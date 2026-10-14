import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Entity, EntityMetrics, ExecutionRange, ObservationSession, ObservedCallEdge } from "../model.js";
import { SCHEMA_VERSION, sessionFileSchemas, type SessionFile } from "../schema.js";

/**
 * Query layer (docs/observe-plan.md §9): the only layer the CLI and the MCP server build on, so both answer the same
 * questions with the same data. Answers are compact by design: small limits, rounded numbers, project-relative paths,
 * and every answer carries `sessionId` and the session's quality level.
 */

export interface LoadedSession {
  readonly sessionId: string;
  readonly dir: string;
  readonly session: ObservationSession;
  readonly entities: ReadonlyMap<string, Entity>;
  readonly metrics: ReadonlyMap<string, EntityMetrics>;
  /** In the order they are stored (by inclusive CPU time). */
  readonly metricList: readonly EntityMetrics[];
  readonly edges: readonly ObservedCallEdge[];
}

export interface SessionListing {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly sha: string | null;
  readonly dirty: boolean;
  readonly quality: string;
  readonly command: string;
  readonly measurements: readonly string[];
}

export type HotMetric = "self" | "inclusive" | "alloc" | "executions" | "cpu-per-call";
export type Scope = "own" | "all";

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

const PSEUDO_KINDS = new Set(["dependency", "runtime", "native", "gc", "program", "idle", "unmapped"]);

export class QueryError extends Error {
  constructor(message: string, readonly candidates: readonly string[] = []) {
    super(message);
  }
}

/** Sessions under `<root>/.crankts/sessions` (or an explicit directory), newest first. */
export class SessionStore {
  readonly dir: string;
  private readonly cache = new Map<string, { mtimeMs: number; session: LoadedSession }>();

  constructor(options: { readonly root?: string; readonly sessionsDir?: string } = {}) {
    this.dir = resolve(options.sessionsDir ?? join(options.root ?? process.cwd(), ".crankts", "sessions"));
  }

  ids(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => existsSync(join(this.dir, name, "session.json")))
      .sort()
      .reverse();
  }

  list(): SessionListing[] {
    return this.ids().map((sessionId) => {
      const session = readJson<ObservationSession>(join(this.dir, sessionId, "session.json"));
      return {
        sessionId,
        createdAt: session.createdAt,
        sha: session.git.sha ? session.git.sha.slice(0, 10) : null,
        dirty: session.git.dirty,
        quality: session.quality.level,
        command: session.workload.command.join(" "),
        measurements: session.measurements.map((measurement) => measurement.kind),
      };
    });
  }

  /** The given session, or the newest one with attribution output. */
  load(sessionId?: string): LoadedSession {
    const ids = this.ids();
    if (ids.length === 0) throw new QueryError(`No sessions in ${this.dir}. Run: crankts observe -- <cmd...>`);
    const id = sessionId ?? ids.find((candidate) => existsSync(join(this.dir, candidate, "metrics.json")));
    if (!id || !ids.includes(id)) throw new QueryError(`Unknown session '${sessionId ?? ""}'.`, ids.slice(0, 10));
    const dir = join(this.dir, id);
    const mtimeMs = statSync(join(dir, "session.json")).mtimeMs;
    const cached = this.cache.get(id);
    if (cached && cached.mtimeMs === mtimeMs) return cached.session;
    if (!existsSync(join(dir, "metrics.json"))) throw new QueryError(`Session '${id}' has no attribution output (see its session.json errors).`);
    const session = readValidated<ObservationSession>(dir, "session.json");
    const entities = readValidated<Entity[]>(dir, "entities.json");
    const metricList = readValidated<EntityMetrics[]>(dir, "metrics.json");
    const loaded: LoadedSession = {
      sessionId: id,
      dir,
      session,
      entities: new Map(entities.map((entity) => [entity.identity.key, entity])),
      metrics: new Map(metricList.map((metric) => [metric.key, metric])),
      metricList,
      edges: readValidated<ObservedCallEdge[]>(dir, "edges.json"),
    };
    this.cache.set(id, { mtimeMs, session: loaded });
    return loaded;
  }

  /** Deletes all but the newest `keep` sessions; returns the deleted ids. */
  gc(keep: number): string[] {
    const removed = this.ids().slice(Math.max(0, keep));
    for (const id of removed) rmSync(join(this.dir, id), { recursive: true, force: true });
    return removed;
  }
}

