# Analysis Details and Evaluation History

This document collects the technical report contract, original design context, and IntentWeave measurements previously embedded in the README. Historical results are snapshots from 2026-10-10, not current performance guarantees. See the [README](../README.md) for product positioning, usage, and the active roadmap.

## Design Context

CrankTS began as an analysis-only native-island discovery tool. The core hypothesis remains: a small subset of a large TypeScript backend may benefit from cheaper execution without a full application rewrite.

The original design distinguished static suitability from optimization value and preferred connected regions over isolated functions to limit runtime crossings. Initial targets included graph construction/traversal, indexing, parsing, correlation, ranking, and large-scale transformations. Configuration, filesystem access, database access, and external API orchestration were expected to remain in Node.js unless measurements justified otherwise.

Positive suitability signals included resolved types, numeric operations, typed collections, stable object shapes, local allocations, and closed calls. Negative signals included `any`, unresolved `unknown`, reflection, `eval`, `Proxy`, prototype mutation, dynamic property access, and unresolved external behavior. These produce diagnostics rather than rejecting the application.

Data-representation opportunities included replacing pointer-heavy object arrays with packed array-of-structs or structure-of-arrays layouts. Such opportunities are not equivalent to measured memory savings or qualified transformations.

The product has expanded from native-candidate discovery into deterministic strategy selection and planned transformation. Existing TypeScript remains valid, no discovery annotations are required, and native execution is an optimization rather than a change in semantics. Rust/N-API is a prospective backend; WebAssembly and Cranelift/native JIT are longer-term possibilities. CrankTS is not a replacement for Node.js, V8, Bun, or the TypeScript compiler.

scriptc is prior art for ahead-of-time compilation, not an architectural dependency. CrankTS instead asks which regions of an existing application are worth accelerating.

## Analysis Scope and Reports

The CLI loads the nearest `tsconfig.json`, resolves the project, and reports selected functions plus transitively resolved local callees. It prefers the project's declared and installed TypeScript compiler, falling back to its bundled compiler. It never executes the analyzed target application or modifies its source.

Eligibility and effects propagate through resolved in-project call edges, including recursive components. External and unresolved calls retain direct diagnostics. Effects use conservative syntax and common Node.js API heuristics; transitive effects are unions across resolved calls.

Candidate islands are weakly connected components over supported and conditional functions. They remain unsplit. Package-only analysis does not follow source-level calls across project references; opt-in workspace/project-reference resolution is planned.

The JSON report uses schema version 2. Existing function, island, and `nativePriority` fields remain; v2 adds `workloadLabel`, optional `allocationProfile` and `pipeline` evidence, and `acceleration` assessments. `--min-score` filters reported islands, not the complete selected function summaries. `--verbose` includes typed call edges and region-level parallelism evidence.

### Static Scoring

Static suitability starts at 100, subtracts 15 per distinct conditional blocker category, and becomes 0 when any blocking signal is present. CPU, memory, and parallel opportunity are independent syntax/effect heuristics, not measurements.

```text
Native Priority = round(staticSuitability
  * max(cpuOpportunity, memoryOpportunity, parallelOpportunity) / 100)
```

An island uses its lowest member suitability and the maximum member score on each opportunity axis. Boundary diagnostics and parallelism classification do not alter this formula. When a CPU profile is attached, presentation order uses observed island self CPU, with static priority as a tie-breaker.

### Component Diagnostics

- `internalEdges`, `entryEdges`, and `exitEdges` count directed calls inside/across the component. An unresolved or external member call counts as an exit.
- `boundaryRatio = (entryEdges + exitEdges) / (internalEdges + entryEdges + exitEdges)`, or 0 for an empty denominator.
- `eligibilityMix` counts members; `boundaryEligibilityMix` counts unique known adjacent functions, excluding unknown external endpoints.
- Articulation points use Tarjan's algorithm on the undirected internal-call projection. Impact counts nodes outside the largest remaining part after removal, alongside part count, largest-part size, and distinct internal callers.
- `sizePenalty = max(0, memberCount - 20)` is diagnostic only, not a calibrated threshold or priority penalty.
- A shared-helper warning appears when the largest-impact articulation has at least two distinct internal callers. It does not split the component.

Each call has a syntactic `kind` and an orthogonal runtime `boundaryKind`. Effective edge counts omit kinds with zero diagnostic cost; reports retain raw counts and the boundary-kind histogram.

