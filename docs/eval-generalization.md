# Generalization Review (Draft): Five Projects

This is the review the plan asked for after the five-project study: acceleration coverage, recognition recall, pattern-family recall, pattern yield, and the stop/go reading. **The labels behind the "plausible" and "evidence-supported" columns are my judgment from reading sources and profiles; the verdict needs your review, and I have not made the decision.**

Reports per project: [Knip](eval-knip.md), [TypeDoc and ESLint](eval-typedoc-eslint.md), [noble-hashes](eval-noble-hashes.md), and Effect below. Data: `evaluation/crankts-<project>-coverage.json`.

## Effect 4.0.3 (Eval #4)

Effect core run from source on fiber, stream, and schema workloads (`evaluation/effect/study.ts`; scratch workloads in `packages/effect/crankts-workloads/`).

| Workload | Attributable | Own JS | Project frames not matched to a function | Human-plausible | Recognized |
| --- | ---: | ---: | ---: | ---: | ---: |
| fibers (`Effect.gen`, `forEach`, concurrency) | 43.0 | 8.1 | 33.9 | 0 | 0 |
| streams (map/filter/rechunk/fold, `splitLines`) | 37.8 | 14.5 | 23.8 | 0 | 0 |
| schema (decode/encode of 50-item orders) | 64.3 | 40.7 | 23.6 | 10.0 | 0 |

- **The time is the runtime itself.** 32% of the fibers workload is `FiberImpl.runLoop`, the interpreter over Effect primitives with a mutable fiber, a continuation stack, and a scheduler; streams are closure continuation chains (`mapCont`, `andThenCont`, `loop`); the schema parser is per-item closure dispatch over a compiled parser tree. None of it is batchable, hoistable, or lowerable. The one plausible item is `assignProperty` (10% of the schema workload): assigning keys one at a time with `Reflect.ownKeys` creates dictionary-mode objects, a layout change that needs a measured gain.
- **Measurement gap in CrankTS: 24–34% of the samples are project frames that were not matched to an analyzed function.** Effect defines its runtime primitives through computed-key methods and local classes (`makePrimitiveProto` 14%, `evaluate`, `PrimitiveImpl`, `ExitPrimitive`), which `collectFunctions` does not register. Those samples count as `UNANALYZED_PROJECT`, not as the project's own code. The numbers above therefore understate Effect's own-JS share. This is a recognition gap to close before relying on Effect-like libraries in the study, and I have not fixed it.

## A Closed-Source Project (Eval #6)

One corporate TypeScript monorepo (pipeline ingest of architecture data: adapters, normalization, workers, SQLite backend), analyzed locally; details stay in a private report (`evaluation/arc-platform/REPORT.md`, git-ignored). Its own JavaScript is 23–24% of the runtime on the two large workloads; 43% is caused in dependencies (full-text indexing, SQLite driver). Human-plausible 45–47%, evidence-supported 13%, recognized 0%, lowering accepts nothing (async code, `unknown` types, `this` methods). The two sizable findings are an algorithmic duplication (every entity indexed twice) and repeated hashing of rows that cannot differ (an identity check would remove it): both fall outside CrankTS's pattern set, and neither is a kernel. Not validated by measurement.

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
4. **Recognition gaps the studies exposed** (found, not fixed): the static eligibility analysis marks typed-array indexing as dynamic and `throw` as an unknown call (hiding `keccakP`); computed-key methods and local classes are not collected (hiding up to a third of Effect).
5. **Execution-side answers.** TypeDoc's cost is the TypeScript compiler; the right recommendation is a faster checker, not a kernel. Knip already runs parsing and resolution natively.

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
