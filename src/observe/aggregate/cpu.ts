import type { FrameResolver, ResolvedFrame, V8CallFrame } from "../resolve/index.js";
import type { CausedCpu, Confidence, CpuSummary, EntityFlag, EntityMetrics, ObservedCallEdge } from "../model.js";

/**
 * CPU aggregation (docs/observe-plan.md §7.2): self, inclusive, caused, and observed caller edges per entity from one
 * V8 `.cpuprofile`. Work is done per profile node (all samples of a node share its stack), which is equivalent to
 * the per-sample definition.
 */

export interface V8CpuProfileNode {
  readonly id: number;
  readonly callFrame: V8CallFrame;
  readonly children?: readonly number[];
  /** Self samples per 1-based line of the frame's script (`node --cpu-prof` records them). */
  readonly positionTicks?: readonly { readonly line: number; readonly ticks: number }[];
}

export interface V8CpuProfile {
  readonly nodes: readonly V8CpuProfileNode[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

export interface CpuAggregation {
  readonly metrics: EntityMetrics[];
  readonly edges: ObservedCallEdge[];
  readonly summary: CpuSummary;
}

export interface CpuAggregationOptions {
  readonly measurementId?: string;
  /** Packages kept in `causedByPackage` per entity. */
  readonly topPackages?: number;
  /** Whether an own entity is `async` (for `asyncTruncated`). */
  readonly isAsync?: (key: string) => boolean;
  /** Flags the entity index assigned (e.g. `anonymousOrdinal`). */
  readonly indexFlags?: (key: string) => readonly string[];
  /** The own entity a 1-based line of a script belongs to; enables the inlined-callee correction. */
  readonly entityAtLine?: (url: string, line: number) => string | undefined;
}

const TASK_QUEUE_FRAME = /^(?:processTicksAndRejections|runMicrotasks|processPromiseRejections)$/;

interface Accumulator {
  selfMicros: number;
  inclusiveMicros: number;
  selfSamples: number;
  inclusiveSamples: number;
  caused: { dependency: number; runtime: number; native: number; gc: number };
  causedByPackage: Map<string, number>;
  flags: Set<EntityFlag>;
}

interface EdgeAccumulator {
  micros: number;
  samples: number;
  via: ObservedCallEdge["via"];
}

export function validateCpuProfile(value: unknown, label: string): V8CpuProfile {
  const profile = value as Partial<V8CpuProfile> | null;
  if (!profile || typeof profile !== "object" || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples)
    || !Array.isArray(profile.timeDeltas) || profile.samples.length !== profile.timeDeltas.length
    || typeof profile.startTime !== "number" || typeof profile.endTime !== "number") {
    throw new Error(`Invalid V8 CPU profile '${label}': expected nodes, startTime, endTime, and aligned samples/timeDeltas.`);
  }
  return profile as V8CpuProfile;
}

/**
 * Sample weights as Chrome DevTools computes them: a sample lasts until the next one, and the last sample until
 * `endTime`. (`crankts analyze --profile` weights by `timeDeltas[i]` instead, so numbers can differ slightly.)
 */
export function sampleWeights(profile: V8CpuProfile): number[] {
  const count = profile.samples.length;
  const weights = new Array<number>(count);
  let timestamp = profile.startTime;
  for (let index = 0; index < count; index += 1) {
    timestamp += profile.timeDeltas[index] ?? 0;
    const next = index + 1 < count ? (profile.timeDeltas[index + 1] ?? 0) : profile.endTime - timestamp;
    weights[index] = Math.max(0, next);
  }
  return weights;
}

export function aggregateCpuProfile(profile: V8CpuProfile, resolver: FrameResolver, options: CpuAggregationOptions = {}): CpuAggregation {
  const measurementId = options.measurementId ?? "cpu-01";
  const topPackages = options.topPackages ?? 5;
  const nodeById = new Map<number, V8CpuProfileNode>();
  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    nodeById.set(node.id, node);
    for (const child of node.children ?? []) {
      if (!parentOf.has(child)) parentOf.set(child, node.id);
    }
  }

