// Seeded inputs and reference decoders shared by the Kernel IR and native backend tests.
import { findArticulationPoints, findWeaklyConnectedComponents } from "../../src/analysis/islands.js";
import type { FunctionAnalysis } from "../../src/analysis/model.js";

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export interface Graph {
  readonly offsets: Uint32Array;
  readonly neighbors: Uint32Array;
  readonly fileRank: Uint32Array;
  readonly line: Uint32Array;
  readonly adjacency: number[][];
}

export function toCsr(adjacency: number[][], next: () => number): Graph {
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

export function randomGraph(seed: number): Graph {
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

export function shapedGraphs(): Graph[] {
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
export function decodeGraph(output: number[], ids: string[]) {
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

export function islandsReference(graph: Graph) {
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

export function randomDictionary(seed: number): { terms: string[]; texts: string[] } {
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
