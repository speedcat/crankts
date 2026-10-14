import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { aggregateCoverage, sourceMapCatalog, type V8CoverageFile } from "./aggregate/coverage.js";
import type { V8CpuProfile } from "./aggregate/cpu.js";
import type { V8HeapProfile } from "./aggregate/heap.js";
import { fingerprintArtifact } from "./artifact/index.js";
import { attribute, type Attribution } from "./attribute.js";
import { buildSummary, readCoverageFile, readCpuProfile, readHeapProfile, writeJson, writeOutputs } from "./m0.js";
import type { ArtifactFingerprint, Measurement, ObservationSession, ProcessInfo } from "./model.js";
import { PRELOAD_SOURCE, type PreloadRecord } from "./preload/source.js";
import { artifactsAgree, assessQuality, repeatCountAgreement } from "./quality/index.js";
import { assertValid } from "./schema.js";
import { FrameResolver } from "./resolve/index.js";
import { assignRoles } from "./runner/roles.js";
import { runWorkload, type WorkloadRun } from "./runner/spawn.js";

/**
 * `crankts observe` (docs/observe-plan.md §5, §8): runs the workload once per measurement with the preload and that
 * measurement's collector, finds the primary process, and writes a session directory:
 *
 *   .crankts/sessions/<sessionId>/{session,entities,metrics,edges,summary}.json + raw/<measurementId>/
 *
 * Measurements: CPU (M1), coverage (M2), and heap (M3). They are separate runs (D2); values are never presented as
 * simultaneous, and derived per-call estimates say so through their confidence.
 */

export type MeasurementKind = "cpu" | "coverage" | "heap";

export interface ObserveOptions {
  readonly command: readonly string[];
  readonly cwd?: string;
  /** Project root for attribution; defaults to cwd. */
  readonly root?: string;
  /** Defaults to `<root>/.crankts/sessions`. */
  readonly sessionsDir?: string;
  readonly entry?: string;
  /** Defaults to cpu, coverage, and heap. */
  readonly only?: readonly MeasurementKind[];
  /** Sampling interval in µs (default 1000). */
  readonly cpuIntervalUs?: number;
  /** Heap sampling interval in bytes (default 524288). */
  readonly heapIntervalBytes?: number;
  /** Per measurement, in seconds (default 600). */
  readonly timeoutSec?: number;
  readonly graceMs?: number;
  readonly workloadId?: string;
  readonly stdio?: "inherit" | "ignore" | "pipe";
  /** Run coverage a second time and compare the top 50 execution counts (§7.6 repeatCountAgreement). */
  readonly verifyDeterminism?: boolean;
  /** Run the workload once without instrumentation first, to report each measurement's wall-time overhead. */
  readonly baseline?: boolean;
}

export interface ObserveResult {
  readonly session: ObservationSession;
  readonly sessionDir: string;
  /** Attribution of the primary process's measurements, when there is one. */
  readonly attribution?: Attribution;
  /** Why nothing was attributed (no primary process, missing data). */
  readonly error?: string;
  /** The first non-zero exit code across measurements, else the last one. */
  readonly exitCode: number | null;
}

interface Collector {
  readonly kind: "cpu" | "coverage" | "heap";
  readonly prefix: string;
  /** Data files: capture groups 1 = pid, 2 = threadId. */
  readonly dataFile: RegExp;
  readonly config: Record<string, string | number>;
  readonly overheadNote: string;
  environment(directory: string): Record<string, string>;
}

interface MeasurementRun {
  readonly measurement: Measurement;
  readonly primary?: PreloadRecord;
  /** Absolute path of the primary process's main-thread data file. */
  readonly primaryData?: string;
  readonly run: WorkloadRun;
}

const PRELOAD_NAME = /^preload-(\d+)-(\d+)\.json$/;
const SUPPORTED: readonly MeasurementKind[] = ["cpu", "coverage", "heap"];

