import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type {
  BoundaryRisk,
  PipelineAggregation,
  PipelineAnalysis,
  PipelineDescriptor,
  PipelineFunctionReference,
  PipelineInputSharing,
  PipelineIndependentWork,
  PipelineOptimizationHint,
  PipelineResourceEffect,
  PipelineScheduling,
  PipelineSinkAdapter,
  PipelineSinkAnalysis,
  PipelineSinkDescriptor,
  PipelineSinkWriterMode,
  PipelineStageAnalysis,
  PipelineStageDescriptor,
  PipelineWorkUnit,
} from "./model.js";

const sqliteAdapters = new Set<PipelineSinkAdapter>([
  "SQLITE",
  "BETTER_SQLITE3",
  "NODE_SQLITE",
]);
const workUnits = new Set<PipelineWorkUnit>(["FILE", "CHUNK", "RECORD", "BATCH", "UNKNOWN"]);
const schedulings = new Set<PipelineScheduling>(["SERIAL", "ASYNC_IO", "WORKERS", "UNKNOWN"]);
const inputSharingModes = new Set<PipelineInputSharing>(["READ_ONLY", "SHARED_MUTABLE", "UNKNOWN"]);
const aggregationModes = new Set<PipelineAggregation>(["PER_UNIT", "REDUCTION", "ORDERED", "SHARED_STATE", "UNKNOWN"]);
const sinkAdapters = new Set<PipelineSinkAdapter>(["SQLITE", "BETTER_SQLITE3", "NODE_SQLITE", "GENERIC"]);
const writerModes = new Set<PipelineSinkWriterMode>(["SINGLE_WRITER", "MULTI_WRITER", "UNKNOWN"]);

