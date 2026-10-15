# Observe agent comparison 2: P vs P+ vs O, scored by measured outcome

**Results (2026-10-15):** all 12 runs valid, no difference between the arms; see [results.json](results.json) and [the comparison document](../../docs/observe-agent-comparison.md#comparison-2-results-2026-10-15).

Follows [observe-agent-comparison.md](../../docs/observe-agent-comparison.md), whose v0.4 gate was not decided: the first comparison's 10 vs 9 came from a rubric point only Observe could earn, and the scale data changed no decision. This protocol is fixed before any run.

## Question

Does CrankTS's model (one join of CPU, coverage, and heap onto code entities) make an agent choose and implement a *better optimization* than:
- **P:** a raw CPU profile;
- **P+:** the same three raw recordings without CrankTS?

P+ separates "the join" from "more data". If O only matches P+, the collector settings are the product, not the model.

## Arms

All arms have the same source workspace, workload, test command, rules, budget, and task text; only the material differs. All recordings come from one Observe session per workload, recorded in the pristine baseline clone.

| Arm | Material |
|---|---|
| P | `profile.cpuprofile` (the CPU run) |
| P+ | `profile.cpuprofile`, `coverage.json` (the coverage run, including Node's source-map cache), `heap.heapprofile` (the heap run, collected objects included) |
| O | the Observe session (no raw files), queried only through `crankts summary / top / inspect / callers / callees / deps --json` |

The preload's own frames in the raw files are renamed to `/observer/preload.cjs`.

## Workloads

Chosen by a screening run on 2026-10-14 (Node 24.21, all sessions quality `high`):

- **`typeorm-insert`** (TypeORM `relational-insert-500000-orders`, about 9 s). *Quantity decides:* `QueryBuilder.getParameters` costs about 1 ms per call over 1,503 calls (1.6 s), while `hasParameter` and `setParameter` cost about 0.1 µs per call over 8.5 M calls (1.2 s and 0.5 s). Each batch carries about 5,700 named parameters. Which lever is larger is not visible from a CPU profile alone.
- **`pdflib-modify`** (pdf-lib `modify-large-existing-pdf`, about 7 s). Dependency-heavy (~48% in dependencies); `ByteStream.next` runs 44 M times. It also contains a trap: about 0.6 s are esbuild export getters that tsx generates (a loader artifact a production build would not have).

## Runs

3 arms × 2 workloads × 2 repetitions = 12 runs in a seeded shuffled order (`control/run-map.json`). Each run has its own copy-on-write workspace clone. Agents are fresh general-purpose subagents with the same model, started from `prompts/<runId>.md`. They may run the workload, the measure script, and the tests, but no profilers or instrumentation. Budget: about 60 tool calls.

## Scoring

**Primary: measured outcome.** `measure-outcome.mjs <runId>` measures each run against the pristine baseline:
- allowed files only, with `crankts-workloads/` unchanged;
- identical output checksum;
- 10 interleaved baseline/candidate timings after one warm-up each, reporting medians and MAD;
- the subject's tests pass.

Dry runs on untouched workspaces measured 0.992× (TypeORM) and 0.978× (pdf-lib) with 3 pairs. Speedups within about ±3% of 1.0 are noise.

A run is **valid** when all of these hold. Its score is `speedup = baseline median / candidate median`; an invalid run scores 1.0 (no gain).

**Secondary: blind grading.** `blind-kit.mjs` anonymizes reports and diffs and removes words that reveal the arm. A second model, not the one that ran the agents, grades each submission without the outcome numbers:

| Score | Criterion |
|---|---|
| 0–2 | diagnosis supported by evidence |
| 0–2 | change preserves semantics, with no gaming (caching outputs, special-casing the workload, weakening checks) |
| 0–1 | alternatives considered and the choice justified |

**Analysis, fixed in advance:**
- Per workload, compare the arms' speedups (2 runs each) and whether each run chose the lever that measures largest.
- O vs P+ answers "join or data"; O vs P answers the v0.4 gate. With n = 2 only differences larger than run-to-run spread (MAD) count.
- Cost (tokens, tool uses, duration) is recorded from the task notifications.
- No O+S arm: static annotations do not exist yet; a later round can add it.

## Machine conditions

A TypeORM run needs about 1 GB (peak RSS 0.8–1.0 GB; its tests need more), a pdf-lib run about 0.4 GB. On 2026-10-15 a validation run took 15 min instead of 9 s, because swap was full (21.1 of 21.5 GB) and the load average was about 50. So:

- **Before the campaign,** free memory: `sysctl vm.swapusage` should show most swap free and the load average should be below the core count.
- **Agents in batches of at most 3**, because each one runs the workload and the tests.
- **Outcome measurements one at a time,** after all agents finish. `measure-outcome.mjs` records load and free memory and refuses to measure when the 1-minute load exceeds the core count (override with `--force`).

## Steps

```bash
pnpm build                                              # CrankTS dist for the O arm
node evaluation/observe-comparison-2/prepare.mjs        # baselines, materials, workspaces, prompts, run map
node evaluation/observe-comparison-2/measure-outcome.mjs <runId> --skip-tests --runs 3   # dry run on an untouched workspace
# run the 12 agents from prompts/<runId>.md; save each final report to reports/<runId>.md
node evaluation/observe-comparison-2/measure-outcome.mjs <runId>          # per run, after the agents finish
node evaluation/observe-comparison-2/blind-kit.mjs                        # then grade blind-kit/*.md
```

The campaign data lives outside the repository in `../crankts-eval/observe-comparison-2026-10/`; it holds clones of the subjects.
