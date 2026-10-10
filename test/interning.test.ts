import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject } from "../src/analysis/analyze-project.js";
import { findCandidateIslands, findWeaklyConnectedComponents } from "../src/analysis/islands.js";
import { extractKernel } from "../src/lowering/extract.js";
import { planInterning } from "../src/lowering/interning.js";
import { planBatchInterning } from "../src/lowering/interning-batch.js";
import { findArticulationPoints } from "../src/analysis/islands.js";

const islands = fileURLToPath(new URL("../src/analysis/islands.ts", import.meta.url));
const batchFixtures = fileURLToPath(new URL("./fixtures/lowering/src/batch-kernels.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const generatedRoot = fileURLToPath(new URL("./.generated", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("id-domain representation pass", () => {
  it("packs CrankTS's real findWeaklyConnectedComponents into indices, CSR, bitmaps, and ranks", () => {
    const result = planInterning({ file: islands, function: "findWeaklyConnectedComponents", alias: "FunctionId" });
    if (!result.ok) throw new Error(result.diagnostics.join("\n"));
    const plan = result.plan;
    expect(plan.params.map((param) => [param.name, param.role])).toEqual([
      ["candidateFunctions", "universe"], ["adjacency", "graph"], ["functionById", "entityRank"],
    ]);
    expect(plan.packedParams).toEqual(["candidateFunctions__count", "adjacency__offsets", "adjacency__neighbors", "functionById__rank"]);
    expect(plan.packedFunction).not.toContain("FunctionId");
    expect(plan.packedFunction).toContain("const visited = new Array<boolean>(candidateFunctions__count).fill(false);");
    expect(plan.packedFunction).toContain("for (let __slot0 = adjacency__offsets[currentId]; __slot0 < adjacency__offsets[currentId + 1]; __slot0++) {");
    expect(plan.packedFunction).toContain("members.sort((leftId, rightId) => functionById__rank[leftId] - functionById__rank[rightId]);");
    expect(plan.guards).toEqual(["every universe id has an entry in functionById", "functionById entries have a finite numeric line"]);
  });

  it("fails closed on findArticulationPoints with the rules it still needs", () => {
    const result = planInterning({ file: islands, function: "findArticulationPoints", alias: "FunctionId" });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining("members: readonly FunctionId[] has no packing rule"),
      expect.stringContaining("graph parameter adjacency must be used only as"),
      expect.stringContaining("no universe parameter"),
    ]));
  });

  it("generates a patched islands.ts that equals the original (packed TypeScript, no addon)", async () => {
    mkdirSync(generatedRoot, { recursive: true });
    const out = mkdtempSync(join(generatedRoot, "wcc-"));
    temporaryDirectories.push(out);
    const extracted = extractKernel({
      target: `${islands}#findWeaklyConnectedComponents`,
      shape: "GRAPH_BATCH",
      outDir: out,
      crateName: "wcc-packed-fallback",
      intern: "FunctionId",
    });
    if (!extracted.ok) throw new Error(`${extracted.stage}: ${extracted.messages.join("\n")}`);
    expect(extracted.contract.inputs.map((input) => input.type.kind)).toEqual(["scalar", "packedGraph", "typedArray"]);

    const parity = await import(pathToFileURL(join(out, "ts/parity.ts")).href) as {
      runPackedParity(original: unknown, options: { iterations: number }): { packedAgreed: number; packingGuards: number; mismatches: string[] };
    };
    const report = parity.runPackedParity(findWeaklyConnectedComponents, { iterations: 600 });
    expect(report.mismatches).toEqual([]);
    expect(report.packedAgreed + report.packingGuards).toBe(600);
    expect(report.packedAgreed).toBeGreaterThan(500);

    // End-to-end: the patched findCandidateIslands on a real analysis (CrankTS's own src/).
    const patched = await import(pathToFileURL(join(out, "ts/islands.crankts.ts")).href) as { findCandidateIslands: typeof findCandidateIslands };
    const integration = await import(pathToFileURL(join(out, "ts/integration.ts")).href) as {
      nativeStatus: { loaded: boolean };
      packedStatus: { packedTypeScriptCalls: number; packingGuards: number };
    };
    const analysis = analyzeProject(join(repoRoot, "src"));
    const scoped = new Set(analysis.functions.map((fn) => fn.id));
    expect(JSON.stringify(patched.findCandidateIslands(analysis.functions, scoped))).toBe(JSON.stringify(findCandidateIslands(analysis.functions, scoped)));
    expect(integration.nativeStatus.loaded).toBe(false);
    expect(integration.packedStatus.packedTypeScriptCalls).toBe(1);
  });
});

