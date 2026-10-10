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
import type { AnalysisResult, FunctionAnalysis, FunctionId } from "./model.js";

export interface AnalyzeProjectOptions {
  readonly workspaceReferences?: boolean;
  readonly profilePath?: string;
  readonly heapProfilePath?: string;
  readonly pipelinePath?: string;
  readonly workloadLabel?: string;
}

export function analyzeProject(target: string, options: AnalyzeProjectOptions = {}): AnalysisResult {
  const facade = createCompilerFacade(target, { workspaceReferences: options.workspaceReferences === true });
  const functionIndex = collectFunctions(facade);
  const callsByFunction = buildCallGraph(facade, functionIndex);
  const directFunctions: FunctionAnalysis[] = functionIndex.definitions.map((definition) => {
    const projectFacade = definition.compilerFacade;
    const calls = callsByFunction.get(definition.id) ?? [];
    const eligibility = evaluateEligibility(definition, calls, projectFacade);
    const directEffects = inferDirectEffects(definition, calls, projectFacade);
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
  });
  const effectfulFunctions = propagateEffects(propagateEligibility(directFunctions));
  const effectsByFunction = new Map(effectfulFunctions.map((functionAnalysis) => [functionAnalysis.id, functionAnalysis.effects]));
  const allFunctions = effectfulFunctions.map((functionAnalysis) => {
    const definition = functionIndex.byId.get(functionAnalysis.id);
    if (!definition) {
      return functionAnalysis;
    }
    const projectFacade = definition.compilerFacade;
    const opportunities = scoreOpportunities(definition, functionAnalysis.effects, projectFacade);
    return {
      ...functionAnalysis,
      opportunities,
      parallelism: analyzeParallelism(
        definition,
        functionAnalysis.calls,
        functionAnalysis.effects,
        projectFacade,
        effectsByFunction,
      ),
      nativePriority: calculateNativePriority(functionAnalysis.suitability, opportunities),
    };
  });

  const scopedFunctionIds = getTargetCallClosure(functionIndex.definitions, callsByFunction);
  let functions = allFunctions
    .filter((functionAnalysis) => scopedFunctionIds.has(functionAnalysis.id))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  let candidateIslands = findCandidateIslands(allFunctions, scopedFunctionIds);
  let cpuProfile: AnalysisResult["cpuProfile"];
  let allocationProfile: AnalysisResult["allocationProfile"];

  if (options.profilePath) {
    const profile = loadV8CpuProfile(options.profilePath, facade.projectRoot, functions);
    const profiled = attachCpuProfile(functions, candidateIslands, profile);
    functions = [...profiled.functions]
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
    candidateIslands = [...profiled.candidateIslands];
    cpuProfile = profiled.cpuProfile;
  }

  if (options.heapProfilePath) {
    const profile = loadV8HeapProfile(options.heapProfilePath, facade.projectRoot, functions);
    const profiled = attachHeapProfile(functions, profile);
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
  const acceleration = analyzeAcceleration({
    functions,
    candidateIslands,
    ...(pipeline ? { pipeline } : {}),
    ...(cpuProfile ? { cpuProfile } : {}),
    ...(allocationProfile ? { allocationProfile } : {}),
    ...(workloadLabel ? { workloadLabel } : {}),
  });

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
