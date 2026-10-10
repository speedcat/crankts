import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const evaluationPath = fileURLToPath(new URL("../evaluation/intentweave-index-top16.json", import.meta.url));
const rustSplitPath = fileURLToPath(new URL("../evaluation/intentweave-rust-split.json", import.meta.url));
const profileEvidencePath = fileURLToPath(new URL("../evaluation/intentweave-index-build-profile.json", import.meta.url));

describe("IntentWeave evaluation labels", () => {
  it("contains 16 uniquely keyed candidates with machine-readable labels and reasons", () => {
    const evaluation = JSON.parse(readFileSync(evaluationPath, "utf8")) as {
      schemaVersion: number;
      candidates: Array<{
        key: string;
        label: string;
        reasons: string[];
        boundary: {
          rawExitEdges: number;
          effectiveExitEdges: number;
          risk: string;
          kinds: Record<string, number>;
        };
      }>;
      reasonVocabulary: string[];
    };

    const labels = evaluation.candidates.reduce<Record<string, number>>((counts, candidate) => {
      counts[candidate.label] = (counts[candidate.label] ?? 0) + 1;
      return counts;
    }, {});

    expect(evaluation.schemaVersion).toBe(1);
    expect(evaluation.candidates).toHaveLength(16);
    expect(new Set(evaluation.candidates.map((candidate) => candidate.key)).size).toBe(16);
    expect(labels).toEqual({
      GOOD_NATIVE_CANDIDATE: 1,
      MAYBE: 7,
      BAD_CANDIDATE: 8,
    });
    expect(evaluation.candidates.every((candidate) => (
      candidate.reasons.length > 0
      && candidate.reasons.every((reason) => evaluation.reasonVocabulary.includes(reason))
      && candidate.boundary.effectiveExitEdges <= candidate.boundary.rawExitEdges
      && ["LOW", "MEDIUM", "HIGH"].includes(candidate.boundary.risk)
      && Object.values(candidate.boundary.kinds).every((count) => count >= 0)
    ))).toBe(true);
  });

  it("maps every Rust build stage to TypeScript analysis results without treating the tiny benchmark as performance ground truth", () => {
    const comparison = JSON.parse(readFileSync(rustSplitPath, "utf8")) as {
      schemaVersion: number;
      comparisonType: string;
      priorityCalibrationApplied: boolean;
      runtimeSplit: { type: string; rustStages: string[] };
      stages: Array<{
        stage: string;
        rustSource: string;
        typescriptSources: string[];
        typescriptOrchestrationSources?: string[];
        cranktsFunctions: number;
        priority70Plus: number;
      }>;
      parityHarness: {
        performanceAssertion: boolean;
        observedTinyFixtureRun: { nativeToTypescriptRatio: number; interpretation: string };
      };
    };

    expect(comparison.schemaVersion).toBe(1);
    expect(comparison.comparisonType).toBe("pipeline-stage-map");
    expect(comparison.priorityCalibrationApplied).toBe(false);
    expect(comparison.runtimeSplit.type).toBe("whole-pipeline-cli-backend");
    expect(comparison.stages.map((stage) => stage.stage)).toEqual(comparison.runtimeSplit.rustStages);
    expect(comparison.stages.every((stage) => (
      stage.rustSource.startsWith("packages/cari-native/src/")
      && stage.typescriptSources.length > 0
      && stage.cranktsFunctions > 0
      && stage.priority70Plus >= 0
    ))).toBe(true);
    expect(comparison.stages.find((stage) => stage.stage === "AX")?.typescriptOrchestrationSources)
      .toContain("packages/index/src/facade.ts#buildFromPaths");
    expect(comparison.stages.find((stage) => stage.stage === "AX")?.priority70Plus).toBe(0);
    expect(comparison.stages.find((stage) => stage.stage === "KWX")?.priority70Plus).toBe(2);
    expect(comparison.stages.find((stage) => stage.stage === "COX")?.priority70Plus).toBe(1);
    expect(comparison.stages.find((stage) => stage.stage === "TCG")?.priority70Plus).toBe(3);
    expect(comparison.parityHarness.performanceAssertion).toBe(false);
    expect(comparison.parityHarness.observedTinyFixtureRun.nativeToTypescriptRatio).toBeGreaterThan(1);
    expect(comparison.parityHarness.observedTinyFixtureRun.interpretation).toContain("not representative");
  });

  it("records the real IW profile discrepancy and refuses an unqualified speedup claim", () => {
    const evidence = JSON.parse(readFileSync(profileEvidencePath, "utf8")) as {
      schemaVersion: number;
      profile: { totalSampleMicros: number; findings: Array<{ function: string; staticPriority: number; selfCpuMicros: number }> };
      dictionaryAlgorithmComparison: { parityCaveat: string };
      semanticOutputDrift: { interpretation: string; databaseRows: Record<string, { typescript: number; rust: number }> };
      limitations: string[];
    };
    const hotDictionaryScan = evidence.profile.findings.find((finding) => finding.function === "HeuristicKeywordExtractor.extractDictionary");
    const staticHighButCold = evidence.profile.findings.find((finding) => finding.function === "aggregateEntities");

    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.profile.totalSampleMicros).toBeGreaterThan(0);
    expect(hotDictionaryScan).toMatchObject({ staticPriority: 30, selfCpuMicros: 10_936_226 });
    expect(staticHighButCold).toMatchObject({ staticPriority: 85, selfCpuMicros: 15_041 });
    expect(evidence.dictionaryAlgorithmComparison.parityCaveat).toContain("multi-word");
    expect(evidence.semanticOutputDrift.databaseRows.annotations.typescript)
      .not.toBe(evidence.semanticOutputDrift.databaseRows.annotations.rust);
    expect(evidence.semanticOutputDrift.interpretation).toContain("not yet semantically equivalent");
    expect(evidence.limitations).toContain("No Rust CPU profiler or allocation/heap profile was captured.");
  });
});