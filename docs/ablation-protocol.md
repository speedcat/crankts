# Agent Ablation Protocol (Product Gate for Track A)

> **Parked on 2026-10-13; not run.** CrankTS moved to Observe ([observe-plan.md](observe-plan.md)), whose M0 and M4 gates replace this product gate. See [plan.md](plan.md#decision-after-the-seventh-review-round-2026-10-13-observe).

**Question:** does CrankTS's workload evidence make a competent agent materially better at finding *validated* performance improvements in unfamiliar TypeScript code?

Three arms, same model, same budget, same prompt skeleton:

| Arm | The agent gets |
| --- | --- |
| **P** (profiler) | source tree, workload command, CPU profile, neutral profiler summary |
| **E** (evidence) | P + CrankTS evidence: call-site attribution, caller paths, static effects, observations with upper bounds |
| **H** (hypotheses) | E + CrankTS hypotheses with preconditions and estimates, advisor recommendations, hoisting candidates |

P → E measures the value of the measurements; E → H measures the value of deterministic hypothesis derivation. Decision rule and exit criterion: [plan.md](plan.md#decision-after-the-sixth-review-round-2026-10-11).

## 1. Subjects

| Subject | Character | Notes |
| --- | --- | --- |
| RxDB | reactive database: queries, change streams, storage adapters | use the in-memory storage, so no external service |
| pdf-lib | PDF creation and parsing: byte-level encoding, fonts, object graph | pure JS, compute-heavy |
| TypeORM | ORM: metadata building, query building, hydration | SQLite (`better-sqlite3` or `sqlite3`) in a temp file |
| codegraphchat-v2 | local code-graph CLI (`cg`) | unpublished; it has an `optimization-log.md` (earlier tuning), which the protocol records |
| (optional) BullMQ | queue on Redis | needs Redis and has many Rust parts: only as a negative control |

`codegraph` is not recommended: it needs a Neo4j server, so much of the time would be outside the process.

None of these may be used to tune CrankTS before or during the ablation. The earlier subjects (IntentWeave, Knip, TypeDoc, ESLint, Effect, noble-hashes, the closed-source project) are excluded: they are training data for the current design.

## 2. Preparation (once per subject, before any agent run)

Whoever prepares a subject must not read its profile or look for performance problems. Preparation is setup only.

1. **Pin and install** in `../crankts-eval/<repo>`: a release tag, dependencies installed (`--ignore-scripts` where native builds are not needed), the subject's own tests green.
2. **Write 2–3 realistic workloads** as scripts in `<repo>/crankts-workloads/`, each 5–30 s, deterministic input (seeded), printing a checksum of the result. Choose them by how the library is used (its README, examples, benchmarks folder), not by where time might be. Examples:
   - **RxDB:**
     - bulk insert of 50k documents with an index
     - 2k queries with sort and limit
     - a live query receiving 10k changes
   - **pdf-lib:**
     - create a 500-page document with text, an embedded font, and images
     - load and modify a large existing PDF, then save it
   - **TypeORM:**
     - build metadata for 200 entities
     - insert 50k rows with relations
     - 2k QueryBuilder queries with joins and hydration
   - **codegraphchat-v2:** `cg` indexing a medium repository (e.g. a pinned checkout of a mid-size OSS project), then its query commands.
3. **Freeze** `evaluation/ablation/<repo>/study.ts` (template: [study-template.ts](../evaluation/ablation/study-template.ts)) and record the commit, Node version, and machine.
4. **Run the study and export the bundles:**

   ```sh
   node --import tsx evaluation/coverage/run-study.ts evaluation/ablation/<repo>/study.ts --out /tmp/ablation-<repo>
   node --import tsx evaluation/ablation/export-bundle.ts evaluation/ablation/<repo>/study.ts /tmp/ablation-<repo> ../ablation-bundles
   ```

   This writes `../ablation-bundles/<repo>/<workload>/{P,E,H}/`, each self-contained:
   - `WORKLOAD.md`
   - `profile.cpuprofile`
   - `profile-summary.md`
   - E and H only: `crankts-evidence.{json,md}`
   - H only: `crankts-hypotheses.{json,md}`

5. **Baseline harness:** a script `<repo>/crankts-workloads/measure.sh <workload>` that runs the workload 5 times and prints the median wall time and the checksum. Agents and scoring use the same harness.

## 2b. Pre-Flight Checks (before the first run)

Added after a review of the first preparation, which found E and H bundles with no content. Run all of these; do not start a session until they pass. Checks 1, 2, 5, and 6 are automated:

```sh
node evaluation/ablation/preflight.mjs ../ablation-bundles/<bundle dir> ../ablation-runs/<campaign dir>
```

To replace the material of already prepared workspaces without rebuilding them (refuses once a run has started; `perf-input/` is not part of the baseline commit):

```sh
node evaluation/ablation/sync-perf-input.mjs ../ablation-bundles/<bundle dir> ../ablation-runs/<campaign dir> --apply
```

**Run the evidence study under Node 24** (the study configs pin `~/.nvm/versions/node/v24.21.0`, the Node the agents use). Node 22.19 with tsx 4.20 rejects every synchronous load hook, which the evidence probe registers; the exported evidence records whether the probe recorded anything (`workloadProbe.ran`), so a failed probe cannot pass as "nothing found".

1. **The E and H material has content.** In every `crankts-evidence.json`:
   - `runtimeByAttributionTarget` is not 100% `UNATTRIBUTED`
   - `callSites` is not empty
   - `selfTimeByOrigin` lists a project origin (not only `other`)

   An empty analysis means the analysis root does not contain the sources the profile ran, or the project's TypeScript is too old for the analyzer. Use the subject's real project root (for a monorepo the package that holds the sources; for solution-style `tsconfig.json` files add `workspaceReferences: true`), not a synthetic project folder next to it.
2. **P is clean.** The P arm contains no CrankTS output. Also remove incidental mentions of the tool name from all arms: the folder name `crankts-workloads`, the document author string, and absolute paths such as `crankts-eval` inside the profile.
3. **A defined test command per subject.** The prompt says "subject tests pass"; give each workspace a fixed, fast, offline command (`crankts-workloads/test.sh`) that runs in the sandbox. Browser suites and suites that need database servers do not run offline. The command must be identical in all arms and pass on the baseline.
4. **The sandbox works as intended.** In one workspace, check with `/sandbox policy` that network and unsandboxed fallback are off, and that reads outside the workspace fail for: other projects, loose files in the workspace parent, `~/Documents`, `~/Desktop`, `~/Downloads`. A denylist of sibling folders does not cover files and folders created later.
5. **Workspaces match the bundles** byte for byte, each has one baseline commit and a clean tree, and `measure.sh` runs and prints a checksum.
6. **Record** model, effort, Copilot Chat version, and who scores, in the run map before the first run.

## 3. Agent Runs

**Isolation:**

- Every run starts from a fresh checkout of the pinned subject: `git worktree` or a copy per run, so no run sees another run's patches.
- It runs in a fresh session in a directory outside the CrankTS repository.
- It has no access to CrankTS, its docs, `review.md`, or earlier eval reports.
- With Claude Code, start it in the subject directory. Make sure no `CLAUDE.md` or memory from the CrankTS project applies, and disable web access, so nobody looks up known performance issues of the library.

**Material:**

- Copy the arm's bundle folder into the checkout as `perf-input/`.
- The subject's source, tests, and `measure.sh` are available in all arms.

**Budget:** the same for every run. Suggested:

- 90 minutes wall time or a fixed token budget, whichever comes first
- the same model and the same effort setting

**Runs:**

- **2 runs per arm per subject.** With 4 subjects, that is 24 runs.
- Interleave the order (P, E, H, H, E, P, …) so the machine state is not confounded with the arm.

**Prompt** (identical except for the material line):

```text
You are a performance engineer. Goal: make the workload in perf-input/WORKLOAD.md faster without changing results.

Material: perf-input/ contains <ARM MATERIAL LINE>.

Rules:
- Every finding must be validated: patch, run `crankts-workloads/measure.sh <workload>` before and after
  (median of 5), and check that the checksum is unchanged and the subject's tests still pass.
- Report only findings with a measured median gain of at least 2% of the workload's wall time.
- Keep each finding as a separate patch (git stash/branch per finding), so findings can be measured alone.
- Stop when the budget is used up.

Deliver FINDINGS.md with one entry per finding:
  id, location (file:line), diagnosis (what work is wasted or slow and why), change (one paragraph),
  patch file name, before/after medians, checksum unchanged (yes/no), tests (pass/fail),
  and for each finding: which material pointed you to it (profile summary, profile, evidence, hypotheses, code reading).
Also report findings you investigated and rejected, with the reason.
```

Material lines:

- **P:** "a CPU profile of the workload (`profile.cpuprofile`) and a summary of it (`profile-summary.md`)"
- **E:** the P line + "and CrankTS evidence about the workload (`crankts-evidence.md`): call-site attribution, caller paths, static effects, and measured observations with upper bounds"
- **H:** the E line + "and CrankTS hypotheses (`crankts-hypotheses.md`); they are unvalidated"

**Record per run:**

- the arm, subject, and run number
- start and end time
- tokens, if available
- `FINDINGS.md`
- the patches
- the time of the first validated finding

## 4. Scoring

Scoring is blind to the arm: rename runs to random ids before scoring.

1. **Re-measure every reported finding** with the harness: alternate original and patched, 5 runs each, median, checksum, tests. A finding is **validated** if its median gain is ≥ 2% and larger than the original's run-to-run spread.
2. **Deduplicate across all runs:** findings that change the same work in the same way are one finding, and each keeps its list of runs.
3. **Denominator:** the union of validated findings over all runs. Add a time-boxed independent pass (one more expert or agent session per subject, any material, 2× budget) to catch what all arms missed. Report how many findings only that pass found.
4. **Per arm, the median over its runs:**
   - **validated recall:** validated gain found ÷ validated gain in the union. Use each finding's individual gain, and if two overlap, count the larger.
   - **validated findings:** the count.
   - **precision:** validated ÷ reported.
   - **time to first validated finding.**
   - **tokens and wall time.**
   - **false-positive severity:** findings reported as validated whose re-measurement fails or changes results.
   - **attribution of the source:** per validated finding, the material the agent named.
   - **claim reliability:** of the findings an agent reports as validated (its own before/after numbers), the share that fails the blind re-measurement, and the ratio of claimed to re-measured gain. This is the evidence for or against a validation layer: if agents' self-measured gains replicate, an independent evaluator adds little; if they do not (the measurement noise floor on a loaded machine was 5–11% run to run in earlier studies, above the 2% threshold), it fills a real gap.

**Decision:**

- **A passes:**
  - E beats P on validated recall by ≥ 15 percentage points, or reaches the same recall at ≤ 60% of the cost
  - in at least 3 of 4 subjects
  - with no worse false-positive severity
- **H vs E** decides whether hypotheses ship by default or only on request.
- **If E does not beat P,** CrankTS ends as a research result (the exit criterion in plan.md).

## 5. Known Biases to Record

- **Agent variance is large.** Two runs per arm is the minimum. If results are close, add a third run before deciding.
- **CrankTS's evidence covers the hottest call sites only.** In code where the waste is spread thinly, E has nothing more than P. That is a valid result, not a protocol failure.
- **Async pipelines:** CPU profiles lose caller stacks across `await`. CrankTS's caller paths and its parallelism screening are blind to stage structure there (found on the closed-source project). Record when a validated finding is pipeline-level (stage parallelism, batching across stages).
- **Workload realism:** synthetic repetition (the same input processed again) creates real but useless hypotheses (seen in noble-hashes). Seeded inputs should vary like real data.
