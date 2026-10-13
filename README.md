# CrankTS

<p align="center">
  <img src="ressources/crankts-wordmark.svg" alt="CrankTS" width="720" />
</p>

<p align="center"><strong>Crank up your TS.</strong></p>

> [!IMPORTANT]
> **CrankTS is a research experiment, not a product.** It started as a TypeScript-to-native offload idea and has become an evidence-and-diagnosis tool. Six external evaluations and several gain measurements have stopped the native direction; the one open bet, whether CrankTS's workload evidence makes an agent better at finding validated speedups, is being tested now. See [Status of the Experiment](#status-of-the-experiment). Report formats and heuristics may change at any time.

<p align="center">
  <img src="ressources/crankts-illustration2.png" alt="CrankTS analyzes TypeScript, measures workload behavior, and recommends acceleration opportunities" width="960" />
</p>

> **Write TypeScript. Pay for dynamism only where you use it.**

CrankTS is an evidence-first performance analysis tool for existing TypeScript projects. It attributes profiled runtime to call sites (own code, dependencies, native addons, I/O), follows the dominant caller paths, probes expensive calls for repeated or duplicated work, and states what it measured separately from what it merely suspects.

**Today:**
- Static analysis, profile correlation, call-site attribution, and caller paths (`analyze`).
- A workload evidence probe that records call counts, repeated inputs, identical objects, and duplicate content, and derives observations and hypotheses with preconditions (v0.2.6e).
- `crankts extract`, which transforms explicitly selected kernels into Rust/N-API crates. It does this only when a fail-closed contract validates, and each crate comes with a TypeScript fallback wrapper, a parity runner, and a benchmark with an acceptance gate. This backend is frozen (see below).

The `analyze` command does not execute the analyzed application or rewrite its source. Whether an optimization is worth making is decided by measuring a patch, not by this tool.

## Status of the Experiment

