import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectFunctions } from "../src/analysis/functions.js";
import { createCompilerFacade, type CompilerFacade } from "../src/compiler/compiler-facade.js";
import { validateKernelContract } from "../src/lowering/contract.js";
import { deriveKernelContract } from "../src/lowering/derive-contract.js";
import { interpretIr, KernelTrap } from "../src/lowering/interpret.js";
import type { IrModule, IrStmt } from "../src/lowering/ir.js";
import { mergeModules, printIrModule } from "../src/lowering/ir.js";
import { analyzeIntegers } from "../src/lowering/integer-analysis.js";
import { kernelFunctionOf, lowerKernel, type KernelFunction } from "../src/lowering/lower.js";
import { verifyIrModule, walkStatements } from "../src/lowering/verify.js";
import { graphBatch } from "./fixtures/lowering/src/graph-kernel.js";
import { prepareDictionary, scanAsciiTerms } from "./fixtures/lowering/src/kwx-kernel.js";
import { decodeGraph, islandsReference, randomDictionary, randomGraph, shapedGraphs } from "./helpers/kernel-inputs.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/lowering", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const facades = new Map<string, CompilerFacade>();

function declaration(root: string, file: string, name: string): { node: KernelFunction; facade: CompilerFacade } {
  let facade = facades.get(root);
  if (!facade) {
    facade = createCompilerFacade(root);
    facades.set(root, facade);
  }
  const definition = collectFunctions(facade).definitions.find((candidate) => candidate.file === file && candidate.name === name);
  const node = definition ? kernelFunctionOf(facade.typescript, definition.node) : undefined;
  if (!definition || !node) {
    throw new Error(`Expected a kernel function ${file}#${name}.`);
  }
  return { node, facade: definition.compilerFacade };
}

function lower(file: string, name: string, root = fixtureRoot) {
  const { node, facade } = declaration(root, file, name);
  return lowerKernel(node, facade, { projectRoot: root });
}

function lowered(file: string, name: string): IrModule {
  const result = lower(file, name);
  if (!result.ok) {
    throw new Error(`lowering ${name} failed: ${JSON.stringify(result.diagnostics, null, 2)}`);
  }
  return result.module;
}

function statements(module: IrModule): IrStmt[] {
  const all: IrStmt[] = [];
  for (const fn of module.functions) {
    walkStatements(fn.body, (statement) => all.push(statement), () => undefined);
  }
  return all;
}

describe("Kernel IR lowering", () => {
  it("lowers the kernel-style graph and KWX kernels including helper callees and structs", () => {
    const graph = lowered("src/graph-kernel.ts", "graphBatch");
    expect(graph.functions.map((fn) => fn.name)).toEqual(["graphBatch"]);
    expect(statements(graph)).toContainEqual(expect.objectContaining({ stmt: "sortByKeys", keys: [expect.anything(), expect.anything()] }));

    const prepare = lowered("src/kwx-kernel.ts", "prepareDictionary");
    expect(prepare.functions.map((fn) => fn.name)).toEqual(["isWordCode", "isSimpleTerm", "prepareDictionary"]);
    expect(prepare.structs).toEqual([{
      name: "PreparedDictionary",
      fields: [
        { name: "termCount", type: { kind: "f64" } },
        { name: "headByLower", type: { kind: "map", value: { kind: "f64" } } },
        { name: "next", type: { kind: "array", element: { kind: "f64" }, storage: "dynamic" } },
      ],
    }]);
    const scan = lowered("src/kwx-kernel.ts", "scanAsciiTerms");
    expect(printIrModule(scan)).toContain("mapGetOr(dictionary.headByLower, toLowerAscii(slice(text, start, index)), -1)");
  });

  it("fails closed with positioned diagnostics on real, unrefactored code", () => {
    const islands = lower("src/analysis/islands.ts", "findWeaklyConnectedComponents", repoRoot);
    expect(islands.ok).toBe(false);
    const messages = islands.ok ? [] : islands.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining("sets are not lowered"),
      expect.stringContaining("map value sets are not lowered"),
    ]));
    expect(islands.ok ? [] : islands.diagnostics.every((diagnostic) => diagnostic.file === "src/analysis/islands.ts" && diagnostic.line > 0))
      .toBe(true);

    const extract = lower("src/kernels.ts", "extractDictionary");
    expect(extract.ok ? [] : extract.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("functions cannot be lowered as values"),
    ]));
    const truthiness = lower("src/negative.ts", "truthiness");
    expect(truthiness.ok ? [] : truthiness.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining("no truthiness coercion"),
    ]);
  });
});

