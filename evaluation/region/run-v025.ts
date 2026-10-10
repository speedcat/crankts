// v0.2.5 evaluation: CrankTS extracts the KWX kernel from the *unmodified* IntentWeave source
// (HeuristicKeywordExtractor.extractDictionary), builds it in release mode, and validates the
// generated patched copy against the original:
//   1. IntentWeave's own test file, run once against the original and once against the patched copy;
//   2. full extract() output on an IntentWeave corpus, plus caller-side Set mutation;
//   3. generated region parity (outlined TS vs. integration vs. raw addon);
//   4. full-extractor wall time and the region-level acceptance gate (handwritten MVP-8 scanner as reference).
//
// Run from the CrankTS root after `pnpm build`:
//   node --import tsx evaluation/region/run-v025.ts [--out /tmp/crankts-v025] [--runs 5]
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { analyzeProject } from "../../src/analysis/analyze-project.js";
import { extractKernel } from "../../src/lowering/extract.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const intentweave = resolve(repoRoot, "../intentweave");
const analyzer = join(intentweave, "packages/analyzer");
const sourceFile = join(analyzer, "src/kwg/heuristicExtractor.ts");
const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};
const out = resolve(option("--out", "/tmp/crankts-v025"));
const runs = Number(option("--runs", "5"));
const target = join(out, "cargo-target");
const extension = process.platform === "darwin" ? "dylib" : "so";
const require = createRequire(import.meta.url);
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const round = (value: number): number => Math.round(value * 1000) / 1000;

type Extractor = { extract(text: string, heading?: string): unknown[] };
type ExtractorClass = new (options?: { minLength?: number; depth?: "structured" | "full"; dictionary?: Set<string> }) => Extractor;

// Child mode: time the full extractor of one module in a fresh process (used with the addon disabled,
// which turns the integration into a TypeScript-only memoization of the prepared state).
if (argv.includes("--measure-full")) {
  const modulePath = option("--measure-full", "");
  const corpus = JSON.parse(readFileSync(option("--corpus", ""), "utf8")) as { dictionary: string[]; texts: string[] };
  const { HeuristicKeywordExtractor: Measured } = await import(pathToFileURL(modulePath).href) as { HeuristicKeywordExtractor: ExtractorClass };
  const samples: number[] = [];
  for (let run = 0; run <= runs; run += 1) {
    const extractor = new Measured({ depth: "full", dictionary: new Set(corpus.dictionary) });
    const start = performance.now();
    for (const text of corpus.texts) extractor.extract(text);
    if (run > 0) samples.push(performance.now() - start);
  }
  console.log(JSON.stringify({ medianMs: median(samples) }));
  process.exit(0);
}

function cargoRelease(crateDirectory: string, library: string, destination: string): void {
  const build = spawnSync("cargo", ["build", "--release", "--quiet"], { cwd: crateDirectory, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: target } });
  if (build.status !== 0) throw new Error(`cargo build failed in ${crateDirectory}:\n${build.stderr}`);
  copyFileSync(join(target, "release", `lib${library}.${extension}`), destination);
}

