// Template for an ablation subject. Copy to evaluation/ablation/<repo>/study.ts and fill in.
// Rules: choose workloads for realism (how the library is used), never by looking at a profile first;
// freeze this file before any profile is opened. Run with:
//   node --import tsx evaluation/coverage/run-study.ts evaluation/ablation/<repo>/study.ts --out /tmp/ablation-<repo>
//   node --import tsx evaluation/ablation/export-bundle.ts evaluation/ablation/<repo>/study.ts /tmp/ablation-<repo> ../ablation-bundles
import { resolve } from "node:path";
import type { StudyConfig } from "../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const subject = resolve(repoRoot, "../crankts-eval/<repo>"); // pinned checkout, dependencies installed

const study: StudyConfig = {
  name: "<repo>",
  version: "<tag or commit>",
  description: "<what the workloads represent>",
  analysisRoot: subject, // the directory with the tsconfig.json of the code under study
  cwd: subject,
  workloads: [
    // A script in the subject repo (e.g. crankts-workloads/<name>.ts) run from source; 5–30 s each.
    { name: "<workload>", args: ["--experimental-strip-types", resolve(subject, "crankts-workloads/<name>.ts")] },
  ],
  output: resolve(repoRoot, "evaluation/ablation/<repo>/coverage.json"),
};
export default study;
