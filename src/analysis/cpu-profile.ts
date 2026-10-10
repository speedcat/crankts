import { readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnalysisResult,
  CandidateIsland,
  CpuProfileObservation,
  CpuProfileSummary,
  FunctionAnalysis,
  FunctionId,
} from "./model.js";

interface V8CallFrame {
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
}

interface V8ProfileNode {
  readonly id: number;
  readonly callFrame: V8CallFrame;
  readonly children?: readonly number[];
}

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
  let totalSampleMicros = 0;
  let matchedSampleMicros = 0;
  let matchedSampleCount = 0;

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

    samples.push({ durationMicros, functionIds });
  }

  const observations = new Map<FunctionId, CpuProfileObservation>();
  for (const functionAnalysis of functions) {
    const selfCpuMicros = selfMicrosByFunction.get(functionAnalysis.id) ?? 0;
    const totalCpuMicros = totalMicrosByFunction.get(functionAnalysis.id) ?? selfCpuMicros;
      observations.set(functionAnalysis.id, {
        selfCpuMicros,
        totalCpuMicros,
        samplePercent: percentOf(selfCpuMicros, totalSampleMicros),
        callCount: null,
      });
  }

  const matchedSamplePercent = percentOf(matchedSampleMicros, totalSampleMicros);
  const confidence = matchedSamplePercent >= 80 && matchedSampleCount >= 100
    ? "HIGH"
    : matchedSamplePercent >= 50 && matchedSampleCount >= 25
      ? "MEDIUM"
      : "LOW";
  const projectRelativeProfilePath = relative(process.cwd(), absoluteProfilePath).split(sep).join("/");

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
    },
    observations,
    samples,
  };
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

function indexFunctionsByFile(functions: readonly FunctionAnalysis[]): Map<string, FunctionAnalysis[]> {
  const functionsByFile = new Map<string, FunctionAnalysis[]>();
  for (const functionAnalysis of functions) {
    const fileFunctions = functionsByFile.get(functionAnalysis.file) ?? [];
    fileFunctions.push(functionAnalysis);
    functionsByFile.set(functionAnalysis.file, fileFunctions);
  }
  return functionsByFile;
}

function matchFunction(
  callFrame: V8CallFrame,
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
    return undefined;
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

  function percentOf(part: number, total: number): number {
    return total === 0 ? 0 : Math.round((part / total) * 10_000) / 100;
  }
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
  if (relativePath.startsWith("dist/")) {
    candidates.add(`src/${relativePath.slice("dist/".length)}`);
    relativePath = relativePath.slice("dist/".length);
  }
  if (relativePath.startsWith("build/")) {
    candidates.add(`src/${relativePath.slice("build/".length)}`);
    relativePath = relativePath.slice("build/".length);
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
    candidates.add(`src/${sourcePath}`);
  }
  return [...candidates];
}

function percentOf(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 10_000) / 100;
}