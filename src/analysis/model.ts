import type { CompilerSource } from "../compiler/compiler-facade.js";

export type FunctionId = string;

export type CallEdgeKind =
  | "DIRECT_RESOLVED"
  | "METHOD_RESOLVED"
  | "CONSTRUCTOR"
  | "CALLBACK"
  | "EXTERNAL"
  | "UNRESOLVED"
  | "DYNAMIC";

export type RuntimeBoundaryKind =
  | "LOCAL_DIRECT"
  | "LOCAL_METHOD"
  | "LOCAL_CALLBACK"
  | "LOCAL_CONSTRUCTOR"
  | "STDLIB_PURE"
  | "STDLIB_COLLECTION"
  | "STDLIB_RUNTIME"
  | "NODE_IO"
  | "DATABASE"
  | "NETWORK"
  | "PROCESS"
  | "EXTERNAL_TYPED"
  | "EXTERNAL_UNKNOWN"
  | "DYNAMIC"
  | "UNRESOLVED";

export type BoundaryRisk = "LOW" | "MEDIUM" | "HIGH";
export type EvidenceConfidence = "LOW" | "MEDIUM" | "HIGH";

export type RuntimeBoundaryCounts = Record<RuntimeBoundaryKind, number>;

export type BlockerCode =
  | "DYNAMIC_TYPE"
  | "DYNAMIC_PROPERTY_ACCESS"
  | "DYNAMIC_CALL"
  | "EVAL_USAGE"
  | "PROXY_USAGE"
  | "REFLECTION"
  | "CALLEE_NOT_SUPPORTED"
  | "NODE_RUNTIME_DEPENDENCY"
  | "UNKNOWN_EXTERNAL_CALL"
  | "UNRESOLVED_CALL";

export type EligibilityKind = "SUPPORTED" | "CONDITIONAL" | "BLOCKED";

export type Effect =
  | "PURE"
  | "ALLOCATES"
  | "READS_EXTERNAL_STATE"
  | "WRITES_EXTERNAL_STATE"
  | "FILESYSTEM_IO"
  | "NETWORK_IO"
  | "DATABASE_IO"
  | "PROCESS_CONTROL"
  | "MUTATES_ARGUMENT"
  | "MUTATES_LOCAL_STATE"
  | "MUTATES_GLOBAL_STATE"
  | "SPAWNS_ASYNC_WORK"
  | "UNKNOWN_SIDE_EFFECT";

export interface OpportunityScores {
  readonly cpu: number;
  readonly memory: number;
  readonly parallel: number;
}

export type ParallelismClass =
  | "PARALLEL_DOALL"
  | "PARALLEL_MAP_REDUCE"
  | "PARALLEL_PARTITIONABLE"
  | "PARALLEL_PIPELINE"
  | "PARALLEL_WITH_SYNCHRONIZATION"
  | "SEQUENTIAL_DEPENDENCE"
  | "UNKNOWN";

export type ParallelRegionKind = "LOOP" | "ASYNC_BATCH";
export type MemoryAccessMode = "READ" | "WRITE";
export type MemoryAccessScope = "ITERATION_LOCAL" | "PARTITIONED" | "SHARED" | "UNKNOWN";
export type DependenceKind = "RAW" | "WAR" | "WAW";

export interface MemoryAccess {
  readonly resource: string;
  readonly target: string;
  readonly mode: MemoryAccessMode;
  readonly scope: MemoryAccessScope;
  readonly line: number;
  readonly reduction?: boolean;
  readonly partitionKeyCandidate?: boolean;
}

export interface MemoryDependence {
  readonly kind: DependenceKind;
  readonly target: string;
  readonly loopCarried: boolean;
  readonly reason: string;
}

export interface ParallelismRegion {
  readonly kind: ParallelRegionKind;
  readonly line: number;
  readonly classification: ParallelismClass;
  readonly reads: readonly MemoryAccess[];
  readonly writes: readonly MemoryAccess[];
  readonly sharedWrites: readonly string[];
  readonly dependences: readonly MemoryDependence[];
  readonly externalEffects: readonly Effect[];
  readonly explanation: string;
}

export interface ParallelismAnalysis {
  readonly classification: ParallelismClass;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly sharedWrites: readonly string[];
  readonly dependences: readonly MemoryDependence[];
  readonly regions: readonly ParallelismRegion[];
}

