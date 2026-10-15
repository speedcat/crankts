#!/usr/bin/env node
// Prepares the second Observe agent comparison: baseline clones, recorded materials per arm (P, P+, O), one isolated
// workspace and prompt per run, and the run map. Usage: node evaluation/observe-comparison-2/prepare.mjs [--force]
// See README.md in this directory.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { arms, campaignRoot, cranktsCli, evalRoot, node, paths, repetitions, workloads } from "./config.mjs";

const force = process.argv.includes("--force");
if (existsSync(campaignRoot) && !force) {
  console.error(`${campaignRoot} exists; pass --force to rebuild it.`);
  process.exit(2);
}
if (!existsSync(node)) throw new Error(`Node not found at ${node} (set COMPARISON_NODE).`);
if (!existsSync(cranktsCli)) throw new Error(`Build CrankTS first (pnpm build): ${cranktsCli} is missing.`);
rmSync(campaignRoot, { recursive: true, force: true });
for (const dir of ["baseline", "materials", "workspaces", "prompts", "outcomes", "reports", "control"]) mkdirSync(join(campaignRoot, dir), { recursive: true });

/** Copy-on-write clone on APFS (cp -c), plain copy elsewhere. */
function clone(from, to) {
  const cow = spawnSync("cp", ["-c", "-R", from, to], { stdio: "inherit" });
  if (cow.status !== 0) cpSync(from, to, { recursive: true });
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr}`);
  return result;
}

// 1. Baseline clones: the pristine subjects (pinned commit plus the prepared workload folder and dependencies).
for (const subject of new Set(workloads.map((workload) => workload.subject))) {
  const source = resolve(evalRoot, subject);
  const status = run("git", ["-C", source, "status", "--porcelain"]).stdout.split("\n").filter((line) => line && !line.endsWith("crankts-workloads/"));
  if (status.length > 0) throw new Error(`${source} has local changes:\n${status.join("\n")}`);
  clone(source, paths.baseline(subject));
  console.log(`baseline: ${subject}`);
}

// 2. Materials: one Observe session per workload, recorded in the baseline clone, then split into the arms.
const scrub = (text, sessionDir) => text
  .replaceAll(`${sessionDir}/raw/preload.cjs`, "/observer/preload.cjs")
  .replaceAll(`file://${sessionDir}/raw/preload.cjs`, "file:///observer/preload.cjs");