| Boundary kinds | Diagnostic units per edge |
| --- | ---: |
| `LOCAL_DIRECT`, `LOCAL_METHOD`, `LOCAL_CALLBACK`, `LOCAL_CONSTRUCTOR`, `STDLIB_PURE`, `STDLIB_COLLECTION` | 0 |
| `STDLIB_RUNTIME`, `EXTERNAL_TYPED` | 1 |
| `NODE_IO`, `EXTERNAL_UNKNOWN` | 4 |
| `DATABASE`, `PROCESS`, `UNRESOLVED` | 6 |
| `NETWORK`, `DYNAMIC` | 8 |

Risk is `HIGH` with any database, network, process, dynamic, or unresolved edge; otherwise `MEDIUM` with Node I/O, unknown external calls, or at least eight aggregate units; otherwise `LOW`. These units are review aids, not calibrated native-transition costs.

### Parallelism

The separate conservative pass records loops and `Promise.all(map(...))` regions, read/write sets, shared writes, effects, explanations, and loop-carried RAW/WAR/WAW evidence. Classifications are `PARALLEL_DOALL`, `PARALLEL_MAP_REDUCE`, `PARALLEL_PARTITIONABLE`, `PARALLEL_PIPELINE`, `PARALLEL_WITH_SYNCHRONIZATION`, `SEQUENTIAL_DEPENDENCE`, and `UNKNOWN`.

Aliases, dynamic keys, unresolved calls, and external state limit confidence. Keyed writes suggest partitioning but do not prove unique keys. `Promise.all` identifies an async batch, not CPU parallelism.

## Workload Evidence

### CPU Profiles

`--profile` accepts Node/V8 `.cpuprofile` JSON with aligned `samples` and `timeDeltas`. Frames match by source path and function name; common `dist`/`build` JavaScript paths map back to `src` TypeScript. Source maps, inline/eval frames, and call counts are not inferred.

Reports include self/inclusive CPU, sample share, matched coverage, and confidence. High confidence requires at least 80% matched sample time and 100 matched samples; medium requires at least 50% and 25; otherwise it is low. Package-scope coverage can overlap and must not be added.

### Allocation Profiles

`--heap-profile` accepts Node/V8 `.heapprofile` JSON. `sample.size` represents sampled allocated bytes, not retained heap, RSS, or allocation rate. Self and inclusive allocation shares are separate; mapped ancestors receive inclusive bytes even when the sampled leaf is an unmapped runtime frame. Inclusive bytes overlap and must not be summed across functions.

Allocation confidence is separate from CPU confidence. With zero matched function samples and low coverage, memory/layout potential remains `UNKNOWN`, not zero.

### Pipeline Descriptors

`--pipeline` accepts a versioned JSON manifest. Stage entry paths are relative to `projectRoot`; entries outside the selected project remain unresolved. Validation rejects duplicate/unknown IDs and dependency cycles.

Stages declare work-unit grain, scheduling, input sharing, aggregation, dependencies, optional sink IDs, and optional optimization evidence. `independentWork: CANDIDATE` means declared read-only units with compatible aggregation, not proven runtime independence. `ASYNC_IO` is not CPU parallelism.

Sink adapters are `SQLITE`, `BETTER_SQLITE3`, `NODE_SQLITE`, and `GENERIC`, with optional writer-mode, transaction, and ordered-commit declarations. The SQLite adapters default to a single writer unless explicitly overridden; generic sinks remain `UNKNOWN` without a declaration. Scaling-risk reports are structural, not measured contention. The initial manifest is [intentweave-pipeline.json](../evaluation/intentweave-pipeline.json).

### Deterministic Recommendations

Assessments separate `feasibility`, `staticOpportunity`, `observedWorkload`, and `optimizationPotential`. Actions are `KEEP_TS`, `OPTIMIZE_ALGORITHM`, `PARALLELIZE`, `CHANGE_DATA_LAYOUT`, `MOVE_OFF_EVENT_LOOP`, `NATIVE_OFFLOAD`, `BATCH_IO`, and `REMOVE_SERIALIZED_SINK`; only evidence-backed rules emit an action.

Algorithm/layout manifest hints are declared evidence, not inferred facts. Self-CPU review bands are 20% (`VERY_HIGH`), 10% (`HIGH`), and 2% (`MEDIUM`), all provisional. Low coverage caps native potential and remains attached to provisional recommendations. No recommendation currently triggers generation or execution.

## IntentWeave Evaluation History

Raw profiles and databases were stored under `/tmp`, not in Git. Checked-in JSON files retain the measurement summaries and source-review labels.

### Initial Package Analyses

Read-only analyses used Node 22.19 and project TypeScript 5.9.3:

| Target | Wall time | Functions (supported / conditional / blocked) | Islands / largest |
| --- | ---: | --- | --- |
| `packages/index/src` | ~1.7 s | 1,739 (487 / 1,057 / 195) | 334 / 283 |
| `packages/analyzer/src` | ~0.8 s | 270 (74 / 149 / 47) | 105 / 20 |

The largest index component was conditional, priority 55, with 1,354 raw exits. A connectivity check found 59 articulation functions, including query entry points; no single function had unusually high fan-in. This did not justify an automatic split rule.

### Existing Rust Comparison

IntentWeave's `indexBuildParity.test.ts` compared isolated TypeScript (`--no-native`) and Rust `cari-build` workspaces using indexed files, exported functions, and selected table counts. A tiny-fixture test passed and measured 1,388 ms native versus 494 ms TS (ratio 2.81). Startup and fixed costs matter; this was neither a representative workload nor a candidate-level benchmark, and it did not measure RSS/allocations.

Rust runs a whole-pipeline subprocess, not N-API islands. Its stage mapping is in [intentweave-rust-split.json](../evaluation/intentweave-rust-split.json). KWX/COX aligned with compute signals; AX was under-ranked, while persistence had low island signal. The Top-16 query/report candidates were mostly outside this pipeline. Rust discovery is inside AX; TS discovery/orchestration lives separately in the index facade.

### Initial Full-Workspace Profile

A legacy-root full-depth TS build with `--no-native` and 1 ms V8 sampling took about 35 s; an unprofiled run was similar. Package-profile coverage was 64.18% for analyzer and 68.4% for index (overlapping medium-confidence scopes).

| Work | TS | Rust `cari-build` |
| --- | ---: | ---: |
| AX | 7.6 s | 0.11 s |
| IN + KWX + COX aggregate / KWX | 23.3 s | 0.04 s |
| COX | Included above | 0.04 s |
| TCG | 2.5 s | 2.05 s |
| Annotate | <0.1 s | 0.02 s |
| Write | 1.12 s | 1.13 s |
| Whole command | ~35 s | 4.3 s |

These are **not equal-output speedups**. Stage boundaries differ; TS indexed 256 AX files and 56,163 mentions/annotations, versus Rust's 346 source files and 49,737 annotations. Final TS/Rust counts differed: files 711/378, symbols 7,172/6,220, imports 733/1,322, co-occurrences 16,108/17,228, and co-changes 914/918.

`HeuristicKeywordExtractor.extractDictionary` consumed 10.94 s self CPU (31.1%, 21.24 s inclusive) with static priority 30. By contrast, `aggregateEntities` scored 85 but had 15 ms self CPU; `computeDocumentEdges` scored 70 but had 6 ms. `analyzeFocusInsights` was not called by this workload, so absent samples did not establish general coldness.

TS then scanned text with a regex per dictionary term; Rust tokenized and probed a `HashSet`. Different mention counts and multi-word semantics prevented a parity-backed acceleration claim. Details: [intentweave-index-build-profile.json](../evaluation/intentweave-index-build-profile.json).

### KWX Matcher Rewrite

TS now indexes simple ASCII terms and scans stripped text once, retaining escaped-regex fallback for multi-word/punctuation terms. Five focused tests cover case-insensitive boundaries, first-match behavior, dictionary order, structured-match deduplication, fallback terms, and mutable dictionary sets.

A synthetic 2,500-term / 30,000-character case found the same 2,500 matches in 1.8 ms versus 16.5 ms (9.2x in that microbenchmark only). A subsequent profiled build took about 19 s, with KWG 6.5 s and `extractDictionary` 4.49 s self / 5.18 s inclusive CPU (23.7%). Coverage fell to 30.31% (`LOW`); these single runs are directional. Current static priority became 55, not a runtime ranking.

The final DB had 7,206 symbols and 16,108 co-occurrences. Mentions rose from 56,163 to 56,170; eight added and one removed match were confined to changed extractor source comments. Markdown match identities were unchanged; IDF/confidence values were recomputed. This checks TS document behavior, not TS/Rust parity.

### MVP-6 Repeat Baseline

Three unprofiled sequential full-depth TS builds took 19.8, 21.6, and 21.8 s (median 21.6 s); KWG/IN median was 7.9 s. All produced 7,308 symbols, 56,475 mentions/annotations, and 16,184 co-occurrences.

A separate CPU profile matched 37.02% of analyzer samples (`LOW`). `extractDictionary` had 5.98 s self CPU, 7.05 s inclusive, and 25.89% sample share. Assessment: `VERY_HIGH` hotness, `MEDIUM` declared algorithm potential, `HIGH` chunk parallel potential, and `LOW` native potential under conditional suitability/high island boundary risk. Priority remained 55.

