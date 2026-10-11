# External Evaluation #1: Knip (Acceleration Coverage)

The question is not whether CrankTS finds a Rust candidate in Knip. It is: **without Knip-specific rules, how much of Knip's profiled runtime do CrankTS's known patterns reach, and how much could be transformed at all?** This is the first data point of the generalization study defined in [plan.md](plan.md) (coverage funnel, recognition recall, pattern yield, stop/go after about five projects).

- **Data:** [crankts-knip-coverage.json](../evaluation/crankts-knip-coverage.json)
- **Driver:** [run-study.ts](../evaluation/coverage/run-study.ts) with [study.ts](../evaluation/knip/study.ts) (`node --import tsx evaluation/coverage/run-study.ts evaluation/knip/study.ts`)
- **Manual review:** [annotations.json](../evaluation/knip/annotations.json)
- **Model:** [`computeCoverage` and `attributeToCallSites`](../src/analysis/coverage.ts)

## Setup

- **Subject:** Knip 6.41.0 (`packages/knip/src`, 2,514 functions), run directly from its TypeScript sources with Node 22's type stripping, so profile frames map 1:1 to the analyzed source.
- **Workloads:** Knip analyzing five repositories. Each runs 3 times in fresh processes, round-robin, with `--cpu-prof-interval 500us`; the values are medians.

  | Workload | State |
  | --- | --- |
  | Knip's own monorepo | complete |
  | IntentWeave | complete |
  | Vite v8.3.4 | dependencies installed with `--ignore-scripts`, `vite` built; 7 config files fail to load |
  | TanStack Router v1.166.7 | dependencies installed; workspace packages not built, so about 160 config files fail to load |
  | the local Backstage checkout | no dependencies installed; about 230 config files fail to load |

  The degraded workloads still parse and resolve every project file; they find fewer plugin entry files.
- **Advisor:** today's advisor with its default rules.
- **Pipeline probes:** dry runs of today's fail-closed passes on every hotspot. Region extraction is not probed (it needs line ranges). The passes probed:
  - Kernel IR lowering
  - `planInterning` and `planBatchInterning` with every `string` type alias found in the parameters
- **Human review:** the top call sites and hotspots of every workload (44 functions). Each is labeled transformable or not, with the pattern in the review's vocabulary. **These labels are my judgment from reading Knip's source and the profiles, so they need your review before the verdict counts.**

## Where the Time Goes

Self time by origin of the sampled frame, in percent of profiled time. The last three columns are explained in the notes below the table.

| Workload | Wall | Knip code | Packages (JS) | Native | Node | GC, program, idle, wasm | Attributable to Knip call sites | Recognized / supported by CrankTS | Transformable (human, call sites) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Knip (self) | 0.98 s | 17.1 | 24.1 | 21.6 | 14.9 | 21.0 | 56.7 | 0 / 0 | 5.0 |
| IntentWeave | 1.05 s | 17.0 | 26.1 | 17.5 | 19.3 | 20.5 | 53.1 | 0.3 / 0 | 2.3 |
| Vite | 3.14 s | 13.7 | 33.4 | 17.7 | 12.3 | 22.6 | 46.0 | 0 / 0 | 14.5 |
| TanStack Router | 9.82 s | 11.5 | 26.0 | 33.0 | 19.9 | 9.4 | 51.2 | 0 / 0 | 22.6 |
| Backstage (degraded) | 5.58 s | 24.1 | 28.0 | 30.1 | 4.7 | 13.3 | 70.3 | 0.5 / 0 | 15.0 |

- **Native** means frames without a script. This covers:
  - fs bindings (`readFileUtf8`)
  - regex execution
  - oxc-parser's Rust parser behind N-API

  Packages are led by oxc-parser's JS side (4–17%), picomatch (4–20%), and jiti (up to 7%).
