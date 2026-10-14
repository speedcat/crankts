import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateCoverageFile, type V8CoverageFile } from "./aggregate/coverage.js";
import { validateCpuProfile, type V8CpuProfile } from "./aggregate/cpu.js";
import { validateHeapProfile, type V8HeapProfile } from "./aggregate/heap.js";
import { attribute, isOwnEntity, type Attribution } from "./attribute.js";
import type { EntityMetrics } from "./model.js";
import { assertValid } from "./schema.js";

/**
 * Observe M0 (docs/observe-plan.md §10): one existing `.cpuprofile` → entities.json, metrics.json, edges.json, and
 * summary.json. Sessions (M1+) use the same attribution and output writers.
 */

export interface ObserveM0Options {
  readonly profilePath: string;
  readonly root: string;
  readonly outDir?: string;
  readonly topLimit?: number;
}

export interface ObserveM0Result extends Attribution {
  readonly outDir?: string;
}

export function observeCpuProfile(options: ObserveM0Options): ObserveM0Result {
  const profilePath = resolve(options.profilePath);
  const result = attributeCpuProfile(readCpuProfile(profilePath), options.root);
  if (!options.outDir) return result;
  const outDir = resolve(options.outDir);
  writeOutputs(outDir, result, buildSummary(result, profilePath, options.topLimit ?? 10));
  return { ...result, outDir };
}

export function readCpuProfile(profilePath: string): V8CpuProfile {
  return validateCpuProfile(readJson(profilePath, "V8 CPU profile"), profilePath);
}

export function readCoverageFile(coveragePath: string): V8CoverageFile {
  return validateCoverageFile(readJson(coveragePath, "V8 coverage file"), coveragePath);
}

