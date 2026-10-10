// v0.2.6b evaluation: CrankTS batches its own, unmodified findArticulationPoints (islands.ts): one packed
// kernel call for all components instead of one call per component, the graph sealed (packed once) by its
// producer, and findWeaklyConnectedComponents (v0.2.6a) chained on the same sealed graph. Variants:
//   A  original TypeScript: groups.map(g => findArticulationPoints(g, adjacency))
//   B  transformed TypeScript: batched, packed kernel in TypeScript
//   C  transformed native: batched, packed Rust kernel
// each with per-call graph packing and with the graph sealed upstream, plus end to end on W1.
//
// Run from the CrankTS root:
//   node --expose-gc --import tsx evaluation/packing/run-v026b.ts [--out /tmp/crankts-v026b] [--runs 15]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { analyzeProject } from "../../src/analysis/analyze-project.js";
import { findArticulationPoints, findCandidateIslands, findWeaklyConnectedComponents } from "../../src/analysis/islands.js";
import type { FunctionAnalysis } from "../../src/analysis/model.js";
import { StageTimer } from "../../src/analysis/timings.js";
import { extractKernel } from "../../src/lowering/extract.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const intentweave = resolve(repoRoot, "../intentweave");
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};
const out = resolve(option("--out", "/tmp/crankts-v026b"));
const runs = Number(option("--runs", "15"));
// With --expose-gc, collect before every timed section so allocation from building inputs is not billed to it.
const collect = (): void => (globalThis as { gc?: () => void }).gc?.();
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const round = (value: number): number => Math.round(value * 1000) / 1000;
type Graph = ReadonlyMap<string, ReadonlySet<string>>;
type Groups = readonly (readonly string[])[];

// Child mode: end-to-end findCandidateIslands of one module in a fresh process.
if (argv.includes("--measure-islands")) {
  const module = await import(pathToFileURL(option("--measure-islands", "")).href) as { findCandidateIslands: typeof findCandidateIslands };
  const functions = JSON.parse(readFileSync(option("--functions", ""), "utf8")) as FunctionAnalysis[];
  const scoped = new Set(functions.map((fn) => fn.id));
  const totals: number[] = [];
  const graphWork: number[] = [];
  let output = "";
  for (let run = 0; run <= runs; run += 1) {
    const timer = new StageTimer();
    collect();
    const start = performance.now();
    const islands = module.findCandidateIslands(functions, scoped, timer);
    const total = performance.now() - start;
    // Graph work = everything except the stages no variant changes (adjacency construction, boundaries,
    // per-component metrics without articulation, sort): WCC, articulation, sealing, batching, lookups.
    const stage = (name: string): number => timer.toJSON().stages.find((entry) => entry.name === name)?.durationMs ?? 0;
    const unchanged = stage("islands.adjacency") + stage("islands.boundaries") + stage("islands.components")
      - stage("islands.components.articulation") + stage("islands.sort");
    if (run > 0) {
      totals.push(total);
      graphWork.push(total - unchanged);
    }
    output = JSON.stringify(islands);
  }
  writeFileSync(option("--result", ""), JSON.stringify({ medianMs: median(totals), graphWorkMs: median(graphWork), output }));
  process.exit(0);
}

mkdirSync(out, { recursive: true });
function build(crate: string, library: string): void {
  const result = spawnSync("cargo", ["build", "--release", "--quiet"], { cwd: crate, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: join(out, "cargo-target") } });
  if (result.status !== 0) throw new Error(result.stderr);
  copyFileSync(join(out, "cargo-target/release", `lib${library}.${process.platform === "darwin" ? "dylib" : "so"}`), join(crate, `${library}.node`));
}

