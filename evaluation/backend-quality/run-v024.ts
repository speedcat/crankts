// v0.2.4 backend quality evaluation: extracts both kernel-style fixtures with `crankts extract`,
// builds them in release mode, and runs the *generated* benchmark (ts/benchmark.ts) with its
// acceptance gate against the handwritten PoCs (MVP-8 KWX, MVP-9b graph) as references.
//
// Run from the CrankTS root after `pnpm build`:
//   node --import tsx evaluation/backend-quality/run-v024.ts [--out /tmp/crankts-v024] [--runs 5]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeProject } from "../../src/analysis/analyze-project.js";
import { extractKernel } from "../../src/lowering/extract.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const intentweave = resolve(repoRoot, "../intentweave");
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};
const out = resolve(option("--out", "/tmp/crankts-v024"));
const runs = Number(option("--runs", "5"));
const target = join(out, "cargo-target");
const extension = process.platform === "darwin" ? "dylib" : "so";
const fixtures = join(repoRoot, "test/fixtures/lowering/src");
const require = createRequire(import.meta.url);

type Fn = (...args: unknown[]) => unknown;

mkdirSync(out, { recursive: true });

function cargoRelease(crateDirectory: string, library: string, destination: string): string {
  const build = spawnSync("cargo", ["build", "--release", "--quiet"], {
    cwd: crateDirectory,
    encoding: "utf8",
    env: { ...process.env, CARGO_TARGET_DIR: target },
  });
  if (build.status !== 0) {
    throw new Error(`cargo build failed in ${crateDirectory}:\n${build.stderr}`);
  }
  copyFileSync(join(target, "release", `lib${library}.${extension}`), destination);
  return destination;
}

function extract(name: string, request: Omit<Parameters<typeof extractKernel>[0], "outDir" | "crateName">): string {
  const directory = join(out, name);
  const result = extractKernel({ ...request, outDir: directory, crateName: name });
  if (!result.ok) {
    throw new Error(`extract ${name} failed at ${result.stage}: ${result.messages.join("\n")}`);
  }
  cargoRelease(directory, name.replace(/-/g, "_"), join(directory, `${name.replace(/-/g, "_")}.node`));
  return directory;
}

// --- graph workload: the real W1 candidate graph, replicated ------------------------------------

interface Replay {
  readonly nodeCount: number;
  readonly nodes: readonly [string, string, number][];
  readonly adjacency: readonly (readonly number[])[];
  readonly source: unknown;
}

function graphCase(replay: Replay, scale: number): unknown[] {
  const files: string[] = [];
  const lines: number[] = [];
  const neighborLists: number[][] = [];
  for (let copy = 0; copy < scale; copy += 1) {
    const prefix = copy === 0 ? "" : `copy${copy}/`;
    for (const [, file, line] of replay.nodes) {
      files.push(`${prefix}${file}`);
      lines.push(line);
    }
    for (const neighbors of replay.adjacency) {
      neighborLists.push(neighbors.map((neighbor) => neighbor + copy * replay.nodeCount));
    }
  }
  const offsets = new Uint32Array(neighborLists.length + 1);
  neighborLists.forEach((list, index) => {
    offsets[index + 1] = (offsets[index] ?? 0) + list.length;
  });
  const ranked = [...new Set(files)].sort((left, right) => left.localeCompare(right));
  const rank = new Map(ranked.map((file, index) => [file, index]));
  return [offsets, Uint32Array.from(neighborLists.flat()), Uint32Array.from(files.map((file) => rank.get(file) ?? 0)), Uint32Array.from(lines)];
}

// --- KWX workload: IntentWeave function names × IntentWeave paragraphs --------------------------

function kwxWorkload(): { terms: string[]; texts: string[] } {
  const analysis = analyzeProject(intentweave, { workspaceReferences: true });
  const terms = [...new Set(analysis.functions.flatMap((fn) => fn.name.split(".")).filter((name) => name.length > 0))].sort();
  const texts: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") {
        continue;
      }
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else if (entry.endsWith(".md") || (path.includes("/packages/") && path.includes("/src/") && entry.endsWith(".ts"))) {
        texts.push(...readFileSync(path, "utf8").split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0));
      }
    }
  };
  visit(intentweave);
  return { terms, texts };
}

// --- run -----------------------------------------------------------------------------------------

const graphReplayPath = "/tmp/crankts-graph/w1-graph.json";
if (!existsSync(graphReplayPath)) {
  mkdirSync("/tmp/crankts-graph", { recursive: true });
  const exported = spawnSync(process.execPath, [join(repoRoot, "evaluation/graph-native-poc/export-graph.mjs"), intentweave, "--workspace-references", "--output", graphReplayPath], { encoding: "utf8" });
  if (exported.status !== 0) {
    throw new Error(exported.stderr);
  }
}
const replay = JSON.parse(readFileSync(graphReplayPath, "utf8")) as Replay;

