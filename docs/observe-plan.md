# CrankTS Observe – Implementation Plan (M0 → v0.3 → v0.4)

Status: 2026-10-14 · **M0–M5 done; agent comparison run** ([observe-agent-comparison.md](observe-agent-comparison.md)): M0 gate pass, M4 acceptance pass, v0.4 gate formally met with a small margin. Recommended before v0.4: one comparison on an unfamiliar, dependency- or async-heavy workload. Replaces the v0.2 roadmap in [plan.md](plan.md) (decision record: [seventh review round](plan.md#decision-after-the-seventh-review-round-2026-10-13-observe)). Background: [review.md](review.md).

## 1. Goal

CrankTS describes a **single real workload** at the level of TypeScript code entities, so that a coding agent makes better performance decisions than it would with raw profiler data.

The result is a machine-readable model made of:

```text
Entity  +  EntityMetrics  +  ObservedCallEdge   (v0.3)
        +  StaticCallEdge +  SemanticAnnotations (v0.4 → CodeEntityGraph)
```

Guiding principle: **measured, not interpreted.** Derived values are reported as estimates with a confidence.

## 2. Decisions

| # | Decision | Consequence |
|---|---|---|
| D1 | **EntityKey ≠ EntityMatch.** The key is readable and valid for the current revision. Matching across revisions is a separate, later step | v0.3 writes `key` + fingerprints. Matching exists only in the schema and is implemented in v0.5 |
| D2 | **ObservationSession with separate measurements.** CPU, coverage, and heap are three program runs | Every metric carries its `measurementId`. Values are never presented as observed at the same time |
| D3 | **Artifact fingerprint per measurement** | Source-map-derived data is carried across measurements only when the artifact hashes are identical |
| D4 | **Primary process only** | Other profiles are stored with `processRole` but not merged. No "largest process = app" heuristic |
| D5 | **Derived values are estimates** | e.g. `selfCpuPerCall.estimatedNs` always with `cpuSamples`, `executionCount`, `confidence` |
| D6 | **Observed caller edges belong in v0.3** | `ObservedCallEdge` is part of the core model |
| D7 | **Precise names for counters** | `functionExecutionCount`, `rangeExecutionCount`; never `calls` |
| D8 | **Simple quality checks only** | Only checks that compare like with like (§7.6). No overall score from incompatible values |
| D9 | **Non-goals for v0.3/v0.4** | No async wait-time attribution, no Rust/N-API time attribution, no recommendations, scores, or clusters, no before/after gate (later: CodSpeed/Bencher) |
| D10 | **Entity index on `oxc-parser`** | The Observe pipeline parses with `oxc-parser`, not the TypeScript API. It is independent of the project's TypeScript version (5.x or 7), fast on large repositories, and shares its ESTree shape with oxlint JS plugins and the rolldown ecosystem. `typescript` 5.9 remains only for `analyze` and v0.4 (see §16) |

## 3. Phases

| Phase | Content | Effort (estimate) |
|---|---|---|
| **M0** | Entity model + CPU path on a fixture and on IntentWeave | 3–4 days |
| **M1** | Runner, measurements, preload, artifact fingerprint | 3 days |
| **M2** | Coverage collector + execution counts | 3–4 days |
| **M3** | Heap collector + derived estimates | 3 days |
| **M4** | CLI queries + MCP server | 4 days |
| **M5** | Quality checks, robustness, toolchain matrix, docs | 2–3 days |
| **v0.4** | CodeEntityGraph: static edges + annotations | 8–10 days |
| *v0.5 (outlook)* | Entity matching + `diff` | – |

**Gate after M0:** M1–M5 continue only if the output on IntentWeave is clearly easier for an agent to use than today's `crankts analyze --profile … --format json` report (`observedCpu`, caller paths).
**Gate after M4:** v0.4 is built only if the M4 acceptance test passes and a short, non-blinded comparison on 1–2 known IntentWeave issues (agent with CrankTS MCP vs. agent with the raw `.cpuprofile`) favors MCP. The comparison is recorded in `docs/`; it is not a statistical study. (The blinded three-arm agent ablation is parked; see [plan.md](plan.md#decision-after-the-seventh-review-round-2026-10-13-observe).)

## 4. Data Model

```ts
type Confidence = "high" | "medium" | "low" | "none";

interface ObservationSession {
  schemaVersion: "0.3";
  sessionId: string;
  createdAt: string;
  workload: { command: string[]; cwd: string; workloadId?: string };
  git: { sha: string; dirty: boolean; dirtyHash?: string };
  environment: { node: string; v8: string; os: string; cpu: string; cores: number };
  measurements: Measurement[];
  quality: SessionQuality;
}

interface Measurement {
  measurementId: string;                 // e.g. "cpu-01"
  kind: "cpu" | "coverage" | "heap";
  config: Record<string, string | number>; // interval etc.
  processes: ProcessInfo[];
  artifact: ArtifactFingerprint;          // of the primary process
  rawFiles: string[];                     // relative to raw/
  wallMs: number;
  overheadNote?: string;
}

interface ProcessInfo {
  pid: number; ppid: number; threadId: number;
  role: "primary" | "launcher" | "worker" | "child" | "unknown";
  argv: string[]; execArgv: string[];
  resourceUsage?: { userCpuMs: number; systemCpuMs: number; maxRssKb: number };
  eventLoop?: { utilization: number; delayP50Ms: number; delayP99Ms: number };
  rawFiles: string[];
}

interface ArtifactFingerprint {
  entrypoint: string;
  entrypointHash: string;                 // sha256 of the executed entry file
  sourceMapHashes: Record<string, string>; // url → sha256
  loader?: "node" | "node-strip-types" | "tsx" | "ts-node" | "other";
}

interface EntityIdentity {
  key: string;                            // "myapp::src/graph/parse.ts::GraphParser.parseNode"
  fingerprint: { body: string; shape: string };
  anchor: {
    package: string;
    module: string;                       // project-relative path
    qualifiedName: string;
    nameSource: "declared" | "inferred" | "context" | "ordinal";
    parentKey?: string;
  };
}

interface Entity {
  identity: EntityIdentity;
  kind: "function" | "method" | "getter" | "setter" | "constructor"
      | "arrow" | "function-expression" | "module-init"
      | "dependency" | "runtime" | "native" | "gc" | "program" | "idle";
  source?: {
    file: string; line: number; column: number; endLine: number;
    language: "typescript" | "javascript";
    async?: boolean;                      // from the AST; used by asyncTruncated
  };
}

interface EntityMetrics {
  key: string;
  cpu?: {
    measurementId: string;
    selfMs: number; selfPct: number;
    inclusiveMs: number; inclusivePct: number;
    samples: number;
    caused: { dependencyMs: number; runtimeMs: number; nativeMs: number; gcMs: number };
    causedByPackage?: Record<string, number>; // top-k packages in ms
  };
  allocation?: {
    measurementId: string;
    selfBytes: number; inclusiveBytes: number; samples: number;
    includesCollected: boolean;           // see §7.4
  };
  execution?: {
    measurementId: string;
    functionExecutionCount?: number;
    hotRanges: ExecutionRange[];          // top-k by count
  };
  estimates?: {
    selfCpuPerCall?: { estimatedNs: number; cpuSamples: number; executionCount: number; confidence: Confidence };
    bytesPerCall?: { estimatedBytes: number; allocSamples: number; executionCount: number; confidence: Confidence };
  };
  confidence: { cpu: Confidence; allocation: Confidence; execution: Confidence };
  flags: Array<"asyncTruncated" | "unmappedFrames" | "anonymousOrdinal" | "inlinedSuspected">;
}

interface ExecutionRange {
  kind: "function" | "block";
  startLine: number; startColumn: number; endLine: number; endColumn: number;
  rangeExecutionCount: number;
}

interface ObservedCallEdge {
  callerKey: string;                      // nearest own frame above
  calleeKey: string;
  measurementId: string;                  // always a CPU measurement
  sampledInclusiveMs: number;             // time in the callee subtree under this caller
  samples: number;
  shareOfCallee: number;                  // 0..1
  via: "direct" | "dependency" | "runtime"; // foreign frames in between?
}

interface SessionQuality {
  level: "high" | "medium" | "low";
  reasons: string[];
  checks: {
    artifactAgreement: boolean;
    sampledButNotExecutedRatio?: number;  // CPU samples on entities with count 0
    allocatedButNotExecutedRatio?: number;
    unmappedOwnSampleRatio: number;
    repeatCountAgreement?: number;        // only with --verify-determinism
  };
}
```

### 4.1 EntityKey Rules

Format: `<package>::<modulePath>::<qualifiedName>`

Priority of the name source (`nameSource`):

1. **declared:** `function foo`, `class A { bar() }` → `A.bar`, `get x` → `A.get x`, `constructor` → `A.constructor`
2. **inferred:** `const foo = () => …`, `{ foo: () => … }` → `<parent>.foo`, `export default` → `default`, assignment `this.handler = …` → `A.handler`
3. **context:** callback argument → `<parent>/<callee>#cb<argIndex>`, e.g. `buildIndex/items.map#cb0`. A leading string-literal argument labels the callback: `it("parses")#cb1`, `measureTableWrite("symbols")#cb1`. Also: an object literal passed as an argument → `register#arg0.run`; a returned function → `<parent>/return`
4. **ordinal:** fallback `<parent>/<anon#n>` plus the `anonymousOrdinal` flag

On collisions, later duplicates get an occurrence suffix (`~2`, `~3`, …) and the first keeps its name. (The draft said `@<line>`; a line suffix changes whenever code is inserted above, which breaks acceptance criterion 3.)

Dependencies: `flexsearch::*` (scoped: `@scope/name::*`; pnpm paths `.pnpm/<name>@<ver>/node_modules/<name>` are normalized). Runtime: `node:internal::*`. Pseudo-entities: `(gc)`, `(program)`, `(idle)`, `(native)::<functionName>`, `(external)::*` (outside the project and `node_modules`), and `(unmapped)::<generated file>` for own frames that cannot be mapped (entity kind `unmapped`). Own frames that map to a file but to no function position go to its `(module)` entity with the `unmappedFrames` flag.

The rules are implemented on the `oxc-parser` ESTree (D10). The existing `analyze` names (`getFunctionName` in [functions.ts](../src/analysis/functions.ts)) cover declared and inferred names; port that logic and extend it with context and ordinal names. The existing `FunctionId` (`<file>:<startOffset>`) and its `callback@<line>` names are not stable across edits, which is why Observe has its own key. v0.4 maps `FunctionId` → `EntityKey` by file and start position, since both come from the same source positions.

### 4.2 Fingerprints

- `body`: sha256 over the token sequence of the function node, without comments and whitespace (oxc tokens)
- `shape`: the same, but with identifiers and literals normalized (`$id`, `$str`, `$num`)

Purpose: recognize moved or renamed, **unchanged** functions in v0.5. For changed functions, the key and git rename mapping are the main signals.

## 5. Session Directory

```text
.crankts/sessions/<sessionId>/
  session.json            ObservationSession
  entities.json           Entity[]
  metrics.json            EntityMetrics[]
  edges.json              ObservedCallEdge[]
  summary.json            top lists, global numbers, quality
  raw/
    cpu-01/   CPU.*.cpuprofile, preload-<pid>.json
    cov-01/   coverage-*.json,  preload-<pid>.json
    heap-01/  Heap.*.heapprofile, preload-<pid>.json
```

`.crankts/` belongs in `.gitignore`. `crankts gc --keep 20` removes old sessions.

## 6. Module Structure

```text
src/observe/
  runner/        spawn, NODE_OPTIONS, signal forwarding, timeout, process roles
  preload/       crankts-preload.cjs (runs in the target process)
  artifact/      hashing of entrypoint and source maps
  resolve/       URL classification, source-map lookup, offset→line
  entity/        oxc-parser index, key rules, fingerprints
  aggregate/
    cpu.ts       self/inclusive/caused/edges
    coverage.ts  function and range counts
    heap.ts      self/inclusive bytes
    estimates.ts CPU/call, bytes/call, confidence
  quality/       checks from §7.6
  output/        JSON writer, schema validation
  query/         shared query logic for CLI and MCP
  cli/           observe, top, inspect, callers, deps, summary, gc
  mcp/           MCP server on top of query/
```

`query/` is the only layer CLI and MCP build on, so their behavior stays identical. `observe` is a new subcommand in [src/index.ts](../src/index.ts) next to `analyze` and `extract`; it lives in this package, not a separate one.

**`resolve/`:** CrankTS has no source-map resolver today. `analyze` matches profile frames by name, `dist/`→`src/` and `.js`→`.ts` path rewriting, and line proximity (`matchFunction`/`getSourceFileCandidates` in [cpu-profile.ts](../src/analysis/cpu-profile.ts)). Observe builds the resolver on Node's built-in `SourceMap` class from `node:module`, so it needs no dependency. Frames whose URL is a `.ts` file (Node type stripping, §16) map directly, with no source map.

## 7. Algorithms

### 7.1 Frame Classification (CPU and Heap)

Reuse `classifyOrigin` from [cpu-profile.ts](../src/analysis/cpu-profile.ts). It already implements the following, including scoped packages and pnpm paths (the last `node_modules` segment wins):

```text
functionName == "(root)"                → skip
functionName == "(garbage collector)"   → gc
functionName == "(program)"             → program
functionName == "(idle)"                → idle
url startsWith "node:"                  → runtime
url == "" && functionName != ""         → native
url contains "/node_modules/"           → dependency(<package>)
url under project root                  → own → source map (or direct for .ts) → entity
otherwise                               → external (treated like dependency)
```

Packages that `isNativeAddonPackageRoot` recognizes stay `dependency`, with a `nativeAddon` mark. That is classification only; attributing their time to Rust code is a non-goal (D9).

Positions in `.cpuprofile`/`.heapprofile` are **0-based** (line and column). Account for this in the source-map lookup.

### 7.2 CPU Aggregation

1. Index nodes (`id → node`, derive `parent` from `children`).
2. Weight per sample: `w[i] = timeDeltas[i+1]`; the last sample gets `endTime − last timestamp`. µs → ms. This matches Chrome DevTools. `analyze --profile` weights by `timeDeltas[i]`, so Observe numbers can differ slightly from it.
3. For each sample, reconstruct the stack from root to leaf and resolve each frame (cache the result per `callFrame`).
4. **Self:** leaf entity `+= w`.
5. **Inclusive:** every *distinct* entity in the stack `+= w` (one set per sample, recursion-safe).
6. **Caused:** if the leaf is not own code, find the deepest own frame in the stack and add `caused.<category> += w`; for dependencies also `causedByPackage[pkg] += w`.
7. **Edges:** for each pair of consecutive own frames in the stack (foreign frames in between → `via`), `edge.sampledInclusiveMs += w` (at most once per sample and edge).
8. **asyncTruncated:** flag an entity as possibly truncated only when its lowest own frame has only runtime frames between it and `(root)`, **and** either that chain contains `processTicksAndRejections` or a microtask frame (`runMicrotasks`), or the entity is `async` according to the AST. "Directly under a runtime frame" alone is not enough: nearly every own stack sits under `node:internal` frames such as module loading or timers.
9. Percentages are relative to the total sample time **without** `(idle)`.

CPU confidence (starting values, adjust later): `high ≥ 200 samples`, `medium ≥ 50`, `low ≥ 10`, otherwise `none`.

### 7.3 Coverage Aggregation

1. Read the primary process's `coverage-*.json`: `result[]` (ScriptCoverage) and `source-map-cache`.
2. Per script: offsets → line/column via `lineLengths` from the `source-map-cache`, or, if absent, via the generated file on disk (only with a matching artifact hash). With Node type stripping, offsets refer to the `.ts` file itself and need no mapping.
3. Per function: `ranges[0].count` → `functionExecutionCount` of the entity at the start position.
4. Block ranges: the count at a position is that of the **innermost** enclosing range. Map ranges to TS positions and keep the top k (default 5) per entity by `rangeExecutionCount`.
5. Several V8 functions on the same entity (transpiler helpers, bundler wrappers): do **not** sum counts; take the one with the most precise position match and set `inlinedSuspected` or a note.

### 7.4 Heap Aggregation

1. Read the `.heapprofile` (`head` tree with `callFrame`, `selfSize`, `children`).
2. Depth-first walk with an entity stack: leaf entity `selfBytes += selfSize`; every distinct entity on the path `inclusiveBytes += selfSize`.
3. Count `samples` per node from `samples[]` (for the confidence).

**Settled in M3: `--heap-prof` is live-only.** An allocate-and-drop loop shows 0 MB under `--heap-prof` and 25 MB with collected objects included ([observe-m3-intentweave.json](../evaluation/observe-m3-intentweave.json)). Observe therefore always samples through the preload (`node:inspector`, `HeapProfiler.startSampling` with both include flags, `CRANKTS_HEAP_INTERVAL`). On IntentWeave the sampled volume (29.4 GB) is 95% of what V8's GC trace counts (31.1 GB). The original note follows.

**Check in M3 before relying on it:** V8's sampling heap profiler keeps only samples of objects that are still live when sampling stops, unless the `includeObjectsCollectedByMajorGC`/`MinorGC` flags are set. If `--heap-prof` runs without them, `selfBytes` misses short-lived allocations, which are the usual hot case, and `bytesPerCall` is wrong. [analysis-and-evaluation.md](analysis-and-evaluation.md) currently states "sampled allocated bytes"; this is unverified. The `allocLoop` fixture (allocate and drop) decides it. If `--heap-prof` turns out to be live-only, the preload starts sampling itself via `node:inspector` (`HeapProfiler.startSampling` with both include flags) and writes the profile at exit. `allocation.includesCollected` records which mode was used.

### 7.5 Derived Estimates

```text
selfCpuPerCall.estimatedNs = cpu.selfMs * 1e6 / execution.functionExecutionCount
bytesPerCall               = allocation.selfBytes / execution.functionExecutionCount
confidence                 = min(confidence of both sources)
                             and "none" if artifactAgreement == false or count == 0
```

Always output both raw values, never only the quotient.

### 7.6 Quality Checks

| Check | Meaning | Threshold (start) |
|---|---|---|
| `artifactAgreement` | same artifact hashes in all measurements | false → `low` |
| `sampledButNotExecutedRatio` | share of CPU time on own entities with coverage count 0 | > 5% → `medium`, > 20% → `low` |
| `allocatedButNotExecutedRatio` | the same for heap | as above |
| `unmappedOwnSampleRatio` | share of own samples without a TS entity | > 5% → `medium` |
| `repeatCountAgreement` | with `--verify-determinism`: share of the top 50 entities whose counts agree within ±1% across two coverage runs | < 95% → `medium`, < 80% → `low` |

`level` = the worst single result; `reasons` names the checks that triggered it.

## 8. Runner

- Invocation: `crankts observe [--only cpu,coverage,heap] [--cpu-interval 1000] [--heap-interval 524288] [--verify-determinism] [--timeout 600] [--entry <path>] -- <cmd...>`
- `<cmd>` is restarted for each measurement with extended `NODE_OPTIONS` (existing ones are kept):
  - CPU: `--cpu-prof --cpu-prof-dir=<raw/cpu-01> --cpu-prof-interval=<µs>`
  - Coverage: env `NODE_V8_COVERAGE=<raw/cov-01>`
  - Heap: `--heap-prof --heap-prof-dir=<raw/heap-01> --heap-prof-interval=<bytes>` (or preload-driven sampling, §7.4)
  - Always: `--require <preload.cjs>` and env `CRANKTS_MEASUREMENT_DIR`
- The **preload** synchronously writes `preload-<pid>-<tid>.json` on `exit`: pid, ppid, threadId, argv, execArgv, cwd, `process.resourceUsage()`, `performance.eventLoopUtilization()`, the event-loop delay histogram (`monitorEventLoopDelay`), and start and end time. The artifact hash is computed from `process.argv[1]`. The existing input-signature probe ([input-signatures.ts](../src/analysis/input-signatures.ts)) is the reference for preloads that work under plain Node and tsx.
- **Process role:** if `<cmd>` starts with `node`/`tsx`, the directly started process is `primary`. Otherwise the process whose `argv[1]` matches `--entry <path>` is `primary`. Without `--entry` and without a unique match: all `unknown`, a warning, and aggregation stops with a hint. Recommended in the docs: `crankts observe -- node dist/main.js` or `crankts observe -- node src/main.ts` (type stripping).
- SIGINT/SIGTERM are forwarded to the child process group. On timeout: SIGTERM first, SIGKILL after 10 s. Profiles of killed processes are missing; report that as an error in the measurement.
- Recommended for M0: tsc output with `.map` files on disk (IntentWeave: turbo + tsc, `sourceMap: true` in `tsconfig.base.json`), or Node type stripping. tsx/ts-node from M2 (via the `source-map-cache` with artifact check).

## 9. CLI and MCP

### CLI (M4)

```text
crankts observe ...                          (M1)
crankts summary   [--session <id>]
crankts top       --by self|inclusive|alloc|executions|cpu-per-call [--limit 20] [--scope own|all]
crankts inspect   <key | file:line>
crankts callers   <key> [--limit 10]
crankts deps      [<key>]                    dependency cost by own cause
crankts sessions                             list
crankts gc        --keep <n>
```

Output: a table by default; with `--json`, the same data structures as MCP.

### MCP Tools (M4)

| Tool | Parameters | Returns |
|---|---|---|
| `get_summary` | session? | global numbers, quality, top 5 per category |
| `get_hot_functions` | by, limit≤50, scope | compact rows: key, file:line, metric, confidence |
| `get_function_metrics` | key | full EntityMetrics + top callers |
| `get_hot_allocators` | limit | by selfBytes |
| `get_hot_ranges` | limit | blocks with the highest `rangeExecutionCount` |
| `get_callers` | key, limit | incoming ObservedCallEdges |
| `get_callees` | key, limit | outgoing ObservedCallEdges |
| `get_dependency_costs` | key? | caused values per package |
| `list_sessions` | – | sessions with date, SHA, quality |

Rules: small default `limit` (10), rounded numbers, project-relative paths, every answer contains `sessionId` and the quality level. Target size of a typical answer: under about 2k tokens. Implementation: `@modelcontextprotocol/sdk` (new runtime dependency).

## 10. Milestones in Detail

### M0: Entity Model + CPU (3–4 days) — done 2026-10-13

**Result.** `crankts observe-m0 <file.cpuprofile> [--root <dir>] [--out <dir>]` (a subcommand instead of a separate `crankts-m0` script) writes `entities.json`, `metrics.json`, `edges.json`, and `summary.json`. Code: `src/observe/{model.ts, entity/, resolve/, aggregate/cpu.ts, m0.ts}`; tests: `test/observe-{entity,cpu,m0}.test.ts`; fixture: `test/fixtures/observe`. Evidence: [observe-m0-intentweave.json](../evaluation/observe-m0-intentweave.json).

| Criterion | Status |
|---|---|
| 1. Fixture order and ±25% magnitude | pass, both with Node type stripping (`.ts` frames) and with tsc output + source maps. Measured shares 31.8 / 23.8 / 15.9 / 15.9 / 8.0 / 4.0% for designed 4 : 3 : 2 : 2 : 1 : 0.5 units |
| 2. IntentWeave > 95% of own samples mapped | pass: 100% (`index build --depth full --no-native`, 16.4 s sampled, 303 entities, 257 edges) |
| 3. `anonymous` keys stable when a function is inserted above | pass |
| 4. Agent test vs. today's `analyze --profile` JSON | **pass (2026-10-14):** Observe 10/10 in both runs vs. 8/10 for the `analyze` JSON, with 21% fewer tokens ([observe-agent-comparison.md](observe-agent-comparison.md)). For the same profile, `analyze` takes 6.5 s and writes 26.6 MB of JSON; `observe-m0` takes 0.29 s and writes 0.43 MB (`summary.json` 11 KB) |

**Implementation notes and deviations:**
- `EntityMetrics.cpu` also has `inclusiveSamples`; CPU confidence uses it, so orchestrators with little self time are not reported as `none`.
- The resolver canonicalizes the project root and frame paths (`realpath`); macOS tmp dirs and pnpm links otherwise make own code look external.
- Profile-shape tests weight samples by wall time, so they run in a separate vitest project after all other tests (`vitest.config.ts`); under parallel load (load average ~40) their shares drift by 2×.
- With IntentWeave's default (native) build, the main thread is mostly idle (631 ms sampled, 3.4 s idle) because the Rust engine runs on other threads. That is within D4/D9; it is noted for M1 process and thread roles.

Original tasks:

Tasks:
- `entity/`: `oxc-parser` index per file, key rules §4.1, fingerprints §4.2
- `resolve/`: frame classification §7.1 (reusing `classifyOrigin`), source-map lookup from disk via `node:module` `SourceMap`, direct `.ts` mapping
- `aggregate/cpu.ts`: all of §7.2 including edges
- A simple script `crankts-m0 <file.cpuprofile> --root <dir>` → `entities.json`, `metrics.json`, `edges.json`
- Fixtures `amplified`, `expensive`, `depHeavy`, `recursive`, `anonymous`

Acceptance:
1. Fixtures: expected order and magnitude (±25%) of the hotspots
2. IntentWeave: > 95% of own samples mapped, `unmapped` reported
3. Fixture `anonymous`: keys stay stable when a new function is inserted above
4. Agent test: a coding agent names the top 3 problems with caller context from the files. Direct comparison with today's `crankts analyze --profile … --format json` report

### M1: Runner (3 days) — done 2026-10-13

- `runner/`, `preload/`, `artifact/` per §8; write the ObservationSession; CPU measurement only
- Acceptance: `crankts observe -- node dist/fixture.js` produces a complete session. With `npm run` as the command, process roles are detected correctly or there is a clear error

**Result.** `crankts observe [--entry <script>] [--root <dir>] [--cpu-interval <µs>] [--timeout <s>] [--sessions-dir <dir>] [--workload <label>] -- <cmd...>` writes `.crankts/sessions/<id>/` (§5). Code: `src/observe/{session.ts, runner/, preload/, artifact/, paths.ts}`; tests: `test/observe-session.test.ts`. Both criteria pass:
- `node dist/main.js` gives a complete session with one primary process, artifact hashes, and attribution.
- `npm run start` without `--entry` stops with "The command started 2 Node processes; pass --entry <script> …" and lists them. With `--entry dist/main.js`, npm is the launcher.

tsx (launcher + script process + module-loader thread), Node type stripping, a timeout, and a failing exit code are covered too. On IntentWeave (`index build --depth full --no-native`, 17.1 s sampled) the session has one primary process and quality `high`.

**Implementation notes and deviations from §8:**
- **Primary process by script, not by spawn order.** `node` may be a version-manager shim (volta, nvm), and tsx runs the script in a child process, so "the directly started process" is not reliable. The script is `--entry`, or the first script argument of a `node`/`tsx`/`ts-node` command, skipping runner CLIs such as `tsx/dist/cli.mjs`. It must match exactly one main-thread `argv[1]`. Without a script, a single recorded process is primary; otherwise the run is an error.
- **Other roles:** `child` = descendant of the primary (ppid chain); `launcher` = a process that starts before and ends after the primary (npm, the tsx CLI); `worker` = threadId > 0. Threads that write a profile but never run the preload's exit hook (tsx's module-loader thread) are workers.
- **Signals:** Node writes no `--cpu-prof` output when killed by a signal. If the workload has no handler of its own, the preload turns SIGTERM/SIGINT into `process.exit(128 + n)`, so a timeout keeps the profile.
- **Process group:** the run ends only when the whole process group has exited, so launchers that exit before their children do not cut off profiles. SIGKILL comes after a 10 s grace period.
- **Artifact:** `moduleHashes` (every own module in the profile) sits next to `sourceMapHashes`, so type-stripped runs, which have no maps, are fingerprinted too.
- **CrankTS's own files:** the preload is written to `raw/preload.cjs`. Frames under `.crankts/` are tooling (`(crankts)::preload`), not project code.
- **Git state:** recorded before the run, excluding `.crankts/`, so observing never makes the tree dirty.
- **Output streams:** the report goes to stderr (the workload owns stdout). The exit code is the workload's, or 1 if nothing could be attributed.

### M2: Coverage (3–4 days) — done 2026-10-13

- `aggregate/coverage.ts` per §7.3, offset→line via `lineLengths`, tsx support via `source-map-cache`
- Fixture `loops` (nested loops, known iteration counts)
- Acceptance: function counts exact on fixtures, range counts plausible for loop bodies, `sampledButNotExecutedRatio` on IntentWeave under 5%

**Result.** `crankts observe` now runs CPU and coverage by default (`--only cpu,coverage`). `metrics.json` carries `execution.functionExecutionCount` and the top 5 `hotRanges`; `summary.json` adds `topExecutions`, the coverage summary, and `sampledButNotExecutedRatio`. Code: `src/observe/{aggregate/coverage.ts, attribute.ts}`; tests: `test/observe-coverage.test.ts`; evidence: [observe-m2-intentweave.json](../evaluation/observe-m2-intentweave.json). All criteria pass:
- **Fixture function counts:** exact for tsc + source maps, Node type stripping, and tsx (e.g. `normalizeToken` 2000×, `walk` 20×, callbacks 100×).
- **Loop ranges:** `nestedLoops(50, 200)` × 3 gives the inner body 30000× at lines 6–8 and the outer body 150× at lines 4–9.
- **IntentWeave:** `sampledButNotExecutedRatio` is 0%. 1923 of 1958 own V8 functions match an entity, 630 entities ran, and only 10 executed functions match none.

**Implementation notes and deviations from §7.3:**
- **Matching by header.** A V8 function matches the innermost entity whose *header* contains its mapped start. The header runs from the entity's start, or from a wrapping `export`, which tsc maps point at, to the start of its body. Synthetic V8 functions (class-field initializers, tsx's `__name` helper) match nothing and are counted as `unmatchedExecutedFunctions`, never assigned to the surrounding code. When several V8 functions match one header, the closest one wins and `inlinedSuspected` is set.
- **One resolver for both measurements.** The `source-map-cache` of the coverage run holds tsx's in-memory maps, and the same maps now fix the CPU run's positions. `.ts` frames under tsx carry transformed positions; M0/M1 treated them as direct, and `walk` landed on `(module)`. A tsx/ts-node CPU run without coverage gets quality `low` (`transformedPositionsWithoutSourceMaps`).
- **Artifact agreement (D3)** is checked across measurements: the same entry hash, and the same hash for every own module and source map that several measurements saw. Disagreement sets quality `low`.
- Entities that ran but were never sampled get metrics with `execution` only. Own sampled entities without coverage data get `confidence.execution: "none"`.

### M3: Heap + Estimates (3 days) — done 2026-10-14

- `aggregate/heap.ts` §7.4, `estimates.ts` §7.5
- Fixture `allocLoop`; settle the live-only question from §7.4 first
- Acceptance: top allocator on the fixture correct (including short-lived allocations), self CPU/call of the `amplified` fixture in the expected magnitude with confidence ≥ medium

**Result.** `crankts observe` runs CPU, coverage, and heap by default (`--heap-interval <bytes>`, default 524288). `metrics.json` adds `allocation` (self/inclusive bytes, samples, `includesCollected`) and `estimates.selfCpuPerCall` / `estimates.bytesPerCall`, always with both inputs. `summary.json` adds `heap`, `topAllocators`, `topSelfCpuPerCall`, and `topBytesPerCall` (only confidence ≥ medium), plus `allocatedButNotExecutedRatio`. Code: `src/observe/aggregate/heap.ts`, the preload, and `attribute.ts`. The estimates live in `attribute.ts` instead of a separate `estimates.ts`. Tests: `test/observe-heap.test.ts`, `test/observe-m3.test.ts` (profiled group). Both criteria pass:
- **Fixture:** `allocateTemporaries` (2000 short-lived 8 KB arrays) is the top own allocator, and the retained arrays stay below a fifth of it.
- **Per-call estimate:** `normalizeToken`'s self CPU per call is within ±25% of the expected 2 units / 2000 calls, with confidence ≥ medium.

On IntentWeave, `extractDictionary` allocates 18.5 GB in 11,413 calls (1.6 MB per call, confidence high).

**Implementation notes:**
- **Estimate confidence:** the minimum of the source's self-sample confidence and the execution confidence, and `none` when the measurements' artifacts disagree (D3). Allocation confidence uses the same thresholds as CPU, on inclusive samples.
- **Heap profile file:** written at exit by the preload as `heap-<pid>-<threadId>.heapprofile`. The SIGTERM handling from M1 also covers it.
- **Correction elsewhere:** `analysis-and-evaluation.md` called `--heap-prof` profiles "sampled allocated bytes"; it now carries a correction.

### M4: CLI + MCP (4 days) — done 2026-10-14 (agent acceptance passed, see [observe-agent-comparison.md](observe-agent-comparison.md))

- `query/`, `cli/`, `mcp/` per §9
- Acceptance: Claude Code or Codex finds the top hotspots on IntentWeave, with caller paths, through MCP alone, without opening raw files
- Then the short comparison for the v0.4 gate (§3)

**Result.** Code: `src/observe/{query/, cli/, mcp/server.ts}`; tests: `test/observe-query.test.ts`, which includes an MCP client over an in-memory transport. Evidence: [observe-m4-intentweave.json](../evaluation/observe-m4-intentweave.json).
- **CLI:** `crankts summary | top | inspect | callers | callees | deps | sessions | gc` read the newest session (or `--session`), print tables, and with `--json` print the MCP structures.
- **MCP:** `crankts mcp [--root | --sessions-dir]` serves the nine tools from §9 over stdio. All are read-only, and every answer has `sessionId` and `quality`.
- **Answer size on IntentWeave:** 150–600 tokens per tool, `get_summary` about 1,200 (target: under 2k).
- **Agent acceptance: open.** An agent session with only `crankts mcp` has to find IntentWeave's top hotspots and caller paths. Setup: `claude mcp add crankts -- node <crankts>/dist/cli.js mcp --root <intentweave>` after a `crankts observe` run there. The same session can serve the M0 gate comparison against the `analyze --profile` JSON and the v0.4 gate comparison against the raw `.cpuprofile`.

**Implementation notes and additions to §9:**
- **Key lookup:** keys resolve exactly, by a unique name suffix (`normalizeToken`, `Class.method`, `#cb0`), or by `file:line` (the innermost entity containing the line). Ambiguous or unknown names return up to 10 candidates (`isError` in MCP).
- **CLI `callees`** was added for parity with `get_callees`.
- **Compact rows:** each `get_hot_functions` row has the key, location, the ranked metric, the execution count, and the confidence that belongs to that metric. `cpu-per-call` leaves out estimates with confidence `none`.
- **Dependency costs:** `get_dependency_costs` without a key sums `causedByPackage` over all entities (top 5 packages per entity) and names the top 3 causing entities and whether the package is a native addon.

### M5: Robustness (2–3 days) — done 2026-10-14

- `quality/` per §7.6, `--verify-determinism`
- JSON schema validation, `schemaVersion`
- CI matrix: Node 22 and 24, macOS + Linux
- Toolchain fixtures (§16): tsc 5.9, tsc 7, Node type stripping, tsx, tsdown/rolldown bundle with source maps
- Measure Observe's own overhead per measurement in `session.json`
- Dev tooling: oxlint and a TS 7 typecheck in CI (§16)
- README: workflow, limits (async, processes, determinism)

**Result.** Code: `src/observe/{quality/, schema.ts}`, CPU and resolver changes, `.github/workflows/ci.yml`, `.oxlintrc.json`; tests: `test/observe-toolchains.test.ts` and additions elsewhere; evidence: [observe-m5-intentweave.json](../evaluation/observe-m5-intentweave.json). The suite (161 tests), lint, and both typechecks pass on Node 22 and 24 locally. The CI matrix (ubuntu/macOS × Node 22/24: lint, test, typecheck 5.9 and 7, build) has not run on GitHub yet.
- **Quality:** `quality/` implements every check of §7.6 including `repeatCountAgreement` (`--verify-determinism`: a second coverage run, `cov-02`, comparing the top 50 counts within ±1%). On IntentWeave: 1.0, quality `high`.
- **Schemas:** zod schemas typed against the model interfaces, so the compiler keeps them in sync. Writers validate before writing; `SessionStore` validates on load and rejects other `schemaVersion`s with a clear message. `crankts schema` prints JSON Schema (draft 2020-12).
- **Overhead:** `--baseline` adds one uninstrumented run; each measurement records `overhead.wallRatio`, and `session.timing.attributionMs` records CrankTS's own post-processing. On IntentWeave: CPU 1.05×, coverage 1.38×, heap 1.07×, attribution 1.4 s.
- **Toolchains:** the same fixture with tsc 5.9, tsc 7, a tsdown/rolldown bundle, Node type stripping, and tsx yields the same entities and exact counts.
- **Dev tooling:** oxlint 1.88 (`pnpm lint`) and a TS 7 typecheck (`pnpm typecheck:ts7`, an npm alias `typescript7`; the runtime stays on 5.9 and the build/typecheck scripts call each compiler by path, because the alias's `tsc` binary shadows 5.9's). Two oxlint rules are off: `no-thenable` flags the Kernel IR's `if`/`then` nodes, and `no-new-array` flags deliberately preallocated arrays.

**Found and fixed in M5:**
- **Inlined callees on Node 24.** V8 in Node 24 attributes an inlined leaf function's samples to the caller's frame, but keeps the callee's lines in `positionTicks`. Self ticks on lines of another own entity now go to that entity (an inlined leaf under the caller, flag `inlinedSuspected`); lines of other scripts stay with the frame. Without this, `normalizeToken` showed 0.4× of its time on Node 24. Inlined *intermediate* frames can still vanish from stacks; this is documented as a limit.
- **Bundles.** Dependencies that a bundler inlined map back to `node_modules` through the source map and now count as dependencies. A multi-module bundle's top-level code is `<bundle>::(module)` instead of the first source. Source-map lookups between segments use column extrapolation on the same generated line, accepted only when the generated text and the source text agree.
- **Fixture work units are time-based.** Equal loop iterations did not cost the same in different functions on Node 24's JIT; each fixture now spins until its share of wall time has passed (`OBSERVE_FIXTURE_UNIT_MS`).
- **Evidence probe (outside Observe).** oxlint found a lost `\d` escape in the generated input-signature probe; see the correction in [analysis-and-evaluation.md](analysis-and-evaluation.md).

## 11. v0.4: CodeEntityGraph (8–10 days)

- **StaticCallEdge** from the existing CrankTS call graph ([call-graph.ts](../src/analysis/call-graph.ts)), mapped to EntityKeys (by file and start position, §4.1), with `observed: boolean` against ObservedCallEdges
- **SemanticAnnotations** per entity from existing analyses ([effects.ts](../src/analysis/effects.ts) and others): `purity`, `writesOuterState`, `usesThis`, `captures`, `async`, `generator`, `dynamicCall`, `callsDependency`, `callsNative`. Facts only, no scores. Optional: oxlint `perf` diagnostics (e.g. `no-accumulating-spread`, `no-await-in-loop`) attached as facts to the entity they fall in
- **Boundary marks** on edges: own→dependency, own→native, own→runtime
- Queries: `get_subgraph(key, depth, minWeightPct)`, `get_hot_paths(limit)`, `get_annotations(key)`; CLI `crankts graph <key> --format json|dot`
- **TS 7 spike first** (§16): can a `CompilerFrontend` on `typescript/unstable/sync` serve `call-graph.ts` and `effects.ts`? If yes, v0.4 uses it with TS 5.9 as the fallback; if not, v0.4 stays on 5.9
- Acceptance: for the top 5 IntentWeave hotspots, `get_subgraph` returns a subgraph of at most 30 nodes that an agent can read without extra context
- Explicitly **not** in v0.4: cluster scores, data-flow edges (READS/WRITES/ALIASES), probes for observed dynamism

## 12. Outlook v0.5 (not part of this plan)

- `EntityMatch`: exact key → git rename mapping → qualifiedName + signature → `body` fingerprint → `shape` fingerprint + parent, with `matchConfidence`
- `crankts diff <sessionA> <sessionB>` at entity level
- Gate and statistics external (CodSpeed, Bencher, hyperfine)
- Re-evaluate the parked agent ablation ([ablation-protocol.md](ablation-protocol.md)) with Observe output as the evidence arm

## 13. Risks

| Risk | Mitigation |
|---|---|
| Workload not deterministic | quality checks, `--verify-determinism`; the CPU measurement alone stays usable |
| Source maps missing or wrong | report `unmapped`, compare artifact hashes, M0 with tsc output or type stripping |
| Several processes (npm, workers) | primary process only, `--entry`, clear error message |
| Inlining, small functions | always report samples and confidence |
| Truncated async stacks | `asyncTruncated` flag (§7.2), documented as a limit |
| Unstable anonymous functions | key rules §4.1, `anonymousOrdinal` flag |
| Heap profile live-only | M3 check and preload-driven sampling (§7.4) |
| Unstable TS 7 API | used only behind `CompilerFrontend`, TS 5.9 fallback (§16) |
| Scope creep | non-goals (D9) and the M0 and M4 gates |

## 14. Resolved Questions

1. **Existing resolver?** None that uses source maps (§6). M0 builds a lean one on `node:module` `SourceMap`.
2. **IntentWeave build:** turbo + tsc 5.9 with `sourceMap: true`. **Still open:** a reproducible workload command (candidate: the index build from MVP-6/8).
3. **Package placement:** `src/observe/` in this package, subcommand `observe`.
4. **Node versions:** 22 and 24 (`engines: >=22`; type stripping is unflagged from 22.18).

## 15. Dependencies

| Package | Use | From |
|---|---|---|
| `oxc-parser` | entity index, fingerprints | M0 |
| `@modelcontextprotocol/sdk` | MCP server | M4 |
| `typescript@^5.9.3` (existing) | `analyze`, v0.4 static graph | – |
| `oxlint` (dev) | linting CrankTS itself; optional v0.4 facts | M5 |
| TS 7 (dev, aliased) | typecheck CrankTS in CI; v0.4 spike | M5 / v0.4 |

## 16. Toolchain

As of 2026-10-13 on npm: `typescript` latest is **7.0.2** (the Go compiler), `oxc-parser`/`oxc-transform` 0.154, `oxlint` 1.88, `rolldown` 1.2, `tsdown` 0.23.

**TypeScript 7.** The package exports only `typescript/unstable/{sync,async,ast,…}`; the classic `ts.*` API is gone. `unstable/sync` has a `Checker` with `getTypeAtLocation`, `getSymbolAtLocation`, `getResolvedSignature`, and `getTypeOfSymbol`. Consequences:
- Observe M0–M5 needs no checker, so D10 decouples it from the TypeScript package entirely.
- `analyze` keeps `typescript@^5.9.3`. The caret already excludes 7, but note that a bare `npm i typescript` now installs 7. Projects that pin TS 7 keep falling back to the bundled 5.9 for `analyze`.
- v0.4 starts with a spike on `unstable/sync` behind `CompilerFrontend` (§11).
- Projects compiled with tsc 7 emit standard `.map` files; the M5 fixtures cover them.

**Execution paths the resolver must handle:**

| Path | Frame URLs | Mapping |
|---|---|---|
| Node type stripping (`node src/main.ts`, unflagged from Node 22.18) | `.ts` files | direct; positions unchanged, coverage offsets exact |
| tsc 5.9 / tsc 7 output | `.js` + `.map` on disk | source map |
| tsx (esbuild) | `.ts` URLs, in-memory maps | `source-map-cache` (M2) |
| tsdown / rolldown bundle | bundle + `.map` | source map; several modules per file |

**oxc.** `oxc-parser` is the parser for `entity/` (D10). In v0.4, oxc's scope and reference analysis can provide cheap direct-call edges without a checker; method dispatch still needs the checker. oxlint `perf` diagnostics are optional entity facts (§11).

**CrankTS's own tooling (M5).** CrankTS has no linter today. Add `oxlint` as a dev dependency and CI step. Add a TS 7 `tsc --noEmit` typecheck as an extra CI step via an aliased dev dependency, keeping the TS 5.9 build as is.
