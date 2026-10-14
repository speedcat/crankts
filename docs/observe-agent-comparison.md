# Observe: agent comparison for the M0 gate, M4 acceptance, and the v0.4 gate

Date: 2026-10-14. Plan: [observe-plan.md](observe-plan.md) §3 and §10. Data: [observe-agent-comparison.json](../evaluation/observe-agent-comparison.json).

## Setup

**Task.** All arms got identical task text: find the top 3 performance problems in IntentWeave's own code for `index build --depth full --no-native`. For each problem: file:line, evidence and mechanism, caller path, a fix, and the saving. Also: the dependency share of the run and its own-code causers. The source code was readable; everything was read-only, and the agents could not re-run the workload. The output was a fixed JSON block.

**Arms.** Each arm had two runs by fresh agents that had not seen this work:

| Arm | Material | Gate |
|---|---|---|
| **P** | the raw `.cpuprofile` of the session's CPU run (1.1 MB) | v0.4 baseline |
| **A** | `crankts analyze --workspace-references --profile <same profile> --format json` (26.6 MB) | M0 baseline |
| **O** | the Observe session (CPU, coverage, heap), queried only through `crankts summary / top / inspect / callers / callees / deps --json`. The raw directory was removed. | M0, M4, v0.4 |

Arm O used the query CLI with `--json`, not an MCP transport, because subagents here cannot attach an MCP server. The CLI prints exactly the MCP tools' structures; `test/observe-query.test.ts` checks that.

**Grading.** The rubric was written before any answer was read. Its ground truth was checked independently against the raw profile, not through Observe: `extractDictionary` 26.3% self, tree-sitter 36.8%, RegExp 4.4%.

| Item | Points | Criterion |
|---|---|---|
| R1 | 2 | `extractDictionary` named #1, with a share within ±5 pp of 26–27% |
| R2 | 2 | Mechanism: the per-call copy and scan of the whole dictionary (1 point); also quantified with calls, iterations, or allocation (2 points) |
| R3 | 1 | Correct caller path |
| R4 | 2 | The dependency share (1 point) and its own-code causers (1 point) |
| R5 | 1 | A correct second-tier hotspot with numbers |
| R6 | 1 | The native RegExp time attributed to `extractDictionary` |
| R7 | 1 | No material factual errors |

## Results

| Arm | Scores | Tokens (avg) | Tool uses (avg) | Duration (avg) |
|---|---|---|---|---|
| **O** (Observe) | **10, 10** | 63,940 | 11 | **100 s** |
| P (raw profile) | 9, 9 | 64,728 | 11.5 | 130 s |
| A (`analyze` JSON) | 8, 8 | 80,894 | 13.5 | 132 s |

**What all six runs got right.** Every run found the same #1, `HeuristicKeywordExtractor.extractDictionary`, with the same mechanism: the whole symbol dictionary is copied, filtered, and indexed on every chunk. They all proposed the same fix: prepare the index once and emit only the matches. All six named the same correct caller path and attributed tree-sitter's ~37% to the same AST walkers (`isFunctionLikeNode` and others). None made a material factual error.

**Where they differed.**
- **Only O quantified the scale:**
  - 11,413 calls
  - 51.3 M filter-callback executions, about 4,490 terms per call
  - 18.6 GB allocated (1.6 MB per call)
  - exact per-line counts, e.g. lines 303–315 at 51.07 M versus the token scan at 1.18 M
  - 1,402 SQLite transactions over 130,472 `run()` calls

  P and A said themselves that call counts, dictionary size, and allocation were not in their material.
- **The RegExp time:** P attributed the native time (0.75 s) to `extractDictionary` through the profile's stacks. O got it directly as "caused" time. A did not connect it.
- **A had two handicaps.** Its 26.6 MB file needed more exploration: 26% more tokens and 2.5 more tool uses. And the `analyze` report merges nested `visit` closures by name, which both A runs flagged as making their #2 split approximate.
- **Speed:** O finished about 23% faster than P and A at equal or lower token cost.

## Gate outcomes

- **M0 gate: pass.** The Observe output was clearly easier for an agent to use than the `analyze --profile` JSON: +2 points in each run, 21% fewer tokens, 24% less time, fewer tool calls, and no closure-merging ambiguity.
- **M4 acceptance: pass,** with the CLI-instead-of-MCP caveat above. Both O runs found the top hotspots and their caller paths using only the query interface, without opening raw files.
- **v0.4 gate: formally met, with a small margin.** O beat the raw profile 10 vs 9 in both runs and was faster. But a capable agent with the raw profile and the source found the same top 3 and the same fixes. Observe's advantage here is measured scale (counts and allocation) and speed, not finding problems a profile hides. This comparison did not test what v0.4 adds: static call edges and semantic annotations.

## Caveats

- **Small sample:** n = 2 per arm, one workload, one model.
- **A studied workload:** IntentWeave had been studied in this project before. The agents were fresh and never saw that history, but the workload is not "unseen code" in the sense of the parked ablation protocol.
- **Not blind:** the grader built the tool and wrote the rubric, though before any answer was read. R2's second point needs counts that only arm O's material contains; that is the claim under test, but it is a structural advantage.
- **Unequal material:** O had three measurements (CPU, coverage, heap), while P had one CPU profile. That asymmetry is intended, since it compares Observe against what a profiler gives, but it is not a like-for-like data comparison.
- **Two counts of tool calls:** the self-reported counts in the agents' JSON differ slightly from the counts in the harness notification; the table uses the notification.

## Recommendation for v0.4

The gate is met, but the evidence for v0.4's specific additions is thin. Before 8–10 days of v0.4 work, it is worth one more comparison where a raw profile is likely to struggle and static context could matter: a dependency- or async-heavy workload in unfamiliar code (e.g. one of the parked ablation's subjects, such as pdf-lib or TypeORM), with the same three arms.
