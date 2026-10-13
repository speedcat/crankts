import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { StudyConfig } from "../../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const subject = resolve(repoRoot, "../crankts-eval/typeorm");
// The analysis root must contain the sources the profile ran (a synthetic project next to them matches no profile frame and
// yields an empty analysis); see docs/ablation-protocol.md, pre-flight check 1.
const analysisProject = resolve(subject, "packages/typeorm");
const definitions = JSON.parse(
  readFileSync(resolve(subject, "crankts-workloads/workloads.json"), "utf8"),
) as Record<string, { args: string[]; env: Record<string, string> }>;

const study: StudyConfig = {
  name: "typeorm",
  version: "1.1.2 (a0ea55323662dcd3cff1fa5ab6153be43ded80a7)",
  description: "TypeORM metadata bootstrap, 500k relational inserts, and 20k varied joined hydration queries on SQLite",
  analysisRoot: analysisProject,
  // The Node the agent sessions use (the sandbox allows only this one). Node 22.19 breaks tsx 4.20 under any sync load hook,
  // which the evidence probe needs, so the evidence run must not use it.
  node: process.env.ABLATION_NODE ?? resolve(homedir(), ".nvm/versions/node/v24.21.0/bin/node"),
  cwd: subject,
  workloads: Object.entries(definitions).map(([name, workload]) => ({
    name,
    args: workload.args,
    env: workload.env,
  })),
  output: resolve(repoRoot, "evaluation/ablation/typeorm/coverage.json"),
};

export default study;