  // Weight and sample count per node.
  const weights = sampleWeights(profile);
  const nodeMicros = new Map<number, number>();
  const nodeSamples = new Map<number, number>();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const nodeId = profile.samples[index] as number;
    nodeMicros.set(nodeId, (nodeMicros.get(nodeId) ?? 0) + (weights[index] ?? 0));
    nodeSamples.set(nodeId, (nodeSamples.get(nodeId) ?? 0) + 1);
  }

  const stackCache = new Map<number, readonly ResolvedFrame[]>();
  const stackOf = (nodeId: number): readonly ResolvedFrame[] => {
    const cached = stackCache.get(nodeId);
    if (cached) return cached;
    const chain: number[] = [];
    for (let current: number | undefined = nodeId; current !== undefined; current = parentOf.get(current)) chain.push(current);
    chain.reverse();
    const frames: ResolvedFrame[] = [];
    for (const id of chain) {
      const node = nodeById.get(id);
      if (!node) continue;
      const frame = resolver.resolve(node.callFrame);
      if (frame.category !== "root") frames.push(frame);
    }
    stackCache.set(nodeId, frames);
    return frames;
  };
  const functionNameCache = new Map<number, readonly string[]>();
  const functionNamesOf = (nodeId: number): readonly string[] => {
    let names = functionNameCache.get(nodeId);
    if (!names) {
      names = [];
      for (let current: number | undefined = nodeId; current !== undefined; current = parentOf.get(current)) {
        (names as string[]).push(nodeById.get(current)?.callFrame.functionName ?? "");
      }
      (names as string[]).reverse();
      functionNameCache.set(nodeId, names);
    }
    return names;
  };

  const accumulators = new Map<string, Accumulator>();
  const accumulatorOf = (key: string): Accumulator => {
    let entry = accumulators.get(key);
    if (!entry) {
      entry = {
        selfMicros: 0, inclusiveMicros: 0, selfSamples: 0, inclusiveSamples: 0,
        caused: { dependency: 0, runtime: 0, native: 0, gc: 0 }, causedByPackage: new Map(), flags: new Set(),
      };
      accumulators.set(key, entry);
    }
    return entry;
  };
  const edges = new Map<string, EdgeAccumulator>();
  const inlined = new Set<string>();
  const byCategory = { own: 0, dependency: 0, runtime: 0, native: 0, gc: 0, program: 0, unmapped: 0 };
  let totalMicros = 0;
  let idleMicros = 0;
  let sampleCount = 0;
  let ownLeafMicros = 0;
  let unmappedOwnMicros = 0;

  const account = (nodeId: number, stack: readonly ResolvedFrame[], micros: number, samples: number): void => {
    const leaf = stack[stack.length - 1] as ResolvedFrame & { key: string };
    totalMicros += micros;
    sampleCount += samples;
    if (leaf.category === "own" || leaf.category === "unmapped") {
      ownLeafMicros += micros;
      if (leaf.category === "unmapped" || leaf.approximate) unmappedOwnMicros += micros;
    }
    if (leaf.category !== "root" && leaf.category !== "idle") byCategory[leaf.category] += micros;

    // Self.
    const leafEntry = accumulatorOf(leaf.key);
    leafEntry.selfMicros += micros;
    leafEntry.selfSamples += samples;

    // Inclusive: each distinct entity once.
    const seen = new Set<string>();
    for (const frame of stack) {
      if (!frame.key || seen.has(frame.key)) continue;
      seen.add(frame.key);
      const entry = accumulatorOf(frame.key);
      entry.inclusiveMicros += micros;
      entry.inclusiveSamples += samples;
      if (frame.approximate) entry.flags.add("unmappedFrames");
    }

    // Caused: foreign leaf time charged to the deepest own frame.
    if (leaf.category === "dependency" || leaf.category === "runtime" || leaf.category === "native" || leaf.category === "gc") {
      for (let position = stack.length - 2; position >= 0; position -= 1) {
        const frame = stack[position] as ResolvedFrame;
        if (frame.category !== "own" || !frame.key) continue;
        const entry = accumulatorOf(frame.key);
        entry.caused[leaf.category] += micros;
        if (leaf.category === "dependency" && leaf.package) {
          entry.causedByPackage.set(leaf.package, (entry.causedByPackage.get(leaf.package) ?? 0) + micros);
        }
        break;
      }
    }

    // Edges between consecutive own frames; foreign frames in between set `via`.
    const seenEdges = new Set<string>();
    let caller: string | undefined;
    let between: "direct" | "dependency" | "runtime" = "direct";
    for (const frame of stack) {
      if (frame.category === "own" && frame.key) {
        if (caller !== undefined) {
          const edgeKey = `${caller}\u0000${frame.key}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            const edge = edges.get(edgeKey) ?? { micros: 0, samples: 0, via: between };
            edge.micros += micros;
            edge.samples += samples;
            if (rank(between) > rank(edge.via)) edge.via = between;
            edges.set(edgeKey, edge);
          }
        }
        caller = frame.key;
        between = "direct";
      } else if (caller !== undefined) {
        if (frame.category === "dependency") between = "dependency";
        else if (between === "direct") between = "runtime";
      }
    }

    // asyncTruncated: the lowest own frame sits under runtime frames only, resumed from the task queue or async.
    const lowestOwn = stack.findIndex((frame) => frame.category === "own");
    if (lowestOwn >= 0) {
      const below = stack.slice(0, lowestOwn);
      const onlyRuntime = below.every((frame) => frame.category === "runtime" || frame.category === "native" || frame.category === "program");
      if (onlyRuntime) {
        const key = stack[lowestOwn]?.key as string;
        const names = functionNamesOf(nodeId).slice(1, 1 + lowestOwn);
        const fromTaskQueue = names.some((name) => TASK_QUEUE_FRAME.test(name));
        if (below.length === 0 || fromTaskQueue || options.isAsync?.(key)) accumulatorOf(key).flags.add("asyncTruncated");
      }
    }
  };

  for (const [nodeId, micros] of nodeMicros) {
    const samples = nodeSamples.get(nodeId) ?? 0;
    const stack = stackOf(nodeId);
    const leaf = stack[stack.length - 1];
    if (!leaf?.key) continue;
    if (leaf.category === "idle") {
      idleMicros += micros;
      continue;
    }
    // Inlined callees: V8 may report samples of an inlined function on the caller's frame, but keeps the callee's
    // lines in positionTicks. Ticks on lines of another own entity go to that entity as an inlined leaf.
    const node = nodeById.get(nodeId);
    const ticks = leaf.category === "own" && options.entityAtLine && node?.positionTicks ? node.positionTicks : undefined;
    const total = ticks?.reduce((sum, entry) => sum + entry.ticks, 0) ?? 0;
    if (!ticks || total <= 0) {
      account(nodeId, stack, micros, samples);
      continue;
    }
    const inlinedTicks = new Map<string, number>();
    let ownTicks = 0;
    for (const entry of ticks) {
      const key = options.entityAtLine?.(node?.callFrame.url ?? "", entry.line);
      if (key && key !== leaf.key && !key.endsWith("::(module)")) inlinedTicks.set(key, (inlinedTicks.get(key) ?? 0) + entry.ticks);
      else ownTicks += entry.ticks;
    }
    if (inlinedTicks.size === 0) {
      account(nodeId, stack, micros, samples);
      continue;
    }
    if (ownTicks > 0) account(nodeId, stack, (micros * ownTicks) / total, Math.round((samples * ownTicks) / total));
    for (const [key, count] of inlinedTicks) {
      inlined.add(key);
      account(nodeId, [...stack, { category: "own", key }], (micros * count) / total, Math.round((samples * count) / total));
    }
  }

  const ms = (micros: number): number => round(micros / 1000);
  const pct = (micros: number): number => (totalMicros === 0 ? 0 : round((micros / totalMicros) * 100));
  const metrics: EntityMetrics[] = [];
  for (const [key, entry] of accumulators) {
    if (entry.inclusiveMicros === 0 && entry.selfMicros === 0) continue;
    const caused: CausedCpu = {
      dependencyMs: ms(entry.caused.dependency),
      runtimeMs: ms(entry.caused.runtime),
      nativeMs: ms(entry.caused.native),
      gcMs: ms(entry.caused.gc),
    };
    const causedByPackage = [...entry.causedByPackage]
      .sort((left, right) => right[1] - left[1])
      .slice(0, topPackages);
    for (const flag of options.indexFlags?.(key) ?? []) entry.flags.add(flag as EntityFlag);
    if (inlined.has(key)) entry.flags.add("inlinedSuspected");
    metrics.push({
      key,
      cpu: {
        measurementId,
        selfMs: ms(entry.selfMicros),
        selfPct: pct(entry.selfMicros),
        inclusiveMs: ms(entry.inclusiveMicros),
        inclusivePct: pct(entry.inclusiveMicros),
        samples: entry.selfSamples,
        inclusiveSamples: entry.inclusiveSamples,
        caused,
        ...(causedByPackage.length > 0 ? { causedByPackage: Object.fromEntries(causedByPackage.map(([name, micros]) => [name, ms(micros)])) } : {}),
      },
      confidence: { cpu: cpuConfidence(entry.inclusiveSamples), allocation: "none", execution: "none" },
      flags: [...entry.flags].sort(),
    });
  }
  metrics.sort((left, right) => (right.cpu?.inclusiveMs ?? 0) - (left.cpu?.inclusiveMs ?? 0) || left.key.localeCompare(right.key));

  const inclusiveByKey = new Map(metrics.map((metric) => [metric.key, accumulators.get(metric.key)?.inclusiveMicros ?? 0]));
  const edgeList: ObservedCallEdge[] = [...edges].map(([edgeKey, edge]) => {
    const [callerKey, calleeKey] = edgeKey.split("\u0000") as [string, string];
    const calleeMicros = inclusiveByKey.get(calleeKey) ?? 0;
    return {
      callerKey,
      calleeKey,
      measurementId,
      sampledInclusiveMs: ms(edge.micros),
      samples: edge.samples,
      shareOfCallee: calleeMicros === 0 ? 0 : round(edge.micros / calleeMicros, 3),
      via: edge.via,
    };
  });
  edgeList.sort((left, right) => right.sampledInclusiveMs - left.sampledInclusiveMs || left.callerKey.localeCompare(right.callerKey) || left.calleeKey.localeCompare(right.calleeKey));

  const notes: string[] = [];
  if (idleMicros > 0) notes.push("Percentages exclude (idle).");
  return {
    metrics,
    edges: edgeList,
    summary: {
      measurementId,
      totalMs: ms(totalMicros),
      idleMs: ms(idleMicros),
      sampleCount,
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([name, micros]) => [name, ms(micros)])) as unknown as CpuSummary["byCategory"],
      unmappedOwnSampleRatio: ownLeafMicros === 0 ? 0 : round(unmappedOwnMicros / ownLeafMicros, 4),
      notes,
    },
  };
}

/** Starting thresholds from the plan; to be adjusted. */
export function cpuConfidence(samples: number): Confidence {
  if (samples >= 200) return "high";
  if (samples >= 50) return "medium";
  if (samples >= 10) return "low";
  return "none";
}

function rank(via: ObservedCallEdge["via"]): number {
  return via === "direct" ? 0 : via === "runtime" ? 1 : 2;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