// 1. Batch findArticulationPoints (patches its call site and seals the graph) ...
const apCrate = join(out, "ap-batch");
const batched = extractKernel({
  target: `${join(repoRoot, "src/analysis/islands.ts")}#findArticulationPoints`,
  shape: "GRAPH_BATCH",
  outDir: apCrate,
  crateName: "ap-batch",
  intern: "FunctionId",
  batch: true,
});
if (!batched.ok) throw new Error(`${batched.stage}: ${batched.messages.join("\n")}`);
// 2. ... then pack findWeaklyConnectedComponents on that patched copy (chained: both share the sealed graph).
const wccCrate = join(out, "wcc-sealed");
const chained = extractKernel({
  target: `${join(apCrate, "ts/islands.crankts.ts")}#findWeaklyConnectedComponents`,
  shape: "GRAPH_BATCH",
  outDir: wccCrate,
  crateName: "wcc-sealed",
  intern: "FunctionId",
});
if (!chained.ok) throw new Error(`${chained.stage}: ${chained.messages.join("\n")}`);
console.error("building release kernels ...");
build(apCrate, "ap_batch");
build(wccCrate, "wcc_sealed");

const integration = await import(pathToFileURL(join(apCrate, "ts/integration.ts")).href) as {
  variants: {
    original(original: unknown, groups: Groups, graph: Graph): unknown[];
    packedTypeScript(groups: Groups, graph: Graph): unknown[];
    native(groups: Groups, graph: Graph): unknown[];
    pack(groups: Groups, graph: Graph): { ids: readonly string[]; args: readonly [Uint32Array, Uint32Array, Uint32Array, Uint32Array] };
    packedKernel(args: readonly unknown[]): number[];
    nativeKernel(args: readonly unknown[]): ArrayLike<number>;
    unpack(flat: ArrayLike<number>, ids: readonly string[]): unknown[];
  };
  sealGraph(graph: Graph): void;
  nativeAddon: Record<string, (...args: unknown[]) => unknown> | undefined;
};
const parity = await import(pathToFileURL(join(apCrate, "ts/parity.ts")).href) as {
  runBatchParity(original: unknown, options: { iterations: number }): { packedAgreed: number; nativeAgreed: number; packingGuards: number; mismatches: string[] };
};
const parityReport = parity.runBatchParity(findArticulationPoints, { iterations: 3000 });

// --- kernel level on the W1 graph (components from the original WCC) --------------------------------
const replayPath = "/tmp/crankts-graph/w1-graph.json";
if (!existsSync(replayPath)) {
  mkdirSync("/tmp/crankts-graph", { recursive: true });
  const exported = spawnSync(process.execPath, [join(repoRoot, "evaluation/graph-native-poc/export-graph.mjs"), intentweave, "--workspace-references", "--output", replayPath], { encoding: "utf8" });
  if (exported.status !== 0) throw new Error(exported.stderr);
}
const replay = JSON.parse(readFileSync(replayPath, "utf8")) as { nodeCount: number; nodes: [string, string, number][]; adjacency: number[][] };

function inputs(scale: number): { groups: string[][]; graph: () => Map<string, Set<string>> } {
  const candidates: { id: string; file: string; line: number }[] = [];
  for (let copy = 0; copy < scale; copy += 1) {
    const prefix = copy === 0 ? "" : `copy${copy}/`;
    for (const [id, file, line] of replay.nodes) candidates.push({ id: `${prefix}${id}`, file: `${prefix}${file}`, line });
  }
  // A fresh Map per measured call: sealing is per graph object, as in findCandidateIslands.
  const graph = (): Map<string, Set<string>> => {
    const adjacency = new Map<string, Set<string>>();
    candidates.forEach((candidate, index) => {
      const copy = Math.floor(index / replay.nodeCount);
      adjacency.set(candidate.id, new Set((replay.adjacency[index % replay.nodeCount] ?? []).map((neighbor) => candidates[neighbor + copy * replay.nodeCount]?.id ?? "")));
    });
    return adjacency;
  };
  const groups = findWeaklyConnectedComponents(candidates as unknown as FunctionAnalysis[], graph(), new Map(candidates.map((candidate) => [candidate.id, candidate])) as never);
  return { groups, graph };
}

