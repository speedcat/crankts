import { basename } from "node:path";
import { createCompilerFacade } from "../compiler/compiler-facade.js";
import { buildCallGraph } from "./call-graph.js";
import { attachCpuProfile, loadV8CpuProfile } from "./cpu-profile.js";
import { attachHeapProfile, loadV8HeapProfile } from "./heap-profile.js";
import { evaluateEligibility, propagateEligibility } from "./eligibility.js";
import { inferDirectEffects, propagateEffects } from "./effects.js";
import { collectFunctions } from "./functions.js";
import { findCandidateIslands } from "./islands.js";
import { calculateNativePriority, scoreOpportunities } from "./opportunities.js";
import { analyzeParallelism } from "./parallelism.js";
import { analyzeAcceleration } from "./assessment.js";
import { analyzePipeline, loadPipelineDescriptor } from "./pipeline.js";
import { accumulateStage, measureStage, type StageTimer } from "./timings.js";
import type { AnalysisResult, FunctionAnalysis, FunctionId } from "./model.js";

export interface AnalyzeProjectOptions {
  readonly workspaceReferences?: boolean;
  readonly profilePath?: string;
  readonly heapProfilePath?: string;
  readonly pipelinePath?: string;
  readonly workloadLabel?: string;
  /** Opt-in stage recorder (`--timings`); never affects the analysis result. */
  readonly timings?: StageTimer;
}

