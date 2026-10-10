import { describe, expect, it } from "vitest";
import { analyzeProject } from "../src/analysis/analyze-project.js";
import { analyzeAcceleration } from "../src/analysis/assessment.js";
import { analyzePipeline } from "../src/analysis/pipeline.js";
import type { PipelineDescriptor } from "../src/analysis/model.js";

const fixtureRoot = new URL("./fixtures/basic", import.meta.url).pathname;

describe("analyzeAcceleration", () => {
  it("keeps evidence axes separate and cites reasons for each recommendation", () => {
    const base = analyzeProject(fixtureRoot);
    const parseFilesBase = base.functions.find((functionAnalysis) => functionAnalysis.name === "parseFiles");
    if (!parseFilesBase) throw new Error("Expected parseFiles fixture function.");
    const functions = base.functions.map((functionAnalysis) => (
      functionAnalysis.id === parseFilesBase.id
        ? {
          ...functionAnalysis,
          observedCpu: {
            selfCpuMicros: 3500,
            totalCpuMicros: 5000,
            samplePercent: 35,
            callCount: null as const,
          },
          observedAllocation: {
            sampledBytesSelf: 3000,
            sampledBytesTotal: 5000,
            sampledBytesSelfPercent: 30,
            sampledBytesTotalPercent: 50,
            sampleCountSelf: 20,
            sampleCountTotal: 30,
          },
        }
        : functionAnalysis
    ));
    const descriptor: PipelineDescriptor = {
      schemaVersion: 1,
      workloadLabel: "fixture-workload",
      stages: [{
        id: "parse-files",
        entry: { file: "src/opportunities.ts", name: "parseFiles" },
        workUnit: "FILE",
        scheduling: "SERIAL",
        inputSharing: "READ_ONLY",
        aggregation: "PER_UNIT",
        dependsOn: [],
        optimizationHints: [{
          category: "ALGORITHMIC",
          level: "VERY_HIGH",
          evidence: "The measured stage repeatedly scans the same text for each dictionary term.",
        }],
      }, {
        id: "write-index",
        entry: { file: "src/opportunities.ts", name: "enqueueNodes" },
        workUnit: "RECORD",
        scheduling: "SERIAL",
        inputSharing: "READ_ONLY",
        aggregation: "ORDERED",
        dependsOn: ["parse-files"],
        sinkIds: ["sqlite-writer"],
      }],
      sinks: [{
        id: "sqlite-writer",
        adapter: "SQLITE",
        transactional: true,
        orderedCommit: true,
      }],
    };
    const pipeline = analyzePipeline(descriptor, functions.map(({ id, file, name, parallelism }) => ({ id, file, name, parallelism })));
    const assessment = analyzeAcceleration({
      functions,
      candidateIslands: base.candidateIslands,
      pipeline,
      cpuProfile: {
        file: "cpu.cpuprofile",
        totalSampleMicros: 10_000,
        matchedSampleMicros: 7_000,
        matchedSamplePercent: 70,
        sampleCount: 100,
        matchedSampleCount: 70,
        timeUnit: "microseconds",
        confidence: "MEDIUM",
      },
      allocationProfile: {
        file: "memory.heapprofile",
        totalSampledBytes: 10_000,
        matchedSampledBytes: 9_000,
        matchedSampledPercent: 90,
        sampleCount: 100,
        matchedSampleCount: 90,
        unit: "bytes",
        confidence: "HIGH",
      },
    });
    const parseAssessment = assessment.functions.find((item) => item.functionId === parseFilesBase.id);

    expect(assessment.workloadLabel).toBe("fixture-workload");
    expect(parseAssessment).toMatchObject({
      feasibility: { eligibility: "SUPPORTED" },
      observedWorkload: {
        hotness: "VERY_HIGH",
        selfCpuMicros: 3500,
        inclusiveCpuMicros: 5000,
        cpuProfileConfidence: "MEDIUM",
        sampledAllocationBytesSelf: 3000,
        allocationProfileConfidence: "HIGH",
      },
      optimizationPotential: {
        algorithmic: "VERY_HIGH",
        parallel: "HIGH",
        memoryLayout: "HIGH",
      },
    });
    expect(parseAssessment?.recommendations.map((recommendation) => recommendation.action)).toEqual(expect.arrayContaining([
      "OPTIMIZE_ALGORITHM",
      "PARALLELIZE",
      "NATIVE_OFFLOAD",
      "CHANGE_DATA_LAYOUT",
    ]));
    expect(parseAssessment?.recommendations.every((recommendation) => recommendation.evidence.length > 0)).toBe(true);
    expect(assessment.pipelineRecommendations.map((recommendation) => recommendation.action)).toEqual(expect.arrayContaining([
      "REMOVE_SERIALIZED_SINK",
      "BATCH_IO",
    ]));
    expect(parseAssessment?.feasibility.nativePriority).toBe(parseFilesBase.nativePriority);
  });

  it("does not infer hotness or native offload when runtime profiles are absent", () => {
    const result = analyzeProject(fixtureRoot);
    const assessment = analyzeAcceleration({
      functions: result.functions,
      candidateIslands: result.candidateIslands,
    });
    const parseFiles = result.functions.find((functionAnalysis) => functionAnalysis.name === "parseFiles");
    const parseAssessment = assessment.functions.find((item) => item.functionId === parseFiles?.id);

    expect(parseAssessment?.observedWorkload.hotness).toBe("UNKNOWN");
    expect(parseAssessment?.optimizationPotential.nativeExecution).toBe("UNKNOWN");
    expect(parseAssessment?.recommendations.some((recommendation) => recommendation.action === "NATIVE_OFFLOAD")).toBe(false);

    if (!parseFiles) throw new Error("Expected parseFiles fixture function.");
    const zeroAllocationFunctions = result.functions.map((functionAnalysis) => (
      functionAnalysis.id === parseFiles.id
        ? {
          ...functionAnalysis,
          observedAllocation: {
            sampledBytesSelf: 0,
            sampledBytesTotal: 0,
            sampledBytesSelfPercent: 0,
            sampledBytesTotalPercent: 0,
            sampleCountSelf: 0,
            sampleCountTotal: 0,
          },
        }
        : functionAnalysis
    ));
    const lowCoverage = analyzeAcceleration({
      functions: zeroAllocationFunctions,
      candidateIslands: result.candidateIslands,
      allocationProfile: {
        file: "low-coverage.heapprofile",
        totalSampledBytes: 1_000,
        matchedSampledBytes: 50,
        matchedSampledPercent: 5,
        sampleCount: 100,
        matchedSampleCount: 2,
        unit: "bytes",
        confidence: "LOW",
      },
    });
    expect(lowCoverage.functions.find((item) => item.functionId === parseFiles.id)?.optimizationPotential.memoryLayout).toBe("UNKNOWN");
  });

  it("keeps a hot native recommendation provisional when profile confidence is low", () => {
    const result = analyzeProject(fixtureRoot);
    const rootFunction = result.functions.find((functionAnalysis) => functionAnalysis.name === "profiledRoot");
    if (!rootFunction) throw new Error("Expected profiledRoot fixture function.");
    const functions = result.functions.map((functionAnalysis) => (
      functionAnalysis.id === rootFunction.id
        ? {
          ...functionAnalysis,
          observedCpu: {
            selfCpuMicros: 2500,
            totalCpuMicros: 3000,
            samplePercent: 25,
            callCount: null as const,
          },
        }
        : functionAnalysis
    ));
    const assessment = analyzeAcceleration({
      functions,
      candidateIslands: result.candidateIslands,
      cpuProfile: {
        file: "low-coverage.cpuprofile",
        totalSampleMicros: 10_000,
        matchedSampleMicros: 3_000,
        matchedSamplePercent: 30,
        sampleCount: 100,
        matchedSampleCount: 20,
        timeUnit: "microseconds",
        confidence: "LOW",
      },
    });
    const rootAssessment = assessment.functions.find((item) => item.functionId === rootFunction.id);
    const nativeRecommendation = rootAssessment?.recommendations.find((recommendation) => recommendation.action === "NATIVE_OFFLOAD");

    expect(rootAssessment?.observedWorkload.hotness).toBe("VERY_HIGH");
    expect(nativeRecommendation).toMatchObject({ level: "MEDIUM", confidence: "LOW" });
  });
});