console.error("building handwritten references and generated kernels ...");
const graphReference = require(cargoRelease(join(repoRoot, "evaluation/graph-native-poc"), "graph_native_poc", join(out, "graph_native_poc.node"))) as Record<string, Fn>;
const kwxPoc = require(cargoRelease(join(repoRoot, "evaluation/kwx-native-poc"), "kwx_native_poc", join(out, "kwx_native_poc.node"))) as {
  PreparedDictionary: new (terms: string[]) => { scan(text: string): number[] };
};
const graphDirectory = extract("graph-v024", {
  target: join(fixtures, "graph-kernel.ts#graphBatch"),
  shape: "GRAPH_BATCH",
  graph: { offsets: "offsets", neighbors: "neighbors", direction: "directed" },
});
const kwxDirectory = extract("kwx-v024", {
  target: join(fixtures, "kwx-kernel.ts#scanAsciiTerms"),
  prepare: join(fixtures, "kwx-kernel.ts#prepareDictionary"),
  shape: "PREPARED_STATE",
});

type Benchmark = { runBenchmark(options: Record<string, unknown>): Record<string, unknown> & { accepted: boolean } };
const graphBenchmark = await import(pathToFileURL(join(graphDirectory, "ts/benchmark.ts")).href) as Benchmark;
const kwxBenchmark = await import(pathToFileURL(join(kwxDirectory, "ts/benchmark.ts")).href) as Benchmark;
const { graphBatch } = await import(pathToFileURL(join(fixtures, "graph-kernel.ts")).href) as { graphBatch: Fn };
const kwxKernel = await import(pathToFileURL(join(fixtures, "kwx-kernel.ts")).href) as { prepareDictionary: Fn; scanAsciiTerms: Fn };

const graphResults = [];
for (const scale of [1, 10, 100]) {
  const args = graphCase(replay, scale);
  // The references must compute the same result, or the comparison is meaningless.
  const referenceOutput = Array.from(graphReference.graphBatch?.(...args) as Uint32Array);
  if (JSON.stringify(referenceOutput) !== JSON.stringify(graphBatch(...args))) {
    throw new Error(`graph reference disagrees with the original at ${scale}x`);
  }
  console.error(`graph ${scale}x ...`);
  const report = graphBenchmark.runBenchmark({ cases: [{ calls: [args] }], runs, reference: graphReference, parityIterations: 200, paritySample: 1 });
  graphResults.push({ scale, nodes: (args[0] as Uint32Array).length - 1, report });
}

console.error("kwx workload ...");
const { terms, texts } = kwxWorkload();
const reference = {
  prepareDictionary: (dictionary: unknown) => new kwxPoc.PreparedDictionary(dictionary as string[]),
  scanAsciiTerms: (text: unknown, handle: unknown) => (handle as { scan(text: string): number[] }).scan(text as string),
};
const referenceState = reference.prepareDictionary(terms);
const originalState = kwxKernel.prepareDictionary(terms, 3);
for (const text of texts.slice(0, 500)) {
  if (JSON.stringify(reference.scanAsciiTerms(text, referenceState)) !== JSON.stringify(kwxKernel.scanAsciiTerms(text, originalState))) {
    throw new Error("KWX reference disagrees with the original");
  }
}
const kwxReport = kwxBenchmark.runBenchmark({
  cases: [{ prepareArgs: [terms, 3], calls: texts.map((text) => [text, undefined]) }],
  runs,
  reference,
  parityIterations: 400,
  paritySample: 200,
});

const result = {
  schemaVersion: 1,
  project: "CrankTS",
  comparisonType: "v0.2.4-generated-backend-quality",
  capturedAt: new Date().toISOString().slice(0, 10),
  environment: {
    node: process.version.slice(1),
    host: `${process.platform}-${process.arch}`,
    rust: spawnSync("rustc", ["--version"], { encoding: "utf8" }).stdout.split(" ")[1],
    build: "cargo --release (opt-level 3, LTO, codegen-units 1)",
  },
  gateDefinition: {
    correctness: "generated parity: wrapper ≡ original and native ≡ original-or-trap on supplied + fuzzed cases",
    performance: "wrapper total < original TypeScript total (median)",
    backendQuality: "generated addon call <= 2x handwritten PoC call (median)",
    boundary: "(wrapper - kernel compute) / (original - kernel compute) <= 0.5",
  },
  baselineBeforeV024: {
    note: "v0.2.2 generated graph kernel through the MVP-9b harness (f64 everywhere, JS array output, per-component allocation)",
    w1: { generatedCallMs: 0.94, handwrittenCallMs: 0.26 },
    w1x10: { generatedCallMs: 6.11, handwrittenCallMs: 1.54 },
    w1x100: { generatedCallMs: 59.09, handwrittenCallMs: 13.66 },
  },
  graph: { workload: "W1 candidate graph (IntentWeave full workspace), replicated", results: graphResults },
  kwx: {
    workload: "dictionary = IntentWeave function names; texts = paragraphs of IntentWeave Markdown and packages/*/src TypeScript",
    terms: terms.length,
    texts: texts.length,
    textUnits: texts.reduce((sum, text) => sum + text.length, 0),
    report: kwxReport,
  },
};
const output = join(repoRoot, "evaluation/crankts-v024-backend-quality.json");
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.error(`wrote ${output}`);
