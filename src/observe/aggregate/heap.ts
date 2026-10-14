import type { HeapSummary } from "../model.js";
import type { FrameResolver, ResolvedFrame, V8CallFrame } from "../resolve/index.js";

/**
 * Heap aggregation (docs/observe-plan.md §7.4): sampled allocated bytes per entity from a sampling heap profile.
 * `selfSize` is V8's estimate of the bytes allocated at a node (samples scaled by the sampling interval). The leaf
 * entity gets self bytes; every distinct entity on the path gets inclusive bytes.
 */

export interface V8HeapProfileNode {
  readonly id: number;
  readonly callFrame: V8CallFrame;
  readonly selfSize: number;
  readonly children?: readonly V8HeapProfileNode[];
}

export interface V8HeapProfile {
  readonly head: V8HeapProfileNode;
  readonly samples?: readonly { readonly size: number; readonly nodeId: number; readonly ordinal?: number }[];
}

export interface EntityAllocation {
  selfBytes: number;
  inclusiveBytes: number;
  samples: number;
  inclusiveSamples: number;
}

export interface HeapAggregation {
  readonly allocations: ReadonlyMap<string, EntityAllocation>;
  readonly summary: HeapSummary;
}

export function validateHeapProfile(value: unknown, label: string): V8HeapProfile {
  const profile = value as Partial<V8HeapProfile> | null;
  if (!profile || typeof profile !== "object" || !profile.head || typeof profile.head !== "object") {
    throw new Error(`Invalid V8 heap profile '${label}': expected a head node.`);
  }
  return profile as V8HeapProfile;
}

export function aggregateHeapProfile(
  profile: V8HeapProfile,
  resolver: FrameResolver,
  options: { readonly measurementId?: string; readonly includesCollected?: boolean } = {},
): HeapAggregation {
  const samplesByNode = new Map<number, number>();
  for (const sample of profile.samples ?? []) samplesByNode.set(sample.nodeId, (samplesByNode.get(sample.nodeId) ?? 0) + 1);

  const allocations = new Map<string, EntityAllocation>();
  const allocationOf = (key: string): EntityAllocation => {
    let entry = allocations.get(key);
    if (!entry) {
      entry = { selfBytes: 0, inclusiveBytes: 0, samples: 0, inclusiveSamples: 0 };
      allocations.set(key, entry);
    }
    return entry;
  };
  const byCategory = { own: 0, dependency: 0, runtime: 0, native: 0, program: 0, unmapped: 0 };
  let totalBytes = 0;
  let sampleCount = 0;

  // Iterative depth-first walk; `onPath` counts how often each entity is on the current path (recursion-safe).
  const onPath = new Map<string, number>();
  const stack: { node: V8HeapProfileNode; frame: ResolvedFrame; leaving: boolean }[] = [{ node: profile.head, frame: resolver.resolve(profile.head.callFrame), leaving: false }];
  while (stack.length > 0) {
    const entry = stack.pop() as { node: V8HeapProfileNode; frame: ResolvedFrame; leaving: boolean };
    const key = entry.frame.key;
    if (entry.leaving) {
      if (key) {
        const count = (onPath.get(key) ?? 1) - 1;
        if (count === 0) onPath.delete(key);
        else onPath.set(key, count);
      }
      continue;
    }
    if (key) onPath.set(key, (onPath.get(key) ?? 0) + 1);
    stack.push({ ...entry, leaving: true });

    const bytes = entry.node.selfSize;
    const samples = samplesByNode.get(entry.node.id) ?? 0;
    if (key && (bytes > 0 || samples > 0)) {
      totalBytes += bytes;
      sampleCount += samples;
      const category = entry.frame.category;
      const bucket = category === "own" || category === "dependency" || category === "runtime" || category === "native" || category === "unmapped" ? category : "program";
      byCategory[bucket] += bytes;
      const leaf = allocationOf(key);
      leaf.selfBytes += bytes;
      leaf.samples += samples;
      for (const pathKey of onPath.keys()) {
        const inclusive = allocationOf(pathKey);
        inclusive.inclusiveBytes += bytes;
        inclusive.inclusiveSamples += samples;
      }
    }
    for (const child of entry.node.children ?? []) stack.push({ node: child, frame: resolver.resolve(child.callFrame), leaving: false });
  }

  return {
    allocations,
    summary: {
      measurementId: options.measurementId ?? "heap-01",
      totalBytes,
      sampleCount,
      byCategory,
      includesCollected: options.includesCollected ?? true,
    },
  };
}
