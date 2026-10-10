#!/usr/bin/env node
// MVP-9b.1: export the real candidate-island graph that CrankTS feeds into WCC/Tarjan as a replay file.
// Nodes are in report order (file, line) and neighbor lists keep Set insertion order, so every
// replay of this file has one fixed traversal order; TS and native kernels see identical input.
// Usage: node evaluation/graph-native-poc/export-graph.mjs <target> [--workspace-references] --output <file>
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findWeaklyConnectedComponents } from "../../dist/analysis/islands.js";
import { analyzeProject } from "../../dist/index.js";

const argv = process.argv.slice(2);
const outputIndex = argv.indexOf("--output");
if (outputIndex < 0 || !argv[outputIndex + 1]) {
  throw new Error("--output <file> is required");
}
const output = resolve(argv[outputIndex + 1]);
const workspaceReferences = argv.includes("--workspace-references");
const target = resolve(argv.find((argument, index) => !argument.startsWith("-") && index !== outputIndex + 1) ?? ".");

const result = analyzeProject(target, workspaceReferences ? { workspaceReferences: true } : {});

// Mirrors the islands.adjacency stage of findCandidateIslands. analyzeProject returns only the
// scoped functions, which is exactly the scope findCandidateIslands filters to.
const candidates = result.functions.filter((fn) => fn.eligibility.kind !== "BLOCKED");
const indexById = new Map(candidates.map((fn, index) => [fn.id, index]));
const adjacency = candidates.map(() => new Set());
for (const [index, fn] of candidates.entries()) {
  for (const edge of fn.calls) {
    const targetIndex = edge.to === undefined ? undefined : indexById.get(edge.to);
    if (targetIndex === undefined) {
      continue;
    }
    adjacency[index].add(targetIndex);
    adjacency[targetIndex].add(index);
  }
}

// Fidelity check: WCC over the exported graph must reproduce the real islands' member lists.
const idAdjacency = new Map(candidates.map((fn, index) => [fn.id, new Set([...adjacency[index]].map((neighbor) => candidates[neighbor].id))]));
const replayComponents = findWeaklyConnectedComponents(candidates, idAdjacency, new Map(candidates.map((fn) => [fn.id, fn])))
  .map((members) => JSON.stringify(members)).sort();
const realComponents = result.candidateIslands.map((island) => JSON.stringify(island.members)).sort();
if (JSON.stringify(replayComponents) !== JSON.stringify(realComponents)) {
  throw new Error("replay graph does not reproduce the analyzed candidate islands");
}

const replay = {
  schemaVersion: 1,
  kind: "crankts-candidate-graph",
  source: {
    target: relative(process.cwd(), target) || ".",
    workspaceReferences,
    crankts: "dist/",
    typescript: result.typescript.version,
  },
  nodeCount: candidates.length,
  undirectedEdgeCount: adjacency.reduce((sum, neighbors, index) => (
    sum + [...neighbors].filter((neighbor) => neighbor >= index).length
  ), 0),
  candidateIslands: result.candidateIslands.length,
  fidelity: "WCC over this graph reproduces every candidate island's member list",
  nodes: candidates.map((fn) => [fn.id, fn.file, fn.line]),
  adjacency: adjacency.map((neighbors) => [...neighbors]),
};
writeFileSync(output, `${JSON.stringify(replay)}\n`);
console.error(`wrote ${output}: ${replay.nodeCount} nodes, ${replay.undirectedEdgeCount} undirected edges, ${replay.candidateIslands} islands`);
