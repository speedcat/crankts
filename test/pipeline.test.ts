import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeProject } from "../src/analysis/analyze-project.js";
import { analyzePipeline, validatePipelineDescriptor } from "../src/analysis/pipeline.js";
import type { PipelineDescriptor } from "../src/analysis/model.js";
import { runCli } from "../src/index.js";
import { renderJsonReport } from "../src/report/json.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("analyzePipeline", () => {
  it("distinguishes independent serial work from a single-writer SQLite sink", () => {
    const descriptor: PipelineDescriptor = {
      schemaVersion: 1,
      workloadLabel: "fixture-index-build",
      stages: [
        {
          id: "parse-files",
          entry: { file: "src/opportunities.ts", name: "parseFiles" },
          workUnit: "FILE",
          scheduling: "SERIAL",
          inputSharing: "READ_ONLY",
          aggregation: "PER_UNIT",
          dependsOn: [],
        },
        {
          id: "write-index",
          entry: { file: "src/effects.ts", name: "queryThroughCompatDatabase" },
          workUnit: "RECORD",
          scheduling: "SERIAL",
          inputSharing: "READ_ONLY",
          aggregation: "ORDERED",
          dependsOn: ["parse-files"],
          sinkIds: ["index-db"],
        },
      ],
      sinks: [
        {
          id: "index-db",
          adapter: "SQLITE",
          writerMode: "SINGLE_WRITER",
          transactional: true,
          orderedCommit: true,
        },
      ],
    };
    const functions = [
      {
        id: "src/opportunities.ts:parseFiles",
        file: "src/opportunities.ts",
        name: "parseFiles",
        parallelism: { classification: "PARALLEL_DOALL" },
      },
      {
        id: "src/effects.ts:queryThroughCompatDatabase",
        file: "src/effects.ts",
        name: "queryThroughCompatDatabase",
        parallelism: { classification: "UNKNOWN" },
      },
    ];

    const result = analyzePipeline(descriptor, functions);

    expect(result.workloadLabel).toBe("fixture-index-build");
    expect(result.stages[0]).toMatchObject({
      id: "parse-files",
      entryStatus: "RESOLVED",
      independentWork: "CANDIDATE",
      scheduling: "SERIAL",
      workUnit: "FILE",
    });
    expect(result.stages[1]).toMatchObject({
      id: "write-index",
      entryStatus: "RESOLVED",
      sinkIds: ["index-db"],
    });
    expect(result.sinks[0]).toMatchObject({
      id: "index-db",
      serialized: true,
      writerStageCount: 1,
    });
    expect(result.sinks[0]?.resourceEffects).toEqual(expect.arrayContaining([
      "SERIALIZED_SINK",
      "SINGLE_WRITER_RESOURCE",
      "TRANSACTIONAL_WRITE",
      "ORDERED_COMMIT",
    ]));
    expect(result.serializationRisk).toBe("HIGH");
  });

  it("validates stage dependencies and rejects cycles", () => {
    const descriptor = {
      schemaVersion: 1,
      stages: [
        {
          id: "first",
          entry: { file: "src/opportunities.ts", name: "parseFiles" },
          workUnit: "FILE",
          scheduling: "SERIAL",
          inputSharing: "READ_ONLY",
          aggregation: "PER_UNIT",
          dependsOn: ["second"],
        },
        {
          id: "second",
          entry: { file: "src/opportunities.ts", name: "parseFiles" },
          workUnit: "FILE",
          scheduling: "SERIAL",
          inputSharing: "READ_ONLY",
          aggregation: "PER_UNIT",
          dependsOn: ["first"],
        },
      ],
      sinks: [],
    };

    expect(() => validatePipelineDescriptor(descriptor)).toThrow(/dependency cycle/);
  });

  it("loads pipeline descriptors through the API and CLI without changing native priority", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "crankts-pipeline-"));
    temporaryDirectories.push(temporaryDirectory);
    const pipelinePath = join(temporaryDirectory, "pipeline.json");
    const descriptor: PipelineDescriptor = {
      schemaVersion: 1,
      workloadLabel: "fixture-index-build",
      stages: [{
        id: "parse-files",
        entry: { file: "src/opportunities.ts", name: "parseFiles" },
        workUnit: "FILE",
        scheduling: "SERIAL",
        inputSharing: "READ_ONLY",
        aggregation: "PER_UNIT",
        dependsOn: [],
      }],
      sinks: [],
    };
    writeFileSync(pipelinePath, JSON.stringify(descriptor));

    const project = analyzeProject(resolve("test/fixtures/basic"), { pipelinePath });
    const parseFiles = project.functions.find((functionAnalysis) => functionAnalysis.name === "parseFiles");
    const parseFilesOpportunity = parseFiles
      ? Math.max(parseFiles.opportunities.cpu, parseFiles.opportunities.memory, parseFiles.opportunities.parallel)
      : 0;
    expect(project.pipeline?.stages[0]).toMatchObject({
      id: "parse-files",
      entryStatus: "RESOLVED",
      independentWork: "CANDIDATE",
    });
    expect(parseFiles?.nativePriority).toBe(
      Math.round((parseFiles?.suitability ?? 0) * parseFilesOpportunity / 100),
    );
    expect(JSON.parse(renderJsonReport(project))).toMatchObject({
      schemaVersion: 2,
      pipeline: { workloadLabel: "fixture-index-build" },
    });

    let output = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(runCli([
        "analyze",
        "test/fixtures/basic",
        "--pipeline",
        pipelinePath,
        "--workload",
        "fixture-cli-workload",
        "--format=json",
      ])).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(JSON.parse(output)).toMatchObject({
      workloadLabel: "fixture-cli-workload",
      pipeline: { workloadLabel: "fixture-cli-workload" },
      acceleration: { workloadLabel: "fixture-cli-workload" },
    });
    expect(JSON.parse(output).pipeline.stages[0].entryStatus).toBe("RESOLVED");
  });
});