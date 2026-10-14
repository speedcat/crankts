import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeWorkload } from "../src/observe/session.js";
import { createObserveFixture } from "./helpers/observe-fixture.js";

/**
 * M3 acceptance (docs/observe-plan.md §10): the allocLoop fixture's short-lived allocations make it the top allocator,
 * and the amplified fixture's CPU per call has the expected magnitude with confidence ≥ medium. CPU shares use wall
 * time, so this runs in the isolated "profiled" group.
 */

let root = "";
beforeAll(() => {
  root = createObserveFixture({ build: true });
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const key = (name: string) => `observe-fixture::src/${name}`;

describe("observe M3: heap and per-call estimates", () => {
  it("finds short-lived allocations and estimates cost per call", { timeout: 120_000, retry: 2 }, async () => {
    process.env["OBSERVE_FIXTURE_UNIT_MS"] = "50";
    const result = await observeWorkload({ command: [process.execPath, "dist/main.js"], cwd: root, stdio: "ignore", cpuIntervalUs: 100, heapIntervalBytes: 65_536 });
    expect(result.error).toBeUndefined();
    expect(result.session.measurements.map((measurement) => measurement.kind)).toEqual(["cpu", "coverage", "heap"]);
    expect(result.session.quality.checks).toMatchObject({ artifactAgreement: true });
    expect(result.attribution?.allocatedButNotExecutedRatio).toBeLessThan(0.05);
    const metrics = result.attribution?.metrics ?? [];
    const metric = (name: string) => metrics.find((candidate) => candidate.key === key(name));

    // Top own allocator, although its arrays are dropped right away (--heap-prof alone would not see them).
    const own = metrics.filter((candidate) => candidate.key.startsWith("observe-fixture::") && candidate.allocation);
    const top = [...own].sort((left, right) => (right.allocation?.selfBytes ?? 0) - (left.allocation?.selfBytes ?? 0))[0];
    expect(top?.key).toBe(key("alloc-loop.ts::allocateTemporaries"));
    expect(top?.allocation?.selfBytes).toBeGreaterThan(12e6);
    expect(top?.allocation?.selfBytes).toBeLessThan(40e6);
    expect(top?.allocation?.includesCollected).toBe(true);
    expect(top?.estimates?.bytesPerCall).toMatchObject({ executionCount: 1 });
    expect(metric("alloc-loop.ts::retainSome")?.allocation?.selfBytes ?? 0).toBeLessThan((top?.allocation?.selfBytes ?? 0) / 5);

    // normalizeToken: 2 units over 2000 calls; expensiveTransform: 4 units in one call.
    const perCall = metric("amplified.ts::normalizeToken")?.estimates?.selfCpuPerCall;
    const unitNs = ((metric("expensive.ts::expensiveTransform")?.cpu?.selfMs ?? 0) * 1e6) / 4;
    expect(perCall).toMatchObject({ executionCount: 2000 });
    expect(["medium", "high"]).toContain(perCall?.confidence);
    expect(perCall?.estimatedNs).toBeGreaterThan(((2 * unitNs) / 2000) * 0.75);
    expect(perCall?.estimatedNs).toBeLessThan(((2 * unitNs) / 2000) * 1.25);
  });
});