export function analyzeProject(target: string, options: AnalyzeProjectOptions = {}): AnalysisResult {
  const timer = options.timings;
  const facade = measureStage(timer, "program", () => (
    createCompilerFacade(target, { workspaceReferences: options.workspaceReferences === true })
  ));
  const functionIndex = measureStage(timer, "functions", () => collectFunctions(facade));
  const callsByFunction = measureStage(timer, "callGraph", () => buildCallGraph(facade, functionIndex));
  const directFunctions: FunctionAnalysis[] = measureStage(timer, "direct", () => functionIndex.definitions.map((definition) => {
    const projectFacade = definition.compilerFacade;
    const calls = callsByFunction.get(definition.id) ?? [];
    const eligibility = accumulateStage(timer, "direct.eligibility", () => (
      evaluateEligibility(definition, calls, projectFacade)
    ));
    const directEffects = accumulateStage(timer, "direct.effects", () => (
      inferDirectEffects(definition, calls, projectFacade)
    ));
    return {
      id: definition.id,
      name: definition.name,
      file: definition.file,
      line: definition.line,
      eligibility: eligibility.eligibility,
      suitability: eligibility.suitability,
      opportunities: { cpu: 0, memory: 0, parallel: 0 },
      parallelism: { classification: "UNKNOWN", reads: [], writes: [], sharedWrites: [], dependences: [], regions: [] },
      nativePriority: 0,
      directEffects,
      effects: [],
      calls,
    };
  }));
  const eligibleFunctions = measureStage(timer, "propagation.eligibility", () => propagateEligibility(directFunctions));
  const effectfulFunctions = measureStage(timer, "propagation.effects", () => propagateEffects(eligibleFunctions));
  const effectsByFunction = new Map(effectfulFunctions.map((functionAnalysis) => [functionAnalysis.id, functionAnalysis.effects]));
  const allFunctions = measureStage(timer, "scoring", () => effectfulFunctions.map((functionAnalysis) => {
    const definition = functionIndex.byId.get(functionAnalysis.id);
    if (!definition) {
      return functionAnalysis;
    }
    const projectFacade = definition.compilerFacade;
    const opportunities = accumulateStage(timer, "scoring.opportunities", () => (
      scoreOpportunities(definition, functionAnalysis.effects, projectFacade)
    ));
    return {
      ...functionAnalysis,
      opportunities,
      parallelism: accumulateStage(timer, "scoring.parallelism", () => analyzeParallelism(
        definition,
        functionAnalysis.calls,
        functionAnalysis.effects,
        projectFacade,
        effectsByFunction,
      )),
      nativePriority: calculateNativePriority(functionAnalysis.suitability, opportunities),
    };
  }));

  const scopedFunctionIds = measureStage(timer, "callClosure", () => (
    getTargetCallClosure(functionIndex.definitions, callsByFunction)
  ));
  let functions = allFunctions
    .filter((functionAnalysis) => scopedFunctionIds.has(functionAnalysis.id))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  let candidateIslands = measureStage(timer, "islands", () => (
    findCandidateIslands(allFunctions, scopedFunctionIds, timer)
  ));
  let cpuProfile: AnalysisResult["cpuProfile"];
  let allocationProfile: AnalysisResult["allocationProfile"];

  if (options.profilePath) {
    const profilePath = options.profilePath;
    const profile = measureStage(timer, "profile.cpu.load", () => (
      loadV8CpuProfile(profilePath, facade.projectRoot, functions)
    ));
    const profiled = measureStage(timer, "profile.cpu.attach", () => (
      attachCpuProfile(functions, candidateIslands, profile)
    ));
    functions = [...profiled.functions]
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
    candidateIslands = [...profiled.candidateIslands];
    cpuProfile = profiled.cpuProfile;
  }

  if (options.heapProfilePath) {
    const heapProfilePath = options.heapProfilePath;
    const profile = measureStage(timer, "profile.heap.load", () => (
      loadV8HeapProfile(heapProfilePath, facade.projectRoot, functions)
    ));
    const profiled = measureStage(timer, "profile.heap.attach", () => attachHeapProfile(functions, profile));
    functions = [...profiled.functions]
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
    allocationProfile = profiled.allocationProfile;
  }

  const loadedPipeline = options.pipelinePath
    ? analyzePipeline(
      loadPipelineDescriptor(options.pipelinePath),
      functions.map(({ id, file, name, parallelism }) => ({ id, file, name, parallelism })),
    )
    : undefined;
  const pipeline = loadedPipeline && options.workloadLabel
    ? { ...loadedPipeline, workloadLabel: options.workloadLabel }
    : loadedPipeline;
  const workloadLabel = options.workloadLabel ?? pipeline?.workloadLabel;
  const acceleration = measureStage(timer, "assessment", () => analyzeAcceleration({
    functions,
    candidateIslands,
    ...(pipeline ? { pipeline } : {}),
    ...(cpuProfile ? { cpuProfile } : {}),
    ...(allocationProfile ? { allocationProfile } : {}),
    ...(workloadLabel ? { workloadLabel } : {}),
  }));

  return {
    projectName: basename(facade.projectRoot),
    projectRoot: facade.projectRoot,
    ...(options.workspaceReferences
      ? {
        workspace: {
          projectConfigsLoaded: facade.projectFacades?.length ?? 1,
          skippedReferences: facade.skippedProjectReferences ?? [],
        },
      }
      : {}),
    typescript: {
      version: facade.version,
      source: facade.source,
    },
    ...(cpuProfile ? { cpuProfile } : {}),
    ...(allocationProfile ? { allocationProfile } : {}),
    ...(pipeline ? { pipeline } : {}),
    ...(workloadLabel ? { workloadLabel } : {}),
    acceleration,
    functions,
    candidateIslands,
  };
}

function getTargetCallClosure(
  definitions: readonly { readonly id: FunctionId; readonly isSeed: boolean }[],
  callsByFunction: ReadonlyMap<FunctionId, readonly FunctionAnalysis["calls"][number][]>,
): Set<FunctionId> {
  const visited = new Set<FunctionId>();
  const pending = definitions.filter((definition) => definition.isSeed).map((definition) => definition.id);

  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    for (const edge of callsByFunction.get(currentId) ?? []) {
      if (edge.to && !visited.has(edge.to)) {
        pending.push(edge.to);
      }
    }
  }

  return visited;
}
