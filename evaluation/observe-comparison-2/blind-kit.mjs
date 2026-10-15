#!/usr/bin/env node
// Builds the blind grading kit after all runs: each run's final report (reports/<runId>.md) and its diff, with words that
// reveal the arm removed, under a random label in shuffled order. The key stays in control/blind-key.json.
// Usage: node evaluation/observe-comparison-2/blind-kit.mjs
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { campaignRoot, paths, workloads } from "./config.mjs";

const runs = JSON.parse(readFileSync(paths.runMap, "utf8")).runs;
const kit = join(campaignRoot, "blind-kit");
mkdirSync(kit, { recursive: true });

// What would tell a grader which material a run had. Replaced, not deleted, so sentences stay readable.
const revealing = [
  [/crankts[\w-]*/gi, "[tool]"],
  [/observability tool|observe(?:d)? session|query (?:tool|commands?)/gi, "[material]"],
  [/\$C\s+\w+[^\n]*/g, "[material query]"],
  [/--sessions-dir\s+\S+/g, ""],
  [/\b(?:coverage\.json|heap\.heapprofile|profile\.cpuprofile|NODE_V8_COVERAGE|precise coverage|heap (?:sampling|profile)|cpu ?profile|source-map cache)\b/gi, "[material]"],
  [/\b(?:summary|top|inspect|callers|callees|deps)\s+--/g, "[material query] --"],
  [/\b[a-z0-9@/.-]+::[^\s`'",)]+/gi, (match) => match.split("::").pop()],
  [/\b\d{8}-\d{6}-[0-9a-f]{4}\b/g, "[session]"],
  [/\/Users\/[^\s`'")]+/g, (match) => match.replace(/^.*\/workspaces\/r\d+\//, "<workspace>/").replace(/^\/Users\/.*$/, "<path>")],
  [/\br\d{2}\b/g, "[run]"],
];
const scrub = (text) => revealing.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);

const missing = runs.filter((run) => !existsSync(paths.report(run.runId)));
if (missing.length > 0) throw new Error(`Reports missing for ${missing.map((run) => run.runId).join(", ")} (save each agent's final report to reports/<runId>.md).`);

const labelled = runs.map((run) => ({ run, label: randomBytes(3).toString("hex") })).sort((left, right) => left.label.localeCompare(right.label));
const key = {};
for (const { run, label } of labelled) {
  const workload = workloads.find((candidate) => candidate.id === run.workload);
  const diff = spawnSync("git", ["diff"], { cwd: paths.workspace(run.runId), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout;
  writeFileSync(join(kit, `${label}.md`), `# Submission ${label} (${workload.subject}: ${workload.name})

## Report

${scrub(readFileSync(paths.report(run.runId), "utf8"))}

## Diff

\`\`\`diff
${diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n[... diff truncated ...]` : diff}
\`\`\`
`);
  key[label] = run;
}
writeFileSync(join(campaignRoot, "control", "blind-key.json"), `${JSON.stringify(key, null, 2)}\n`);
console.log(`blind kit: ${labelled.length} submissions in ${kit}; key in control/blind-key.json`);
