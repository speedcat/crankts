import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { StudyConfig } from "../../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const subject = resolve(repoRoot, "../crankts-eval/pdf-lib");
// The analysis root must contain the sources the profile ran (a synthetic project next to them matches no profile frame and
// yields an empty analysis); see docs/ablation-protocol.md, pre-flight check 1.
const analysisProject = subject;
const definitions = JSON.parse(
  readFileSync(resolve(subject, "crankts-workloads/workloads.json"), "utf8"),
) as Record<string, { args: string[] }>;

const study: StudyConfig = {
  name: "pdf-lib",
  version: "v1.17.1 (4beebbef7a261ed0be089bb1d63a5b6e28cc488a)",
  description: "PDF creation and modification with embedded fonts, images, and large page counts",
  analysisRoot: analysisProject,
  // The Node the agent sessions use (the sandbox allows only this one). Node 22.19 breaks tsx 4.20 under any sync load hook,
  // which the evidence probe needs, so the evidence run must not use it.
  node: process.env.ABLATION_NODE ?? resolve(homedir(), ".nvm/versions/node/v24.21.0/bin/node"),
  cwd: subject,
  workloads: Object.entries(definitions).map(([name, workload]) => ({ name, args: workload.args })),
  output: resolve(repoRoot, "evaluation/ablation/pdf-lib/coverage.json"),
};

export default study;