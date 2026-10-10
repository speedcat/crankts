import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeProject } from "../src/analysis/analyze-project.js";
import { loadV8HeapProfile } from "../src/analysis/heap-profile.js";
import { runCli } from "../src/index.js";
import { renderJsonReport } from "../src/report/json.js";
import { renderTextReport } from "../src/report/text.js";

const fixtureRoot = new URL("./fixtures/basic", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadV8HeapProfile", () => {
  it("maps sampled allocation bytes to self/inclusive functions and reports coverage", () => {
    const project = analyzeProject(fixtureRoot);
    const root = project.functions.find((functionAnalysis) => functionAnalysis.name === "profiledRoot");
    const helper = project.functions.find((functionAnalysis) => functionAnalysis.name === "profiledHelper");
    if (!root || !helper) throw new Error("Expected heap profile fixture functions.");

    const temporaryDirectory = mkdtempSync(join(tmpdir(), "crankts-heapprofile-"));
    temporaryDirectories.push(temporaryDirectory);
    const profilePath = join(temporaryDirectory, "allocations.heapprofile");
    const sourceUrl = pathToFileURL(join(fixtureRoot, "src", "opportunities.ts")).href;
    writeFileSync(profilePath, JSON.stringify({
      head: {
        id: 1,
        callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 },
        selfSize: 0,
        children: [
          {
            id: 2,
            callFrame: { functionName: "profiledRoot", url: sourceUrl, lineNumber: 0, columnNumber: 0 },
            selfSize: 0,
            children: [
              {
                id: 3,
                callFrame: { functionName: "profiledHelper", url: sourceUrl, lineNumber: 0, columnNumber: 0 },
                selfSize: 0,
                children: [{
                  id: 5,
                  callFrame: { functionName: "Buffer.alloc", url: "node:buffer", lineNumber: 0, columnNumber: 0 },
                  selfSize: 0,
                }],
              },
            ],
          },
          {
            id: 4,
            callFrame: { functionName: "unmatched", url: "file:///external/module.js", lineNumber: 0, columnNumber: 0 },
            selfSize: 0,
          },
        ],
      },
      samples: [
        { size: 100, nodeId: 2, ordinal: 1 },
        { size: 250, nodeId: 5, ordinal: 2 },
        { size: 650, nodeId: 4, ordinal: 3 },
      ],
    }));

    const profile = loadV8HeapProfile(profilePath, project.projectRoot, project.functions);

    expect(profile.summary).toMatchObject({
      totalSampledBytes: 1000,
      matchedSampledBytes: 350,
      matchedSampledPercent: 35,
      sampleCount: 3,
      matchedSampleCount: 2,
      confidence: "LOW",
    });
    expect(profile.observations.get(root.id)).toMatchObject({
      sampledBytesSelf: 100,
      sampledBytesTotal: 350,
      sampleCountSelf: 1,
      sampleCountTotal: 2,
    });
    expect(profile.observations.get(helper.id)).toMatchObject({
      sampledBytesSelf: 0,
      sampledBytesTotal: 250,
      sampleCountSelf: 0,
      sampleCountTotal: 1,
    });
  });

  it("rejects malformed or negative allocation samples", () => {
    const project = analyzeProject(fixtureRoot);
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "crankts-heapprofile-"));
    temporaryDirectories.push(temporaryDirectory);
    const profilePath = join(temporaryDirectory, "invalid.heapprofile");
    writeFileSync(profilePath, JSON.stringify({
      head: {
        id: 1,
        callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 },
      },
      samples: [{ size: -1, nodeId: 1 }],
    }));

    expect(() => loadV8HeapProfile(profilePath, project.projectRoot, project.functions)).toThrow(/non-negative size/);
  });

  it("attaches allocation evidence through the API and heap-profile CLI option", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "crankts-heapprofile-"));
    temporaryDirectories.push(temporaryDirectory);
    const profilePath = join(temporaryDirectory, "allocations.heapprofile");
    const sourceUrl = pathToFileURL(join(fixtureRoot, "src", "opportunities.ts")).href;
    writeFileSync(profilePath, JSON.stringify({
      head: {
        id: 1,
        callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 },
        children: [{
          id: 2,
          callFrame: { functionName: "profiledRoot", url: sourceUrl, lineNumber: 0, columnNumber: 0 },
        }],
      },
      samples: [{ size: 128, nodeId: 2, ordinal: 1 }],
    }));

    const baseline = analyzeProject(fixtureRoot);
    const result = analyzeProject(fixtureRoot, { heapProfilePath: profilePath });
    const baselineRoot = baseline.functions.find((functionAnalysis) => functionAnalysis.name === "profiledRoot");
    const profiledRoot = result.functions.find((functionAnalysis) => functionAnalysis.name === "profiledRoot");
    expect(result.allocationProfile).toMatchObject({
      totalSampledBytes: 128,
      matchedSampledBytes: 128,
      matchedSampledPercent: 100,
      confidence: "LOW",
    });
    expect(profiledRoot?.observedAllocation).toMatchObject({
      sampledBytesSelf: 128,
      sampledBytesTotal: 128,
      sampleCountSelf: 1,
      sampleCountTotal: 1,
    });
    expect(profiledRoot?.nativePriority).toBe(baselineRoot?.nativePriority);
    expect(JSON.parse(renderJsonReport(result))).toMatchObject({
      schemaVersion: 2,
      allocationProfile: { unit: "bytes" },
    });
    expect(renderTextReport(result, { verbose: true })).toContain("sampled allocation 128 bytes self");

    let output = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(runCli(["analyze", fixtureRoot, "--heap-profile", profilePath, "--format=json"])).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(JSON.parse(output).allocationProfile.matchedSampledBytes).toBe(128);
  });
});