/** Reads a session file and checks it against its schema; older or foreign sessions get a clear error. */
function readValidated<T>(dir: string, file: SessionFile): T {
  const value = readJson<unknown>(join(dir, file));
  if (file === "session.json") {
    const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (version !== SCHEMA_VERSION) throw new QueryError(`${join(dir, file)} has schemaVersion ${JSON.stringify(version)}; this CrankTS reads ${SCHEMA_VERSION}. Re-run crankts observe.`);
  }
  const result = sessionFileSchemas[file].safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new QueryError(`${join(dir, file)} does not match schema ${SCHEMA_VERSION} (${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}).`);
  }
  return value as T;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

function header(loaded: LoadedSession): { sessionId: string; quality: string } {
  return { sessionId: loaded.sessionId, quality: loaded.session.quality.level };
}

function isOwn(loaded: LoadedSession, key: string): boolean {
  const kind = loaded.entities.get(key)?.kind;
  return kind !== undefined && !PSEUDO_KINDS.has(kind);
}

function at(loaded: LoadedSession, key: string): string | undefined {
  const source = loaded.entities.get(key)?.source;
  return source ? `${source.file}:${source.line}` : undefined;
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? DEFAULT_LIMIT)));
}

function round(value: number | undefined, digits = 1): number | undefined {
  if (value === undefined) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Drops undefined fields so answers stay small. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/** Exact key; a unique key suffix (`normalizeToken`, `amplified.ts::normalizeToken`); or `file:line`. */
export function resolveKey(loaded: LoadedSession, query: string): string {
  if (loaded.entities.has(query)) return query;
  const location = /^(.+?):(\d+)$/.exec(query);
  if (location && !query.includes("::")) {
    const [, file, lineText] = location as unknown as [string, string, string];
    const line = Number(lineText);
    const containing = [...loaded.entities.values()]
      .filter((entity) => entity.source && (entity.source.file === file || entity.source.file.endsWith(`/${file}`)) && entity.kind !== "module-init"
        && entity.source.line <= line && line <= entity.source.endLine)
      .sort((left, right) => ((left.source?.endLine ?? 0) - (left.source?.line ?? 0)) - ((right.source?.endLine ?? 0) - (right.source?.line ?? 0)));
    if (containing[0]) return containing[0].identity.key;
    throw new QueryError(`No observed entity contains ${query}.`);
  }
  const suffix = [...loaded.entities.keys()].filter((key) => key.endsWith(`::${query}`) || key.endsWith(`/${query}`) || key.endsWith(`.${query}`) || key.endsWith(`#${query}`));
  if (suffix.length === 1) return suffix[0] as string;
  if (suffix.length > 1) throw new QueryError(`'${query}' is ambiguous.`, suffix.slice(0, 10));
  const partial = [...loaded.entities.keys()].filter((key) => key.toLowerCase().includes(query.toLowerCase()));
  throw new QueryError(`No entity matches '${query}'.`, partial.slice(0, 10));
}

export function getSummary(loaded: LoadedSession): Record<string, unknown> {
  const own = loaded.metricList.filter((metric) => isOwn(loaded, metric.key));
  const top = (value: (metric: EntityMetrics) => number | undefined, limit = 5) => own
    .filter((metric) => (value(metric) ?? 0) > 0)
    .sort((left, right) => (value(right) ?? 0) - (value(left) ?? 0))
    .slice(0, limit)
    .map((metric) => compact({ key: metric.key, at: at(loaded, metric.key), value: round(value(metric)) }));
  const session = loaded.session;
  const summary = readSummaryTotals(loaded);
  return compact({
    ...header(loaded),
    qualityReasons: session.quality.reasons.length > 0 ? session.quality.reasons : undefined,
    createdAt: session.createdAt,
    command: session.workload.command.join(" "),
    git: session.git.sha ? `${session.git.sha.slice(0, 10)}${session.git.dirty ? " (dirty)" : ""}` : undefined,
    measurements: session.measurements.map((measurement) => compact({
      id: measurement.measurementId,
      kind: measurement.kind,
      wallMs: measurement.wallMs,
      errors: measurement.errors.length > 0 ? measurement.errors : undefined,
    })),
    cpu: summary.cpu,
    execution: summary.execution,
    heap: summary.heap,
    topSelfMs: top((metric) => metric.cpu?.selfMs),
    topInclusiveMs: top((metric) => metric.cpu?.inclusiveMs),
    topCausedMs: top((metric) => causedTotal(metric)),
    topExecutions: top((metric) => metric.execution?.functionExecutionCount),
    topAllocMB: top((metric) => (metric.allocation ? metric.allocation.selfBytes / 1e6 : undefined)),
    notes: "Measurements are separate runs; per-call values are estimates (see get_function_metrics). Keys are <package>::<module>::<name>.",
  });
}

function readSummaryTotals(loaded: LoadedSession): { cpu?: unknown; execution?: unknown; heap?: unknown } {
  const path = join(loaded.dir, "summary.json");
  if (!existsSync(path)) return {};
  const summary = readJson<Record<string, unknown>>(path);
  const cpu = summary["cpu"] as { totalMs: number; idleMs: number; byCategory: Record<string, number>; unmappedOwnSampleRatio: number } | undefined;
  const execution = summary["execution"] as { executedEntities: number; unmatchedExecutedFunctions: number } | undefined;
  const heap = summary["heap"] as { totalBytes: number; byCategory: Record<string, number> } | undefined;
  return compact({
    cpu: cpu ? { totalMs: round(cpu.totalMs), idleMs: round(cpu.idleMs), byLeafCategoryMs: roundRecord(cpu.byCategory), unmappedOwnSampleRatio: cpu.unmappedOwnSampleRatio } : undefined,
    execution: execution ? { executedEntities: execution.executedEntities, unmatchedExecutedFunctions: execution.unmatchedExecutedFunctions } : undefined,
    heap: heap ? { totalMB: round(heap.totalBytes / 1e6), byCategoryMB: roundRecord(Object.fromEntries(Object.entries(heap.byCategory).map(([name, bytes]) => [name, bytes / 1e6]))) } : undefined,
  });
}

function roundRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value > 0).map(([name, value]) => [name, round(value) as number]));
}

