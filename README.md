# crankts
Crank up your TS!

# Initial Specification v0.1

## 1. Summary

**CrankTS** is a static analysis and optimization tool for existing TypeScript applications.

Its initial goal is to identify code regions that are good candidates for execution outside the JavaScript runtime, especially where native execution could improve:

- CPU throughput
- memory usage
- multicore utilization
- data locality
- garbage collection pressure

CrankTS does **not** initially replace Node.js, V8, Bun, or the TypeScript compiler.

Instead, it analyzes an existing TypeScript application and identifies **native islands**: statically constrained regions that could later be extracted into native implementations such as Rust/N-API, WebAssembly, or direct native code.

The long-term goal is:

> Keep TypeScript for orchestration and dynamic application logic while transparently moving suitable compute-heavy regions toward more efficient native execution.

---

# 2. Motivation

Modern TypeScript/JavaScript runtimes provide excellent performance for many workloads.

However, several structural limitations remain relevant for data-intensive backend applications:

1. JavaScript execution within one runtime isolate is primarily single-threaded.
2. Parallel CPU workloads require explicit worker-based architectures.
3. Large object graphs can have substantial memory overhead.
4. Dynamic object representations reduce cache locality.
5. Large heaps increase garbage collector pressure.
6. TypeScript type information is erased before execution.
7. V8 must rediscover runtime type information through profiling and speculation.

These limitations are particularly visible in workloads such as:

- graph construction
- graph traversal
- indexing
- parsing
- correlation
- ranking
- static analysis
- large-scale transformations
- similarity calculations
- compiler pipelines
- in-memory analytical workloads

A complete rewrite of an application in Rust or C++ is usually not economically justified.

CrankTS instead attempts to identify the parts where such a rewrite would actually provide value.

---

# 3. Core Concept

CrankTS separates a TypeScript program conceptually into different execution domains.

```text
                    TypeScript Application
                             │
                             ▼

                            Every call edge also carries a runtime `boundaryKind`, orthogonal to its syntactic call `kind`: `LOCAL_DIRECT`, `LOCAL_METHOD`, `LOCAL_CALLBACK`, `LOCAL_CONSTRUCTOR`, `STDLIB_PURE`, `STDLIB_COLLECTION`, `STDLIB_RUNTIME`, `NODE_IO`, `DATABASE`, `NETWORK`, `PROCESS`, `EXTERNAL_TYPED`, `EXTERNAL_UNKNOWN`, `DYNAMIC`, or `UNRESOLVED`. Island reports retain raw entry/exit counts, count effective edges only when their diagnostic cost is non-zero, and show the boundary-kind histogram.

                      CrankTS Analyzer
                             │
              ┌──────────────┴──────────────┐
              │                             │
       Dynamic / Managed                Native-friendly
              │                             │
              ▼                             ▼
          Node / V8                  Native candidate
                                        region
```

The initial version performs only the analysis.

Future versions may transform:

```text
Native candidate
       │
       ├── Rust / N-API
       ├── WebAssembly
       ├── Cranelift
       └── other backends
```

The runtime boundary must remain explicit internally even if the developer-facing API eventually becomes transparent.

---

# 4. Design Principles

## 4.1 Existing TypeScript remains valid

CrankTS must not require a new TypeScript dialect for initial adoption.

The developer should be able to run:

```bash
crankts analyze src/
```

against an existing project.

No mandatory annotations such as:

```ts
@native
function foo() {}
```

should be required.

Annotations may later exist as hints or constraints but should not be required to discover optimization opportunities.

---

## 4.2 Native execution is an optimization, not semantics

The observable program behavior must not change merely because CrankTS considers a region native-friendly.

If semantics cannot be preserved, the region remains in JavaScript.

Conceptually:

```text
cannot prove safety
      ↓
leave untouched
```

rather than:

```text
cannot prove safety
      ↓
reject application
```

---

## 4.3 Optimize regions, not isolated functions

Crossing JS/native boundaries has a cost.

CrankTS should therefore prefer:

```text
function A
  ↓
function B
  ↓
function C
```

as one native island rather than generating three independent transitions.

Native suitability is therefore fundamentally a **call-graph problem**, not merely a function-level property.

---

## 4.4 Performance potential and compilability are different

A function can be fully statically analyzable and still be a poor native candidate.

Example:

```ts
async function loadUser(id: string) {
    return database.query(...);
}
```

