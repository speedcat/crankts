import { readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnalysisResult,
  AttributionTarget,
  CallSiteObservation,
  CandidateIsland,
  CpuProfileObservation,
  CpuProfileOrigin,
  CpuProfileOriginKind,
  CpuProfileSummary,
  FunctionAnalysis,
  FunctionId,
} from "./model.js";

export interface ProfileCallFrame {
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
}

interface V8ProfileNode {
  readonly id: number;
  readonly callFrame: ProfileCallFrame;
  readonly children?: readonly number[];
  /** Self ticks per 1-based source line (`node --cpu-prof` records them). */
  readonly positionTicks?: readonly { readonly line: number; readonly ticks: number }[];
}

export interface CpuProfileLoadOptions {
  /**
   * 1-based lines of a function where it calls into a native addon (N-API). N-API calls have no frame, so
   * their time is the caller's self time; ticks on these lines are attributed as EXTERNAL_NATIVE.
   */
  readonly nativeAddonCallLines?: (functionId: FunctionId) => ReadonlySet<number> | undefined;
  /** Whether the package at this root directory is a native addon; defaults to reading its package.json. */
  readonly isNativeAddonPackage?: (packageRoot: string) => boolean;
}

/** Node modules whose native leaves are I/O. */
const IO_MODULE = /^node:(?:internal\/)?(?:fs|net|dns|tls|http|https|http2|child_process|dgram|readline|zlib|internal\/fs|internal\/streams|stream)(?:\/|$)/;

