# CrankTS: Outcome

Status: 2026-10-15 · **The project is closed.** This is the final write-up: what CrankTS set out to do, what each experiment measured, which decision followed, and what is worth keeping. The details are in the linked documents; this page adds no new measurements.

## In one paragraph

CrankTS started as a way to make TypeScript faster by moving hot code to Rust. Native code was often much faster locally but barely moved whole workloads, because the project's own JavaScript was only 8–37% of runtime and plain algorithmic fixes in TypeScript gave as much as the best native kernel. That led to an advisor, then to an evidence layer, then to Observe: code-level runtime observability for coding agents. In the last test, on two unfamiliar workloads, an agent with a raw CPU profile and the source chose the same fixes with the same measured speedup as an agent with Observe. No product thesis is left that the measurements support, so the project ends here.

## Hypotheses, experiments, and decisions

| # | Hypothesis | What was measured | Decision |
|---|---|---|---|
| 1 | **Hot TypeScript can be lowered to Rust/N-API for a real gain.** | IntentWeave KWX: a manual napi-rs scanner gave 1.225× on the full build (2.49× in the microbenchmark), while a TypeScript matcher rewrite took the build from about 35 s to about 19 s. CrankTS's own graph kernel was 2.9× faster natively but saved about 3 ms of 5.9 s. Over six external projects, own JavaScript was 8–37% of runtime, and no hot application function passed the lowering. A hand-written Rust SHA-256 was 1.75× over V8; scriptc native builds ran at 0.09–0.17× of V8. | **Stopped** (2026-10-11). Kernel IR, Rust backend, proof obligations, and parity gates are frozen as research code. |
| 2 | **A native thread pool unlocks parallelism.** | Where parallel work existed, `worker_threads` reached it (IntentWeave stage 2.87×; full build 19.4 s → 14.1 s with four workers). On a closed-source project, scaling stopped at two ingesters (1.3×) because the database did 2–3× the application's CPU. | **Stopped.** |
| 3 | **Pattern recognition per hotspot can advise optimizations.** | Recognizers reached single-digit percent coverage, and every project needed bespoke fixes. The Knip evaluation showed that recognition, not the pattern families, was the gap. | **Stopped.** |
| 4 | **Workload evidence (call counts, repeated inputs, identical objects) finds the waste.** | It reproduced known findings: identical objects hashed again (16%, validated at −17% wall time), every entity indexed twice (15%, validated up to −23%), and Knip's repeated `glob` option work (9%). One hypothesis was refuted by measurement (a JSON-parse cache, −0.8%, within noise). | Kept as a finding. The blind ablation that would have tested it against a plain profile was **parked** and later superseded by the Observe comparisons. |
| 5 | **Observe: one join of CPU, coverage, and heap onto stable code entities helps a coding agent.** | M0–M5 built and validated (100% of IntentWeave's own samples mapped; exact execution counts; per-call estimates; CLI and MCP). Comparison 1 on IntentWeave: Observe 10/10, raw profile 9/10, `analyze` JSON 8/10, but all arms found the same #1 and fix, and the 10 vs 9 came from a rubric point only Observe could earn. Comparison 2, scored by measured speedup on TypeORM and pdf-lib: P (raw profile) 1.235 / 1.154, P+ (raw recordings, no CrankTS) 1.231 / 1.190, O (Observe) 1.220 / 1.151. | M0 gate and M4 acceptance **passed**; v0.4 gate **not met**. v0.4 and v0.5 **not built**. **Project closed** (2026-10-15). |

Sources: [eval-generalization.md](eval-generalization.md), [analysis-and-evaluation.md](analysis-and-evaluation.md), [plan.md](plan.md) (decision records), [observe-plan.md](observe-plan.md), [observe-agent-comparison.md](observe-agent-comparison.md), and the JSON files under [evaluation/](../evaluation/).

## What the evidence says

- **Local speedups rarely reach the whole workload.** Most time sits in dependencies, native code, I/O, and the runtime, outside what a TypeScript-to-native backend can take. Amdahl's law decided most native questions before the backend did.
- **Algorithmic fixes in TypeScript beat native code** wherever both were tried.
- **A capable coding agent with a CPU profile and the source finds the same levers.** In both comparisons, more data (counts, allocation) and CrankTS's model gave better-supported answers but did not change which fix was chosen or how much it gained.
- **What the comparisons cover:** two comparisons, three workloads, one model, n = 2 per arm. On the tested workloads, the agents found the levers without CrankTS. They do not show that runtime evidence can never help.

## Lessons for evaluating agent tools

- **A rubric point only one arm can earn measures the material, not the effect.** Comparison 1's lead came entirely from such a point.
- **Score outcomes, not reports.** Measured speedup, output checksums, green tests, and allowed-file guards settled what rubric scores could not.
- **Separate "more data" from "the model".** The P+ arm (the same raw recordings without the tool) is the control that tells the two apart.
- **Watch the machine and the loader.** Swap and load ruined one validation run, so the harness checks load before each measurement. tsx export getters made part of the pdf-lib gains a loader artifact.
- **Explain spread before reading means.** The pdf-lib spread (1.05–1.25×) came from code variants, visible in stable baselines and the diffs, not from timing noise.

## What is worth keeping

| Part | Where | Why |
|---|---|---|
| Call-site attribution, caller paths, frame classification (own, dependency, runtime, native, loader-generated) | `src/analysis/cpu-profile.ts`, `src/observe/resolve/`, `src/observe/aggregate/` | Reusable for any tool that maps V8 profiles to source |
| Stable entity keys on `oxc-parser` | `src/observe/entity/` | Source-level identities without a TypeScript checker |
| Observe sessions, quality checks, CLI, MCP | `src/observe/` | Work as they are, for anyone who wants CPU, counts, and allocation per entity |
| Outcome harness: interleaved pairs, checksums, allowed-file and load guards | [evaluation/observe-comparison-2](../evaluation/observe-comparison-2/README.md) | A ready check of whether an agent's change actually helped |
| Fail-closed lowering with proof obligations, parity runner, benchmark gate | `src/lowering/`, [lowering.md](lowering.md) | Research code for a future compiler or agent project |
| The evaluation history | `docs/`, `evaluation/` | Negative results with data |

## Open questions (not a roadmap)

- **Profiling the candidate.** In comparison 2 the agents could time their changes but not profile them. Two of them stopped at 1.05× where others reached 1.25×. Whether profile feedback on the candidate closes that gap is untested, and existing profilers and continuous-benchmarking tools largely cover it.
- **A runtime architecture map for humans.** It would project measured execution onto the static code structure. That would be a new project with its own stop criterion, not a continuation of this one.
- **TypeScript 7's checker API** (`typescript/unstable/sync`) was not adopted; see [plan.md](plan.md#open-point-a-faster-typescript-checker).

## State of the repository

The code stays as it is. `analyze`, `observe`, the queries, and `mcp` keep working; `extract` and the native backend stay frozen. There is no further development, and issues are not expected to be addressed.
