import { existsSync, readFileSync } from "node:fs";
import { SourceMap, type SourceMapPayload } from "node:module";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyOrigin, isNativeAddonPackageRoot, packageRootFromUrl } from "../../analysis/cpu-profile.js";
import { entityAtOffset, EntityIndex, offsetOf, toEntity, type IndexedEntity, type ModuleIndex } from "../entity/index.js";
import type { Entity } from "../model.js";
import { canonicalPath } from "../paths.js";

/**
 * Frame resolution (docs/observe-plan.md §6, §7.1): classify a V8 call frame, map own frames through the generated
 * file's source map (or directly for `.ts` files run with type stripping), and find the entity at that position.
 */

export interface V8CallFrame {
  readonly functionName?: string;
  readonly url?: string;
  /** 0-based. */
  readonly lineNumber?: number;
  /** 0-based. */
  readonly columnNumber?: number;
}

export type FrameCategory = "own" | "dependency" | "runtime" | "native" | "gc" | "program" | "idle" | "unmapped" | "root";

export interface ResolvedFrame {
  readonly category: FrameCategory;
  /** Absent only for `(root)`. */
  readonly key?: string;
  /** Package name for `dependency` frames. */
  readonly package?: string;
  /** Own frame that matched a file but whose position fell outside every function (or had no mapping entry). */
  readonly approximate?: boolean;
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SOURCE_MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/;

interface LoadedMap {
  readonly map: SourceMap;
  /** Directory sources resolve against (map file directory joined with sourceRoot). */
  readonly sourceBase: string;
  /** Line starts of the generated code, when known without reading it (from a `source-map-cache` entry). */
  readonly lineStarts?: readonly number[];
}

/**
 * Source maps that Node cached while running the workload (the `source-map-cache` of a NODE_V8_COVERAGE file), keyed
 * by script URL. They cover in-memory transforms such as tsx, whose `.ts` URLs carry transformed positions.
 */
export interface CachedSourceMap {
  readonly data: SourceMapPayload;
  readonly lineLengths?: readonly number[];
}

/** A position in project source: the module, the offset in it (if mappable), and whether the match is approximate. */
export interface SourceLocation {
  readonly module: ModuleIndex;
  readonly offset?: number;
  readonly approximate: boolean;
}

export class FrameResolver {
  readonly index: EntityIndex;
  private readonly entities = new Map<string, Entity>();
  private readonly maps = new Map<string, LoadedMap | null>();
  private readonly frameCache = new Map<string, ResolvedFrame>();
  private readonly canonicalUrls = new Map<string, string>();
  private readonly lineCache = new Map<string, string | null>();

  readonly projectRoot: string;

  private readonly generatedSources = new Map<string, { readonly text: string; readonly starts: readonly number[] } | null>();

  constructor(projectRoot: string, options: { readonly sourceMaps?: ReadonlyMap<string, CachedSourceMap> } = {}) {
    // Profile URLs carry real paths (e.g. /private/var on macOS), so the root must too.
    this.projectRoot = canonicalPath(projectRoot);
    this.index = new EntityIndex(this.projectRoot);
    for (const [url, cached] of options.sourceMaps ?? []) {
      const path = urlToPath(this.canonicalUrl(url));
      if (!path || !Array.isArray(cached.data?.sources)) continue;
      const sourceRoot = typeof cached.data.sourceRoot === "string" ? cached.data.sourceRoot : "";
      const base = sourceRoot.startsWith("file:") ? fileURLToPath(sourceRoot) : resolve(dirname(path), sourceRoot);
      this.maps.set(path, {
        map: new SourceMap(cached.data),
        sourceBase: base,
        ...(cached.lineLengths ? { lineStarts: lineStartsFromLengths(cached.lineLengths) } : {}),
      });
    }
  }

  /** Whether a script URL is project code (not dependencies, Node, or CrankTS's own files). */
  isOwnUrl(url: string): boolean {
    const canonicalUrl = this.canonicalUrl(url);
    return classifyOrigin({ url: canonicalUrl, functionName: "f" }, this.projectRoot).kind === "PROJECT" && !isCranktsPath(canonicalUrl);
  }

  /** Registers an own entity (e.g. one found through coverage) and returns its key. */
  register(module: ModuleIndex, indexed: IndexedEntity): string {
    if (!this.entities.has(indexed.key)) this.entities.set(indexed.key, toEntity(module, indexed));
    return indexed.key;
  }

