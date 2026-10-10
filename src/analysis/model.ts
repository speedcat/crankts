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
  readonly nativePriority: number;
  readonly directEffects: readonly Effect[];
  readonly effects: readonly Effect[];
  readonly calls: readonly CallEdge[];
  readonly observedCpu?: CpuProfileObservation;
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

export interface AnalysisResult {
  readonly projectName: string;
  readonly projectRoot: string;
  readonly typescript: {
    readonly version: string;
    readonly source: CompilerSource;
  };
  readonly cpuProfile?: CpuProfileSummary;
  readonly functions: readonly FunctionAnalysis[];
  readonly candidateIslands: readonly CandidateIsland[];
}