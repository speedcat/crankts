import type {
  AccelerationAnalysis,
  AccelerationLevel,
  AccelerationRecommendation,
  AnalysisResult,
  BoundaryRisk,
  EvidenceConfidence,
  FunctionAccelerationAssessment,
  FunctionAnalysis,
  PipelineAnalysis,
  PipelineStageAnalysis,
} from "./model.js";

export interface AnalyzeAccelerationOptions {
  readonly functions: readonly FunctionAnalysis[];
  readonly candidateIslands: AnalysisResult["candidateIslands"];
  readonly pipeline?: PipelineAnalysis;
  readonly cpuProfile?: AnalysisResult["cpuProfile"];
  readonly allocationProfile?: AnalysisResult["allocationProfile"];
  readonly workloadLabel?: string;
}

export function analyzeAcceleration(options: AnalyzeAccelerationOptions): AccelerationAnalysis {
  const workloadLabel = options.workloadLabel ?? options.pipeline?.workloadLabel;
  const functionStages = new Map<string, PipelineStageAnalysis[]>();
  for (const stage of options.pipeline?.stages ?? []) {
    if (!stage.functionId) continue;
    const stages = functionStages.get(stage.functionId) ?? [];
    stages.push(stage);
    functionStages.set(stage.functionId, stages);
  }

  const boundaryRiskByFunction = new Map<string, BoundaryRisk>();
  for (const island of options.candidateIslands) {
    for (const functionId of island.members) boundaryRiskByFunction.set(functionId, island.boundaryRisk);
  }

  const functions = options.functions.map((functionAnalysis) => {
    const stages = functionStages.get(functionAnalysis.id) ?? [];
    return assessFunction(
      functionAnalysis,
      boundaryRiskByFunction.get(functionAnalysis.id) ?? "UNKNOWN",
      stages,
      options,
    );
  });

  return {
    ...(workloadLabel ? { workloadLabel } : {}),
    functions,
    pipelineRecommendations: assessPipeline(options.pipeline),
  };
}

function assessFunction(
  functionAnalysis: FunctionAnalysis,
  boundaryRisk: BoundaryRisk | "UNKNOWN",
  stages: readonly PipelineStageAnalysis[],
  options: AnalyzeAccelerationOptions,
): FunctionAccelerationAssessment {
  const observedCpu = functionAnalysis.observedCpu;
  const observedAllocation = functionAnalysis.observedAllocation;
  // Own JavaScript only: N-API time a frame spends in Rust/C++ is not something to offload again.
  const ownCpuPercent = observedCpu?.callSite ? observedCpu.callSite.byTarget.FUNCTION_SELF ?? 0 : observedCpu?.samplePercent;
  const hotness = getHotness(ownCpuPercent, options.cpuProfile?.confidence);
  const algorithmicHint = highestHint(stages, "ALGORITHMIC");
  const dataLayoutHint = highestHint(stages, "DATA_LAYOUT");
  const parallel = getParallelPotential(functionAnalysis, stages);
  const nativeExecution = getNativePotential(functionAnalysis, boundaryRisk, hotness, options.cpuProfile?.confidence);
  const memoryLayout = dataLayoutHint?.level
    ?? getMemoryPotential(
      // Inclusive bytes would credit orchestrators and dependency internals; layout advice targets
      // allocations the function itself controls.
      observedAllocation?.sampledBytesAttributablePercent ?? observedAllocation?.sampledBytesSelfPercent,
      observedAllocation?.sampleCountAttributable ?? observedAllocation?.sampleCountSelf,
      functionAnalysis.opportunities.memory,
      options.allocationProfile?.confidence,
    );

  const assessment: FunctionAccelerationAssessment = {
    functionId: functionAnalysis.id,
    name: functionAnalysis.name,
    feasibility: {
      eligibility: functionAnalysis.eligibility.kind,
      nativeSuitability: functionAnalysis.suitability,
      nativePriority: functionAnalysis.nativePriority,
      boundaryRisk,
    },
    staticOpportunity: functionAnalysis.opportunities,
    observedWorkload: {
      hotness,
      ...(observedCpu ? {
        selfCpuMicros: observedCpu.selfCpuMicros,
        inclusiveCpuMicros: observedCpu.totalCpuMicros,
        cpuSamplePercent: observedCpu.samplePercent,
        ...(observedCpu.callSite ? {
          ownCpuSamplePercent: observedCpu.callSite.byTarget.FUNCTION_SELF ?? 0,
          causedCpuSamplePercent: observedCpu.callSite.causedPercent,
        } : {}),
      } : {}),
      ...(options.cpuProfile ? {
        cpuProfileConfidence: options.cpuProfile.confidence,
        cpuMatchedSamplePercent: options.cpuProfile.matchedSamplePercent,
      } : {}),
      ...(observedAllocation ? {
        sampledAllocationBytesSelf: observedAllocation.sampledBytesSelf,
        sampledAllocationBytesTotal: observedAllocation.sampledBytesTotal,
        allocationSelfSamplePercent: observedAllocation.sampledBytesSelfPercent,
        allocationInclusiveSamplePercent: observedAllocation.sampledBytesTotalPercent,
        ...(observedAllocation.sampledBytesAttributablePercent !== undefined
          ? { allocationAttributableSamplePercent: observedAllocation.sampledBytesAttributablePercent }
          : {}),
        allocationSampleCountTotal: observedAllocation.sampleCountTotal,
      } : {}),
      ...(options.allocationProfile ? {
        allocationProfileConfidence: options.allocationProfile.confidence,
        allocationMatchedSampledPercent: options.allocationProfile.matchedSampledPercent,
      } : {}),
    },
    optimizationPotential: {
      algorithmic: algorithmicHint?.level ?? "UNKNOWN",
      parallel,
      nativeExecution,
      memoryLayout,
    },
    recommendations: [],
  };

  return {
    ...assessment,
    recommendations: assessFunctionRecommendations(
      functionAnalysis,
      boundaryRisk,
      stages,
      assessment,
      algorithmicHint?.evidence,
      dataLayoutHint?.evidence,
      options,
    ),
  };
}