- **The wasm share is a study artifact.** It is amaro, Node's type stripper (swc compiled to wasm), turning Knip's `.ts` sources into JavaScript at load time. That's 13% of the 1-second runs and less on longer ones. It comes from running Knip from source and is excluded from every conclusion below.
- **Attributable to Knip call sites:** every sample is attributed to the innermost Knip frame on its stack, so external time is billed to the Knip code that caused it. About half of the runtime has such a call site. The rest is startup, module loading, and GC.
- **Measurement caveat:** N-API calls get no frame of their own. `resolveSync`'s "self" time (1–7%) is really oxc-resolver, which is Rust. So "Knip code" in the table overstates project-owned compute. CrankTS should classify such frames as external native (see "What this changes" below).
- **Flat profile:** the top 20 self-time functions cover only 53–69% of Knip's own self time, and the hottest single function takes 1–7%.

## Evidence Levels After the Fifth Review Round

The review split "transformable" into evidence levels:

- `PLAUSIBLE`: the pattern fits, but a precondition is not shown.
- `EVIDENCE_SUPPORTED`: the precondition is measured or verified by inspection.
- `VALIDATED_BENEFICIAL`: the gain is measured.

`NOT_TRANSFORMABLE` labels are unchanged.

| Call site | Share of runtime | Pattern | Level | Evidence |
| --- | ---: | --- | --- | --- |
| `glob` → tinyglobby/picomatch | 1.5–13.1% (compilation 75–80% of it) | `HOIST_INVARIANT_WORK` | **EVIDENCE_SUPPORTED** | Measured by input-signature profiling (see below). The ignore sets repeat: Vite 92 distinct option objects over 4,264 calls (reuse 0.978), TanStack 229 over 2,067 (0.89), IntentWeave 6 over 181 (0.97), Knip-self 20 over 88 (0.77). |
| `isGitIgnored` → picomatch `arrayMatcher` | 0.5–17% | `PREPARE_STATE`, `CHANGE_ALGORITHM` | PLAUSIBLE (MEDIUM) | Missing: a pattern prefilter or merge that provably keeps gitignore/picomatch semantics. |
| `isExcluded` | up to 2.4% | `CHANGE_ALGORITHM` | EVIDENCE_SUPPORTED | By inspection: a growing chain of matcher closures. |
| `findWorkspaceByFilePath` | 0.6–2.9% | `PREPARE_STATE`, `CHANGE_DATA_LAYOUT` | EVIDENCE_SUPPORTED | By inspection: a linear prefix scan over all workspaces. |
| `isShadowed` | < 0.4% | `CHANGE_DATA_LAYOUT` | PLAUSIBLE (LOW) | Irrelevant for the decision. |

## Recognition After v0.2.6d

v0.2.6d added four things:

- call-site attribution
- N-API time externalized
- `HOIST_INVARIANT_WORK` detection with input-signature profiling
- arrow functions and methods in lowering

All percentages below are of profiled runtime, medians over 3 runs; the profiles are the same as above.

| Workload | Attributable to call sites | Own JS | Human-plausible | Evidence-supported | CrankTS-recognized | CrankTS-transformable | Recognition recall | Pattern-family recall | Precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Knip (self) | 56.7 | 12.5 | 4.7 | 3.5 | 0 | 0 | 0 | 0.48 | – |
| IntentWeave | 53.1 | 13.0 | 1.9 | 1.8 | 1.8 | 0 | 1.0 | 1.0 | 1.0 |
| Vite | 46.0 | 9.3 | 11.5 | 11.1 | 10.2 | 0 | 0.88 | 1.0 | 1.0 |
| TanStack Router | 51.2 | 6.4 | 21.3 | 4.3 | 2.3 | 0 | 0.11 | 0.90 | 1.0 |
| Backstage (degraded) | 70.3 | 15.2 | 12.9 | 8.8 | 5.8 | 0 | 0.46 | 1.0 | 1.0 |

What the table shows:

- **Own JavaScript is small.** Only 6–15% of the runtime is Knip's own JavaScript once N-API time (oxc-resolver, oxc-parser bindings: 3.7–10.2%) and I/O (8.7–20.8%) are attributed correctly. Before v0.2.6d, `resolveSync` looked like a 1–7% Knip hotspot; it is Rust.
- **`glob` is now recognized** wherever its measured reuse and compile cost justify it: HIGH on Vite and Backstage, MEDIUM on IntentWeave and TanStack. On Knip-self the compile cost is under 1%, so it stays LOW.
- **No false positives (precision 1.0).** `parseFile` → `parseSync` is a compile-like dependency call as well, but its sources barely repeat (reuse 0.08–0.12), so it is not recommended. A statically invariant factory call in `graph/build.ts` runs once per program, and the call-count rule rejects it.
- **The remaining recall gap** is the `PREPARE_STATE`/index cases: gitignore patterns (TanStack 17%) and the workspace lookup. CrankTS has the family (KWX), but recognizing "a repeated linear scan over invariant data" is not built (no new patterns until the generalization review).
- **CrankTS-transformable stays 0.** No hot Knip function lowers. With arrow functions and methods (R4), syntax is no longer the reason. The probes now reject on:
  - union and optional types: ESTree nodes, `string | undefined` results
  - `any`
  - class instances (parser results)
  - functions as values
  - async functions
  - captured closure state
  - `this`

  That is expected for orchestration and AST code; it is not a syntax gap.

## Coverage Funnel (Vite)

1. **runtime:** 100%
2. **attributable to Knip call sites:** 46%
3. **Knip's own JavaScript:** 9.3%
4. **human-plausible:** 11.5%
5. **human-evidence-supported:** 11.1%, almost all of it measured hoisting at `glob`
6. **CrankTS-recognized:** 10.2%
7. **CrankTS-transformable:** 0%
8. **validated-beneficial:** not measured

## Verdict for This Data Point

| Measure | Value (median over workloads) |
| --- | --- |
| Human-plausible acceleration coverage | 11.5% |
| Evidence-supported | 4.3% |
| CrankTS-recognized | 2.3% |
| Pipeline-supported | 0% |
| Automated recognition recall | 0.46 |
| Pattern-family recall | 1.0 |

- **The families recur:** the pattern families CrankTS has (hoisting and prepared state) cover what review finds.
- **Recognition is evidence-based:** it now finds the measurable case without false positives.
- **Native execution is not the lever for Knip.**
- **No Go/No-Go from one project.** Next: TypeDoc, ESLint, Effect, noble-hashes.

## Original Findings (Before v0.2.6d)

### What CrankTS Recognized: 0%

- **No hotspot passes a probe.** Every Knip hotspot is an arrow function, a method, a generator, or an AST visitor over oxc's ESTree union types:
  - Lowering only takes top-level `function` declarations.
  - The Kernel IR has no model for dynamic object graphs (`unions ... are not lowered`).
- **The advisor recognizes almost nothing.** It flags only two small visitor functions (`PARALLELIZE:HIGH`, 0.3–0.5%). Its recommendations are per function and self-time based, so it does not see time that Knip causes inside dependencies.

**Recognition recall: 0.** CrankTS recognizes none of the call sites that human review marks transformable.

### What Was Transformable (Human Review, First Labels)

| Call site | Share of runtime | Pattern | Why |
| --- | ---: | --- | --- |
| `glob` (`util/glob-core.ts`) → tinyglobby | 1.2–10.6% picomatch compilation, 75–80% of the call site | `HOIST_INVARIANT_WORK` | tinyglobby compiles the ignore patterns (picomatch `parse`/`scan`/`makeRe`/`toRegex`) on every call. Compiling once per ignore set would remove most of it. The work is inside a dependency. Whether the inputs repeat across calls is inferred from the code, not measured. |
| `isGitIgnored` → picomatch `arrayMatcher` | 0.5–17% (TanStack: about 11% regex execution) | `PREPARE_STATE`, `CHANGE_ALGORITHM` | Every path is tested against hundreds of separate gitignore regexes; results are already memoized per path. Prefiltering or indexing the patterns (literal suffix or basename) or merging them is domain-specific. |
| `isExcluded` (directory crawl) | up to 2.4% | `CHANGE_ALGORITHM` | A chain of picomatch closures that grows per batch of patterns; merge into one matcher. |
| `ConfigurationChief.findWorkspaceByFilePath` | 0.6–2.9% | `PREPARE_STATE`, `CHANGE_DATA_LAYOUT` | Memoized per file, but a linear `startsWith` scan over all workspaces (about 230 in Backstage). A path-segment index built once makes it O(depth). |
| `isShadowed` (visitor) | < 0.4% | `CHANGE_DATA_LAYOUT` | Linear scan over scope ranges. |

