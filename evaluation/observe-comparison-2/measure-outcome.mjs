#!/usr/bin/env node
// Measures one run's outcome against the pristine baseline: allowed changes only, identical output checksum, interleaved
// timing (baseline and candidate alternate, after one warm-up each), and the subject's tests.
// Usage: node evaluation/observe-comparison-2/measure-outcome.mjs <runId> [--runs 10] [--skip-tests]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg } from "node:os";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { node, paths, workloads } from "./config.mjs";

const [runId] = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const runsIndex = process.argv.indexOf("--runs");
const runs = runsIndex > 0 ? Number(process.argv[runsIndex + 1]) : 10;
const skipTests = process.argv.includes("--skip-tests");
const entry = JSON.parse(readFileSync(paths.runMap, "utf8")).runs.find((candidate) => candidate.runId === runId);
if (!entry) throw new Error(`Unknown run ${runId}`);
const workload = workloads.find((candidate) => candidate.id === entry.workload);
const baseline = paths.baseline(workload.subject);
const workspace = paths.workspace(runId);

// Timings under heavy load or swapping are meaningless (a 9 s workload took 15 min with swap full): refuse them.
function machineState() {
  const swap = spawnSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }).stdout?.trim();
  return { loadavg1: Math.round(loadavg()[0] * 10) / 10, cores: availableParallelism(), freeMemMB: Math.round(freemem() / 1048576), swap };
}
const before = machineState();
if (before.loadavg1 > before.cores && !process.argv.includes("--force")) {
  console.error(`Load average ${before.loadavg1} exceeds ${before.cores} cores; timings would be unreliable. Wait, or pass --force. (${before.swap ?? ""})`);
  process.exit(3);
}

const sh = (command, args, cwd, extra = {}) => spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...extra });

// 1. Changes: tracked diffs and new files, all inside the editable paths; the workload folder untouched.
const porcelain = sh("git", ["status", "--porcelain", "--untracked-files=all"], workspace).stdout.split("\n").filter(Boolean)
  .map((line) => line.slice(3)).filter((file) => !file.startsWith("crankts-workloads/") && !file.startsWith(".crankts/"));
const editablePrefixes = workload.editable.map((pattern) => pattern.replace(/\*\*$/, ""));
const violations = porcelain.filter((file) => !editablePrefixes.some((prefix) => file.startsWith(prefix)));
const treeHash = (root) => {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(relative(root, path)).update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest("hex");
};
const workloadFolderUnchanged = treeHash(join(baseline, "crankts-workloads")) === treeHash(join(workspace, "crankts-workloads"));
const diffStat = sh("git", ["diff", "--stat"], workspace).stdout.trim();

// 2. Checksum and timing, interleaved.
const env = { ...process.env, ...workload.env };
function timed(cwd) {
  const start = performance.now();
  const result = sh(node, workload.args, cwd, { env });
  const ms = performance.now() - start;
  if (result.status !== 0) return { ms, checksum: undefined, error: (result.stderr ?? "").slice(-2000) };
  return { ms, checksum: /^CHECKSUM=([a-f0-9]{64})$/m.exec(result.stdout ?? "")?.[1] };
}
const warmBase = timed(baseline);
const warmCandidate = timed(workspace);
const base = [];
const candidate = [];
let checksumOk = warmCandidate.checksum !== undefined && warmCandidate.checksum === warmBase.checksum;
for (let index = 0; index < runs && checksumOk; index += 1) {
  const first = index % 2 === 0;
  const a = first ? timed(baseline) : timed(workspace);
  const b = first ? timed(workspace) : timed(baseline);
  const [baseRun, candidateRun] = first ? [a, b] : [b, a];
  base.push(baseRun.ms);
  candidate.push(candidateRun.ms);
  if (candidateRun.checksum !== warmBase.checksum || baseRun.checksum !== warmBase.checksum) checksumOk = false;
}
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mad = (values) => {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
};

// 3. Tests in the workspace.
let tests = { skipped: true };
if (!skipTests) {
  const started = performance.now();
  const result = sh("bash", ["-lc", workload.tests.commands.join(" && ")], join(workspace, workload.tests.cwd), { env: { ...process.env, PATH: `${join(node, "..")}:${process.env.PATH}` } });
  tests = { passed: result.status === 0, seconds: Math.round((performance.now() - started) / 1000), tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1500) };
}

const outcome = {
  runId,
  arm: entry.arm,
  workload: entry.workload,
  repetition: entry.repetition,
  measuredAt: new Date().toISOString(),
  changes: { files: porcelain, violations, workloadFolderUnchanged, diffStat },
  checksum: { baseline: warmBase.checksum, candidate: warmCandidate.checksum, identical: checksumOk, candidateError: warmCandidate.error },
  timing: checksumOk
    ? {
      runs,
      baselineMedianMs: Math.round(median(base)),
      candidateMedianMs: Math.round(median(candidate)),
      baselineMadMs: Math.round(mad(base)),
      candidateMadMs: Math.round(mad(candidate)),
      speedup: Math.round((median(base) / median(candidate)) * 1000) / 1000,
    }
    : undefined,
  tests,
  machine: { before, after: machineState() },
  valid: violations.length === 0 && workloadFolderUnchanged && checksumOk && (tests.skipped || tests.passed),
};
writeFileSync(paths.outcome(runId), `${JSON.stringify(outcome, null, 2)}\n`);
console.log(JSON.stringify({ runId, valid: outcome.valid, speedup: outcome.timing?.speedup, checksum: checksumOk, tests: tests.passed ?? "skipped", violations }, null, 0));