export function loadPipelineDescriptor(pipelinePath: string): PipelineDescriptor {
  let contents: string;
  try {
    contents = readFileSync(pipelinePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read pipeline descriptor '${pipelinePath}': ${message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pipeline descriptor '${pipelinePath}': ${message}`);
  }
  return validatePipelineDescriptor(value, pipelinePath);
}

export function validatePipelineDescriptor(value: unknown, source = "<pipeline>"): PipelineDescriptor {
  if (!isRecord(value)) {
    throw descriptorError(source, "expected a JSON object");
  }
  if (value.schemaVersion !== 1) {
    throw descriptorError(source, "schemaVersion must be 1");
  }
  if (value.workloadLabel !== undefined && !isNonEmptyString(value.workloadLabel)) {
    throw descriptorError(source, "workloadLabel must be a non-empty string when provided");
  }
  if (!Array.isArray(value.stages) || !Array.isArray(value.sinks)) {
    throw descriptorError(source, "stages and sinks must be arrays");
  }

  const stages = value.stages.map((stage, index) => validateStage(stage, index, source));
  const sinks = value.sinks.map((sink, index) => validateSink(sink, index, source));
  assertUniqueIds(stages.map((stage) => stage.id), "stage", source);
  assertUniqueIds(sinks.map((sink) => sink.id), "sink", source);

  const stageIds = new Set(stages.map((stage) => stage.id));
  const sinkIds = new Set(sinks.map((sink) => sink.id));
  for (const stage of stages) {
    for (const dependency of stage.dependsOn) {
      if (!stageIds.has(dependency)) {
        throw descriptorError(source, `stage '${stage.id}' depends on unknown stage '${dependency}'`);
      }
    }
    for (const sinkId of stage.sinkIds ?? []) {
      if (!sinkIds.has(sinkId)) {
        throw descriptorError(source, `stage '${stage.id}' references unknown sink '${sinkId}'`);
      }
    }
  }
  assertAcyclic(stages, source);

  return {
    schemaVersion: 1,
    ...(value.workloadLabel ? { workloadLabel: value.workloadLabel } : {}),
    stages,
    sinks,
  };
}

export function analyzePipeline(
  descriptor: PipelineDescriptor,
  functions: readonly PipelineFunctionReference[],
): PipelineAnalysis {
  const stages: PipelineStageAnalysis[] = descriptor.stages.map((stage) => {
    const matches = functions.filter((functionReference) => (
      normalizePath(functionReference.file) === normalizePath(stage.entry.file)
      && functionReference.name === stage.entry.name
    ));
    const entryStatus = matches.length === 1 ? "RESOLVED" : matches.length > 1 ? "AMBIGUOUS" : "UNRESOLVED";
    const functionReference = matches.length === 1 ? matches[0] : undefined;
    const independent = classifyIndependentWork(stage, entryStatus);
    return {
      ...stage,
      entryStatus,
      ...(functionReference ? { functionId: functionReference.id } : {}),
      independentWork: independent.value,
      explanation: independent.explanation,
    };
  });

  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const sinks = descriptor.sinks.map((sink) => analyzeSink(sink, stages, stageById));
  const knownRisks = sinks.map((sink) => sink.scalingRisk).filter((risk) => risk !== "UNKNOWN");
  const serializationRisk = knownRisks.includes("HIGH")
    ? "HIGH"
    : knownRisks.includes("MEDIUM")
      ? "MEDIUM"
      : knownRisks.includes("LOW")
        ? "LOW"
        : "UNKNOWN";

  return {
    schemaVersion: 1,
    ...(descriptor.workloadLabel ? { workloadLabel: descriptor.workloadLabel } : {}),
    stages,
    sinks,
    parallelCandidateStageCount: stages.filter((stage) => stage.independentWork === "CANDIDATE").length,
    serializedSinkCount: sinks.filter((sink) => sink.serialized === true).length,
    serializationRisk,
  };
}

function analyzeSink(
  descriptor: PipelineSinkDescriptor,
  stages: readonly PipelineStageAnalysis[],
  stageById: ReadonlyMap<string, PipelineStageAnalysis>,
): PipelineSinkAnalysis {
  const writerStages = stages.filter((stage) => stage.sinkIds?.includes(descriptor.id));
  const explicitMode = descriptor.writerMode ?? "UNKNOWN";
  const serialized = explicitMode === "SINGLE_WRITER"
    || explicitMode === "UNKNOWN" && sqliteAdapters.has(descriptor.adapter)
    ? true
    : explicitMode === "MULTI_WRITER"
      ? false
      : null;
  const resourceEffects = getResourceEffects(descriptor, serialized);
  const upstreamStageIds = new Set<string>();
  const pending = writerStages.flatMap((stage) => [...stage.dependsOn]);
  while (pending.length > 0) {
    const stageId = pending.pop();
    if (!stageId || upstreamStageIds.has(stageId)) continue;
    upstreamStageIds.add(stageId);
    pending.push(...(stageById.get(stageId)?.dependsOn ?? []));
  }
  const candidateUpstreamStageIds = [...upstreamStageIds].filter((stageId) => (
    stageById.get(stageId)?.independentWork === "CANDIDATE"
  ));

  let scalingRisk: BoundaryRisk | "UNKNOWN";
  if (serialized === false) {
    scalingRisk = "LOW";
  } else if (serialized === null) {
    scalingRisk = "UNKNOWN";
  } else if (writerStages.length === 0) {
    scalingRisk = "UNKNOWN";
  } else if (candidateUpstreamStageIds.length > 0) {
    scalingRisk = "HIGH";
  } else {
    scalingRisk = "MEDIUM";
  }

  return {
    ...descriptor,
    serialized,
    resourceEffects,
    writerStageCount: writerStages.length,
    writerStageIds: writerStages.map((stage) => stage.id),
    upstreamStageIds: [...upstreamStageIds],
    candidateUpstreamStageIds,
    scalingRisk,
  };
}

function classifyIndependentWork(
  stage: PipelineStageDescriptor,
  entryStatus: PipelineStageAnalysis["entryStatus"],
): { value: PipelineIndependentWork; explanation: string } {
  if (entryStatus !== "RESOLVED") {
    return { value: "UNKNOWN", explanation: `Stage entry is ${entryStatus.toLowerCase()}.` };
  }
  if (stage.inputSharing === "SHARED_MUTABLE" || stage.aggregation === "SHARED_STATE") {
    return { value: "NO", explanation: "The stage declares shared mutable input or shared-state aggregation." };
  }
  if (stage.inputSharing === "UNKNOWN" || stage.aggregation === "UNKNOWN" || stage.workUnit === "UNKNOWN") {
    return { value: "UNKNOWN", explanation: "Work-unit independence is not declared precisely enough." };
  }
  if (stage.aggregation === "PER_UNIT" || stage.aggregation === "REDUCTION" || stage.aggregation === "ORDERED") {
    const ordered = stage.aggregation === "ORDERED" ? " Ordered merge/commit may still serialize output." : "";
    return {
      value: "CANDIDATE",
      explanation: `Read-only ${stage.workUnit.toLowerCase()} inputs have independent work units.${ordered}`,
    };
  }
  return { value: "NO", explanation: "The declared aggregation does not preserve independent work units." };
}

function getResourceEffects(
  sink: PipelineSinkDescriptor,
  serialized: boolean | null,
): PipelineResourceEffect[] {
  const effects = new Set<PipelineResourceEffect>(["SHARED_EXTERNAL_STATE"]);
  if (serialized) {
    effects.add("SERIALIZED_SINK");
    effects.add("SINGLE_WRITER_RESOURCE");
  }
  if (sink.transactional) effects.add("TRANSACTIONAL_WRITE");
  if (sink.orderedCommit) effects.add("ORDERED_COMMIT");
  return [...effects];
}

function validateStage(value: unknown, index: number, source: string): PipelineStageDescriptor {
  const location = `stages[${index}]`;
  if (!isRecord(value)) throw descriptorError(source, `${location} must be an object`);
  if (!isNonEmptyString(value.id)) throw descriptorError(source, `${location}.id must be a non-empty string`);
  if (!isRecord(value.entry)
    || !isNonEmptyString(value.entry.file)
    || !isNonEmptyString(value.entry.name)) {
    throw descriptorError(source, `${location}.entry must specify non-empty file and name strings`);
  }
  if (!isStringSetMember(value.workUnit, workUnits)) throw descriptorError(source, `${location}.workUnit is invalid`);
  if (!isStringSetMember(value.scheduling, schedulings)) throw descriptorError(source, `${location}.scheduling is invalid`);
  if (!isStringSetMember(value.inputSharing, inputSharingModes)) throw descriptorError(source, `${location}.inputSharing is invalid`);
  if (!isStringSetMember(value.aggregation, aggregationModes)) throw descriptorError(source, `${location}.aggregation is invalid`);
  if (!Array.isArray(value.dependsOn) || !value.dependsOn.every(isNonEmptyString)) {
    throw descriptorError(source, `${location}.dependsOn must be an array of stage ids`);
  }
  if (value.sinkIds !== undefined && (!Array.isArray(value.sinkIds) || !value.sinkIds.every(isNonEmptyString))) {
    throw descriptorError(source, `${location}.sinkIds must be an array of sink ids`);
  }
  if (value.optimizationHints !== undefined && !Array.isArray(value.optimizationHints)) {
    throw descriptorError(source, `${location}.optimizationHints must be an array`);
  }
  const optimizationHints = (value.optimizationHints ?? []).map((hint, hintIndex) => {
    if (!isRecord(hint)
      || (hint.category !== "ALGORITHMIC" && hint.category !== "DATA_LAYOUT")
      || !isOptimizationPotential(hint.level)
      || !isNonEmptyString(hint.evidence)) {
      throw descriptorError(source, `${location}.optimizationHints[${hintIndex}] is invalid`);
    }
    return { category: hint.category, level: hint.level, evidence: hint.evidence } satisfies PipelineOptimizationHint;
  });
  return {
    id: value.id,
    entry: { file: normalizePath(value.entry.file), name: value.entry.name },
    workUnit: value.workUnit,
    scheduling: value.scheduling,
    inputSharing: value.inputSharing,
    aggregation: value.aggregation,
    dependsOn: [...value.dependsOn],
    ...(value.sinkIds ? { sinkIds: [...value.sinkIds] } : {}),
    ...(optimizationHints.length > 0 ? { optimizationHints } : {}),
  };
}

function validateSink(value: unknown, index: number, source: string): PipelineSinkDescriptor {
  const location = `sinks[${index}]`;
  if (!isRecord(value)) throw descriptorError(source, `${location} must be an object`);
  if (!isNonEmptyString(value.id)) throw descriptorError(source, `${location}.id must be a non-empty string`);
  if (!isStringSetMember(value.adapter, sinkAdapters)) throw descriptorError(source, `${location}.adapter is invalid`);
  if (value.writerMode !== undefined && !isStringSetMember(value.writerMode, writerModes)) {
    throw descriptorError(source, `${location}.writerMode is invalid`);
  }
  if (value.transactional !== undefined && typeof value.transactional !== "boolean") {
    throw descriptorError(source, `${location}.transactional must be a boolean`);
  }
  if (value.orderedCommit !== undefined && typeof value.orderedCommit !== "boolean") {
    throw descriptorError(source, `${location}.orderedCommit must be a boolean`);
  }
  return {
    id: value.id,
    adapter: value.adapter,
    ...(value.writerMode ? { writerMode: value.writerMode } : {}),
    ...(value.transactional !== undefined ? { transactional: value.transactional } : {}),
    ...(value.orderedCommit !== undefined ? { orderedCommit: value.orderedCommit } : {}),
  };
}

function assertUniqueIds(ids: readonly string[], kind: string, source: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw descriptorError(source, `duplicate ${kind} id '${id}'`);
    seen.add(id);
  }
}

function assertAcyclic(stages: readonly PipelineStageDescriptor[], source: string): void {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stageId: string): void => {
    if (visited.has(stageId)) return;
    if (visiting.has(stageId)) throw descriptorError(source, `stage dependency cycle includes '${stageId}'`);
    visiting.add(stageId);
    for (const dependency of stageById.get(stageId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(stageId);
    visited.add(stageId);
  };
  for (const stage of stages) visit(stage.id);
}

function normalizePath(file: string): string {
  return posix.normalize(file.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function descriptorError(source: string, detail: string): Error {
  return new Error(`Invalid pipeline descriptor '${source}': ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringSetMember<T extends string>(value: unknown, values: ReadonlySet<T>): value is T {
  return typeof value === "string" && values.has(value as T);
}

function isOptimizationPotential(value: unknown): value is PipelineOptimizationHint["level"] {
  return value === "VERY_HIGH" || value === "HIGH" || value === "MEDIUM" || value === "LOW";
}