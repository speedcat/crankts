import { entityWithHeaderAt, positionOf, type IndexedEntity, type ModuleIndex } from "../entity/index.js";
import type { EntityFlag, ExecutionRange } from "../model.js";
import type { CachedSourceMap, FrameResolver } from "../resolve/index.js";

/**
 * Coverage aggregation (docs/observe-plan.md §7.3): exact function execution counts and the hottest block ranges per
 * entity from one NODE_V8_COVERAGE file (precise count coverage, as Node collects it).
 *
 * Matching: V8 reports a function at its own position, which lies in the entity's header (from its start to the start
 * of its body). V8 functions that land elsewhere (transpiler helpers, class-field initializers) match nothing; when
 * several land in the same header, the closest one wins and its count is used, never a sum.
 */

export interface V8CoverageRange {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly count: number;
}

export interface V8FunctionCoverage {
  readonly functionName: string;
  readonly ranges: readonly V8CoverageRange[];
  readonly isBlockCoverage: boolean;
}

export interface V8ScriptCoverage {
  readonly scriptId: string;
  readonly url: string;
  readonly functions: readonly V8FunctionCoverage[];
}

export interface V8CoverageFile {
  readonly result: readonly V8ScriptCoverage[];
  readonly "source-map-cache"?: Readonly<Record<string, CachedSourceMap>>;
}

export interface EntityExecution {
  readonly functionExecutionCount: number;
  readonly hotRanges: readonly ExecutionRange[];
  readonly flags: readonly EntityFlag[];
}

export interface ExecutionSummary {
  readonly measurementId: string;
  readonly ownScripts: number;
  readonly ownFunctions: number;
  /** V8 functions matched to an entity header. */
  readonly matchedFunctions: number;
  /** Executed (count > 0) V8 functions that matched no entity: helpers, initializers, or mapping gaps. */
  readonly unmatchedExecutedFunctions: number;
  readonly executedEntities: number;
}

export interface CoverageAggregation {
  readonly executions: ReadonlyMap<string, EntityExecution>;
  readonly summary: ExecutionSummary;
}

export function validateCoverageFile(value: unknown, label: string): V8CoverageFile {
  const file = value as Partial<V8CoverageFile> | null;
  if (!file || typeof file !== "object" || !Array.isArray(file.result)) {
    throw new Error(`Invalid V8 coverage file '${label}': expected a result array.`);
  }
  return file as V8CoverageFile;
}

/** The source maps Node cached during the coverage run, by script URL. */
export function sourceMapCatalog(file: V8CoverageFile): Map<string, CachedSourceMap> {
  const catalog = new Map<string, CachedSourceMap>();
  for (const [url, entry] of Object.entries(file["source-map-cache"] ?? {})) {
    if (entry && typeof entry === "object" && entry.data && Array.isArray(entry.data.sources)) catalog.set(url, entry);
  }
  return catalog;
}

interface Candidate {
  readonly module: ModuleIndex;
  readonly entity: IndexedEntity;
  readonly url: string;
  readonly fn: V8FunctionCoverage;
  readonly distance: number;
}

export function aggregateCoverage(
  file: V8CoverageFile,
  resolver: FrameResolver,
  options: { readonly measurementId?: string; readonly topRanges?: number } = {},
): CoverageAggregation {
  const measurementId = options.measurementId ?? "cov-01";
  const topRanges = options.topRanges ?? 5;
  const best = new Map<string, Candidate>();
  const candidateCount = new Map<string, number>();
  let ownScripts = 0;
  let ownFunctions = 0;
  let matchedFunctions = 0;
  let unmatchedExecuted = 0;

  for (const script of file.result) {
    if (!script.url || !resolver.isOwnUrl(script.url)) continue;
    ownScripts += 1;
    script.functions.forEach((fn, index) => {
      const range = fn.ranges[0];
      if (!range) return;
      ownFunctions += 1;
      let candidate: Candidate | undefined;
      if (index === 0 && range.startOffset === 0 && fn.functionName === "") {
        // The script's top-level code: the module-init entity of the source it maps to.
        const location = resolver.locate(resolver.canonicalUrl(script.url), -1, -1);
        if (location) candidate = { module: location.module, entity: location.module.entities[0] as IndexedEntity, url: script.url, fn, distance: 0 };
      } else {
        const location = resolver.locateOffset(script.url, range.startOffset);
        if (location?.offset !== undefined && !location.approximate) {
          const entity = entityWithHeaderAt(location.module, location.offset);
          if (entity) candidate = { module: location.module, entity, url: script.url, fn, distance: location.offset - entity.start };
        }
      }
      if (!candidate) {
        if (range.count > 0) unmatchedExecuted += 1;
        return;
      }
      matchedFunctions += 1;
      const key = candidate.entity.key;
      candidateCount.set(key, (candidateCount.get(key) ?? 0) + 1);
      const previous = best.get(key);
      if (!previous || candidate.distance < previous.distance
        || (candidate.distance === previous.distance && range.count > (previous.fn.ranges[0]?.count ?? 0))) {
        best.set(key, candidate);
      }
    });
  }

  const executions = new Map<string, EntityExecution>();
  for (const [key, candidate] of best) {
    resolver.register(candidate.module, candidate.entity);
    const flags: EntityFlag[] = [];
    if ((candidateCount.get(key) ?? 0) > 1 && candidate.entity.kind !== "module-init") flags.push("inlinedSuspected");
    executions.set(key, {
      functionExecutionCount: candidate.fn.ranges[0]?.count ?? 0,
      hotRanges: hotRanges(candidate, resolver, topRanges),
      flags,
    });
  }
  return {
    executions,
    summary: {
      measurementId,
      ownScripts,
      ownFunctions,
      matchedFunctions,
      unmatchedExecutedFunctions: unmatchedExecuted,
      executedEntities: [...executions.values()].filter((execution) => execution.functionExecutionCount > 0).length,
    },
  };
}

function hotRanges(candidate: Candidate, resolver: FrameResolver, limit: number): ExecutionRange[] {
  const blocks = candidate.fn.ranges.slice(1).filter((range) => range.count > 0);
  const sorted = [...blocks].sort((left, right) => right.count - left.count || left.startOffset - right.startOffset).slice(0, limit * 2);
  const ranges: ExecutionRange[] = [];
  for (const range of sorted) {
    if (ranges.length >= limit) break;
    const start = resolver.locateOffset(candidate.url, range.startOffset);
    const end = resolver.locateOffset(candidate.url, Math.max(range.startOffset, range.endOffset - 1));
    if (start?.offset === undefined || end?.offset === undefined || start.module !== candidate.module || end.module !== candidate.module) continue;
    const from = positionOf(candidate.module, start.offset);
    const to = positionOf(candidate.module, end.offset);
    ranges.push({ kind: "block", startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column, rangeExecutionCount: range.count });
  }
  return ranges;
}
