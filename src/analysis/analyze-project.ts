import { basename } from "node:path";
import { createCompilerFacade } from "../compiler/compiler-facade.js";
import { buildCallGraph } from "./call-graph.js";
import { attachCpuProfile, loadV8CpuProfile } from "./cpu-profile.js";
import { evaluateEligibility, propagateEligibility } from "./eligibility.js";
import { inferDirectEffects, propagateEffects } from "./effects.js";
import { collectFunctions } from "./functions.js";
import { findCandidateIslands } from "./islands.js";
import { calculateNativePriority, scoreOpportunities } from "./opportunities.js";
import type { AnalysisResult, FunctionAnalysis, FunctionId } from "./model.js";

export interface AnalyzeProjectOptions {
  readonly profilePath?: string;
}

export function analyzeProject(target: string, options: AnalyzeProjectOptions = {}): AnalysisResult {
  const facade = createCompilerFacade(target);
  const functionIndex = collectFunctions(facade);
  const callsByFunction = buildCallGraph(facade, functionIndex);
  const directFunctions: FunctionAnalysis[] = functionIndex.definitions.map((definition) => {
    const calls = callsByFunction.get(definition.id) ?? [];
    const eligibility = evaluateEligibility(definition, calls, facade);
    const directEffects = inferDirectEffects(definition, calls, facade);
    return {
      id: definition.id,
      name: definition.name,
      file: definition.file,
      line: definition.line,
      eligibility: eligibility.eligibility,
      suitability: eligibility.suitability,
      opportunities: { cpu: 0, memory: 0, parallel: 0 },
      nativePriority: 0,
      directEffects,
      effects: [],
      calls,
    };
  });
  const effectfulFunctions = propagateEffects(propagateEligibility(directFunctions));
  const allFunctions = effectfulFunctions.map((functionAnalysis) => {
    const definition = functionIndex.byId.get(functionAnalysis.id);
    if (!definition) {
      return functionAnalysis;
    }
    const opportunities = scoreOpportunities(definition, functionAnalysis.effects, facade);
    return {
      ...functionAnalysis,
      opportunities,
      nativePriority: calculateNativePriority(functionAnalysis.suitability, opportunities),
    };
  });

  const scopedFunctionIds = getTargetCallClosure(functionIndex.definitions, callsByFunction);
  let functions = allFunctions
    .filter((functionAnalysis) => scopedFunctionIds.has(functionAnalysis.id))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  let candidateIslands = findCandidateIslands(allFunctions, scopedFunctionIds);
  let cpuProfile: AnalysisResult["cpuProfile"];

  if (options.profilePath) {
    const profile = loadV8CpuProfile(options.profilePath, facade.projectRoot, functions);
    const profiled = attachCpuProfile(functions, candidateIslands, profile);
    functions = [...profiled.functions]
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
    candidateIslands = [...profiled.candidateIslands];
    cpuProfile = profiled.cpuProfile;
  }

  return {
    projectName: basename(facade.projectRoot),
    projectRoot: facade.projectRoot,
    typescript: {
      version: facade.version,
      source: facade.source,
    },
    ...(cpuProfile ? { cpuProfile } : {}),
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
