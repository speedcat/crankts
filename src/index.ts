import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeProject } from "./analysis/analyze-project.js";
import { StageTimer } from "./analysis/timings.js";
import { renderJsonReport } from "./report/json.js";
import { renderTextReport } from "./report/text.js";

export { analyzeProject } from "./analysis/analyze-project.js";
export { renderJsonReport } from "./report/json.js";
export { renderTextReport } from "./report/text.js";
export { StageTimer } from "./analysis/timings.js";
export type * from "./analysis/model.js";
export type { StageTiming, StageTimingsReport } from "./analysis/timings.js";

type OutputFormat = "text" | "json";

interface AnalyzeOptions {
  readonly workspaceReferences: boolean;
  readonly format: OutputFormat;
  readonly minScore: number;
  readonly profilePath?: string;
  readonly heapProfilePath?: string;
  readonly pipelinePath?: string;
  readonly workloadLabel?: string;
  readonly timingsPath?: string;
  readonly target: string;
  readonly verbose: boolean;
}

export function runCli(arguments_: readonly string[]): number {
  const cliStart = performance.now();
  if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "help") {
    printUsage();
    return 0;
  }

  if (arguments_[0] !== "analyze") {
    console.error(`Unknown command '${arguments_[0]}'.`);
    printUsage();
    return 2;
  }

  const analyzeArguments = arguments_.slice(1);
  if (analyzeArguments.includes("--help")) {
    printUsage();
    return 0;
  }
  let options: AnalyzeOptions;
  try {
    options = parseAnalyzeOptions(analyzeArguments);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    return 2;
  }

  const target = resolve(options.target);
  const timer = options.timingsPath ? new StageTimer() : undefined;
  timer?.record("startup", cliStart);
  try {
    const result = analyzeProject(target, {
      ...(timer ? { timings: timer } : {}),
      ...(options.profilePath ? { profilePath: options.profilePath } : {}),
      ...(options.heapProfilePath ? { heapProfilePath: options.heapProfilePath } : {}),
      ...(options.pipelinePath ? { pipelinePath: options.pipelinePath } : {}),
      ...(options.workloadLabel ? { workloadLabel: options.workloadLabel } : {}),
      ...(options.workspaceReferences ? { workspaceReferences: true } : {}),
    });
    const reportOptions = { verbose: options.verbose, minScore: options.minScore };
    const render = (): string => (options.format === "json"
      ? renderJsonReport(result, reportOptions)
      : renderTextReport(result, reportOptions));
    const report = timer ? timer.measure("report", render) : render();
    process.stdout.write(report);
    if (timer && options.timingsPath) {
      writeTimings(options.timingsPath, target, timer, performance.now() - cliStart);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`CrankTS analysis failed: ${message}`);
    return 1;
  }
}

function writeTimings(path: string, target: string, timer: StageTimer, cliMs: number): void {
  const resourceUsage = process.resourceUsage();
  const timings = {
    ...timer.toJSON(),
    target,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    totalMs: performance.now(),
    cliMs,
    // maxRSS is reported in kilobytes by libuv on all platforms.
    peakRssBytes: resourceUsage.maxRSS * 1024,
  };
  writeFileSync(resolve(path), `${JSON.stringify(timings, null, 2)}\n`);
}

function printUsage(): void {
  console.log("Usage: crankts analyze [target] [options]");
  console.log("Analyze a TypeScript project or a file/directory within it.");
  console.log("Options:");
  console.log("  --format <text|json>  Select report format (default: text)");
  console.log("  --verbose             Include resolved and unresolved call edges");
  console.log("  --min-score <0-100>   Only report candidate islands at or above this score");
  console.log("  --profile <file>      Attach a Node/V8 .cpuprofile; Native Priority is unchanged");
  console.log("  --heap-profile <file> Attach a Node/V8 .heapprofile of sampled allocated bytes");
  console.log("  --pipeline <file>     Add a versioned pipeline/sink evidence descriptor");
  console.log("  --workload <label>    Label the workload represented by attached profiles");
  console.log("  --workspace-references Analyze transitive TypeScript project references");
  console.log("  --timings <file>      Write per-stage wall time and memory to a separate JSON file");
}