The heap profile matched 2 of 32 samples (5.67%, `LOW`); inclusive bytes landed on `processFile`, `parseGitLog`, and `runTcxStage`, with zero self bytes due to unmapped runtime leaves. This did not support a KWX layout recommendation.

The manifest declared eight read-only candidate stages upstream of one SQLite writer, yielding structural `HIGH` serialization risk. `annotate` and `sqlite-write` remained unresolved under analyzer-package scope. Details: [intentweave-mvp6-baseline.json](../evaluation/intentweave-mvp6-baseline.json).

### MVP-7a Worker First Pass

IntentWeave's opt-in `iw index build --kwx-workers N` experiment uses explicit `1` as the serial TS control and `2` through `8` as a reusable per-build worker pool. Omission preserves existing native/TS backend selection. It parallelizes chunks within files; outer document/source-comment loops stay serial. This is not a CrankTS transformation.

| Workers | KWG | Whole build | Process CPU |
| ---: | ---: | ---: | ---: |
| 1 | 6.6 s | 19.4 s | 100% |
| 2 | 3.8 s | 16.9 s | 118% |
| 4 | 2.3 s | 14.1 s | 148% |
| 8 | 2.2 s | 14.2 s | 171% |

Exact row-multiset matches held for `annotations`, `co_occurrences`, `symbols`, `files`, `imports`, `todos`, `rationale`, `symbol_calls`, `property_accesses`, `type_assertions`, and `variable_assignments`. `co_changes.recency` is time-dependent; `def_use_chains` counts varied (18,322 / 18,370 / 18,344 / 18,280). Full-database parity was not established.

There was one run per configuration, no warm-up/repeated distributions, and no peak RSS measurement. Eight workers did not beat four end-to-end. SQLite was not instrumented; its earlier ~1.1 s stage was about 5% of the 21.6 s baseline, not evidence of a dominant sink. Details: [intentweave-mvp7-kwx-workers.json](../evaluation/intentweave-mvp7-kwx-workers.json).

### Top-16 Source Review

All 16 index islands above the priority-70 cutoff scored exactly 70. Manual labels were 1 `GOOD_NATIVE_CANDIDATE`, 7 `MAYBE`, and 8 `BAD_CANDIDATE`, not profiler-backed ground truth. Full region metrics, labels, and reason tokens are in [intentweave-index-top16.json](../evaluation/intentweave-index-top16.json).

`analyzeFocusInsights` was the promising in-memory graph/layer region, but needed workload confirmation. Database-backed BFS, joins, and signature/string scans were uncertain; rendering, bounded lookups, configuration parsing, and LLM/network work were poor native candidates.

The set had 1,142 raw exits and 439 effective exits: 24 `LOCAL_DIRECT`, 650 `STDLIB_COLLECTION`, 33 `STDLIB_PURE`, 6 `STDLIB_RUNTIME`, 152 `DATABASE`, 188 `EXTERNAL_TYPED`, and 93 `EXTERNAL_UNKNOWN` directed boundary appearances. Twelve islands were `HIGH` risk and four `MEDIUM`; the graph-analysis island had 271 raw/49 effective exits and `MEDIUM` risk.

This selected sample exposed false positives but was too small and unmeasured to fit coefficients. Raw boundary ratio would penalize the promising graph region, while callbacks/stdlib calls do not necessarily represent runtime crossings. No score weights or component membership were changed from these results.

## Follow-up Validation Gates

1. **Worker validation:** warm up, then collect at least five measured serial/2/4/8 runs; capture peak RSS, startup/clone costs, and file/chunk variants. Require normalized semantic parity.
2. **Sink measurements:** instrument statement, transaction, commit, checkpoint, and writer-stage time. Measure queue depth/producer wait only after a real producer queue exists; distinguish structural risk from observed contention.
3. **Workspace analysis:** opt-in project-reference resolution, preserving package-only behavior; verify unique cross-project IDs and call resolution in a solution-tsconfig fixture.
4. **Native validation:** choose a measured, algorithmically reasonable in-memory candidate with acceptable boundaries. Validate a manual napi-rs harness using parity and repeated CPU/RSS/GC/scaling measurements before automatic generation.
5. **Transformation:** keep evidence, advice, optional agent assistance, and deterministic lowering separate. v0.2 requires explicit selection, a supported end-to-end implementation, wrapper/boundary, TS fallback, parity tests, and benchmarks. v0.3 adds gated automatic selection, Native IR/backend integration, reversible replacement, and rollback. Unsupported semantics remain in TypeScript.