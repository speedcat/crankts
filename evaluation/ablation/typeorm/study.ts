import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StudyConfig } from "../../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const subject = resolve(repoRoot, "../crankts-eval/typeorm");
const analysisProject = resolve(subject, "crankts-workloads/analyzer-project");
const definitions = JSON.parse(
  readFileSync(resolve(subject, "crankts-workloads/workloads.json"), "utf8"),
) as Record<string, { args: string[]; env: Record<string, string> }>;

const study: StudyConfig = {
  name: "typeorm",
  version: "1.1.2 (a0ea55323662dcd3cff1fa5ab6153be43ded80a7)",
  description: "TypeORM metadata bootstrap, 500k relational inserts, and 20k varied joined hydration queries on SQLite",
  analysisRoot: analysisProject,
  cwd: subject,
  workloads: Object.entries(definitions).map(([name, workload]) => ({
    name,
    args: workload.args,
    env: workload.env,
  })),
  output: resolve(repoRoot, "evaluation/ablation/typeorm/coverage.json"),
};

export default study;