#!/usr/bin/env node
// MVP-9a self-profile protocol (docs/plan.md). Runs CrankTS on W1/W2 from dist/,
// 1 warm-up + N measured runs per mode (plain/cpu/heap), then lets CrankTS analyze its own profiles.
// Usage: node evaluation/crankts-self-profile/run-mvp9a.mjs [--runs 5] [--out /tmp/crankts-self] [--self-only]
// --self-only re-runs only the self-analysis step against the median profiles of an existing raw result.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist", "cli.js");
const argv = process.argv.slice(2);
const runs = Number(optionValue("--runs") ?? 5);
const outDir = resolve(optionValue("--out") ?? "/tmp/crankts-self");
const intentweave = resolve(repoRoot, "../intentweave");

const workloads = [
  { key: "w1", label: "IntentWeave full workspace", args: [intentweave, "--workspace-references"] },
  { key: "w2", label: "IntentWeave analyzer package", args: [join(intentweave, "packages", "analyzer")] },
];

mkdirSync(outDir, { recursive: true });
const results = {};
if (argv.includes("--self-only")) {
  Object.assign(results, JSON.parse(readFileSync(join(outDir, "mvp9a-raw.json"), "utf8")));
  for (const workload of workloads) {
    analyzeSelf(workload, medianRun(results[workload.key].runs.cpu), medianRun(results[workload.key].runs.heap));
  }
} else {
  for (const workload of workloads) {
    results[workload.key] = measureWorkload(workload);
  }
}
writeFileSync(join(outDir, "mvp9a-raw.json"), `${JSON.stringify(results, null, 2)}\n`);
console.error(`raw results: ${join(outDir, "mvp9a-raw.json")}`);

function measureWorkload(workload) {
  const modes = {};
  const reportHashes = new Set();
  for (const mode of ["plain", "cpu", "heap"]) {
    const measured = [];
    for (let run = 0; run <= runs; run += 1) {
      const name = `${workload.key}-${mode}-${run === 0 ? "warmup" : run}`;
      const result = runOnce(workload, mode, name);
      reportHashes.add(result.reportSha256);
      console.error(`${name}: ${result.wallSeconds.toFixed(2)} s, ${(result.peakRssBytes / 1e6).toFixed(0)} MB`);
      if (run > 0) {
        measured.push(result);
      }
    }
    modes[mode] = measured;
  }

  const medianCpu = medianRun(modes.cpu);
  const medianHeap = medianRun(modes.heap);
  const selfReportPath = analyzeSelf(workload, medianCpu, medianHeap);

  return {
    label: workload.label,
    args: workload.args.map((argument) => argument.replace(resolve(repoRoot, ".."), "..")),
    runs: modes,
    deterministicReport: reportHashes.size === 1,
    reportSha256: [...reportHashes],
    selfAnalysis: { cpuProfile: medianCpu.cpuProfile, heapProfile: medianHeap.heapProfile, report: selfReportPath },
  };
}

function analyzeSelf(workload, medianCpu, medianHeap) {
  const selfReportPath = join(outDir, `${workload.key}-self-report.json`);
  const self = spawnSync(process.execPath, [
    cli, "analyze", join(repoRoot, "src"),
    "--profile", medianCpu.cpuProfile,
    "--heap-profile", medianHeap.heapProfile,
    "--workload", `self: ${workload.label}`,
    "--format", "json",
  ], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 30 });
  if (self.status !== 0) {
    throw new Error(`self analysis failed: ${self.stderr}`);
  }
  writeFileSync(selfReportPath, self.stdout);
  return selfReportPath;
}

function runOnce(workload, mode, name) {
  const nodeArgs = mode === "cpu"
    ? ["--cpu-prof", "--cpu-prof-interval", "1000", "--cpu-prof-dir", outDir, "--cpu-prof-name", `${name}.cpuprofile`]
    : mode === "heap"
      ? ["--heap-prof", "--heap-prof-dir", outDir, "--heap-prof-name", `${name}.heapprofile`]
      : [];
  const timingsPath = join(outDir, `${name}-timings.json`);
  const cliArgs = [cli, "analyze", ...workload.args, "--format", "json", ...(mode === "plain" ? ["--timings", timingsPath] : [])];
  const child = spawnSync("/usr/bin/time", ["-l", process.execPath, ...nodeArgs, ...cliArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (child.status !== 0) {
    throw new Error(`${name} failed: ${child.stderr}`);
  }
  if (mode === "plain" && name.endsWith("-warmup")) {
    writeFileSync(join(outDir, `${workload.key}-report.json`), child.stdout);
  }
  return {
    wallSeconds: Number(/([\d.,]+)\s+real/.exec(child.stderr)?.[1]?.replace(",", ".")),
    peakRssBytes: Number(/(\d+)\s+maximum resident set size/.exec(child.stderr)?.[1]),
    reportSha256: createHash("sha256").update(child.stdout).digest("hex"),
    ...(mode === "plain" ? { timings: JSON.parse(readFileSync(timingsPath, "utf8")) } : {}),
    ...(mode === "cpu" ? { cpuProfile: join(outDir, `${name}.cpuprofile`) } : {}),
    ...(mode === "heap" ? { heapProfile: join(outDir, `${name}.heapprofile`) } : {}),
  };
}

function medianRun(measured) {
  return [...measured].sort((left, right) => left.wallSeconds - right.wallSeconds)[Math.floor(measured.length / 2)];
}

function optionValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
