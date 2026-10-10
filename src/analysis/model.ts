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
  | "REMOVE_SERIALIZED_SINK";
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
    readonly cpuProfileConfidence?: EvidenceConfidence;
    readonly cpuMatchedSamplePercent?: number;
    readonly sampledAllocationBytesSelf?: number;
    readonly sampledAllocationBytesTotal?: number;
    readonly allocationSelfSamplePercent?: number;
    readonly allocationInclusiveSamplePercent?: number;
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
  readonly selfCpuMicros: number;
  readonly totalCpuMicros: number;
  readonly samplePercent: number;
  readonly callCount: null;
}

export interface AllocationObservation {
  readonly sampledBytesSelf: number;
  readonly sampledBytesTotal: number;
  readonly sampledBytesSelfPercent: number;
  readonly sampledBytesTotalPercent: number;
  readonly sampleCountSelf: number;
  readonly sampleCountTotal: number;
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

export interface AnalysisResult {
  readonly projectName: string;
  readonly projectRoot: string;
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