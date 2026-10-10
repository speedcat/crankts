import { performance } from "node:perf_hooks";

export interface MemorySnapshot {
  readonly rss: number;
  readonly heapUsed: number;
}

export interface StageTiming {
  readonly name: string;
  /** `stage` runs once with memory snapshots; `accumulated` sums many short calls and records time only. */
  readonly kind: "stage" | "accumulated";
  readonly calls: number;
  readonly durationMs: number;
  readonly before?: MemorySnapshot;
  readonly after?: MemorySnapshot;
  readonly rssDelta?: number;
  readonly heapUsedDelta?: number;
}

export interface StageTimingsReport {
  readonly schemaVersion: 1;
  readonly unit: { readonly time: "milliseconds"; readonly memory: "bytes" };
  readonly stages: readonly StageTiming[];
}

interface MutableAccumulated {
  calls: number;
  durationMs: number;
}

/**
 * Opt-in stage recorder for self-profiling (MVP-9a). Not part of the report schema.
 * Stages are recorded in completion order; nested stages use dotted names (e.g. `islands.wcc`).
 */
export class StageTimer {
  private readonly stages: StageTiming[] = [];
  private readonly accumulated = new Map<string, MutableAccumulated>();
  private readonly order: string[] = [];

  measure<T>(name: string, run: () => T): T {
    const before = snapshotMemory();
    const start = performance.now();
    const result = run();
    const durationMs = performance.now() - start;
    const after = snapshotMemory();
    this.stages.push({
      name,
      kind: "stage",
      calls: 1,
      durationMs,
      before,
      after,
      rssDelta: after.rss - before.rss,
      heapUsedDelta: after.heapUsed - before.heapUsed,
    });
    this.order.push(name);
    return result;
  }

  accumulate<T>(name: string, run: () => T): T {
    const start = performance.now();
    const result = run();
    const durationMs = performance.now() - start;
    let entry = this.accumulated.get(name);
    if (!entry) {
      entry = { calls: 0, durationMs: 0 };
      this.accumulated.set(name, entry);
      this.order.push(name);
    }
    entry.calls += 1;
    entry.durationMs += durationMs;
    return result;
  }

  /** Records an externally measured stage, e.g. CLI startup before the timer existed. */
  record(name: string, durationMs: number): void {
    this.stages.push({ name, kind: "stage", calls: 1, durationMs });
    this.order.push(name);
  }

  toJSON(): StageTimingsReport {
    const stageByName = new Map(this.stages.map((stage) => [stage.name, stage]));
    const stages = this.order.flatMap((name): StageTiming[] => {
      const stage = stageByName.get(name);
      if (stage) {
        return [stage];
      }
      const entry = this.accumulated.get(name);
      return entry ? [{ name, kind: "accumulated", calls: entry.calls, durationMs: entry.durationMs }] : [];
    });
    return {
      schemaVersion: 1,
      unit: { time: "milliseconds", memory: "bytes" },
      stages,
    };
  }
}

export function measureStage<T>(timer: StageTimer | undefined, name: string, run: () => T): T {
  return timer ? timer.measure(name, run) : run();
}

export function accumulateStage<T>(timer: StageTimer | undefined, name: string, run: () => T): T {
  return timer ? timer.accumulate(name, run) : run();
}

function snapshotMemory(): MemorySnapshot {
  const { rss, heapUsed } = process.memoryUsage();
  return { rss, heapUsed };
}