export type PipelineWorkUnit = "FILE" | "CHUNK" | "RECORD" | "BATCH" | "UNKNOWN";
export type PipelineScheduling = "SERIAL" | "ASYNC_IO" | "WORKERS" | "UNKNOWN";
export type PipelineInputSharing = "READ_ONLY" | "SHARED_MUTABLE" | "UNKNOWN";
export type PipelineAggregation = "PER_UNIT" | "REDUCTION" | "ORDERED" | "SHARED_STATE" | "UNKNOWN";
export type PipelineIndependentWork = "CANDIDATE" | "NO" | "UNKNOWN";
export type PipelineEntryStatus = "RESOLVED" | "UNRESOLVED" | "AMBIGUOUS";
export type PipelineSinkAdapter = "SQLITE" | "BETTER_SQLITE3" | "NODE_SQLITE" | "GENERIC";
export type PipelineSinkWriterMode = "SINGLE_WRITER" | "MULTI_WRITER" | "UNKNOWN";
export type AccelerationLevel = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type OptimizationPotential = Exclude<AccelerationLevel, "UNKNOWN">;
export type PipelineOptimizationCategory = "ALGORITHMIC" | "DATA_LAYOUT";
export type AccelerationRecommendationAction =
  | "KEEP_TS"
  | "OPTIMIZE_ALGORITHM"
  | "PARALLELIZE"
  | "CHANGE_DATA_LAYOUT"
  | "MOVE_OFF_EVENT_LOOP"
  | "NATIVE_OFFLOAD"
  | "BATCH_IO"
  | "REMOVE_SERIALIZED_SINK"
  /** Recognition only (v0.2.6d): invariant or repeated work (compile/parse/factory) redone per call. */
  | "HOIST_INVARIANT_WORK";
export type PipelineResourceEffect =
  | "SERIALIZED_SINK"
  | "SHARED_EXTERNAL_STATE"
  | "TRANSACTIONAL_WRITE"
  | "ORDERED_COMMIT"
  | "SINGLE_WRITER_RESOURCE";

export interface PipelineOptimizationHint {
  readonly category: PipelineOptimizationCategory;
  readonly level: OptimizationPotential;
  readonly evidence: string;
}

export interface PipelineFunctionEntry {
  readonly file: string;
  readonly name: string;
}

export interface PipelineStageDescriptor {
  readonly id: string;
  readonly entry: PipelineFunctionEntry;
  readonly workUnit: PipelineWorkUnit;
  readonly scheduling: PipelineScheduling;
  readonly inputSharing: PipelineInputSharing;
  readonly aggregation: PipelineAggregation;
  readonly dependsOn: readonly string[];
  readonly sinkIds?: readonly string[];
  readonly optimizationHints?: readonly PipelineOptimizationHint[];
}

export interface PipelineSinkDescriptor {
  readonly id: string;
  readonly adapter: PipelineSinkAdapter;
  readonly writerMode?: PipelineSinkWriterMode;
  readonly transactional?: boolean;
  readonly orderedCommit?: boolean;
}

export interface PipelineDescriptor {
  readonly schemaVersion: 1;
  readonly workloadLabel?: string;
  readonly stages: readonly PipelineStageDescriptor[];
  readonly sinks: readonly PipelineSinkDescriptor[];
}

export interface PipelineFunctionReference {
  readonly id: FunctionId;
  readonly file: string;
  readonly name: string;
  readonly parallelism: Pick<ParallelismAnalysis, "classification">;
}

export interface PipelineStageAnalysis extends PipelineStageDescriptor {
  readonly entryStatus: PipelineEntryStatus;
  readonly functionId?: FunctionId;
  readonly independentWork: PipelineIndependentWork;
  readonly explanation: string;
}

export interface PipelineSinkAnalysis extends PipelineSinkDescriptor {
  readonly serialized: boolean | null;
  readonly resourceEffects: readonly PipelineResourceEffect[];
  readonly writerStageCount: number;
  readonly writerStageIds: readonly string[];
  readonly upstreamStageIds: readonly string[];
  readonly candidateUpstreamStageIds: readonly string[];
  readonly scalingRisk: BoundaryRisk | "UNKNOWN";
}

export interface PipelineAnalysis {
  readonly schemaVersion: 1;
  readonly workloadLabel?: string;
  readonly stages: readonly PipelineStageAnalysis[];
  readonly sinks: readonly PipelineSinkAnalysis[];
  readonly parallelCandidateStageCount: number;
  readonly serializedSinkCount: number;
  readonly serializationRisk: BoundaryRisk | "UNKNOWN";
}

export interface AccelerationRecommendation {
  readonly action: AccelerationRecommendationAction;
  readonly level: AccelerationLevel;
  readonly confidence: EvidenceConfidence | "UNKNOWN";
  readonly targetKind: "FUNCTION" | "STAGE" | "SINK";
  readonly targetId: string;
  readonly evidence: readonly string[];
  readonly explanation: string;
}

