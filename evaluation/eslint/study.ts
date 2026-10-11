// Eval #3: ESLint 10.12.0 (visitor- and rule-heavy; JavaScript with JSDoc types, analyzed with allowJs).
// Setup (pinned, outside the repo): ../crankts-eval/eslint@v10.12.0, dependencies installed with --ignore-scripts.
// Scratch files in that clone: lib/tsconfig.json (allowJs, so CrankTS can analyze lib/), two flat configs
// (all core rules / recommended, importing packages/js), and crankts-corpus/ (copies of typescript.js and
// Vite's built dist/node, linted as large real-world JS).
import { resolve } from "node:path";
import type { StudyConfig } from "../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const eslint = resolve(repoRoot, "../crankts-eval/eslint");
const bin = resolve(eslint, "bin/eslint.js");

const study: StudyConfig = {
  name: "eslint",
  version: "10.12.0",
  description: "ESLint linting its own code with its repository config, and real JS corpora with all core or recommended rules",
  analysisRoot: resolve(eslint, "lib"),
  cwd: eslint,
  // Exit code 1: lint problems were found; the run completed.
  acceptExitCodes: [0, 1],
  workloads: [
    { name: "eslint (self, repo config)", args: [bin, "lib"] },
    { name: "all core rules: eslint tests", args: [bin, "--no-config-lookup", "-c", "crankts-all.config.mjs", "--no-warn-ignored", "tests/lib"] },
    { name: "recommended: typescript.js (8.7 MB)", args: [bin, "--no-config-lookup", "-c", "crankts-recommended.config.mjs", "crankts-corpus/typescript"] },
    { name: "all core rules: vite dist", args: [bin, "--no-config-lookup", "-c", "crankts-all.config.mjs", "crankts-corpus/vite"] },
  ],
  annotations: resolve(repoRoot, "evaluation/eslint/annotations.json"),
  output: resolve(repoRoot, "evaluation/crankts-eslint-coverage.json"),
};
export default study;
