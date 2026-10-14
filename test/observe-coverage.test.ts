import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aggregateCoverage, type V8CoverageFile } from "../src/observe/aggregate/coverage.js";
import type { ArtifactFingerprint } from "../src/observe/model.js";
import { FrameResolver } from "../src/observe/resolve/index.js";
import { artifactsAgree, repeatCountAgreement } from "../src/observe/quality/index.js";
import { observeWorkload } from "../src/observe/session.js";
import { createObserveFixture, typeStripping } from "./helpers/observe-fixture.js";

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("coverage aggregation", () => {
  const source = [
    "export function outer(items: number[]) {", // line 1
    "  return items.map((item) => {",
    "    if (item > 1) return item;",
    "    return 0;",
    "  });",
    "}",
    "class Box { size() { return 1; } }",
  ].join("\n");

  function project(): { root: string; url: string } {
    const root = mkdtempSync(join(tmpdir(), "crankts-observe-cov-"));
    directories.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(join(root, "src", "a.ts"), source);
    return { root, url: pathToFileURL(join(root, "src", "a.ts")).href };
  }

  it("matches V8 functions to entity headers and keeps exact counts and block ranges", () => {
    const { root, url } = project();
    const at = (text: string) => source.indexOf(text);
    const file: V8CoverageFile = {
      result: [{
        scriptId: "1",
        url,
        functions: [
          { functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
          // `export function outer`: source positions often point at `export`.
          { functionName: "outer", isBlockCoverage: true, ranges: [{ startOffset: at("export"), endOffset: at("class") - 1, count: 4 }] },
          {
            functionName: "",
            isBlockCoverage: true,
            ranges: [
              { startOffset: at("(item) =>"), endOffset: at("  });"), count: 40 },
              { startOffset: at("return item;"), endOffset: at("return item;") + "return item;".length, count: 25 },
            ],
          },
          // A synthetic function (e.g. a class-field initializer) lands outside every header.
          { functionName: "<instance_members_initializer>", isBlockCoverage: true, ranges: [{ startOffset: at("class Box") + 10, endOffset: at("class Box") + 11, count: 2 }] },
          { functionName: "size", isBlockCoverage: true, ranges: [{ startOffset: at("size()"), endOffset: source.length - 2, count: 0 }] },
        ],
      }],
    };
    const resolver = new FrameResolver(root);
    const result = aggregateCoverage(file, resolver);
    const execution = (name: string) => result.executions.get(`app::src/a.ts::${name}`);
    expect(execution("(module)")?.functionExecutionCount).toBe(1);
    expect(execution("outer")?.functionExecutionCount).toBe(4);
    expect(execution("outer/items.map#cb0")).toMatchObject({
      functionExecutionCount: 40,
      hotRanges: [{ kind: "block", startLine: 3, startColumn: 19, endLine: 3, rangeExecutionCount: 25 }],
    });
    expect(execution("Box.size")?.functionExecutionCount).toBe(0);
    expect(result.summary).toMatchObject({ ownFunctions: 5, matchedFunctions: 4, unmatchedExecutedFunctions: 1, executedEntities: 3 });
    expect(resolver.referencedEntities.has("app::src/a.ts::outer/items.map#cb0")).toBe(true);
  });

  it("compares execution counts of two coverage runs", () => {
    const first = new Map([["a", 1000], ["b", 500], ["c", 10], ["zero", 0]]);
    expect(repeatCountAgreement(first, new Map([["a", 1005], ["b", 500], ["c", 10]]))).toBe(1);
    expect(repeatCountAgreement(first, new Map([["a", 1100], ["b", 500]]))).toBe(0.333);
    expect(repeatCountAgreement(first, new Map([["a", 1000], ["b", 500], ["c", 10]]), 2)).toBe(1);
  });

  it("compares artifacts across measurements", () => {
    const base: ArtifactFingerprint = { entrypoint: "dist/main.js", entrypointHash: "e", sourceMapHashes: { "dist/a.js.map": "m" }, moduleHashes: { "dist/a.js": "a" }, loader: "node" };
    expect(artifactsAgree([base, { ...base, moduleHashes: { "dist/a.js": "a", "dist/b.js": "b" } }])).toBe(true);
    expect(artifactsAgree([base, { ...base, moduleHashes: { "dist/a.js": "changed" } }])).toBe(false);
    expect(artifactsAgree([base, { ...base, entrypointHash: "other" }])).toBe(false);
  });
});

/** M2 acceptance (docs/observe-plan.md §10): exact function counts and plausible loop-body counts on the fixture. */
describe("crankts observe with coverage", () => {
  let built = "";
  let plain = "";
  beforeAll(() => {
    built = createObserveFixture({ build: true });
    plain = createObserveFixture();
    directories.push(built, plain);
  });

  const key = (name: string) => `observe-fixture::src/${name}`;
  async function observe(root: string, command: string[]) {
    process.env["OBSERVE_FIXTURE_UNIT_MS"] = "5";
    const result = await observeWorkload({ command, cwd: root, stdio: "ignore", only: ["cpu", "coverage"] });
    expect(result.error).toBeUndefined();
    const metrics = new Map(result.attribution?.metrics.map((metric) => [metric.key, metric]));
    const count = (name: string) => metrics.get(key(name))?.execution?.functionExecutionCount;
    expect(count("expensive.ts::expensiveTransform")).toBe(1);
    expect(count("amplified.ts::processTokens")).toBe(1);
    expect(count("amplified.ts::normalizeToken")).toBe(2000);
    expect(count("recursive.ts::walk")).toBe(20);
    expect(count("anonymous.ts::buildIndex/items.map#cb0")).toBe(100);
    expect(count("anonymous.ts::buildIndex/mapped.forEach#cb0")).toBe(100);
    expect(count("loops.ts::nestedLoops")).toBe(3);
    expect(count("main.ts::(module)")).toBe(1);
    const loops = metrics.get(key("loops.ts::nestedLoops"))?.execution?.hotRanges ?? [];
    expect(loops[0]).toMatchObject({ startLine: 6, endLine: 8, rangeExecutionCount: 30_000 });
    expect(loops[1]).toMatchObject({ startLine: 4, endLine: 9, rangeExecutionCount: 150 });
    // CPU and coverage agree on the entities: sampled time sits on executed entities.
    expect(metrics.get(key("recursive.ts::walk"))?.cpu?.selfMs).toBeGreaterThan(0);
    expect(result.attribution?.sampledButNotExecutedRatio).toBeLessThan(0.05);
    expect(result.session.quality.checks).toMatchObject({ artifactAgreement: true });
    expect(result.session.measurements.map((measurement) => measurement.kind)).toEqual(["cpu", "coverage"]);
    return result;
  }

  it("counts executions from tsc output through source maps", async () => {
    const result = await observe(built, [process.execPath, "dist/main.js"]);
    expect(result.session.quality.level).toBe("high");
  });

  it("verifies determinism with a second coverage run and reports overhead against a baseline", async () => {
    process.env["OBSERVE_FIXTURE_UNIT_MS"] = "5";
    const result = await observeWorkload({ command: [process.execPath, "dist/main.js"], cwd: built, stdio: "ignore", only: ["cpu", "coverage"], verifyDeterminism: true, baseline: true });
    expect(result.session.measurements.map((measurement) => measurement.measurementId)).toEqual(["cpu-01", "cov-01", "cov-02"]);
    expect(result.session.quality.checks.repeatCountAgreement).toBe(1);
    expect(result.session.quality.level).toBe("high");
    expect(result.session.timing?.baselineWallMs).toBeGreaterThan(0);
    for (const measurement of result.session.measurements) expect(measurement.overhead?.wallRatio).toBeGreaterThan(0);
    // The execution counts stay those of the first coverage run.
    expect(result.attribution?.metrics.find((metric) => metric.key === key("amplified.ts::normalizeToken"))?.execution?.measurementId).toBe("cov-01");
  });

  it.skipIf(!typeStripping)("counts executions of type-stripped TypeScript directly", async () => {
    await observe(plain, [process.execPath, "src/main.ts"]);
  });

  it("maps tsx's transformed positions through the coverage run's source-map cache", async () => {
    const tsx = (await import("node:module")).createRequire(import.meta.url).resolve("tsx/cli");
    const result = await observe(plain, [process.execPath, tsx, "src/main.ts"]);
    expect(result.session.measurements[0]?.artifact?.loader).toBe("tsx");
    expect(result.session.quality.reasons).not.toContain("transformedPositionsWithoutSourceMaps");
  });
});