Possible output:

```text
Static suitability: 100%
Native performance benefit: LOW
Reason: dominated by external I/O
```

CrankTS therefore distinguishes:

### Static Suitability

Can this region safely be represented outside the dynamic JS runtime?

### Optimization Potential

Would moving it outside the JS runtime plausibly improve performance or memory behavior?

---

# 5. v0.1 Scope

CrankTS v0.1 is an **analysis-only tool**.

It performs:

1. TypeScript project loading
2. type analysis
3. call graph construction
4. detection of dynamic language features
5. basic side-effect/effect analysis
6. native-suitability scoring
7. basic performance-opportunity scoring
8. native-island discovery
9. human-readable reports
10. machine-readable reports

CrankTS v0.1 does **not**:

- generate Rust
- compile native code
- modify source code
- replace Node.js
- replace V8
- implement Node APIs
- execute application code
- automatically benchmark functions

---

# 6. Inputs

Primary input:

```bash
crankts analyze .
```

Optional target:

```bash
crankts analyze src/graph/
```

or:

```bash
crankts analyze src/graph/buildGraph.ts
```

CrankTS should load the project's existing:

```text
tsconfig.json
package.json
source files
type declarations
```

Where possible it should use the standard TypeScript compiler APIs rather than reimplementing TypeScript parsing or type resolution.

---

# 7. Static Suitability Analysis

Each relevant symbol/function receives a static suitability assessment.

Initial signals include the following.

## Positive signals

- fully resolved parameter types
- fully resolved return type
- primitive numeric operations
- TypedArray usage
- homogeneous arrays
- closed interfaces
- closed call graph
- locally allocated objects
- pure helper functions
- deterministic property access
- loops over typed collections

## Negative signals

- `any`
- unresolved `unknown`
- `eval`
- `Function(...)`
- `Proxy`
- dynamic property access
- prototype mutation
- monkey patching
- dynamic import resolution
- reflection-heavy behavior
- runtime-dependent object shapes
- unresolved external functions

Example:

```text
calculateScores()

Static suitability: 94%

+ typed parameters
+ closed return type
+ no dynamic property access
+ closed internal call graph
+ numeric loops

- external helper with unknown implementation
```

---

# 8. Dynamic Boundary Classification

CrankTS should explicitly classify reasons why code cannot safely move into a native region.

Initial blocker categories:

```text
DYNAMIC_TYPE
DYNAMIC_PROPERTY_ACCESS
UNKNOWN_EXTERNAL_CALL
REFLECTION
PROXY_USAGE
EVAL_USAGE
PROTOTYPE_MUTATION
UNSUPPORTED_ASYNC_BOUNDARY
NODE_RUNTIME_DEPENDENCY
UNKNOWN_SIDE_EFFECT
SHARED_MUTABLE_JS_STATE
```

These should be represented as structured diagnostics rather than compiler-style fatal errors.

Example:

```text
buildPluginPipeline()

Native suitability: LOW

Blockers:
- DYNAMIC_PROPERTY_ACCESS
- UNKNOWN_EXTERNAL_CALL
- SHARED_MUTABLE_JS_STATE
```

---

# 9. Effect Analysis

CrankTS should gradually infer effects such as:

```text
PURE
ALLOCATES
READS_EXTERNAL_STATE
WRITES_EXTERNAL_STATE
FILESYSTEM_IO
NETWORK_IO
DATABASE_IO
PROCESS_CONTROL
MUTATES_ARGUMENT
MUTATES_GLOBAL_STATE
SPAWNS_ASYNC_WORK
```

This helps distinguish computation from orchestration.

Example:

```text
calculateCommunities()

Effects:
ALLOCATES
MUTATES_LOCAL_STATE

No:
IO
global state
dynamic dispatch
```

This is a strong candidate.

---

# 10. Performance Opportunity Analysis

Native suitability alone is insufficient.

CrankTS should estimate potential benefit along at least three dimensions.

## CPU Potential

Signals:

- nested loops
- large iteration counts where statically inferable
- numeric computations
- hashing
- sorting
- graph traversal
- recursive algorithms
- large call counts
- repeated transformations

## Memory Potential

Signals:

- arrays of objects
- large object construction
- maps/sets with primitive keys
- repeated short-lived allocations
- graph structures
- duplicated strings
- pointer-heavy structures
- opportunities for TypedArray/native layout

## Parallelization Potential

