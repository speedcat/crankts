import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject } from "../src/analysis/analyze-project.js";
import { computeCoverage } from "../src/analysis/coverage.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/basic", import.meta.url));
const graphUrl = pathToFileURL(join(fixtureRoot, "src/graph.ts")).href;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "crankts-coverage-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * root → buildGraph (project) → resolveEdges (project) → picomatch.test (package)
 *                                                   → readFileSync (node:fs) → readFileUtf8 (binding)
 * and GC without a stack. Samples: resolveEdges self 400, picomatch 300, fs binding 200, buildGraph self 100, GC 1000.
 */
function writeProfile(directory: string): string {
  const frame = (functionName: string, url: string, lineNumber: number) => ({ functionName, scriptId: "1", url, lineNumber, columnNumber: 0 });
  const profile = {
    nodes: [
      { id: 1, callFrame: frame("(root)", "", -1), children: [2, 6] },
      { id: 2, callFrame: frame("buildGraph", graphUrl, 15), children: [3] },
      { id: 3, callFrame: frame("resolveEdges", graphUrl, 9), children: [4, 7] },
      { id: 4, callFrame: frame("test", "file:///work/node_modules/picomatch/lib/picomatch.js", 1) },
      { id: 7, callFrame: frame("readFileSync", "node:fs", 400), children: [5] },
      { id: 5, callFrame: frame("readFileUtf8", "", -1) },
      { id: 6, callFrame: frame("(garbage collector)", "", -1) },
    ],
    startTime: 0,
    endTime: 2000,
    samples: [3, 4, 5, 2, 6],
    timeDeltas: [400, 300, 200, 100, 1000],
  };
  const file = join(directory, "run.cpuprofile");
  writeFileSync(file, JSON.stringify(profile));
  return file;
}