function assessFunctionRecommendations(
  functionAnalysis: FunctionAnalysis,
  boundaryRisk: BoundaryRisk | "UNKNOWN",
  stages: readonly PipelineStageAnalysis[],
  assessment: FunctionAccelerationAssessment,
  algorithmicEvidence: string | undefined,
  dataLayoutEvidence: string | undefined,
  options: AnalyzeAccelerationOptions,
): AccelerationRecommendation[] {
  const recommendations: AccelerationRecommendation[] = [];
  const stageWithAlgorithmHint = stages.find((stage) => stage.optimizationHints?.some((hint) => hint.category === "ALGORITHMIC"));
  if (assessment.optimizationPotential.algorithmic !== "UNKNOWN" && algorithmicEvidence && stageWithAlgorithmHint) {
    recommendations.push({
      action: "OPTIMIZE_ALGORITHM",
      level: assessment.optimizationPotential.algorithmic,
      confidence: "MEDIUM",
      targetKind: "FUNCTION",
      targetId: functionAnalysis.id,
      evidence: [`pipeline-stage:${stageWithAlgorithmHint.id}`, `declared-hint:${algorithmicEvidence}`],
      explanation: algorithmicEvidence,
    });
  }

  const hoist = hoistRecommendation(functionAnalysis);
  if (hoist) {
    recommendations.push(hoist);
  }

  const independentSerialStage = stages.find((stage) => (
    stage.independentWork === "CANDIDATE" && stage.scheduling === "SERIAL"
  ));
  if (independentSerialStage) {
    recommendations.push({
      action: "PARALLELIZE",
      level: assessment.optimizationPotential.parallel,
      confidence: "MEDIUM",
      targetKind: "STAGE",
      targetId: independentSerialStage.id,
      evidence: [`pipeline-stage:${independentSerialStage.id}:work-unit`, `pipeline-stage:${independentSerialStage.id}:scheduling`],
      explanation: `${independentSerialStage.workUnit.toLowerCase()} work units are declared independent but currently scheduled serially.`,
    });
  } else if (functionAnalysis.parallelism.classification === "PARALLEL_DOALL"
    || functionAnalysis.parallelism.classification === "PARALLEL_PARTITIONABLE") {
    recommendations.push({
      action: "PARALLELIZE",
      level: assessment.optimizationPotential.parallel,
      confidence: "LOW",
      targetKind: "FUNCTION",
      targetId: functionAnalysis.id,
      evidence: [`parallelism-analysis:${functionAnalysis.id}:${functionAnalysis.parallelism.classification}`],
      explanation: "Function-local dependence heuristics found a parallel work candidate; validate aliases and runtime overhead before implementation.",
    });
  }

  const nativePotential = assessment.optimizationPotential.nativeExecution;
  const nativeCandidate = nativePotential === "HIGH"
    || nativePotential === "VERY_HIGH"
    || nativePotential === "MEDIUM" && (
      assessment.observedWorkload.hotness === "HIGH"
      || assessment.observedWorkload.hotness === "VERY_HIGH"
    );
  if (nativeCandidate) {
    recommendations.push({
      action: "NATIVE_OFFLOAD",
      level: options.cpuProfile?.confidence === "LOW" ? "MEDIUM" : nativePotential,
      confidence: options.cpuProfile?.confidence ?? "UNKNOWN",
      targetKind: "FUNCTION",
      targetId: functionAnalysis.id,
      evidence: [
        `cpu-profile:${options.cpuProfile?.file ?? "missing"}`,
        `eligibility:${functionAnalysis.eligibility.kind}`,
        `boundary-risk:${boundaryRisk}`,
      ],
      explanation: options.cpuProfile?.confidence === "LOW"
        ? "The function appears hot and suitable, but low profile coverage makes native prioritization provisional."
        : "The function is runtime-hot, feasible, and has no high-risk boundary in the analyzed island.",
    });
  }

  if (assessment.optimizationPotential.memoryLayout === "HIGH"
    || assessment.optimizationPotential.memoryLayout === "VERY_HIGH") {
    recommendations.push({
      action: "CHANGE_DATA_LAYOUT",
      level: assessment.optimizationPotential.memoryLayout,
      confidence: options.allocationProfile?.confidence ?? "UNKNOWN",
      targetKind: "FUNCTION",
      targetId: functionAnalysis.id,
      evidence: [
        `allocation-profile:${options.allocationProfile?.file ?? "missing"}`,
        ...(dataLayoutEvidence ? [`declared-hint:${dataLayoutEvidence}`] : []),
      ],
      explanation: dataLayoutEvidence ?? "A large share of sampled allocated bytes is allocated directly by this function or its runtime builtins; inspect object shape and allocation sites.",
    });
  }

  if (functionAnalysis.eligibility.kind === "BLOCKED" || boundaryRisk === "HIGH") {
    recommendations.push({
      action: "KEEP_TS",
      level: "MEDIUM",
      confidence: boundaryRisk === "UNKNOWN" ? "LOW" : "MEDIUM",
      targetKind: "FUNCTION",
      targetId: functionAnalysis.id,
      evidence: [
        `eligibility:${functionAnalysis.eligibility.kind}`,
        `boundary-risk:${boundaryRisk}`,
      ],
      explanation: "Resolve feasibility or boundary constraints before considering native offload; optimize this region in TypeScript first.",
    });
  }
  return recommendations;
}