Signals:

- independent loop iterations
- map/reduce-style computation
- no shared mutable state
- batched inputs
- graph algorithms with separable phases
- pure functions over collections

Possible output:

```text
buildDependencyGraph()

CPU potential:        HIGH
Memory potential:     VERY HIGH
Parallel potential:   HIGH
```

---

# 11. Native Island Detection

CrankTS should construct the call graph and identify maximal connected regions where native execution appears feasible.

Example:

```text
CLI
│
├── loadConfig
├── openDatabase
│
├── analyzeRepository
│    │
│    ├── normalizeSymbols
│    ├── correlateSymbols
│    ├── buildGraph
│    └── calculateCommunities
│
└── persistResults
```

CrankTS might infer:

```text
Native Island #1

normalizeSymbols
correlateSymbols
buildGraph
calculateCommunities
```

while leaving:

```text
loadConfig
openDatabase
persistResults
```

in Node.js.

---

# 12. Data Representation Opportunities

CrankTS should identify cases where native representation could reduce memory overhead.

Example TypeScript:

```ts
interface Edge {
    source: number;
    target: number;
    kind: number;
}

const edges: Edge[];
```

Potential representations:

```text
Array-of-Structs

[source:u32,target:u32,kind:u8]
[source:u32,target:u32,kind:u8]
...
```

or:

```text
Structure-of-Arrays

source: Uint32Array
target: Uint32Array
kind:   Uint8Array
```

v0.1 does not need to choose or implement the representation.

It should merely report:

```text
Potential packed representation detected.

Expected impact:
Memory: HIGH
Cache locality: HIGH
SIMD potential: MEDIUM
```

---

# 13. Initial Scoring Model

Each function receives independent scores.

Example:

```text
calculateCommunities
──────────────────────────────────
Static suitability      96 / 100
CPU opportunity         91 / 100
Memory opportunity      76 / 100
Parallel opportunity    94 / 100

Native Priority         93 / 100
```

The overall priority should not simply average all values.

A possible initial model:

```text
NativePriority =
    StaticSuitability
    ×
    max(
        CpuOpportunity,
        MemoryOpportunity,
        ParallelOpportunity
    )
```

with penalties for costly JS/native boundaries.

The exact formula should remain experimental in v0.x.

---

# 14. CLI

Initial interface:

```bash
crankts analyze
```

Optional target:

```bash
crankts analyze src/
```

Detailed report:

```bash
crankts analyze --verbose
```

Machine-readable output:

```bash
crankts analyze --format json
```

Only high-value candidates:

```bash
crankts analyze --min-score 70
```

Possible later commands:

```bash
crankts explain buildGraph
crankts graph
crankts extract
crankts build
crankts benchmark
```

---

# 15. Example Output

```text
CrankTS Analysis
════════════════════════════════════

Project:
  intentweave

Functions analyzed:
  4,281

Native-friendly:
  1,193

High-value candidates:
  27

────────────────────────────────────

#1 calculateCommunities()

Static suitability       98
CPU potential            96
Memory potential         81
Parallel potential       97

Native priority          96

Reasons:
  ✓ closed call graph
  ✓ typed collections
  ✓ no external I/O
  ✓ numeric loops
  ✓ no dynamic JS features

Recommendation:
  Rust/N-API
  parallel execution

────────────────────────────────────

#2 buildDependencyGraph()

Static suitability       94
CPU potential            88
Memory potential         97
Parallel potential       79

Native priority          94

Reasons:
  ✓ large object arrays
  ✓ stable object shape
  ✓ integer-like identifiers
  ✓ high allocation pressure

Potential representation:
  Edge[] → packed edge table

────────────────────────────────────

#3 loadRepository()

Static suitability       91
CPU potential            12
Memory potential         18
Parallel potential       22

Native priority          20

Recommendation:
  Keep in Node.js

Reason:
  dominated by filesystem I/O
```

---

# 16. Architecture

Suggested initial implementation:

```text
                  TypeScript Project
                         │
                         ▼
                TypeScript Compiler
                         │
         ┌───────────────┼────────────────┐
         ▼               ▼                ▼
     Type Graph      Symbol Graph      AST/CFG
         │               │                │
         └───────────────┼────────────────┘
                         ▼
                    Call Graph
                         │
                         ▼
                  Effect Analysis
                         │
                         ▼
                Native Suitability
                         │
                         ▼
               Opportunity Analysis
                         │
                         ▼
              Native Island Discovery
                         │
                         ▼
                       Report
```

