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

  if (options.verbose) {
    lines.push("", "Call edges:");
    for (const functionAnalysis of result.functions) {
      const observedCpu = functionAnalysis.observedCpu
        ? `, self CPU ${functionAnalysis.observedCpu.selfCpuMicros} microseconds, total CPU ${functionAnalysis.observedCpu.totalCpuMicros} microseconds`
        : "";
      lines.push(`  ${functionAnalysis.name}() [${functionAnalysis.eligibility.kind}, suitability ${functionAnalysis.suitability}, priority ${functionAnalysis.nativePriority}${observedCpu}]`);
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

function formatBoundaryKinds(boundaryKinds: AnalysisResult["candidateIslands"][number]["boundaryKinds"]): string {
  const entries = Object.entries(boundaryKinds).filter(([, count]) => count > 0);
  return entries.length > 0 ? entries.map(([kind, count]) => `${kind} ${count}`).join(", ") : "none";
}