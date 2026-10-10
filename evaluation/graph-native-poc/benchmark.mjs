#!/usr/bin/env node
// MVP-9b GRAPH_BATCH crossover benchmark: CrankTS's TypeScript WCC/Tarjan vs. the N-API kernel on
// the real candidate graph replayed at increasing scale. Each (topology, scale, implementation)
// runs in its own child process (fresh JIT/heap, separate peak RSS); parity is an exact hash match.
// Usage:
//   node --expose-gc evaluation/graph-native-poc/benchmark.mjs --graph <replay.json>[,<replay.json>...] --addon <file.node> \
//     [--scales 1,2,5,10,25,50,100] [--base-scales 1] [--topologies replicate,bridged] [--runs 5] [--output <file>]
// --scales applies to the first graph; --base-scales (fractions allowed) to every further graph.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findArticulationPoints, findWeaklyConnectedComponents } from "../../dist/analysis/islands.js";

const options = parseArguments(process.argv.slice(2));
if (options.child) {
  process.stdout.write(JSON.stringify(runChild(options)));
} else {
  runDriver(options);
}

function runDriver({ graphs, addon, scales, baseScales, topologies, runs, output }) {
  const replays = graphs.map((graph) => ({ graph, replay: JSON.parse(readFileSync(graph, "utf8")) }));
  const measurements = [];
  for (const topology of topologies) {
    for (const [graphIndex, { graph, replay }] of replays.entries()) {
      // Only the first (largest) graph is scaled; additional graphs cover sizes below it.
      for (const scale of graphIndex === 0 ? scales : baseScales) {
        const ts = spawnChild({ graph, addon, scale, topology, runs, impl: "ts" });
        const native = spawnChild({ graph, addon, scale, topology, runs, impl: "native" });
        const entry = { graph: replay.source.target, ...summarize(topology, scale, ts, native) };
        measurements.push(entry);
        console.error(`${entry.graph} ${topology} ${scale}x: ${entry.nodes} nodes, TS ${entry.typescript.kernelMs.median} ms (cold ${entry.typescript.coldMs}), native ${entry.native.totalMs.median} ms (call ${entry.native.callMs.median}, cold ${entry.native.coldTotalMs}), ${entry.speedup.total}x, parity ${entry.parity}`);
      }
    }
  }
  measurements.sort((left, right) => left.topology.localeCompare(right.topology) || left.nodes - right.nodes);

  const result = {
    schemaVersion: 1,
    project: "CrankTS",
    comparisonType: "mvp9b-graph-batch-crossover",
    capturedAt: new Date().toISOString().slice(0, 10),
    environment: {
      node: process.version.slice(1),
      host: `${process.platform}-${process.arch}`,
      rust: rustVersion(),
      napi: "3.14.2",
    },
    graphs: replays.map(({ replay }) => ({
      source: replay.source,
      nodeCount: replay.nodeCount,
      undirectedEdgeCount: replay.undirectedEdgeCount,
      candidateIslands: replay.candidateIslands,
      fidelity: replay.fidelity,
    })),
    protocol: {
      warmupRuns: 1,
      measuredRuns: runs,
      typescriptKernel: "findWeaklyConnectedComponents + findArticulationPoints per component (dist/analysis/islands.js) on Map<FunctionId, Set<FunctionId>> adjacency",
      nativeTotal: "prepare (Map adjacency -> CSR Uint32Arrays, file ranks via localeCompare) + graphBatch call + decode (FunctionId arrays, localeCompare articulation tie-break)",
      topologies: {
        replicate: "k disjoint copies of the real graph",
        bridged: "k copies plus one edge between the highest-degree node of consecutive copies (one giant component)",
      },
      parity: "sha256 of the canonical result JSON must match between TypeScript and native for every run",
      isolation: "one child process per topology, scale, and implementation; --expose-gc and gc() before every run; ICU collator initialized before the first (cold) run",
      fractionalScales: "scale < 1 keeps the first nodes in (file, line) order and drops edges leaving the subset",
    },
    measurements,
    crossover: Object.fromEntries(topologies.map((topology) => {
      const rows = measurements.filter((row) => row.topology === topology);
      const nativeWins = (row) => row.native.totalMs.median < row.typescript.kernelMs.median;
      // Rows are sorted by node count: the crossover is the smallest size from which native
      // (including transfer) wins at every larger measured size.
      const lastTypescriptWin = rows.findLastIndex((row) => !nativeWins(row));
      return [topology, {
        typescriptWinsAtNodes: rows.filter((row) => !nativeWins(row)).map((row) => row.nodes),
        nativeWinsFromNodes: rows[lastTypescriptWin + 1]?.nodes ?? null,
      }];
    })),
    allParity: measurements.every((row) => row.parity),
  };
  if (output) {
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.error(`wrote ${output}`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

function spawnChild({ graph, addon, scale, topology, runs, impl }) {
  // Child processes receive exactly one graph, scale, and topology.
  const child = spawnSync(process.execPath, [
    "--expose-gc",
    fileURLToPath(import.meta.url),
    "--child", "--graph", graph, "--addon", addon,
    "--scales", String(scale), "--topologies", topology, "--runs", String(runs), "--impl", impl,
  ], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (child.status !== 0) {
    throw new Error(`${impl} ${topology} ${scale}x failed: ${child.stderr}`);
  }
  return JSON.parse(child.stdout);
}

function summarize(topology, scale, ts, native) {
  const parity = ts.resultHashes.length === 1
    && native.resultHashes.length === 1
    && ts.resultHashes[0] === native.resultHashes[0];
  const tsMedian = median(ts.runs.map((run) => run.kernelMs));
  const nativeTotal = median(native.runs.map((run) => run.totalMs));
  const nativeCall = median(native.runs.map((run) => run.callMs));
  return {
    topology,
    scale,
    nodes: ts.nodes,
    undirectedEdges: ts.undirectedEdges,
    components: ts.components,
    largestComponent: ts.largestComponent,
    componentsWithArticulationPoints: ts.componentsWithArticulationPoints,
    parity,
    resultSha256: ts.resultHashes[0],
    typescript: {
      kernelMs: spread(ts.runs.map((run) => run.kernelMs)),
      coldMs: round(ts.cold.kernelMs),
      rssAfterInputMb: megabytes(ts.rssAfterInput),
      peakRssMb: megabytes(ts.peakRss),
    },
    native: {
      prepareMs: spread(native.runs.map((run) => run.prepareMs)),
      callMs: spread(native.runs.map((run) => run.callMs)),
      decodeMs: spread(native.runs.map((run) => run.decodeMs)),
      totalMs: spread(native.runs.map((run) => run.totalMs)),
      coldTotalMs: round(native.cold.totalMs),
      rssAfterInputMb: megabytes(native.rssAfterInput),
      peakRssMb: megabytes(native.peakRss),
    },
    speedup: {
      total: round(tsMedian / nativeTotal),
      callOnly: round(tsMedian / nativeCall),
      cold: round(ts.cold.kernelMs / native.cold.totalMs),
    },
  };
}

function runChild({ graphs, addon, scales, topologies, runs, impl }) {
  const replay = JSON.parse(readFileSync(graphs[0], "utf8"));
  const { candidates, adjacency, functionById, undirectedEdges } = buildInput(replay, scales[0], topologies[0]);
  const graphBatch = impl === "native" ? createRequire(import.meta.url)(resolve(addon)).graphBatch : undefined;
  const rssAfterInput = process.memoryUsage().rss;
  // The first localeCompare initializes ICU's collator (~6 ms). A real CrankTS run has already paid
  // this while sorting functions, so it must not be charged to whichever kernel runs first.
  "a".localeCompare("b");

  const measured = [];
  let cold;
  const resultHashes = new Set();
  let lastResult;
  for (let run = 0; run <= runs; run += 1) {
    globalThis.gc?.();
    const timing = impl === "ts"
      ? runTypescript(candidates, adjacency, functionById)
      : runNative(candidates, adjacency, graphBatch);
    resultHashes.add(createHash("sha256").update(JSON.stringify(timing.result)).digest("hex"));
    lastResult = timing.result;
    const { result, ...times } = timing;
    if (run === 0) {
      cold = times;
    } else {
      measured.push(times);
    }
  }

  return {
    nodes: candidates.length,
    undirectedEdges,
    components: lastResult.length,
    largestComponent: Math.max(...lastResult.map((component) => component.members.length)),
    componentsWithArticulationPoints: lastResult.filter((component) => component.articulationCount > 0).length,
    rssAfterInput,
    peakRss: process.resourceUsage().maxRSS * 1024,
    resultHashes: [...resultHashes],
    cold,
    runs: measured,
  };
}

function runTypescript(candidates, adjacency, functionById) {
  const start = performance.now();
  const components = findWeaklyConnectedComponents(candidates, adjacency, functionById);
  const result = components.map((members) => {
    const articulation = findArticulationPoints(members, adjacency);
    return { members, articulationCount: articulation.count, largestImpact: articulation.largestImpact };
  });
  return { kernelMs: performance.now() - start, result };
}

function runNative(candidates, adjacency, graphBatch) {
  const start = performance.now();
  const nodeCount = candidates.length;
  const indexById = new Map();
  for (let index = 0; index < nodeCount; index += 1) {
    indexById.set(candidates[index].id, index);
  }
  const offsets = new Uint32Array(nodeCount + 1);
  let edgeSlots = 0;
  for (let index = 0; index < nodeCount; index += 1) {
    edgeSlots += adjacency.get(candidates[index].id)?.size ?? 0;
    offsets[index + 1] = edgeSlots;
  }
  const neighbors = new Uint32Array(edgeSlots);
  let cursor = 0;
  for (let index = 0; index < nodeCount; index += 1) {
    for (const neighborId of adjacency.get(candidates[index].id) ?? []) {
      neighbors[cursor] = indexById.get(neighborId);
      cursor += 1;
    }
  }
  // File order uses localeCompare in TypeScript; rank unique files once instead of comparing in Rust.
  const files = [...new Set(candidates.map((candidate) => candidate.file))].sort((left, right) => left.localeCompare(right));
  const rankByFile = new Map(files.map((file, rank) => [file, rank]));
  const fileRank = new Uint32Array(nodeCount);
  const line = new Uint32Array(nodeCount);
  for (let index = 0; index < nodeCount; index += 1) {
    fileRank[index] = rankByFile.get(candidates[index].file);
    line[index] = candidates[index].line;
  }
  const prepared = performance.now();

  const output = graphBatch(offsets, neighbors, fileRank, line);
  const called = performance.now();

  const result = [];
  let position = 1;
  const componentCount = output[0];
  for (let component = 0; component < componentCount; component += 1) {
    const memberCount = output[position++];
    const members = new Array(memberCount);
    for (let member = 0; member < memberCount; member += 1) {
      members[member] = candidates[output[position++]].id;
    }
    const articulationCount = output[position++];
    const tieCount = output[position++];
    let largestImpact = null;
    for (let tie = 0; tie < tieCount; tie += 1) {
      const candidate = {
        functionId: candidates[output[position]].id,
        impact: output[position + 1],
        componentsAfterRemoval: output[position + 2],
        largestRemainingPart: output[position + 3],
      };
      position += 4;
      if (!largestImpact || candidate.functionId.localeCompare(largestImpact.functionId) < 0) {
        largestImpact = candidate;
      }
    }
    result.push({ members, articulationCount, largestImpact });
  }
  const decoded = performance.now();

  return {
    prepareMs: prepared - start,
    callMs: called - prepared,
    decodeMs: decoded - called,
    totalMs: decoded - start,
    result,
  };
}

function buildInput(fullReplay, scale, topology) {
  const replay = scale < 1 ? truncateReplay(fullReplay, scale) : fullReplay;
  scale = Math.max(1, scale);
  const baseCount = replay.nodeCount;
  const candidates = [];
  for (let copy = 0; copy < scale; copy += 1) {
    const prefix = copy === 0 ? "" : `copy${copy}/`;
    for (const [id, file, line] of replay.nodes) {
      candidates.push({ id: `${prefix}${id}`, file: `${prefix}${file}`, line });
    }
  }
  const neighborLists = [];
  for (let copy = 0; copy < scale; copy += 1) {
    const offset = copy * baseCount;
    for (const neighbors of replay.adjacency) {
      neighborLists.push(neighbors.map((neighbor) => neighbor + offset));
    }
  }
  if (topology === "bridged") {
    let anchor = 0;
    replay.adjacency.forEach((neighbors, index) => {
      if (neighbors.length > replay.adjacency[anchor].length) anchor = index;
    });
    for (let copy = 1; copy < scale; copy += 1) {
      const left = anchor + (copy - 1) * baseCount;
      const right = anchor + copy * baseCount;
      neighborLists[left].push(right);
      neighborLists[right].push(left);
    }
  } else if (topology !== "replicate") {
    throw new Error(`unknown topology '${topology}'`);
  }

  const adjacency = new Map(candidates.map((candidate, index) => [
    candidate.id,
    new Set(neighborLists[index].map((neighbor) => candidates[neighbor].id)),
  ]));
  const functionById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const undirectedEdges = neighborLists.reduce((sum, neighbors, index) => (
    sum + neighbors.filter((neighbor) => neighbor >= index).length
  ), 0);
  return { candidates, adjacency, functionById, undirectedEdges };
}

// Fractional scales keep the first nodes in report (file, line) order, i.e. whole leading files,
// and drop edges that leave the subset.
function truncateReplay(replay, fraction) {
  const nodeCount = Math.max(1, Math.round(replay.nodeCount * fraction));
  return {
    ...replay,
    nodeCount,
    nodes: replay.nodes.slice(0, nodeCount),
    adjacency: replay.adjacency.slice(0, nodeCount).map((neighbors) => neighbors.filter((neighbor) => neighbor < nodeCount)),
  };
}

function parseArguments(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const graph = value("--graph");
  const addon = value("--addon");
  if (!graph || !addon) {
    throw new Error("--graph <replay.json> and --addon <file.node> are required");
  }
  return {
    child: argv.includes("--child"),
    graphs: graph.split(",").map((path) => resolve(path)),
    addon: resolve(addon),
    scales: (value("--scales") ?? "1,2,5,10,25,50,100").split(",").map(Number),
    baseScales: (value("--base-scales") ?? "1").split(",").map(Number),
    topologies: (value("--topologies") ?? "replicate,bridged").split(","),
    runs: Number(value("--runs") ?? 5),
    impl: value("--impl") ?? "ts",
    output: value("--output") ? resolve(value("--output")) : undefined,
  };
}

function rustVersion() {
  const rustc = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  return rustc.status === 0 ? rustc.stdout.split(" ")[1] : "unknown";
}

function spread(values) {
  return { median: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)) };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function megabytes(bytes) {
  return round(bytes / 1_000_000);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