Implementation language for v0.1 can remain TypeScript.

There is no need to use Rust until CrankTS actually starts generating or executing native code.

---

# 17. Relationship to scriptc

scriptc and CrankTS solve related but different problems.

scriptc asks:

> Can this TypeScript/JavaScript program be compiled ahead of time?

CrankTS asks:

> Which regions of an existing TypeScript application are worth moving out of the JavaScript runtime?

Therefore scriptc should initially be treated as:

- prior art
- comparative benchmark
- source of compiler ideas
- validation oracle where useful

CrankTS should not depend architecturally on scriptc.

---

# 18. Future Execution Model

The long-term model may support multiple execution tiers.

```text
                       TypeScript
                            │
                         CrankTS
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
     Dynamic JS        Managed Native      Native/Owned
          │                 │                  │
          ▼                 ▼                  ▼
         V8            Wasm/native         Rust/native
```

Possible backends:

### Rust + N-API

Best suited for:

- native data structures
- parallel algorithms
- long-lived native state
- native libraries
- maximum performance

### WebAssembly

Best suited for:

- portable compute
- simple deployment
- numeric workloads

### Cranelift/native JIT

Possible future option for:

- runtime specialization
- architecture-independent distribution
- adaptive compilation

---

# 19. v0.2 Candidate Scope

After the analyzer proves useful:

1. generate candidate interface definitions
2. generate Rust type skeletons
3. generate N-API wrappers
4. generate TS proxy/wrapper code
5. optionally translate a limited TS subset into Rust or native IR
6. benchmark JS implementation against native implementation

Example:

```bash
crankts extract calculateCommunities
```

might produce:

```text
.crank/
  calculateCommunities/
    mod.rs
    types.rs
    bindings.rs
    index.ts
```

---

# 20. Longer-Term Vision

CrankTS may eventually evolve from an analyzer into a hybrid compiler.

Instead of:

```text
TypeScript
    ↓
JavaScript
    ↓
V8
```

parts of an application could become:

```text
                  TypeScript
                       │
                     CrankTS
                       │
        ┌──────────────┴──────────────┐
        │                             │
       V8                         Native IR
                                      │
                          ┌───────────┼───────────┐
                          ▼           ▼           ▼
                        Rust        Wasm      Native JIT
```

The developer continues writing TypeScript.

CrankTS determines where the dynamic runtime is necessary and where a cheaper execution model is possible.

The guiding principle is:

> **Pay for JavaScript dynamism only where the application actually needs it.**

---

# 21. Initial Success Criteria

v0.1 is successful if it can analyze real-world TypeScript projects and:

1. identify obviously poor native candidates correctly
2. identify compute-heavy native candidates correctly
3. explain its decisions
4. discover useful function clusters rather than isolated functions
5. process a large TypeScript repository within practical developer-tooling latency
6. produce actionable recommendations on IntentWeave
7. correlate reasonably with measured CPU or memory hotspots

No native code generation is required to declare v0.1 successful.

---

# 22. Initial Dogfood Target

IntentWeave should be the first major validation project.

Initial analysis targets should focus on:

- indexing
- normalization
- symbol correlation
- dependency construction
- claim candidate processing
- graph construction
- graph analysis
- ranking
- co-occurrence/co-change computation

CLI orchestration, filesystem access, configuration loading, database access and external API integration should generally remain in Node.js unless profiling provides evidence otherwise.

This dogfood phase should answer the central CrankTS hypothesis:

> Can static analysis identify the small subset of a large TypeScript backend where native execution would materially improve CPU throughput, memory consumption or multicore utilization without requiring a full Rust rewrite?

---

# Current Implementation Status

The current v0.1 MVP is an analysis-only CLI. It loads a TypeScript project, inventories functions, resolves in-project calls, classifies typed/runtime-boundary call edges and blockers, propagates eligibility and effects, estimates CPU/memory/parallel opportunity, groups candidate components, and can optionally attach a Node/V8 CPU profile. It never executes the target program.

```bash
pnpm install
pnpm dev analyze [target]
pnpm build
node dist/cli.js analyze [target]
```

`target` may be a file or directory; it defaults to the current directory. CrankTS loads the nearest `tsconfig.json`, resolves the full project, and reports target functions together with their transitively resolved local callees. It uses the project's declared and installed TypeScript compiler when available, otherwise its bundled compiler.