describe("lowering arrow functions and methods (v0.2.6d)", () => {
  const file = "src/arrow-kernels.ts";

  it("lowers const arrow functions, function expressions, and their calls", () => {
    const module = lowered(file, "sumOfSquares");
    expect(module.functions.map((fn) => fn.name)).toEqual(["square", "sumOfSquares"]);
    expect(interpretIr(module, [[1, 2, 3]])).toBe(14);
    expect(interpretIr(lowered(file, "countAbove"), [[1, 5, 9], 4])).toBe(2);
  });

  it("lowers methods without this and rejects methods that use it", () => {
    expect(interpretIr(lowered(file, "Stats.total"), [[1, 2, 3]])).toBe(6);
    const scaled = lower(file, "Stats.scaled");
    expect(scaled.ok ? [] : scaled.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["methods that use `this` or `super` are not lowered"]);
  });

  it("still rejects arrow functions that capture outer locals", () => {
    const result = lower(file, "scaleAll");
    expect(result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("factor is not a parameter or local of the lowered function"),
    ]));
  });
});

describe("Kernel IR verification", () => {
  it("proves purity, aliasing, and order for both kernels and guards the rest", () => {
    const byKind = (module: IrModule) => Object.fromEntries(verifyIrModule(module).obligations.map((obligation) => [obligation.kind, obligation.status]));
    expect(verifyIrModule(lowered("src/graph-kernel.ts", "graphBatch")).valid).toBe(true);
    expect(byKind(lowered("src/graph-kernel.ts", "graphBatch"))).toEqual({
      PURE: "PROVEN",
      NO_ALIASING: "PROVEN",
      DETERMINISTIC_ORDER: "PROVEN",
      TERMINATION: "GUARDED",
      INTEGER_RANGE: "GUARDED",
      STRING_SEMANTICS: "PROVEN",
    });
    expect(byKind(lowered("src/kwx-kernel.ts", "prepareDictionary"))).toMatchObject({ TERMINATION: "PROVEN", STRING_SEMANTICS: "GUARDED" });
    expect(byKind(lowered("src/kwx-kernel.ts", "scanAsciiTerms"))).toMatchObject({ PURE: "PROVEN", TERMINATION: "GUARDED" });
  });

  it("rejects parameter mutation, aliasing, recursion, and non-invariant loop bounds", () => {
    const status = (name: string, kind: string) => verifyIrModule(lowered("src/negative.ts", name)).obligations
      .find((obligation) => obligation.kind === kind)?.status;
    expect(status("mutatesParameter", "PURE")).toBe("UNPROVEN");
    expect(status("aliasesFresh", "NO_ALIASING")).toBe("UNPROVEN");
    expect(status("storesFresh", "NO_ALIASING")).toBe("UNPROVEN");
    const recursive = verifyIrModule(lowered("src/negative.ts", "recursive"));
    expect(recursive.valid).toBe(false);
    expect(recursive.obligations.find((obligation) => obligation.kind === "TERMINATION")?.status).toBe("UNPROVEN");
    const growing = verifyIrModule(lowered("src/negative.ts", "growsWhileIterating"));
    expect(growing.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining("bound reads copy, which the body mutates") }));
  });
});