*As of 2026-10-11. The decision record and exit criterion are in [docs/plan.md](docs/plan.md#decision-after-the-sixth-review-round-2026-10-11); the data is in [docs/eval-generalization.md](docs/eval-generalization.md).*

### What the evidence says

Six projects were profiled and reviewed (Knip, TypeDoc, ESLint, Effect, noble-hashes as a compute-bound control, and one closed-source monorepo, whose details stay private):

- **The time is rarely in code a native backend can take.** On application code, the project's own JavaScript is 8–37% of runtime; the rest is dependencies, native code, I/O, and the runtime. No hot function in any application workload passed the lowering.
- **Native gain is small where it is possible.** A hand-written Rust SHA-256 kernel is 1.75× faster than V8. Native builds of ordinary TypeScript by scriptc 0.2.8 ran at 0.09–0.17× of V8. A plain algorithmic fix in TypeScript gave 1.8× on IntentWeave's hottest function, as much as the best native kernel. KWX native, measured earlier, was at parity with V8.
- **Parallelism does not need a native pool.** Where parallel work exists, `worker_threads` already reach it. On the closed-source project, scaling over several ingesters against Postgres stops at two (1.3×), because the database does 2–3× the application's CPU per entity.
- **The evidence layer reproduces known findings.** From runtime data alone, it found the two largest wastes in the closed-source project (identical objects hashed again, 16%, validated at −17% wall time; every entity indexed twice, 15%, validated up to −23%) and Knip's repeated `glob` option work (9%). It also produced a hypothesis that measurement refuted (a JSON-parse cache: −0.8%, within noise). Estimates and upper bounds are not gains; only a measured patch is.
- **The pattern-recognition approach did not generalize.** Per-hotspot recognizers reached single-digit percent coverage, and every project needed bespoke fixes.

### What is stopped, frozen, or parked

| Track | Status |
| --- | --- |
| General TypeScript-to-native lowering, a static or dynamic-native tier | **Stopped** |
| Native thread pool | **Stopped** (pipeline-level parallelism stays a topic for the advisor) |
| Kernel IR, Rust backend, proof obligations, parity gates | **Frozen**, kept as an opportunistic backend (native work only at an expected whole-workload gain of at least 10%) |
| `TransformationPlan` (v0.2.7) | **Parked** |
| Guarded specialization | **On hold** until a TypeScript-only specialization of a hot spot leaves a real gap |

### What is happening now: the agent ablation

The remaining question is a product question: *does a workload-aware evidence graph make a competent performance engineer, human or agent, materially better at finding validated improvements?*

- **Design:** three arms on unfamiliar code (RxDB, pdf-lib, TypeORM, and one more repository). The agent gets either a plain CPU profile and summary (P), plus CrankTS evidence (E), plus CrankTS hypotheses (H). Every reported finding is re-measured blind to the arm. Protocol: [docs/ablation-protocol.md](docs/ablation-protocol.md); tools: [evaluation/ablation](evaluation/ablation).
- **State:** the 24 isolated runs (2 per arm per repository) are prepared, and a review of the preparation found and fixed a blocker: the E and H material had been empty, because the analysis was pointed at a folder that does not contain the sources, and the evidence probe could not run under the Node/tsx combination used. The material is regenerated and synced into the workspaces; the pre-flight script (`evaluation/ablation/preflight.mjs`) passes except for one workload that is not measurable (RxDB live query: 95% of its 5 s is a dangling timer). Still open before the first run: a fixed offline test command per repository, the sandbox read check, and recording model, effort, and Copilot version. Nothing has been run yet.
- **Rule:** E must beat P by at least 15 points of validated recall (or match it at 60% of the cost) in 3 of 4 repositories, with no worse false-positive severity.

### What happens next

1. Finish the preparation (decide the live-query workload, a fixed test command per repository), then run the 24 sessions and score them blind.
2. **If E clearly beats P:** CrankTS continues as an evidence and diagnosis tool. Next features: a stage view for async pipelines, and database statements joined to the call sites that issue them. Both are blind spots found on the closed-source project.
3. **If not:** CrankTS ends as a research result with a final write-up of what generalized (call-site attribution, evidence probes, fail-closed lowering with proofs) and what did not (per-hotspot recognition, TypeScript-to-native gains).

Native offload is no longer a promised direction. The earlier statement that CrankTS is intended to perform qualified transformations itself is withdrawn.

## Quick Start

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm dev analyze src/

# Build and run the CLI
pnpm build
node dist/cli.js analyze /path/to/project
```

The target can be a file or directory and defaults to the current directory. CrankTS loads the nearest `tsconfig.json`, uses the project's installed TypeScript compiler when available, and includes transitively resolved local callees in the analysis.

```bash
# Detailed call and parallelism evidence
pnpm dev analyze src/ --verbose

# Versioned machine-readable report
pnpm dev analyze src/ --format json

# Filter candidate islands by static Native Priority
pnpm dev analyze src/ --min-score 70

# Attach existing workload measurements and a pipeline descriptor
pnpm dev analyze src/ --profile ingest.cpuprofile
pnpm dev analyze src/ --heap-profile allocations.heapprofile --workload "request replay"
pnpm dev analyze ../intentweave/packages/analyzer --pipeline evaluation/intentweave-pipeline.json

# Include transitive TypeScript project references (opt-in)
pnpm dev analyze . --workspace-references

# Write per-stage wall time and memory of the analysis itself to a separate file
pnpm dev analyze . --timings timings.json

# Lower an explicitly selected kernel to a Rust/N-API crate (fails closed unless its contract is lowerable)
pnpm dev extract test/fixtures/lowering/src/graph-kernel.ts#graphBatch \
  --shape GRAPH_BATCH --graph offsets,neighbors --out /tmp/graph-kernel
```

Project-reference analysis creates a separate TypeScript program and checker per referenced project, then joins source-resolved calls using stable workspace-relative IDs. The default remains single-project analysis. Imports whose implementation is available only through declaration files remain external boundaries.

## How It Works

The architecture separates evidence, qualification, strategy selection, transformation, and validation. The transformer and validator stages are frozen (see the status above); the evidence, qualifier, and advisor stages are the active part:

```mermaid
flowchart TD
  Source["TypeScript + profiles + pipeline evidence"] --> Analyzer["Analyzer<br/>static + runtime evidence"]
  Analyzer --> Qualifier["Qualifier<br/>feasibility + proof obligations"]
  Qualifier --> Advisor["Advisor<br/>deterministic strategy selection"]
  Advisor -->|"algorithm, workers, layout, batching"| Optimize["Optimize TS / pipeline"]
  Advisor -->|"qualified native candidate"| Transformer["Transformer - frozen<br/>supported subset; fail closed"]
  Transformer --> Validator["Validator - frozen<br/>parity + benchmark + regression"]
  Validator -->|"pass"| Enable["Enable transformed region"]
  Validator -->|"fail or uncertain"| KeepTS["Keep original TypeScript"]
  Agent["Optional coding agent<br/>explain evidence; assist unsupported cases"] -.-> Advisor
```

Advisor-to-transformer is a mechanical transition gated by proof obligations, not an agent hop. An optional coding agent can explain findings and propose experiments; it cannot raise confidence or authorize a transformation. Whether an agent working from CrankTS's evidence beats one working from a plain profile is exactly what the ablation measures.

### Deterministic Transformation

Transformations must preserve observable behavior and fail closed. Every required language construct, type, effect, call boundary, and data representation must be supported by the selected backend. Unsupported or ambiguous code stays in TypeScript unchanged.

Generated code must pass differential parity checks and workload benchmarks before offload can be enabled, with the original TypeScript retained as a fallback. Agent-generated changes are outside this guarantee unless independently qualified and validated.

## What the Current Analyzer Reports

| Question | Evidence |
| --- | --- |
| Can a region cross a runtime boundary? | Types, blockers, propagated effects, `SUPPORTED` / `CONDITIONAL` / `BLOCKED` eligibility |
| Where might acceleration help? | Independent CPU, memory, and parallel opportunity heuristics; connected candidate islands |
| Is it hot in this workload? | Optional CPU and allocation profiles, matched coverage, and confidence |
| Is work independent, and what limits scaling? | Conservative loop/batch analysis and declared pipeline/sink constraints |
| Which action is justified? | Evidence-linked recommendations for algorithms, workers, layout, offload, event-loop isolation, batching, or serialized sinks |

`Native Priority` combines static suitability and opportunity; it is **not a runtime ranking or a safety proof**. With a CPU profile, candidate presentation uses observed self CPU first. Boundary costs and component-quality metrics are experimental diagnostics, not measured transition costs.

Parallelism is a heuristic, not proof of independence; `Promise.all` does not establish CPU parallelism. Pipeline declarations are analyst-supplied evidence, not observed contention. Allocation samples do not measure retained heap or RSS. Low profile coverage keeps recommendations provisional.

See [analysis details and evaluation history](docs/analysis-and-evaluation.md) for scoring, report semantics, profile limitations, and the pipeline descriptor contract.

## IntentWeave Validation

IntentWeave is the first real-world validation target. Two experiments show why strategy selection matters:

- **Optimize the algorithm first:** profiling exposed KWX dictionary matching as a hotspot that static ranking missed. A TypeScript matcher rewrite reduced a single full-depth build from about 35 s to roughly 19 s; low post-change profile coverage makes this directional evidence, not a calibrated speedup claim.
- **Test parallel scaling:** an explicit IntentWeave worker experiment measured 19.4 s with one worker and 14.1 s with four; eight did not improve end-to-end time. Selected tables matched exactly, but full-database parity was not established. This was one run per configuration, not an automatic CrankTS transformation.
- **Measure the sink:** one instrumented 30-document build measured a 797 ms SQLite writer stage in an approximately 15 s run (~5%). Annotations took 366 ms, with 1,140 transactions and 386 ms in COMMIT calls. This does not isolate lock-wait or show that SQLite is the current bottleneck; the run had no producer queue and was not repeated.
- **Validate a native candidate:** a manual napi-rs scanner replaced only the ASCII dictionary scan during five full-depth builds. All 49,002 `KeywordMatch` objects matched across 11,010 document/comment chunks; median full build was 15.07 s TypeScript vs. 12.30 s with the preload (1.225x). The full extractor microbenchmark was 2.49x faster, but cold per-chunk dictionary transfer was slower. This remains a manual PoC with no RSS/GC data or production integration; `def_use_chains` also varies between TypeScript-only runs. Details: [MVP-8 native candidate evidence](evaluation/intentweave-mvp8-native-poc.json).

Run a separate measurement-only TS build with:

```bash
iw index build --depth full --sink-metrics /tmp/iw-sink-metrics.json --output /tmp/iw-index.db
```

The metrics option bypasses the native backend and writes a JSON report outside the index database. Full details and caveats are in [the evaluation history](docs/analysis-and-evaluation.md#mvp-7b-sqlite-sink-measurement).

CrankTS is also its own negative control. Profiling it on the full IntentWeave workspace showed 95% of wall time in TypeScript-compiler-bound stages and 0.7% in its graph passes, and its self-assessment kept every graph kernel `KEEP_TS`. A separate native WCC/Tarjan kernel matched exactly and was 2.9x faster on the real graph including transfer (4.2x at 100× scale), but that saves about 3 ms of 5.9 s. The `GRAPH_BATCH` shape works; offloading it inside CrankTS would not matter. Details: [MVP-9a](evaluation/crankts-mvp9a-self-profile.json), [MVP-9b](evaluation/crankts-mvp9b-graph-crossover.json).

These experiments (the first phase of the project) support an evidence-led workflow, not blind TypeScript-to-Rust translation. The later evaluations are summarized in the status section above.

Detailed measurements, caveats, and follow-up gates are in [the evaluation history](docs/analysis-and-evaluation.md#intentweave-evaluation-history).

## Roadmap

| Milestone | State |
| --- | --- |
| v0.1: analyzer | Done: static eligibility, effects, parallelism heuristics, profile correlation, advisor |
| v0.2.0–v0.2.6d: extraction and recognition | Done and **frozen**: kernel contracts, Kernel IR, fail-closed lowering with proof obligations, `crankts extract` (Rust/N-API crate, fallback wrapper, parity runner, benchmark gate), hoisting and packing transformations on IntentWeave and CrankTS's own graph passes ([lowering](docs/lowering.md)), call-site attribution, `HOIST_INVARIANT_WORK` detection. The Knip evaluation showed that recognition, not the pattern families, was the gap ([eval-knip.md](docs/eval-knip.md)). |
| v0.2.6e: evidence before patterns | Done: caller paths, position-based profile matching, typed-array and `throw` eligibility, the evidence probe with observations and hypotheses |
| Evaluations #1–#6 | Done: Knip, TypeDoc, ESLint, Effect, noble-hashes, a closed-source monorepo ([generalization review](docs/eval-generalization.md)) |
| Decision (2026-10-11) | Taken: evidence and diagnosis go to validation; native tier, native thread pool, and the hybrid tier are stopped |
| **Agent ablation** | **In preparation**: E and H material fixed; open items above; then 24 runs and blind scoring |
| v0.2.7 `TransformationPlan`, v0.3 automatic offload | **Parked / no longer planned** |
| Exit | If the ablation does not favor evidence over a plain profile, the project ends as a research write-up |

Other backends, including WebAssembly and native JIT, are not planned.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

Technical context: [analysis and evaluation](docs/analysis-and-evaluation.md). Brand assets: [logo guide](ressources/crankts-logo-guide.md). License: [Apache-2.0](LICENSE).
