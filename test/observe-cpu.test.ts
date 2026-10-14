import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateCpuProfile, sampleWeights, type V8CpuProfile } from "../src/observe/aggregate/cpu.js";
import { FrameResolver } from "../src/observe/resolve/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project(): { root: string; url: string; depUrl: string } {
  const root = mkdtempSync(join(tmpdir(), "crankts-observe-cpu-"));
  directories.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
  writeFileSync(join(root, "src", "a.ts"), [
    "export function outer() { return inner(); }",
    "export function inner() { return 1; }",
    "export async function resumed() { return 2; }",
  ].join("\n"));
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "export function call(f) { return f(); }\n");
  return { root, url: pathToFileURL(join(root, "src", "a.ts")).href, depUrl: pathToFileURL(join(root, "node_modules", "dep", "index.js")).href };
}

function syntheticProfile(url: string, depUrl: string): V8CpuProfile {
  const frame = (functionName: string, frameUrl: string, lineNumber: number, columnNumber: number) => ({ functionName, url: frameUrl, lineNumber, columnNumber });
  return {
    nodes: [
      { id: 1, callFrame: frame("(root)", "", -1, -1), children: [11, 5, 6, 10] },
      { id: 11, callFrame: frame("runEntryPointWithESMLoader", "node:internal/modules/run_main", 0, 0), children: [2] },
      { id: 2, callFrame: frame("outer", url, 0, 7), children: [3, 4, 8] },
      { id: 3, callFrame: frame("inner", url, 1, 7) },
      { id: 4, callFrame: frame("call", depUrl, 0, 7) },
      { id: 5, callFrame: frame("(idle)", "", -1, -1) },
      { id: 6, callFrame: frame("processTicksAndRejections", "node:internal/process/task_queues", 0, 0), children: [7] },
      { id: 7, callFrame: frame("resumed", url, 2, 13) },
      { id: 8, callFrame: frame("call", depUrl, 0, 7), children: [9] },
      { id: 9, callFrame: frame("inner", url, 1, 7) },
      { id: 10, callFrame: frame("(garbage collector)", "", -1, -1) },
    ],
    startTime: 0,
    endTime: 300_000,
    samples: [3, 3, 4, 5, 7, 9, 10],
    timeDeltas: [5_000, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000],
  };
}

describe("observe CPU aggregation", () => {
  it("weights a sample by the gap to the next one and the last by endTime", () => {
    const { url, depUrl } = project();
    expect(sampleWeights(syntheticProfile(url, depUrl))).toEqual([10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 85_000]);
  });

  it("computes self, inclusive, caused, edges, and flags", () => {
    const { root, url, depUrl } = project();
    const resolver = new FrameResolver(root);
    const result = aggregateCpuProfile(syntheticProfile(url, depUrl), resolver, {
      isAsync: (key) => resolver.referencedEntities.get(key)?.source?.async === true,
    });
    const metric = (key: string) => result.metrics.find((candidate) => candidate.key === key)?.cpu;

    expect(result.summary.totalMs).toBe(255);
    expect(result.summary.idleMs).toBe(40);
    expect(result.summary.byCategory).toMatchObject({ own: 140, dependency: 30, gc: 85 });
    expect(result.summary.unmappedOwnSampleRatio).toBe(0);

    expect(metric("app::src/a.ts::inner")).toMatchObject({ selfMs: 90, inclusiveMs: 90, samples: 3 });
    expect(metric("app::src/a.ts::outer")).toMatchObject({
      selfMs: 0,
      inclusiveMs: 120,
      caused: { dependencyMs: 30, runtimeMs: 0, nativeMs: 0, gcMs: 0 },
      causedByPackage: { dep: 30 },
    });
    expect(metric("dep::*")).toMatchObject({ selfMs: 30, inclusiveMs: 90 });
    expect(metric("(gc)")).toMatchObject({ selfMs: 85, selfPct: 33.33 });

    expect(result.edges).toEqual([
      { callerKey: "app::src/a.ts::outer", calleeKey: "app::src/a.ts::inner", measurementId: "cpu-01", sampledInclusiveMs: 90, samples: 3, shareOfCallee: 1, via: "dependency" },
    ]);

    const flags = (key: string) => result.metrics.find((candidate) => candidate.key === key)?.flags;
    expect(flags("app::src/a.ts::resumed")).toEqual(["asyncTruncated"]);
    expect(flags("app::src/a.ts::outer")).toEqual([]);
    expect(resolver.referencedEntities.get("app::src/a.ts::resumed")?.source).toMatchObject({ line: 3, async: true });
  });

  it("counts recursion once for inclusive time and records the self edge", () => {
    const { root, url } = project();
    const frame = (id: number, children: number[] = []) => ({ id, callFrame: { functionName: "outer", url, lineNumber: 0, columnNumber: 7 }, children });
    const result = aggregateCpuProfile({
      nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] }, frame(2, [3]), frame(3, [4]), frame(4)],
      startTime: 0,
      endTime: 20_000,
      samples: [4, 2],
      timeDeltas: [0, 10_000],
    }, new FrameResolver(root));
    expect(result.metrics.find((metric) => metric.key === "app::src/a.ts::outer")?.cpu).toMatchObject({ selfMs: 20, inclusiveMs: 20 });
    expect(result.edges).toEqual([
      expect.objectContaining({ callerKey: "app::src/a.ts::outer", calleeKey: "app::src/a.ts::outer", sampledInclusiveMs: 10, shareOfCallee: 0.5 }),
    ]);
  });

  it("moves self ticks on an inlined callee's lines from the caller's frame to the callee", () => {
    const { root, url } = project();
    const resolver = new FrameResolver(root);
    const result = aggregateCpuProfile({
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
        // outer's frame, but 3 of its 4 ticks are on line 2 (inner) and one on line 99 (another script's line).
        { id: 2, callFrame: { functionName: "outer", url, lineNumber: 0, columnNumber: 7 }, positionTicks: [{ line: 2, ticks: 3 }, { line: 1, ticks: 0 }, { line: 99, ticks: 1 }] },
      ],
      startTime: 0,
      endTime: 40_000,
      samples: [2, 2, 2, 2],
      timeDeltas: [0, 10_000, 10_000, 10_000],
    }, resolver, { entityAtLine: (frameUrl, line) => resolver.entityAtLine(frameUrl, line) });
    const metric = (name: string) => result.metrics.find((candidate) => candidate.key === `app::src/a.ts::${name}`);
    expect(metric("inner")?.cpu).toMatchObject({ selfMs: 30, inclusiveMs: 30, samples: 3 });
    expect(metric("inner")?.flags).toContain("inlinedSuspected");
    expect(metric("outer")?.cpu).toMatchObject({ selfMs: 10, inclusiveMs: 40, samples: 1 });
    expect(result.edges).toEqual([expect.objectContaining({ callerKey: "app::src/a.ts::outer", calleeKey: "app::src/a.ts::inner", sampledInclusiveMs: 30 })]);
  });

  it("reports own frames it cannot map", () => {
    const { root } = project();
    const missing = pathToFileURL(join(root, "src", "missing.js")).href;
    const result = aggregateCpuProfile({
      nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] }, { id: 2, callFrame: { functionName: "gone", url: missing, lineNumber: 0, columnNumber: 0 } }],
      startTime: 0,
      endTime: 10_000,
      samples: [2],
      timeDeltas: [0],
    }, new FrameResolver(root));
    expect(result.summary.unmappedOwnSampleRatio).toBe(1);
    expect(result.metrics[0]?.key).toBe("(unmapped)::src/missing.js");
  });
});
