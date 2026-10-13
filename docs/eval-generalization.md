# Generalization Review (Draft): Six Projects

This is the review the plan asked for after the five-project study: acceleration coverage, recognition recall, pattern-family recall, pattern yield, and the stop/go reading. **The labels behind the "plausible" and "evidence-supported" columns are my judgment from reading sources and profiles; the verdict needs your review, and I have not made the decision.**

Reports per project: [Knip](eval-knip.md), [TypeDoc and ESLint](eval-typedoc-eslint.md), [noble-hashes](eval-noble-hashes.md), and Effect below. Data: `evaluation/crankts-<project>-coverage.json`.

## Effect 4.0.3 (Eval #4)

Effect core run from source on fiber, stream, and schema workloads (`evaluation/effect/study.ts`; scratch workloads in `packages/effect/crankts-workloads/`).

| Workload | Attributable | Own JS | Project frames not matched to a function | Human-plausible | Recognized |
| --- | ---: | ---: | ---: | ---: | ---: |
| fibers (`Effect.gen`, `forEach`, concurrency) | 43.1 | 28.1 | 14.2 | 0 | 0 |
| streams (map/filter/rechunk/fold, `splitLines`) | 37.9 | 37.6 | 0.1 | 0 | 0 |
| schema (decode/encode of 50-item orders) | 64.7 | 64.7 | 0 | 10.0 | 0 |

(After the v0.2.6e matching fix. Before it, own JS was 8.1 / 14.5 / 40.7 and 24–34% of the samples were unmatched project frames.)