describe("integer specialization analysis", () => {
  it("proves the graph kernel integer-only with a non-negative output", () => {
    const module = lowered("src/graph-kernel.ts", "graphBatch");
    const integers = analyzeIntegers(module);
    for (const name of ["nodeCount", "componentCount", "clock", "node", "slot", "impact"]) {
      expect(integers.localInt("graphBatch", name), name).toBe(true);
    }
    for (const array of ["discovery", "low", "parent", "members", "pending", "output"]) {
      expect(integers.localElementsInt("graphBatch", array), array).toBe(true);
    }
    expect(integers.localNonneg("graphBatch", "nodeParent")).toBe(false);
    expect(integers.returnElementsInt("graphBatch")).toBe(true);
    expect(integers.returnElementsNonneg("graphBatch")).toBe(true);
  });

  it("specializes the KWX state across prepare and execute, but not JS-supplied parameters", () => {
    const merged = mergeModules(lowered("src/kwx-kernel.ts", "scanAsciiTerms"), lowered("src/kwx-kernel.ts", "prepareDictionary"));
    const integers = analyzeIntegers(merged, ["scanAsciiTerms", "prepareDictionary"]);
    expect(integers.fieldInt("PreparedDictionary", "termCount")).toBe(true);
    expect(integers.fieldElementsInt("PreparedDictionary", "headByLower")).toBe(true);
    expect(integers.fieldElementsInt("PreparedDictionary", "next")).toBe(true);
    expect(integers.localInt("prepareDictionary", "minLength")).toBe(false);
    expect(integers.localInt("isWordCode", "code")).toBe(true);
    // firstOffset starts at -1, so the output is INT but not provably non-negative.
    expect(integers.returnElementsInt("scanAsciiTerms")).toBe(true);
    expect(integers.returnElementsNonneg("scanAsciiTerms")).toBe(false);
  });

  it("keeps multiplication, -0, and values derived from parameters f64", () => {
    const integers = analyzeIntegers(lowered("src/negative.ts", "mixedNumbers"));
    expect(integers.localInt("mixedNumbers", "count")).toBe(true);
    expect(integers.localInt("mixedNumbers", "index")).toBe(true);
    expect(integers.localInt("mixedNumbers", "negativeZero")).toBe(false);
    expect(integers.localInt("mixedNumbers", "scale")).toBe(false);
    expect(integers.localInt("mixedNumbers", "scaled")).toBe(false);
    expect(integers.localElementsInt("mixedNumbers", "out")).toBe(false);
    expect(integers.localElementsInt("mixedNumbers", "values")).toBe(false);
  });
});

describe("Kernel contract derivation", () => {
  it("derives a lowerable GRAPH_BATCH contract for the graph kernel", () => {
    const derived = deriveKernelContract({
      name: "graph-batch",
      shape: "GRAPH_BATCH",
      execute: lowered("src/graph-kernel.ts", "graphBatch"),
      graph: { offsets: "offsets", neighbors: "neighbors", direction: "directed" },
    });
    if (!derived.ok) throw new Error(JSON.stringify(derived.errors));
    expect(derived.contract.inputs.map((input) => [input.name, input.type.kind, input.packing])).toEqual([
      ["graph", "packedGraph", "UPSTREAM"],
      ["fileRank", "typedArray", "UPSTREAM"],
      ["line", "typedArray", "UPSTREAM"],
    ]);
    expect(validateKernelContract(derived.contract)).toEqual({ lowerable: true, diagnostics: [] });
  });

  it("derives a lowerable PREPARED_STATE contract with a proven immutable handle for KWX", () => {
    const derived = deriveKernelContract({
      name: "kwx-scan",
      shape: "PREPARED_STATE",
      prepare: lowered("src/kwx-kernel.ts", "prepareDictionary"),
      execute: lowered("src/kwx-kernel.ts", "scanAsciiTerms"),
    });
    if (!derived.ok) throw new Error(JSON.stringify(derived.errors));
    expect(derived.contract.state).toMatchObject({ name: "PreparedDictionary", invalidation: "PROVEN_IMMUTABLE" });
    expect(derived.contract.inputs.map((input) => input.type.kind)).toEqual(["string", "handle"]);
    expect(derived.contract.proofObligations).toContainEqual(expect.objectContaining({ kind: "IMMUTABLE_DURING_HANDLE", status: "PROVEN" }));
    expect(validateKernelContract(derived.contract)).toEqual({ lowerable: true, diagnostics: [] });
  });

  it("refuses contracts for kernels that mutate their inputs", () => {
    const derived = deriveKernelContract({ name: "bad", shape: "PURE_BATCH", execute: lowered("src/negative.ts", "mutatesParameter") });
    if (!derived.ok) throw new Error(JSON.stringify(derived.errors));
    expect(validateKernelContract(derived.contract).diagnostics).toContainEqual(expect.objectContaining({ code: "PROOF_UNPROVEN" }));
  });
});

