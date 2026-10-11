import { basename } from "node:path";
import type * as ts from "typescript";
import { createCompilerFacade } from "../compiler/compiler-facade.js";
import { buildCallGraph } from "./call-graph.js";
import { attachCpuProfile, loadV8CpuProfile } from "./cpu-profile.js";
import { detectHoistCandidates } from "./hoist.js";
import { readInputSignatures, siteKey, writeInputSignatureProbe, type ProbeSite } from "./input-signatures.js";
import { nativeAddonCallLines } from "./native-addon.js";
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
  /** Input-signature profiles (`writeHoistInputProbe`) supplying repetition evidence for hoisting candidates. */
  readonly inputSignaturePaths?: readonly string[];
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
      loadV8CpuProfile(profilePath, facade.projectRoot, functions, {
        nativeAddonCallLines: (functionId) => {
          const definition = functionIndex.byId.get(functionId);
          return definition ? nativeAddonCallLines(definition.node, definition.compilerFacade) : undefined;
        },
      })
    ));
    const profiled = measureStage(timer, "profile.cpu.attach", () => (
      attachCpuProfile(functions, candidateIslands, profile)
    ));
    const repetition = options.inputSignaturePaths?.length ? readInputSignatures(options.inputSignaturePaths) : new Map();
    const totalMicros = Math.max(1, profile.summary.totalSampleMicros);
    const inclusiveById = new Map(profiled.functions.map((fn) => [fn.id, fn.observedCpu ? (fn.observedCpu.totalCpuMicros / totalMicros) * 100 : undefined]));
    const idByNode = new Map(functionIndex.definitions.map((definition) => [definition.node as ts.Node, definition.id]));
    const calleeCost = (declaration: ts.Node): number | undefined => {
      const id = idByNode.get(declaration);
      const percent = id ? inclusiveById.get(id) : undefined;
      return percent === undefined ? undefined : Math.round(percent * 100) / 100;
    };
    functions = measureStage(timer, "profile.cpu.hoist", () => profiled.functions.map((functionAnalysis) => {
      // Recognition is limited to call sites the profile shows (≥ 0.05% of runtime).
      const callSite = functionAnalysis.observedCpu?.callSite;
      const definition = functionIndex.byId.get(functionAnalysis.id);
      if (!callSite || callSite.attributedPercent < 0.05 || !definition) return functionAnalysis;
      const candidates = detectHoistCandidates(definition.node, definition.compilerFacade, callSite, calleeCost).map((candidate) => {
        const evidence = repetition.get(siteKey(facade.projectRoot, definition.absoluteFile, candidate.line, candidate.column));
        return evidence ? { ...candidate, repetition: evidence } : candidate;
      });
      return candidates.length > 0 ? { ...functionAnalysis, hoistCandidates: candidates } : functionAnalysis;
    }))
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

/**
 * Writes an input-signature probe (`node --import <importPath> <program>`, with `CRANKTS_SIGNATURES_OUT`
 * set) for the static, parameter-dependent, and variant hoisting candidates of a profiled analysis whose time at stake is at
 * least `minPercent` of the runtime. Re-analyze with `inputSignaturePaths` to attach the evidence.
 */
export function writeHoistInputProbe(
  target: string,
  analysis: AnalysisResult,
  outDir: string,
  options: { readonly minPercent?: number; readonly workspaceReferences?: boolean } = {},
): { readonly importPath: string; readonly sites: readonly string[] } {
  const facade = createCompilerFacade(target, { workspaceReferences: options.workspaceReferences === true });
  const index = collectFunctions(facade);
  const sites: ProbeSite[] = [];
  for (const fn of analysis.functions) {
    const definition = index.byId.get(fn.id);
    if (!definition) continue;
    for (const candidate of fn.hoistCandidates ?? []) {
      // Loop invariance needs no measurement; everything else needs call counts or input repetition.
      const atStake = candidate.atStakePercent ?? fn.observedCpu?.callSite?.attributedPercent ?? 0;
      if (candidate.invariance === "LOOP_INVARIANT" || atStake < (options.minPercent ?? 0.5)) continue;
      const call = findCallAt(definition.compilerFacade.typescript, definition.node, candidate.line, candidate.column);
      if (call) sites.push({ file: definition.absoluteFile, call, key: siteKey(facade.projectRoot, definition.absoluteFile, candidate.line, candidate.column) });
    }
  }
  const probe = writeInputSignatureProbe(sites, outDir);
  return { importPath: probe.importPath, sites: sites.map((site) => site.key) };
}

function findCallAt(t: typeof ts, root: ts.Node, line: number, column: number): ts.CallExpression | ts.NewExpression | undefined {
  const sourceFile = root.getSourceFile();
  let found: ts.CallExpression | ts.NewExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (t.isCallExpression(node) || t.isNewExpression(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      if (position.line + 1 === line && position.character + 1 === column) {
        found = node;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

