import type {
  AccelerationRecommendationAction,
  AnalysisResult,
  AttributionTarget,
  CpuProfileOriginKind,
  EligibilityKind,
  FunctionId,
} from "./model.js";

/**
 * Acceleration coverage (generalization study). Answers "how much of the profiled runtime could CrankTS's
 * patterns reach?" on profiled CPU, never on lines of code. The unit is the call site: the time an
 * analyzed function is responsible for as the innermost analyzed frame, own JavaScript plus what it causes
 * in dependencies, native addons, I/O, and the runtime (`CallSiteObservation`, v0.2.6d). Transformations
 * such as hoisting or prepared state act there even when the time is spent in a dependency.
 *
 * Evidence levels (fifth review round), each a share of runtime:
 *   human-plausible → human-evidence-supported → CrankTS-recognized → CrankTS-transformable → validated-beneficial
 * and two recalls: automated recognition recall (CrankTS found the concrete case) and pattern-family recall
 * (CrankTS has the optimization family at all).
 */

export type Transformability = "PLAUSIBLE" | "EVIDENCE_SUPPORTED" | "VALIDATED_BENEFICIAL" | "NOT_TRANSFORMABLE";

export interface CoverageAnnotation {
  readonly transformability: Transformability;
  readonly confidence?: "LOW" | "MEDIUM" | "HIGH";
  /** Pattern families in the review's vocabulary (HOIST_INVARIANT_WORK, PREPARE_STATE, PACK_DATA, BATCH, ...). */
  readonly patterns?: readonly string[];
  /** Share (0..1) of the call site's attributed time the transformation addresses (default 1). */
  readonly fraction?: number;
  /** What would move PLAUSIBLE to EVIDENCE_SUPPORTED. */
  readonly missingEvidence?: readonly string[];
  /** How the precondition was shown (inspection, measurement). */
  readonly evidence?: string;
  readonly note: string;
}

/** Pattern families CrankTS has implemented transformations or backends for (KWX: prepared state/hoisting; graph: packing, batching; native kernels). */
export const KNOWN_PATTERN_FAMILIES: ReadonlySet<string> = new Set([
  "HOIST_INVARIANT_WORK", "PREPARE_STATE", "PACK_DATA", "CHANGE_DATA_LAYOUT", "BATCH",
  // Execution strategy: lowering to the Kernel IR and a native kernel (v0.2.x).
  "NATIVE_KERNEL",
]);

/** Outcome of running today's fail-closed passes on a function (dry run, nothing is emitted). */
export interface SupportProbe {
  readonly accepted: readonly string[];
  /** First diagnostic per rejecting pass, e.g. `lowering: ...`. */
  readonly rejected: readonly string[];
}

export interface CoverageCallSite {
  readonly functionId: FunctionId;
  readonly name: string;
  readonly attributedPercent: number;
  readonly ownPercent: number;
  readonly byTarget: Readonly<Partial<Record<AttributionTarget, number>>>;
  readonly topExternal: readonly { readonly origin: string; readonly target: AttributionTarget; readonly percent: number }[];
  readonly eligibility: EligibilityKind;
  readonly advisor: readonly string[];
  readonly recognized: boolean;
  readonly support?: SupportProbe;
  readonly annotation?: CoverageAnnotation;
}

export interface CoverageBucket {
  readonly kind: CpuProfileOriginKind;
  readonly origin: string;
  readonly micros: number;
  readonly percent: number;
}

export interface CoverageFunnelStep {
  readonly step: string;
  readonly percent: number;
}

export interface CoverageReport {
  readonly totalMicros: number;
  /** Self time by origin of the sampled frame (project, each package, node, native, GC, program, idle). */
  readonly buckets: readonly CoverageBucket[];
  /** Runtime by attribution target (call-site attribution), plus the unattributed rest. */
  readonly attribution: Readonly<Partial<Record<AttributionTarget | "UNATTRIBUTED", number>>>;
  readonly callSites: readonly CoverageCallSite[];
  readonly funnel: readonly CoverageFunnelStep[];
  /** Weighted by runtime over human-plausible call sites; undefined without plausible sites. */
  readonly automatedRecognitionRecall?: number;
  readonly patternFamilyRecall?: number;
  /** Recognized call sites that review also finds plausible, weighted by runtime (false positives lower it). */
  readonly recognitionPrecision?: number;
}

export interface CoverageOptions {
  /** Call sites covering this share of attributed time (default 0.8), at most `maxCallSites` (default 25). */
  readonly share?: number;
  readonly maxCallSites?: number;
  readonly probe?: (functionId: FunctionId) => SupportProbe | undefined;
  readonly annotations?: Readonly<Record<string, CoverageAnnotation>>;
}

/** Advisor actions that mean "transform or move this": CrankTS recognized an opportunity. */
const RECOGNIZING_ACTIONS: ReadonlySet<AccelerationRecommendationAction> = new Set([
  "OPTIMIZE_ALGORITHM", "PARALLELIZE", "CHANGE_DATA_LAYOUT", "MOVE_OFF_EVENT_LOOP", "NATIVE_OFFLOAD", "BATCH_IO", "HOIST_INVARIANT_WORK",
]);

