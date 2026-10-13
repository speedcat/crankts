#!/usr/bin/env node
// Pre-flight checks for the agent ablation (docs/ablation-protocol.md, section 2b). Read-only.
// Usage: node evaluation/ablation/preflight.mjs <bundle root> <campaign root>
//   e.g. node evaluation/ablation/preflight.mjs ../ablation-bundles/ablation-inputs-2026-10-12 ../ablation-runs/copilot-2026-10-11
// Exit code 1 when a FAIL is found; WARN lines need a decision but do not block.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const [bundleArg, campaignArg] = process.argv.slice(2);
if (!bundleArg || !campaignArg) throw new Error("usage: preflight.mjs <bundle root> <campaign root>");
const bundleRoot = resolve(bundleArg);
const campaignRoot = resolve(campaignArg);
const fails = [];
const warns = [];
const fail = (message) => fails.push(message);
const warn = (message) => warns.push(message);

const arms = { P: ["profile-summary.md", "profile.cpuprofile", "WORKLOAD.md"] };
arms.E = [...arms.P, "crankts-evidence.json", "crankts-evidence.md"];
arms.H = [...arms.E, "crankts-hypotheses.json", "crankts-hypotheses.md"];

// 1 + 2: bundles.
let bundles = 0;
for (const subject of readdirSync(bundleRoot)) {
  for (const workload of readdirSync(join(bundleRoot, subject))) {
    const base = join(bundleRoot, subject, workload);
    const name = `${subject}/${workload}`;
    for (const [arm, files] of Object.entries(arms)) {
      const present = existsSync(join(base, arm)) ? readdirSync(join(base, arm)) : [];
      const extra = present.filter((file) => !files.includes(file));
      const missing = files.filter((file) => !present.includes(file));
      if (missing.length || extra.length) fail(`${name}/${arm}: files differ from the arm definition (missing ${missing}, extra ${extra})`);
    }
    bundles += 1;
    const evidencePath = join(base, "E/crankts-evidence.json");
    if (!existsSync(evidencePath)) continue;
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const attribution = Object.keys(evidence.runtimeByAttributionTarget ?? {});
    const degraded = readFileSync(join(base, "P/WORKLOAD.md"), "utf8").includes("Status: degraded");
    const where = degraded ? warn : fail; // a degraded workload may legitimately have nothing to attribute
    if (attribution.length === 1 && attribution[0] === "UNATTRIBUTED") where(`${name}: E/H evidence is empty (100% UNATTRIBUTED): the analysis root does not contain the sources the profile ran`);
    if ((evidence.callSites ?? []).length === 0) where(`${name}: E/H evidence has no call sites`);
    if (!(evidence.selfTimeByOrigin ?? []).some((origin) => origin.kind === "PROJECT")) where(`${name}: no project origin in selfTimeByOrigin (project code is classified as 'other')`);
    if (!evidence.workloadProbe) fail(`${name}: evidence has no workloadProbe status (exported with an old export-bundle.ts)`);
    else if (!evidence.workloadProbe.ran) where(`${name}: the instrumented evidence run recorded nothing (probe failed or hooks were not applied)`);
    // The P arm must not carry CrankTS output; incidental mentions of the tool name are reported.
    for (const file of arms.P) {
      const text = readFileSync(join(base, "P", file), "utf8");
      // The folder name `crankts-workloads` is part of the prepared layout (prompts and harness refer to it): accepted.
      const mentions = (text.match(/crankts(?!-workloads)/gi) ?? []).length;
      if (mentions > 0) warn(`${name}/P/${file}: ${mentions} mention(s) of the tool name outside the folder name`);
      if (file === "profile.cpuprofile" && text.includes("/Users/")) warn(`${name}/P/${file}: contains absolute home-directory paths`);
    }
  }
}

// 5: workspaces against bundles.
const rows = readFileSync(join(campaignRoot, "control/run-map.csv"), "utf8").trim().split("\n");
const header = rows[0].split('","').map((cell) => cell.replaceAll('"', ""));
const records = rows.slice(1).map((line) => Object.fromEntries(line.split('","').map((cell, index) => [header[index], cell.replaceAll('"', "")])));
let workspaces = 0;
for (const record of records) {
  const workloadsDir = join(campaignRoot, "workspaces", record.run_id, "workloads");
  for (const workload of readdirSync(workloadsDir)) {
    const subject = join(workloadsDir, workload, "subject");
    const target = join(subject, "perf-input");
    const source = join(bundleRoot, record.subject, workload, record.arm);
    const run = `${record.run_id.slice(0, 8)} ${record.subject}/${workload} (${record.arm})`;
    const expected = arms[record.arm];
    const present = existsSync(target) ? readdirSync(target) : [];
    if (present.length !== expected.length || expected.some((file) => !present.includes(file))) fail(`${run}: perf-input files differ from arm ${record.arm}`);
    for (const file of expected) {
      if (!existsSync(join(source, file)) || !existsSync(join(target, file))) continue;
      if (!readFileSync(join(source, file)).equals(readFileSync(join(target, file)))) fail(`${run}: perf-input/${file} differs from the bundle`);
    }
    const count = spawnSync("git", ["-C", subject, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const dirty = spawnSync("git", ["-C", subject, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim();
    if (count !== "1") fail(`${run}: ${count} commits (expected one baseline commit)`);
    if (dirty) fail(`${run}: working tree not clean`);
    if (!existsSync(join(subject, "crankts-workloads/measure.sh"))) fail(`${run}: measure.sh missing`);
    if (!existsSync(join(subject, "crankts-workloads/test.sh"))) warn(`${record.subject}: no crankts-workloads/test.sh (the prompt requires passing subject tests without defining the command)`);
    workspaces += 1;
  }
}
for (const field of ["model", "effort", "copilot_chat_version"]) {
  if (records.some((record) => !record[field])) warn(`run-map.csv: '${field}' is still empty (record it before the first run)`);
}

const unique = (list) => [...new Set(list)];
console.log(`${bundles} bundle workloads, ${records.length} runs, ${workspaces} workspace workloads checked`);
for (const message of unique(warns)) console.log(`WARN ${message}`);
for (const message of unique(fails)) console.log(`FAIL ${message}`);
console.log(fails.length === 0 ? "PRE-FLIGHT OK (warnings above need a decision)" : `PRE-FLIGHT FAILED: ${unique(fails).length} problem(s)`);
process.exit(fails.length === 0 ? 0 : 1);
