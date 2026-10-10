# GRAPH_BATCH Native Kernel PoC

This isolated napi-rs experiment (MVP-9b) validates the `GRAPH_BATCH` offload shape: one batch call over nodes and edges that returns metrics. It does not try to speed up CrankTS itself. MVP-9a showed the graph passes are 0.7% of CrankTS wall time, so the self-offload is a `KEEP_TS` case. The question here is narrower: for a real graph representation, how fast is the native kernel including transfer, and from what size does it beat TypeScript?

The kernel mirrors `findWeaklyConnectedComponents` and `findArticulationPoints` from `src/analysis/islands.ts`, including traversal order. The input is CSR `Uint32Array`s (offsets, neighbors) plus file rank and line per node. The output is one flat `Uint32Array`: per component, the sorted members, the articulation-point count, and the set of articulation points tied for the largest (impact, componentsAfterRemoval). String semantics stay in TypeScript. File order is ranked once with `localeCompare`, and the final articulation tie-break by `FunctionId` uses `localeCompare` on the returned tie set.

## Run

From the CrankTS root on macOS, after `pnpm build`:

```bash
export CARGO_TARGET_DIR=/tmp/crankts-graph-native-target
cargo test --manifest-path evaluation/graph-native-poc/Cargo.toml
cargo build --release --manifest-path evaluation/graph-native-poc/Cargo.toml
cp "$CARGO_TARGET_DIR/release/libgraph_native_poc.dylib" /tmp/crankts-graph/graph_native_poc.node

# Replay files of the real candidate graph (fails unless WCC reproduces every analyzed island)
node evaluation/graph-native-poc/export-graph.mjs ../intentweave --workspace-references --output /tmp/crankts-graph/w1-graph.json
node evaluation/graph-native-poc/export-graph.mjs ../intentweave/packages/analyzer --output /tmp/crankts-graph/w2-graph.json
node evaluation/graph-native-poc/export-graph.mjs src --output /tmp/crankts-graph/self-graph.json

node evaluation/graph-native-poc/benchmark.mjs \
  --graph /tmp/crankts-graph/w1-graph.json,/tmp/crankts-graph/w2-graph.json,/tmp/crankts-graph/self-graph.json \
  --addon /tmp/crankts-graph/graph_native_poc.node \
  --scales 1,2,5,10,25,50,100 --base-scales 0.05,0.1,0.25,0.5,1 --runs 5 \
  --output evaluation/crankts-mvp9b-graph-crossover.json
```

`--scales` replicates the first graph k times. The `replicate` topology uses disjoint copies; the `bridged` topology links the highest-degree node of consecutive copies into one giant component. `--base-scales` applies to the other graphs; a fraction keeps the leading nodes in (file, line) order. Each topology, scale, and implementation runs in its own child process with one cold run and five measured runs. Parity requires the sha256 of the canonical result JSON to match between implementations on every run.

## Limits

The TypeScript side is CrankTS's real kernel on its real `Map<FunctionId, Set<FunctionId>>` input, so the native total includes converting that map to CSR. Scaled graphs are replicas of a real graph, not a larger real code base. Timings below ~0.1 ms are within timer and scheduling noise. This is not a CrankTS integration: the package takes no Rust dependency, and CI is unchanged.