  /**
   * Maps an offset in the executed script (as V8 coverage reports it) to project source. Generated line starts come
   * from the cached map's `lineLengths`, from the generated file on disk, or, for type-stripped `.ts` files without a
   * map, the offset is already a source offset.
   */
  locateOffset(url: string, generatedOffset: number): SourceLocation | undefined {
    const canonicalUrl = this.canonicalUrl(url);
    const path = urlToPath(canonicalUrl);
    if (!path) return undefined;
    const loaded = this.sourceMapFor(path);
    if (!loaded && TS_EXTENSIONS.has(extname(path))) {
      const module = this.index.module(path);
      return module ? { module, offset: generatedOffset, approximate: false } : undefined;
    }
    const lineStarts = loaded?.lineStarts ?? this.generatedLines(path);
    if (!lineStarts) return undefined;
    const position = positionInLines(lineStarts, generatedOffset);
    return this.locate(canonicalUrl, position.line, position.column);
  }

  /** Maps a 0-based position in the executed script to project source; undefined for dependency code. */
  locate(url: string, line: number, column: number): SourceLocation | undefined {
    const target = this.mappedTarget(url, line, column);
    if (!target || isDependencyPath(target.file)) return undefined;
    const module = this.index.module(target.file);
    if (!module) return undefined;
    let offset = target.line >= 0 && target.column >= 0 ? offsetOf(module, target.line, target.column) : undefined;
    if (offset !== undefined && target.shift) {
      // Column extrapolation within one generated line (the map has no segment at this exact position): accept it
      // only when the code at both positions reads the same, i.e. the bundler copied this stretch verbatim.
      const shifted = offset + target.shift.columns;
      const generated = target.shift.generatedText;
      if (generated && generated.length >= 4 && module.source.startsWith(generated, shifted)) offset = shifted;
    }
    // Without a position, the module's top-level code; that is exact for a bundle's own top level.
    return offset === undefined ? { module, approximate: target.approximate } : { module, offset, approximate: target.approximate };
  }

  /**
   * Where a generated position points: through a source map (cached or on disk), or the position itself for
   * type-stripped TypeScript and plain JavaScript. Bundle top-level code without a mapping stays in the bundle.
   */
  private mappedTarget(url: string, line: number, column: number):
    | { file: string; line: number; column: number; approximate: boolean; shift?: { columns: number; generatedText?: string } }
    | undefined {
    const generatedFile = urlToPath(url);
    if (!generatedFile) return undefined;
    const loaded = this.sourceMapFor(generatedFile);
    if (!loaded) return { file: generatedFile, line, column, approximate: false };
    const entry = (line >= 0 && column >= 0 ? loaded.map.findEntry(line, column) : undefined) as
      { generatedLine?: number; generatedColumn?: number; originalSource?: string; originalLine?: number; originalColumn?: number } | undefined;
    if (entry?.originalSource && entry.originalLine !== undefined && entry.originalColumn !== undefined) {
      const file = sourcePath(entry.originalSource, loaded.sourceBase);
      const columns = entry.generatedLine === line && entry.generatedColumn !== undefined ? column - entry.generatedColumn : 0;
      if (columns <= 0) return { file, line: entry.originalLine, column: entry.originalColumn, approximate: false };
      const generatedText = this.generatedText(generatedFile, line, column);
      return { file, line: entry.originalLine, column: entry.originalColumn, approximate: false, shift: { columns, ...(generatedText ? { generatedText } : {}) } };
    }
    // No mapping entry (module wrapper or top-level code). A multi-module bundle's top level belongs to the bundle.
    const sources = loaded.map.payload.sources;
    if (sources.length > 1) return { file: generatedFile, line: -1, column: -1, approximate: false };
    const first = sources[0];
    return first ? { file: sourcePath(first, loaded.sourceBase), line: -1, column: -1, approximate: true } : undefined;
  }

  /**
   * The own entity a 1-based line of an executed script belongs to (for `positionTicks`), mapped at the line's last
   * code character (the first can be an `export` keyword outside the function). Undefined when the line is not in this script (inlined code from other scripts reports its own line
   * numbers) or not mappable.
   */
  entityAtLine(url: string, line: number): string | undefined {
    const canonicalUrl = this.canonicalUrl(url);
    const path = urlToPath(canonicalUrl);
    if (!path || line < 1) return undefined;
    const cacheKey = `${canonicalUrl}\u0000${line}`;
    if (this.lineCache.has(cacheKey)) return this.lineCache.get(cacheKey) ?? undefined;
    let key: string | undefined;
    const loaded = this.sourceMapFor(path);
    const text = loaded ? this.generatedSource(path) : undefined;
    let column: number | undefined;
    if (text) {
      const start = text.starts[line - 1];
      if (start !== undefined) {
        column = lastCodeColumn(text.text.slice(start, text.starts[line] ?? text.text.length));
      }
    } else if (!loaded) {
      const module = this.index.module(path);
      const start = module?.lineStarts[line - 1];
      if (module && start !== undefined) {
        column = lastCodeColumn(module.source.slice(start, module.lineStarts[line] ?? module.source.length));
      }
    }
    if (column !== undefined) {
      const location = this.locate(canonicalUrl, line - 1, column);
      if (location?.offset !== undefined && !location.approximate) {
        key = this.register(location.module, entityAtOffset(location.module, location.offset));
      }
    }
    this.lineCache.set(cacheKey, key ?? null);
    return key;
  }