function assessPipeline(pipeline: PipelineAnalysis | undefined): AccelerationRecommendation[] {
  if (!pipeline) return [];
  const recommendations: AccelerationRecommendation[] = [];
  for (const sink of pipeline.sinks) {
    if (sink.serialized !== true || sink.candidateUpstreamStageIds.length === 0) continue;
    const evidence = [
      `pipeline-sink:${sink.id}:serialized`,
      ...sink.candidateUpstreamStageIds.map((stageId) => `pipeline-stage:${stageId}:independent-work`),
    ];
    recommendations.push({
      action: "REMOVE_SERIALIZED_SINK",
      level: sink.scalingRisk === "HIGH" ? "HIGH" : "MEDIUM",
      confidence: "MEDIUM",
      targetKind: "SINK",
      targetId: sink.id,
      evidence,
      explanation: "Independent upstream work converges on a serialized sink; address sink throughput before increasing producer concurrency.",
    });
    if (sink.resourceEffects.includes("TRANSACTIONAL_WRITE") || sink.resourceEffects.includes("ORDERED_COMMIT")) {
      recommendations.push({
        action: "BATCH_IO",
        level: "HIGH",
        confidence: "MEDIUM",
        targetKind: "SINK",
        targetId: sink.id,
        evidence: [...evidence, ...sink.resourceEffects.map((effect) => `sink-effect:${sink.id}:${effect}`)],
        explanation: "Batch independent writes or commit groups to reduce transaction/ordering overhead at the single-writer boundary.",
      });
    }
  }
  return recommendations;
}