export interface FunctionAccelerationAssessment {
  readonly functionId: FunctionId;
  readonly name: string;
  readonly feasibility: {
    readonly eligibility: EligibilityKind;
    readonly nativeSuitability: number;
    readonly nativePriority: number;
    readonly boundaryRisk: BoundaryRisk | "UNKNOWN";
  };
  readonly staticOpportunity: OpportunityScores;
  readonly observedWorkload: {
    readonly hotness: AccelerationLevel;
    readonly selfCpuMicros?: number;
    readonly inclusiveCpuMicros?: number;
    readonly cpuSamplePercent?: number;
    /** Own JavaScript share (call-site attribution, v0.2.6d): self time minus N-API calls. Drives hotness. */
    readonly ownCpuSamplePercent?: number;
    /** Time this function causes outside its own JavaScript (dependencies, native, I/O, runtime). */
    readonly causedCpuSamplePercent?: number;
    readonly cpuProfileConfidence?: EvidenceConfidence;
    readonly cpuMatchedSamplePercent?: number;
    readonly sampledAllocationBytesSelf?: number;
    readonly sampledAllocationBytesTotal?: number;
    readonly allocationSelfSamplePercent?: number;
    readonly allocationInclusiveSamplePercent?: number;
    readonly allocationAttributableSamplePercent?: number;
    readonly allocationSampleCountTotal?: number;
    readonly allocationProfileConfidence?: EvidenceConfidence;
    readonly allocationMatchedSampledPercent?: number;
  };
  readonly optimizationPotential: {
    readonly algorithmic: AccelerationLevel;
    readonly parallel: AccelerationLevel;
    readonly nativeExecution: AccelerationLevel;
    readonly memoryLayout: AccelerationLevel;
  };
  readonly recommendations: readonly AccelerationRecommendation[];
}

export interface AccelerationAnalysis {
  readonly workloadLabel?: string;
  readonly functions: readonly FunctionAccelerationAssessment[];
  readonly pipelineRecommendations: readonly AccelerationRecommendation[];
}

export interface EligibilityMix {
  readonly supported: number;
  readonly conditional: number;
  readonly blocked: number;
}

export interface ArticulationImpact {
  readonly functionId: FunctionId;
  readonly impact: number;
  readonly componentsAfterRemoval: number;
  readonly largestRemainingPart: number;
  readonly internalCallers: number;
}

export interface CandidateIslandWarning {
  readonly code: "SHARED_HELPER_ARTICULATION";
  readonly functionId: FunctionId;
  readonly message: string;
}

export interface Blocker {
  readonly code: BlockerCode;
  readonly message: string;
  readonly disposition: "conditional" | "blocked";
  readonly line: number;
}

export type Eligibility =
  | { readonly kind: "SUPPORTED" }
  | { readonly kind: "CONDITIONAL"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "BLOCKED"; readonly blockers: readonly Blocker[] };

export interface CallEdge {
  readonly from: FunctionId;
  readonly to?: FunctionId;
  readonly kind: CallEdgeKind;
  readonly boundaryKind: RuntimeBoundaryKind;
  readonly callee: string;
  readonly line: number;
  readonly column: number;
}

export interface FunctionAnalysis {
  readonly id: FunctionId;
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly eligibility: Eligibility;
  readonly suitability: number;
  readonly opportunities: OpportunityScores;
  readonly parallelism: ParallelismAnalysis;
  readonly nativePriority: number;
  readonly directEffects: readonly Effect[];
  readonly effects: readonly Effect[];
  readonly calls: readonly CallEdge[];
  readonly observedCpu?: CpuProfileObservation;
  readonly observedAllocation?: AllocationObservation;
  /** HOIST_INVARIANT_WORK candidates (v0.2.6d, recognition only); computed for profiled functions. */
  readonly hoistCandidates?: readonly HoistCandidate[];
}

/**
 * A call that builds reusable state (a compiled matcher, a regex, a parser or resolver instance, …) on every
 * execution. STATIC_INVARIANT: its inputs are module constants, imports, readonly instance fields, or
 * literals, so it can be computed once. LOOP_INVARIANT: inputs do not change inside the enclosing loop.
 * PARAM_DEPENDENT: inputs come from parameters; hoisting needs DYNAMICALLY_REPEATED evidence (the same
 * inputs recur across calls), measured by input-signature profiling.
 */