The text report shows compiler provenance, `SUPPORTED` / `CONDITIONAL` / `BLOCKED` counts, candidate membership, edge counts, boundary ratio, member/boundary eligibility mix, articulation impact, size diagnostic, blocker explanations, effects, opportunity axes, and Native Priority. Eligibility and effects propagate over resolved in-project call edges, including recursive components; unresolved/external calls retain their direct diagnostics. Candidate components are weakly connected components over supported and conditional functions. No split heuristics are applied.

Static suitability starts at 100, subtracts 15 for each distinct conditional blocker category, and is 0 if any blocking signal is present. Direct effects use conservative syntax and common Node.js API heuristics; transitive effects are unions across resolved calls. CPU, memory, and parallel opportunity are independent syntax/effect heuristics, not measurements.

For each function, Native Priority is:

```text
round(staticSuitability × max(cpuOpportunity, memoryOpportunity, parallelOpportunity) / 100)
```

For a candidate island, CrankTS uses the lowest member suitability and the maximum member score on each opportunity axis, then applies the same formula. Candidate quality metrics are diagnostic only and do not change priority or WCC membership:

- `internalEdges`, `entryEdges`, and `exitEdges` count resolved calls inside and across the component boundary. An unresolved/external call from a member is an exit edge.
- `boundaryRatio = (entryEdges + exitEdges) / (internalEdges + entryEdges + exitEdges)`; it is `0` when the denominator is empty.
- `eligibilityMix` counts component members; `boundaryEligibilityMix` counts unique known functions adjacent across the boundary. Unknown external endpoints are not included in the latter.
- Articulation points are calculated on the undirected projection of resolved internal calls using Tarjan's algorithm. `largestArticulationImpact` is the removed node's count outside the largest remaining part, along with resulting part count, largest-part size, and distinct internal callers.
- `sizePenalty = max(0, memberCount - 20)` is a visible review signal only; 20 is a diagnostic reference, not a calibrated threshold.
- A shared-helper warning is emitted when the largest-impact articulation also has at least two distinct internal callers. It never triggers an automatic split.

There is no boundary-cost penalty or component-splitting heuristic yet. Analysis does not execute or modify project source files.

Machine-readable output uses a versioned JSON schema. `--min-score` filters candidate islands in the report; function summaries continue to describe the complete selected analysis scope. `--verbose` adds typed call-edge details to text output.

```bash
pnpm dev analyze test/fixtures/basic --format json
pnpm dev analyze test/fixtures/basic --verbose
pnpm dev analyze test/fixtures/basic --min-score 70
pnpm dev analyze src/ --profile ingest.cpuprofile
```

Call edges retain their syntactic `kind` and add a separate runtime `boundaryKind`: `LOCAL_DIRECT`, `LOCAL_METHOD`, `LOCAL_CALLBACK`, `LOCAL_CONSTRUCTOR`, `STDLIB_PURE`, `STDLIB_COLLECTION`, `STDLIB_RUNTIME`, `NODE_IO`, `DATABASE`, `NETWORK`, `PROCESS`, `EXTERNAL_TYPED`, `EXTERNAL_UNKNOWN`, `DYNAMIC`, or `UNRESOLVED`. The report summarizes raw and effective entry/exit edges plus counts by boundary kind. Effective counts omit kinds with zero diagnostic cost. Boundary cost units and `LOW` / `MEDIUM` / `HIGH` risk are experimental diagnostics only; they do not modify Native Priority.

Current diagnostic units per crossing edge are: local calls/callbacks and pure/collection standard-library calls `0`; standard runtime and typed external `1`; Node I/O and unknown external `4`; database/process/unresolved `6`; network/dynamic `8`. Risk is `HIGH` if any database, network, process, dynamic, or unresolved edge is present; otherwise `MEDIUM` for Node I/O, unknown external, or at least 8 aggregate units; otherwise `LOW`. These are review aids, not calibrated native-transition costs.

`--profile` accepts Node/V8 `.cpuprofile` JSON with aligned `samples` and `timeDeltas`. CrankTS matches frames to project functions by source path and function name, with common `dist`/`build` JavaScript paths mapped back to `src` TypeScript paths. Source maps, inline/eval frames, and call counts are not inferred. Reports show function/island self CPU, inclusive CPU, sample share, matched-profile coverage, and confidence. When a profile is present, candidate presentation order uses observed island self CPU with static priority as a tie-breaker; `nativePriority` itself is unchanged. High confidence currently requires at least 80% matched sample time and 100 matched samples; medium requires at least 50% and 25 samples; otherwise confidence is low. This is CPU evidence only; heap/allocation profiles are not supported.

