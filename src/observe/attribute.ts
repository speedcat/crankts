import { resolve } from "node:path";
import { aggregateCoverage, sourceMapCatalog, type ExecutionSummary, type V8CoverageFile } from "./aggregate/coverage.js";
import { aggregateCpuProfile, cpuConfidence, type V8CpuProfile } from "./aggregate/cpu.js";
import { aggregateHeapProfile, type V8HeapProfile } from "./aggregate/heap.js";
import type { Confidence, CpuSummary, Entity, EntityFlag, EntityMetrics, HeapSummary, ObservedCallEdge } from "./model.js";
import { FrameResolver } from "./resolve/index.js";

/**
 * Attribution of one session's measurements to entities. All measurements share one resolver: the source maps Node
 * cached during the coverage run (`source-map-cache`) also map CPU and heap frames of in-memory transforms (tsx).
 */

export interface Attribution {
  readonly entities: Entity[];
  readonly metrics: EntityMetrics[];
  readonly edges: ObservedCallEdge[];
  readonly summary?: CpuSummary;
  readonly execution?: ExecutionSummary;
  readonly heap?: HeapSummary;
  /** CPU self time on own entities that coverage saw run 0 times (or not at all), as a share of own self time. */
  readonly sampledButNotExecutedRatio?: number;
  /** The same for allocated self bytes. */
  readonly allocatedButNotExecutedRatio?: number;
}

export interface AttributionInputs {
  readonly cpu?: { readonly profile: V8CpuProfile; readonly measurementId: string };
  readonly coverage?: { readonly file: V8CoverageFile; readonly measurementId: string };
  readonly heap?: { readonly profile: V8HeapProfile; readonly measurementId: string; readonly includesCollected?: boolean };
  /** Whether the measurements ran the same artifact (D3). Without agreement, estimates get confidence "none". */
  readonly artifactAgreement?: boolean;
}

const PSEUDO_KINDS = new Set(["dependency", "runtime", "native", "gc", "program", "idle", "unmapped"]);
const CONFIDENCE_ORDER: readonly Confidence[] = ["none", "low", "medium", "high"];

type MutableMetrics = { -readonly [K in keyof EntityMetrics]: EntityMetrics[K] };