describe("batch id-domain pass (v0.2.6b)", () => {
  it("batches CrankTS's real findArticulationPoints into one packed kernel over all components", () => {
    const result = planBatchInterning({ file: islands, function: "findArticulationPoints", alias: "FunctionId" });
    if (!result.ok) throw new Error(result.diagnostics.join("\n"));
    const plan = result.plan;
    expect(plan.batchFunction).toContain("export function findArticulationPoints__batch(");
    expect(plan.batchFunction).not.toMatch(/FunctionId|\.get\(|\.set\(|\.has\(|reduce|\.sort\(/);
    // Id maps → hoisted presence/value arrays reset per group; the frame stack → struct of arrays reading the CSR.
    expect(plan.batchFunction).toContain("const discovery__has = new Array<boolean>(__n).fill(false);");
    expect(plan.batchFunction).toContain("const frame__node = pending__node[frame];");
    expect(plan.batchFunction).toContain("adjacency__neighbors[adjacency__offsets[frame__node] + pending__nextNeighbor[frame]]");
    expect(plan.batchFunction).toContain("parent__value[memberId] = -1;");
    // Sort-then-first → streaming argmin on the numeric prefix; ties go to the adapter's verbatim comparator.
    expect(plan.output).toEqual([
      { name: "count", kind: "number" },
      expect.objectContaining({ name: "largestImpact", kind: "bestOrNull", comparator: expect.stringContaining("left.functionId.localeCompare(right.functionId)") }),
    ]);
    expect(plan.helpers.join("\n")).toContain("let __reduce");

    const patched = plan.patchedSource("./integration.js", join(repoRoot, "out/ts/islands.crankts.ts"));
    expect(patched.diagnostics).toEqual([]);
    expect(patched.text).toContain("__cranktsBatch.sealGraph(adjacency);");
    expect(patched.text).toContain("const __findArticulationPointsBatch0 = __cranktsBatch.findArticulationPointsBatch(findArticulationPoints, componentMembers, adjacency);");
    expect(patched.text).toContain("(__findArticulationPointsBatch0[componentIndex] as ReturnType<typeof findArticulationPoints>)");
  });

  it("seals a graph only when no later mutation is possible, and rejects early returns", () => {
    const result = planBatchInterning({ file: batchFixtures, function: "memberCount", alias: "Id" });
    if (!result.ok) throw new Error(result.diagnostics.join("\n"));
    const patched = result.plan.patchedSource("./integration.js", join(repoRoot, "out/ts/batch-kernels.crankts.ts"));
    expect(patched.text.match(/__cranktsBatch\.sealGraph\(graph\)/g)).toHaveLength(1);
    expect(patched.text.match(/__cranktsBatch\.memberCountBatch\(memberCount, groups, graph\)/g)).toHaveLength(2);
    expect(patched.diagnostics).toEqual([expect.stringMatching(/graph graph is not sealed .*line 30/)]);

    const early = planBatchInterning({ file: batchFixtures, function: "earlyExit", alias: "Id" });
    expect(early.ok ? [] : early.diagnostics).toEqual([expect.stringContaining("early return at line 36 cannot be batched")]);
  });

  it("generates a batched, sealed findCandidateIslands that equals the original (packed TypeScript, no addon)", async () => {
    mkdirSync(generatedRoot, { recursive: true });
    const out = mkdtempSync(join(generatedRoot, "ap-batch-"));
    temporaryDirectories.push(out);
    const batched = extractKernel({
      target: `${islands}#findArticulationPoints`,
      shape: "GRAPH_BATCH",
      outDir: join(out, "ap"),
      crateName: "ap-batch-fallback",
      intern: "FunctionId",
      batch: true,
    });
    if (!batched.ok) throw new Error(`${batched.stage}: ${batched.messages.join("\n")}`);
    expect(batched.contract.inputs.map((input) => input.type.kind)).toEqual(["packedGraph", "typedArray", "typedArray"]);
    expect(batched.contract.proofObligations.map((obligation) => `${obligation.kind}:${obligation.status}`)).toEqual(expect.arrayContaining(["PURE:PROVEN", "NO_ALIASING:PROVEN"]));
    // Chained: WCC packed on the batched copy, sharing the sealed graph.
    const chained = extractKernel({
      target: `${join(out, "ap/ts/islands.crankts.ts")}#findWeaklyConnectedComponents`,
      shape: "GRAPH_BATCH",
      outDir: join(out, "wcc"),
      crateName: "wcc-sealed-fallback",
      intern: "FunctionId",
    });
    if (!chained.ok) throw new Error(`${chained.stage}: ${chained.messages.join("\n")}`);

    const parity = await import(pathToFileURL(join(out, "ap/ts/parity.ts")).href) as {
      runBatchParity(original: unknown, options: { iterations: number }): { packedAgreed: number; packingGuards: number; mismatches: string[] };
    };
    const report = parity.runBatchParity(findArticulationPoints, { iterations: 600 });
    expect(report.mismatches).toEqual([]);
    expect(report.packedAgreed + report.packingGuards).toBe(600);
    expect(report.packedAgreed).toBeGreaterThan(500);

    const patched = await import(pathToFileURL(join(out, "wcc/ts/islands.crankts.ts")).href) as { findCandidateIslands: typeof findCandidateIslands };
    type Status = { packedStatus: { packedTypeScriptCalls: number }; sealedGraphStats: { sealed: number; reused: number } };
    const apIntegration = await import(pathToFileURL(join(out, "ap/ts/integration.ts")).href) as Status;
    const wccIntegration = await import(pathToFileURL(join(out, "wcc/ts/integration.ts")).href) as Status;
    const before = { ...apIntegration.sealedGraphStats };
    const analysis = analyzeProject(join(repoRoot, "src"));
    const scoped = new Set(analysis.functions.map((fn) => fn.id));
    expect(JSON.stringify(patched.findCandidateIslands(analysis.functions, scoped))).toBe(JSON.stringify(findCandidateIslands(analysis.functions, scoped)));
    expect(apIntegration.packedStatus.packedTypeScriptCalls).toBe(1);
    expect(apIntegration.sealedGraphStats.sealed - before.sealed).toBe(1);
    expect(wccIntegration.sealedGraphStats.reused).toBe(1);
  });
});