function getHotness(samplePercent: number | undefined, confidence: EvidenceConfidence | undefined): AccelerationLevel {
  if (samplePercent === undefined) return "UNKNOWN";
  if (samplePercent === 0 && confidence === "LOW") return "UNKNOWN";
  if (samplePercent >= 20) return "VERY_HIGH";
  if (samplePercent >= 10) return "HIGH";
  if (samplePercent >= 2) return "MEDIUM";
  return "LOW";
}

function getParallelPotential(
  functionAnalysis: FunctionAnalysis,
  stages: readonly PipelineStageAnalysis[],
): AccelerationLevel {
  if (stages.some((stage) => stage.independentWork === "CANDIDATE")) return "HIGH";
  switch (functionAnalysis.parallelism.classification) {
    case "PARALLEL_DOALL":
    case "PARALLEL_PARTITIONABLE":
      return "HIGH";
    case "PARALLEL_MAP_REDUCE":
      return "MEDIUM";
    case "PARALLEL_WITH_SYNCHRONIZATION":
    case "SEQUENTIAL_DEPENDENCE":
      return "LOW";
    default:
      return "UNKNOWN";
  }
}

function getNativePotential(
  functionAnalysis: FunctionAnalysis,
  boundaryRisk: BoundaryRisk | "UNKNOWN",
  hotness: AccelerationLevel,
  profileConfidence: EvidenceConfidence | undefined,
): AccelerationLevel {
  if (hotness === "UNKNOWN") return "UNKNOWN";
  if (hotness === "LOW" || functionAnalysis.eligibility.kind === "BLOCKED" || boundaryRisk === "HIGH") return "LOW";
  if (boundaryRisk === "UNKNOWN") return "UNKNOWN";
  if (functionAnalysis.eligibility.kind === "SUPPORTED" && functionAnalysis.suitability >= 85) {
    return profileConfidence === "LOW" ? "MEDIUM" : "HIGH";
  }
  if (functionAnalysis.suitability >= 50) return "MEDIUM";
  return "LOW";
}

function getMemoryPotential(
  allocationPercent: number | undefined,
  matchedSampleCount: number | undefined,
  staticMemoryOpportunity: number,
  profileConfidence: EvidenceConfidence | undefined,
): AccelerationLevel {
  if (allocationPercent === undefined) return "UNKNOWN";
  if (matchedSampleCount === 0 && profileConfidence === "LOW") return "UNKNOWN";
  if (allocationPercent >= 30 && staticMemoryOpportunity >= 50) return profileConfidence === "LOW" ? "HIGH" : "VERY_HIGH";
  if (allocationPercent >= 15) return "HIGH";
  if (allocationPercent >= 5) return "MEDIUM";
  return "LOW";
}

function highestHint(
  stages: readonly PipelineStageAnalysis[],
  category: "ALGORITHMIC" | "DATA_LAYOUT",
): { level: Exclude<AccelerationLevel, "UNKNOWN">; evidence: string } | undefined {
  const rank: readonly Exclude<AccelerationLevel, "UNKNOWN">[] = ["LOW", "MEDIUM", "HIGH", "VERY_HIGH"];
  const hints = stages.flatMap((stage) => (stage.optimizationHints ?? [])
    .filter((hint) => hint.category === category)
    .map((hint) => ({ ...hint, stageId: stage.id })));
  return hints.sort((left, right) => rank.indexOf(right.level) - rank.indexOf(left.level))
    .map(({ level, evidence, stageId }) => ({ level, evidence: `pipeline-stage:${stageId}: ${evidence}` }))[0];
}

