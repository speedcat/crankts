import type { Attribution } from "../attribute.js";
import type { ArtifactFingerprint, Measurement, SessionQuality } from "../model.js";

/**
 * Session quality (docs/observe-plan.md §7.6, D8): simple checks that each compare like with like. `level` is the
 * worst single result and `reasons` names the checks that set it. There is no combined score.
 *
 * | check                          | lowers to                                   |
 * |--------------------------------|---------------------------------------------|
 * | artifactAgreement              | low when false                              |
 * | sampledButNotExecutedRatio     | medium > 5 %, low > 20 %                    |
 * | allocatedButNotExecutedRatio   | medium > 5 %, low > 20 %                    |
 * | unmappedOwnSampleRatio         | medium > 5 %                                |
 * | repeatCountAgreement           | medium < 95 %, low < 80 % (--verify-determinism) |
 * | plus: no primary data (low), a timeout or missing data in a measurement (medium), transformed positions
 * |   (tsx, ts-node) without the coverage run's source maps (low)                |
 */

export interface QualityInputs {
  readonly measurements: readonly Measurement[];
  readonly attribution?: Attribution;
  readonly artifactAgreement: boolean;
  /** Share of the top entities whose execution counts agree between two coverage runs (±1 %). */
  readonly repeatCountAgreement?: number;
}

export function assessQuality(inputs: QualityInputs): SessionQuality {
  const { measurements, attribution, artifactAgreement, repeatCountAgreement } = inputs;
  const reasons: string[] = [];
  let level: SessionQuality["level"] = "high";
  const lower = (to: SessionQuality["level"], reason: string): void => {
    reasons.push(reason);
    if (to === "low" || level === "high") level = to;
  };
  if (!attribution) lower("low", "noPrimaryData");
  for (const measurement of measurements) {
    if (measurement.exit.timedOut) lower("medium", `timedOut:${measurement.measurementId}`);
    if (!measurement.artifact && attribution) lower("medium", `missingData:${measurement.measurementId}`);
  }
  if (!artifactAgreement) lower("low", "artifactAgreement");

  const unmapped = attribution?.summary?.unmappedOwnSampleRatio;
  if (unmapped !== undefined && unmapped > 0.05) lower("medium", "unmappedOwnSampleRatio");
  const notExecuted = attribution?.sampledButNotExecutedRatio;
  if (notExecuted !== undefined && notExecuted > 0.2) lower("low", "sampledButNotExecutedRatio");
  else if (notExecuted !== undefined && notExecuted > 0.05) lower("medium", "sampledButNotExecutedRatio");
  const allocatedNotExecuted = attribution?.allocatedButNotExecutedRatio;
  if (allocatedNotExecuted !== undefined && allocatedNotExecuted > 0.2) lower("low", "allocatedButNotExecutedRatio");
  else if (allocatedNotExecuted !== undefined && allocatedNotExecuted > 0.05) lower("medium", "allocatedButNotExecutedRatio");
  if (repeatCountAgreement !== undefined && repeatCountAgreement < 0.8) lower("low", "repeatCountAgreement");
  else if (repeatCountAgreement !== undefined && repeatCountAgreement < 0.95) lower("medium", "repeatCountAgreement");

  // In-memory transforms (tsx, ts-node) report transformed positions; only the coverage run's source-map cache maps them.
  const transformed = measurements.some((measurement) => measurement.kind !== "coverage" && ["tsx", "ts-node", "other"].includes(measurement.artifact?.loader ?? ""));
  if (transformed && !measurements.some((measurement) => measurement.kind === "coverage" && measurement.artifact)) {
    lower("low", "transformedPositionsWithoutSourceMaps");
  }
  return {
    level,
    reasons,
    checks: {
      artifactAgreement,
      ...(unmapped !== undefined ? { unmappedOwnSampleRatio: unmapped } : {}),
      ...(notExecuted !== undefined ? { sampledButNotExecutedRatio: notExecuted } : {}),
      ...(allocatedNotExecuted !== undefined ? { allocatedButNotExecutedRatio: allocatedNotExecuted } : {}),
      ...(repeatCountAgreement !== undefined ? { repeatCountAgreement } : {}),
    },
  };
}

/** Same entry hash, and the same hash for every own module and source map that several measurements saw. */
export function artifactsAgree(artifacts: readonly ArtifactFingerprint[]): boolean {
  const [first, ...rest] = artifacts;
  if (!first) return true;
  for (const other of rest) {
    if (first.entrypointHash !== other.entrypointHash) return false;
    for (const [file, hash] of Object.entries(other.moduleHashes)) {
      const known = first.moduleHashes[file];
      if (known !== undefined && known !== hash) return false;
    }
    for (const [file, hash] of Object.entries(other.sourceMapHashes)) {
      const known = first.sourceMapHashes[file];
      if (known !== undefined && known !== hash) return false;
    }
  }
  return true;
}

/**
 * Determinism (§7.6, `--verify-determinism`): the share of the `top` most executed entities of the first coverage run
 * whose count in the second run is within ±1 %. Entities missing from the second run count as disagreeing.
 */
export function repeatCountAgreement(first: ReadonlyMap<string, number>, second: ReadonlyMap<string, number>, top = 50): number {
  const ranked = [...first].filter(([, count]) => count > 0).sort((left, right) => right[1] - left[1]).slice(0, top);
  if (ranked.length === 0) return 1;
  const agreeing = ranked.filter(([key, count]) => {
    const other = second.get(key);
    return other !== undefined && Math.abs(other - count) <= count * 0.01;
  }).length;
  return Math.round((agreeing / ranked.length) * 1000) / 1000;
}
