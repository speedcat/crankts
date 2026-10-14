/**
 * CrankTS Observe data model (docs/observe-plan.md §4). M0 covers entities, CPU metrics, and observed call edges.
 * Everything here is measured or derived mechanically; nothing is interpreted.
 */

export type Confidence = "high" | "medium" | "low" | "none";

export type NameSource = "declared" | "inferred" | "context" | "ordinal";

export interface EntityIdentity {
  /** `<package>::<package-relative module path>::<qualifiedName>`; readable and valid for this revision only. */
  readonly key: string;
  readonly fingerprint: { readonly body: string; readonly shape: string };
  readonly anchor: {
    readonly package: string;
    /** Project-relative path. */
    readonly module: string;
    readonly qualifiedName: string;
    readonly nameSource: NameSource;
    readonly parentKey?: string;
  };
}

export type OwnEntityKind =
  | "function" | "method" | "getter" | "setter" | "constructor"
  | "arrow" | "function-expression" | "module-init";

export type PseudoEntityKind = "dependency" | "runtime" | "native" | "gc" | "program" | "idle" | "unmapped";

export type EntityKind = OwnEntityKind | PseudoEntityKind;

export interface Entity {
  readonly identity: EntityIdentity;
  readonly kind: EntityKind;
  readonly source?: {
    readonly file: string;
    /** 1-based. */
    readonly line: number;
    /** 1-based. */
    readonly column: number;
    readonly endLine: number;
    readonly language: "typescript" | "javascript";
    readonly async?: boolean;
  };
  readonly dependency?: { readonly package: string; readonly nativeAddon: boolean };
}

export interface CausedCpu {
  dependencyMs: number;
  runtimeMs: number;
  nativeMs: number;
  gcMs: number;
}

export type EntityFlag = "asyncTruncated" | "unmappedFrames" | "anonymousOrdinal" | "inlinedSuspected";

export interface EntityMetrics {
  readonly key: string;
  readonly cpu?: {
    readonly measurementId: string;
    readonly selfMs: number;
    readonly selfPct: number;
    readonly inclusiveMs: number;
    readonly inclusivePct: number;
    /** Samples with this entity as the leaf. */
    readonly samples: number;
    /** Samples with this entity anywhere on the stack. */
    readonly inclusiveSamples: number;
    readonly caused: CausedCpu;
    /** Top packages by caused time, in ms. */
    readonly causedByPackage?: Readonly<Record<string, number>>;
  };
  readonly allocation?: {
    readonly measurementId: string;
    /** Sampled allocated bytes (V8's estimate from samples), including objects collected before the run ended. */
    readonly selfBytes: number;
    readonly inclusiveBytes: number;
    readonly selfPct: number;
    /** Allocation samples with this entity as the leaf / anywhere on the stack. */
    readonly samples: number;
    readonly inclusiveSamples: number;
    readonly includesCollected: boolean;
  };
  /**
   * Derived values (docs/observe-plan.md §7.5, D5): always with both inputs. They combine separate runs (D2), so they
   * are estimates; confidence is "none" when the artifacts of those runs disagree or the count is 0.
   */
  readonly estimates?: {
    readonly selfCpuPerCall?: { readonly estimatedNs: number; readonly cpuSamples: number; readonly executionCount: number; readonly confidence: Confidence };
    readonly bytesPerCall?: { readonly estimatedBytes: number; readonly allocSamples: number; readonly executionCount: number; readonly confidence: Confidence };
  };
  readonly execution?: {
    readonly measurementId: string;
    /** Exact count from precise V8 coverage. */
    readonly functionExecutionCount?: number;
    /** Top block ranges by count. */
    readonly hotRanges: readonly ExecutionRange[];
  };
  readonly confidence: { readonly cpu: Confidence; readonly allocation: Confidence; readonly execution: Confidence };
  readonly flags: readonly EntityFlag[];
}

export interface ExecutionRange {
  readonly kind: "function" | "block";
  /** 1-based TypeScript positions. */
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly rangeExecutionCount: number;
}

