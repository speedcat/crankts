// Builds the Rust/N-API crates that `crankts extract` generates and checks the addons and the
// generated TypeScript wrappers against the original kernels. Needs cargo; runs locally when cargo is
// on PATH, in CI only with CRANKTS_NATIVE_TESTS=1 (the CI job stays Rust-free by default).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractKernel, type ExtractRequest } from "../src/lowering/extract.js";
import { graphBatch } from "./fixtures/lowering/src/graph-kernel.js";
import { prepareDictionary, scanAsciiTerms } from "./fixtures/lowering/src/kwx-kernel.js";
import { randomDictionary, randomGraph, shapedGraphs } from "./helpers/kernel-inputs.js";
import { compareExtractors, type ExtractorClass } from "./helpers/kwx-scenarios.js";
import { HeuristicKeywordExtractor } from "./fixtures/lowering/src/kwx-real/heuristicExtractor.js";

const fixtures = fileURLToPath(new URL("./fixtures/lowering/src", import.meta.url));
const generatedRoot = fileURLToPath(new URL("./.generated", import.meta.url));
const hasCargo = spawnSync("cargo", ["--version"]).status === 0;
const enabled = process.env.CRANKTS_NATIVE_TESTS === "1" || (hasCargo && !process.env.CI && process.env.CRANKTS_NATIVE_TESTS !== "0");
const libraryExtension = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
// Shared across runs so napi dependencies compile once.
const cargoTarget = join(tmpdir(), "crankts-native-test-target");
const crateDirectories: string[] = [];

type Fn = (...args: never[]) => unknown;
type Addon = Readonly<Record<string, Fn>>;

interface Built {
  readonly addon: Addon;
  readonly out: string;
}

interface ParityModule {
  runParity(options: { iterations?: number; seed?: number; cases?: readonly { args: readonly unknown[]; prepareArgs?: readonly unknown[] }[] }): {
    cases: number;
    nativeAvailable: boolean;
    nativeAgreed: number;
    nativeTrapped: number;
    mismatches: readonly unknown[];
  };
}

interface NativeStatus {
  loaded: boolean;
  nativeCalls: number;
  traps: number;
  contractGuards: number;
  internalErrors: number;
  foreignStates: number;
  observedStates: number;
}

function buildAddon(name: string, request: Omit<ExtractRequest, "outDir" | "crateName">): Built {
  mkdirSync(generatedRoot, { recursive: true });
  const out = mkdtempSync(join(generatedRoot, `${name}-`));
  crateDirectories.push(out);
  const result = extractKernel({ ...request, outDir: out, crateName: name });
  if (!result.ok) {
    throw new Error(`extract ${name} failed at ${result.stage}: ${result.messages.join("\n")}`);
  }
  const build = spawnSync("cargo", ["build", "--quiet"], {
    cwd: out,
    encoding: "utf8",
    env: { ...process.env, CARGO_TARGET_DIR: cargoTarget },
  });
  if (build.status !== 0) {
    throw new Error(`cargo build ${name} failed:\n${build.stderr}`);
  }
  const library = name.replace(/-/g, "_");
  // Where the generated wrapper looks by default: <out>/<library>.node.
  const addonPath = join(out, `${library}.node`);
  copyFileSync(join(cargoTarget, "debug", `${process.platform === "win32" ? "" : "lib"}${library}.${libraryExtension}`), addonPath);
  return { addon: createRequire(import.meta.url)(addonPath) as Addon, out };
}

async function importGenerated<T>(out: string, file: string): Promise<T> {
  return await import(pathToFileURL(join(out, "ts", file)).href) as T;
}

function call(fn: Fn | undefined, ...args: unknown[]): unknown {
  if (!fn) {
    throw new Error("missing function");
  }
  return fn(...(args as never[]));
}

function trapMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no trap";
}

