# Plan: CrankTS on CrankTS – a Second Offload Shape and v0.2

Status: 2026-10-13. **This document is now the v0.2 history and decision record. The current plan is [observe-plan.md](observe-plan.md)** (see [the seventh review round](#decision-after-the-seventh-review-round-2026-10-13-observe)). Original status, 2026-10-10: this plan was the working basis for the next implementation steps. It does not change existing claims in the [README](../README.md) or [analysis-and-evaluation.md](analysis-and-evaluation.md); measurement results continue to land as JSON under `evaluation/` and as a section in the evaluation history.

## Thesis

> CrankTS deliberately stays TypeScript – and optimizes itself natively wherever CrankTS itself identifies a well-founded offload.

The KWX PoC ([evaluation/kwx-native-poc](../evaluation/kwx-native-poc/README.md), [MVP-8](../evaluation/intentweave-mvp8-native-poc.json)) proved exactly one shape: **prepared state + many string calls** (`PreparedDictionary` → `scan(text)`). The second candidate should deliberately test a different shape: **one batch call over nodes and edges → metrics**. Only once both shapes work manually and then mechanically is the approach more than a special case.

## Target Project Order

| # | Project | Shape | Purpose | Status |
| --- | --- | --- | --- | --- |
| 1 | IntentWeave | `PREPARED_STATE` | first native candidate (KWX) | manual PoC ✓ |
| 2 | CrankTS itself | `GRAPH_BATCH` / `REDUCTION` | second, different offload; dogfooding | this plan |
| 3 | Knip | open | external validation without project knowledge | after v0.2b |
| 4 | TypeDoc or ts-morph | open | compiler-API-heavy hard cases | later |

Knip is cloned only after MVP-9a/9b are complete.

---

## Starting Point in the Code

The analysis runs fully synchronously in [`analyzeProject`](../src/analysis/analyze-project.ts). Stages in call order, with the expectation MVP-9a is meant to confirm or refute:

| Stage | Code | Expectation |
| --- | --- | --- |
| Project loading / TS Program | `createCompilerFacade` in [compiler-facade.ts](../src/compiler/compiler-facade.ts) | probably expensive, hard to offload → `KEEP_TS` control case |
| Function collection | `collectFunctions` in [functions.ts](../src/analysis/functions.ts) | checker-heavy, unlikely |
| Call graph | `buildCallGraph` in [call-graph.ts](../src/analysis/call-graph.ts) | AST walk + checker resolution, unlikely |
| Direct eligibility / effects | `evaluateEligibility`, `inferDirectEffects` | checker-heavy, unlikely |
| Eligibility propagation | `propagateEligibility` in [eligibility.ts](../src/analysis/eligibility.ts) | worklist fixpoint, candidate |
| Effect propagation | `propagateEffects` in [effects.ts](../src/analysis/effects.ts) | worklist fixpoint over `Set<Effect>`, candidate (bitset + SCC) |
| Opportunities / parallelism | `scoreOpportunities`, `analyzeParallelism` | AST-heavy, unlikely |
| Call closure | `getTargetCallClosure` in analyze-project.ts | DFS, expected cheap |
| WCC + boundary statistics + Tarjan | `findCandidateIslands`, `findWeaklyConnectedComponents`, `findArticulationPoints` in [islands.ts](../src/analysis/islands.ts) | **preferred candidate** |
| Profile matching | [cpu-profile.ts](../src/analysis/cpu-profile.ts), [heap-profile.ts](../src/analysis/heap-profile.ts) | maybe (only with a profile) |
| Assessment | [assessment.ts](../src/analysis/assessment.ts) | expected cheap |
| Report | [report/json.ts](../src/report/json.ts), [report/text.ts](../src/report/text.ts) | unlikely |

**Key risk up front:** The largest workload analyzed so far (IntentWeave with `--workspace-references`) had 3,352 functions and 874 islands ([MVP-8](../evaluation/intentweave-mvp8-native-poc.json), `workspaceAnalysis`). WCC and Tarjan are O(V+E); at this size a graph pass is likely in the millisecond range, while the TS Program and checker cost seconds. By Amdahl's law, a 1.5× kernel speedup caps the overall gain at `1 / (1 − f/3)`. For a 5% wall-time reduction the kernel must therefore account for at least ~15% of runtime. MVP-9a may well conclude: "graph pass is cold, the TypeScript compiler dominates → `KEEP_TS`". That is a valid, publishable result, not a failure. The plan handles this case explicitly (see the decision point after MVP-9a).

---

## MVP-9a – Self Profile

**Goal:** measure instead of guess which internal CrankTS pass actually costs.

### Workloads

1. **W1 – IntentWeave full workspace** (main workload):
   `node dist/cli.js analyze ../intentweave --workspace-references --format json > /tmp/crankts-self/w1-report.json`
2. **W2 – IntentWeave analyzer package** (small, for scaling comparison): `../intentweave/packages/analyzer`
3. **W3 – large third-party TS project** (only if W1 is too small for graph kernels), e.g. the TypeScript repository itself or a large monorepo checkout. Analysis only, no transformation. Chosen only after the W1 result.

All runs use the built `dist/` output (not `tsx`), so the profile contains no transpilation cost and the existing `dist` → `src` mapping in `cpu-profile.ts` applies.

### Instrumentation

| Metric | Means | Code change needed? |
| --- | --- | --- |
| CPU profile | `node --cpu-prof --cpu-prof-interval 1000 --cpu-prof-dir /tmp/crankts-self dist/cli.js analyze …` | no |
| Allocation profile | `node --heap-prof --heap-prof-dir /tmp/crankts-self …` | no |
| Peak RSS | `/usr/bin/time -l` (macOS, "maximum resident set size") | no |
| GC | `--trace-gc-nvp` or a `PerformanceObserver` for `gc` | optional |
| Stage timings | new opt-in flag `--timings <file>` | **yes** (see below) |

**Stage timings:** `analyzeProject` gets an optional `timings` option. Each step of the table above is recorded with `performance.now()` and `process.memoryUsage()` (rss, heapUsed) before and after the step. For the mixed loops in `analyzeProject` (e.g. the `directFunctions` map, which calls `evaluateEligibility` and `inferDirectEffects` per function) partial times are accumulated. `findCandidateIslands` is split more finely internally: adjacency construction, WCC, boundary edge loop, Tarjan per component, component mapping, and sorting. Output is a separate JSON file (not part of report schema v2), so report parity is unaffected. Without the flag there is no overhead beyond an `undefined` check.

### Dogfooding Step

The CPU/heap profile of the CrankTS process is then evaluated by CrankTS itself:

```bash
node dist/cli.js analyze src/ \
  --profile /tmp/crankts-self/w1.cpuprofile \
  --heap-profile /tmp/crankts-self/w1.heapprofile \
  --workload "self: IntentWeave full workspace" --format json
```

Expectation: samples in `node_modules/typescript/lib/typescript.js` remain unmatched, so coverage will probably be `LOW`. So that this does not appear merely as "poor coverage", the profile summary gains a **breakdown of unmatched samples by origin** (package under `node_modules`, Node internals, GC, program/idle). This is the only planned change to profile semantics, and it is additive. It allows the TypeScript compiler share to be evidenced as an external, `KEEP_TS`-worthy hotspot.

### Protocol

- 1 warm-up + 5 measured runs per workload, sequential, same machine (macOS arm64, Node 22.19, TS 5.9.3 as in MVP-8).
- Separate runs for: unprofiled (wall + RSS + timings), CPU-profiled, heap-profiled. Otherwise profiler overhead distorts wall time.
- The report JSON of all runs must be byte-identical (determinism check; this is the parity baseline for MVP-9b).

### Output

`evaluation/crankts-mvp9a-self-profile.json` containing:

- top internal CrankTS hotspots (self/inclusive CPU, share)
- top allocation sites
- stage timings (median, min, max over 5 runs) and RSS deltas per stage
- peak RSS, wall-time median
- external share (TypeScript compiler, Node, GC)
- CrankTS self-assessment (actions from `assessment.ts`), including the `KEEP_TS` cases

Plus a new section "MVP-9a CrankTS Self-Profile" in [analysis-and-evaluation.md](analysis-and-evaluation.md).

### Decision Point After MVP-9a

| Result | Consequence |
| --- | --- |
| Graph pass (islands.ts) ≥ ~15% of wall on W1 | MVP-9b with Tarjan/WCC as planned |
| Graph pass cold, but propagation (`propagateEffects`/`propagateEligibility`) hot | MVP-9b with propagation as the `GRAPH_BATCH` kernel (SCC condensation + bitset effects); same shape, different pass |
| Everything internal cold, TS compiler dominates | Document the result as a `KEEP_TS` control case; scale the graph kernel to W3 and check the kernel gate in isolation; report the wall gate as "not reachable on W1" rather than relaxing it |

Default if nothing is clear-cut: Tarjan/WCC, because it separates the shape most clearly from KWX.

---

## MVP-9b – Self-Offload PoC (manual)

> **Reframed after MVP-9a (see [review.md](review.md)) and done:** MVP-9b ran as a small `GRAPH_BATCH` backend crossover test rather than a CrankTS self-offload. It used a replay export, a Rust WCC/Tarjan kernel, exact parity, scales from 12 to 367,900 nodes, and transfer included. There was no preload and no wall gate. Results are in [crankts-mvp9b-graph-crossover.json](../evaluation/crankts-mvp9b-graph-crossover.json). The original section below is kept for reference.

**Goal:** exactly one CrankTS kernel, manually in Rust/N-API, analogous to the KWX PoC.

### Location and Structure

New isolated directory `evaluation/graph-native-poc/` (Cargo crate like [kwx-native-poc/Cargo.toml](../evaluation/kwx-native-poc/Cargo.toml), napi 3.x, `opt-level = 3`, LTO), with `README.md`, `benchmark.mjs`, and a preload analogous to [native-preload.mjs](../evaluation/kwx-native-poc/native-preload.mjs). The CrankTS package takes no Rust dependency; CI ([ci.yml](../.github/workflows/ci.yml)) stays unchanged.

### Kernel Cut (default: Tarjan + WCC)

The cut follows the KWX pattern: only the pure in-memory part goes native; everything carrying semantics stays in TS.

**Native:**
- WCC over the undirected projection of candidate edges (`findWeaklyConnectedComponents`)
- articulation points per component including `impact`, `componentsAfterRemoval`, `largestRemainingPart` (`findArticulationPoints`, `getNonRootParts`)
- optionally, as a second step: the boundary edge loop in `findCandidateIslands` as a reduction (internal/entry/exit counters, boundary-kind histogram, cost units)

**Stays TypeScript:**
- interning `FunctionId` → dense `u32` index and building the CSR arrays
- sorting of members (`file.localeCompare`, `line`) and islands (score, `localeCompare` on member ID)
- tie-breaking articulation impacts via `functionId.localeCompare`: Rust cannot replicate ICU `localeCompare` exactly. Solution: native returns **all** articulation impacts per component and TS sorts. Alternatively TS assigns a rank per ID up front and Rust sorts by rank.
- `internalCallers`, warnings, eligibility mix, `calculateNativePriority`

### ABI

```text
GRAPH_BATCH
  nodeCount: u32
  offsets:   Uint32Array   (CSR, length nodeCount + 1, undirected, deduplicated)
  edges:     Uint32Array
→ componentOf:      Uint32Array (length nodeCount)
  componentOrder:   Uint32Array (first-visit order as in TS)
  articulation:     Uint32Array (tuples: node, impact, parts, largestPart)
```

The adjacency in TS is a `Map<FunctionId, Set<FunctionId>>` with insertion order. The set of articulation points and their impact values are independent of DFS order; component order is not. Native must therefore visit nodes as DFS roots in the same order as `candidateFunctions`.

### Measurement

- **Kernel benchmark:** replay from a serialized candidate graph (exported from W1 and, if used, W3), so the kernel can be measured repeatedly without a TS Program. The TS reference is the unchanged code from `islands.ts`. Measurement includes interning/CSR construction and back-conversion, i.e. the honest boundary cost.
- **Whole app:** W1 with and without the preload, 1 warm-up + 5 runs, wall median, peak RSS.
- Additionally: memory footprint of CSR arrays vs. Map/Set adjacency (heapUsed delta).

### Gates

| Gate | Threshold |
| --- | --- |
| Exact output | `--format json` byte-identical to TS on W1, W2 (and W3 if used); existing [islands.test.ts](../test/islands.test.ts) green via the preload |
| Kernel speedup | ≥ 1.5× median including marshalling |
| Wall time | "meaningful": default ≥ 5% median reduction **and** larger than twice the run-to-run spread of TS |
| RSS | peak RSS at most +5% vs. TS median |

If the wall gate fails on W1 only because of Amdahl (kernel share too small), this is documented as such and not masked by adjusting the gate.

### Output

`evaluation/crankts-mvp9b-graph-native-poc.json` and a section "MVP-9b" in the evaluation history.

---

## MVP-9c – Transformation Shapes (Lowering Contract)

**Goal:** a small, mechanically transformable ABI description. Explicitly **not** a Native IR.

### Location

`src/lowering/contract.ts` (types and validation only), tests in `test/lowering-contract.test.ts`. No codegen yet.

### Kernel Shapes

| Shape | Meaning | Reference |
| --- | --- | --- |
| `PURE_BATCH` | arrays in, arrays/structs out, one call, no state | general case |
| `PREPARED_STATE` | `prepare(input) → handle`, then many calls on the handle | KWX |
| `GRAPH_BATCH` | `PURE_BATCH` with a CSR graph as input | CrankTS Tarjan/WCC |
| `REDUCTION` | many elements → counters/histograms | boundary statistics, profile aggregation (later) |
| `PARALLEL_MAP` | independent elements, parallelizable | declared only, not in v0.2 |

v0.2 supports only `PREPARED_STATE`, `PURE_BATCH`, and `GRAPH_BATCH`.

### Data Types

`Scalar` (u8/u32/i32/f64/bool), `String` (with fixed offset semantics: UTF-16 as in JS), `Array<Scalar>`, `Struct`, `Array<Struct>`, `TypedArray`, `OpaqueNativeHandle`.

### Required Fields per Kernel Description

These fields are exactly the concepts whose repetition should later justify a Native IR:

- inputs/outputs with types
- ownership (copied / borrowed / transferred to a handle)
- handle lifetime and the source's **mutation contract** (e.g. KWX: `Set<string>` is mutable; options: snapshot + invalidation on change, or proof of immutability for the handle's lifetime). Without a valid contract: fail closed.
- input mutability
- ordering and determinism guarantees of the output (e.g. dictionary order, component first-visit order)
- string/offset semantics
- batching granularity
- fallback conditions

### Examples

```text
KWX
  shape: PREPARED_STATE
  prepare: dictionary: Array<String> -> OpaqueNativeHandle
  call:    chunk: String -> Array<Struct{termIndex:u32, offset:u32, length:u32}>
  contract: dictionary immutable for handle lifetime, else re-prepare

Tarjan/WCC
  shape: GRAPH_BATCH
  input:  nodeCount: u32, offsets: Uint32Array, edges: Uint32Array
  output: componentOf: Uint32Array, articulation: Array<Struct{node,impact,parts,largestPart}>
  contract: undirected, deduplicated; component order = root visit order
```

---

## v0.2a – Mechanical KWX Transformer

**Goal:** CrankTS reproducibly generates the KWX shape proven in MVP-8.

```text
TS function
→ extracted native kernel
→ wrapper
→ prepare handle
→ fallback
→ parity harness
```

- **Explicit selection:** new command, e.g. `crankts extract --function <file>#<name> --shape PREPARED_STATE --out <dir>`. No automatic candidate selection in v0.2.
- **Source precondition:** the kernel must be a standalone function. In the KWX case the native part was only a slice of `extractDictionary`. For v0.2a, the ASCII scan loop in IntentWeave is first extracted into its own function (in TS, with no behavior change). That is an ordinary refactor, not a transformer feature.
- **Supported subset:** loops, character-code operations, `Map`/`Set` lookups on strings, arrays of scalars, return as flat `u32` tuples. Anything else → fail closed with a diagnostic.
- **Emission:** Rust crate (napi), TS wrapper with an identical signature, runtime fallback to the original TS function (addon missing, contract violated, error), parity test generator (differential test against the original on supplied inputs), and a benchmark harness.
- **Mutation contract:** the wrapper implements snapshot + invalidation (checking `Set` size and identity, or wrapping `add`/`delete`), so the public mutable-`Set` contract noted in the PoC README is no longer violated.
- **Gate:** the generated kernel reaches the same output parity and at least the order of magnitude of the MVP-8 numbers (scanner ≥ 10×, full build ≥ 1.2× median over 5 runs).

## v0.2b – Mechanical Graph Transformer

The same for the CrankTS kernel validated in MVP-9b, shape `GRAPH_BATCH`.

- Additional supported subset: iterative DFS with an explicit stack, `Map<Id, number>` state that can be mapped to dense arrays, interning of string IDs.
- The result is used as an optional native module for CrankTS itself: an optionalDependency, with TS remaining the default and the reference. CI continues to run without Rust; a separate job for the native package is added only once it is integrated.
- **Gate:** the same gates as MVP-9b, now with a generated instead of a handwritten kernel.

This yields two independent shapes (`PREPARED_STATE` and `GRAPH_BATCH`), both generated mechanically.

## v0.2c – External Validation with Knip

- Clone Knip, **no project-specific rules** in CrankTS.
- Flow: `analyze` → `profile` (run Knip on a large repository, CPU/heap profile) → advise (assessment) → select (manually documented selection).
- The only question is whether CrankTS finds a plausible candidate and whether the proposed shape fits. **No transformation** in v0.2c. Decide on transformation only afterwards.
- Output: `evaluation/knip-v02c-candidates.json` with labels analogous to [intentweave-index-top16.json](../evaluation/intentweave-index-top16.json).

---

## When to Build a Native IR

Only once KWX and the CrankTS self-offload show that the same concepts repeat: inputs, outputs, ownership, lifetime, mutability, batching, parallel semantics, boundary ABI. This list matches the required fields from MVP-9c; the IR is later extracted from the fields actually used, not designed up front. This corresponds to v0.3 in the README roadmap.

## README Demo (goal, only after v0.2b)

```text
CrankTS is written in TypeScript.

CrankTS analyzed itself,
identified its graph-analysis kernel,
and offloaded that kernel automatically.
```

Use only if v0.2b passes the gates on a real workload. If MVP-9a finds the graph pass cold, the honest variant is: "CrankTS analyzed itself and correctly kept its hot path in TypeScript."

---

## Work Packages and Order

| Package | Content | Changes `src/`? | Depends on |
| --- | --- | --- | --- |
| MVP-9a.1 | `--timings` flag and stage measurement in `analyzeProject` / `findCandidateIslands` | yes, additive | – |
| MVP-9a.2 | breakdown of unmatched profile samples by origin | yes, additive | – |
| MVP-9a.3 | measurement protocol W1/W2, self-assessment, evaluation JSON + docs | no | 9a.1, 9a.2 |
| MVP-9b.1 | graph export (replay format) for kernel benchmarks | evaluation/ | 9a.3 |
| MVP-9b.2 | `evaluation/graph-native-poc` (Rust/N-API, preload, benchmark) | no | 9b.1 |
| MVP-9b.3 | measure gates, evaluation JSON + docs | no | 9b.2 |
| MVP-9c | `src/lowering/contract.ts` + tests | yes, new | 9b.3 |
| v0.2a | `crankts extract` for `PREPARED_STATE` (KWX) | yes | 9c |
| v0.2b | `GRAPH_BATCH` transformer, optional native CrankTS module | yes | v0.2a |
| v0.2c | analyze/profile/advise on Knip | no | v0.2b |

MVP-9a is complete: the graph passes are cold on W1 (0.7% of wall), so the outcome is the `KEEP_TS` control case. See [crankts-mvp9a-self-profile.json](../evaluation/crankts-mvp9a-self-profile.json) and the MVP-9a section in [analysis-and-evaluation.md](analysis-and-evaluation.md). As a follow-up, `CHANGE_DATA_LAYOUT` now uses attributable allocation share instead of inclusive share, which removed the orchestrator false positives.

MVP-9b is complete as a crossover test (9b.1 to 9b.3). Native WCC/Tarjan matches exactly and wins from about 40 nodes up: 2.9x on W1 including transfer, 4.2 to 5.0x at 100×, and 18 to 43x call only. `GRAPH_BATCH` is therefore confirmed as a shape; its advisor gate is the kernel's wall share, not graph size. CSR preparation is 75 to 90% of the native cost. The CrankTS self-offload ends here. Per [review.md](review.md), the next steps are external candidate discovery (Knip, where `KEEP_TS` is also an allowed outcome) and, in parallel, v0.2a (`PREPARED_STATE` from KWX).

v0.2 now follows the sequence at the end of [review.md](review.md), which supersedes MVP-9c and v0.2a/b above. **v0.2.0 is done:** `src/lowering/` contains the Kernel Contract with fail-closed validation, the boundary representation analysis, and reference contracts for KWX and MVP-9b; see [lowering.md](lowering.md). That covers the planned MVP-9c lowering contract. One correction to v0.2a above: invalidating a handle by checking `Set` identity and size is unsound, so the KWX contract uses `WRAP_MUTATORS`. **v0.2.1 is done:** the Kernel IR, TS → IR lowering (fail-closed), IR verification with obligation discharge, a reference interpreter with traps, and contract derivation. Kernel-style versions of both PoC kernels lower to lowerable contracts and match TypeScript in the interpreter; the graph kernel also matches the real `islands.ts`. **v0.2.2 is done:** a Rust/N-API backend from verified IR plus `crankts extract`, which fails closed. The generated addons match TypeScript on all parity suites, including traps. The generated graph kernel is 1.6x faster than TypeScript on W1 including transfer (3.1x at 100×), but its call is about 4x slower than the handwritten PoC; see [lowering.md](lowering.md). **v0.2.3 is done:** `crankts extract` also generates a TypeScript wrapper with the original signature and a differential parity runner. The wrapper falls back to the original function when the addon is missing, traps, or errors. Its prepared-state view runs in TypeScript once a caller has observed it. The parity runner checks wrapper ≡ original and native ≡ original-or-trap. **v0.2.4 is done.** Following the second review round, v0.2.4 makes three changes.

It narrows the fallback taxonomy. The wrapper falls back only for `ADDON_MISSING`, `CONTRACT_GUARD`, or `CRANKTS_KERNEL_TRAP`; any other failure, including a caught Rust panic, surfaces as `CRANKTS_INTERNAL_ERROR`.

It adds a backend quality pass:

- integer specialization from IR dataflow (`i64`, checked to 2^53)
- typed-array outputs as part of the contract's `BoundaryType`
- reuse of loop-local buffers

It adds a generated benchmark with an acceptance gate covering correctness, net speed, ≤ 2× the handwritten PoC, and a boundary share ≤ 0.5. All gates pass on W1 at 1×, 10×, and 100× and on an IntentWeave-derived KWX workload. The generated kernels now run at 0.77 to 1.47 times the handwritten PoCs, down from about 4 times; see [crankts-v024-backend-quality.json](../evaluation/crankts-v024-backend-quality.json).

### Roadmap after v0.2.4 (from review.md)

| Step | Content |
| --- | --- |
| v0.2.5 | Real KWX source → automatic `PREPARED_STATE`: callback and fast-path extraction from `extractDictionary`, plus mutation and lifetime handling of the dictionary `Set` |
| v0.2.6 | Real graph source → automatic `GRAPH_BATCH`: `FunctionId` interning, CSR packing upstream in the producer, and a producer-aware transformation |
| v0.2.7 | Explicit `TransformationPlan` (kernel, extraction region, producer changes, preparation site, call replacement, fallback path, validation plan) unifying both transformations; reversible source integration |
| v0.3 | Automatic candidate selection (advisor → qualifier → transformer), enabled only after validation |
| in parallel | External evaluation #1 (Knip): analyze and profile; `KEEP_TS` is an allowed outcome |

The `TransformationPlan` sits between the TS semantic model and the Kernel IR. v0.2.5 and v0.2.6 need it to express producer rewrites and call replacement, which do not belong in the Kernel IR.

**v0.2.5 is done.** `crankts extract --region/--prepare-region` derives the KWX `PREPARED_STATE` transformation from the unmodified `HeuristicKeywordExtractor.extractDictionary`, covering:

- checker-based region interfaces
- slicing of the prepare loop
- verbatim outlining
- in-out maps replayed from a set-log
- `CONTENT_SNAPSHOT` revalidation for the caller-mutable dictionary `Set`
- a patched copy of the source file

IntentWeave's own tests pass against the patched copy (5/5), 20,331 extractions are identical, and the full extractor is 1.25× faster. About 80% of that gain comes from prepared-state hoisting, which a TypeScript-only patch also achieves (1.19×); the native scan is at parity with V8. See [lowering.md](lowering.md) and [crankts-v025-region-extraction.json](../evaluation/crankts-v025-region-extraction.json). Next is v0.2.6 (the real graph source).

**v0.2.6 (part a) is done.** `crankts extract --intern FunctionId` packs CrankTS's unmodified `findWeaklyConnectedComponents` with an id-domain representation pass:

- interned indices
- a CSR graph
- a `Set` bitmap
- a comparator turned into a precomputed rank
- flat output

The packed function is itself the transformed-TypeScript variant, and it lowers to native. The integration and a patched `islands.ts` are generated as well. On W1, with packing on every call, the variants are A 2.30 ms, B 1.62 ms, and C 1.44 ms; 75–83% of the gain comes from the representation. With packing excluded, the packed TS kernel is 8–13× faster than the original and native another 3.3–5×. `findArticulationPoints` fails closed with explicit missing rules, which define v0.2.6b. See [lowering.md](lowering.md) and [crankts-v026-packed-graph.json](../evaluation/crankts-v026-packed-graph.json).

**v0.2.6b is done.** `crankts extract --intern FunctionId --batch` covers CrankTS's unmodified `findArticulationPoints`:

- id-keyed maps become hoisted presence and value arrays, reset per group
- the frame stack becomes a struct of arrays over the CSR
- sort-then-first becomes a streaming argmin, with id ties resolved by the verbatim comparator
- its 928 per-component calls are batched into one kernel call
- `findCandidateIslands` seals the adjacency once (immutability is checked), and the chained WCC kernel reuses it

Output is byte-identical; parity is 2,835 agreeing cases plus 165 guarded, with no mismatches. At kernel level on W1 with the graph sealed, the batched TypeScript is 2.0× faster and native 3.7× (3.0–3.6× at 10× and 100×, where native carries 63–69% of the gain). End to end, the graph work in `findCandidateIslands` drops from 7.1 to 3.4 ms (2.1× native, 1.8× TypeScript only). One lesson: a full `localeCompare` id rank cost more than the kernel itself, so id comparisons are now deferred to ties. See [lowering.md](lowering.md) and [crankts-v026b-batched-graph.json](../evaluation/crankts-v026b-batched-graph.json). Next: v0.2.6c, the Knip coverage study, then v0.2.7 (see the replan below).

### Adjustments from the third review round

- **Optimization model:**
  1. remove repeated work
  2. improve representation and lifetime
  3. parallelize
  4. only then choose the execution backend

  Native is the last mile.
- **Recommendation taxonomy:** split into transformation (`HOIST_INVARIANT_WORK`, `PREPARE_STATE`, `CHANGE_DATA_LAYOUT`, `BATCH`, `PARALLELIZE`) and execution (`KEEP_TS`, `MOVE_OFF_EVENT_LOOP`, `NATIVE_OFFLOAD`). Reports state transformation gain and native incremental gain separately.
- **No further KWX work:** the remaining 11.4 s is structured regex extraction, a separate problem.
- **Knip:** after v0.2.6b (now due).

**v0.2.6c is done.** The two assumptions of v0.2.6b are now proof obligations:

- `TOTAL_ORDER_KEY` is PROVEN by the integer analysis, which now handles arrays of arrays; otherwise the extraction is rejected.
- `IMMUTABLE_AFTER_CAPTURE` is GUARDED per group: the result is used only if the group still equals the captured copy, and otherwise the original re-runs.
- The graph's immutability through the batched statement is PROVEN, and batching now requires it.

The graph transformation is fail-closed without documented exceptions. See [lowering.md](lowering.md).

### Replan after the fourth review round

v0.2.6b showed that CrankTS has to transform across function boundaries: batching, a sealed representation shared by two consumers, and rare semantics kept in TypeScript. The open question is no longer whether CrankTS can optimize two known cases. It is **how much hot TypeScript a small set of reusable acceleration patterns explains.** New order:

| Step | Content |
| --- | --- |
| v0.2.6c | Close the two documented assumptions of v0.2.6b as proof obligations (`IMMUTABLE_AFTER_CAPTURE` for batched groups, `TOTAL_ORDER_KEY` for comparator keys); fail closed otherwise |
| Knip study | Generalization test, no new patterns: CPU profiles of Knip on several real repositories; the coverage funnel; per-hotspot recognition status; manual "transformable" review → recognition recall |
| v0.2.7 | `TransformationPlan` (kernels, regions, representations with preparation site, lifetime, and consumers, call replacements, TS-kept semantics, guards, obligations, fallback, validation). It is shaped by the Knip findings. One patched copy per source file instead of chained copies, and a shared A/B/C evaluation harness. |
| Advisor v2 | Transformation strategy (`KEEP_STRUCTURE`, `HOIST_INVARIANT_WORK`, `PREPARE_STATE`, `PACK_DATA`, `BATCH`, `PARALLELIZE`, `CHANGE_ALGORITHM`) separate from execution strategy (`KEEP_TS`, `MOVE_OFF_EVENT_LOOP`, `NATIVE`). Reports gain attribution and observed vs. projected application impact. |
| v0.3 | Automatic selection: analyzer → qualifier (proofs) → advisor → `TransformationPlan` → Kernel IR only for native parts → validator enables or rolls back |

**No new transformation patterns until the Knip study is evaluated.** (Superseded by the fifth round below: until the five-project generalization review.)

**Metrics for the external evaluations.** They are measured on profiled CPU, never on lines of code or syntax support:

- **Acceleration Coverage funnel:**
  1. runtime
  2. project-owned compute
  3. statically transformable (human review)
  4. covered by known CrankTS patterns
  5. worthwhile after the cost model
  6. successfully accelerated
- **Recognition recall:** recognized by CrankTS ÷ transformable according to human review.
- **Pattern yield:** per pattern, the projects it hits and the CPU coverage it adds. This shows diminishing returns early.
- **Product metric:** coverage × achievable speedup (Amdahl).

**Eval matrix:**

- Knip (dependency and static analysis)
- TypeDoc (compiler API)
- ts-morph (compiler object graph)
- ESLint (AST traversal and rules)
- one data-heavy Node tool (parsing and aggregation)

Not React web apps.

**Stop/Go after about five projects:**

| Median actionable project-owned CPU | Verdict |
| --- | --- |
| ≥ 30%, and a few recurring patterns explain most of it | continue with v0.3 |
| 10–30%, and patterns recur across projects | a niche optimizer for compute-heavy TypeScript |
| < 10%, and every project needs bespoke patterns | rethink the architecture (data-flow, dependence, and alias analysis instead of pattern recognition) |
| < 5%, mostly unique idioms, and native adds little after V8 | no automatic compiler: advisor-only, or a whole-program approach |

**Knip study (first data point) is done.** The annotations were reviewed in the fifth round, which split them into evidence levels. Details are in [eval-knip.md](eval-knip.md). Knip 6.41 was profiled on five repositories.

- **Coverage:** known-pattern coverage and recognition recall are both 0. Human review finds 2.3–22.6% of runtime transformable at Knip call sites, median 14.5%.
- **What is transformable:** mostly `HOIST_INVARIANT_WORK` (picomatch recompiling ignore patterns inside tinyglobby, 1.2–10.6%) and `PREPARE_STATE`/index-building (gitignore and workspace lookups).
- **Native:** Knip already runs parsing and resolution in Rust, so native execution is not the lever.
- **What this changes:**
  - **Call-site attribution:** attribute external time to the project code that causes it, and feed that into Advisor v2.
  - **A recognizer for repeated invariant work across calls:** compile/parse/matcher factories called with repeated inputs (memoize or hoist).
  - **Lowering syntax:** accept arrow functions and `this`-free methods as kernels.
  - **N-API time:** classify it as external native, not project compute.
  - **TypeScript 7:** projects that pin it (whose JavaScript package has no checker API) now fall back to the bundled TypeScript 5.9.

No Go/No-Go from one project. The patterns do recur (hoisting, prepared state); recognition is what fails. That points the v0.2.7 and Advisor v2 work at recognition and call sites rather than at new kernels.

### Replan after the fifth review round (after Knip)

Knip did not show that the approach fails. It showed that CrankTS's pattern families recur, but its recognition is too function-centric and too narrow in syntax: **CrankTS knows the idea but does not see where it applies.** So: build less compiler for now, and measure which compiler is needed.

| Step | Status | Content |
| --- | --- | --- |
| v0.2.6c | done | Proof cleanup (`TOTAL_ORDER_KEY`, `IMMUTABLE_AFTER_CAPTURE`) |
| Eval #1 Knip | done | Hybrid static analysis with native dependencies ([eval-knip.md](eval-knip.md)) |
| **v0.2.6d** | done | **Recognition infrastructure:**<br>R1 call-site attribution as a first-class model (`FUNCTION_SELF`, `CALL_SITE_CAUSED`, `EXTERNAL_DEPENDENCY`, `EXTERNAL_NATIVE`, `IO`, `GC_RUNTIME`)<br>R2 native-addon (N-API) time externalized<br>R3 `HOIST_INVARIANT_WORK` detection (recognition only; `STATIC_INVARIANT` vs `DYNAMICALLY_REPEATED`, with optional input-signature profiling: call count, unique argument fingerprints, reuse ratio)<br>R4 arrow functions and `this`-free methods in lowering (syntax coverage, not a pattern) |
| Eval #2–#6 | done: TypeDoc and ESLint ([eval-typedoc-eslint.md](eval-typedoc-eslint.md)), noble-hashes ([eval-noble-hashes.md](eval-noble-hashes.md)), Effect and one closed-source project (in [eval-generalization.md](eval-generalization.md); private details git-ignored) | TypeDoc (TS checker and AST), ESLint (visitors and rules), Effect (runtime, state, concurrency), noble-hashes (pure compute and typed arrays, a compute-heavy control and upper bound). Recognize and classify only; no new transformers. |
| Generalization review | draft written ([eval-generalization.md](eval-generalization.md)); the stop/go decision is open | Acceleration coverage, automated recognition recall, pattern-family recall, pattern yield, stop/go decision |
| **v0.2.6e** | done | **Evidence before patterns** (sixth review round):<br>E1 profile-weighted caller paths per call site (JSON and text report)<br>E2 profile frames matched by position when V8 names differ (computed-key and factory-object methods)<br>E3 eligibility: typed arrays through aliases/intersections, `throw new Error` as a guard<br>E4 evidence probe around the hottest call sites (`writeEvidenceProbe`): call counts, content repetition, identity overlap between argument collections, the same content reaching several call sites; works on tsc-built `dist/` files and behind tsx (in-thread `registerHooks`)<br>E5 observations with an at-risk upper bound (`IDENTICAL_OBJECT_FLOW`, `DUPLICATE_CONTENT_FLOW`, `REPEATED_INPUT`, `REPEATED_ARGUMENT`), and hypotheses only where no precondition is violated (static write effects, mutable outer reads, per-call cost vs lookup), with an estimated avoidable share where a cost model exists |
| Decision point | **taken 2026-10-11** (see below) | Advisor (A), static tier (B), hybrid (C), or stop: inputs in [eval-generalization.md](eval-generalization.md) (ground truth with provenance, offload gain ceiling, scriptc comparison, phenomena precision) |
| v0.2.7 | parked | `TransformationPlan` built from the patterns that actually recur |
| Advisor v2 | parked (2026-10-13) | Transformation vs. execution strategy, gain attribution, call-site recommendations |
| v0.3 | superseded: v0.3 is now [Observe](observe-plan.md) | Automatic selection and execution |

**v0.2.6d is done.** Details are in [analysis-and-evaluation.md](analysis-and-evaluation.md) and [eval-knip.md](eval-knip.md).

- **R1 call-site attribution:** `observedCpu.callSite` holds the targets per function, plus dependency entries with their compile-like time.
- **R2 N-API time:** time on N-API call lines and addon binding lines is externalized; advisor hotness now uses own JavaScript.
- **R3 `HOIST_INVARIANT_WORK` detection:** invariance classes, and repetition evidence from input-signature profiling (`--probe-inputs`, `--input-signatures`).
- **R4 lowering:** const arrow functions, function expressions, and `this`-free methods.

On Knip, every number is a median over workloads:

| Measure | Value |
| --- | ---: |
| Human-plausible | 11.5% |
| Evidence-supported | 4.3% |
| Recognized | 2.3% |
| Recognition recall | 0.46 (was 0) |
| Pattern-family recall | 1.0 |
| Precision | 1.0 |

The measured repetition turned `glob`/picomatch from plausible into evidence-supported. A study driver ([run-study.ts](../evaluation/coverage/run-study.ts)) now runs any subject from a config; evals #2–#5 use it.

**Rule until the generalization review:**

- New hotspots are classified by a human: an existing pattern family counts as a hit, anything else is recorded as a candidate pattern.
- Nothing new is implemented as a transformer. This guards against 35 special passes for 7% coverage.

**Evidence levels in the coverage funnel.** Every study reports these separately:

1. **Human-plausible**
2. **Human-evidence-supported:** the precondition is shown by measurement or by inspection, e.g. inputs that really repeat.
3. **CrankTS-recognized**
4. **CrankTS-transformable**
5. **Validated-beneficial**

**Two recalls:**

- **Automated recognition recall:** did CrankTS find the concrete case?
- **Pattern-family recall:** does CrankTS have the optimization family at all?

Knip: 0 for the first, nonzero for the second.

**Eval matrix (revised):**

| Project | Character |
| --- | --- |
| Knip | dependency- and orchestration-heavy static analysis |
| TypeDoc | TS checker- and AST-heavy |
| ESLint | visitor- and rule-heavy |
| Effect | runtime-, state-, and concurrency-heavy |
| noble-hashes | pure compute- and typed-array-heavy (control) |

ts-morph is dropped as too similar to TypeDoc. The noble-hashes study also tests the lowering itself: how much profiled CPU is syntactically lowerable, semantically provable, and worth running natively? JavaScript's 32-bit bitwise semantics may be the missing IR piece there.

**Compiler frontend.** TypeScript 7 with the projects' compilers falls back to the bundled TypeScript 5.9; the report records which compiler was used. This is a side issue; nothing more is pursued here. Possible future backends:

- the TypeScript 7.1 API, which the TypeScript docs announce as a new compiler API
- a `bun check` API, if one appears

The architectural boundary for them is a `CompilerFrontend` (TS 5/6 JS API today) behind `CompilerFacade`. A faster native checker would also remove CrankTS's own 95% bottleneck without CrankTS optimizing it. For CrankTS itself that would be an execution-strategy recommendation (`SWITCH_CHECKER`), not a kernel.

**Lessons from v0.2.4–v0.2.6b that shape the next steps:**

- **Load-sensitive measurements:** evaluations run round-robin across fresh processes, with `--expose-gc` and the load average recorded, and report ratios.
- **Hidden O(n) work:** a transformation can add O(n) work that the original only does on rare paths (the `localeCompare` rank). Validation compares against the original's actual paths.
- **Brittle chaining:** chained patched copies work but are brittle; v0.2.7 replaces them.

### Decision after the sixth review round (2026-10-11)

**Primary direction: A, evidence-driven performance diagnosis.** This is a GO to validation; A is not yet proven as a product.

| Track | Status | Meaning |
| --- | --- | --- |
| A, evidence and diagnosis | **GO to validation** | Evidence graph, caller attribution, runtime identity/content/repetition evidence, conservative phenomena, hypotheses with upper bounds; experiments and validation stay with the human or agent until the ablation shows they are the bottleneck |
| B, general TS→native lowering, static or dynamic-native tier | **STOP** | Gain ceiling: hand-written Rust is 1.75× on a numeric kernel and scriptc native builds are slower than V8 (0.09–0.17×); compilability ≠ profitability |
| Native backend (Kernel IR, Rust, proofs, fallback, parity, gates) | **feature freeze** | Kept as an opportunistic backend; native work starts only at an expected whole-workload gain ≥ 10% |
| P, parallel execution | **native pool: STOP; pipeline parallelism: part of A** | No native thread pool: IntentWeave's parallel stage is already taken by `worker_threads` (2.87× on the stage, MVP-7a), and a native pool would add ≤ 10% of the whole workload. Pipeline-level parallelism in async code is real (closed-source project: Amdahl ceiling 1.4–1.7×), but CPU profiles lose stacks at `await`, so CrankTS cannot see it yet. A stage view (async roots, idle share, serial sinks) is an evidence feature for A, built after the ablation ([eval-generalization.md](eval-generalization.md#parallel-execution-screening-track-p)) |
| S, profile-guided guarded specialization | **hold** | Only after a TypeScript-only specialization test of the same hot spot leaves a real gap for native code |
| v0.2.7 `TransformationPlan` | **parked** | Only for validated findings that are mechanically supported |

**Product gate** (superseded on 2026-10-13: the ablation is parked; see the seventh review round below)**:** a blind agent ablation on unseen code bases with three arms: raw profile and source (P), plus CrankTS evidence (E), plus CrankTS hypotheses (H). Metrics: validated findings and gain (denominator: union over the arms plus a time-boxed independent pass), precision, time and tokens to the first useful finding, several runs per arm.

**Exit criterion** (superseded on 2026-10-13; see below)**.** If E does not clearly beat P (more validated gain, or the same gain at clearly lower cost), and P/S do not pass their gates, CrankTS ends as a research result: a final write-up of what generalized (call-site attribution, evidence probes, fail-closed lowering with proofs) and what did not (pattern recognition per hotspot, TS→native gain), with no further product work.

### Decision after the seventh review round (2026-10-13): Observe

The seventh round ([review.md](review.md)) moves CrankTS from pattern recognition and advice to **code-level runtime observability for coding agents**. CrankTS measures a real workload, attributes it to stable TypeScript code entities, and serves the result to an agent over CLI, JSON, and MCP. It does not interpret. The analyses built so far (call graph, effects, call-site attribution, caller paths, dependency and native-boundary classification) feed that model rather than a recommender.

| Track | Status |
| --- | --- |
| **Observe (v0.3 → v0.4)** | **current plan**: [observe-plan.md](observe-plan.md) |
| Agent ablation (P/E/H) | **parked, not run**. The material stays in [evaluation/ablation](../evaluation/ablation/) and the protocol in [ablation-protocol.md](ablation-protocol.md); revisit with Observe output as the evidence arm (v0.5 outlook) |
| v0.2.7 `TransformationPlan`, Advisor v2, automatic selection | parked |
| Native backend | feature freeze, as decided in the sixth round |

**Gates now:** the Observe M0 gate (the Observe output on IntentWeave is clearly easier for an agent to use than the `analyze --profile` JSON) and the M4 gate (an agent finds hotspots and caller paths through MCP alone, plus a short non-blinded comparison against the raw profile). They replace the ablation as the product gate. If the M0 gate fails, the exit criterion above applies in spirit: CrankTS ends as a research write-up.

### Open point: a faster TypeScript checker

TypeScript itself dominates CrankTS's own runtime: 95% of W1 wall time is spent in compiler-bound stages (MVP-9a). TypeScript 7 (the Go port, stable since July 2026) would be the lever for that. CrankTS, however, depends on the full checker API (`getTypeAtLocation`, symbols, signatures), and it is not confirmed that TypeScript 7 exposes it to JavaScript. Rust checkers (stc, Ezno) do not implement full TypeScript semantics.

Decision: keep the TypeScript 5.x API behind `CompilerFacade` and re-evaluate TypeScript 7 once its programmatic checker API is available. Analysis speed affects how quickly CrankTS itself runs, not the results it produces.

Update 2026-10-13: `typescript@7.0.2` is the npm `latest`. It exports only `typescript/unstable/{sync,async,ast,…}`; the classic `ts.*` API is gone. `unstable/sync` has a `Checker` with `getTypeAtLocation`, `getSymbolAtLocation`, `getResolvedSignature`, and `getTypeOfSymbol`, so a programmatic checker API exists, but it is marked unstable. CrankTS keeps `typescript@^5.9.3` (the caret excludes 7). Adoption is a spike at the start of Observe v0.4: a `CompilerFrontend` on `unstable/sync` with 5.9 as the fallback. Observe M0–M5 needs no checker and parses with `oxc-parser`. See [observe-plan.md §16](observe-plan.md#16-toolchain).

## Open Points

- **Workload size:** resolved. W1 is too small for any graph-kernel wall gain (0.7%), and MVP-9b replaced W3 with scaled replays of the real graph.
- **Wall-gate default:** "meaningful" is set here to ≥ 5% and > 2× spread. Adjust if a different threshold is preferred.
- **IntentWeave refactor for v0.2a:** extracting the ASCII scan function is a change in the IntentWeave repository and must happen there separately.