export async function observeWorkload(options: ObserveOptions): Promise<ObserveResult> {
  const only = options.only ?? ["cpu", "coverage", "heap"];
  const unsupported = only.filter((kind) => !SUPPORTED.includes(kind));
  if (unsupported.length > 0) throw new Error(`Unknown measurement ${unsupported.join(", ")} (available: ${SUPPORTED.join(", ")}).`);
  if (only.length === 0) throw new Error("No measurement selected.");
  if (options.command.length === 0) throw new Error("No workload command given (crankts observe [options] -- <cmd...>).");

  const cwd = resolve(options.cwd ?? process.cwd());
  const root = resolve(options.root ?? cwd);
  const sessionId = newSessionId();
  const sessionDir = join(resolve(options.sessionsDir ?? join(root, ".crankts", "sessions")), sessionId);
  const rawDir = join(sessionDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const preloadFile = join(rawDir, "preload.cjs");
  writeFileSync(preloadFile, PRELOAD_SOURCE);
  // Before the runs, and without our own session directory, so observing never makes the tree dirty.
  const git = gitState(root);

  const intervalUs = options.cpuIntervalUs ?? 1000;
  const collectors: Collector[] = [];
  if (only.includes("cpu")) {
    collectors.push({
      kind: "cpu",
      prefix: "cpu",
      dataFile: /^CPU\.\d+\.\d+\.(\d+)\.(\d+)\.\d+\.cpuprofile$/,
      config: { cpuIntervalUs: intervalUs },
      overheadNote: `CPU sampling every ${intervalUs} µs; the preload adds an exit hook and an event-loop delay histogram.`,
      environment: (directory) => ({ NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${quote(directory)} --cpu-prof-interval=${intervalUs}` }),
    });
  }
  if (only.includes("coverage")) {
    collectors.push({
      kind: "coverage",
      prefix: "cov",
      dataFile: /^coverage-(\d+)-\d+-(\d+)\.json$/,
      config: { mode: "precise-count" },
      overheadNote: "Precise block coverage (NODE_V8_COVERAGE) slows execution; its wall time is not comparable to the CPU run.",
      environment: (directory) => ({ NODE_V8_COVERAGE: directory }),
    });
  }

  if (only.includes("heap")) {
    const intervalBytes = options.heapIntervalBytes ?? 524_288;
    collectors.push({
      kind: "heap",
      prefix: "heap",
      dataFile: /^heap-(\d+)-(\d+)\.heapprofile$/,
      config: { heapIntervalBytes: intervalBytes, includesCollected: "true" },
      overheadNote: `Sampling heap profiler every ${intervalBytes} bytes, started by the preload with objects collected by GC included (--heap-prof would keep only live objects).`,
      environment: () => ({ CRANKTS_HEAP_INTERVAL: String(intervalBytes) }),
    });
  }

  let baselineWallMs: number | undefined;
  if (options.baseline) {
    const baseline = await runWorkload({
      command: options.command,
      cwd,
      env: process.env,
      timeoutMs: (options.timeoutSec ?? 600) * 1000,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      ...(options.stdio ? { stdio: options.stdio } : {}),
    });
    baselineWallMs = baseline.wallMs;
  }

  const context = { ...options, cwd, root, rawDir, preloadFile };
  const runs: MeasurementRun[] = [];
  for (const collector of collectors) {
    runs.push(await runMeasurement(collector, context, `${collector.prefix}-01`));
  }
  const coverageCollector = collectors.find((collector) => collector.kind === "coverage");
  const repeatRun = options.verifyDeterminism && coverageCollector ? await runMeasurement(coverageCollector, context, "cov-02") : undefined;
  if (repeatRun) runs.push(repeatRun);

  const cpuRun = runs.find((entry) => entry.measurement.kind === "cpu");
  const coverageRun = runs.find((entry) => entry.measurement.kind === "coverage");
  const cpuProfile: V8CpuProfile | undefined = cpuRun?.primaryData ? readCpuProfile(cpuRun.primaryData) : undefined;
  const coverageFile: V8CoverageFile | undefined = coverageRun?.primaryData ? readCoverageFile(coverageRun.primaryData) : undefined;
  const repeatFile: V8CoverageFile | undefined = repeatRun?.primaryData ? readCoverageFile(repeatRun.primaryData) : undefined;
  const heapRun = runs.find((entry) => entry.measurement.kind === "heap");
  const heapProfile: V8HeapProfile | undefined = heapRun?.primaryData ? readHeapProfile(heapRun.primaryData) : undefined;

  const attributionStarted = performance.now();
  const measurements = runs.map(({ measurement }) => {
    if (measurement.kind === "cpu" && cpuProfile && cpuRun?.primary) {
      return { ...measurement, artifact: fingerprintArtifact(cpuRun.primary, cpuProfile.nodes.map((node) => node.callFrame.url ?? ""), root) };
    }
    if (measurement.kind === "coverage" && coverageFile && coverageRun?.primary && measurement.measurementId === coverageRun.measurement.measurementId) {
      return { ...measurement, artifact: fingerprintArtifact(coverageRun.primary, coverageFile.result.map((script) => script.url), root) };
    }
    if (measurement.kind === "coverage" && repeatFile && repeatRun?.primary && measurement.measurementId === repeatRun.measurement.measurementId) {
      return { ...measurement, artifact: fingerprintArtifact(repeatRun.primary, repeatFile.result.map((script) => script.url), root) };
    }
    if (measurement.kind === "heap" && heapProfile && heapRun?.primary) {
      return { ...measurement, artifact: fingerprintArtifact(heapRun.primary, heapProfileUrls(heapProfile), root) };
    }
    return measurement;
  });
  const artifactAgreement = artifactsAgree(measurements.map((measurement) => measurement.artifact).filter((artifact): artifact is ArtifactFingerprint => artifact !== undefined));

  const attribution = cpuProfile || coverageFile || heapProfile
    ? attribute(root, {
      artifactAgreement,
      ...(cpuProfile && cpuRun ? { cpu: { profile: cpuProfile, measurementId: cpuRun.measurement.measurementId } } : {}),
      ...(coverageFile && coverageRun ? { coverage: { file: coverageFile, measurementId: coverageRun.measurement.measurementId } } : {}),
      ...(heapProfile && heapRun ? { heap: { profile: heapProfile, measurementId: heapRun.measurement.measurementId, includesCollected: true } } : {}),
    })
    : undefined;
  let agreement: number | undefined;
  if (attribution && repeatFile && repeatRun) {
    const first = new Map<string, number>();
    for (const metric of attribution.metrics) {
      const count = metric.execution?.functionExecutionCount;
      if (count !== undefined) first.set(metric.key, count);
    }
    const repeated = aggregateCoverage(repeatFile, new FrameResolver(root, { sourceMaps: sourceMapCatalog(repeatFile) }), { measurementId: repeatRun.measurement.measurementId });
    agreement = repeatCountAgreement(first, new Map([...repeated.executions].map(([key, execution]) => [key, execution.functionExecutionCount])));
  }
  const quality = assessQuality({ measurements, ...(attribution ? { attribution } : {}), artifactAgreement, ...(agreement !== undefined ? { repeatCountAgreement: agreement } : {}) });
  const attributionMs = Math.round(performance.now() - attributionStarted);
  const primary = runs.find((entry) => entry.primary)?.primary;
  const session: ObservationSession = {
    schemaVersion: "0.3",
    sessionId,
    createdAt: new Date().toISOString(),
    workload: { command: options.command, cwd, root, ...(options.workloadId ? { workloadId: options.workloadId } : {}) },
    git,
    environment: {
      node: primary?.versions.node ?? process.versions.node,
      v8: primary?.versions.v8 ?? process.versions.v8,
      os: `${platform()} ${release()} ${arch()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      cores: availableParallelism(),
    },
    measurements: baselineWallMs === undefined
      ? measurements
      : measurements.map((measurement) => ({ ...measurement, overhead: { baselineWallMs, wallRatio: Math.round((measurement.wallMs / Math.max(1, baselineWallMs)) * 100) / 100 } })),
    quality,
    timing: { attributionMs, ...(baselineWallMs !== undefined ? { baselineWallMs } : {}) },
  };

  assertValid("session.json", session);
  writeJson(join(sessionDir, "session.json"), session);
  if (attribution) {
    writeOutputs(sessionDir, attribution, { sessionId, quality: quality.level, ...buildSummary(attribution, undefined, 10) });
  }
  const errors = measurements.flatMap((measurement) => measurement.errors);
  const error = attribution ? undefined : errors.join(" ") || "Nothing was attributed.";
  const exitCode = runs.map((entry) => entry.run.code).find((code) => code !== 0 && code !== null) ?? runs.at(-1)?.run.code ?? null;
  return { session, sessionDir, ...(attribution ? { attribution } : {}), ...(error ? { error } : {}), exitCode };
}

async function runMeasurement(
  collector: Collector,
  context: ObserveOptions & { readonly cwd: string; readonly root: string; readonly rawDir: string; readonly preloadFile: string },
  measurementId: string,
): Promise<MeasurementRun> {
  const directory = join(context.rawDir, measurementId);
  mkdirSync(directory);
  const collectorEnvironment = collector.environment(directory);
  const env = {
    ...process.env,
    ...collectorEnvironment,
    NODE_OPTIONS: [process.env["NODE_OPTIONS"] ?? "", `--require ${quote(context.preloadFile)}`, collectorEnvironment["NODE_OPTIONS"] ?? ""]
      .filter(Boolean).join(" "),
    CRANKTS_MEASUREMENT_DIR: directory,
  };
  const run = await runWorkload({
    command: context.command,
    cwd: context.cwd,
    env,
    timeoutMs: (context.timeoutSec ?? 600) * 1000,
    ...(context.graceMs !== undefined ? { graceMs: context.graceMs } : {}),
    ...(context.stdio ? { stdio: context.stdio } : {}),
  });

  const files = readdirSync(directory).sort();
  const records: PreloadRecord[] = [];
  const recordFile = new Map<PreloadRecord, string>();
  for (const name of files.filter((file) => PRELOAD_NAME.test(file))) {
    try {
      const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as PreloadRecord;
      records.push(record);
      recordFile.set(record, name);
    } catch {
      // A truncated record (process killed while writing) is reported through the missing-data check below.
    }
  }
  const dataFiles = new Map<string, string>();
  for (const name of files) {
    const match = collector.dataFile.exec(name);
    if (match) dataFiles.set(`${match[1]}:${match[2]}`, name);
  }

  const errors: string[] = [];
  if (run.timedOut) errors.push(`${measurementId}: timed out after ${context.timeoutSec ?? 600} s; the workload was sent SIGTERM.`);
  if (run.killed) errors.push(`${measurementId}: SIGKILL was needed after the grace period; data of killed processes is missing.`);
  const assignment = assignRoles(records, { command: context.command, cwd: context.cwd, ...(context.entry ? { entry: context.entry } : {}) });
  if (assignment.error) errors.push(`${measurementId}: ${assignment.error}`);

  const processes: ProcessInfo[] = records.map((record) => {
    const data = dataFiles.get(`${record.pid}:${record.threadId}`);
    return {
      pid: record.pid,
      ppid: record.ppid,
      threadId: record.threadId,
      role: assignment.roles.get(record) ?? "unknown",
      argv: record.argv,
      execArgv: record.execArgv,
      resourceUsage: record.resourceUsage,
      eventLoop: record.eventLoop,
      exitCode: record.exitCode,
      wallMs: record.endedAt - record.startedAt,
      rawFiles: [data, recordFile.get(record)].filter((file): file is string => file !== undefined).map((file) => `${measurementId}/${file}`),
    };
  });
  const recorded = new Set(records.map((record) => `${record.pid}:${record.threadId}`));
  for (const [id, name] of dataFiles) {
    if (recorded.has(id)) continue;
    // Threads that never ran the preload's exit hook (e.g. the module-loader thread of `--import` hooks).
    const [pid, threadId] = id.split(":").map(Number) as [number, number];
    const owner = records.find((record) => record.pid === pid && record.threadId === 0);
    processes.push({ pid, ppid: owner?.ppid ?? -1, threadId, role: threadId > 0 ? "worker" : "unknown", argv: [], execArgv: [], rawFiles: [`${measurementId}/${name}`] });
  }
  processes.sort((left, right) => roleOrder(left.role) - roleOrder(right.role) || left.pid - right.pid || left.threadId - right.threadId);

  const primary = assignment.primary;
  const primaryName = primary ? dataFiles.get(`${primary.pid}:0`) : undefined;
  if (primary && !primaryName) errors.push(`${measurementId}: the primary process (pid ${primary.pid}) wrote no ${collector.kind} data.`);

  const measurement: Measurement = {
    measurementId,
    kind: collector.kind,
    config: collector.config,
    processes,
    rawFiles: files.filter((file) => collector.dataFile.test(file) || PRELOAD_NAME.test(file)).map((file) => `${measurementId}/${file}`),
    wallMs: run.wallMs,
    exit: { code: run.code, signal: run.signal, timedOut: run.timedOut },
    errors,
    overheadNote: collector.overheadNote,
  };
  return { measurement, ...(primary ? { primary } : {}), ...(primaryName ? { primaryData: join(directory, primaryName) } : {}), run };
}

function heapProfileUrls(profile: V8HeapProfile): string[] {
  const urls: string[] = [];
  const stack = [profile.head];
  while (stack.length > 0) {
    const node = stack.pop() as V8HeapProfile["head"];
    if (node.callFrame.url) urls.push(node.callFrame.url);
    stack.push(...(node.children ?? []));
  }
  return urls;
}

function gitState(root: string): ObservationSession["git"] {
  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    } catch {
      return undefined;
    }
  };
  const sha = git("rev-parse", "HEAD")?.trim();
  if (!sha) return { sha: null, dirty: false };
  const status = git("status", "--porcelain", "--", ".", ":(exclude).crankts") ?? "";
  if (!status.trim()) return { sha, dirty: false };
  const diff = git("diff", "HEAD") ?? "";
  return { sha, dirty: true, dirtyHash: createHash("sha256").update(status).update(diff).digest("hex").slice(0, 16) };
}

function newSessionId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

function roleOrder(role: ProcessInfo["role"]): number {
  return ["primary", "worker", "child", "launcher", "unknown"].indexOf(role);
}

/** NODE_OPTIONS accepts double-quoted values with backslash escapes. */
function quote(path: string): string {
  return `"${path.replace(/["\\]/g, "\\$&")}"`;
}