describe.skipIf(!enabled)("generated Rust/N-API kernels", () => {
  let graph: Built;
  let kwx: Built;
  let lowersCase: Built;
  let spins: Built;
  let region: Built;

  beforeAll(() => {
    graph = buildAddon("graph-batch-test", {
      target: join(fixtures, "graph-kernel.ts#graphBatch"),
      shape: "GRAPH_BATCH",
      graph: { offsets: "offsets", neighbors: "neighbors", direction: "directed" },
    });
    kwx = buildAddon("kwx-scan-test", {
      target: join(fixtures, "kwx-kernel.ts#scanAsciiTerms"),
      prepare: join(fixtures, "kwx-kernel.ts#prepareDictionary"),
      shape: "PREPARED_STATE",
    });
    lowersCase = buildAddon("lowers-case-test", { target: join(fixtures, "negative.ts#lowersCase"), shape: "PURE_BATCH" });
    spins = buildAddon("spins-test", { target: join(fixtures, "negative.ts#spins"), shape: "PURE_BATCH" });
    region = buildAddon("kwx-region-test", {
      target: join(fixtures, "kwx-real/heuristicExtractor.ts#HeuristicKeywordExtractor.extractDictionary"),
      shape: "PREPARED_STATE",
      region: { execute: { startLine: 334, endLine: 369 }, prepare: { startLine: 312, endLine: 324 } },
    });
  }, 600_000);

  afterAll(() => {
    for (const directory of crateDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("matches the TypeScript graph kernel on shaped and random graphs", () => {
    const graphs = [...shapedGraphs(), ...Array.from({ length: 200 }, (_, seed) => randomGraph(seed + 1))];
    for (const input of graphs) {
      const args = [input.offsets, input.neighbors, input.fileRank, input.line] as const;
      const native = call(graph.addon.graphBatch, ...args);
      // The contract declares a typed output: non-negative INT elements cross as Uint32Array.
      expect(native).toBeInstanceOf(Uint32Array);
      expect(Array.from(native as Uint32Array)).toEqual(graphBatch(...args));
    }
  });

  it("matches the TypeScript KWX kernel through a native handle, including lone surrogates", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const { terms, texts } = randomDictionary(seed);
      const minLength = seed % 4;
      const handle = call(kwx.addon.prepareDictionary, terms, minLength);
      const state = prepareDictionary(terms, minLength);
      for (const text of [...texts, `${texts[0] ?? ""}\uD800Graph\uDC00node_1`]) {
        // INT but not provably non-negative (firstOffset starts at -1): Float64Array.
        expect(Array.from(call(kwx.addon.scanAsciiTerms, text, handle) as Float64Array)).toEqual(scanAsciiTerms(text, state));
      }
    }
  });

  it("traps exactly where the Kernel IR interpreter traps", () => {
    const malformed = [Uint32Array.from([0, 1]), Uint32Array.from([5]), Uint32Array.from([0]), Uint32Array.from([1])];
    expect(trapMessage(() => call(graph.addon.graphBatch, ...malformed))).toMatch(/^CRANKTS_KERNEL_TRAP: /);
    expect(trapMessage(() => call(lowersCase.addon.lowersCase, "Straße"))).toContain("non-ASCII");
    expect(call(lowersCase.addon.lowersCase, "ABC_1")).toBe("abc_1");

    call(spins.addon.__setIterationBudget, 10);
    expect(trapMessage(() => call(spins.addon.spins, 1000))).toContain("iteration budget exhausted");
    call(spins.addon.__setIterationBudget, Number.POSITIVE_INFINITY);
    expect(call(spins.addon.spins, 1000)).toBe(1000);
  });

  it("wraps GRAPH_BATCH natively and falls back to TypeScript on traps", async () => {
    const wrapper = await importGenerated<{ graphBatch: typeof graphBatch; nativeStatus: NativeStatus }>(graph.out, "graphBatch.ts");
    expect(wrapper.nativeStatus.loaded).toBe(true);
    const input = randomGraph(7);
    const args = [input.offsets, input.neighbors, input.fileRank, input.line] as const;
    expect(wrapper.graphBatch(...args)).toEqual(graphBatch(...args));
    expect(wrapper.nativeStatus.nativeCalls).toBe(1);

    // Malformed CSR: the addon traps, the wrapper returns whatever the original TypeScript returns.
    const malformed = [Uint32Array.from([0, 1]), Uint32Array.from([5]), Uint32Array.from([0]), Uint32Array.from([1])] as const;
    expect(wrapper.graphBatch(...malformed)).toEqual(graphBatch(...malformed));
    expect(wrapper.nativeStatus.traps).toBe(1);
    // Arguments outside the contract (plain arrays instead of Uint32Array) are caught by the
    // TypeScript contract guard before the addon is called; the original decides.
    const wrongTypes = [[0, 1], [0], [0], [1]] as unknown as Parameters<typeof graphBatch>;
    expect(wrapper.graphBatch(...wrongTypes)).toEqual(graphBatch(...wrongTypes));
    expect(wrapper.nativeStatus).toMatchObject({ contractGuards: 1, internalErrors: 0 });
    // The wrapper returns the original's representation (number[]), not the typed output.
    expect(Array.isArray(wrapper.graphBatch(...args))).toBe(true);
  });

  it("wraps PREPARED_STATE with a lazily materialized state that downgrades to TypeScript once observed", async () => {
    const wrapper = await importGenerated<{
      prepareDictionary: typeof prepareDictionary;
      scanAsciiTerms: typeof scanAsciiTerms;
      nativeStatus: NativeStatus;
    }>(kwx.out, "scanAsciiTerms.ts");
    const terms = ["Graph", "node_1", "KWX", "kwx"];
    const text = "graph and KWX and node_1 again";
    const state = wrapper.prepareDictionary(terms, 3);
    terms.push("again"); // prepare snapshots its inputs, like the original
    expect(wrapper.scanAsciiTerms(text, state)).toEqual(scanAsciiTerms(text, prepareDictionary(terms.slice(0, 4), 3)));
    expect(wrapper.nativeStatus).toMatchObject({ nativeCalls: 2, observedStates: 0 });

    // Reading a field materializes the TypeScript state; the caller may now mutate it.
    expect(state).toEqual(prepareDictionary(terms.slice(0, 4), 3));
    state.headByLower.set("again", 3);
    const reference = prepareDictionary(terms.slice(0, 4), 3);
    reference.headByLower.set("again", 3);
    expect(wrapper.scanAsciiTerms(text, state)).toEqual(scanAsciiTerms(text, reference));
    expect(wrapper.nativeStatus.observedStates).toBe(1);

    // States the wrapper did not create always run in TypeScript.
    expect(wrapper.scanAsciiTerms(text, reference)).toEqual(scanAsciiTerms(text, reference));
    expect(wrapper.nativeStatus.foreignStates).toBe(1);
  });

  it("runs the generated benchmark and evaluates the acceptance gate", async () => {
    const benchmark = await importGenerated<{
      runBenchmark(options: Record<string, unknown>): {
        gate: Record<string, string>;
        accepted: boolean;
        kernelMs: { median: number };
        nativeCallMs: { median: number };
        parity: { mismatches: number };
      };
    }>(graph.out, "benchmark.ts");
    const input = randomGraph(42);
    const report = benchmark.runBenchmark({
      cases: [{ calls: [[input.offsets, input.neighbors, input.fileRank, input.line]] }],
      runs: 3,
      reference: { graphBatch: (...args: unknown[]) => graphBatch(...(args as Parameters<typeof graphBatch>)) },
      parityIterations: 50,
    });
    expect(Object.keys(report.gate).sort()).toEqual(["backendQuality", "boundary", "correctness", "performance"]);
    expect(report.gate.correctness).toBe("PASS");
    expect(report.parity.mismatches).toBe(0);
    expect(report.kernelMs.median).toBeLessThanOrEqual(report.nativeCallMs.median);
    // Tiny debug-build inputs prove nothing about speed; the gate verdicts are only shape-checked here.
    expect(["PASS", "FAIL"]).toContain(report.gate.performance);
  });

  it("runs the real extractDictionary regions natively with identical extractor output", async () => {
    const patched = await importGenerated<{ HeuristicKeywordExtractor: ExtractorClass }>(region.out, "heuristicExtractor.crankts.ts");
    const integration = await importGenerated<{
      nativeStatus: NativeStatus;
      regionStatus: { preparations: number; cacheHits: number };
    }>(region.out, "integration.ts");
    const comparison = compareExtractors(HeuristicKeywordExtractor as unknown as ExtractorClass, patched.HeuristicKeywordExtractor, 60);
    expect(comparison.mismatches).toEqual([]);
    expect(integration.nativeStatus).toMatchObject({ loaded: true, traps: 0, contractGuards: 0, internalErrors: 0 });
    expect(integration.nativeStatus.nativeCalls).toBeGreaterThan(300);
    expect(integration.regionStatus.cacheHits).toBeGreaterThan(0);

    const parity = await importGenerated<{
      runRegionParity(options: { iterations: number }): { nativeAvailable: boolean; nativeAgreed: number; mismatches: string[] };
    }>(region.out, "parity.ts");
    const report = parity.runRegionParity({ iterations: 1000 });
    expect(report).toMatchObject({ nativeAvailable: true, mismatches: [] });
    expect(report.nativeAgreed).toBe(1000);
  });

  it("runs the generated parity runner with fuzzed and supplied cases", async () => {
    const graphParity = await importGenerated<ParityModule>(graph.out, "parity.ts");
    const cases = Array.from({ length: 100 }, (_, seed) => {
      const input = randomGraph(seed + 1000);
      return { args: [input.offsets, input.neighbors, input.fileRank, input.line] };
    });
    const graphReport = graphParity.runParity({ iterations: 500, seed: 3, cases });
    expect(graphReport).toMatchObject({ cases: 600, nativeAvailable: true, mismatches: [] });
    // Fuzzed CSR is mostly malformed and traps; the supplied cases must all run natively.
    expect(graphReport.nativeAgreed).toBeGreaterThanOrEqual(100);

    const kwxParity = await importGenerated<ParityModule>(kwx.out, "parity.ts");
    const kwxReport = kwxParity.runParity({ iterations: 1000, seed: 5 });
    expect(kwxReport).toMatchObject({ cases: 1000, nativeAvailable: true, mismatches: [] });
    expect(kwxReport.nativeAgreed).toBe(1000);
  });
});