export function getHotFunctions(loaded: LoadedSession, options: { readonly by?: HotMetric; readonly limit?: number; readonly scope?: Scope } = {}): Record<string, unknown> {
  const by = options.by ?? "self";
  const scope = options.scope ?? "own";
  const value = (metric: EntityMetrics): number | undefined => {
    switch (by) {
      case "self": return metric.cpu?.selfMs;
      case "inclusive": return metric.cpu?.inclusiveMs;
      case "alloc": return metric.allocation?.selfBytes;
      case "executions": return metric.execution?.functionExecutionCount;
      case "cpu-per-call": return metric.estimates?.selfCpuPerCall?.estimatedNs;
    }
  };
  const rows = loaded.metricList
    .filter((metric) => (scope === "all" || isOwn(loaded, metric.key)) && (value(metric) ?? 0) > 0)
    // Per-call estimates without any confidence (too few samples, or runs on different artifacts) are not ranked.
    .filter((metric) => by !== "cpu-per-call" || metric.estimates?.selfCpuPerCall?.confidence !== "none")
    .sort((left, right) => (value(right) ?? 0) - (value(left) ?? 0))
    .slice(0, clampLimit(options.limit))
    .map((metric) => hotRow(loaded, metric, by));
  return { ...header(loaded), by, scope, rows };
}

/** key, location, the ranked metric, the execution count for context, and the confidence that goes with the metric. */
function hotRow(loaded: LoadedSession, metric: EntityMetrics, by: HotMetric): Record<string, unknown> {
  const executions = metric.execution?.functionExecutionCount;
  const base = { key: metric.key, at: at(loaded, metric.key) };
  switch (by) {
    case "self":
      return compact({ ...base, selfMs: round(metric.cpu?.selfMs), selfPct: round(metric.cpu?.selfPct), executions, confidence: metric.confidence.cpu });
    case "inclusive":
      return compact({ ...base, inclusiveMs: round(metric.cpu?.inclusiveMs), inclusivePct: round(metric.cpu?.inclusivePct), executions, confidence: metric.confidence.cpu });
    case "alloc":
      return compact({ ...base, allocMB: round((metric.allocation?.selfBytes ?? 0) / 1e6, 2), executions, confidence: metric.confidence.allocation });
    case "executions":
      return compact({ ...base, executions, selfMs: round(metric.cpu?.selfMs), confidence: metric.confidence.execution });
    case "cpu-per-call": {
      const estimate = metric.estimates?.selfCpuPerCall;
      return compact({ ...base, selfCpuPerCallNs: estimate?.estimatedNs, executions, selfMs: round(metric.cpu?.selfMs), confidence: estimate?.confidence });
    }
  }
}