// --- 1. extract from the unmodified source --------------------------------------------------------
const sourceHash = spawnSync("git", ["-C", intentweave, "log", "-1", "--format=%h", "--", "packages/analyzer/src/kwg/heuristicExtractor.ts"], { encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["-C", intentweave, "status", "--porcelain", "--", "packages/analyzer/src/kwg/heuristicExtractor.ts"], { encoding: "utf8" }).stdout.trim();
if (dirty) throw new Error("heuristicExtractor.ts has local changes; the evaluation requires the committed source");
const crate = join(out, "kwx-region");
const extracted = extractKernel({
  target: `${sourceFile}#HeuristicKeywordExtractor.extractDictionary`,
  shape: "PREPARED_STATE",
  outDir: crate,
  crateName: "kwx-region",
  region: { execute: { startLine: 325, endLine: 360 }, prepare: { startLine: 303, endLine: 315 } },
});
if (!extracted.ok) throw new Error(`${extracted.stage}: ${extracted.messages.join("\n")}`);
console.error("building generated crate and handwritten MVP-8 reference ...");
cargoRelease(crate, "kwx_region", join(crate, "kwx_region.node"));
cargoRelease(join(repoRoot, "evaluation/kwx-native-poc"), "kwx_native_poc", join(out, "kwx_native_poc.node"));
const patchedPath = join(crate, "ts/heuristicExtractor.crankts.ts");

// --- 2. IntentWeave's own tests against original and patched --------------------------------------
function intentweaveTests(alias?: string): { passed: number; failed: number; raw: string } {
  const config = join(out, alias ? "vitest.patched.config.mjs" : "vitest.original.config.mjs");
  writeFileSync(config, `export default { root: ${JSON.stringify(analyzer)}, test: { include: ["src/__tests__/kwg-heuristicExtractor.test.ts"] }${alias
    ? `, resolve: { alias: [{ find: /^\\.\\.\\/kwg\\/heuristicExtractor\\.js$/, replacement: ${JSON.stringify(alias)} }] }`
    : ""} };\n`);
  const run = spawnSync(join(intentweave, "node_modules/.bin/vitest"), ["run", "--config", config, "--reporter=json"], { cwd: analyzer, encoding: "utf8", maxBuffer: 1 << 26 });
  const json = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as { numPassedTests: number; numFailedTests: number };
  return { passed: json.numPassedTests, failed: json.numFailedTests, raw: run.status === 0 ? "ok" : run.stderr.slice(0, 2000) };
}
console.error("IntentWeave test suite: original, then patched ...");
const testsOriginal = intentweaveTests();
const testsPatched = intentweaveTests(patchedPath);

// --- 3. corpus differential + mutation ---------------------------------------------------------------
console.error("loading corpus ...");
const analysis = analyzeProject(intentweave, { workspaceReferences: true });
const dictionary = [...new Set(analysis.functions.flatMap((fn) => fn.name.split(".")).filter((name) => name.length > 0))].sort();
const texts: string[] = [];
const visit = (directory: string): void => {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) visit(path);
    else if (entry.endsWith(".md") || (path.includes("/packages/") && path.includes("/src/") && entry.endsWith(".ts"))) {
      texts.push(...readFileSync(path, "utf8").split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0));
    }
  }
};
visit(intentweave);

const { HeuristicKeywordExtractor: Original } = await import(pathToFileURL(sourceFile).href) as { HeuristicKeywordExtractor: ExtractorClass };
const { HeuristicKeywordExtractor: Patched } = await import(pathToFileURL(patchedPath).href) as { HeuristicKeywordExtractor: ExtractorClass };
const integration = await import(pathToFileURL(join(crate, "ts/integration.ts")).href) as {
  nativeStatus: Record<string, unknown>;
  regionStatus: { preparations: number; cacheHits: number };
  nativeAddon: Record<string, (...args: unknown[]) => unknown>;
  executeExtractDictionary: (owner: object, inputs: [string[]], stripped: string, firstMatches: Map<string, unknown>) => void;
};
const regions = await import(pathToFileURL(join(crate, "ts/regions.ts")).href) as {
  prepareExtractDictionary: (terms: string[]) => unknown;
  executeExtractDictionary: (stripped: string, state: unknown, firstMatches: Map<string, unknown>) => void;
};