- **The time is the runtime itself.** 32% of the fibers workload is `FiberImpl.runLoop`, the interpreter over Effect primitives with a mutable fiber, a continuation stack, and a scheduler; streams are closure continuation chains (`mapCont`, `andThenCont`, `loop`); the schema parser is per-item closure dispatch over a compiled parser tree. None of it is batchable, hoistable, or lowerable. The one plausible item is `assignProperty` (10% of the schema workload): assigning keys one at a time with `Reflect.ownKeys` creates dictionary-mode objects, a layout change that needs a measured gain.
- **Measurement gap, fixed.** Effect defines its runtime primitives through computed-key methods (`[evaluate](…)`) and object-literal methods passed to factories, whose V8 names differ from source names. Profile frames are now matched by position when no name matches (the only analyzed function starting on the frame's line). Unmatched project time dropped from 24–34% to 0–14%; the remaining 14% in the fibers workload are frames on lines with several functions. The verdict does not change: all of it is interpreter and continuation code.

## A Closed-Source Project (Eval #6)

One corporate TypeScript monorepo (pipeline ingest of architecture data: adapters, normalization, workers, SQLite backend), analyzed locally; details stay in a git-ignored private report. Its own JavaScript is 23–24% of the runtime on the two large workloads; 43% is caused in dependencies (full-text indexing, SQLite driver). Human-plausible 45–47%, evidence-supported 13%, recognized 0%, lowering accepts nothing (async code, `unknown` types, `this` methods). The two sizable findings are an algorithmic duplication (every entity indexed twice) and repeated hashing of rows that cannot differ (an identity check would remove it): both fall outside CrankTS's pattern set, and neither is a kernel.

**Validated on a patched local copy** (round-robin fresh processes, identical canonical tables): the identity short-circuit cuts wall time by about 17% on both large workloads (9.9 → 8.2 s, 10.1 → 8.4 s). Skipping the second index is an upper bound of −23% (8.4 → 6.5 s) because it drops a feature. **Discovery provenance:** a human found both by reading the source, helped by an ad-hoc caller-chain script; CrankTS at that point contributed attribution only. Since v0.2.6e, CrankTS's evidence probe reports both mechanically (see "Evidence Before Patterns").

## Cross-Project Summary

Medians over each project's workloads, percent of profiled runtime:

| Project | Character | Attributable | Own JS | Human-plausible | Evidence-supported | Recognized | Transformable | Automated recall | Family recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Knip | orchestration, native deps | 53.1 | 12.5 | 11.5 | 4.3 | 2.3 | 0 | 0.46 | 1.0 |
| TypeDoc | TS compiler and AST | 65.5 | 10.4 | 4.3 | 0 | 0 | 0 | 0 | 1.0 |
| ESLint | visitors and rules | 79.0 | 37.2 | 7.1 | 0 | 0 | 0 | 0 | 0.5 |
| Effect | runtime, state, concurrency | 43.0 | 14.5 | 0 | 0 | 0 | 0 | – | 1.0 |
| noble-hashes | pure compute (control) | 95.5 | 95.4 | 71.6 | 0 | 0 | 0 | 0 | 1.0 |

Per project, the median over the five is 7.1% human-plausible (4.3% without the noble control) and 0% evidence-supported. Recognition recall is nonzero for Knip only.

## Pattern Yield

The largest single plausible call site per pattern, as a percent of runtime in its best workload:

| Pattern | Projects hit | Largest share | CrankTS has the family |
| --- | --- | --- | --- |
| `NATIVE_KERNEL` | noble-hashes | 37.7 (`keccakP`) | yes |
| `CHANGE_ALGORITHM` | Knip, TypeDoc, ESLint | 17.0 (gitignore matching) | no (bespoke each time) |
| `PREPARE_STATE` | Knip, ESLint | 17.0 | yes |
| `HOIST_INVARIANT_WORK` | Knip, TypeDoc, ESLint | 10.2 (`glob`) | yes |
| `CHANGE_DATA_LAYOUT` | Knip, Effect | 10.0 | yes |
| `PACK_DATA` | ESLint | 1.9 | yes |

`CHANGE_ALGORITHM` appears in three projects and is always a different algorithm. That is the bespoke pattern the stop/go table warns about, not something to automate.

## What the Studies Say About CrankTS

1. **Where the time is.** In Knip, TypeDoc, ESLint, and Effect, the project's own JavaScript is 8–37% of the runtime; the rest is dependencies, native code, I/O, and the runtime. Only noble-hashes is compute-bound (95%).
2. **Lowering reaches nothing in real application code.** Across 20 workloads (about 25 call sites each) no hot call site lowers. The blockers weighted by runtime: union and optional types (up to 65%), class instances (up to 51% in TypeDoc), `this`-bound methods (up to 45% in ESLint), types without a Kernel IR form, async code. For noble-hashes the blockers are a bundle (bitwise operators, generic typed-array types, `this`-bound hash state, throw-as-guard, module tables), not one small IR piece.
3. **Recognition works where evidence exists and is silent elsewhere.** Knip's `glob` is recognized with measured repetition; no false positives. Elsewhere there is nothing measured to recognize.
4. **Recognition gaps the studies exposed, now fixed** (v0.2.6e): typed-array indexing through aliases and intersections (`TArg<Uint32Array>`) and `throw new Error(…)` guards no longer block eligibility (noble's `G1s`, `G2b`, and `_compress` are now `SUPPORTED`; `keccakP` is `CONDITIONAL` only because of its callees); profile frames of computed-key and factory-object methods are matched by position.
5. **Execution-side answers.** TypeDoc's cost is the TypeScript compiler; the right recommendation is a faster checker, not a kernel. Knip already runs parsing and resolution natively.

## Evidence Before Patterns (v0.2.6e)

Instead of one recognizer per kind of waste, CrankTS now probes the expensive calls around the hottest call sites. The probes cover inner calls into costly callees, the edges along the dominant caller path, and hoisting candidates. They record generic facts:

- call counts and content repetition (identity-only inputs such as no-argument calls, buffers, and class instances do not count)
- identity overlap between collections passed to the same call
- the same content reaching several call sites

`derivePhenomena` separates two levels:

- **Observations** (`IDENTICAL_OBJECT_FLOW`, `DUPLICATE_CONTENT_FLOW`, `REPEATED_INPUT`, `REPEATED_ARGUMENT`) are measured facts with an at-risk upper bound; they imply no optimization.
- **Hypotheses** (`AVOID_REDUNDANT_WORK`, `AVOID_DUPLICATE_PROCESSING`, `CACHE_RESULT`, `HOIST_ARGUMENT_WORK`) carry preconditions marked `MET`, `UNVERIFIED`, or `VIOLATED`. A hypothesis is only attached when nothing is violated; otherwise the observation says why it was withheld. `CACHE_RESULT` needs a callee that:
  - writes nothing outside its locals
  - reads no mutable outer state (`this`, outer `let`/`var`, outer object/array/buffer constants, clock, environment)
  - costs clearly more per call than a lookup

  It also lists `CALLERS_DO_NOT_MUTATE_SHARED_RESULT` as unverified. Where a cost model exists (cache lookups, about 0.1 µs), the hypothesis also gives an **estimated avoidable work**: cost × (reuse − lookup / per-call cost).

The probe samples hot calls so that it cannot dominate the workload (a 500k-call workload ran 100× slower unsampled): the first 2,000 calls of a site are fingerprinted exactly, then every 4th up to 20,000, then every 64th. Counts stay exact; ratios use the sampled calls and the evidence says so (`sampledCalls`). The studies below ran before this budget; sites with more than 2,000 calls would show somewhat different ratios on a rerun (repetition whose repeats are far apart is the part sampling can miss).

No annotations or source reading are involved. The results:

| Project | Observation → hypothesis | Upper bound / estimate | Outcome |
| --- | --- | ---: | --- |
| closed source | identical-object flow → avoid redundant work | 16.4 / – | **validated −17%** |
| closed source | duplicate content flow → avoid duplicate processing | 15.5 / – | **validated ≤ −23%** (upper bound) |
| closed source | repeated input → cache JSON parse (all checked preconditions met) | 3.1 / 2.7 | **not beneficial:** −0.7% / −0.8% median, within noise |
| Knip | repeated argument → hoist `tinyGlob` option work | 9.1 / – | true (finding #1) |
| ESLint | repeated argument → hoist `eslintScope.analyze` option work | 5.8 / – | weak: the work is per file |
| ESLint, Knip, Effect, noble | 15 observations | up to 51 | withheld: callee writes outer state or its arguments, reads mutable outer state, or costs less than a lookup (noble `G1s`/`G2s` at 0.02 µs per call) |
| TypeDoc | none | – | correctly silent |

- **Reproduction:** both closed-source findings and Knip's `glob` are found mechanically. Knip's plugin-config reload (finding #3) stays an observation, because its callee does dynamic imports and has unknown side effects.
- **Precision of hypotheses:** 5 hypotheses: 3 true (2 validated), 1 weak, 1 refuted by measurement. Every earlier false positive is now an observation with a stated reason.
- **What the refuted cache shows:** a hypothesis with every *checked* precondition met can still gain nothing. The estimate assumed the profiled cost was all parse work. In that workload, the time sits in reading rows four times, which a cache does not touch. Upper bound, estimate, and validated gain are different numbers, and only the last one counts.
- **Caveat:** the probe was designed after the closed-source findings were known. The only fresh hit that met its preconditions did not validate. An ablation with an agent on unseen projects remains the real go/no-go for the advisor.

## Parallel Execution Screening (Track P)

Amdahl screening from the existing profiles (`evaluation/coverage/parallel-screen.ts`): for every workload, the hot functions whose loops or async batches the static parallelism analysis classifies as parallelizable, their inclusive CPU share P, and the ceiling 1 / ((1 − P) + P / n).

| Project | Largest candidate | P | Ceiling ×4 / ×8 | Checked |
| --- | --- | ---: | ---: | --- |
| Knip | `walkAST`, `runPlugin` | 9–13% | 1.07–1.10 / 1.08–1.12 | small either way |
| TypeDoc | `Application.convert` | 43–56% | 1.47–1.73 / – | **artifact:** the loop is `program.emit()` (only with `emit: both`); the share is all of `convert`, which runs on one shared checker |
| ESLint | `validateRulesConf` | 0–2% | ≈ 1.0 | – |
| Effect | – | 0% | 1.0 | – |
| noble-hashes | `keccakP`, `rounds`, `digestInto` | 35–49% | 1.35–1.59 / – | **artifact:** Keccak rounds and scrypt mixing are sequential through typed-array state |
| closed source | a read adapter loop | 3.5% | 1.03 | **missed the real structure:** see below |
| IntentWeave index build | `buildFromPaths`, keyword extraction | 27–39% | 1.25–1.42 / 1.3–1.52 | real (per-chunk extraction) |

- **Only IntentWeave has a real candidate, and JS workers already take it.** MVP-7a measured the keyword stage at 6.6 s → 2.3 s with 4 `worker_threads` (2.87×), while the wall time stays at 14.1 s because the rest of the pipeline is serial. A native thread pool could only shrink the remaining 2.3 s. Optimistically (8 threads, no boundary cost) that is ≈ 1.5 s of 14 s, about 10%, and about 6% after the 1.8× algorithmic fix. That is below the ≥ 10% gate, so the four-variant PoC was not built.
- **CrankTS bug found:** the static parallelism classifier reports `PARALLEL_DOALL` for loops with loop-carried dependences through typed-array elements (`keccakP`), and the screening attributes a function's whole inclusive time to its loop. Both make P look larger than it is. The classification is a candidate list, not evidence.
- **The screening is blind to async pipelines.** CPU profiles lose the caller stack at every `await`, so a pipeline stage shows up as its own root, not under the orchestrator loop that schedules it. On the closed-source project the orchestrator loop has 1.1% inclusive time, while the stages it runs take most of the runtime. A stage view from the same profile (outermost project frame per sample, idle share) shows:
  - the run is CPU-bound on one core: idle 0–0.2%, a single thread profile
  - a full-text index build of 30–33%, done per source
  - delta computation and hashing of 16–17%, pure and per row
  - load and transform per source of 6–8%
  - SQLite reads, writes, and views (about 20%) and GC stay serial

  With P ≈ 0.55 the Amdahl ceiling is about 1.7× at 4 threads and 1.9× at 8. After the two validated algorithmic fixes it is about 1.4× at 4 threads (P ≈ 0.35–0.4). The parallel units are per-source index builds and per-row hashing. The index lives in the main process, so a worker-thread design must export the index or serve queries from the worker: an architecture change in TypeScript, not a native kernel.
- **Reading for track P:**
  - No native thread-pool backend is warranted: where parallel work exists, `worker_threads` reach it, and the units are coarse (per source or file).
  - Pipeline-level parallelism in async code is a real advisor topic that CrankTS cannot see today. It needs a stage view (async roots, idle share, serial sinks), which belongs to track A.
  - The closed-source project is a candidate for that: a ceiling of 1.4–1.7×, unvalidated. This is a **lower bound**, measured with the local configuration: inline executor, single-writer SQLite. In production it runs with Postgres, several ingester replicas, and process-level workers. There the serial SQLite share leaves the critical path, and the ceiling depends on the deployment instead:
    - the source as the partition unit (the largest source is the critical path)
    - wave dependencies between workers
    - the database's write capacity
  - A CPU profile of one configuration cannot give the production ceiling. The stage view must report stages and their sinks separately, so that Amdahl can be computed per deployment scenario.
  - **Measured with Postgres** (local container, N ingester processes over disjoint sources, emulating pods): more ingesters help only up to 2 (1.3×) and then get slower. The database needs 2–3× the application's CPU per entity and is bound by WAL writes. Most of its work is visible only inside the database: a post-insert full-text enrichment `UPDATE` rewrites every row with new entries in all eight indexes, so the database work doubles. Locally this is pessimistic (shared cores, Docker storage), but it moves the question from "how many workers" to "how much database work per entity".
  - **For CrankTS:** this cost is outside the process. The CPU profile shows only the client waiting on I/O, so neither attribution nor the evidence probe can see it. A `CROSS_BOUNDARY_COST` view (database statements joined to call sites, e.g. via `pg_stat_statements`) would be the evidence feature; like the stage view, it belongs to track A after the ablation.

## Ground-Truth Findings and Discovery Provenance

The findings list for a later ablation (same agent and budget, raw `.cpuprofile` vs CrankTS evidence). Provenance: **TOOL** = CrankTS named the call and the reason; **HUMAN_FROM_TOOL_EVIDENCE** = a human diagnosed it from CrankTS output (attribution, caller paths, blockers); **HUMAN_INDEPENDENT** = found by reading source or a plain profile. "v0.2.6e" marks findings the new evidence probe reproduces; because the probe was designed after the closed-source findings were known, those two are not independent evidence that it works. The fresh hits (marked *new*) are the fairer test.

| # | Project | Finding | Share | Provenance | Validation |
| --- | --- | --- | ---: | --- | --- |
| 1 | Knip | `glob` called again and again with the same patterns | 10.2 | TOOL (hoisting, measured repetition) | repetition measured, gain not measured |
| 2 | Knip | gitignore matching algorithm | 17.0 | HUMAN_INDEPENDENT | none |
| 3 | Knip | plugin config loaded again for the same root manifest | 6.8 | TOOL observation only (callee effects unknown, no hypothesis) | none |
| 4 | TypeDoc | cost is the TypeScript checker: a faster checker, not a kernel | – | HUMAN_FROM_TOOL_EVIDENCE (attribution) | none |
| 5 | ESLint | prepared rule state, packed tokens | 7.1 | HUMAN_INDEPENDENT | none |
| 6 | Effect | `assignProperty` creates dictionary-mode objects | 10.0 | HUMAN_INDEPENDENT | none |
| 7 | noble-hashes | `keccakP` and the compression functions as native kernels | 37.7 | HUMAN_FROM_TOOL_EVIDENCE (attribution, blockers) | gain ceiling below |
| 8 | closed source | per-row hashing of rows that are the same objects | 16.4 | HUMAN_INDEPENDENT, since v0.2.6e TOOL | −17% wall |
| 9 | closed source | every entity indexed twice | 15.5 | HUMAN_INDEPENDENT, since v0.2.6e TOOL | ≤ −23% wall (upper bound) |
| 10 | closed source | the same JSON column text parsed 4× per row and per source | 2.2–3.1 | TOOL (v0.2.6e, *new*) | **refuted:** memoizing gains −0.7/−0.8%, within noise |
| 11 | IntentWeave | `extractDictionary` rebuilds its term index (and about 40% of it as `RegExp`s) on every chunk | 22.9 | HUMAN_FROM_TOOL_EVIDENCE (KWX history, attribution) | 1.8× on a synthetic benchmark (7.7 → 4.3 s, same output) |

## Offload Gain Ceiling (Option B)

The open question for a static tier is gain, not coverage, so I measured it before any compiler work. Same inputs and outputs in every column; wall time on an M-series Mac, Node 22.19 / V8, scriptc 0.2.8.

| Kernel | V8 (TS) | scriptc native | CrankTS Rust backend | hand-written Rust | vendor native |
| --- | ---: | ---: | ---: | ---: | ---: |
| SHA-256 compression, 300 MiB, plain `Uint32Array` + bitwise | 1.50 s | 17.6 s (0.09×) | fails closed (`>>>`, `off += 64` loop) | 0.86 s (**1.75×**) | ~0.11 s (OpenSSL with SHA instructions, ~13×) |
| IntentWeave `extract`, 2,000 chunks × 7k-term dictionary (regex path) | 7.6 s | 41–46 s (0.17×, `--dynamic`) | not lowerable (class, `this`, regex) | – | – |
| same, identifier terms only (char-code scanning loop) | 2.2–2.4 s | 2.1–2.6 s (≈1×) | – | – | – |
| same, index built once (algorithmic fix, stays TypeScript) | **4.3 s (1.8×)** | – | – | – | – |
| noble-hashes vs `node:crypto`, 1 MiB / 64 B | – | – | – | – | 11–24× / 1.6–4.3× |

Reading: compiling ordinary TypeScript to native buys about 1× on string and object code and at most about 1.75× on a numeric kernel before the N-API boundary; only hand-tuned vendor code with hardware instructions is far ahead, and for hashes it already exists (`node:crypto`). The one algorithmic fix measured here gains as much as the best native kernel and needs no backend. This is consistent with KWX, where the generated kernel was at parity with V8.

## scriptc 0.2.8 on IntentWeave (Profile-Weighted)

`scriptc coverage` counts statements reachable from an entry, not runtime, so I joined it with a CPU profile of `iw index build --depth full --no-native` (20 s). Where the time goes: tree-sitter native 32%, project JavaScript 41% (`extractDictionary` 23%, `extract` 3%, `sqlite-compat` 5%, `ast-extractor` 6%), idle and GC the rest.

- From the CLI entry, 34% of 5,678 statements compile statically, but scriptc treats the workspace packages (`@intentweave/analyzer`, `core`, `index`, `sqlite-compat`) as npm code that runs in its embedded engine. **None of the 41% hot project code is in the static part from the real entry.**
- Reached through a small driver, the hot extractor compiles 6% static, 96% with `--dynamic` (the escape is the `KeywordMatch[]` type from the core package). So scriptc already implements "static regions with dynamic escapes" for this code, and the result is the 0.17× above.
- noble-hashes: 34–39% static; the kernels are blocked by `TArg<Uint32Array>` intersections, and even `--dynamic` builds fail (15–42 errors). That is the same blocker CrankTS had in its eligibility analysis before v0.2.6e.

The comparison does not argue for building CrankTS's own static tier: a dedicated TS-to-native compiler reaches the hot code only with dynamic escapes and then runs slower than V8; the blockers it reports (intersections, cross-package types, `this`-heavy classes) are the ones CrankTS sees too.

## Stop/Go Reading (for your decision)

Against the plan's table (median actionable project-owned CPU after about five projects):

| Plan band | This data |
| --- | --- |
| ≥ 30% and a few recurring patterns | no |
| 10–30% and patterns recur | no: plausible is 7.1% median (4.3% without the control); the patterns that recur (hoisting, prepared state) cover little each |
| < 10% and each project needs bespoke patterns | **matches** for the application projects (Knip, TypeDoc, ESLint, Effect); `CHANGE_ALGORITHM` is bespoke in every project |
| < 5%, mostly unique idioms, native adds little | evidence-supported is 0–4.3%; V8 parity for native was already measured in KWX |

Two readings, which are yours to weigh:

- **Pessimistic (architecture rethink band):** pattern recognition on individual hotspots yields single-digit coverage on application code, and lowering reaches none of it. Per the plan, the alternatives are a lower-level approach (data-flow, dependence, alias analysis) or an advisor-only product that names the dominant dependency and the measured, repeated invariant work.
- **Constructive:** the advisor already does the part that paid off (Knip `glob`, 10% of runtime, with measured evidence) and correctly says `KEEP_TS` elsewhere. The compute-bound control shows the clearest native opportunity, blocked by a fixable bundle of lowering and static-analysis gaps. A decision between a narrow compute-kernel product and an advisor product is the real fork.

I recommend not building `TransformationPlan` (v0.2.7) before you pick the direction, because it differs between the two readings.