const variants = integration.variants;
const kernelLevel = [];
for (const scale of [1, 10, 100]) {
  console.error(`W1 ${scale}x ...`);
  const { groups, graph } = inputs(scale);
  const reference = graph();
  const expected = JSON.stringify(variants.original(findArticulationPoints, groups, reference));
  for (const variant of [variants.packedTypeScript, variants.native]) {
    if (JSON.stringify(variant(groups, graph())) !== expected) throw new Error(`variant disagrees with the original at ${scale}x`);
  }
  const samples: Record<string, number[]> = {
    A: [], B: [], C: [], seal: [], Bsealed: [], Csealed: [], packGroups: [], packedKernel: [], nativeCall: [], kernel: [], unpack: [],
  };
  const time = <T>(label: string, body: () => T): T => {
    collect();
    const start = performance.now();
    const result = body();
    samples[label]?.push(performance.now() - start);
    return result;
  };
  for (let run = 0; run <= runs; run += 1) {
    const warm = run === 0;
    const g1 = graph();
    const g2 = graph();
    const g3 = graph();
    const g4 = graph();
    const g5 = graph();
    if (warm) {
      variants.original(findArticulationPoints, groups, g1);
      variants.packedTypeScript(groups, g2);
      variants.native(groups, g3);
      continue;
    }
    time("A", () => variants.original(findArticulationPoints, groups, g1));
    time("B", () => variants.packedTypeScript(groups, g2));
    time("C", () => variants.native(groups, g3));
    time("seal", () => integration.sealGraph(g4));
    time("Bsealed", () => variants.packedTypeScript(groups, g4));
    integration.sealGraph(g5);
    const packed = time("packGroups", () => variants.pack(groups, g5));
    time("packedKernel", () => variants.packedKernel(packed.args));
    const flat = time("nativeCall", () => variants.nativeKernel(packed.args));
    samples.kernel?.push((integration.nativeAddon?.["__lastKernelNanos"]?.() as number) / 1e6);
    time("unpack", () => variants.unpack(flat, packed.ids));
    // Sealed native: g4 is sealed for B; seal g1 (read-only use by A) for C.
    integration.sealGraph(g1);
    time("Csealed", () => variants.native(groups, g1));
  }
  const m = Object.fromEntries(Object.entries(samples).map(([label, values]) => [label, round(median(values))])) as Record<string, number>;
  const a = m.A ?? 0;
  const attribution = (b: number, c: number): Record<string, number | null> => (a > c
    ? { representationAndBatching: round((a - b) / (a - c)), nativeExecution: round((b - c) / (a - c)) }
    : { representationAndBatching: null, nativeExecution: null });
  kernelLevel.push({
    scale,
    nodes: replay.nodeCount * scale,
    groups: groups.length,
    callsBefore: groups.length,
    callsAfter: 1,
    medianMs: m,
    perCallPacking: { speedupTypeScript: round(a / (m.B ?? 1)), speedupNative: round(a / (m.C ?? 1)), attribution: attribution(m.B ?? 0, m.C ?? 0) },
    sealedUpstream: {
      note: "graph sealed by the producer (the seal is paid once per producer call and shared by WCC and articulation)",
      speedupTypeScript: round(a / (m.Bsealed ?? 1)),
      speedupNative: round(a / (m.Csealed ?? 1)),
      attribution: attribution(m.Bsealed ?? 0, m.Csealed ?? 0),
    },
  });
}

