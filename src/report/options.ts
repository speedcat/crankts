import type { AnalysisResult, CandidateIsland } from "../analysis/model.js";

export interface ReportOptions {
  readonly verbose?: boolean;
  readonly minScore?: number;
}

export function getVisibleCandidateIslands(
  result: AnalysisResult,
  options: ReportOptions = {},
): CandidateIsland[] {
  const minScore = options.minScore ?? 0;
  const candidates = result.candidateIslands.filter((island) => island.score >= minScore);
  if (!result.cpuProfile) {
    return candidates;
  }
  return candidates.sort((left, right) => (
    (right.observedCpu?.selfCpuMicros ?? 0) - (left.observedCpu?.selfCpuMicros ?? 0)
    || right.nativePriority - left.nativePriority
  ));
}