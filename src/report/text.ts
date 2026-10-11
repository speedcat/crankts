import type { AnalysisResult, Blocker, Effect, FunctionAnalysis } from "../analysis/model.js";
import { CRANKTS_VERSION } from "../version.js";
import { getVisibleCandidateIslands } from "./options.js";
import type { ReportOptions } from "./options.js";

export function renderTextReport(result: AnalysisResult, options: ReportOptions = {}): string {
  const candidateIslands = getVisibleCandidateIslands(result, options);
  const counts = {
    SUPPORTED: result.functions.filter((functionAnalysis) => functionAnalysis.eligibility.kind === "SUPPORTED").length,
    CONDITIONAL: result.functions.filter((functionAnalysis) => functionAnalysis.eligibility.kind === "CONDITIONAL").length,
    BLOCKED: result.functions.filter((functionAnalysis) => functionAnalysis.eligibility.kind === "BLOCKED").length,
  };
  const functionsById = new Map(result.functions.map((functionAnalysis) => [functionAnalysis.id, functionAnalysis]));
  const lines = [
    `CrankTS v${CRANKTS_VERSION}`,
    "",
    `Project: ${result.projectName}`,
    `TypeScript: ${result.typescript.version} (${result.typescript.source})`,
    "",
    `Functions: ${result.functions.length}`,
    `Supported: ${counts.SUPPORTED}`,
    `Conditional: ${counts.CONDITIONAL}`,
    `Blocked: ${counts.BLOCKED}`,
    `Candidate islands: ${candidateIslands.length} / ${result.candidateIslands.length}`,
  ];

  if (result.cpuProfile) {
    lines.push(
      `CPU profile: ${result.cpuProfile.file}`,
      `  Matched sample time: ${result.cpuProfile.matchedSampleMicros} / ${result.cpuProfile.totalSampleMicros} microseconds (${result.cpuProfile.matchedSamplePercent.toFixed(1)}%)`,
      `  Profile confidence: ${result.cpuProfile.confidence}`,
      "  Candidate order: observed self CPU; Native Priority unchanged.",
    );
    const origins = (result.cpuProfile.origins ?? []).slice(0, 5);
    if (origins.length > 0) {
      lines.push("  Sample origins (self time, top 5):");
      for (const origin of origins) {
        lines.push(`    ${origin.origin} [${origin.kind}]: ${origin.selfPercent.toFixed(1)}% self, ${origin.unmatchedPercent.toFixed(1)}% unmatched`);
      }
    }
    const attribution = result.cpuProfile.attribution;
    if (attribution) {
      const targets = Object.entries(attribution.byTarget)
        .sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0))
        .map(([target, percent]) => `${target} ${(percent ?? 0).toFixed(1)}%`);
      lines.push(
        `  Call-site attribution (${attribution.attributedPercent.toFixed(1)}% of samples have an analyzed caller): ${targets.join(", ")}`,
        ...(attribution.nativeAddonSelfPercent > 0
          ? [`  N-API time inside project frames (not project compute): ${attribution.nativeAddonSelfPercent.toFixed(1)}%`]
          : []),
      );
    }
  }
  if (result.allocationProfile) {
    lines.push(
      `Allocation profile: ${result.allocationProfile.file}`,
      `  Matched sampled bytes: ${result.allocationProfile.matchedSampledBytes} / ${result.allocationProfile.totalSampledBytes} (${result.allocationProfile.matchedSampledPercent.toFixed(1)}%)`,
      `  Allocation profile confidence: ${result.allocationProfile.confidence}`,
      "  Values are sampled allocated bytes, not retained heap or RSS.",
    );
  }
  if (result.workspace) {
    lines.push(`Project-reference configs: ${result.workspace.projectConfigsLoaded}`);
    if (result.workspace.skippedReferences.length > 0) {
      lines.push("Skipped missing project references:");
      result.workspace.skippedReferences.forEach((reference) => lines.push(`  ${reference}`));
    }
  }

  if (candidateIslands.length === 0) {
    lines.push("", options.minScore ? `No candidate islands meet minimum score ${options.minScore}.` : "Candidate islands: none");
  } else {
    candidateIslands.forEach((island, index) => {
      lines.push(
        "",
        `Candidate Island #${index + 1}`,
        `  Status: ${island.status}`,
        `  Native Priority: ${island.nativePriority} / 100`,
        `  Static Suitability: ${island.suitability} / 100`,
        `  Opportunity: CPU ${island.opportunities.cpu}, Memory ${island.opportunities.memory}, Parallel ${island.opportunities.parallel}`,
        `  Functions: ${island.members.length}`,
        `  Internal edges: ${island.internalEdges}`,
        `  Raw entry/exit edges: ${island.rawEntryEdges} / ${island.rawExitEdges}`,
        `  Effective entry/exit edges: ${island.effectiveEntryEdges} / ${island.effectiveExitEdges}`,
        `  Boundary risk: ${island.boundaryRisk} (${island.boundaryCostUnits} diagnostic units)`,
        `  Boundary kinds: ${formatBoundaryKinds(island.boundaryKinds)}`,
        `  Boundary ratio: ${island.boundaryRatio.toFixed(3)}`,
        `  Member mix: ${formatEligibilityMix(island.eligibilityMix)}`,
        `  Boundary mix: ${formatEligibilityMix(island.boundaryEligibilityMix)}`,
        `  Articulation points: ${island.articulationCount}`,
        `  Size penalty (diagnostic): ${island.sizePenalty}`,
      );

      if (island.observedCpu) {
        lines.push(
          `  Observed CPU: self ${island.observedCpu.selfCpuMicros} microseconds, total ${island.observedCpu.totalCpuMicros} microseconds, ${island.observedCpu.samplePercent.toFixed(2)}% of profile`,
        );
      }

      if (island.largestArticulationImpact) {
        const articulation = island.largestArticulationImpact;
        const helper = functionsById.get(articulation.functionId);
        lines.push(
          `  Largest articulation impact: ${helper?.name ?? articulation.functionId} `
            + `(${articulation.impact} members outside largest remainder, `
            + `${articulation.componentsAfterRemoval} parts, largest ${articulation.largestRemainingPart}, `
            + `${articulation.internalCallers} internal callers)`,
        );
      }
      for (const warning of island.warnings) {
        lines.push(`  Warning ${warning.code}: ${warning.message}`);
      }

      for (const memberId of island.members) {
        const member = functionsById.get(memberId);
        if (member) {
          lines.push(`  ${member.name}() (${member.file}:${member.line})`);
        }
      }
    });
  }

  const parallelismFunctions = result.functions.filter((functionAnalysis) => functionAnalysis.parallelism.regions.length > 0);
  lines.push("", "Parallelism:");
  if (parallelismFunctions.length === 0) {
    lines.push("  no loop or async-batch regions detected");
  } else {
    for (const functionAnalysis of parallelismFunctions) {
      lines.push(`  ${functionAnalysis.name}(): ${functionAnalysis.parallelism.classification}`);
      if (!options.verbose) continue;
      for (const region of functionAnalysis.parallelism.regions) {
        lines.push(`    ${region.kind} line ${region.line}: ${region.classification} - ${region.explanation}`);
        lines.push(`      Reads: ${formatMemoryAccesses(region.reads)}`);
        lines.push(`      Writes: ${formatMemoryAccesses(region.writes)}`);
        lines.push(`      Shared writes: ${region.sharedWrites.join(", ") || "none"}`);
        lines.push(`      Dependences: ${formatDependences(region.dependences)}`);
        if (region.externalEffects.length > 0) {
          lines.push(`      Effects: ${region.externalEffects.join(", ")}`);
        }
      }
    }
  }

  if (result.pipeline) {
    lines.push(
      "",
      `Pipeline${result.pipeline.workloadLabel ? ` (${result.pipeline.workloadLabel})` : ""}:`,
      `  Parallel work candidates: ${result.pipeline.parallelCandidateStageCount} stage(s)`,
      `  Serialized sinks: ${result.pipeline.serializedSinkCount}`,
      `  Serialization risk: ${result.pipeline.serializationRisk}`,
    );
    for (const stage of result.pipeline.stages) {
      lines.push(
        `  ${stage.id}: ${stage.workUnit} / ${stage.scheduling}; independent work ${stage.independentWork}; entry ${stage.entryStatus}`,
      );
      if (stage.sinkIds?.length) {
        lines.push(`    Sinks: ${stage.sinkIds.join(", ")}`);
      }
      if (options.verbose) {
        lines.push(`    ${stage.explanation}`);
        if (stage.dependsOn.length > 0) lines.push(`    Depends on: ${stage.dependsOn.join(", ")}`);
      }
    }
    for (const sink of result.pipeline.sinks) {
      lines.push(
        `  Sink ${sink.id}: ${sink.adapter}, serialized ${sink.serialized === null ? "unknown" : sink.serialized ? "yes" : "no"}, `
          + `writers ${sink.writerStageCount}, scaling risk ${sink.scalingRisk}`,
      );
      if (options.verbose) {
        lines.push(`    Resource effects: ${sink.resourceEffects.join(", ") || "none"}`);
        lines.push(`    Candidate upstream stages: ${sink.candidateUpstreamStageIds.join(", ") || "none"}`);
      }
    }
  }

  const assessedFunctions = result.acceleration.functions.filter((assessment) => (
    assessment.observedWorkload.hotness !== "UNKNOWN" || assessment.recommendations.length > 0
  ));
  lines.push("", `Acceleration Assessment${result.acceleration.workloadLabel ? ` (${result.acceleration.workloadLabel})` : ""}:`);
  if (assessedFunctions.length === 0 && result.acceleration.pipelineRecommendations.length === 0) {
    lines.push("  no profile-backed or pipeline-declared recommendations");
  } else {
    for (const assessment of assessedFunctions) {
      const observed = assessment.observedWorkload;
      lines.push(
        `  ${assessment.name}(): hotness ${observed.hotness}, native suitability ${assessment.feasibility.nativeSuitability}, `
          + `parallel ${assessment.optimizationPotential.parallel}, algorithmic ${assessment.optimizationPotential.algorithmic}, `
          + `native ${assessment.optimizationPotential.nativeExecution}, memory/layout ${assessment.optimizationPotential.memoryLayout}`,
      );
      if (options.verbose) {
        lines.push(`    Feasibility: ${assessment.feasibility.eligibility}; boundary risk ${assessment.feasibility.boundaryRisk}; Native Priority ${assessment.feasibility.nativePriority}`);
        if (observed.selfCpuMicros !== undefined) {
          lines.push(`    CPU: self ${observed.selfCpuMicros} microseconds, inclusive ${observed.inclusiveCpuMicros} microseconds, profile confidence ${observed.cpuProfileConfidence ?? "UNKNOWN"}`);
        }
        if (observed.sampledAllocationBytesSelf !== undefined) {
          lines.push(`    Allocation: self ${observed.sampledAllocationBytesSelf} sampled bytes, inclusive ${observed.sampledAllocationBytesTotal} sampled bytes, profile confidence ${observed.allocationProfileConfidence ?? "UNKNOWN"}`);
        }
      }
      for (const recommendation of assessment.recommendations) {
        lines.push(`    Recommendation ${recommendation.action}: ${recommendation.level} (${recommendation.confidence})`);
        if (options.verbose) lines.push(`      ${recommendation.explanation} Evidence: ${recommendation.evidence.join(", ")}`);
      }
    }
    for (const recommendation of result.acceleration.pipelineRecommendations) {
      lines.push(`  Pipeline recommendation ${recommendation.action} for ${recommendation.targetId}: ${recommendation.level} (${recommendation.confidence})`);
      if (options.verbose) lines.push(`    ${recommendation.explanation} Evidence: ${recommendation.evidence.join(", ")}`);
    }
  }

  if (options.verbose) {
    lines.push("", "Call edges:");
    for (const functionAnalysis of result.functions) {
      const observedCpu = functionAnalysis.observedCpu
        ? `, self CPU ${functionAnalysis.observedCpu.selfCpuMicros} microseconds, total CPU ${functionAnalysis.observedCpu.totalCpuMicros} microseconds`
        : "";
      const observedAllocation = functionAnalysis.observedAllocation
        ? `, sampled allocation ${functionAnalysis.observedAllocation.sampledBytesSelf} bytes self, ${functionAnalysis.observedAllocation.sampledBytesTotal} bytes inclusive`
        : "";
      lines.push(`  ${functionAnalysis.name}() [${functionAnalysis.eligibility.kind}, suitability ${functionAnalysis.suitability}, priority ${functionAnalysis.nativePriority}${observedCpu}${observedAllocation}]`);
      if (functionAnalysis.calls.length === 0) {
        lines.push("    none");
        continue;
      }
      for (const edge of functionAnalysis.calls) {
        const target = edge.to ? functionsById.get(edge.to) : undefined;
        const targetDescription = target ? ` -> ${target.name}()` : "";
        lines.push(`    ${edge.kind}/${edge.boundaryKind}: ${edge.callee}${targetDescription} (${edge.line}:${edge.column})`);
      }
    }
  }

  const functionsWithEffects = result.functions.filter((functionAnalysis) => (
    functionAnalysis.effects.some((effect) => effect !== "PURE")
  ));
  lines.push("", "Effects:");
  if (functionsWithEffects.length === 0) {
    lines.push("  none inferred");
  } else {
    for (const functionAnalysis of functionsWithEffects) {
      const directEffects = new Set<Effect>(functionAnalysis.directEffects.filter((effect) => effect !== "PURE"));
      const propagatedEffects = functionAnalysis.effects.filter((effect) => !directEffects.has(effect));
      lines.push(`  ${functionAnalysis.name}(): ${functionAnalysis.effects.join(", ")}`);
      if (propagatedEffects.length > 0) {
        lines.push(`    propagated: ${propagatedEffects.join(", ")}`);
      }
    }
  }

  const blockedFunctions = result.functions.filter((functionAnalysis) => (
    functionAnalysis.eligibility.kind !== "SUPPORTED"
  ));
  lines.push("", "Blockers:");
  if (blockedFunctions.length === 0) {
    lines.push("  none");
  } else {
    for (const functionAnalysis of blockedFunctions) {
      const blockers = getBlockers(functionAnalysis);
      if (blockers.length === 0) {
        continue;
      }
      lines.push(`  ${functionAnalysis.name}() (${functionAnalysis.file}:${functionAnalysis.line})`);
      for (const blocker of blockers) {
        lines.push(`    ${blocker.code}: ${blocker.message} (line ${blocker.line})`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function getBlockers(functionAnalysis: FunctionAnalysis): readonly Blocker[] {
  return functionAnalysis.eligibility.kind === "SUPPORTED"
    ? []
    : functionAnalysis.eligibility.blockers;
}

function formatEligibilityMix(mix: AnalysisResult["candidateIslands"][number]["eligibilityMix"]): string {
  return `supported ${mix.supported}, conditional ${mix.conditional}, blocked ${mix.blocked}`;
}

function formatMemoryAccesses(accesses: FunctionAnalysis["parallelism"]["regions"][number]["reads"]): string {
  if (accesses.length === 0) return "none";
  return accesses.map((access) => `${access.target} (${access.mode.toLowerCase()}, ${access.scope.toLowerCase()})`).join(", ");
}

function formatDependences(dependences: FunctionAnalysis["parallelism"]["dependences"]): string {
  if (dependences.length === 0) return "none";
  return dependences.map((dependence) => (
    `${dependence.kind} ${dependence.target}${dependence.loopCarried ? " (loop-carried)" : ""}`
  )).join(", ");
}

function formatBoundaryKinds(boundaryKinds: AnalysisResult["candidateIslands"][number]["boundaryKinds"]): string {
  const entries = Object.entries(boundaryKinds).filter(([, count]) => count > 0);
  return entries.length > 0 ? entries.map(([kind, count]) => `${kind} ${count}`).join(", ") : "none";
}