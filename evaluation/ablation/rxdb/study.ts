import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StudyConfig } from "../../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const subject = resolve(repoRoot, "../crankts-eval/rxdb");
const analysisProject = resolve(subject, "crankts-workloads/analyzer-project");
const definitions = JSON.parse(
  readFileSync(resolve(subject, "crankts-workloads/workloads.json"), "utf8"),
) as Record<string, { args: string[] }>;

const study: StudyConfig = {
  name: "rxdb",
  version: "17.6.0 (9d60a86373730211c291f8c25668fca7aa531887)",
  description: "In-memory RxDB storage with 750k indexed records, repeated sorted queries, and a live query",
  analysisRoot: analysisProject,
  cwd: subject,
  workloads: Object.entries(definitions).map(([name, workload]) => ({ name, args: workload.args })),
  output: resolve(repoRoot, "evaluation/ablation/rxdb/coverage.json"),
};

export default study;