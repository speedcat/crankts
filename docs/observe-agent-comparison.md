# Observe: agent comparison for the M0 gate, M4 acceptance, and the v0.4 gate

Date: 2026-10-14. Plan: [observe-plan.md](observe-plan.md) §3 and §10. Data: [observe-agent-comparison.json](../evaluation/observe-agent-comparison.json).

> **Outcome (2026-10-15):** the second comparison, scored by measured speedup, found no difference between the arms ([below](#comparison-2-results-2026-10-15)). The v0.4 gate is not met, v0.4 is not built, and the project is closed ([outcome.md](outcome.md)).

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
- **v0.4 gate: not decided** (corrected after review on 2026-10-14; the first version said "formally met"). The 10 vs 9 gap is entirely R2's second point. Both P runs earned everything else, R6 included. R2's second point needs counts that only arm O's material contains, so the rubric built the gap in; it was not measured. Without it the score is 9 vs 9. In substance it was a tie: the same top 3, mechanism, caller path, and fix. O's shorter duration (98–102 s vs 124–137 s) is not evidence at n = 2. This comparison also did not test what v0.4 adds (static call edges and semantic annotations).

## What the result does not show

- **The counts changed no decision.** Only O had the 11,413 calls, 51 M callback executions, and 18.6 GB of allocation, yet all six runs proposed the same fix. On this task the scale gave the answer better support, not a better answer. The rubric scored what agents reported, not whether a fix works; the agents could not run the workload.
- **Join or just more data.** O had three measurements, P one. Whether O's edge comes from CrankTS's join (one model across CPU, coverage, and heap, mapped to entities) or simply from having more raw data stays open. An arm **P+** separates the two: the raw `.cpuprofile` plus the raw coverage and heap files, without CrankTS. If O only matches P+, the collector settings are the product, not the model.

## Caveats

- **Small sample:** n = 2 per arm, one workload, one model.
- **A studied workload:** IntentWeave had been studied in this project before. The agents were fresh and never saw that history, but the workload is not "unseen code" in the sense of the parked ablation protocol.
- **Not blind:** the grader built the tool and wrote the rubric, though before any answer was read. R2's second point needs counts that only arm O's material contains; that is the claim under test, but it is a structural advantage.
- **Unequal material:** O had three measurements (CPU, coverage, heap), while P had one CPU profile. That asymmetry is intended, since it compares Observe against what a profiler gives, but it is not a like-for-like data comparison.
- **Two counts of tool calls:** the self-reported counts in the agents' JSON differ slightly from the counts in the harness notification; the table uses the notification.

## Next comparison (before any v0.4 work)

There is no evidence for v0.4 yet. The next comparison should decide it, on unfamiliar code where a raw profile is likely to struggle: a dependency- or async-heavy workload such as pdf-lib or TypeORM (subjects of the parked ablation).

- **Arms:** P (raw CPU profile), **P+** (raw CPU profile plus raw coverage and heap files, no CrankTS), O (Observe), and, if v0.4 is to be justified, **O+S** (Observe plus a prototype of static annotations).
- **A task where quantity decides:** two plausible hotspots, one cheap per call but multiplied, the other expensive per call, with different payoffs. Only an agent that knows the counts picks the right one.
- **Score the outcome, not the report:** agents implement their fix; the speedup is measured with hyperfine; the project's tests must stay green. That removes the rubric asymmetry above.
- **Partly blind grading:** anonymized answers in shuffled order, scored by a second model or person.

The 8–10 days for v0.4 are worth spending only if O or O+S beats P+ on measured outcome.

**Prepared (2026-10-14), without O+S:** [evaluation/observe-comparison-2](../evaluation/observe-comparison-2/README.md). It covers 12 runs (P, P+, O × TypeORM insert and pdf-lib modify × 2) with isolated workspaces, an outcome harness (allowed files, checksum, interleaved timing, tests), and a blind-grading kit.

## Comparison 2 results (2026-10-15)

Protocol: [evaluation/observe-comparison-2/README.md](../evaluation/observe-comparison-2/README.md), fixed before any run. Data: [results.json](../evaluation/observe-comparison-2/results.json). All 12 runs are valid: identical output checksums, green tests, and no edits outside the allowed files.

Speedup = baseline median ÷ candidate median, from 10 interleaved pairs per run:

| Workload | P (raw profile) | P+ (raw profile + coverage + heap) | O (Observe) |
|---|---|---|---|
| TypeORM insert | 1.232, 1.237 (mean 1.235) | 1.227, 1.234 (mean 1.231) | 1.227, 1.214 (mean 1.220) |
| pdf-lib modify | 1.056, 1.252 (mean 1.154) | 1.245, 1.135 (mean 1.190) | 1.052, 1.251 (mean 1.151) |

**What it shows:**
- **No arm advantage.** On TypeORM, all six runs chose the same lever: the per-execute copy of the parameter map in `QueryBuilder.getParameters()`. On pdf-lib, all six chose a variant of the first-byte skip in `PDFObjectParser.findEndOfStreamFallback`. The arm means are within the within-arm spread.
- **The join hypothesis is not supported.** O vs P+ is 1.220 vs 1.231 (TypeORM) and 1.151 vs 1.190 (pdf-lib). The raw-data arm is no worse in either case.
- **The designed "quantity decides" lever did not discriminate.** Every arm, P included, found the copy from the profile and the source alone.

**The pdf-lib spread comes from the variant, not the machine.** The baseline medians are 4143–4174 ms in all six pdf-lib runs, and the per-run MADs are 7–34 ms. Only the candidates differ, and they differ in how often the scan loop reads the `CharCodes` enum per byte:

| Runs | `CharCodes` reads per byte in the scan loop | Speedup |
|---|---|---|
| r04 (O), r08 (P) | 4 (`CharCodes.s/e/CarriageReturn/Newline` in the condition) | 1.05 |
| r12 (P+) | about 2 (`s`/`e` from `Keywords[0]`, CR/LF from `CharCodes`) | 1.135 |
| r07 (P+), r11 (P) | 0 (hoisted to locals or module constants) | 1.25 |

r05 (O, 1.251) reached the same level with a separate `ByteStream.skipUntil` loop. Under tsx, `CharCodes` members are esbuild export getters. That is the loader artifact the protocol named as a trap. Much of the 1.05–1.25 gap is therefore specific to the tsx-run workload and would likely shrink in a compiled build; this was not measured.

**Correction to the earlier review.** In this comparison the agents *could* time their candidates with the measure script, just not profile them. r04 and r08 measured their small gains and put them down to noise under machine load (r08 reports load averages up to 41). r07 measured the skip alone at about 4%, then hoisted the constants. So "agents could not check their change" does not explain the spread. Profiling the candidate might have; that stays untested.

**Not graded, but visible in the diffs.** In 4 of the 6 TypeORM runs (both O, both P+), the public `getParameters()` now returns the live parameter map. Both P runs kept the public copy and changed only the internal execute path. The blind grading, which would have scored this, was not run.

**Not recorded:** tokens and duration per run (the task notifications were not saved). The agents' self-reported tool calls are 12–28 and show no pattern by arm.

**Gate outcome: v0.4 not met.** Neither O vs P (the v0.4 gate) nor O vs P+ (join or data) shows a difference larger than the within-arm spread. v0.4 is not built. With this result, the project closes as a research write-up ([outcome.md](outcome.md)).
