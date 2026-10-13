#!/usr/bin/env node
// Replaces the perf-input/ folders of prepared ablation workspaces with the files of a (re)generated bundle,
// without rebuilding the workspaces. perf-input/ is excluded from the baseline commit, so the baseline stays valid.
// Refuses to touch a run that has already started (start_time_utc set in run-map.csv).
// Usage: node evaluation/ablation/sync-perf-input.mjs <bundle root> <campaign root> [--apply]
//   Without --apply it only reports what would change.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const apply = process.argv.includes("--apply");
const [bundleArg, campaignArg] = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (!bundleArg || !campaignArg) throw new Error("usage: sync-perf-input.mjs <bundle root> <campaign root> [--apply]");
const bundleRoot = resolve(bundleArg);
const campaignRoot = resolve(campaignArg);

const lines = readFileSync(join(campaignRoot, "control/run-map.csv"), "utf8").trim().split("\n");
const header = lines[0].split('","').map((cell) => cell.replaceAll('"', ""));
const records = lines.slice(1).map((line) => Object.fromEntries(line.split('","').map((cell, index) => [header[index], cell.replaceAll('"', "")])));

const started = records.filter((record) => record.start_time_utc);
if (started.length > 0) throw new Error(`${started.length} run(s) already started (${started.map((record) => record.run_id.slice(0, 8)).join(", ")}); refusing to change their material.`);

let changed = 0;
for (const record of records) {
  const workloadsDir = join(campaignRoot, "workspaces", record.run_id, "workloads");
  for (const workload of readdirSync(workloadsDir)) {
    const source = join(bundleRoot, record.subject, workload, record.arm);
    const target = join(workloadsDir, workload, "subject", "perf-input");
    if (!existsSync(source)) throw new Error(`missing bundle ${source}`);
    const wanted = readdirSync(source);
    const present = existsSync(target) ? readdirSync(target) : [];
    const differs = wanted.some((file) => !present.includes(file) || !readFileSync(join(source, file)).equals(readFileSync(join(target, file))))
      || present.some((file) => !wanted.includes(file));
    if (!differs) continue;
    changed += 1;
    if (!apply) continue;
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const file of wanted) cpSync(join(source, file), join(target, file));
  }
}
console.log(`${changed} perf-input folder(s) ${apply ? "replaced" : "would be replaced (run with --apply)"}`);
