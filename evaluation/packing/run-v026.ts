// v0.2.6 evaluation: CrankTS packs its own, unmodified findWeaklyConnectedComponents (islands.ts) with
// the id-domain representation pass and measures three variants on the real W1 candidate graph:
//   A  original TypeScript (Map<FunctionId, Set<FunctionId>>, Set, localeCompare comparator)
//   B  transformed TypeScript: pack → packed TS (indices, CSR, bitmap, rank) → unpack
//   C  transformed native:     pack → Rust kernel → unpack
// and attributes the gain to the representation (A→B) and to the execution backend (B→C).
//
// Run from the CrankTS root after `pnpm build`:
//   node --import tsx evaluation/packing/run-v026.ts [--out /tmp/crankts-v026] [--runs 5]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { analyzeProject } from "../../src/analysis/analyze-project.js";
import { findCandidateIslands, findWeaklyConnectedComponents } from "../../src/analysis/islands.js";
import type { FunctionAnalysis } from "../../src/analysis/model.js";
import { extractKernel } from "../../src/lowering/extract.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const intentweave = resolve(repoRoot, "../intentweave");
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};
const out = resolve(option("--out", "/tmp/crankts-v026"));
const runs = Number(option("--runs", "5"));
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const round = (value: number): number => Math.round(value * 1000) / 1000;
type Fn = (...args: unknown[]) => unknown;

// Child mode: end-to-end findCandidateIslands of one module in a fresh process.
if (argv.includes("--measure-islands")) {
  const module = await import(pathToFileURL(option("--measure-islands", "")).href) as { findCandidateIslands: typeof findCandidateIslands };
  const functions = JSON.parse(readFileSync(option("--functions", ""), "utf8")) as FunctionAnalysis[];
  const scoped = new Set(functions.map((fn) => fn.id));
  const samples: number[] = [];
  let output = "";
  for (let run = 0; run <= runs; run += 1) {
    const start = performance.now();
    const islands = module.findCandidateIslands(functions, scoped);
    if (run > 0) samples.push(performance.now() - start);
    output = JSON.stringify(islands);
  }
  // Written to a file: stdout is a pipe, and process.exit() would cut large output off at 64 KB.
  writeFileSync(option("--result", ""), JSON.stringify({ medianMs: median(samples), output }));
  process.exit(0);
}

mkdirSync(out, { recursive: true });
const crate = join(out, "wcc-packed");
const extracted = extractKernel({
  target: `${join(repoRoot, "src/analysis/islands.ts")}#findWeaklyConnectedComponents`,
  shape: "GRAPH_BATCH",
  outDir: crate,
  crateName: "wcc-packed",
  intern: "FunctionId",
});
if (!extracted.ok) throw new Error(`${extracted.stage}: ${extracted.messages.join("\n")}`);
console.error("building release kernel ...");
const build = spawnSync("cargo", ["build", "--release", "--quiet"], { cwd: crate, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: join(out, "cargo-target") } });
if (build.status !== 0) throw new Error(build.stderr);
copyFileSync(join(out, "cargo-target/release", `libwcc_packed.${process.platform === "darwin" ? "dylib" : "so"}`), join(crate, "wcc_packed.node"));

const integration = await import(pathToFileURL(join(crate, "ts/integration.ts")).href) as {
  variants: { packedTypeScript: Fn; native: Fn; pack: (...args: unknown[]) => { ids: readonly string[]; args: readonly unknown[] }; packedKernel: Fn };
  nativeAddon: Record<string, Fn>;
};
const adapters = await import(pathToFileURL(join(crate, "ts/adapters.ts")).href) as Record<string, Fn>;
const unpack = adapters["unpackFindWeaklyConnectedComponents"] as (flat: ArrayLike<number>, ids: readonly string[]) => string[][];
const parity = await import(pathToFileURL(join(crate, "ts/parity.ts")).href) as {
  runPackedParity(original: unknown, options: { iterations: number }): { packedAgreed: number; nativeAgreed: number; packingGuards: number; mismatches: string[] };
};
const parityReport = parity.runPackedParity(findWeaklyConnectedComponents, { iterations: 3000 });

// --- kernel-level A/B/C on the W1 graph -------------------------------------------------------------
const replayPath = "/tmp/crankts-graph/w1-graph.json";
if (!existsSync(replayPath)) {
  mkdirSync("/tmp/crankts-graph", { recursive: true });
  const exported = spawnSync(process.execPath, [join(repoRoot, "evaluation/graph-native-poc/export-graph.mjs"), intentweave, "--workspace-references", "--output", replayPath], { encoding: "utf8" });
  if (exported.status !== 0) throw new Error(exported.stderr);
}
const replay = JSON.parse(readFileSync(replayPath, "utf8")) as { nodeCount: number; nodes: [string, string, number][]; adjacency: number[][] };

function inputs(scale: number): unknown[] {
  const candidates: { id: string; file: string; line: number }[] = [];
  for (let copy = 0; copy < scale; copy += 1) {
    const prefix = copy === 0 ? "" : `copy${copy}/`;
    for (const [id, file, line] of replay.nodes) candidates.push({ id: `${prefix}${id}`, file: `${prefix}${file}`, line });
  }
  const adjacency = new Map<string, Set<string>>();
  candidates.forEach((candidate, index) => {
    const copy = Math.floor(index / replay.nodeCount);
    adjacency.set(candidate.id, new Set((replay.adjacency[index % replay.nodeCount] ?? []).map((neighbor) => candidates[neighbor + copy * replay.nodeCount]?.id ?? "")));
  });
  return [candidates, adjacency, new Map(candidates.map((candidate) => [candidate.id, candidate]))];
}