describe("Kernel IR interpreter parity", () => {
  it("matches the TypeScript graph kernel and islands.ts on shaped and random graphs", () => {
    const module = lowered("src/graph-kernel.ts", "graphBatch");
    const graphs = [...shapedGraphs(), ...Array.from({ length: 200 }, (_, seed) => randomGraph(seed + 1))];
    let articulationComponents = 0;
    for (const graph of graphs) {
      const args = [graph.offsets, graph.neighbors, graph.fileRank, graph.line] as const;
      const typescript = graphBatch(...args);
      expect(interpretIr(module, args)).toEqual(typescript);
      const reference = islandsReference(graph);
      const decoded = decodeGraph(typescript, reference.ids);
      expect(decoded).toEqual(reference.components);
      articulationComponents += decoded.filter((component) => component.articulationCount > 0).length;
    }
    expect(articulationComponents).toBeGreaterThan(50);
  });

  it("matches the TypeScript KWX kernel, including astral and non-ASCII text", () => {
    const prepare = lowered("src/kwx-kernel.ts", "prepareDictionary");
    const scan = lowered("src/kwx-kernel.ts", "scanAsciiTerms");
    let matchCount = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const { terms, texts } = randomDictionary(seed);
      const minLength = seed % 4;
      const typescriptState = prepareDictionary(terms, minLength);
      const irState = interpretIr(prepare, [terms, minLength]) as ReturnType<typeof prepareDictionary>;
      expect(irState).toEqual(typescriptState);
      for (const text of texts) {
        const expected = scanAsciiTerms(text, typescriptState);
        expect(interpretIr(scan, [text, irState])).toEqual(expected);
        matchCount += expected.length / 3;
      }
    }
    expect(matchCount).toBeGreaterThan(500);
  });

  it("traps instead of emulating JS edge cases, so the TypeScript fallback decides", () => {
    const graph = lowered("src/graph-kernel.ts", "graphBatch");
    // Malformed CSR: neighbor index out of range. TypeScript reads undefined; the IR traps.
    const malformed = [Uint32Array.from([0, 1]), Uint32Array.from([5]), Uint32Array.from([0]), Uint32Array.from([1])];
    expect(() => interpretIr(graph, malformed)).toThrow(KernelTrap);
    expect(() => interpretIr(lowered("src/negative.ts", "lowersCase"), ["Straße"])).toThrow(/non-ASCII/);
    expect(interpretIr(lowered("src/negative.ts", "lowersCase"), ["ABC_1"])).toBe("abc_1");
    expect(() => interpretIr(lowered("src/negative.ts", "spins"), [1000], { iterationBudget: 10 })).toThrow(/budget/);
    expect(interpretIr(lowered("src/negative.ts", "spins"), [1000])).toBe(1000);
  });
});
