import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyOrigin } from "../../analysis/cpu-profile.js";
import type { ArtifactFingerprint } from "../model.js";
import { canonicalPath } from "../paths.js";
import { isCranktsPath } from "../resolve/index.js";
import type { PreloadRecord } from "../preload/source.js";

/**
 * Artifact fingerprint per measurement (docs/observe-plan.md D3): hashes of the entry file, of every own module the
 * profile touched, and of their source maps. Later measurements reuse source-map-derived data only when they agree.
 */

const SOURCE_MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/;
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export function fingerprintArtifact(primary: PreloadRecord, profileUrls: Iterable<string>, projectRoot: string): ArtifactFingerprint {
  const root = canonicalPath(projectRoot);
  const moduleHashes: Record<string, string> = {};
  const sourceMapHashes: Record<string, string> = {};
  for (const url of new Set(profileUrls)) {
    if (classifyOrigin({ url, functionName: "f" }, root).kind !== "PROJECT" || isCranktsPath(url)) continue;
    let file: string;
    try {
      file = url.startsWith("file:") ? fileURLToPath(url) : url;
    } catch {
      continue;
    }
    file = canonicalPath(file);
    const code = readOrUndefined(file);
    if (code === undefined) continue;
    moduleHashes[projectRelative(root, file)] = sha256(code);
    const reference = SOURCE_MAPPING_URL.exec(code.toString("utf8", Math.max(0, code.length - 4096)).trimEnd())?.[1];
    if (reference && !reference.startsWith("data:")) {
      const mapFile = resolve(dirname(file), decodeURIComponent(reference));
      const map = readOrUndefined(mapFile);
      if (map !== undefined) sourceMapHashes[projectRelative(root, mapFile)] = sha256(map);
    } else if (!reference && existsSync(`${file}.map`)) {
      sourceMapHashes[projectRelative(root, `${file}.map`)] = sha256(readFileSync(`${file}.map`));
    }
  }
  const entry = primary.argv[1] ?? "";
  return {
    entrypoint: entry ? projectRelative(root, canonicalPath(resolve(primary.cwd, entry))) : "",
    entrypointHash: primary.entryHash ?? "",
    sourceMapHashes: sortKeys(sourceMapHashes),
    moduleHashes: sortKeys(moduleHashes),
    loader: detectLoader(primary),
  };
}

export function detectLoader(record: Pick<PreloadRecord, "argv" | "execArgv">): ArtifactFingerprint["loader"] {
  const options = record.execArgv.join(" ");
  if (/(?:^|[/\\\s])tsx(?:[/\\@]|\s|$)/.test(options)) return "tsx";
  if (/ts-node/.test(options)) return "ts-node";
  const entry = record.argv[1] ?? "";
  if (TS_EXTENSIONS.has(extname(entry))) return "node-strip-types";
  if (/--(?:import|loader|experimental-loader|require)\b/.test(options)) return "other";
  return "node";
}

function readOrUndefined(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch {
    return undefined;
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function projectRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}
