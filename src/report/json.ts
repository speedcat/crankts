import type { AnalysisResult, FunctionAnalysis } from "../analysis/model.js";
import { CRANKTS_VERSION } from "../version.js";
import { getVisibleCandidateIslands } from "./options.js";
import type { ReportOptions } from "./options.js";

export interface JsonAnalysisReport {
  readonly schemaVersion: 2;
  readonly tool: {
    readonly name: "CrankTS";
    readonly version: string;
  };
  readonly project: {
    readonly name: string;
    readonly typescript: AnalysisResult["typescript"];
  };
  readonly workspace?: NonNullable<AnalysisResult["workspace"]>;
  readonly workloadLabel?: string;
  readonly acceleration: NonNullable<AnalysisResult["acceleration"]>;
  readonly summary: {
    readonly candidateOrdering: "native-priority" | "observed-cpu-self";
    readonly functions: {
      readonly total: number;
      readonly supported: number;
      readonly conditional: number;
      readonly blocked: number;
    };
    readonly candidateIslands: {
      readonly total: number;
      readonly reported: number;
    };
  };
  readonly functions: readonly FunctionAnalysis[];
  readonly candidateIslands: AnalysisResult["candidateIslands"];
  readonly cpuProfile?: NonNullable<AnalysisResult["cpuProfile"]>;
  readonly allocationProfile?: NonNullable<AnalysisResult["allocationProfile"]>;
  readonly pipeline?: NonNullable<AnalysisResult["pipeline"]>;
}

export function renderJsonReport(
  result: AnalysisResult,
  options: ReportOptions = {},
): string {
  const candidateIslands = getVisibleCandidateIslands(result, options);
  const report: JsonAnalysisReport = {
    schemaVersion: 2,
    tool: {
      name: "CrankTS",
      version: CRANKTS_VERSION,
    },
    project: {
      name: result.projectName,
      typescript: result.typescript,
    },
    ...(result.workspace ? { workspace: result.workspace } : {}),
    ...(result.workloadLabel ? { workloadLabel: result.workloadLabel } : {}),
    acceleration: result.acceleration,
    summary: {
      candidateOrdering: result.cpuProfile ? "observed-cpu-self" : "native-priority",
      functions: {
        total: result.functions.length,
        supported: countFunctions(result, "SUPPORTED"),
        conditional: countFunctions(result, "CONDITIONAL"),
        blocked: countFunctions(result, "BLOCKED"),
      },
      candidateIslands: {
        total: result.candidateIslands.length,
        reported: candidateIslands.length,
      },
    },
    functions: result.functions,
    candidateIslands,
    ...(result.cpuProfile ? { cpuProfile: result.cpuProfile } : {}),
    ...(result.allocationProfile ? { allocationProfile: result.allocationProfile } : {}),
    ...(result.pipeline ? { pipeline: result.pipeline } : {}),
  };

  return `${JSON.stringify(report, null, 2)}\n`;
}

function countFunctions(result: AnalysisResult, kind: FunctionAnalysis["eligibility"]["kind"]): number {
  return result.functions.filter((functionAnalysis) => functionAnalysis.eligibility.kind === kind).length;
}