export interface HoistCandidate {
  readonly line: number;
  readonly column: number;
  readonly callee: string;
  /** Why the call is considered a builder of reusable state. */
  readonly kind: "REGEXP" | "RETURNS_FUNCTION" | "PACKAGE_INSTANCE" | "COMPILE_LIKE_DEPENDENCY";
  readonly invariance: "STATIC_INVARIANT" | "LOOP_INVARIANT" | "PARAM_DEPENDENT" | "VARIANT";
  readonly inLoop: boolean;
  /**
   * The call's own profiled cost (percent of runtime): the compile-like time under its dependency entry, the
   * entry's time, or a project callee's inclusive time (an upper bound). Undefined if unknown.
   */
  readonly atStakePercent?: number;
  readonly compileLikePercent?: number;
  /** Input-signature profile: calls, distinct argument fingerprints, and reuse ratio per argument path. */
  readonly repetition?: InputRepetition;
}

export interface InputRepetition {
  readonly calls: number;
  readonly distinctSignatures: number;
  /** 1 − distinct/calls over the whole argument list (0 for a single call). */
  readonly reuseRatio: number;
  /** Best reuse ratio over substantial argument paths (fingerprint ≥ 200 chars: pattern lists, sources), e.g. `args[1].ignore`. */
  readonly bestPath?: { readonly path: string; readonly distinct: number; readonly reuseRatio: number };
  /** Calls whose inputs carry values, not only object identities (no arguments, buffers, class instances). */
  readonly contentCalls?: number;
  /** Identity overlap between collections in the arguments: share of B's elements that are the same objects as in A. */
  readonly identity?: readonly { readonly pair: string; readonly meanOverlap: number; readonly meanElements: number; readonly calls: number }[];
  /** Other probed sites that received the same argument content (duplicate processing across call sites). */
  readonly sharedWith?: readonly { readonly site: string; readonly distinct: number; readonly shareOfDistinct: number }[];
}

export interface CandidateIsland {
  readonly id: number;
  readonly status: "SUPPORTED" | "CONDITIONAL";
  readonly suitability: number;
  readonly opportunities: OpportunityScores;
  readonly nativePriority: number;
  readonly score: number;
  readonly members: readonly FunctionId[];
  readonly internalEdges: number;
  readonly rawEntryEdges: number;
  readonly rawExitEdges: number;
  readonly entryEdges: number;
  readonly exitEdges: number;
  readonly effectiveEntryEdges: number;
  readonly effectiveExitEdges: number;
  readonly boundaryKinds: RuntimeBoundaryCounts;
  readonly boundaryCostUnits: number;
  readonly boundaryRisk: BoundaryRisk;
  readonly boundaryRatio: number;
  readonly eligibilityMix: EligibilityMix;
  readonly boundaryEligibilityMix: EligibilityMix;
  readonly articulationCount: number;
  readonly largestArticulationImpact: ArticulationImpact | null;
  readonly sizePenalty: number;
  readonly warnings: readonly CandidateIslandWarning[];
  readonly observedCpu?: CpuProfileObservation;
}

export interface CpuProfileObservation {
  /** Raw V8 self time; includes time inside N-API calls, which have no frame of their own. */
  readonly selfCpuMicros: number;
  readonly totalCpuMicros: number;
  readonly samplePercent: number;
  readonly callCount: null;
  /** Call-site attribution (v0.2.6d): everything this function is the innermost analyzed frame of. */
  readonly callSite?: CallSiteObservation;
}

/**
 * Where the time a project function is responsible for goes (v0.2.6d). Every profile sample is billed to
 * the innermost analyzed function on its stack:
 * - FUNCTION_SELF: the function's own JavaScript, including builtins and regexes it runs directly
 * - EXTERNAL_DEPENDENCY: JavaScript (and regexes) of packages it calls
 * - EXTERNAL_NATIVE: native addons, either N-API calls made on its own lines or native frames under addon packages
 * - IO: fs, net, and process bindings
 * - RUNTIME: other Node internals and wasm
 * - UNANALYZED_PROJECT: project code the analysis did not match
 */
export type AttributionTarget = "FUNCTION_SELF" | "EXTERNAL_DEPENDENCY" | "EXTERNAL_NATIVE" | "IO" | "RUNTIME" | "UNANALYZED_PROJECT";

