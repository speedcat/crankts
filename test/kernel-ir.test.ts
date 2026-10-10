import { fileURLToPath } from "node:url";
import type * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { collectFunctions } from "../src/analysis/functions.js";
import { findArticulationPoints, findWeaklyConnectedComponents } from "../src/analysis/islands.js";
import type { FunctionAnalysis } from "../src/analysis/model.js";
import { createCompilerFacade, type CompilerFacade } from "../src/compiler/compiler-facade.js";
import { validateKernelContract } from "../src/lowering/contract.js";
import { deriveKernelContract } from "../src/lowering/derive-contract.js";
import { interpretIr, KernelTrap } from "../src/lowering/interpret.js";
import type { IrModule, IrStmt } from "../src/lowering/ir.js";
import { printIrModule } from "../src/lowering/ir.js";
import { lowerKernel } from "../src/lowering/lower.js";
import { verifyIrModule, walkStatements } from "../src/lowering/verify.js";
import { graphBatch } from "./fixtures/lowering/src/graph-kernel.js";
import { prepareDictionary, scanAsciiTerms } from "./fixtures/lowering/src/kwx-kernel.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/lowering", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const facades = new Map<string, CompilerFacade>();

function declaration(root: string, file: string, name: string): { node: ts.FunctionDeclaration; facade: CompilerFacade } {
  let facade = facades.get(root);
  if (!facade) {
    facade = createCompilerFacade(root);
    facades.set(root, facade);
  }
  const definition = collectFunctions(facade).definitions.find((candidate) => candidate.file === file && candidate.name === name);
  if (!definition || !facade.typescript.isFunctionDeclaration(definition.node)) {
    throw new Error(`Expected function declaration ${file}#${name}.`);
  }
  return { node: definition.node, facade: definition.compilerFacade };
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

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Graph {
  readonly offsets: Uint32Array;
  readonly neighbors: Uint32Array;
  readonly fileRank: Uint32Array;
  readonly line: Uint32Array;
  readonly adjacency: number[][];
}

function toCsr(adjacency: number[][], next: () => number): Graph {
  const offsets = new Uint32Array(adjacency.length + 1);
  adjacency.forEach((list, index) => {
    offsets[index + 1] = (offsets[index] ?? 0) + list.length;
  });
  const neighbors = Uint32Array.from(adjacency.flat());
  // Few distinct files and lines, so (fileRank, line) ties exercise sort stability.
  const fileRank = Uint32Array.from(adjacency.map(() => Math.floor(next() * 3)));
  const line = Uint32Array.from(adjacency.map(() => 1 + Math.floor(next() * 4)));
  return { offsets, neighbors, fileRank, line, adjacency };
}

function randomGraph(seed: number): Graph {
  const next = random(seed);
  const nodeCount = Math.floor(next() * 40);
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  const edgeCount = Math.floor(next() * nodeCount * 1.5);
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const left = Math.floor(next() * nodeCount);
    const right = Math.floor(next() * nodeCount);
    // Undirected, deduplicated, insertion-ordered, self-loops allowed: like findCandidateIslands.
    if (!adjacency[left]?.includes(right)) {
      adjacency[left]?.push(right);
      if (left !== right) {
        adjacency[right]?.push(left);
      }
    }
  }
  return toCsr(adjacency, next);
}

function shapedGraphs(): Graph[] {
  const next = random(7);
  const undirected = (nodeCount: number, edges: Array<[number, number]>): Graph => {
    const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
    for (const [left, right] of edges) {
      adjacency[left]?.push(right);
      adjacency[right]?.push(left);
    }
    return toCsr(adjacency, next);
  };
  return [
    undirected(0, []),
    undirected(1, []),
    undirected(3, [[0, 1], [1, 2]]),
    undirected(3, [[0, 1], [1, 2], [2, 0]]),
    undirected(5, [[0, 1], [0, 2], [0, 3], [0, 4]]),
    undirected(7, [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 5], [5, 3], [5, 6]]),
  ];
}

/** Decodes the flat kernel output into the shape islands.ts produces, using its tie-break. */
function decodeGraph(output: number[], ids: string[]) {
  const components = [];
  let position = 1;
  for (let component = 0; component < (output[0] ?? 0); component += 1) {
    const memberCount = output[position++] ?? 0;
    const members = output.slice(position, position + memberCount).map((member) => ids[member] ?? "");
    position += memberCount;
    const articulationCount = output[position++] ?? 0;
    const tieCount = output[position++] ?? 0;
    let largestImpact: { functionId: string; impact: number; componentsAfterRemoval: number; largestRemainingPart: number } | null = null;
    for (let tie = 0; tie < tieCount; tie += 1) {
      const candidate = {
        functionId: ids[output[position] ?? 0] ?? "",
        impact: output[position + 1] ?? 0,
        componentsAfterRemoval: output[position + 2] ?? 0,
        largestRemainingPart: output[position + 3] ?? 0,
      };
      position += 4;
      if (!largestImpact || candidate.functionId.localeCompare(largestImpact.functionId) < 0) {
        largestImpact = candidate;
      }
    }
    components.push({ members, articulationCount, largestImpact });
  }
  return components;
}

function islandsReference(graph: Graph) {
  const ids = graph.adjacency.map((_, index) => `n${String(index).padStart(3, "0")}`);
  const candidates = ids.map((id, index) => ({
    id,
    file: `file${graph.fileRank[index] ?? 0}.ts`,
    line: graph.line[index] ?? 0,
  })) as unknown as FunctionAnalysis[];
  const adjacency = new Map(ids.map((id, index) => [id, new Set((graph.adjacency[index] ?? []).map((neighbor) => ids[neighbor] ?? ""))]));
  const functionById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const components = findWeaklyConnectedComponents(candidates, adjacency, functionById).map((members) => {
    const articulation = findArticulationPoints(members, adjacency);
    return { members, articulationCount: articulation.count, largestImpact: articulation.largestImpact };
  });
  return { ids, components };
}

function randomDictionary(seed: number): { terms: string[]; texts: string[] } {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const syllables = ["ax", "Graph", "node", "KWX", "_id", "42", "Map", "set", "scan", "Tarjan"];
  const word = (): string => Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(syllables)).join("");
  const terms = Array.from({ length: 5 + Math.floor(next() * 25) }, () => pick([
    word, word, word,
    () => word().toUpperCase(),
    () => `${word()} ${word()}`,
    () => `${word()}é`,
    () => "ab",
  ])());
  const texts = Array.from({ length: 8 }, () => Array.from({ length: Math.floor(next() * 40) }, () => pick([
    word, word, () => pick(terms), () => pick(terms).toLowerCase(),
    () => " ", () => ". ", () => "é", () => "😀", () => "\n", () => "-",
  ])()).join(""));
  return { terms, texts };
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
        { name: "headByLower", type: { kind: "map" } },
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
      expect.stringContaining("maps are lowered only as Map<string, number>"),
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
