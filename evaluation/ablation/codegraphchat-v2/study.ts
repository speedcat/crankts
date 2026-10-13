import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { StudyConfig } from "../../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const subject = resolve(repoRoot, "../crankts-eval/codegraphchat-v2");
// The analysis root must contain the sources the profile ran (a synthetic project next to them matches no profile frame and
// yields an empty analysis); see docs/ablation-protocol.md, pre-flight check 1.
const analysisProject = subject;
const definitions = JSON.parse(
  readFileSync(resolve(subject, "crankts-workloads/workloads.json"), "utf8"),
) as Record<string, { args: string[] }>;

const study: StudyConfig = {
  name: "codegraphchat-v2",
  version: "c35c76b5a22032b6ebe733adf7b720ad6f85bcf2",
  description: "Workspace validation of 128 branching 2,048-state capture graphs; this revision has no repository-index or query command",
  analysisRoot: analysisProject,
  workspaceReferences: true, // solution-style tsconfig.json (files: [], references to the packages)
  // The Node the agent sessions use (the sandbox allows only this one). Node 22.19 breaks tsx 4.20 under any sync load hook,
  // which the evidence probe needs, so the evidence run must not use it.
  node: process.env.ABLATION_NODE ?? resolve(homedir(), ".nvm/versions/node/v24.21.0/bin/node"),
  cwd: subject,
  workloads: Object.entries(definitions).map(([name, workload]) => ({
    name,
    args: workload.args,
    degraded: "The pinned CLI lacks repository indexing and queries; this validation substitute runs below the protocol's five-second minimum.",
  })),
  output: resolve(repoRoot, "evaluation/ablation/codegraphchat-v2/coverage.json"),
};

export default study;