/**
 * HOIST_INVARIANT_WORK (v0.2.6d, recognition only). Hoisting pays only for work that is repeated:
 * - LOOP_INVARIANT: repeated by construction (HIGH confidence)
 * - STATIC_INVARIANT: needs at least 2 measured calls (input-signature probe; HIGH), else LOW
 * - PARAM_DEPENDENT / VARIANT: needs measured reuse ≥ 0.75 over the arguments or one substantial argument
 *   path (each input used four times on average; MEDIUM), else LOW
 * Level: the call's own cost × the share of calls a cache would serve (≥ 5% HIGH, ≥ 1% MEDIUM, else LOW).
 * LOW confidence caps the level at LOW: an unproven repetition is reported, not recommended.
 */
function hoistRecommendation(functionAnalysis: FunctionAnalysis): AccelerationRecommendation | undefined {
  const candidates = functionAnalysis.hoistCandidates ?? [];
  if (candidates.length === 0) {
    return undefined;
  }
  const ranked = candidates.map((candidate) => {
    const reuse = Math.max(candidate.repetition?.reuseRatio ?? 0, candidate.repetition?.bestPath?.reuseRatio ?? 0);
    const repeated = candidate.invariance === "LOOP_INVARIANT"
      || (candidate.invariance === "STATIC_INVARIANT" && (candidate.repetition?.calls ?? 0) >= 2)
      || ((candidate.invariance === "PARAM_DEPENDENT" || candidate.invariance === "VARIANT") && reuse >= 0.75);
    const confidence: EvidenceConfidence = !repeated ? "LOW" : candidate.invariance === "PARAM_DEPENDENT" || candidate.invariance === "VARIANT" ? "MEDIUM" : "HIGH";
    const share = candidate.invariance === "PARAM_DEPENDENT" || candidate.invariance === "VARIANT" ? reuse : 1;
    const atStake = (candidate.atStakePercent ?? 0) * share;
    const level: AccelerationLevel = confidence === "LOW" ? "LOW" : atStake >= 5 ? "HIGH" : atStake >= 1 ? "MEDIUM" : "LOW";
    return { candidate, confidence, level, atStake };
  }).sort((left, right) => rank(right.level) - rank(left.level) || rank(right.confidence) - rank(left.confidence) || right.atStake - left.atStake);
  const best = ranked[0];
  if (!best) {
    return undefined;
  }
  const { candidate } = best;
  const evidence = [
    `hoist-candidate:${candidate.line}:${candidate.column}:${candidate.kind}`,
    `invariance:${candidate.invariance}`,
    ...(candidate.atStakePercent !== undefined ? [`call-cost:${candidate.atStakePercent}%`] : []),
    ...(candidate.compileLikePercent !== undefined ? [`compile-like-cpu:${candidate.compileLikePercent}%`] : []),
    ...(candidate.repetition ? [`input-reuse:${candidate.repetition.calls} calls, ${candidate.repetition.reuseRatio}${candidate.repetition.bestPath ? `; ${candidate.repetition.bestPath.path} ${candidate.repetition.bestPath.reuseRatio}` : ""}`] : []),
  ];
  const where = `\`${candidate.callee}\` (line ${candidate.line})`;
  return {
    action: "HOIST_INVARIANT_WORK",
    level: best.level,
    confidence: best.confidence,
    targetKind: "FUNCTION",
    targetId: functionAnalysis.id,
    evidence,
    explanation: best.confidence === "LOW"
      ? `${where} builds reusable state on every call; repetition is not shown yet (profile its inputs and call count).`
      : `${where} builds reusable state from ${candidate.invariance === "LOOP_INVARIANT" ? "loop-invariant" : candidate.invariance === "STATIC_INVARIANT" ? "invariant" : "repeating"} inputs on every call; compute it once (prepared state or a cache keyed by those inputs).`,
  };
}

function rank(level: AccelerationLevel | EvidenceConfidence): number {
  return { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 }[level];
}