for (const workload of workloads) {
  const root = paths.baseline(workload.subject);
  const sessions = join(root, ".crankts", "sessions");
  run(node, [cranktsCli, "observe", "--workload", workload.name, "--", node, ...workload.args], {
    cwd: root,
    env: { ...process.env, ...workload.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const sessionId = readdirSync(sessions).sort().at(-1);
  const sessionDir = join(sessions, sessionId);
  const session = JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8"));
  if (session.quality.level !== "high") console.warn(`warning: ${workload.id} session quality ${session.quality.level}: ${session.quality.reasons.join(", ")}`);
  const primaryFile = (kind, suffix) => {
    const measurement = session.measurements.find((entry) => entry.kind === kind);
    const file = measurement?.processes.find((info) => info.role === "primary")?.rawFiles.find((name) => name.endsWith(suffix));
    if (!file) throw new Error(`${workload.id}: no primary ${kind} data`);
    return join(sessionDir, "raw", file);
  };
  const raw = {
    cpu: scrub(readFileSync(primaryFile("cpu", ".cpuprofile"), "utf8"), sessionDir),
    coverage: scrub(readFileSync(primaryFile("coverage", ".json"), "utf8"), sessionDir),
    heap: scrub(readFileSync(primaryFile("heap", ".heapprofile"), "utf8"), sessionDir),
  };
  const materials = paths.materials(workload.id);
  mkdirSync(join(materials, "P"), { recursive: true });
  writeFileSync(join(materials, "P", "profile.cpuprofile"), raw.cpu);
  mkdirSync(join(materials, "P+"), { recursive: true });
  writeFileSync(join(materials, "P+", "profile.cpuprofile"), raw.cpu);
  writeFileSync(join(materials, "P+", "coverage.json"), raw.coverage);
  writeFileSync(join(materials, "P+", "heap.heapprofile"), raw.heap);
  const observeTarget = join(materials, "O", "sessions", sessionId);
  mkdirSync(observeTarget, { recursive: true });
  for (const file of ["session.json", "entities.json", "metrics.json", "edges.json", "summary.json"]) cpSync(join(sessionDir, file), join(observeTarget, file));
  writeFileSync(join(materials, "recording.json"), `${JSON.stringify({
    sessionId,
    quality: session.quality,
    measurements: session.measurements.map((entry) => ({ id: entry.measurementId, wallMs: entry.wallMs })),
    sha256: Object.fromEntries(Object.entries(raw).map(([name, text]) => [name, createHash("sha256").update(text).digest("hex")])),
  }, null, 2)}\n`);
  // The recording stays out of the workspaces: remove it from the baseline clone they are cloned from.
  rmSync(join(root, ".crankts"), { recursive: true, force: true });
  console.log(`materials: ${workload.id} (session ${sessionId}, quality ${session.quality.level})`);
}

// 3. Runs: every arm × workload × repetition, in a seeded shuffled order, each with its own workspace clone.
const combos = [];
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  for (const workload of workloads) for (const arm of arms) combos.push({ arm, workload: workload.id, repetition });
}
let seed = 20261015;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
for (let index = combos.length - 1; index > 0; index -= 1) {
  const other = Math.floor(random() * (index + 1));
  [combos[index], combos[other]] = [combos[other], combos[index]];
}
const runMap = combos.map((combo, index) => ({ runId: `r${String(index + 1).padStart(2, "0")}`, ...combo }));
for (const entry of runMap) {
  const workload = workloads.find((candidate) => candidate.id === entry.workload);
  clone(paths.baseline(workload.subject), paths.workspace(entry.runId));
  writeFileSync(paths.prompt(entry.runId), prompt(entry, workload));
}
writeFileSync(paths.runMap, `${JSON.stringify({ createdAt: new Date().toISOString(), node, runs: runMap }, null, 2)}\n`);
console.log(`runs: ${runMap.length} (${runMap.map((entry) => `${entry.runId}=${entry.arm}/${entry.workload}#${entry.repetition}`).join(", ")})`);

function prompt(entry, workload) {
  const workspace = paths.workspace(entry.runId);
  const materials = paths.materials(workload.id);
  const material = {
    P: [
      "A V8 CPU profile of one run of the workload (recorded with `node --cpu-prof --cpu-prof-interval=1000`):",
      `  ${join(materials, "P", "profile.cpuprofile")}`,
      "Analyze it with your own read-only scripts.",
    ],
    "P+": [
      "Three raw recordings of the workload, each from a separate run:",
      `  ${join(materials, "P+", "profile.cpuprofile")}   V8 CPU profile (\`node --cpu-prof --cpu-prof-interval=1000\`)`,
      `  ${join(materials, "P+", "coverage.json")}        precise V8 coverage (NODE_V8_COVERAGE): exact execution counts per function and block, plus Node's source-map cache for the transformed sources`,
      `  ${join(materials, "P+", "heap.heapprofile")}     sampling heap profile that includes objects the GC already collected (allocation volume per call stack)`,
      "Analyze them with your own read-only scripts.",
    ],
    O: [
      "An observability tool recorded three runs of the workload (CPU profile, precise coverage, heap sampling) and attributed them to code entities. Query it ONLY through these commands (each prints JSON):",
      `  C="${node} ${cranktsCli}"`,
      `  D="--sessions-dir ${join(materials, "O", "sessions")} --json"`,
      "  $C summary $D                                  overview, quality, top entities (start here)",
      "  $C top --by self|inclusive|alloc|executions|cpu-per-call [--limit 20] [--scope own|all] $D",
      "  $C inspect <key | unique name like Class.method | file:line> $D   everything measured for one entity",
      "  $C callers <key> [--limit 10] $D        $C callees <key> [--limit 10] $D",
      "  $C deps [<key>] $D                              dependency time by the own code that caused it",
      "Keys look like <package>::<module>::<name>. Do not open the files under the sessions directory directly.",
    ],
  }[entry.arm];
  return `# Task ${entry.runId}

You are a performance engineer. ${workload.description}

Your workspace (a private copy of the project; change files only here): ${workspace}

Run the workload once:            cd ${workspace} && ${workload.env.TSX_TSCONFIG_PATH ? `TSX_TSCONFIG_PATH=${workload.env.TSX_TSCONFIG_PATH} ` : ""}${node} ${workload.args.join(" ")}
Time it (5 runs, median and output checksum): cd ${workspace} && ${workload.env.TSX_TSCONFIG_PATH ? `TSX_TSCONFIG_PATH=${workload.env.TSX_TSCONFIG_PATH} ` : ""}${node} crankts-workloads/measure.mjs ${workload.name}
Tests (must pass after your change):  cd ${join(workspace, workload.tests.cwd)} && ${workload.tests.commands.join(" && ")}
Use this Node binary for everything: ${node}

## Goal

Find the single optimization in the project's own source code that gives this workload the largest speedup, and implement it. You may iterate on that one optimization. Spend your effort on choosing the right one: a wrong choice cannot be made up for later.

## Measurement material

${material.join("\n")}

## Rules

- Edit only ${workload.editable.join(", ")} inside your workspace. Do not change the workload scripts (crankts-workloads/), tests, dependencies, lockfiles, or node_modules.
- The workload's output CHECKSUM must stay identical, and the tests must pass.
- Do not use profilers or runtime instrumentation of any kind (no --cpu-prof, --prof, --heap-prof, --inspect, NODE_V8_COVERAGE, clinic, 0x, or similar). Timing the workload with the measure script is allowed.
- Use only the measurement material above to learn about runtime behavior. Do not open anything else under ${campaignRoot} except your workspace and your material.
- Budget: about 60 tool calls.

## Report

Explain the diagnosis (what is slow and why, with the evidence you used), the change (files and what changed), and your before/after medians from the measure script. End with a JSON block:
{"diagnosis":"...","evidence":["..."],"change":{"files":["..."],"summary":"..."},"expectedSpeedup":"...","measured":{"beforeMedianMs":0,"afterMedianMs":0},"checksumUnchanged":true,"testsPassed":true,"alternativesConsidered":["..."],"toolCallsUsed":0}
`;
}
