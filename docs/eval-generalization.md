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

- call counts and content repetition (identity-only inputs such as no-argument calls, buffers, and class instances do not count as content)
- identity overlap between collections passed to the same call
- the same content reaching several call sites

`derivePhenomena` turns these facts into hypotheses with an upper bound on the runtime share. Repetition is only evidence when the callee does not write outer state or its arguments (static effects). No annotations or source reading are involved.

| Project | Hypothesis (kind, call) | Upper bound | Judgment |
| --- | --- | ---: | --- |
| closed source | `REDUNDANT_WORK_ON_IDENTICAL_OBJECTS`: a diff over two collections that are 100% the same objects | 16.4 / 16.6 | true, validated −17% |
| closed source | `DUPLICATE_PROCESSING`: two index calls in one function get the same content | 15.5 / 14.4 / 1.6 | true, ≤ −23% |
| closed source | `RECOMPUTATION`: JSON column parse, 400k calls over 5–40 distinct inputs | 2.9 / 3.1 | *new*, plausible, unvalidated |
| Knip | `INVARIANT_ARGUMENT`: `tinyGlob` options repeat (92 values in 4,264 calls) | 9.1 | true (finding #1) |
| ESLint | `INVARIANT_ARGUMENT`: `eslintScope.analyze` gets the same options for 353 files | 5.8 | weak: options repeat, the work is per file; at most option normalization is hoistable |
| Effect | `RECOMPUTATION`: `Arr.range` with the same bounds | 2.9 | true repetition, small |
| noble-hashes | `RECOMPUTATION`: `G1s`/`G2s` inputs repeat | 1.0–5.0 | true at workload level, an artifact of hashing the same buffer 30 times |
| TypeDoc | none | – | correctly silent |

- **Hit rate on the known ground truth:** both closed-source findings and Knip's `glob` are reproduced mechanically. Knip's plugin-config reload (#3) is lost, because its callee does dynamic imports and is marked as having unknown side effects.
- **Precision:** of 7 distinct hypotheses, 4 are true and actionable, 2 are true but low-value or benchmark artifacts, and 1 is weak. All false positives of the first version came from identity-only inputs and effectful callees. These were 16–22 entries per noble workload (`this.keccak()`, `G(a, b, c, d)` on mutable buffers) plus Effect's interpreter loop, and the content and effect gates removed them.
- **Caveat:** the probe was designed after the closed-source findings were known. The fresh hits (JSON parse, `Arr.range`) are the honest test, and they are small. An ablation with an agent on new projects remains the real go/no-go for the advisor.

## Ground-Truth Findings and Discovery Provenance

The findings list for a later ablation (same agent and budget, raw `.cpuprofile` vs CrankTS evidence). Provenance: **TOOL** = CrankTS named the call and the reason; **HUMAN_FROM_TOOL_EVIDENCE** = a human diagnosed it from CrankTS output (attribution, caller paths, blockers); **HUMAN_INDEPENDENT** = found by reading source or a plain profile. "v0.2.6e" marks findings the new evidence probe reproduces; because the probe was designed after the closed-source findings were known, those two are not independent evidence that it works. The fresh hits (marked *new*) are the fairer test.

| # | Project | Finding | Share | Provenance | Validation |
| --- | --- | --- | ---: | --- | --- |
| 1 | Knip | `glob` called again and again with the same patterns | 10.2 | TOOL (hoisting, measured repetition) | repetition measured, gain not measured |
| 2 | Knip | gitignore matching algorithm | 17.0 | HUMAN_INDEPENDENT | none |
| 3 | Knip | plugin config loaded again for the same root manifest | 6.8 | TOOL (v0.2.6e draft only; the final effect gate drops it) | none |
| 4 | TypeDoc | cost is the TypeScript checker: a faster checker, not a kernel | – | HUMAN_FROM_TOOL_EVIDENCE (attribution) | none |
| 5 | ESLint | prepared rule state, packed tokens | 7.1 | HUMAN_INDEPENDENT | none |
| 6 | Effect | `assignProperty` creates dictionary-mode objects | 10.0 | HUMAN_INDEPENDENT | none |
| 7 | noble-hashes | `keccakP` and the compression functions as native kernels | 37.7 | HUMAN_FROM_TOOL_EVIDENCE (attribution, blockers) | gain ceiling below |
| 8 | closed source | per-row hashing of rows that are the same objects | 16.4 | HUMAN_INDEPENDENT, since v0.2.6e TOOL | −17% wall |
| 9 | closed source | every entity indexed twice | 15.5 | HUMAN_INDEPENDENT, since v0.2.6e TOOL | ≤ −23% wall (upper bound) |
| 10 | closed source | the same JSON column text parsed 4× per row and per source | 2.2–3.1 | TOOL (v0.2.6e, *new*) | none |
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
