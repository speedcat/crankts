import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexModuleSource } from "../src/observe/entity/index.js";
import { observeCpuProfile, type ObserveM0Result } from "../src/observe/m0.js";
import { createObserveFixture, fixtureSource, typeStripping } from "./helpers/observe-fixture.js";

/**
 * M0 acceptance on real profiles (docs/observe-plan.md §10): the fixture spends 4 : 3 : 2 : 2 : 1 : 0.5 work units in
 * expensiveTransform, a dependency, normalizeToken, walk, a map callback, and a forEach callback. Run once with Node
 * type stripping (`.ts` frames) and once from tsc output with source maps.
 */

const fixture = fixtureSource;
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const key = (name: string) => `observe-fixture::src/${name}`;
let root = "";

beforeAll(() => {
  root = createObserveFixture();
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function profile(entry: string, directory: string): string {
  rmSync(join(root, directory), { recursive: true, force: true });
  execFileSync(process.execPath, ["--cpu-prof", "--cpu-prof-interval", "100", "--cpu-prof-dir", directory, entry], {
    cwd: root,
    env: { ...process.env, OBSERVE_FIXTURE_UNIT_MS: "50", NODE_OPTIONS: "" },
    stdio: "pipe",
  });
  const file = readdirSync(join(root, directory)).find((name) => name.endsWith(".cpuprofile"));
  if (!file) throw new Error("no profile written");
  return join(root, directory, file);
}

function expectFixtureShape(result: ObserveM0Result): void {
  const cpu = (name: string) => {
    const metric = result.metrics.find((candidate) => candidate.key === key(name))?.cpu;
    if (!metric) throw new Error(`missing ${name}`);
    return metric;
  };
  const unit = cpu("expensive.ts::expensiveTransform").selfMs / 4;
  const near = (actual: number, units: number) => {
    expect(actual).toBeGreaterThan(units * unit * 0.75);
    expect(actual).toBeLessThan(units * unit * 1.25);
  };
  near(cpu("amplified.ts::normalizeToken").selfMs, 2);
  near(cpu("recursive.ts::walk").selfMs, 2);
  near(cpu("anonymous.ts::buildIndex/items.map#cb0").selfMs, 1);
  near(cpu("anonymous.ts::buildIndex/mapped.forEach#cb0").selfMs, 0.5);
  near(cpu("dep-heavy.ts::useDependency").caused.dependencyMs, 3);
  near(cpu("dep-heavy.ts::useDependency").causedByPackage?.["fakedep"] ?? 0, 3);
  near(cpu("amplified.ts::processTokens").inclusiveMs, 2);
  expect(cpu("dep-heavy.ts::useDependency").selfMs).toBeLessThan(unit * 0.1);

  const ownBySelf = result.metrics
    .filter((metric) => metric.key.startsWith("observe-fixture::"))
    .sort((left, right) => (right.cpu?.selfMs ?? 0) - (left.cpu?.selfMs ?? 0))
    .map((metric) => metric.key);
  expect(ownBySelf[0]).toBe(key("expensive.ts::expensiveTransform"));
  expect(new Set(ownBySelf.slice(1, 3))).toEqual(new Set([key("amplified.ts::normalizeToken"), key("recursive.ts::walk")]));
  expect(ownBySelf[3]).toBe(key("anonymous.ts::buildIndex/items.map#cb0"));

  const edge = (caller: string, callee: string) => result.edges.find((candidate) => candidate.callerKey === key(caller) && candidate.calleeKey === key(callee));
  expect(edge("amplified.ts::processTokens", "amplified.ts::normalizeToken")).toMatchObject({ shareOfCallee: 1, via: "direct" });
  expect(edge("recursive.ts::walk", "recursive.ts::walk")?.shareOfCallee).toBeGreaterThan(0.8);
  expect(edge("anonymous.ts::buildIndex", "anonymous.ts::buildIndex/items.map#cb0")?.shareOfCallee).toBe(1);

  expect(result.summary.unmappedOwnSampleRatio).toBeLessThan(0.05);
  const entity = result.entities.find((candidate) => candidate.identity.key === key("anonymous.ts::buildIndex/items.map#cb0"));
  expect(entity).toMatchObject({ kind: "arrow", source: { file: "src/anonymous.ts", line: 5, language: "typescript" } });
  expect(entity?.identity.anchor).toMatchObject({ nameSource: "context", parentKey: key("anonymous.ts::buildIndex") });
}

// Sample weights are wall time, so CPU contention from parallel test files can skew one phase; retry before failing.
const profiled = { timeout: 60_000, retry: 2 };

describe("observe M0 on the fixture", () => {
  it.skipIf(!typeStripping)("attributes a type-stripped run directly to TypeScript", profiled, () => {
    expectFixtureShape(observeCpuProfile({ profilePath: profile("src/main.ts", "prof-ts"), root }));
  });

  it("attributes a tsc build through its source maps and writes the output files", profiled, () => {
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: root, stdio: "pipe" });
    const out = join(root, "out-js");
    expectFixtureShape(observeCpuProfile({ profilePath: profile("dist/main.js", "prof-js"), root, outDir: out }));
    for (const file of ["entities.json", "metrics.json", "edges.json", "summary.json"]) {
      expect(() => JSON.parse(readFileSync(join(out, file), "utf8")) as unknown).not.toThrow();
    }
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) as { topSelf: { key: string }[]; topCaused: { key: string }[] };
    expect(summary.topSelf[0]?.key).toBe(key("expensive.ts::expensiveTransform"));
    expect(summary.topCaused[0]?.key).toBe(key("dep-heavy.ts::useDependency"));
  });

  it("keeps the anonymous fixture's keys when a function is inserted above", () => {
    const source = readFileSync(join(fixture, "src", "anonymous.ts"), "utf8");
    const options = { absoluteFile: "/x/src/anonymous.ts", file: "src/anonymous.ts", packageName: "observe-fixture", packagePath: "src/anonymous.ts" };
    const before = indexModuleSource(source, options).entities.map((entity) => entity.key);
    const after = new Set(indexModuleSource(`export function added(): number[] {\n  return [1].map((x) => x + 1);\n}\n${source}`, options).entities.map((entity) => entity.key));
    expect(before.length).toBeGreaterThan(2);
    for (const entityKey of before) expect(after.has(entityKey)).toBe(true);
  });
});