The provisional IntentWeave source-review labels are available as machine-readable data in [evaluation/intentweave-index-top16.json](evaluation/intentweave-index-top16.json). They are not profiler-backed ground truth.

No `.cpuprofile` was present in the IntentWeave workspace during this review. The profile-ingestion path is validated with deterministic synthetic V8 samples only; a real IW hotness ranking remains pending an actual captured profile.

Run the fixture suite and static checks with:

```bash
pnpm test
pnpm typecheck
pnpm build
```

### Initial IntentWeave Dogfood

Read-only package-level analyses were run on 2026-10-10 with Node 22.19 and the project's TypeScript 5.9.3:

| Target | Wall time | Functions (supported / conditional / blocked) | Candidate islands / largest |
| --- | ---: | ---: | ---: |
| `packages/index/src` | ~1.7 s | 1,739 (487 / 1,057 / 195) | 334 / 283 |
| `packages/analyzer/src` | ~0.8 s | 270 (74 / 149 / 47) | 105 / 20 |

### Existing IntentWeave Rust/TypeScript Comparison

IntentWeave already has an end-to-end comparison harness in `packages/cli/src/commands/indexBuildParity.test.ts`. It builds isolated workspaces through the TypeScript path (`--no-native`) and Rust `cari-build`, then compares indexed files, exported functions, and selected SQLite table counts. The Rust CLI documents the same six stage boundaries as the TypeScript pipeline and can emit per-stage timings with `--verbose`.

The existing parity test passed on a tiny fixture and printed `nativeMs=1388`, `tsMs=494`, `ratio=2.81`; Rust was slower for this small input, where process startup and full-pipeline fixed costs dominate. This is a useful correctness/benchmark harness blueprint, not evidence that Rust is slower on a representative repository. It also benchmarks the whole index build, not an individual CrankTS candidate, and does not measure peak RSS or allocations. A realistic comparison should reuse its isolated inputs/output databases, validate full normalized DB parity, run repeated warm/cold samples, capture stage timings and peak RSS, then profile the specific TypeScript candidate separately. No CrankTS score weights were changed from this result.

#### Rust Port Split vs CrankTS Signals

The native implementation is a whole-pipeline `cari-build` subprocess selected instead of the TypeScript fallback; it is not a set of N-API islands. The table compares its ported stages to the corresponding TypeScript source files analyzed by CrankTS. These are stage-level correlations, not proof that the Rust stages were selected because of CrankTS-like scoring.

| Rust stage | TypeScript counterpart | Functions | Priority ≥70 | Highest priority | Read against actual split |
| --- | --- | ---: | ---: | --- | --- |
| AX | `analyzer/src/stages/ax.ts` + AX helpers | 64 | 0 | 53 `correctPredicateViolations` | Under-ranked by current opportunity heuristics; the port also covers parsing and filesystem traversal. |
| KWX | `analyzer/src/stages/in.ts`, `kwg/kwxStage.ts`, `heuristicExtractor.ts` | 37 | 2 | 85 `aggregateEntities` | Strong compute/data-volume alignment. |
| COX | `analyzer/src/kwg/coxStage.ts` | 5 | 1 | 70 `computeDocumentEdges` | Direct alignment with collection-pair computation. |
| TCG | `analyzer/src/tcg/{tcx,coc,hot,own,stl}Stage.ts` | 37 | 3 | 81 `computeGini` | Several local compute stages rank highly; git-history loading remains I/O-bound. |
| IDF | `index/src/idf.ts` | 1 | 0 | 47 `computeIdf` | Small isolated scoring stage; below the current cutoff. |
| Annotate | `index/src/annotator.ts` | 12 | 0 | 52 `annotate` | Per-mention matching is conditional and allocation-heavy, but not highly ranked. |
| Write | `index/src/writer.ts` | 47 | 0 | 67 `snapshotConformance` | Mostly SQLite persistence and schema work; low native-island signal is plausible. |

