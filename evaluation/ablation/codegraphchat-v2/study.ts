import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StudyConfig } from "../../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const subject = resolve(repoRoot, "../crankts-eval/codegraphchat-v2");
const analysisProject = resolve(subject, "crankts-workloads/analyzer-project");
const definitions = JSON.parse(
  readFileSync(resolve(subject, "crankts-workloads/workloads.json"), "utf8"),
) as Record<string, { args: string[] }>;

const study: StudyConfig = {
  name: "codegraphchat-v2",
  version: "c35c76b5a22032b6ebe733adf7b720ad6f85bcf2",
  description: "Workspace validation of 128 branching 2,048-state capture graphs; this revision has no repository-index or query command",
  analysisRoot: analysisProject,
  cwd: subject,
  workloads: Object.entries(definitions).map(([name, workload]) => ({
    name,
    args: workload.args,
    degraded: "The pinned CLI lacks repository indexing and queries; this validation substitute runs below the protocol's five-second minimum.",
  })),
  output: resolve(repoRoot, "evaluation/ablation/codegraphchat-v2/coverage.json"),
};

export default study;