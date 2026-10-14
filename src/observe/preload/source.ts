/**
 * The preload that runs inside every Node process and worker of an observed workload (docs/observe-plan.md §8).
 * It is written next to the raw profiles as `preload.cjs` and loaded through `NODE_OPTIONS=--require`. At exit it
 * writes `preload-<pid>-<threadId>.json` synchronously: identity, argv, resource usage, event-loop utilization and
 * delay, and the sha256 of `argv[1]`.
 *
 * Heap (M3): `--heap-prof` keeps only objects still alive when sampling stops, so short-lived allocations, usually the
 * hot ones, would be missing. With CRANKTS_HEAP_INTERVAL set, the preload samples through the in-process inspector
 * with `includeObjectsCollectedByMajorGC/MinorGC` and writes `heap-<pid>-<threadId>.heapprofile` at exit.
 *
 * SIGTERM/SIGINT: Node does not write `--cpu-prof` output when a signal kills the process. If the workload has no
 * handler of its own, the preload turns the signal into `process.exit(128 + n)`, so profiles survive a timeout.
 */
export const PRELOAD_SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { threadId } = require("node:worker_threads");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");

const directory = process.env.CRANKTS_MEASUREMENT_DIR;
if (directory) {
  const startedAt = Date.now();
  let heapSession;
  const heapInterval = Number(process.env.CRANKTS_HEAP_INTERVAL);
  if (heapInterval > 0) {
    try {
      const inspector = require("node:inspector");
      heapSession = new inspector.Session();
      heapSession.connect();
      heapSession.post("HeapProfiler.startSampling", {
        samplingInterval: heapInterval,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    } catch {
      heapSession = undefined;
    }
  }
  let histogram;
  try {
    histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
  } catch {
    histogram = undefined;
  }
  if (threadId === 0) {
    const exitOn = (signal, code) => () => {
      if (process.listenerCount(signal) === 1) process.exit(code);
    };
    process.on("SIGTERM", exitOn("SIGTERM", 143));
    process.on("SIGINT", exitOn("SIGINT", 130));
  }
  process.on("exit", (exitCode) => {
    if (heapSession) {
      try {
        // In-thread inspector sessions answer synchronously, so this still runs inside the exit handler.
        heapSession.post("HeapProfiler.stopSampling", (error, result) => {
          if (!error && result) fs.writeFileSync(path.join(directory, "heap-" + process.pid + "-" + threadId + ".heapprofile"), JSON.stringify(result.profile));
        });
      } catch {
        // Never let observation break the workload.
      }
    }
    try {
      const usage = process.resourceUsage();
      const utilization = performance.eventLoopUtilization();
      const entry = process.argv[1];
      let entryHash;
      if (threadId === 0 && entry && !entry.startsWith("[")) {
        try {
          entryHash = crypto.createHash("sha256").update(fs.readFileSync(entry)).digest("hex");
        } catch {
          entryHash = undefined;
        }
      }
      if (histogram) histogram.disable();
      const record = {
        pid: process.pid,
        ppid: process.ppid,
        threadId,
        argv: process.argv,
        execArgv: process.execArgv,
        cwd: process.cwd(),
        versions: { node: process.versions.node, v8: process.versions.v8 },
        startedAt,
        endedAt: Date.now(),
        exitCode,
        entry,
        entryHash,
        resourceUsage: { userCpuMs: usage.userCPUTime / 1000, systemCpuMs: usage.systemCPUTime / 1000, maxRssKb: usage.maxRSS },
        eventLoop: histogram && histogram.count > 0
          ? { utilization: utilization.utilization, delayP50Ms: histogram.percentile(50) / 1e6, delayP99Ms: histogram.percentile(99) / 1e6 }
          : { utilization: utilization.utilization },
      };
      fs.writeFileSync(path.join(directory, "preload-" + process.pid + "-" + threadId + ".json"), JSON.stringify(record));
    } catch {
      // Never let observation break the workload.
    }
  });
}
`;

export interface PreloadRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly threadId: number;
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  readonly cwd: string;
  readonly versions: { readonly node: string; readonly v8: string };
  readonly startedAt: number;
  readonly endedAt: number;
  readonly exitCode: number;
  readonly entry?: string;
  readonly entryHash?: string;
  readonly resourceUsage: { readonly userCpuMs: number; readonly systemCpuMs: number; readonly maxRssKb: number };
  readonly eventLoop: { readonly utilization: number; readonly delayP50Ms?: number; readonly delayP99Ms?: number };
}