function parseAnalyzeOptions(arguments_: readonly string[]): AnalyzeOptions {
  let target: string | undefined;
  let workspaceReferences = false;
  let format: OutputFormat = "text";
  let verbose = false;
  let minScore = 0;
  let profilePath: string | undefined;
  let heapProfilePath: string | undefined;
  let pipelinePath: string | undefined;
  let workloadLabel: string | undefined;
  let timingsPath: string | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--workspace-references") {
      workspaceReferences = true;
      continue;
    }
    if (argument === "--verbose") {
      verbose = true;
      continue;
    }
    if (argument === "--profile" || argument?.startsWith("--profile=")) {
      const value = argument === "--profile" ? arguments_[index + 1] : argument.slice("--profile=".length);
      if (argument === "--profile") {
        index += 1;
      }
      if (!value || value.startsWith("-")) {
        throw new Error("--profile requires a V8 .cpuprofile file path.");
      }
      profilePath = value;
      continue;
    }
    if (argument === "--pipeline" || argument?.startsWith("--pipeline=")) {
      const value = argument === "--pipeline" ? arguments_[index + 1] : argument.slice("--pipeline=".length);
      if (argument === "--pipeline") {
        index += 1;
      }
      if (!value || value.startsWith("-")) {
        throw new Error("--pipeline requires a versioned JSON descriptor path.");
      }
      pipelinePath = value;
      continue;
    }
    if (argument === "--heap-profile" || argument?.startsWith("--heap-profile=")) {
      const value = argument === "--heap-profile" ? arguments_[index + 1] : argument.slice("--heap-profile=".length);
      if (argument === "--heap-profile") {
        index += 1;
      }
      if (!value || value.startsWith("-")) {
        throw new Error("--heap-profile requires a V8 .heapprofile file path.");
      }
      heapProfilePath = value;
      continue;
    }
    if (argument === "--workload" || argument?.startsWith("--workload=")) {
      const value = argument === "--workload" ? arguments_[index + 1] : argument.slice("--workload=".length);
      if (argument === "--workload") {
        index += 1;
      }
      if (!value || value.startsWith("-")) {
        throw new Error("--workload requires a non-empty label.");
      }
      workloadLabel = value;
      continue;
    }
    if (argument === "--timings" || argument?.startsWith("--timings=")) {
      const value = argument === "--timings" ? arguments_[index + 1] : argument.slice("--timings=".length);
      if (argument === "--timings") {
        index += 1;
      }
      if (!value || value.startsWith("-")) {
        throw new Error("--timings requires an output file path.");
      }
      timingsPath = value;
      continue;
    }
    if (argument === "--format" || argument?.startsWith("--format=")) {
      const value = argument === "--format" ? arguments_[index + 1] : argument.slice("--format=".length);
      if (argument === "--format") {
        index += 1;
      }
      if (value !== "text" && value !== "json") {
        throw new Error("--format must be either 'text' or 'json'.");
      }
      format = value;
      continue;
    }
    if (argument === "--min-score" || argument?.startsWith("--min-score=")) {
      const value = argument === "--min-score" ? arguments_[index + 1] : argument.slice("--min-score=".length);
      if (argument === "--min-score") {
        index += 1;
      }
      const parsedScore = Number(value);
      if (!Number.isInteger(parsedScore) || parsedScore < 0 || parsedScore > 100) {
        throw new Error("--min-score must be an integer from 0 to 100.");
      }
      minScore = parsedScore;
      continue;
    }
    if (!argument || argument.startsWith("-")) {
      throw new Error(`Unknown analyze option '${argument ?? ""}'.`);
    }
    if (target) {
      throw new Error("The analyze command accepts one optional file or directory target.");
    }
    target = argument;
  }

  return {
    target: target ?? ".",
    workspaceReferences,
    format,
    verbose,
    minScore,
    ...(profilePath ? { profilePath } : {}),
    ...(heapProfilePath ? { heapProfilePath } : {}),
    ...(pipelinePath ? { pipelinePath } : {}),
    ...(workloadLabel ? { workloadLabel } : {}),
    ...(timingsPath ? { timingsPath } : {}),
  };
}