  /** Up to 16 characters of generated code at a position, when the generated file is on disk. */
  private generatedText(file: string, line: number, column: number): string | undefined {
    const lines = this.generatedSource(file);
    if (!lines) return undefined;
    const start = (lines.starts[line] ?? -1) + column;
    if (start < 0) return undefined;
    const end = lines.starts[line + 1] ?? lines.text.length;
    return lines.text.slice(start, Math.min(start + 16, end)).replace(/\s+$/, "");
  }

  /** Entities referenced by resolved frames, keyed by entity key. */
  get referencedEntities(): ReadonlyMap<string, Entity> {
    return this.entities;
  }

  resolve(frame: V8CallFrame): ResolvedFrame {
    const cacheKey = `${frame.functionName ?? ""}\u0000${frame.url ?? ""}\u0000${frame.lineNumber ?? -1}\u0000${frame.columnNumber ?? -1}`;
    let resolved = this.frameCache.get(cacheKey);
    if (!resolved) {
      resolved = this.resolveUncached(frame);
      this.frameCache.set(cacheKey, resolved);
    }
    return resolved;
  }

  private resolveUncached(original: V8CallFrame): ResolvedFrame {
    const functionName = original.functionName ?? "";
    if (functionName === "(root)") return { category: "root" };
    const frame = { ...original, url: this.canonicalUrl(original.url ?? "") };
    const origin = classifyOrigin(frame, this.projectRoot);
    switch (origin.kind) {
      case "GC":
        return this.pseudo("gc", "(gc)");
      case "IDLE":
        return this.pseudo("idle", "(idle)");
      case "PROGRAM":
        return this.pseudo("program", "(program)");
      case "NATIVE":
        return this.pseudo("native", `(native)::${functionName || "(anonymous)"}`);
      case "NODE":
        return this.pseudo("runtime", "node:internal::*");
      case "PACKAGE": {
        const packageRoot = packageRootFromUrl(frame.url ?? "");
        const nativeAddon = packageRoot ? isNativeAddonPackageRoot(packageRoot) : false;
        return this.pseudo("dependency", `${origin.origin}::*`, { package: origin.origin, nativeAddon });
      }
      case "OTHER":
        return this.pseudo("dependency", "(external)::*", { package: "(external)", nativeAddon: false });
      case "PROJECT":
        // CrankTS's own preload lives in the session directory under the root; it is tooling, not project code.
        if (isCranktsPath(frame.url)) return this.pseudo("runtime", "(crankts)::preload");
        return this.resolveOwn(frame);
    }
  }

  private resolveOwn(frame: V8CallFrame): ResolvedFrame {
    // Bundles inline dependencies; their source maps point back into node_modules.
    const target = this.mappedTarget(frame.url ?? "", frame.lineNumber ?? -1, frame.columnNumber ?? -1);
    if (target && isDependencyPath(target.file)) {
      const name = packageRootFromUrl(target.file)?.split("/node_modules/").pop() ?? "(external)";
      return this.pseudo("dependency", `${name}::*`, { package: name, nativeAddon: false });
    }
    const location = this.locate(frame.url ?? "", frame.lineNumber ?? -1, frame.columnNumber ?? -1);
    if (!location) return this.unmapped(frame.url ?? "");
    const indexed = location.offset === undefined ? (location.module.entities[0] as IndexedEntity) : entityAtOffset(location.module, location.offset);
    return this.own(location.module, indexed, location.approximate);
  }

  private generatedLines(file: string): readonly number[] | undefined {
    return this.generatedSource(file)?.starts;
  }

  private generatedSource(file: string): { readonly text: string; readonly starts: readonly number[] } | undefined {
    let source = this.generatedSources.get(file);
    if (source === undefined) {
      try {
        const text = readFileSync(file, "utf8");
        source = { text, starts: lineStartsOf(text) };
      } catch {
        source = null;
      }
      this.generatedSources.set(file, source);
    }
    return source ?? undefined;
  }

  /** File URLs with symlinks resolved, so they compare against the canonical project root. */
  canonicalUrl(url: string): string {
    let canonicalUrl = this.canonicalUrls.get(url);
    if (canonicalUrl === undefined) {
      const path = urlToPath(url);
      canonicalUrl = path ? pathToFileURL(canonicalPath(path)).href : url;
      this.canonicalUrls.set(url, canonicalUrl);
    }
    return canonicalUrl;
  }

  private own(module: ModuleIndex, indexed: IndexedEntity, approximate: boolean): ResolvedFrame {
    if (!this.entities.has(indexed.key)) this.entities.set(indexed.key, toEntity(module, indexed));
    return approximate ? { category: "own", key: indexed.key, approximate } : { category: "own", key: indexed.key };
  }