export function getHotAllocators(loaded: LoadedSession, options: { readonly limit?: number } = {}): Record<string, unknown> {
  const rows = loaded.metricList
    .filter((metric) => isOwn(loaded, metric.key) && (metric.allocation?.selfBytes ?? 0) > 0)
    .sort((left, right) => (right.allocation?.selfBytes ?? 0) - (left.allocation?.selfBytes ?? 0))
    .slice(0, clampLimit(options.limit))
    .map((metric) => compact({
      key: metric.key,
      at: at(loaded, metric.key),
      selfMB: round((metric.allocation?.selfBytes ?? 0) / 1e6, 2),
      inclusiveMB: round((metric.allocation?.inclusiveBytes ?? 0) / 1e6, 2),
      executions: metric.execution?.functionExecutionCount,
      bytesPerCall: metric.estimates?.bytesPerCall?.estimatedBytes,
      confidence: metric.estimates?.bytesPerCall?.confidence ?? metric.confidence.allocation,
    }));
  return { ...header(loaded), includesCollectedObjects: true, rows };
}

export function getHotRanges(loaded: LoadedSession, options: { readonly limit?: number } = {}): Record<string, unknown> {
  const ranges: { key: string; file: string; range: ExecutionRange }[] = [];
  for (const metric of loaded.metricList) {
    const file = loaded.entities.get(metric.key)?.source?.file;
    if (!file) continue;
    for (const range of metric.execution?.hotRanges ?? []) ranges.push({ key: metric.key, file, range });
  }
  const rows = ranges
    .sort((left, right) => right.range.rangeExecutionCount - left.range.rangeExecutionCount)
    .slice(0, clampLimit(options.limit))
    .map(({ key, file, range }) => ({
      key,
      at: `${file}:${range.startLine}-${range.endLine}`,
      count: range.rangeExecutionCount,
      entityExecutions: loaded.metrics.get(key)?.execution?.functionExecutionCount,
    }));
  return { ...header(loaded), rows };
}

export function getFunctionMetrics(loaded: LoadedSession, query: string): Record<string, unknown> {
  const key = resolveKey(loaded, query);
  const entity = loaded.entities.get(key);
  const metric = loaded.metrics.get(key);
  const callers = edgesFor(loaded, key, "callers", 5);
  const callees = edgesFor(loaded, key, "callees", 5);
  return compact({
    ...header(loaded),
    key,
    kind: entity?.kind,
    at: at(loaded, key),
    endLine: entity?.source?.endLine,
    async: entity?.source?.async,
    nameSource: entity?.identity.anchor.nameSource,
    parentKey: entity?.identity.anchor.parentKey,
    cpu: metric?.cpu ? compact({
      selfMs: round(metric.cpu.selfMs),
      selfPct: round(metric.cpu.selfPct),
      inclusiveMs: round(metric.cpu.inclusiveMs),
      inclusivePct: round(metric.cpu.inclusivePct),
      samples: metric.cpu.samples,
      inclusiveSamples: metric.cpu.inclusiveSamples,
      causedMs: nonZero({ dependency: metric.cpu.caused.dependencyMs, runtime: metric.cpu.caused.runtimeMs, native: metric.cpu.caused.nativeMs, gc: metric.cpu.caused.gcMs }),
      causedByPackageMs: metric.cpu.causedByPackage,
    }) : undefined,
    execution: metric?.execution ? { count: metric.execution.functionExecutionCount, hotRanges: metric.execution.hotRanges.map((range) => ({ lines: `${range.startLine}-${range.endLine}`, count: range.rangeExecutionCount })) } : undefined,
    allocation: metric?.allocation ? { selfMB: round(metric.allocation.selfBytes / 1e6, 2), inclusiveMB: round(metric.allocation.inclusiveBytes / 1e6, 2), samples: metric.allocation.samples, includesCollectedObjects: metric.allocation.includesCollected } : undefined,
    estimates: metric?.estimates,
    confidence: metric?.confidence,
    flags: metric && metric.flags.length > 0 ? metric.flags : undefined,
    topCallers: callers.length > 0 ? callers : undefined,
    topCallees: callees.length > 0 ? callees : undefined,
  });
}