describe("call-site attribution and acceleration coverage", () => {
  it("attributes every sample to the innermost analyzed frame by target", () => {
    const analysis = analyzeProject(fixtureRoot, { profilePath: writeProfile(temporary()) });
    expect(analysis.cpuProfile?.attribution).toEqual({
      attributedPercent: 50,
      byTarget: { FUNCTION_SELF: 25, EXTERNAL_DEPENDENCY: 15, IO: 10 },
      unattributedPercent: 50,
      nativeAddonSelfPercent: 0,
    });
    const resolveEdges = analysis.functions.find((fn) => fn.name === "resolveEdges");
    expect(resolveEdges?.observedCpu?.callSite).toMatchObject({
      attributedPercent: 45,
      causedPercent: 25,
      byTarget: { FUNCTION_SELF: 20, EXTERNAL_DEPENDENCY: 15, IO: 10 },
      topExternal: [
        { origin: "picomatch", target: "EXTERNAL_DEPENDENCY", percent: 15 },
        { origin: "node", target: "IO", percent: 10 },
      ],
    });
    // Hotness uses the function's own JavaScript, not what it causes.
    const assessment = analysis.acceleration.functions.find((entry) => entry.functionId === resolveEdges?.id);
    expect(assessment?.observedWorkload).toMatchObject({ ownCpuSamplePercent: 20, causedCpuSamplePercent: 25 });
  });

  it("builds the evidence-level funnel and both recalls from annotations", () => {
    const analysis = analyzeProject(fixtureRoot, { profilePath: writeProfile(temporary()) });
    const id = (name: string): string => analysis.functions.find((fn) => fn.name === name)?.id ?? "";
    const report = computeCoverage(analysis, {
      share: 1,
      probe: (functionId) => (functionId === id("buildGraph") ? { accepted: ["lowering (Kernel IR)"], rejected: [] } : { accepted: [], rejected: ["lowering: ..."] }),
      annotations: {
        [id("resolveEdges")]: { transformability: "PLAUSIBLE", patterns: ["HOIST_INVARIANT_WORK"], fraction: 0.5, note: "test" },
        [id("buildGraph")]: { transformability: "EVIDENCE_SUPPORTED", patterns: ["CHANGE_ALGORITHM"], note: "test" },
      },
    });
    expect(report.callSites.map((site) => [site.name, site.attributedPercent, site.ownPercent])).toEqual([["resolveEdges", 45, 20], ["buildGraph", 5, 5]]);
    expect(Object.fromEntries(report.funnel.map((step) => [step.step, step.percent]))).toMatchObject({
      "human-plausible": 27.5,
      "human-evidence-supported": 5,
      "CrankTS-transformable (a fail-closed pass accepts it)": 5,
      "validated-beneficial": 0,
    });
    // The tiny profile has LOW confidence, so the advisor's hint on resolveEdges does not count as
    // recognition; only buildGraph (accepted by a pass) does: 5 of 27.5.
    expect(report.automatedRecognitionRecall).toBe(0.18);
    // Only HOIST_INVARIANT_WORK is a known family: 22.5 of 27.5.
    expect(report.patternFamilyRecall).toBe(0.82);
  });

  it("externalizes N-API time: ticks on addon call lines and binding lines of addon packages", () => {
    const root = temporary();
    mkdirSync(join(root, "src"));
    const addon = join(root, "node_modules/fast-addon");
    mkdirSync(addon, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "napi-project", dependencies: { "fast-addon": "1.0.0" } }));
    writeFileSync(join(addon, "package.json"), JSON.stringify({ name: "fast-addon", version: "1.0.0", main: "index.js", types: "index.d.ts", napi: { binaryName: "fast" } }));
    writeFileSync(join(addon, "index.d.ts"), "export declare function resolveFast(specifier: string): string;\nexport declare function parseWrapped(source: string): number;\n");
    writeFileSync(join(addon, "index.js"), "const binding = require('./fast.node');\nexports.resolveFast = binding.resolve;\nexports.parseWrapped = (source) => {\n  const raw = binding.parse(source);\n  return JSON.parse(raw).length;\n};\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "commonjs" }, include: ["src"] }));
    writeFileSync(join(root, "src/index.ts"), [
      'import { parseWrapped, resolveFast } from "fast-addon";',
      "export function resolveAll(specifiers: string[]): string[] {",
      "  const out: string[] = [];",
      "  for (const specifier of specifiers) {",
      "    out.push(resolveFast(specifier));",
      "  }",
      "  return out;",
      "}",
      "export function parseAll(sources: string[]): number {",
      "  let total = 0;",
      "  for (const source of sources) total += parseWrapped(source);",
      "  return total;",
      "}",
      "",
    ].join("\n"));
    const url = pathToFileURL(join(root, "src/index.ts")).href;
    const addonUrl = pathToFileURL(join(addon, "index.js")).href;
    const frame = (functionName: string, scriptUrl: string, lineNumber: number) => ({ functionName, scriptId: "1", url: scriptUrl, lineNumber, columnNumber: 0 });
    const profilePath = join(root, "run.cpuprofile");
    writeFileSync(profilePath, JSON.stringify({
      nodes: [
        { id: 1, callFrame: frame("(root)", "", -1), children: [2, 3] },
        // resolveAll: 3 of 4 self ticks on line 5 (the N-API call), 1 on line 4 (the loop).
        { id: 2, callFrame: frame("resolveAll", url, 1), positionTicks: [{ line: 5, ticks: 3 }, { line: 4, ticks: 1 }] },
        { id: 3, callFrame: frame("parseAll", url, 8), children: [4] },
        // parseWrapped (addon package JS): 1 tick on the binding line 4, 1 on JSON.parse (line 5).
        { id: 4, callFrame: frame("exports.parseWrapped", addonUrl, 2), positionTicks: [{ line: 4, ticks: 1 }, { line: 5, ticks: 1 }] },
      ],
      startTime: 0,
      endTime: 1600,
      samples: [2, 2, 2, 2, 4, 4],
      timeDeltas: [200, 200, 200, 200, 400, 400],
    }));
    const analysis = analyzeProject(root, { profilePath });
    const site = (name: string) => analysis.functions.find((fn) => fn.name === name)?.observedCpu?.callSite;
    expect(site("resolveAll")?.byTarget).toEqual({ EXTERNAL_NATIVE: 37.5, FUNCTION_SELF: 12.5 });
    expect(site("parseAll")?.byTarget).toEqual({ EXTERNAL_NATIVE: 25, EXTERNAL_DEPENDENCY: 25 });
    expect(analysis.cpuProfile?.attribution?.nativeAddonSelfPercent).toBe(37.5);
    // The advisor sees 12.5% own JavaScript for resolveAll, not the raw 50% self time.
    const assessment = analysis.acceleration.functions.find((entry) => entry.name === "resolveAll");
    expect(assessment?.observedWorkload).toMatchObject({ cpuSamplePercent: 50, ownCpuSamplePercent: 12.5 });
  });

  it("falls back to the bundled compiler when the project's TypeScript has no checker API (TypeScript 7)", () => {
    const root = temporary();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules/typescript"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ts7-project", devDependencies: { typescript: "7.0.2" } }));
    writeFileSync(join(root, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "7.0.2", main: "index.js" }));
    writeFileSync(join(root, "node_modules/typescript/index.js"), "module.exports = { version: '7.0.2' };\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
    writeFileSync(join(root, "src/index.ts"), "export function add(left: number, right: number): number {\n  return left + right;\n}\n");
    const analysis = analyzeProject(root);
    expect(analysis.typescript.source).toBe("bundled");
    expect(analysis.functions.map((fn) => fn.name)).toEqual(["add"]);
  });
});