The stage map and counts are stored in [evaluation/intentweave-rust-split.json](evaluation/intentweave-rust-split.json). The earlier Top-16 candidates are mostly query/report code outside the `cari-build` pipeline, so comparing those candidates directly to this Rust split would be an apples-to-oranges evaluation.

The AX function count covers the analyzer AX implementation and helpers; TypeScript file discovery/orchestration (`discoverFiles` and `buildFromPaths`) lives in `packages/index/src/facade.ts` and is recorded separately in the stage-map JSON. Rust folds filesystem walking into its AX stage.

In the index package, 16 of 334 candidate islands scored at least 70. The largest component is conditional, scored 55, and has 1,354 raw exit edges. A separate connectivity check found 59 articulation functions in it; the highest-impact ones include query entry points, and no single function has unusually high fan-in. The analyzer package's largest component is 20 functions.

For the 16 priority-70 index candidates, there are 1,142 raw exits and 439 effective exits. Their boundary-kind histogram includes 24 `LOCAL_DIRECT`, 650 `STDLIB_COLLECTION`, 33 `STDLIB_PURE`, 6 `STDLIB_RUNTIME`, 152 `DATABASE`, 188 `EXTERNAL_TYPED`, and 93 `EXTERNAL_UNKNOWN` directed boundary appearances. Twelve candidates are `HIGH` risk and four are `MEDIUM`; the largest graph-analysis candidate has 271 raw exits but 49 effective exits and `MEDIUM` risk. No real IW `.cpuprofile` was supplied for this review.

These results confirm that WCC can group large regions, but do not yet establish a reliable automatic split rule. Components remain unsplit candidate regions; scores and edge boundaries should guide further review, not be read as measured performance. Each package was analyzed using its own `tsconfig.json`: the monorepo root config is a solution config with no source files, so source-level calls across package references are outside these per-package call graphs.

### Index Top-16 Source Review

The 16 `packages/index/src` candidates with priority at least 70 were manually reviewed against their entry-point implementations. These are provisional source-review labels, not profiler-backed ground truth; machine-readable labels and reason tokens live in [evaluation/intentweave-index-top16.json](evaluation/intentweave-index-top16.json). `S/C/B` means supported/conditional/blocked members; `I/E/X` means internal/entry/exit call edges. Boundary ratio is the diagnostic ratio defined above. Components remain unchanged and unsplit.

| # | Main region | Priority | Members | S/C/B | I/E/X | Raw/Effective exits | Risk | Boundary | Largest articulation (impact) | Size penalty | Review |
| ---: | --- | ---: | ---: | --- | --- | ---: | --- | ---: | --- | ---: | --- |
| 1 | `analyzeFocusInsights` | 70 | 74 | 42/32/0 | 95/0/271 | 271/49 | MEDIUM | 0.740 | `analyzeFocusInsights` (37) | 54 | `GOOD_NATIVE_CANDIDATE` |
| 2 | `insightsBook` graph renderer | 70 | 17 | 7/10/0 | 16/0/43 | 43/13 | MEDIUM | 0.729 | `buildFileLevel` (10) | 0 | `BAD_CANDIDATE` |
| 3 | `reportFromDb` | 70 | 12 | 5/7/0 | 11/0/49 | 49/32 | HIGH | 0.817 | `reportFromDb` (8) | 0 | `BAD_CANDIDATE` |
| 4 | `testIntentFromDb` | 70 | 6 | 2/4/0 | 5/0/19 | 19/10 | HIGH | 0.792 | `testIntentFromDb` (4) | 0 | `MAYBE` |
| 5 | `traceFromDb` | 70 | 5 | 2/3/0 | 4/0/30 | 30/12 | HIGH | 0.882 | `traceFromDb` (3) | 0 | `MAYBE` |
| 6 | `ruleCoverageFromDb` | 70 | 7 | 2/5/0 | 7/0/40 | 40/16 | HIGH | 0.851 | `ruleCoverageFromDb` (5) | 0 | `BAD_CANDIDATE` |
| 7 | `testCoverageFromDb` | 70 | 16 | 7/9/0 | 18/0/81 | 81/29 | HIGH | 0.818 | `testCoverageFromDb` (12) | 0 | `MAYBE` |
| 8 | `mentionsOfFromDb` | 70 | 7 | 1/6/0 | 6/0/21 | 21/10 | HIGH | 0.778 | `mentionsOfFromDb` (5) | 0 | `BAD_CANDIDATE` |
| 9 | `parseArchitectureYaml` | 70 | 6 | 0/6/0 | 17/0/39 | 39/27 | MEDIUM | 0.696 | `parseArchitectureYaml` (4) | 0 | `BAD_CANDIDATE` |
| 10 | `consistency` / `livingScore` / `verify` | 70 | 31 | 19/12/0 | 36/3/122 | 122/48 | HIGH | 0.776 | `computeSpecCoverage` (13) | 11 | `MAYBE` |
| 11 | `deadFeaturesFromDb` | 70 | 6 | 3/3/0 | 5/0/49 | 49/21 | HIGH | 0.907 | `deadFeaturesFromDb` (4) | 0 | `MAYBE` |
| 12 | `diagramEntityCheck` / `resolveComponent` | 70 | 26 | 13/13/0 | 33/0/137 | 137/58 | HIGH | 0.806 | `diagramEntityCheckFromDb` (13) | 6 | `BAD_CANDIDATE` |
| 13 | `impactFromDb` | 70 | 15 | 8/7/0 | 14/0/58 | 58/20 | HIGH | 0.806 | `impactFromDb` (10) | 0 | `MAYBE` |
| 14 | `interfaceConformanceFromDb` | 70 | 8 | 4/4/0 | 8/0/36 | 36/23 | HIGH | 0.818 | `interfaceConformanceFromDb` (6) | 0 | `MAYBE` |
| 15 | `nameLayers` | 70 | 10 | 4/6/0 | 9/0/26 | 26/5 | MEDIUM | 0.743 | `nameLayers` (5) | 0 | `BAD_CANDIDATE` |
| 16 | `checkSequenceDiagram` | 70 | 38 | 22/16/0 | 44/1/121 | 121/66 | HIGH | 0.735 | `checkSequenceDiagram` (19) | 18 | `BAD_CANDIDATE` |