export interface ObservedCallEdge {
  /** Nearest own frame above the callee. */
  readonly callerKey: string;
  readonly calleeKey: string;
  readonly measurementId: string;
  /** Time in the callee's subtree under this caller. */
  readonly sampledInclusiveMs: number;
  readonly samples: number;
  /** 0..1 of the callee's inclusive time. */
  readonly shareOfCallee: number;
  /** Whether foreign frames sit between caller and callee. */
  readonly via: "direct" | "dependency" | "runtime";
}

export interface CpuSummary {
  readonly measurementId: string;
  /** Sampled time without `(idle)`. */
  readonly totalMs: number;
  readonly idleMs: number;
  readonly sampleCount: number;
  readonly byCategory: Readonly<Record<"own" | "dependency" | "runtime" | "native" | "gc" | "program" | "unmapped", number>>;
  /** Share of own-code samples (leaf in the project) that did not map to a TypeScript entity. */
  readonly unmappedOwnSampleRatio: number;
  readonly notes: readonly string[];
}

export interface HeapSummary {
  readonly measurementId: string;
  /** Sampled allocated bytes across the primary process. */
  readonly totalBytes: number;
  readonly sampleCount: number;
  readonly byCategory: Readonly<Record<"own" | "dependency" | "runtime" | "native" | "program" | "unmapped", number>>;
  readonly includesCollected: boolean;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly threadId: number;
  readonly role: "primary" | "launcher" | "worker" | "child" | "unknown";
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  readonly resourceUsage?: { readonly userCpuMs: number; readonly systemCpuMs: number; readonly maxRssKb: number };
  readonly eventLoop?: { readonly utilization: number; readonly delayP50Ms?: number; readonly delayP99Ms?: number };
  readonly exitCode?: number;
  readonly wallMs?: number;
  /** Relative to the session's raw/ directory. */
  readonly rawFiles: readonly string[];
}

export interface ArtifactFingerprint {
  /** Project-relative path of the primary process's `argv[1]`. */
  readonly entrypoint: string;
  /** sha256 of the entry file at exit. */
  readonly entrypointHash: string;
  /** Project-relative source map path → sha256. */
  readonly sourceMapHashes: Readonly<Record<string, string>>;
  /** Project-relative path → sha256 of every own module that appears in the profile (generated JS or stripped TS). */
  readonly moduleHashes: Readonly<Record<string, string>>;
  readonly loader: "node" | "node-strip-types" | "tsx" | "ts-node" | "other";
}

export interface Measurement {
  readonly measurementId: string;
  readonly kind: "cpu" | "coverage" | "heap";
  readonly config: Readonly<Record<string, string | number>>;
  readonly processes: readonly ProcessInfo[];
  readonly artifact?: ArtifactFingerprint;
  /** Relative to the session's raw/ directory. */
  readonly rawFiles: readonly string[];
  readonly wallMs: number;
  readonly exit: { readonly code: number | null; readonly signal: string | null; readonly timedOut: boolean };
  readonly errors: readonly string[];
  readonly overheadNote?: string;
  /** With `--baseline`: this run's wall time against an uninstrumented run of the same command. */
  readonly overhead?: { readonly baselineWallMs: number; readonly wallRatio: number };
}

export interface SessionQuality {
  readonly level: "high" | "medium" | "low";
  readonly reasons: readonly string[];
  readonly checks: {
    readonly artifactAgreement: boolean;
    readonly sampledButNotExecutedRatio?: number;
    readonly allocatedButNotExecutedRatio?: number;
    readonly unmappedOwnSampleRatio?: number;
    readonly repeatCountAgreement?: number;
  };
}

export interface ObservationSession {
  readonly schemaVersion: "0.3";
  readonly sessionId: string;
  readonly createdAt: string;
  readonly workload: { readonly command: readonly string[]; readonly cwd: string; readonly root: string; readonly workloadId?: string };
  readonly git: { readonly sha: string | null; readonly dirty: boolean; readonly dirtyHash?: string };
  readonly environment: { readonly node: string; readonly v8: string; readonly os: string; readonly cpu: string; readonly cores: number };
  readonly measurements: readonly Measurement[];
  readonly quality: SessionQuality;
  /** CrankTS's own cost: attribution time after the runs, and the uninstrumented wall time with `--baseline`. */
  readonly timing?: { readonly attributionMs: number; readonly baselineWallMs?: number };
}