interface V8CpuProfile {
  readonly nodes: readonly V8ProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

interface ProfileSample {
  readonly durationMicros: number;
  readonly functionIds: ReadonlySet<FunctionId>;
}

export interface LoadedCpuProfile {
  readonly summary: CpuProfileSummary;
  readonly observations: ReadonlyMap<FunctionId, CpuProfileObservation>;
  readonly samples: readonly ProfileSample[];
}

export function loadV8CpuProfile(
  profilePath: string,
  projectRoot: string,
  functions: readonly FunctionAnalysis[],
  options: CpuProfileLoadOptions = {},
): LoadedCpuProfile {
  const absoluteProfilePath = resolve(profilePath);
  let rawProfile: unknown;
  try {
    rawProfile = JSON.parse(readFileSync(absoluteProfilePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read V8 CPU profile '${absoluteProfilePath}': ${message}`);
  }

  const profile = validateProfile(rawProfile, absoluteProfilePath);
  const functionByProfileNode = new Map<number, FunctionId>();
  const parentByNode = new Map<number, number>();
  const nodeById = new Map<number, V8ProfileNode>();
  const functionsByFile = indexFunctionsByFile(functions);

  for (const node of profile.nodes) {
    nodeById.set(node.id, node);
    const functionAnalysis = matchFunction(node.callFrame, projectRoot, functionsByFile);
    if (functionAnalysis) {
      functionByProfileNode.set(node.id, functionAnalysis.id);
    }
    for (const childId of node.children ?? []) {
      if (!parentByNode.has(childId)) {
        parentByNode.set(childId, node.id);
      }
    }
  }

  const selfMicrosByFunction = new Map<FunctionId, number>();
  const totalMicrosByFunction = new Map<FunctionId, number>();
  const samples: ProfileSample[] = [];
  const originByNode = new Map<number, { readonly origin: string; readonly kind: CpuProfileOriginKind }>();
  const originTotals = new Map<string, { kind: CpuProfileOriginKind; selfMicros: number; unmatchedMicros: number }>();
  let totalSampleMicros = 0;
  let matchedSampleMicros = 0;
  let matchedSampleCount = 0;
  const attribution = new Map<FunctionId, SiteAccumulator>();
  const attributedByTarget: Partial<Record<AttributionTarget, number>> = {};
  let nativeAddonSelfMicros = 0;
  // Per profile: node ids are only unique within one profile.
  const addonShareByNode = new Map<number, number>();
  const bindingShareByNode = new Map<number, number>();
  /** Share of a project frame's self ticks that fall on its N-API call lines. */
  const addonShare = (node: V8ProfileNode, functionId: FunctionId): number => {
    const cached = addonShareByNode.get(node.id);
    if (cached !== undefined) return cached;
    const lines = options.nativeAddonCallLines?.(functionId);
    let share = 0;
    if (lines && lines.size > 0 && node.positionTicks && node.positionTicks.length > 0) {
      const total = node.positionTicks.reduce((sum, entry) => sum + entry.ticks, 0);
      const onAddon = node.positionTicks.filter((entry) => lines.has(entry.line)).reduce((sum, entry) => sum + entry.ticks, 0);
      share = total > 0 ? onAddon / total : 0;
    }
    addonShareByNode.set(node.id, share);
    return share;
  };
  const addAttribution = (functionId: FunctionId, target: AttributionTarget, origin: string | undefined, micros: number): void => {
    if (micros <= 0) return;
    const entry = attribution.get(functionId) ?? newSiteAccumulator();
    entry.byTarget[target] = (entry.byTarget[target] ?? 0) + micros;
    if (origin !== undefined) {
      const key = `${origin}\u0000${target}`;
      const external = entry.external.get(key) ?? { target, micros: 0 };
      external.micros += micros;
      entry.external.set(key, external);
    }
    attribution.set(functionId, entry);
    attributedByTarget[target] = (attributedByTarget[target] ?? 0) + micros;
  };

  for (let index = 0; index < profile.samples.length; index += 1) {
    const nodeId = profile.samples[index];
    const durationMicros = profile.timeDeltas[index] ?? 0;
    if (nodeId === undefined || durationMicros < 0) {
      continue;
    }
    totalSampleMicros += durationMicros;

    const functionIds = new Set<FunctionId>();
    let currentNodeId: number | undefined = nodeId;
    const visitedNodeIds = new Set<number>();
    while (currentNodeId !== undefined && !visitedNodeIds.has(currentNodeId)) {
      visitedNodeIds.add(currentNodeId);
      const functionId = functionByProfileNode.get(currentNodeId);
      if (functionId) {
        functionIds.add(functionId);
      }
      currentNodeId = parentByNode.get(currentNodeId);
    }

    let origin = originByNode.get(nodeId);
    if (!origin) {
      origin = classifyOrigin(nodeById.get(nodeId)?.callFrame, projectRoot);
      originByNode.set(nodeId, origin);
    }
    const originTotal = originTotals.get(origin.origin) ?? { kind: origin.kind, selfMicros: 0, unmatchedMicros: 0 };
    originTotal.selfMicros += durationMicros;
    if (functionIds.size === 0) {
      originTotal.unmatchedMicros += durationMicros;
    }
    originTotals.set(origin.origin, originTotal);

    if (functionIds.size > 0) {
      matchedSampleMicros += durationMicros;
      matchedSampleCount += 1;
      for (const functionId of functionIds) {
        totalMicrosByFunction.set(
          functionId,
          (totalMicrosByFunction.get(functionId) ?? 0) + durationMicros,
        );
      }
    }

    const selfFunctionId = functionByProfileNode.get(nodeId);
    if (selfFunctionId) {
      selfMicrosByFunction.set(
        selfFunctionId,
        (selfMicrosByFunction.get(selfFunctionId) ?? 0) + durationMicros,
      );
    }

    // Call-site attribution: the innermost analyzed frame, and what the sample's leaf is relative to it.
    let siteNodeId: number | undefined = nodeId;
    let belowSite: number[] = [];
    while (siteNodeId !== undefined && !functionByProfileNode.has(siteNodeId)) {
      belowSite.push(siteNodeId);
      siteNodeId = parentByNode.get(siteNodeId);
    }
    const siteFunctionId = siteNodeId === undefined ? undefined : functionByProfileNode.get(siteNodeId);
    if (siteNodeId !== undefined && siteFunctionId) {
      // Caller path: the next distinct analyzed functions above the site (recursion collapsed), up to 3.
      const path: FunctionId[] = [];
      for (let up = parentByNode.get(siteNodeId); up !== undefined && path.length < 3; up = parentByNode.get(up)) {
        const caller = functionByProfileNode.get(up);
        if (caller && caller !== siteFunctionId && caller !== path[path.length - 1]) path.push(caller);
      }
      const site = attribution.get(siteFunctionId) ?? newSiteAccumulator();
      const key = path.join("\u0001");
      site.callers.set(key, (site.callers.get(key) ?? 0) + durationMicros);
      attribution.set(siteFunctionId, site);
      if (belowSite.length === 0) {
        const native = durationMicros * addonShare(nodeById.get(siteNodeId) as V8ProfileNode, siteFunctionId);
        nativeAddonSelfMicros += native;
        addAttribution(siteFunctionId, "EXTERNAL_NATIVE", "(N-API call)", native);
        addAttribution(siteFunctionId, "FUNCTION_SELF", undefined, durationMicros - native);
      } else {
        // The frame right below the analyzed function: the dependency (or Node API) it called into.
        const entryFrame = nodeById.get(belowSite[belowSite.length - 1] as number)?.callFrame;
        if (entryFrame?.url) {
          const site = attribution.get(siteFunctionId) ?? newSiteAccumulator();
          const key = `${classifyOrigin(entryFrame, projectRoot).origin}\u0000${entryFrame.functionName ?? ""}`;
          const entry = site.entries.get(key) ?? { micros: 0, compileLikeMicros: 0 };
          entry.micros += durationMicros;
          if (belowSite.some((id) => isCompileLike(nodeById.get(id)?.callFrame.functionName))) entry.compileLikeMicros += durationMicros;
          site.entries.set(key, entry);
          attribution.set(siteFunctionId, site);
        }
        const isAddon = options.isNativeAddonPackage ?? isNativeAddonPackageRoot;
        const classified = classifyBelowSite(belowSite.map((id) => nodeById.get(id)?.callFrame), projectRoot, isAddon);
        // A JS frame of an addon package spends its N-API calls as self time too: split by its line ticks.
        const leafNode = nodeById.get(nodeId);
        const native = classified.target === "EXTERNAL_DEPENDENCY" && leafNode ? durationMicros * packageBindingShare(leafNode, isAddon, bindingShareByNode) : 0;
        addAttribution(siteFunctionId, "EXTERNAL_NATIVE", classified.origin, native);
        addAttribution(siteFunctionId, classified.target, classified.target === "FUNCTION_SELF" ? undefined : classified.origin, durationMicros - native);
      }
    }
    belowSite = [];

    samples.push({ durationMicros, functionIds });
  }

  const observations = new Map<FunctionId, CpuProfileObservation>();
  for (const functionAnalysis of functions) {
    const selfCpuMicros = selfMicrosByFunction.get(functionAnalysis.id) ?? 0;
    const totalCpuMicros = totalMicrosByFunction.get(functionAnalysis.id) ?? selfCpuMicros;
    const site = attribution.get(functionAnalysis.id);
    observations.set(functionAnalysis.id, {
      selfCpuMicros,
      totalCpuMicros,
      samplePercent: percentOf(selfCpuMicros, totalSampleMicros),
      callCount: null,
      ...(site ? { callSite: callSiteObservation(site, totalSampleMicros) } : {}),
    });
  }

  const matchedSamplePercent = percentOf(matchedSampleMicros, totalSampleMicros);
  const confidence = matchedSamplePercent >= 80 && matchedSampleCount >= 100
    ? "HIGH"
    : matchedSamplePercent >= 50 && matchedSampleCount >= 25
      ? "MEDIUM"
      : "LOW";
  const projectRelativeProfilePath = relative(process.cwd(), absoluteProfilePath).split(sep).join("/");
  const origins: CpuProfileOrigin[] = [...originTotals]
    .map(([origin, total]) => ({
      origin,
      kind: total.kind,
      selfMicros: total.selfMicros,
      selfPercent: percentOf(total.selfMicros, totalSampleMicros),
      unmatchedMicros: total.unmatchedMicros,
      unmatchedPercent: percentOf(total.unmatchedMicros, totalSampleMicros),
    }))
    .sort((left, right) => right.selfMicros - left.selfMicros || left.origin.localeCompare(right.origin));

  return {
    summary: {
      file: projectRelativeProfilePath || extname(absoluteProfilePath),
      totalSampleMicros,
      matchedSampleMicros,
      matchedSamplePercent,
      sampleCount: profile.samples.length,
      matchedSampleCount,
      timeUnit: "microseconds",
      confidence,
      origins,
      attribution: {
        attributedPercent: percentOf(sumValues(attributedByTarget), totalSampleMicros),
        byTarget: mapValues(attributedByTarget, (micros) => percentOf(micros, totalSampleMicros)),
        unattributedPercent: percentOf(totalSampleMicros - sumValues(attributedByTarget), totalSampleMicros),
        nativeAddonSelfPercent: percentOf(nativeAddonSelfMicros, totalSampleMicros),
      },
    },
    observations,
    samples,
  };
}

interface SiteAccumulator {
  readonly byTarget: Partial<Record<AttributionTarget, number>>;
  readonly external: Map<string, { target: AttributionTarget; micros: number }>;
  readonly entries: Map<string, { micros: number; compileLikeMicros: number }>;
  readonly callers: Map<string, number>;
}

function newSiteAccumulator(): SiteAccumulator {
  return { byTarget: {}, external: new Map(), entries: new Map(), callers: new Map() };
}

/** Frames that build reusable state from their input: compilers, parsers, scanners, pattern expansion. */
const COMPILE_LIKE = /^(?:compile|parse|makeRe|toRegex|tokeni[sz]e|scan|lex|expand)/i;

export function isCompileLike(functionName: string | undefined): boolean {
  const last = (functionName ?? "").split(".").pop() ?? "";
  return COMPILE_LIKE.test(last);
}

function callSiteObservation(site: SiteAccumulator, totalSampleMicros: number): CallSiteObservation {
  const attributedMicros = sumValues(site.byTarget);
  const causedMicros = attributedMicros - (site.byTarget.FUNCTION_SELF ?? 0);
  return {
    attributedMicros: Math.round(attributedMicros),
    attributedPercent: percentOf(attributedMicros, totalSampleMicros),
    causedMicros: Math.round(causedMicros),
    causedPercent: percentOf(causedMicros, totalSampleMicros),
    byTarget: mapValues(site.byTarget, (micros) => percentOf(micros, totalSampleMicros)),
    topExternal: [...site.external]
      .map(([key, entry]) => ({ origin: key.split("\u0000")[0] as string, target: entry.target, micros: Math.round(entry.micros), percent: percentOf(entry.micros, totalSampleMicros) }))
      .sort((left, right) => right.micros - left.micros)
      .slice(0, 5),
    entries: [...site.entries]
      .map(([key, entry]) => {
        const [origin, functionName] = key.split("\u0000") as [string, string];
        return {
          origin,
          functionName,
          micros: Math.round(entry.micros),
          percent: percentOf(entry.micros, totalSampleMicros),
          compileLikeMicros: Math.round(entry.compileLikeMicros),
          compileLikePercent: percentOf(entry.compileLikeMicros, totalSampleMicros),
        };
      })
      .sort((left, right) => right.micros - left.micros)
      .slice(0, 8),
    callerPaths: [...site.callers]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([key, micros]) => ({ path: key === "" ? [] : key.split("\u0001"), percentOfSite: percentOf(micros, attributedMicros) })),
  };
}

/**
 * Classifies a sample by the frames between the leaf (first) and the innermost analyzed frame (exclusive).
 * Native leaves (no script: builtins, regexes, bindings) take the class of their nearest JavaScript caller.
 */
export function classifyBelowSite(
  frames: readonly (ProfileCallFrame | undefined)[],
  projectRoot: string,
  isAddonPackage: (packageRoot: string) => boolean,
): { readonly target: AttributionTarget; readonly origin: string } {
  const leaf = frames[0];
  const leafUrl = leaf?.url ?? "";
  const scripted = frames.find((frame) => frame?.url && !frame.url.startsWith("wasm://"));
  if (leafUrl.startsWith("wasm://")) {
    return { target: "RUNTIME", origin: scripted?.url?.startsWith("node:") ? "node (wasm)" : "wasm" };
  }
  const reference = leafUrl ? leaf : scripted;
  if (!reference?.url) {
    // Only native frames between the analyzed function and the leaf: its own builtins and regexes.
    return { target: "FUNCTION_SELF", origin: "(native)" };
  }
  const nativeLeaf = !leafUrl;
  const url = reference.url;
  if (url.startsWith("node:")) {
    return { target: IO_MODULE.test(url) ? "IO" : "RUNTIME", origin: "node" };
  }
  const origin = classifyOrigin(reference, projectRoot);
  if (origin.kind === "PACKAGE") {
    const root = packageRootFromUrl(url);
    return { target: nativeLeaf && root !== undefined && isAddonPackage(root) ? "EXTERNAL_NATIVE" : "EXTERNAL_DEPENDENCY", origin: origin.origin };
  }
  if (origin.kind === "PROJECT") {
    return { target: "UNANALYZED_PROJECT", origin: "project" };
  }
  return { target: "RUNTIME", origin: origin.origin };
}

const BINDING_CALL = /\b(?:\w*[Bb]inding\w*|addon|native)\s*(?:\.\s*\w+\s*)?\(/;
const sourceLinesCache = new Map<string, readonly string[] | null>();

/**
 * Share of an addon package frame's self ticks on lines that call its binding (`parseSyncBinding(…)`,
 * `binding.resolve(…)`, `nativeBinding.x(…)`): the generated glue of napi-rs and node-gyp packages.
 * Packages are not type-checked, so this is a textual check, limited to native addon packages.
 */
function packageBindingShare(node: V8ProfileNode, isAddon: (packageRoot: string) => boolean, bindingShareCache: Map<number, number>): number {
  const cached = bindingShareCache.get(node.id);
  if (cached !== undefined) return cached;
  let share = 0;
  const url = node.callFrame.url ?? "";
  const root = packageRootFromUrl(url);
  if (root && isAddon(root) && node.positionTicks && node.positionTicks.length > 0) {
    let lines = sourceLinesCache.get(url);
    if (lines === undefined) {
      try {
        lines = readFileSync(url.startsWith("file:") ? fileURLToPath(new URL(url)) : url, "utf8").split("\n");
      } catch {
        lines = null;
      }
      sourceLinesCache.set(url, lines);
    }
    if (lines) {
      const total = node.positionTicks.reduce((sum, entry) => sum + entry.ticks, 0);
      const onBinding = node.positionTicks.filter((entry) => BINDING_CALL.test(lines?.[entry.line - 1] ?? "")).reduce((sum, entry) => sum + entry.ticks, 0);
      share = total > 0 ? onBinding / total : 0;
    }
  }
  bindingShareCache.set(node.id, share);
  return share;
}

/** `/…/node_modules/<name>/` (innermost) of a script URL. */
export function packageRootFromUrl(url: string): string | undefined {
  let path = url;
  try {
    path = url.startsWith("file:") ? fileURLToPath(new URL(url)) : url;
  } catch {
    return undefined;
  }
  const normalized = path.split(sep).join("/");
  const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\/(?!.*\/node_modules\/)/.exec(normalized);
  return match?.[1];
}

const addonManifestCache = new Map<string, boolean>();
export function isNativeAddonPackageRoot(packageRoot: string): boolean {
  let addon = addonManifestCache.get(packageRoot);
  if (addon === undefined) {
    try {
      addon = isNativeAddonManifest(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>);
    } catch {
      addon = false;
    }
    addonManifestCache.set(packageRoot, addon);
  }
  return addon;
}

/** napi-rs, node-gyp, and prebuild packages; also packages shipping per-platform binding packages. */
export function isNativeAddonManifest(manifest: Record<string, unknown>): boolean {
  if (manifest["napi"] || manifest["gypfile"] || manifest["binary"]) return true;
  const dependencies = { ...(manifest["dependencies"] as Record<string, string> | undefined), ...(manifest["optionalDependencies"] as Record<string, string> | undefined) };
  return Object.keys(dependencies).some((name) => (
    /^(node-gyp-build|bindings|prebuild-install|@mapbox\/node-pre-gyp|node-addon-api)$/.test(name)
    || /(?:^|[/-])binding-|-(?:darwin|linux|win32)-(?:x64|arm64|ia32)/.test(name)
  ));
}

function sumValues(record: Partial<Record<string, number>>): number {
  return Object.values(record).reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function mapValues<K extends string>(record: Partial<Record<K, number>>, map: (value: number) => number): Partial<Record<K, number>> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value as number)])) as Partial<Record<K, number>>;
}

export function attachCpuProfile(
  functions: readonly FunctionAnalysis[],
  candidateIslands: readonly CandidateIsland[],
  profile: LoadedCpuProfile,
): Pick<AnalysisResult, "functions" | "candidateIslands" | "cpuProfile"> {
  const profiledFunctions = functions.map((functionAnalysis) => {
    const observedCpu = profile.observations.get(functionAnalysis.id);
    return observedCpu ? { ...functionAnalysis, observedCpu } : functionAnalysis;
  });
  const profiledIslands = candidateIslands.map((island) => {
    const memberIds = new Set(island.members);
    let selfCpuMicros = 0;
    for (const functionId of memberIds) {
      selfCpuMicros += profile.observations.get(functionId)?.selfCpuMicros ?? 0;
    }
    let totalCpuMicros = 0;
    for (const sample of profile.samples) {
      if ([...sample.functionIds].some((functionId) => memberIds.has(functionId))) {
        totalCpuMicros += sample.durationMicros;
      }
    }
    return {
      ...island,
      observedCpu: {
        selfCpuMicros,
        totalCpuMicros,
          samplePercent: percentOf(selfCpuMicros, profile.summary.totalSampleMicros),
        callCount: null,
      },
    };
  });

  return {
    functions: profiledFunctions,
    candidateIslands: profiledIslands,
    cpuProfile: profile.summary,
  };
}

const SYNTHETIC_FRAMES: ReadonlyMap<string, CpuProfileOriginKind> = new Map([
  ["(garbage collector)", "GC"],
  ["(program)", "PROGRAM"],
  ["(root)", "PROGRAM"],
  ["(idle)", "IDLE"],
]);

export function classifyOrigin(
  callFrame: ProfileCallFrame | undefined,
  projectRoot: string,
): { readonly origin: string; readonly kind: CpuProfileOriginKind } {
  const functionName = callFrame?.functionName ?? "";
  const syntheticKind = SYNTHETIC_FRAMES.get(functionName);
  if (syntheticKind) {
    return { origin: functionName, kind: syntheticKind };
  }
  const url = callFrame?.url ?? "";
  if (!url) {
    return { origin: "(native)", kind: "NATIVE" };
  }
  if (url.startsWith("node:")) {
    return { origin: "node", kind: "NODE" };
  }
  let path = url;
  try {
    path = url.startsWith("file:") ? fileURLToPath(new URL(url)) : url;
  } catch {
    return { origin: "other", kind: "OTHER" };
  }
  const normalizedPath = path.split(sep).join("/");
  const packageMatch = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*\/node_modules\/)/.exec(normalizedPath);
  if (packageMatch?.[1]) {
    return { origin: packageMatch[1], kind: "PACKAGE" };
  }
  if (isAbsolute(path)) {
    const relativePath = relative(resolve(projectRoot), path);
    if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
      return { origin: "project", kind: "PROJECT" };
    }
  }
  return { origin: "other", kind: "OTHER" };
}

function validateProfile(value: unknown, profilePath: string): V8CpuProfile {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid V8 CPU profile '${profilePath}': expected a JSON object.`);
  }
  const profile = value as Partial<V8CpuProfile>;
  if (!Array.isArray(profile.nodes)
    || !Array.isArray(profile.samples)
    || !Array.isArray(profile.timeDeltas)
    || profile.samples.length !== profile.timeDeltas.length) {
    throw new Error(`Invalid V8 CPU profile '${profilePath}': expected nodes and aligned samples/timeDeltas arrays.`);
  }
  return profile as V8CpuProfile;
}

export function indexFunctionsByFile(functions: readonly FunctionAnalysis[]): Map<string, FunctionAnalysis[]> {
  const functionsByFile = new Map<string, FunctionAnalysis[]>();
  for (const functionAnalysis of functions) {
    const fileFunctions = functionsByFile.get(functionAnalysis.file) ?? [];
    fileFunctions.push(functionAnalysis);
    functionsByFile.set(functionAnalysis.file, fileFunctions);
  }
  return functionsByFile;
}

export function matchFunction(
  callFrame: ProfileCallFrame,
  projectRoot: string,
  functionsByFile: ReadonlyMap<string, readonly FunctionAnalysis[]>,
): FunctionAnalysis | undefined {
  const fileCandidates = getSourceFileCandidates(callFrame.url ?? "", projectRoot);
  const candidates = fileCandidates.flatMap((file) => functionsByFile.get(file) ?? []);
  if (candidates.length === 0) {
    return undefined;
  }

  const profileName = (callFrame.functionName ?? "").replace(/^[~*]+/, "");
  const exactMatches = candidates.filter((functionAnalysis) => functionAnalysis.name === profileName);
  const matches = exactMatches.length > 0
    ? exactMatches
    : candidates.filter((functionAnalysis) => functionAnalysis.name.endsWith(`.${profileName}`));
  if (matches.length === 0) {
    // V8's inferred names differ from source names for computed-key methods (`[evaluate](…)`), object-literal
    // methods passed to factories, and some anonymous functions. Fall back to the position: the only analyzed
    // function that starts on the frame's line (unambiguous only; source maps are not used).
    if (callFrame.lineNumber === undefined || callFrame.lineNumber < 0) {
      return undefined;
    }
    const startLine = callFrame.lineNumber + 1;
    const atLine = candidates.filter((functionAnalysis) => functionAnalysis.line === startLine);
    return atLine.length === 1 ? atLine[0] : undefined;
  }
  if (matches.length === 1 || callFrame.lineNumber === undefined || callFrame.lineNumber < 0) {
    return matches[0];
  }

  const profileLine = callFrame.lineNumber + 1;
  return [...matches].sort((left, right) => (
    Math.abs(left.line - profileLine) - Math.abs(right.line - profileLine)
    || left.line - right.line
  ))[0];
}

function getSourceFileCandidates(profileUrl: string, projectRoot: string): string[] {
  if (!profileUrl || profileUrl.startsWith("node:")) {
    return [];
  }
  let absolutePath: string;
  try {
    absolutePath = profileUrl.startsWith("file:")
      ? fileURLToPath(new URL(profileUrl))
      : isAbsolute(profileUrl)
        ? resolve(profileUrl)
        : resolve(projectRoot, profileUrl);
  } catch {
    return [];
  }

  let relativePath = relative(resolve(projectRoot), absolutePath).split(sep).join("/");
  if (relativePath.startsWith("../") || relativePath === "..") {
    return [];
  }

  const candidates = new Set([relativePath]);
  const outputDirectory = /(^|\/)(?:dist|build)\//.exec(relativePath);
  const mappedOutputDirectory = Boolean(outputDirectory);
  if (outputDirectory) {
    const matchStart = outputDirectory.index ?? 0;
    const matchLength = outputDirectory[0].length;
    const pathSeparator = outputDirectory[1];
    relativePath = `${relativePath.slice(0, matchStart)}${pathSeparator}src/${relativePath.slice(matchStart + matchLength)}`;
    candidates.add(relativePath);
  }

  const extension = extname(relativePath);
  const sourceExtensions: Readonly<Record<string, string>> = {
    ".js": ".ts",
    ".mjs": ".mts",
    ".cjs": ".cts",
    ".jsx": ".tsx",
  };
  const sourceExtension = sourceExtensions[extension];
  if (sourceExtension) {
    const sourcePath = relativePath.slice(0, -extension.length) + sourceExtension;
    candidates.add(sourcePath);
    if (!mappedOutputDirectory) {
      candidates.add(`src/${sourcePath}`);
    }
  }
  return [...candidates];
}

export function percentOf(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 10_000) / 100;
}