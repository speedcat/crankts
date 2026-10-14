import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeWorkload } from "../src/observe/session.js";
import { createObserveFixture } from "./helpers/observe-fixture.js";

/**
 * Toolchain matrix (docs/observe-plan.md §16, M5): the same fixture built with tsc 5.9, tsc 7, and a tsdown (rolldown)
 * bundle yields the same entities and exact counts. Node type stripping and tsx are covered in observe-coverage.
 */

const repo = new URL("..", import.meta.url).pathname;
const require = createRequire(import.meta.url);
let root = "";

beforeAll(() => {
  root = createObserveFixture();
  const run = (args: string[]) => execFileSync(process.execPath, args, { cwd: root, stdio: "pipe" });
  run([require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", "dist5"]);
  run([join(repo, "node_modules", "typescript7", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", "dist7"]);
  execFileSync(join(repo, "node_modules", ".bin", "tsdown"), ["src/main.ts", "--sourcemap", "--format", "esm", "-d", "bundle", "--no-dts"], { cwd: root, stdio: "pipe" });
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const key = (name: string) => `observe-fixture::src/${name}`;

describe.each([
  ["tsc 5.9", "dist5/main.js"],
  ["tsc 7", "dist7/main.js"],
  ["tsdown bundle", "bundle/main.mjs"],
])("toolchain %s", (_name, entry) => {
  it("maps CPU and coverage to the same entities with exact counts", async () => {
    process.env["OBSERVE_FIXTURE_UNIT_MS"] = "20";
    const result = await observeWorkload({ command: [process.execPath, entry], cwd: root, stdio: "ignore", only: ["cpu", "coverage"] });
    expect(result.error).toBeUndefined();
    const metrics = new Map(result.attribution?.metrics.map((metric) => [metric.key, metric]));
    const count = (name: string) => metrics.get(key(name))?.execution?.functionExecutionCount;
    expect(count("amplified.ts::normalizeToken")).toBe(2000);
    expect(count("recursive.ts::walk")).toBe(20);
    expect(count("anonymous.ts::buildIndex/items.map#cb0")).toBe(100);
    expect(count("loops.ts::nestedLoops")).toBe(3);
    expect(metrics.get(key("expensive.ts::expensiveTransform"))?.cpu?.selfMs).toBeGreaterThan(0);
    // The dependency stays a dependency, also when the bundler inlined it.
    expect(metrics.get("fakedep::*")?.cpu?.selfMs).toBeGreaterThan(0);
    expect([...metrics.keys()].some((metricKey) => metricKey.includes("node_modules"))).toBe(false);
    expect(result.attribution?.sampledButNotExecutedRatio).toBeLessThan(0.05);
    expect(result.attribution?.summary?.unmappedOwnSampleRatio).toBeLessThan(0.05);
    expect(result.session.quality.checks.artifactAgreement).toBe(true);
  }, 60_000);
});