console.error(`differential on ${texts.length} texts ...`);
const left = new Original({ depth: "full", dictionary: new Set(dictionary) });
const right = new Patched({ depth: "full", dictionary: new Set(dictionary) });
let compared = 0;
let dictionaryMatches = 0;
const mismatches: string[] = [];
for (const text of texts) {
  const expected = left.extract(text);
  const actual = right.extract(text);
  compared += 1;
  dictionaryMatches += (expected as { source: string }[]).filter((match) => match.source === "dictionary").length;
  if (JSON.stringify(expected) !== JSON.stringify(actual)) mismatches.push(text.slice(0, 80));
}
// Mutation contract: caller changes the Set between extractions.
const mutationOriginal = new Set(dictionary.slice(0, 200));
const mutationPatched = new Set(dictionary.slice(0, 200));
const mutatingLeft = new Original({ depth: "full", dictionary: mutationOriginal });
const mutatingRight = new Patched({ depth: "full", dictionary: mutationPatched });
for (const [index, text] of texts.slice(0, 2000).entries()) {
  if (index % 50 === 0) {
    for (const set of [mutationOriginal, mutationPatched]) {
      set.add(dictionary[(index * 7) % dictionary.length] ?? "x");
      set.delete(dictionary[(index * 3) % 200] ?? "x");
    }
  }
  compared += 1;
  if (JSON.stringify(mutatingLeft.extract(text)) !== JSON.stringify(mutatingRight.extract(text))) mismatches.push(`mutation ${index}`);
}

const parityModule = await import(pathToFileURL(join(crate, "ts/parity.ts")).href) as {
  runRegionParity(options: { iterations: number }): { cases: number; nativeAgreed: number; nativeTrapped: number; mismatches: string[] };
};
const regionParity = parityModule.runRegionParity({ iterations: 2000 });

// --- 4. performance ----------------------------------------------------------------------------------
// Full-extractor timings run in fresh child processes: this process holds the IntentWeave analysis heap,
// whose GC pressure would distort in-process timings.
console.error("benchmarking ...");
const corpusPath = join(out, "corpus.json");
writeFileSync(corpusPath, JSON.stringify({ dictionary, texts }));
function measureFull(modulePath: string, env: Record<string, string> = {}): number {
  const child = spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "evaluation/region/run-v025.ts"), "--measure-full", modulePath, "--corpus", corpusPath, "--runs", String(runs)], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 1 << 26,
  });
  if (child.status !== 0) throw new Error(child.stderr);
  return (JSON.parse(child.stdout.trim().split("\n").pop() ?? "{}") as { medianMs: number }).medianMs;
}
const fullOriginal = measureFull(sourceFile);
const fullPatched = measureFull(patchedPath);
// Same patched source with the addon disabled: the integration's TypeScript path (cached TS state,
// identical snapshot checks), i.e. the prepared-state hoisting without native code.
const fullTsMemoized = measureFull(patchedPath, { CRANKTS_ADDON_KWX_REGION: join(out, "disabled.node") });

// Region level: the execute region on every text, with the state prepared once (as across calls).
const terms = dictionary.filter((term) => term.length >= 3);
const addon = integration.nativeAddon;
const poc = require(join(out, "kwx_native_poc.node")) as { PreparedDictionary: new (terms: string[]) => { scan(text: string): number[] } };
const pocState = new poc.PreparedDictionary(terms);
const tsState = regions.prepareExtractDictionary(terms);
const handle = addon["prepareExtractDictionary"]?.(terms);
// typescript: the original per-call work of both regions (prepare slice + scan), which the integration replaces.
// typescriptScanOnly: the scan on a state prepared once, i.e. V8 on the kernel itself.
const region: Record<string, number[]> = { typescript: [], typescriptScanOnly: [], integration: [], nativeCall: [], kernel: [], reference: [] };
const owner = {};
for (let run = 0; run <= runs; run += 1) {
  const time = (label: string, body: (text: string) => void): void => {
    const start = performance.now();
    for (const text of texts) body(text);
    if (run > 0) region[label]?.push(performance.now() - start);
  };
  time("typescript", (text) => regions.executeExtractDictionary(text, regions.prepareExtractDictionary(terms), new Map()));
  time("typescriptScanOnly", (text) => regions.executeExtractDictionary(text, tsState, new Map()));
  time("integration", (text) => integration.executeExtractDictionary(owner, [terms], text, new Map()));
  let kernel = 0;
  time("nativeCall", (text) => {
    addon["executeExtractDictionary"]?.(text, handle, []);
    kernel += (addon["__lastKernelNanos"]?.() as number) / 1e6;
  });
  if (run > 0) region.kernel?.push(kernel);
  time("reference", (text) => pocState.scan(text));
}
const regionMedians = Object.fromEntries(Object.entries(region).map(([label, values]) => [label, round(median(values))])) as Record<string, number>;
const boundaryShare = ((regionMedians.integration ?? 0) - (regionMedians.kernel ?? 0)) / ((regionMedians.typescript ?? 0) - (regionMedians.kernel ?? 0));
const referenceRatio = (regionMedians.nativeCall ?? 0) / (regionMedians.reference ?? 1);
const gate = {
  correctness: testsPatched.failed === 0 && testsPatched.passed === testsOriginal.passed && mismatches.length === 0 && regionParity.mismatches.length === 0 ? "PASS" : "FAIL",
  performance: (regionMedians.integration ?? 0) < (regionMedians.typescript ?? 0) ? "PASS" : "FAIL",
  backendQuality: referenceRatio <= 2 ? "PASS" : "FAIL",
  // Informational: does the native kernel itself beat V8 on the scan (state prepared once)?
  nativeKernelVsV8Scan: round((regionMedians.typescriptScanOnly ?? 0) / (regionMedians.kernel ?? 1)),
  boundary: boundaryShare <= 0.5 ? "PASS" : "FAIL",
};

