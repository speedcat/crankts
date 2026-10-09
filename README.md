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
