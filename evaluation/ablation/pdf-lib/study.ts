import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StudyConfig } from "../../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const subject = resolve(repoRoot, "../crankts-eval/pdf-lib");
const analysisProject = resolve(subject, "crankts-workloads/analyzer-project");
const definitions = JSON.parse(
  readFileSync(resolve(subject, "crankts-workloads/workloads.json"), "utf8"),
) as Record<string, { args: string[] }>;

const study: StudyConfig = {
  name: "pdf-lib",
  version: "v1.17.1 (4beebbef7a261ed0be089bb1d63a5b6e28cc488a)",
  description: "PDF creation and modification with embedded fonts, images, and large page counts",
  analysisRoot: analysisProject,
  cwd: subject,
  workloads: Object.entries(definitions).map(([name, workload]) => ({ name, args: workload.args })),
  output: resolve(repoRoot, "evaluation/ablation/pdf-lib/coverage.json"),
};

export default study;