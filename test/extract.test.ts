import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/index.js";
import { validateKernelContract, type KernelContract } from "../src/lowering/contract.js";
import { graphBatch } from "./fixtures/lowering/src/graph-kernel.js";
import { randomGraph } from "./helpers/kernel-inputs.js";

const fixtures = fileURLToPath(new URL("./fixtures/lowering/src", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function outDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "crankts-extract-"));
  temporaryDirectories.push(directory);
  return directory;
}

function cli(arguments_: readonly string[]): { readonly exitCode: number; readonly output: string; readonly error: string } {
  let output = "";
  let error = "";
  const logSpy = vi.spyOn(console, "log").mockImplementation((message) => {
    output += `${String(message)}\n`;
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
    error += `${String(message)}\n`;
  });
  try {
    return { exitCode: runCli(arguments_), output, error };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("crankts extract", () => {
  it("emits a GRAPH_BATCH crate with a lowerable contract", () => {
    const out = outDir();
    const result = cli([
      "extract", join(fixtures, "graph-kernel.ts#graphBatch"),
      "--shape", "GRAPH_BATCH", "--graph", "offsets,neighbors", "--out", out,
    ]);
    expect(result.exitCode, result.error).toBe(0);
    expect(result.output).toContain("contract is lowerable");
    for (const file of ["Cargo.toml", "src/lib.rs", "contract.json", "kernel.ir", "README.md", "ts/graphBatch.ts", "ts/parity.ts", "ts/benchmark.ts"]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8")) as KernelContract;
    expect(validateKernelContract(contract).lowerable).toBe(true);
    expect(readFileSync(join(out, "Cargo.toml"), "utf8")).toContain('name = "graph-batch-kernel"');
    const lib = readFileSync(join(out, "src/lib.rs"), "utf8");
    expect(lib).toContain('#[napi(js_name = "graphBatch")]');
    expect(lib).toContain("a_offsets: Uint32Array");
    expect(lib).toContain("sort_by(");
    expect(readFileSync(join(out, "kernel.ir"), "utf8")).toContain("sortByKeys members by fileRank, line");
  });

  it("emits a PREPARED_STATE crate with a native handle class", () => {
    const out = outDir();
    const result = cli([
      "extract", join(fixtures, "kwx-kernel.ts#scanAsciiTerms"),
      "--prepare", join(fixtures, "kwx-kernel.ts#prepareDictionary"),
      "--shape", "PREPARED_STATE", "--name", "kwx-scan", "--out", out,
    ]);
    expect(result.exitCode, result.error).toBe(0);
    expect(result.output).toContain("IMMUTABLE_DURING_HANDLE: PROVEN");
    const lib = readFileSync(join(out, "src/lib.rs"), "utf8");
    expect(lib).toContain('#[napi(js_name = "PreparedDictionary")]');
    expect(lib).toContain("a_dictionary: &H_PreparedDictionary");
    expect(lib).toContain("a_text: Utf16String");
    expect(lib).toContain("pub fn napi_prepareDictionary(a_terms: Vec<Utf16String>, a_minLength: f64)");
  });

  it("fails closed without writing anything when lowering or the contract fails", () => {
    const islands = outDir();
    const lowering = cli([
      "extract", join(repoRoot, "src/analysis/islands.ts#findWeaklyConnectedComponents"),
      "--shape", "PURE_BATCH", "--out", islands,
    ]);
    expect(lowering.exitCode).toBe(1);
    expect(lowering.error).toContain("failed closed at lower");
    expect(lowering.error).toContain("src/analysis/islands.ts:");
    expect(existsSync(join(islands, "Cargo.toml"))).toBe(false);

    const impure = outDir();
    const contract = cli(["extract", join(fixtures, "negative.ts#mutatesParameter"), "--shape", "PURE_BATCH", "--out", impure]);
    expect(contract.exitCode).toBe(1);
    expect(contract.error).toContain("failed closed at contract");
    expect(contract.error).toContain("PROOF_UNPROVEN");
    expect(existsSync(join(impure, "Cargo.toml"))).toBe(false);

    const shape = cli(["extract", join(fixtures, "graph-kernel.ts#graphBatch"), "--shape", "GRAPH_BATCH", "--out", outDir()]);
    expect(shape.exitCode).toBe(1);
    expect(shape.error).toContain("GRAPH_BATCH requires the CSR offsets/neighbors parameters");
  });

  it("generates a wrapper that falls back to the original when no addon is built", async () => {
    const generatedRoot = fileURLToPath(new URL("./.generated", import.meta.url));
    mkdirSync(generatedRoot, { recursive: true });
    const out = mkdtempSync(join(generatedRoot, "no-addon-"));
    temporaryDirectories.push(out);
    const result = cli([
      "extract", join(fixtures, "graph-kernel.ts#graphBatch"),
      "--shape", "GRAPH_BATCH", "--graph", "offsets,neighbors", "--name", "no-addon-graph", "--out", out,
    ]);
    expect(result.exitCode, result.error).toBe(0);
    const wrapperSource = readFileSync(join(out, "ts/graphBatch.ts"), "utf8");
    expect(wrapperSource).toContain('import { graphBatch as original_graphBatch } from "../../../fixtures/lowering/src/graph-kernel.js";');
    expect(wrapperSource).toContain("CRANKTS_ADDON_NO_ADDON_GRAPH");

    const wrapper = await import(pathToFileURL(join(out, "ts/graphBatch.ts")).href) as {
      graphBatch: typeof graphBatch;
      nativeStatus: { loaded: boolean; loadError?: string; nativeCalls: number };
    };
    expect(wrapper.nativeStatus.loaded).toBe(false);
    expect(wrapper.nativeStatus.loadError).toContain("no_addon_graph.node");
    const input = randomGraph(11);
    const args = [input.offsets, input.neighbors, input.fileRank, input.line] as const;
    expect(wrapper.graphBatch(...args)).toEqual(graphBatch(...args));
    expect(wrapper.nativeStatus.nativeCalls).toBe(0);

    const parity = await import(pathToFileURL(join(out, "ts/parity.ts")).href) as {
      runParity(options: { iterations: number }): { cases: number; nativeAvailable: boolean; mismatches: unknown[] };
    };
    const report = parity.runParity({ iterations: 200 }) as unknown as { byCategory: Record<string, { cases: number }> };
    expect(report).toMatchObject({ cases: 200, nativeAvailable: false, mismatches: [] });
    expect(Object.fromEntries(Object.entries(report.byCategory).map(([category, entry]) => [category, entry.cases])))
      .toEqual({ normal: 50, boundary: 50, strings: 50, trapDomain: 50 });
  });

  it("falls back only on traps and contract guards; internal errors surface", async () => {
    const generatedRoot = fileURLToPath(new URL("./.generated", import.meta.url));
    mkdirSync(generatedRoot, { recursive: true });
    const scenario = async (name: string, body: string) => {
      const out = mkdtempSync(join(generatedRoot, `${name}-`));
      temporaryDirectories.push(out);
      const result = cli([
        "extract", join(fixtures, "graph-kernel.ts#graphBatch"),
        "--shape", "GRAPH_BATCH", "--graph", "offsets,neighbors", "--name", name, "--out", out,
      ]);
      expect(result.exitCode, result.error).toBe(0);
      // A stand-in addon loaded through the documented override variable.
      const fake = join(out, "fake-addon.cjs");
      writeFileSync(fake, `exports.graphBatch = () => { ${body} };\nexports.__lastKernelNanos = () => 0;\n`);
      process.env[`CRANKTS_ADDON_${name.replace(/-/g, "_").toUpperCase()}`] = fake;
      return {
        wrapper: await import(pathToFileURL(join(out, "ts/graphBatch.ts")).href) as {
          graphBatch: typeof graphBatch;
          nativeStatus: { loaded: boolean; traps: number; contractGuards: number; internalErrors: number };
        },
        parity: await import(pathToFileURL(join(out, "ts/parity.ts")).href) as {
          runParity(options: { iterations: number }): { mismatches: { kind: string }[] };
        },
      };
    };
    const input = randomGraph(5);
    const args = [input.offsets, input.neighbors, input.fileRank, input.line] as const;

    const trapping = await scenario("fake-trap", `throw new Error("CRANKTS_KERNEL_TRAP: index");`);
    expect(trapping.wrapper.nativeStatus.loaded).toBe(true);
    expect(trapping.wrapper.graphBatch(...args)).toEqual(graphBatch(...args));
    expect(trapping.wrapper.nativeStatus).toMatchObject({ traps: 1, internalErrors: 0 });
    expect(trapping.parity.runParity({ iterations: 50 }).mismatches).toEqual([]);

    const broken = await scenario("fake-internal", `throw new Error("boom");`);
    expect(() => broken.wrapper.graphBatch(...args)).toThrow(/^CRANKTS_INTERNAL_ERROR in graphBatch: boom$/);
    expect(broken.wrapper.nativeStatus).toMatchObject({ traps: 0, internalErrors: 1 });
    // Codegen bugs cannot hide behind the fallback: parity reports them.
    expect(broken.parity.runParity({ iterations: 20 }).mismatches.some((mismatch) => mismatch.kind === "wrapper")).toBe(true);

    const guarded = await scenario("fake-guard", `throw new Error("must not be called");`);
    const outsideContract = [[0, 1], [0], [0], [1]] as unknown as Parameters<typeof graphBatch>;
    expect(guarded.wrapper.graphBatch(...outsideContract)).toEqual(graphBatch(...outsideContract));
    expect(guarded.wrapper.nativeStatus).toMatchObject({ contractGuards: 1, internalErrors: 0 });
  });

  it("emits integer-specialized Rust with typed outputs and reused loop buffers", () => {
    const out = outDir();
    expect(cli([
      "extract", join(fixtures, "graph-kernel.ts#graphBatch"),
      "--shape", "GRAPH_BATCH", "--graph", "offsets,neighbors", "--out", out,
    ]).exitCode).toBe(0);
    const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8")) as KernelContract;
    expect(contract.outputs[0]).toMatchObject({ type: { kind: "typedArray", element: "u32" } });
    const lib = readFileSync(join(out, "src/lib.rs"), "utf8");
    expect(lib).toContain("-> napi::Result<Uint32Array>");
    expect(lib).toContain("let mut l_visited: Vec<bool>");
    expect(lib).toContain("let mut l_discovery: Vec<i64>");
    expect(lib).toContain("let mut __buffer_members: Vec<i64> = Vec::new();");
    expect(lib).toContain("std::panic::catch_unwind");
    // Every index in the kernel is INT, so no f64 index conversion remains in its body.
    const kernel = lib.slice(lib.indexOf("fn f_graphBatch("), lib.indexOf('#[napi(js_name = "graphBatch")]'));
    expect(kernel).toContain("idx_i(");
    expect(kernel).not.toMatch(/\bidx\(/);

    const kwx = outDir();
    expect(cli([
      "extract", join(fixtures, "kwx-kernel.ts#scanAsciiTerms"),
      "--prepare", join(fixtures, "kwx-kernel.ts#prepareDictionary"),
      "--shape", "PREPARED_STATE", "--out", kwx,
    ]).exitCode).toBe(0);
    const kwxContract = JSON.parse(readFileSync(join(kwx, "contract.json"), "utf8")) as KernelContract;
    expect(kwxContract.outputs[0]).toMatchObject({ type: { kind: "typedArray", element: "f64" } });
    expect(readFileSync(join(kwx, "src/lib.rs"), "utf8")).toContain("pub f_headByLower: HashMap<Str, i64>,");
  });

  it("requires exported targets so the wrapper can fall back to them", () => {
    const result = cli(["extract", join(fixtures, "kwx-kernel.ts#isWordCode"), "--shape", "PURE_BATCH", "--out", outDir()]);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("isWordCode must be exported");
  });

  it("rejects malformed invocations with usage errors", () => {
    expect(cli(["extract", "file.ts#fn", "--shape", "REDUCTION", "--out", "x"]).exitCode).toBe(2);
    expect(cli(["extract", "--shape", "PURE_BATCH", "--out", "x"]).exitCode).toBe(2);
    expect(cli(["extract", "file.ts#fn", "--shape", "GRAPH_BATCH", "--graph", "offsets", "--out", "x"]).exitCode).toBe(2);
    const missing = cli(["extract", join(fixtures, "graph-kernel.ts#nope"), "--shape", "PURE_BATCH", "--out", outDir()]);
    expect(missing.exitCode).toBe(1);
    expect(missing.error).toContain("no function nope found");
  });
});