const kernelLevel = [];
for (const scale of [1, 10, 100]) {
  console.error(`W1 ${scale}x ...`);
  const args = inputs(scale);
  const expected = JSON.stringify(findWeaklyConnectedComponents(...(args as Parameters<typeof findWeaklyConnectedComponents>)));
  for (const variant of [integration.variants.packedTypeScript, integration.variants.native]) {
    if (JSON.stringify(variant(...args)) !== expected) throw new Error(`variant disagrees with the original at ${scale}x`);
  }
  const samples: Record<string, number[]> = { A: [], B: [], C: [], pack: [], packedKernel: [], nativeCall: [], kernel: [], unpack: [] };
  const time = (label: string, body: () => unknown): unknown => {
    const start = performance.now();
    const result = body();
    samples[label]?.push(performance.now() - start);
    return result;
  };
  for (let run = 0; run <= runs; run += 1) {
    if (run === 0) {
      findWeaklyConnectedComponents(...(args as Parameters<typeof findWeaklyConnectedComponents>));
      integration.variants.packedTypeScript(...args);
      integration.variants.native(...args);
      continue;
    }
    time("A", () => findWeaklyConnectedComponents(...(args as Parameters<typeof findWeaklyConnectedComponents>)));
    time("B", () => integration.variants.packedTypeScript(...args));
    time("C", () => integration.variants.native(...args));
    const packed = time("pack", () => integration.variants.pack(...args)) as { ids: readonly string[]; args: readonly unknown[] };
    time("packedKernel", () => integration.variants.packedKernel(...packed.args));
    const flat = time("nativeCall", () => integration.nativeAddon["findWeaklyConnectedComponents__packed"]?.(...packed.args)) as Uint32Array;
    samples.kernel?.push((integration.nativeAddon["__lastKernelNanos"]?.() as number) / 1e6);
    time("unpack", () => unpack(flat, packed.ids));
  }
  const m = Object.fromEntries(Object.entries(samples).map(([label, values]) => [label, round(median(values))])) as Record<string, number>;
  const a = m.A ?? 0;
  const b = m.B ?? 0;
  const c = m.C ?? 0;
  kernelLevel.push({
    scale,
    nodes: (args[0] as unknown[]).length,
    medianMs: m,
    speedup: { transformedTypeScript: round(a / b), transformedNative: round(a / c) },
    attribution: a > c
      ? { representation: round((a - b) / (a - c)), nativeExecution: round((b - c) / (a - c)) }
      : { representation: null, nativeExecution: null, note: "no total gain" },
    upstreamPacking: {
      note: "if the producer built the packed graph (pack excluded)",
      transformedTypeScriptMs: round((m.packedKernel ?? 0) + (m.unpack ?? 0)),
      transformedNativeMs: round((m.nativeCall ?? 0) + (m.unpack ?? 0)),
      speedupTypeScript: round(a / ((m.packedKernel ?? 0) + (m.unpack ?? 0))),
      speedupNative: round(a / ((m.nativeCall ?? 0) + (m.unpack ?? 0))),
    },
  });
}

// --- end to end: findCandidateIslands on the real W1 analysis, fresh processes -------------------
console.error("analyzing IntentWeave for the end-to-end run ...");
const analysis = analyzeProject(intentweave, { workspaceReferences: true });
const functionsPath = join(out, "w1-functions.json");
writeFileSync(functionsPath, JSON.stringify(analysis.functions));
let measurement = 0;
function measureIslands(modulePath: string, env: Record<string, string> = {}): { medianMs: number; output: string } {
  const resultPath = join(out, `islands-${measurement++}.json`);
  const child = spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "evaluation/packing/run-v026.ts"), "--measure-islands", modulePath, "--functions", functionsPath, "--runs", String(runs), "--result", resultPath], {
    cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env },
  });
  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(readFileSync(resultPath, "utf8")) as { medianMs: number; output: string };
}
const patchedIslands = join(crate, "ts/islands.crankts.ts");
const endToEnd = {
  original: measureIslands(join(repoRoot, "src/analysis/islands.ts")),
  native: measureIslands(patchedIslands),
  transformedTypeScript: measureIslands(patchedIslands, { CRANKTS_ADDON_WCC_PACKED: join(out, "disabled.node") }),
};
const identical = endToEnd.native.output === endToEnd.original.output && endToEnd.transformedTypeScript.output === endToEnd.original.output;

const result = {
  schemaVersion: 1,
  project: "CrankTS",
  comparisonType: "v0.2.6-id-packed-graph-kernel",
  capturedAt: new Date().toISOString().slice(0, 10),
  environment: { node: process.version.slice(1), host: `${process.platform}-${process.arch}`, build: "cargo --release" },
  source: "src/analysis/islands.ts#findWeaklyConnectedComponents (unmodified)",
  contract: { shape: extracted.contract.shape, obligations: extracted.contract.proofObligations.map((obligation) => `${obligation.kind}:${obligation.status}`) },
  parity: { cases: 3000, ...parityReport, mismatches: parityReport.mismatches.length },
  kernelLevel,
  endToEnd: {
    workload: `findCandidateIslands on the W1 analysis (${analysis.functions.length} functions), fresh process per variant`,
    identicalOutput: identical,
    originalMs: round(endToEnd.original.medianMs),
    transformedTypeScriptMs: round(endToEnd.transformedTypeScript.medianMs),
    transformedNativeMs: round(endToEnd.native.medianMs),
  },
};
const output = join(repoRoot, "evaluation/crankts-v026-packed-graph.json");
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.error(`wrote ${output}`);
console.log(JSON.stringify({ parity: result.parity, kernelLevel, endToEnd: result.endToEnd }, null, 2));