  /** Flags such as `anonymousOrdinal` that the index assigned to an own entity. */
  indexedFlags(key: string): readonly string[] {
    const entity = this.entities.get(key);
    if (!entity?.source) return [];
    const module = this.index.module(resolve(this.projectRoot, entity.source.file));
    return module?.entities.find((candidate) => candidate.key === key)?.flags ?? [];
  }

  private pseudo(category: FrameCategory, key: string, dependency?: { package: string; nativeAddon: boolean }): ResolvedFrame {
    if (!this.entities.has(key)) {
      const kind = category === "dependency" || category === "runtime" || category === "native" || category === "gc"
        || category === "program" || category === "idle" ? category : "unmapped";
      this.entities.set(key, {
        identity: {
          key,
          fingerprint: { body: "", shape: "" },
          anchor: { package: dependency?.package ?? key.split("::")[0] ?? key, module: "", qualifiedName: key, nameSource: "declared" },
        },
        kind,
        ...(dependency ? { dependency } : {}),
      });
    }
    return dependency ? { category, key, package: dependency.package } : { category, key };
  }

  private unmapped(url: string): ResolvedFrame {
    const path = urlToPath(url);
    const label = path ? relativeLabel(this.projectRoot, path) : url;
    return this.pseudo("unmapped", `(unmapped)::${label}`);
  }

  private sourceMapFor(generatedFile: string): LoadedMap | undefined {
    let loaded = this.maps.get(generatedFile);
    if (loaded === undefined) {
      loaded = loadSourceMap(generatedFile) ?? null;
      this.maps.set(generatedFile, loaded);
    }
    return loaded ?? undefined;
  }
}

function loadSourceMap(generatedFile: string): LoadedMap | undefined {
  let code: string;
  try {
    code = readFileSync(generatedFile, "utf8");
  } catch {
    return undefined;
  }
  const tail = code.slice(Math.max(0, code.length - 4096)).trimEnd();
  const reference = SOURCE_MAPPING_URL.exec(tail)?.[1];
  let payload: SourceMapPayload | undefined;
  let mapDirectory = dirname(generatedFile);
  try {
    if (reference?.startsWith("data:")) {
      const comma = reference.indexOf(",");
      const meta = reference.slice(0, comma);
      const data = reference.slice(comma + 1);
      payload = JSON.parse(meta.includes(";base64") ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data)) as SourceMapPayload;
    } else {
      const mapFile = reference ? resolve(dirname(generatedFile), decodeURIComponent(reference)) : `${generatedFile}.map`;
      if (!existsSync(mapFile)) return undefined;
      payload = JSON.parse(readFileSync(mapFile, "utf8")) as SourceMapPayload;
      mapDirectory = dirname(mapFile);
    }
  } catch {
    return undefined;
  }
  if (!payload || !Array.isArray(payload.sources)) return undefined;
  const sourceRoot = typeof payload.sourceRoot === "string" ? payload.sourceRoot : "";
  const sourceBase = sourceRoot.startsWith("file:") ? fileURLToPath(sourceRoot) : resolve(mapDirectory, sourceRoot);
  return { map: new SourceMap(payload), sourceBase };
}

function lineStartsFromLengths(lengths: readonly number[]): number[] {
  const starts = [0];
  for (let index = 0; index < lengths.length - 1; index += 1) starts.push((starts[index] as number) + (lengths[index] as number) + 1);
  return starts;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let position = 0; position < text.length; position += 1) {
    if (text.charCodeAt(position) === 10) starts.push(position + 1);
  }
  return starts;
}

function positionInLines(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, column: offset - (starts[low] as number) };
}

function lastCodeColumn(lineText: string): number | undefined {
  const trimmed = lineText.replace(/\s+$/, "");
  return trimmed.length > 0 ? trimmed.length - 1 : undefined;
}

function isDependencyPath(file: string): boolean {
  return /[/\\]node_modules[/\\]/.test(file);
}

export function isCranktsPath(url: string): boolean {
  return /[/\\]\.crankts[/\\]/.test(url);
}

function sourcePath(source: string, base: string): string {
  if (source.startsWith("file:")) return fileURLToPath(source);
  if (isAbsolute(source)) return source;
  return resolve(base, source);
}

function urlToPath(url: string): string | undefined {
  if (!url) return undefined;
  try {
    if (url.startsWith("file:")) return fileURLToPath(new URL(url));
  } catch {
    return undefined;
  }
  return isAbsolute(url) ? url : undefined;
}

function relativeLabel(root: string, path: string): string {
  const relativePath = path.startsWith(resolve(root)) ? path.slice(resolve(root).length + 1) : path;
  return relativePath.split("\\").join("/");
}