export function attribute(root: string, inputs: AttributionInputs): Attribution {
  const resolver = new FrameResolver(resolve(root), inputs.coverage ? { sourceMaps: sourceMapCatalog(inputs.coverage.file) } : {});
  const cpu = inputs.cpu
    ? aggregateCpuProfile(inputs.cpu.profile, resolver, {
      measurementId: inputs.cpu.measurementId,
      isAsync: (key) => resolver.referencedEntities.get(key)?.source?.async === true,
      indexFlags: (key) => resolver.indexedFlags(key),
      entityAtLine: (url, line) => resolver.entityAtLine(url, line),
    })
    : undefined;
  const coverage = inputs.coverage ? aggregateCoverage(inputs.coverage.file, resolver, { measurementId: inputs.coverage.measurementId }) : undefined;
  const heap = inputs.heap
    ? aggregateHeapProfile(inputs.heap.profile, resolver, { measurementId: inputs.heap.measurementId, includesCollected: inputs.heap.includesCollected ?? true })
    : undefined;

  const isOwn = (key: string): boolean => {
    const kind = resolver.referencedEntities.get(key)?.kind;
    return kind !== undefined && !PSEUDO_KINDS.has(kind);
  };
  const byKey = new Map<string, MutableMetrics>();
  const order: string[] = [];
  const metricOf = (key: string): MutableMetrics => {
    let metric = byKey.get(key);
    if (!metric) {
      metric = { key, confidence: { cpu: "none", allocation: "none", execution: "none" }, flags: resolver.indexedFlags(key) as EntityFlag[] };
      byKey.set(key, metric);
      order.push(key);
    }
    return metric;
  };
  for (const metric of cpu?.metrics ?? []) {
    byKey.set(metric.key, { ...metric });
    order.push(metric.key);
  }

  if (heap) {
    const total = heap.summary.totalBytes;
    const sortedAllocations = [...heap.allocations].sort((left, right) => right[1].inclusiveBytes - left[1].inclusiveBytes || left[0].localeCompare(right[0]));
    for (const [key, allocation] of sortedAllocations) {
      if (allocation.inclusiveBytes <= 0) continue;
      const metric = metricOf(key);
      metric.allocation = {
        measurementId: heap.summary.measurementId,
        selfBytes: Math.round(allocation.selfBytes),
        inclusiveBytes: Math.round(allocation.inclusiveBytes),
        selfPct: total === 0 ? 0 : Math.round((allocation.selfBytes / total) * 10_000) / 100,
        samples: allocation.samples,
        inclusiveSamples: allocation.inclusiveSamples,
        includesCollected: heap.summary.includesCollected,
      };
      metric.confidence = { ...metric.confidence, allocation: cpuConfidence(allocation.inclusiveSamples) };
    }
  }

  if (coverage) {
    for (const key of order) {
      if (!isOwn(key)) continue;
      const metric = byKey.get(key) as MutableMetrics;
      const execution = coverage.executions.get(key);
      if (execution) {
        metric.execution = { measurementId: coverage.summary.measurementId, functionExecutionCount: execution.functionExecutionCount, hotRanges: execution.hotRanges };
        metric.flags = mergeFlags(metric.flags, execution.flags);
      }
      metric.confidence = { ...metric.confidence, execution: execution ? "high" : "none" };
    }
    const executedOnly = [...coverage.executions]
      .filter(([key, execution]) => !byKey.has(key) && execution.functionExecutionCount > 0)
      .sort((left, right) => right[1].functionExecutionCount - left[1].functionExecutionCount || left[0].localeCompare(right[0]));
    for (const [key, execution] of executedOnly) {
      const metric = metricOf(key);
      metric.execution = { measurementId: coverage.summary.measurementId, functionExecutionCount: execution.functionExecutionCount, hotRanges: execution.hotRanges };
      metric.confidence = { ...metric.confidence, execution: "high" };
      metric.flags = mergeFlags(metric.flags, execution.flags);
    }
  }

  // Estimates (§7.5): only with an exact count > 0, always with both inputs.
  const agreement = inputs.artifactAgreement ?? true;
  for (const metric of byKey.values()) {
    const count = metric.execution?.functionExecutionCount ?? 0;
    if (count <= 0 || !isOwn(metric.key)) continue;
    const estimates: NonNullable<EntityMetrics["estimates"]> = {
      ...(metric.cpu && metric.cpu.samples > 0
        ? {
          selfCpuPerCall: {
            estimatedNs: Math.round((metric.cpu.selfMs * 1e6) / count),
            cpuSamples: metric.cpu.samples,
            executionCount: count,
            confidence: agreement ? minConfidence(cpuConfidence(metric.cpu.samples), metric.confidence.execution) : "none",
          },
        }
        : {}),
      ...(metric.allocation && metric.allocation.samples > 0
        ? {
          bytesPerCall: {
            estimatedBytes: Math.round(metric.allocation.selfBytes / count),
            allocSamples: metric.allocation.samples,
            executionCount: count,
            confidence: agreement ? minConfidence(cpuConfidence(metric.allocation.samples), metric.confidence.execution) : "none",
          },
        }
        : {}),
    };
    if (estimates.selfCpuPerCall || estimates.bytesPerCall) metric.estimates = estimates;
  }

  const metrics = order.map((key) => byKey.get(key) as EntityMetrics);
  const notExecutedShare = (value: (metric: EntityMetrics) => number): number | undefined => {
    if (!coverage) return undefined;
    let ownTotal = 0;
    let notExecuted = 0;
    for (const metric of metrics) {
      const amount = value(metric);
      if (amount <= 0 || !isOwn(metric.key)) continue;
      ownTotal += amount;
      if ((metric.execution?.functionExecutionCount ?? 0) === 0) notExecuted += amount;
    }
    return ownTotal === 0 ? 0 : Math.round((notExecuted / ownTotal) * 10_000) / 10_000;
  };
  const sampledButNotExecutedRatio = cpu ? notExecutedShare((metric) => metric.cpu?.selfMs ?? 0) : undefined;
  const allocatedButNotExecutedRatio = heap ? notExecutedShare((metric) => metric.allocation?.selfBytes ?? 0) : undefined;

  const keys = new Set(order);
  const entities = [...resolver.referencedEntities.values()]
    .filter((entity) => keys.has(entity.identity.key))
    .sort((left, right) => left.identity.key.localeCompare(right.identity.key));
  return {
    entities,
    metrics,
    edges: cpu?.edges ?? [],
    ...(cpu ? { summary: cpu.summary } : {}),
    ...(coverage ? { execution: coverage.summary } : {}),
    ...(heap ? { heap: heap.summary } : {}),
    ...(sampledButNotExecutedRatio !== undefined ? { sampledButNotExecutedRatio } : {}),
    ...(allocatedButNotExecutedRatio !== undefined ? { allocatedButNotExecutedRatio } : {}),
  };
}

export function isOwnEntity(entity: Entity | undefined): boolean {
  return entity !== undefined && !PSEUDO_KINDS.has(entity.kind);
}

function minConfidence(left: Confidence, right: Confidence): Confidence {
  return CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(left), CONFIDENCE_ORDER.indexOf(right))] as Confidence;
}

function mergeFlags(left: readonly EntityFlag[], right: readonly EntityFlag[] | undefined): EntityFlag[] {
  return [...new Set([...left, ...(right ?? [])])].sort();
}
