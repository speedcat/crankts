# Grading rubric (fixed before any agent result was read)

Ground truth, from the Observe session and checked independently against the raw `.cpuprofile` (17.16 s sampled, idle excluded):

- G1: `HeuristicKeywordExtractor.extractDictionary` (packages/analyzer/src/kwg/heuristicExtractor.ts:281) is the top own hotspot: 26.3% self in the raw profile (Observe: 27.4%), about 4.5 s.
- G2: mechanism: line 296 `[...this.dictionary].filter(...)` copies and scans the whole dictionary on every call. 11,413 calls; the filter callback runs about 51 million times (Observe: lines 303–315 executed 51,073,175 times). The function allocates about 18.5 GB (1.6 MB per call). Fix: prepare/index the dictionary once (hoist the per-call scan).
- G3: caller path: `extractDictionary` ← `HeuristicKeywordExtractor.extract` ← `KwxChunkProcessor.process` ← `runKwxStage`.
- G4: dependency time: tree-sitter about 37% of sampled time (getters `type`, `children`, `unmarshalNodes`). Own causers: `AstExtractor.isFunctionLikeNode` (1.4 s caused, 1.7 M calls), `extractUsages/visit`, `findEnclosingSymbol`, the def-use walks.
- G5: second-tier own hotspots: sqlite-compat (`StatementCompat.run/all`, `Database.transaction`), `runStlStage`, the AST walks.
- G6: native RegExp `^[A-Za-z0-9_]+$` (about 0.75 s, 4.4%) is caused by `extractDictionary`.

Points per run (max 10):

| Item | Points | Criterion |
|---|---|---|
| R1 | 2 | Names extractDictionary as #1 with a share within ±5 pp of 26–27% (1 point if named #1 with a wrong or no share) |
| R2 | 2 | Mechanism: 1 = the per-call whole-dictionary copy/scan from the source; 2 = additionally quantified (calls, iterations, or allocation) |
| R3 | 1 | Correct caller path to extractDictionary (at least extract ← KwxChunkProcessor.process) |
| R4 | 2 | 1 = dependency share about right (tree-sitter 30–45%, or all dependencies ≈ 38%); 1 = names at least one correct own causer (isFunctionLikeNode, extractUsages visit, findEnclosingSymbol, def-use walks) |
| R5 | 1 | A correct second-tier own hotspot with plausible numbers (G5) |
| R6 | 1 | Attributes the native RegExp time to extractDictionary |
| R7 | 1 | No material factual errors (wrong file:line, shares off by more than 2×, functions that do not exist) |

Also recorded per run: tool calls (self-reported), total tokens and duration (from the task notification). The grader is not blind to the arm (non-blinded comparison, as the plan says for the v0.4 gate).