export function computeCoverage(result: AnalysisResult, options: CoverageOptions = {}): CoverageReport {
  const profile = result.cpuProfile;
  if (!profile?.attribution) {
    throw new Error("coverage needs an attached CPU profile with call-site attribution");
  }
  const total = profile.totalSampleMicros;
  const percent = (micros: number): number => (total > 0 ? round((micros / total) * 100) : 0);
  const buckets: CoverageBucket[] = (profile.origins ?? [])
    .map((origin) => ({ kind: origin.kind, origin: origin.origin, micros: origin.selfMicros, percent: percent(origin.selfMicros) }))
    .sort((left, right) => right.micros - left.micros);

  const assessments = new Map(result.acceleration.functions.map((assessment) => [assessment.functionId, assessment]));
  const ranked = result.functions
    .filter((fn) => (fn.observedCpu?.callSite?.attributedMicros ?? 0) > 0)
    .sort((left, right) => (right.observedCpu?.callSite?.attributedMicros ?? 0) - (left.observedCpu?.callSite?.attributedMicros ?? 0));
  const attributedMicros = ranked.reduce((sum, fn) => sum + (fn.observedCpu?.callSite?.attributedMicros ?? 0), 0);
  const share = options.share ?? 0.8;
  const maxCallSites = options.maxCallSites ?? 25;
  const callSites: CoverageCallSite[] = [];
  let covered = 0;
  for (const fn of ranked) {
    if (callSites.length >= maxCallSites || covered >= attributedMicros * share) break;
    const site = fn.observedCpu?.callSite;
    if (!site) continue;
    covered += site.attributedMicros;
    const recommendations = assessments.get(fn.id)?.recommendations ?? [];
    // Recognized: a transformation/native recommendation of at least MEDIUM level, not a LOW-confidence hint.
    const recognized = recommendations.some((recommendation) => (
      RECOGNIZING_ACTIONS.has(recommendation.action) && ["VERY_HIGH", "HIGH", "MEDIUM"].includes(recommendation.level)
      && recommendation.confidence !== "LOW"
    ));
    const support = options.probe?.(fn.id);
    const annotation = options.annotations?.[fn.id];
    callSites.push({
      functionId: fn.id,
      name: fn.name,
      attributedPercent: site.attributedPercent,
      ownPercent: site.byTarget.FUNCTION_SELF ?? 0,
      byTarget: site.byTarget,
      topExternal: site.topExternal.map((entry) => ({ origin: entry.origin, target: entry.target, percent: entry.percent })),
      eligibility: fn.eligibility.kind,
      advisor: recommendations.map((recommendation) => `${recommendation.action}:${recommendation.level}`),
      recognized,
      ...(support ? { support } : {}),
      ...(annotation ? { annotation } : {}),
    });
  }

  const addressed = (site: CoverageCallSite): number => site.attributedPercent * (site.annotation?.fraction ?? 1);
  const sum = (predicate: (site: CoverageCallSite) => boolean): number => round(callSites.filter(predicate).reduce((acc, site) => acc + addressed(site), 0));
  const level = (site: CoverageCallSite): Transformability => site.annotation?.transformability ?? "NOT_TRANSFORMABLE";
  const plausible = (site: CoverageCallSite): boolean => level(site) !== "NOT_TRANSFORMABLE";
  const supported = (site: CoverageCallSite): boolean => level(site) === "EVIDENCE_SUPPORTED" || level(site) === "VALIDATED_BENEFICIAL";
  const transformable = (site: CoverageCallSite): boolean => (site.support?.accepted.length ?? 0) > 0;
  const plausibleTotal = sum(plausible);
  // Precision counts a recognized site's whole attributed time (its fraction is a review notion).
  const recognizedTotal = round(callSites.filter((site) => site.recognized).reduce((acc, site) => acc + site.attributedPercent, 0));
  const reviewed = callSites.some((site) => site.annotation !== undefined);
  const funnel: CoverageFunnelStep[] = [
    { step: "runtime (profiled)", percent: 100 },
    { step: "attributable to project call sites", percent: profile.attribution.attributedPercent },
    { step: "project's own JavaScript (FUNCTION_SELF)", percent: profile.attribution.byTarget.FUNCTION_SELF ?? 0 },
    { step: `top call sites (${callSites.length})`, percent: percent(covered) },
    ...(reviewed ? [
      { step: "human-plausible", percent: plausibleTotal },
      { step: "human-evidence-supported", percent: sum(supported) },
    ] : []),
    { step: "CrankTS-recognized (advisor)", percent: sum((site) => site.recognized && (!reviewed || plausible(site))) },
    { step: "CrankTS-transformable (a fail-closed pass accepts it)", percent: sum((site) => transformable(site) && (!reviewed || plausible(site))) },
    ...(reviewed ? [{ step: "validated-beneficial", percent: sum((site) => level(site) === "VALIDATED_BENEFICIAL") }] : []),
  ];
  return {
    totalMicros: total,
    buckets,
    attribution: { ...profile.attribution.byTarget, UNATTRIBUTED: profile.attribution.unattributedPercent },
    callSites,
    funnel,
    ...(reviewed && recognizedTotal > 0 ? {
      recognitionPrecision: round(callSites.filter((site) => site.recognized && plausible(site)).reduce((acc, site) => acc + site.attributedPercent, 0) / recognizedTotal),
    } : {}),
    ...(plausibleTotal > 0 ? {
      automatedRecognitionRecall: round(sum((site) => plausible(site) && (site.recognized || transformable(site))) / plausibleTotal),
      patternFamilyRecall: round(sum((site) => plausible(site) && (site.annotation?.patterns ?? []).some((pattern) => KNOWN_PATTERN_FAMILIES.has(pattern))) / plausibleTotal),
    } : {}),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