function nonZero(record: Record<string, number>): Record<string, number> | undefined {
  const kept = roundRecord(record);
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function edgesFor(loaded: LoadedSession, key: string, direction: "callers" | "callees", limit: number): Record<string, unknown>[] {
  return loaded.edges
    .filter((edge) => (direction === "callers" ? edge.calleeKey === key : edge.callerKey === key))
    .sort((left, right) => right.sampledInclusiveMs - left.sampledInclusiveMs)
    .slice(0, limit)
    .map((edge) => {
      const other = direction === "callers" ? edge.callerKey : edge.calleeKey;
      return compact({
        key: other,
        at: at(loaded, other),
        ms: round(edge.sampledInclusiveMs),
        shareOfCallee: round(edge.shareOfCallee, 2),
        via: edge.via === "direct" ? undefined : edge.via,
        executions: direction === "callees" ? loaded.metrics.get(other)?.execution?.functionExecutionCount : undefined,
      });
    });
}

export function getCallers(loaded: LoadedSession, query: string, options: { readonly limit?: number } = {}): Record<string, unknown> {
  const key = resolveKey(loaded, query);
  return { ...header(loaded), key, callers: edgesFor(loaded, key, "callers", clampLimit(options.limit)), note: "Sampled time in this entity's subtree under each caller (CPU run)." };
}

export function getCallees(loaded: LoadedSession, query: string, options: { readonly limit?: number } = {}): Record<string, unknown> {
  const key = resolveKey(loaded, query);
  return { ...header(loaded), key, callees: edgesFor(loaded, key, "callees", clampLimit(options.limit)) };
}

/** Dependency time charged to the own code that called into it; for one entity, or by package across the session. */
export function getDependencyCosts(loaded: LoadedSession, query?: string, options: { readonly limit?: number } = {}): Record<string, unknown> {
  const limit = clampLimit(options.limit);
  if (query) {
    const key = resolveKey(loaded, query);
    const cpu = loaded.metrics.get(key)?.cpu;
    return compact({
      ...header(loaded),
      key,
      causedMs: cpu ? nonZero({ dependency: cpu.caused.dependencyMs, runtime: cpu.caused.runtimeMs, native: cpu.caused.nativeMs, gc: cpu.caused.gcMs }) : undefined,
      causedByPackageMs: cpu?.causedByPackage,
    });
  }
  const packages = new Map<string, { totalMs: number; causers: { key: string; ms: number }[] }>();
  for (const metric of loaded.metricList) {
    for (const [name, ms] of Object.entries(metric.cpu?.causedByPackage ?? {})) {
      const entry = packages.get(name) ?? { totalMs: 0, causers: [] };
      entry.totalMs += ms;
      entry.causers.push({ key: metric.key, ms });
      packages.set(name, entry);
    }
  }
  const rows = [...packages]
    .sort((left, right) => right[1].totalMs - left[1].totalMs)
    .slice(0, limit)
    .map(([name, entry]) => {
      const nativeAddon = [...loaded.entities.values()].find((entity) => entity.dependency?.package === name)?.dependency?.nativeAddon;
      return compact({
        package: name,
        nativeAddon: nativeAddon || undefined,
        selfMs: round(loaded.metrics.get(`${name}::*`)?.cpu?.selfMs),
        causedMs: round(entry.totalMs),
        topCausers: entry.causers.sort((left, right) => right.ms - left.ms).slice(0, 3).map((causer) => ({ key: causer.key, at: at(loaded, causer.key), ms: round(causer.ms) })),
      });
    });
  return { ...header(loaded), rows, note: "causedMs: dependency leaf time charged to the deepest own frame above it (top packages per entity)." };
}

export function listSessions(store: SessionStore, options: { readonly limit?: number } = {}): Record<string, unknown> {
  return { sessions: store.list().slice(0, clampLimit(options.limit)) };
}

function causedTotal(metric: EntityMetrics): number | undefined {
  const caused = metric.cpu?.caused;
  return caused ? caused.dependencyMs + caused.runtimeMs + caused.nativeMs + caused.gcMs : undefined;
}