const result = {
  schemaVersion: 1,
  project: "CrankTS",
  comparisonType: "v0.2.5-region-extraction-real-kwx",
  capturedAt: new Date().toISOString().slice(0, 10),
  environment: { node: process.version.slice(1), host: `${process.platform}-${process.arch}`, build: "cargo --release" },
  source: {
    file: "intentweave/packages/analyzer/src/kwg/heuristicExtractor.ts",
    commit: sourceHash,
    modified: false,
    regions: { prepare: "303-315 (sliced on simpleTermsByLower; state declaration on line 299 pulled in)", execute: "325-360" },
  },
  contract: { shape: extracted.contract.shape, invalidation: extracted.contract.state?.invalidation, obligations: extracted.contract.proofObligations.map((obligation) => `${obligation.kind}:${obligation.status}`) },
  intentweaveTests: { original: { passed: testsOriginal.passed, failed: testsOriginal.failed }, patched: { passed: testsPatched.passed, failed: testsPatched.failed } },
  differential: {
    workload: "dictionary = IntentWeave function names; texts = IntentWeave Markdown and packages/*/src paragraphs; plus 2,000 extractions with Set mutation every 50 calls",
    dictionaryTerms: dictionary.length,
    texts: texts.length,
    comparedExtractions: compared,
    dictionaryMatches,
    mismatches: mismatches.length,
  },
  regionParity: { cases: regionParity.cases, nativeAgreed: regionParity.nativeAgreed, nativeTrapped: regionParity.nativeTrapped, mismatches: regionParity.mismatches.length },
  fullExtractorMs: {
    note: "median of runs, each variant in a fresh process",
    original: round(fullOriginal),
    patched: round(fullPatched),
    speedup: round(fullOriginal / fullPatched),
    patchedTypeScriptOnly: round(fullTsMemoized),
    speedupTypeScriptOnly: round(fullOriginal / fullTsMemoized),
  },
  regionMs: regionMedians,
  gate: { ...gate, referenceRatio: round(referenceRatio), boundaryShare: round(boundaryShare) },
  nativeStatus: integration.nativeStatus,
  regionStatus: integration.regionStatus,
};
const output = join(repoRoot, "evaluation/crankts-v025-region-extraction.json");
mkdirSync(join(repoRoot, "evaluation"), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.error(`wrote ${output}`);
console.log(JSON.stringify({ intentweaveTests: result.intentweaveTests, differential: result.differential, regionParity: result.regionParity, fullExtractorMs: result.fullExtractorMs, regionMs: result.regionMs, gate: result.gate }, null, 2));