Not transformable, or already optimal:

- **I/O:** `readFileSync` of every source file (5–20%), gitignore and tsconfig reads
- **Already native:** oxc parse (3–10%), oxc-resolver
- **Dependency code:** oxc-parser's JS visitor (2–7%), jiti config loading (up to 7%), yaml
- **Hashing:** SHA-1 of file contents
- **AST visitors:** per-node Map lookups over dynamic ESTree objects
- **Orchestration and bookkeeping**
- **Already optimal:** `buildLineStarts`, a native `indexOf` scan. It would be lowerable except for its arrow-function syntax, and a native kernel would not beat V8 there.

**Human-transformable share:** 2.3–22.6% of runtime, median 14.5%. It sits almost entirely at call sites into dependencies, plus a few small Knip-specific algorithmic fixes. None of it is a native-offload candidate: Knip is already a hybrid of TypeScript orchestration and Rust parsing and resolving.

### First Coverage Funnel (Vite)

1. **runtime:** 100%
2. **Knip code (self):** 13.7%, partly oxc-resolver time hidden behind N-API frames
3. **attributable to Knip call sites:** 46%
4. **transformable according to human review:** 14.5%. Of that, 10.6% is picomatch compilation inside tinyglobby, which is invariant work in a dependency.
5. **recognized by the advisor:** 0%
6. **supported by today's pipeline:** 0%

Not measured yet: "worthwhile after the cost model" and "successfully accelerated". No transformation was forced, as planned.

### First Verdict

- **Known-pattern coverage: 0%. Human-transformable: about 15% (median), call-site based.** By the stop/go table, a single project reaching 0% known-pattern coverage would be "problematic". But the gap is not "unique idioms":
  - The one sizable item is `HOIST_INVARIANT_WORK`, the same pattern family that delivered 80% of the KWX gain.
  - The rest is `PREPARE_STATE` or index-building (`findWorkspaceByFilePath`, gitignore patterns).

  So the patterns recur; what fails is recognition: where CrankTS looks, and which syntax it accepts.
- **Native execution is not the lever for Knip.** It already offloads parsing and resolution to Rust.
- **Knip alone gives no Go/No-Go.** Four more projects are needed: TypeDoc, ts-morph, ESLint, and one data-heavy tool.

### What It Changed (Implemented in v0.2.6d)

1. **Call-site attribution belongs in the advisor (Advisor v2).** Transformations act where the time is *caused* (call sites into dependencies), not only where self time is spent. `attributeToCallSites` is the first step.
2. **Recognize repeated invariant work across calls (`HOIST_INVARIANT_WORK`).** Look for compile-like calls (pattern or regex compilation, parsers, matcher factories) whose inputs are invariant or repeat across calls of a hot function; the fix is to memoize them. This is the most promising generic pattern after KWX.
3. **Close the syntax gap in lowering.** Accept `const f = (...) => ...` and methods without `this` as kernels. It changes nothing for Knip, but it is cheap and common.
4. **Classify N-API time as external native.** A frame that calls a native addon function should not count as project-owned compute.
5. **Support the TypeScript 7 era.** Knip pins TypeScript 7.0.2, whose JavaScript package has no compiler API. CrankTS now falls back to its bundled TypeScript 5.9 when the project's compiler lacks the checker API, and the report records which compiler was used (`typescript.source`).