export function readHeapProfile(heapPath: string): V8HeapProfile {
  return validateHeapProfile(readJson(heapPath, "V8 heap profile"), heapPath);
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read ${label} '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Profile → entities, metrics, edges, summary (in memory). */
export function attributeCpuProfile(profile: V8CpuProfile, root: string, measurementId = "cpu-01"): ObserveM0Result {
  return attribute(root, { cpu: { profile, measurementId } });
}

export function writeOutputs(outDir: string, result: Attribution, summary: unknown): void {
  assertValid("entities.json", result.entities);
  assertValid("metrics.json", result.metrics);
  assertValid("edges.json", result.edges);
  mkdirSync(outDir, { recursive: true });
  writeJson(join(outDir, "entities.json"), result.entities);
  writeJson(join(outDir, "metrics.json"), result.metrics);
  writeJson(join(outDir, "edges.json"), result.edges);
  writeJson(join(outDir, "summary.json"), summary);
}

export function buildSummary(result: Attribution, profilePath: string | undefined, limit: number): Record<string, unknown> {
  const entityOf = new Map(result.entities.map((entity) => [entity.identity.key, entity]));
  const isOwn = (metric: EntityMetrics): boolean => isOwnEntity(entityOf.get(metric.key));
  const row = (metric: EntityMetrics) => {
    const entity = entityOf.get(metric.key);
    return {
      key: metric.key,
      ...(entity?.source ? { at: `${entity.source.file}:${entity.source.line}` } : {}),
      ...(metric.cpu ? { selfMs: metric.cpu.selfMs, inclusiveMs: metric.cpu.inclusiveMs } : {}),
      ...(metric.execution?.functionExecutionCount !== undefined ? { executions: metric.execution.functionExecutionCount } : {}),
      confidence: metric.confidence.cpu,
      ...(metric.flags.length > 0 ? { flags: metric.flags } : {}),
    };
  };
  const own = result.metrics.filter(isOwn);
  const withCpu = own.filter((metric) => metric.cpu);
  const bySelf = [...withCpu].sort((left, right) => (right.cpu?.selfMs ?? 0) - (left.cpu?.selfMs ?? 0)).slice(0, limit);
  const byInclusive = withCpu.slice(0, limit);
  const byCaused = [...withCpu]
    .map((metric) => ({ metric, caused: causedTotal(metric) }))
    .filter((entry) => entry.caused > 0)
    .sort((left, right) => right.caused - left.caused)
    .slice(0, limit)
    .map(({ metric }) => ({ ...row(metric), caused: metric.cpu?.caused, ...(metric.cpu?.causedByPackage ? { causedByPackage: metric.cpu.causedByPackage } : {}) }));
  const byExecutions = own
    .filter((metric) => (metric.execution?.functionExecutionCount ?? 0) > 0)
    .sort((left, right) => (right.execution?.functionExecutionCount ?? 0) - (left.execution?.functionExecutionCount ?? 0))
    .slice(0, limit)
    .map(row);
  const byAllocation = own
    .filter((metric) => (metric.allocation?.selfBytes ?? 0) > 0)
    .sort((left, right) => (right.allocation?.selfBytes ?? 0) - (left.allocation?.selfBytes ?? 0))
    .slice(0, limit)
    .map((metric) => ({ ...row(metric), selfBytes: metric.allocation?.selfBytes, inclusiveBytes: metric.allocation?.inclusiveBytes, allocationConfidence: metric.confidence.allocation }));
  // Per-call estimates only where both inputs are solid enough to read.
  const usable = (confidence: string | undefined) => confidence === "high" || confidence === "medium";
  const byCpuPerCall = own
    .filter((metric) => usable(metric.estimates?.selfCpuPerCall?.confidence))
    .sort((left, right) => (right.estimates?.selfCpuPerCall?.estimatedNs ?? 0) - (left.estimates?.selfCpuPerCall?.estimatedNs ?? 0))
    .slice(0, limit)
    .map((metric) => ({ key: metric.key, ...metric.estimates?.selfCpuPerCall }));
  const byBytesPerCall = own
    .filter((metric) => usable(metric.estimates?.bytesPerCall?.confidence))
    .sort((left, right) => (right.estimates?.bytesPerCall?.estimatedBytes ?? 0) - (left.estimates?.bytesPerCall?.estimatedBytes ?? 0))
    .slice(0, limit)
    .map((metric) => ({ key: metric.key, ...metric.estimates?.bytesPerCall }));
  const foreign = result.metrics
    .filter((metric) => !isOwn(metric) && metric.cpu)
    .sort((left, right) => (right.cpu?.selfMs ?? 0) - (left.cpu?.selfMs ?? 0))
    .slice(0, limit)
    .map((metric) => ({ key: metric.key, selfMs: metric.cpu?.selfMs ?? 0, selfPct: metric.cpu?.selfPct ?? 0 }));
  return {
    schemaVersion: "0.3",
    ...(profilePath ? { profile: profilePath } : {}),
    ...(result.summary ? { cpu: result.summary } : {}),
    ...(result.execution ? { execution: result.execution } : {}),
    ...(result.heap ? { heap: result.heap } : {}),
    ...(result.sampledButNotExecutedRatio !== undefined ? { sampledButNotExecutedRatio: result.sampledButNotExecutedRatio } : {}),
    ...(result.allocatedButNotExecutedRatio !== undefined ? { allocatedButNotExecutedRatio: result.allocatedButNotExecutedRatio } : {}),
    ...(withCpu.length > 0 ? { topSelf: bySelf.map(row), topInclusive: byInclusive.map(row), topCaused: byCaused, topForeign: foreign } : {}),
    ...(byExecutions.length > 0 ? { topExecutions: byExecutions } : {}),
    ...(byAllocation.length > 0 ? { topAllocators: byAllocation } : {}),
    ...(byCpuPerCall.length > 0 ? { topSelfCpuPerCall: byCpuPerCall } : {}),
    ...(byBytesPerCall.length > 0 ? { topBytesPerCall: byBytesPerCall } : {}),
  };
}

function causedTotal(metric: EntityMetrics): number {
  const caused = metric.cpu?.caused;
  return caused ? caused.dependencyMs + caused.runtimeMs + caused.nativeMs + caused.gcMs : 0;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function renderM0Text(result: ObserveM0Result, limit = 15): string {
  const lines: string[] = [];
  const summary = result.summary;
  if (summary) {
    lines.push(
      `CPU ${summary.totalMs} ms sampled (${summary.sampleCount} samples, idle ${summary.idleMs} ms excluded)`,
      `By leaf category: ${Object.entries(summary.byCategory).filter(([, value]) => value > 0).map(([name, value]) => `${name} ${value} ms`).join(", ")}`,
      `Own samples unmapped: ${(summary.unmappedOwnSampleRatio * 100).toFixed(1)}%`,
    );
  }
  if (result.execution) {
    lines.push(`Coverage: ${result.execution.executedEntities} entities executed; ${result.execution.unmatchedExecutedFunctions} executed V8 functions matched no entity`);
  }
  if (result.heap) {
    const heap = result.heap;
    lines.push(`Heap ${(heap.totalBytes / 1e6).toFixed(1)} MB sampled allocations (${heap.sampleCount} samples${heap.includesCollected ? ", collected objects included" : ""}): ${Object.entries(heap.byCategory).filter(([, value]) => value > 0).map(([name, value]) => `${name} ${(value / 1e6).toFixed(1)} MB`).join(", ")}`);
  }
  if (result.sampledButNotExecutedRatio !== undefined) {
    lines.push(`Sampled but not executed: ${(result.sampledButNotExecutedRatio * 100).toFixed(1)}% of own self time`);
  }
  const entityOf = new Map(result.entities.map((entity) => [entity.identity.key, entity]));
  const own = result.metrics.filter((metric) => isOwnEntity(entityOf.get(metric.key)));
  const location = (key: string): string => {
    const source = entityOf.get(key)?.source;
    return source ? `  (${source.file}:${source.line})` : "";
  };
  const withCpu = own.filter((metric) => metric.cpu);
  if (withCpu.length > 0) {
    lines.push("", "Top own entities by inclusive time:");
    for (const metric of withCpu.slice(0, limit)) {
      const cpu = metric.cpu;
      if (!cpu) continue;
      const count = metric.execution?.functionExecutionCount;
      lines.push(`  ${cpu.inclusivePct.toFixed(1).padStart(5)}% incl  ${cpu.selfPct.toFixed(1).padStart(5)}% self${count !== undefined ? `  ${String(count).padStart(9)}×` : ""}  ${metric.key}${location(metric.key)}${metric.flags.length ? `  [${metric.flags.join(", ")}]` : ""}`);
    }
  }
  const executed = own
    .filter((metric) => (metric.execution?.functionExecutionCount ?? 0) > 0)
    .sort((left, right) => (right.execution?.functionExecutionCount ?? 0) - (left.execution?.functionExecutionCount ?? 0))
    .slice(0, Math.min(limit, 5));
  if (executed.length > 0) {
    lines.push("", "Most executed own entities:");
    for (const metric of executed) lines.push(`  ${String(metric.execution?.functionExecutionCount).padStart(12)}×  ${metric.key}${location(metric.key)}`);
  }
  const allocators = own
    .filter((metric) => (metric.allocation?.selfBytes ?? 0) > 0)
    .sort((left, right) => (right.allocation?.selfBytes ?? 0) - (left.allocation?.selfBytes ?? 0))
    .slice(0, Math.min(limit, 5));
  if (allocators.length > 0) {
    lines.push("", "Top own allocators (self):");
    for (const metric of allocators) {
      const perCall = metric.estimates?.bytesPerCall;
      lines.push(`  ${((metric.allocation?.selfBytes ?? 0) / 1e6).toFixed(1).padStart(8)} MB${perCall ? `  ~${perCall.estimatedBytes} B/call (${perCall.confidence})` : ""}  ${metric.key}${location(metric.key)}`);
    }
  }
  if (result.outDir) lines.push("", `Wrote entities.json, metrics.json, edges.json, summary.json to ${result.outDir}`);
  return lines.join("\n");
}
