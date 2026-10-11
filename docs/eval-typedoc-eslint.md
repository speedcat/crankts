# External Evaluations #2 and #3: TypeDoc and ESLint

Same method as [Knip](eval-knip.md): CPU profiles of the subject running real workloads (3 fresh processes each, round-robin), call-site attribution, input-signature profiling for hoisting candidates, dry runs of today's fail-closed passes, and manual review with evidence levels. No new transformers.

- **Data:** [crankts-typedoc-coverage.json](../evaluation/crankts-typedoc-coverage.json), [crankts-eslint-coverage.json](../evaluation/crankts-eslint-coverage.json)
- **Configs:** [typedoc/study.ts](../evaluation/typedoc/study.ts), [eslint/study.ts](../evaluation/eslint/study.ts); labels in `annotations.json` next to them. **They are my judgment and need your review.**
- **Driver:** `node --import tsx evaluation/coverage/run-study.ts evaluation/<study>/study.ts`

## Setup

- **TypeDoc 0.28.20** runs from its TypeScript sources through tsx (`--conditions=typedoc-ts` resolves its self-imports to `src/lib`; its built bundle would not map to source files). Workloads: documenting TypeDoc itself, CrankTS, Knip, TanStack router-core, and Vite's node API. It uses TypeScript 6.0.3, whose compiler API CrankTS used for the analysis.
- **ESLint 10.12.0** is JavaScript with JSDoc types, analyzed with `allowJs` through a scratch `lib/tsconfig.json`. Workloads: ESLint linting itself with its repository config (including eslint-plugin-jsdoc), all core rules on its test suite, `recommended` on an 8.7 MB `typescript.js`, and all core rules on Vite's built `dist/node`.

## Where the Time Goes

Percent of profiled runtime, medians over 3 runs. "Own JS" is the function's own JavaScript at call sites; "unattributed" is startup, loading, GC, and idle.

| Subject | Workload | Attributable to call sites | Own JS | Human-plausible | Evidence-supported | Recognized | Family recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| TypeDoc | typedoc (self) | 68.6 | 14.5 | 7.3 | 0 | 0 | 1.0 |
| TypeDoc | crankts | 55.4 | 7.9 | 1.9 | 0 | 0 | 1.0 |
| TypeDoc | knip | 62.9 | 5.2 | 0 | 0 | 0 | – |
| TypeDoc | tanstack router-core | 65.5 | 10.4 | 4.3 | 0 | 0 | 1.0 |
| TypeDoc | vite (node API) | 69.2 | 11.2 | 8.9 | 0 | 0 | 1.0 |
| ESLint | eslint (self, repo config) | 76.8 | 17.1 | 4.2 | 0 | 0 | 0.25 |
| ESLint | all core rules: eslint tests | 81.2 | 43.7 | 13.8 | 0 | 0 | 0.52 |
| ESLint | recommended: typescript.js | 69.6 | 32.3 | 3.0 | 0 | 0 | 1.0 |
| ESLint | all core rules: vite dist | 85.3 | 42.1 | 9.9 | 0 | 0 | 0.43 |

## What the Data Shows

**TypeDoc is a TypeScript-compiler workload.** 34–44% of the runtime is the TypeScript package itself: program creation (`getEntryPrograms`, 17–32% of the call-site time) and lazy checker queries in the converter (`getSymbolForModuleLike`, `convertType`, `convertProperty`). Those are dependency calls with no repeated invariant input. The honest recommendation here is on the execution side: a faster checker (TypeScript 7 or `bun check`), not a CrankTS kernel. The plausible items are small:

- **Shiki `highlight`** (1.2–8.4%): memoizing by (code, language) helps only where examples repeat. Measured: Vite's docs 50 calls / 12 distinct (reuse 0.76), TypeDoc's own docs 29 / 27 (0.07). It stays PLAUSIBLE, workload-dependent.
- **`buildRefIcons`** (~0.7%): rebuilds identical SVG references per render context; the page URL prefix is the only variable.
- **`discoverIndent`** (1.1% on Vite): a regex test per character; equivalent to a code-unit whitespace check.

**ESLint is the first subject with large own-JS shares (up to 44%).** That time is traversal and rule dispatch: `SourceCodeVisitor.callSync`, `SourceCodeTraverser`, `Traverser._traverse`, and the rules themselves. These are callbacks over dynamic AST nodes, class instances, and `this` state, which the Kernel IR does not model. The parser (acorn/espree, 10–14%) and scope analysis (esrecurse/eslint-scope, 3–19%) are dependencies called once per file with distinct inputs. Plausible items are a node-type index of selectors and a columnar token layout, both small and with large producer changes. On the self-lint workload, 10–18% of the time is eslint-plugin-jsdoc's rules, which are third-party code.

**Recognition is silent, and correctly so.** The advisor made no recommendation of MEDIUM level or above (precision is undefined: nothing was recognized). Only four LOW-confidence `HOIST_INVARIANT_WORK` hints appeared: `TypeDocReader.readFile` in TypeDoc and `getAjv`, `getOrCreateValidator`, and `verify` in ESLint. None had measured repetition. The probe ran for a few call sites per workload (TypeDoc 1 for the CrankTS and router-core workloads, ESLint 1–2 per workload) and found no hoistable work with high reuse. TypeDoc's `highlight` was probed by hand, not by the study run: it was not detected as a candidate automatically, because its callee is a method of a module-level object, not a builder call.

**CrankTS-transformable stays 0.** The dry runs reject on class instances, `this`, unions, and dynamic AST types, as for Knip.

## Implications

1. **Not every TypeScript hotspot is a transformation target.** The largest TypeDoc cost is the compiler. The advisor should say `KEEP_TS` for project code and name the dependency that dominates, which it does.
2. **Visitor and rule-dispatch code is a large, uncovered class.** ESLint's 30–44% own-JS share is where a generic pattern would matter most (a node-type index, columnar tokens, listener tables). Whether that is `PACK_DATA`/`PREPARE_STATE` or genuinely the structure of rule engines is a question for the generalization review; no transformer is built.
3. **Pattern-family recall is high or unavailable, automated recall is 0.** The families recur (prepared state, hoisting, packed data), but few cases have the measured preconditions CrankTS requires.