Review reasons:

- **#1 GOOD:** in-memory graph/layer analysis repeatedly scans node and edge collections; cluster computations are independent and data-heavy. The callback-heavy WCC inflates the 74-member size and 0.740 boundary ratio, so a profile should confirm that this work is actually hot.
- **#2 BAD:** graph layout and SVG/DOM rendering are presentation work, not a native compute island.
- **#3 BAD:** SQL aggregates and report-table scans dominate.
- **#4 MAYBE:** scans test descriptions and symbol names, then applies string-pattern matching; could be data-heavy, but database reads may dominate.
- **#5 MAYBE:** performs graph BFS, but issues database queries while expanding the frontier and caps the default result at 50 nodes.
- **#6 BAD:** performs SQLite lookups for rule participants; predominantly database I/O.
- **#7 MAYBE:** scans symbols/imports and builds cross-reference maps; potentially data-heavy, but read/DB cost needs profiling.
- **#8 BAD:** performs a small number of SQLite lookups followed by bounded deduplication and sorting.
- **#9 BAD:** parses a small architecture configuration; likely a trivial helper cluster rather than a sustained workload.
- **#10 MAYBE:** includes relationship conflict comparisons and derived scores, but also broad database reads, 122 exits, and a size penalty of 11.
- **#11 MAYBE:** combines whole-index scans with set-based signal matching; may become data-heavy on large indexes, but current evidence points to DB-bound work.
- **#12 BAD:** performs repeated SQLite lookups per component/alias; mostly I/O with many exits.
- **#13 MAYBE:** contains reverse-import BFS and data joins for co-change/document impact; graph work may matter at scale, but the entry point is DB-backed.
- **#14 MAYBE:** compares class/interface members and signatures after database scans; data-heavy CPU work is plausible, not measured.
- **#15 BAD:** constructs prompts and calls an external LLM; async/network latency dominates.
- **#16 BAD:** checks diagram edges against calls/imports in SQLite; diagrams are bounded input and the work is mostly I/O.

Calibration result: this selected set has no score spread; all 16 candidates score exactly 70. The source review yields 1 `GOOD_NATIVE_CANDIDATE`, 7 `MAYBE`, and 8 `BAD_CANDIDATE`. That is a useful false-positive warning for the current cutoff, but not enough data to fit score coefficients. I have not changed priority. In particular, raw boundary ratio alone would penalize the promising graph-analysis candidate, and the current edge count includes many callback and standard-library calls that may not map one-to-one to runtime transitions. A scoring change should wait for edge-kind-aware boundary costs, a broader labeled sample, and profiler evidence.