export interface CallSiteObservation {
  /** All time attributed to this function as the innermost analyzed frame (own plus caused). */
  readonly attributedMicros: number;
  readonly attributedPercent: number;
  /** Time outside the function's own JavaScript that it caused (dependencies, native, I/O, runtime). */
  readonly causedMicros: number;
  readonly causedPercent: number;
  readonly byTarget: Readonly<Partial<Record<AttributionTarget, number>>>;
  /** Largest external origins (package, `node`, or `(native)` under a package) with their target. */
  readonly topExternal: readonly { readonly origin: string; readonly target: AttributionTarget; readonly micros: number; readonly percent: number }[];
  /**
   * The functions this one calls directly into (first frame below it that is not its own code), with the
   * time spent under them and the part under compile-like frames (`parse*`, `compile*`, `makeRe`, `toRegex`,
   * `scan*`, `tokenize*`, …): the runtime evidence for HOIST_INVARIANT_WORK at call sites into dependencies.
   */
  readonly entries?: readonly CallSiteEntry[];
  /**
   * Profile-weighted caller paths (v0.2.6e): the analyzed functions above this one on the sampled stacks,
   * innermost first, up to three levels, with the share of this call site's attributed time.
   */
  readonly callerPaths?: readonly { readonly path: readonly FunctionId[]; readonly percentOfSite: number }[];
}

export interface CallSiteEntry {
  readonly origin: string;
  readonly functionName: string;
  readonly micros: number;
  readonly percent: number;
  readonly compileLikeMicros: number;
  readonly compileLikePercent: number;
}

export interface CpuAttributionSummary {
  /** Share of samples with an analyzed function on their stack. */
  readonly attributedPercent: number;
  readonly byTarget: Readonly<Partial<Record<AttributionTarget, number>>>;
  /** Samples without any analyzed frame (startup, module loading, GC, idle), in percent. */
  readonly unattributedPercent: number;
  /** Raw self time of project frames that was spent in N-API calls on their own lines, in percent. */
  readonly nativeAddonSelfPercent: number;
}

export interface AllocationObservation {
  readonly sampledBytesSelf: number;
  readonly sampledBytesTotal: number;
  readonly sampledBytesSelfPercent: number;
  readonly sampledBytesTotalPercent: number;
  readonly sampleCountSelf: number;
  readonly sampleCountTotal: number;
  /**
   * Bytes for which this function is the nearest analyzed frame and no frame in between belongs to
   * an external package or Node's module loader: its own allocations plus runtime/builtin callees.
   * Excludes bytes that pass through other analyzed functions (orchestrators), dependencies, or `require`.
   */
  readonly sampledBytesAttributable?: number;
  readonly sampledBytesAttributablePercent?: number;
  readonly sampleCountAttributable?: number;
}

export interface CpuProfileSummary {
  readonly file: string;
  readonly totalSampleMicros: number;
  readonly matchedSampleMicros: number;
  readonly matchedSamplePercent: number;
  readonly sampleCount: number;
  readonly matchedSampleCount: number;
  readonly timeUnit: "microseconds";
  readonly confidence: EvidenceConfidence;
  /**
   * Sample time grouped by the origin of the sampled (leaf) frame. `unmatched*` only counts
   * samples whose stack contains no analyzed function, so external hotspots stay attributable.
   */
  readonly origins?: readonly CpuProfileOrigin[];
  readonly attribution?: CpuAttributionSummary;
}

export type CpuProfileOriginKind =
  | "PROJECT"
  | "PACKAGE"
  | "NODE"
  | "NATIVE"
  | "GC"
  | "PROGRAM"
  | "IDLE"
  | "OTHER";

export interface CpuProfileOrigin {
  readonly origin: string;
  readonly kind: CpuProfileOriginKind;
  readonly selfMicros: number;
  readonly selfPercent: number;
  readonly unmatchedMicros: number;
  readonly unmatchedPercent: number;
}

export interface AllocationProfileSummary {
  readonly file: string;
  readonly totalSampledBytes: number;
  readonly matchedSampledBytes: number;
  readonly matchedSampledPercent: number;
  readonly sampleCount: number;
  readonly matchedSampleCount: number;
  readonly unit: "bytes";
  readonly confidence: EvidenceConfidence;
}

export interface WorkspaceAnalysisSummary {
  readonly projectConfigsLoaded: number;
  readonly skippedReferences: readonly string[];
}

export interface AnalysisResult {
  readonly projectName: string;
  readonly projectRoot: string;
  readonly workspace?: WorkspaceAnalysisSummary;
  readonly typescript: {
    readonly version: string;
    readonly source: CompilerSource;
  };
  readonly cpuProfile?: CpuProfileSummary;
  readonly allocationProfile?: AllocationProfileSummary;
  readonly pipeline?: PipelineAnalysis;
  readonly workloadLabel?: string;
  readonly acceleration: AccelerationAnalysis;
  readonly functions: readonly FunctionAnalysis[];
  readonly candidateIslands: readonly CandidateIsland[];
}