// --- end to end: findCandidateIslands on the real W1 analysis, fresh processes -------------------------
console.error("analyzing IntentWeave for the end-to-end run ...");
const analysis = analyzeProject(intentweave, { workspaceReferences: true });
const functionsPath = join(out, "w1-functions.json");
writeFileSync(functionsPath, JSON.stringify(analysis.functions));
let measurement = 0;
const processes = 3;
type IslandsRun = { medianMs: number; graphWorkMs: number; output: string };
function measureIslandsOnce(modulePath: string, env: Record<string, string>): IslandsRun {
  const resultPath = join(out, `islands-${measurement++}.json`);
  const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", join(repoRoot, "evaluation/packing/run-v026b.ts"), "--measure-islands", modulePath, "--functions", functionsPath, "--runs", String(runs), "--result", resultPath], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env },
  });
  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(readFileSync(resultPath, "utf8")) as IslandsRun;
}
const disabled = join(out, "disabled.node");
const batchOnly = join(apCrate, "ts/islands.crankts.ts");
const both = join(wccCrate, "ts/islands.crankts.ts");
const e2eVariants: Record<string, [string, Record<string, string>]> = {
  original: [join(repoRoot, "src/analysis/islands.ts"), {}],
  articulationBatchedTypeScript: [batchOnly, { CRANKTS_ADDON_AP_BATCH: disabled }],
  articulationBatchedNative: [batchOnly, {}],
  bothTypeScript: [both, { CRANKTS_ADDON_AP_BATCH: disabled, CRANKTS_ADDON_WCC_SEALED: disabled }],
  bothNative: [both, {}],
};
// Round-robin over fresh processes, so load drift on the machine hits every variant alike.
const e2eRuns: Record<string, IslandsRun[]> = Object.fromEntries(Object.keys(e2eVariants).map((label) => [label, []]));
for (let pass = 0; pass < processes; pass += 1) {
  for (const [label, [modulePath, env]] of Object.entries(e2eVariants)) e2eRuns[label]?.push(measureIslandsOnce(modulePath, env));
}
const allOutputs = Object.values(e2eRuns).flat().map((run) => run.output);
const identical = allOutputs.every((output) => output === allOutputs[0]);
const e2e = Object.fromEntries(Object.entries(e2eRuns).map(([label, list]) => [label, round(median(list.map((run) => run.medianMs)))])) as Record<string, number>;
const e2eGraph = Object.fromEntries(Object.entries(e2eRuns).map(([label, list]) => [label, round(median(list.map((run) => run.graphWorkMs)))])) as Record<string, number>;
const original = e2e.original ?? 0;
const originalGraph = e2eGraph.original ?? 0;

const result = {
  schemaVersion: 1,
  project: "CrankTS",
  comparisonType: "v0.2.6b-batched-articulation-sealed-graph",
  capturedAt: new Date().toISOString().slice(0, 10),
  environment: { node: process.version.slice(1), host: `${process.platform}-${process.arch}`, build: "cargo --release", loadAverage: os.loadavg().map(round) },
  source: "src/analysis/islands.ts#findArticulationPoints and #findWeaklyConnectedComponents (unmodified)",
  contract: { shape: batched.contract.shape, obligations: batched.contract.proofObligations.map((obligation) => `${obligation.kind}:${obligation.status}`) },
  parity: { cases: 3000, ...parityReport, mismatches: parityReport.mismatches.length },
  kernelLevel,
  endToEnd: {
    workload: `findCandidateIslands on the W1 analysis (${analysis.functions.length} functions); median of ${processes} fresh processes x ${runs} runs per variant`,
    identicalOutput: identical,
    medianMs: e2e,
    speedup: Object.fromEntries(Object.entries(e2e).map(([label, value]) => [label, round(original / value)])),
    graphWorkMs: e2eGraph,
    graphWorkSpeedup: Object.fromEntries(Object.entries(e2eGraph).map(([label, value]) => [label, round(originalGraph / value)])),
  },
};
const output = join(repoRoot, "evaluation/crankts-v026b-batched-graph.json");
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.error(`wrote ${output}`);
console.log(JSON.stringify({ parity: result.parity, kernelLevel, endToEnd: result.endToEnd }, null, 2));
