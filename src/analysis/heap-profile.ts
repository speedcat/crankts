import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type {
  AllocationObservation,
  AllocationProfileSummary,
  AnalysisResult,
  EvidenceConfidence,
  FunctionAnalysis,
  FunctionId,
} from "./model.js";
import { classifyOrigin, indexFunctionsByFile, matchFunction, percentOf } from "./cpu-profile.js";
import type { ProfileCallFrame } from "./cpu-profile.js";

interface V8HeapProfileNode {
  readonly id: number;
  readonly callFrame: ProfileCallFrame;
  readonly children?: readonly V8HeapProfileNode[];
}

interface V8HeapProfileSample {
  readonly nodeId: number;
  readonly size: number;
  readonly sizeBytes?: number;
}

interface V8HeapProfile {
  readonly head: V8HeapProfileNode;
  readonly samples: readonly V8HeapProfileSample[];
}

interface LoadedHeapSample {
  readonly nodeId: number;
  readonly sampledBytes: number;
}

export interface LoadedHeapProfile {
  readonly summary: AllocationProfileSummary;
  readonly observations: ReadonlyMap<FunctionId, AllocationObservation>;
  readonly samples: readonly LoadedHeapSample[];
}

export function loadV8HeapProfile(
  profilePath: string,
  projectRoot: string,
  functions: readonly FunctionAnalysis[],
): LoadedHeapProfile {
  const absoluteProfilePath = resolve(profilePath);
  let rawProfile: unknown;
  try {
    rawProfile = JSON.parse(readFileSync(absoluteProfilePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read V8 heap profile '${absoluteProfilePath}': ${message}`);
  }

  const profile = validateHeapProfile(rawProfile, absoluteProfilePath);
  const functionsByFile = indexFunctionsByFile(functions);
  const functionByNode = new Map<number, FunctionId>();
  // Frames whose allocations a caller cannot reshape: dependency code and module loading.
  const nonAttributableNodes = new Set<number>();
  const parentByNode = new Map<number, number>();
  const visitedNodes = new Set<number>();
  const visit = (node: V8HeapProfileNode, parentId?: number): void => {
    if (visitedNodes.has(node.id)) {
      throw new Error(`Invalid V8 heap profile '${absoluteProfilePath}': duplicate or cyclic node id ${node.id}.`);
    }
    visitedNodes.add(node.id);
    if (parentId !== undefined) parentByNode.set(node.id, parentId);
    const functionAnalysis = matchFunction(node.callFrame, projectRoot, functionsByFile);
    if (functionAnalysis) functionByNode.set(node.id, functionAnalysis.id);
    else if (isNonAttributableFrame(node.callFrame, projectRoot)) nonAttributableNodes.add(node.id);
    for (const child of node.children ?? []) visit(child, node.id);
  };
  visit(profile.head);

  const selfBytesByFunction = new Map<FunctionId, number>();
  const totalBytesByFunction = new Map<FunctionId, number>();
  const selfCountByFunction = new Map<FunctionId, number>();
  const totalCountByFunction = new Map<FunctionId, number>();
  const attributableBytesByFunction = new Map<FunctionId, number>();
  const attributableCountByFunction = new Map<FunctionId, number>();
  const samples: LoadedHeapSample[] = [];
  let totalSampledBytes = 0;
  let matchedSampledBytes = 0;
  let matchedSampleCount = 0;

  for (const sample of profile.samples) {
    const sampledBytes = sample.sizeBytes ?? sample.size;
    totalSampledBytes += sampledBytes;
    const functionIds = new Set<FunctionId>();
    let nearestFunctionId: FunctionId | undefined;
    let crossesNonAttributableFrame = false;
    let currentNodeId: number | undefined = sample.nodeId;
    const visitedNodeIds = new Set<number>();
    while (currentNodeId !== undefined && !visitedNodeIds.has(currentNodeId)) {
      visitedNodeIds.add(currentNodeId);
      const functionId = functionByNode.get(currentNodeId);
      if (functionId) {
        functionIds.add(functionId);
        nearestFunctionId ??= functionId;
      } else if (!nearestFunctionId && nonAttributableNodes.has(currentNodeId)) {
        crossesNonAttributableFrame = true;
      }
      currentNodeId = parentByNode.get(currentNodeId);
    }
    if (nearestFunctionId && !crossesNonAttributableFrame) {
      attributableBytesByFunction.set(nearestFunctionId, (attributableBytesByFunction.get(nearestFunctionId) ?? 0) + sampledBytes);
      attributableCountByFunction.set(nearestFunctionId, (attributableCountByFunction.get(nearestFunctionId) ?? 0) + 1);
    }

    if (functionIds.size > 0) {
      matchedSampledBytes += sampledBytes;
      matchedSampleCount += 1;
      for (const functionId of functionIds) {
        totalBytesByFunction.set(functionId, (totalBytesByFunction.get(functionId) ?? 0) + sampledBytes);
        totalCountByFunction.set(functionId, (totalCountByFunction.get(functionId) ?? 0) + 1);
      }
    }

    const selfFunctionId = functionByNode.get(sample.nodeId);
    if (selfFunctionId) {
      selfBytesByFunction.set(selfFunctionId, (selfBytesByFunction.get(selfFunctionId) ?? 0) + sampledBytes);
      selfCountByFunction.set(selfFunctionId, (selfCountByFunction.get(selfFunctionId) ?? 0) + 1);
    }
    samples.push({ nodeId: sample.nodeId, sampledBytes });
  }

  const observations = new Map<FunctionId, AllocationObservation>();
  for (const functionAnalysis of functions) {
    const sampledBytesSelf = selfBytesByFunction.get(functionAnalysis.id) ?? 0;
    const sampledBytesAttributable = attributableBytesByFunction.get(functionAnalysis.id) ?? 0;
    observations.set(functionAnalysis.id, {
      sampledBytesSelf,
      sampledBytesTotal: totalBytesByFunction.get(functionAnalysis.id) ?? sampledBytesSelf,
      sampledBytesSelfPercent: percentOf(sampledBytesSelf, totalSampledBytes),
      sampledBytesTotalPercent: percentOf(totalBytesByFunction.get(functionAnalysis.id) ?? sampledBytesSelf, totalSampledBytes),
      sampleCountSelf: selfCountByFunction.get(functionAnalysis.id) ?? 0,
      sampleCountTotal: totalCountByFunction.get(functionAnalysis.id) ?? selfCountByFunction.get(functionAnalysis.id) ?? 0,
      sampledBytesAttributable,
      sampledBytesAttributablePercent: percentOf(sampledBytesAttributable, totalSampledBytes),
      sampleCountAttributable: attributableCountByFunction.get(functionAnalysis.id) ?? 0,
    });
  }

  const matchedSampledPercent = percentOf(matchedSampledBytes, totalSampledBytes);
  const confidence = getProfileConfidence(matchedSampledPercent, matchedSampleCount);
  return {
    summary: {
      file: relative(process.cwd(), absoluteProfilePath).split(sep).join("/") || absoluteProfilePath,
      totalSampledBytes,
      matchedSampledBytes,
      matchedSampledPercent,
      sampleCount: profile.samples.length,
      matchedSampleCount,
      unit: "bytes",
      confidence,
    },
    observations,
    samples,
  };
}

export function attachHeapProfile(
  functions: readonly FunctionAnalysis[],
  profile: LoadedHeapProfile,
): Pick<AnalysisResult, "functions" | "allocationProfile"> {
  return {
    functions: functions.map((functionAnalysis) => {
      const observedAllocation = profile.observations.get(functionAnalysis.id);
      return observedAllocation ? { ...functionAnalysis, observedAllocation } : functionAnalysis;
    }),
    allocationProfile: profile.summary,
  };
}

function isNonAttributableFrame(callFrame: ProfileCallFrame, projectRoot: string): boolean {
  return (callFrame.url ?? "").startsWith("node:internal/modules/")
    || classifyOrigin(callFrame, projectRoot).kind === "PACKAGE";
}

function validateHeapProfile(value: unknown, profilePath: string): V8HeapProfile {
  if (!isRecord(value) || !isRecord(value.head) || !Array.isArray(value.samples)) {
    throw new Error(`Invalid V8 heap profile '${profilePath}': expected head and samples.`);
  }
  const validateNode = (node: unknown): node is V8HeapProfileNode => {
    if (!isRecord(node)
      || !Number.isInteger(node.id)
      || !isRecord(node.callFrame)
      || node.callFrame.functionName !== undefined && typeof node.callFrame.functionName !== "string"
      || node.callFrame.url !== undefined && typeof node.callFrame.url !== "string"
      || node.callFrame.lineNumber !== undefined && typeof node.callFrame.lineNumber !== "number"
      || node.children !== undefined && !Array.isArray(node.children)) {
      return false;
    }
    return (node.children ?? []).every(validateNode);
  };
  if (!validateNode(value.head)) {
    throw new Error(`Invalid V8 heap profile '${profilePath}': head contains an invalid node.`);
  }
  const samples = value.samples.map((sample, index) => {
    if (!isRecord(sample) || typeof sample.nodeId !== "number" || !Number.isInteger(sample.nodeId)) {
      throw new Error(`Invalid V8 heap profile '${profilePath}': samples[${index}] must specify an integer nodeId.`);
    }
    const size = typeof sample.sizeBytes === "number" ? sample.sizeBytes : sample.size;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid V8 heap profile '${profilePath}': samples[${index}] must have a non-negative size.`);
    }
    return {
      nodeId: sample.nodeId,
      size,
      ...(typeof sample.sizeBytes === "number" ? { sizeBytes: sample.sizeBytes } : {}),
    };
  });
  return { head: value.head, samples };
}

function getProfileConfidence(matchedPercent: number, matchedSampleCount: number): EvidenceConfidence {
  return matchedPercent >= 80 && matchedSampleCount >= 100
    ? "HIGH"
    : matchedPercent >= 50 && matchedSampleCount >= 25
      ? "MEDIUM"
      : "LOW";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}