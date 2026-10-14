import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeProject, writeHoistInputProbe } from "./analysis/analyze-project.js";
import { StageTimer } from "./analysis/timings.js";
import { SUPPORTED_KERNEL_SHAPES, type SupportedKernelShape } from "./lowering/contract.js";
import { extractKernel, type ExtractRequest } from "./lowering/extract.js";
import { observeCpuProfile, renderM0Text } from "./observe/m0.js";
import { QUERY_COMMANDS, runQueryCommand } from "./observe/cli/index.js";
import { startMcpServer } from "./observe/mcp/server.js";
import { sessionJsonSchemas } from "./observe/schema.js";
import { observeWorkload, type MeasurementKind } from "./observe/session.js";
import { renderJsonReport } from "./report/json.js";
import { renderTextReport } from "./report/text.js";

export { analyzeProject, writeHoistInputProbe } from "./analysis/analyze-project.js";
export { detectHoistCandidates } from "./analysis/hoist.js";
export { readInputSignatures, writeInputSignatureProbe } from "./analysis/input-signatures.js";
export { renderJsonReport } from "./report/json.js";
export { renderTextReport } from "./report/text.js";
export { StageTimer } from "./analysis/timings.js";
export type * from "./analysis/model.js";
export type { StageTiming, StageTimingsReport } from "./analysis/timings.js";
export { SUPPORTED_KERNEL_SHAPES, validateKernelContract } from "./lowering/contract.js";
export type * from "./lowering/contract.js";
export { deriveSignatureRepresentation, representType } from "./lowering/representation.js";
export type { Representation, SignatureRepresentation, TransferCost } from "./lowering/representation.js";
export { GRAPH_ISLANDS_CONTRACT, KWX_ASCII_SCAN_CONTRACT, REFERENCE_CONTRACTS } from "./lowering/reference-contracts.js";
export type * from "./lowering/ir.js";
export { printIrModule } from "./lowering/ir.js";
export { lowerKernel } from "./lowering/lower.js";
export type { LoweringDiagnostic, LoweringOptions, LoweringResult } from "./lowering/lower.js";
export { verifyIrModule } from "./lowering/verify.js";
export type { IrVerification, VerifyDiagnostic } from "./lowering/verify.js";
export { interpretIr, KernelTrap } from "./lowering/interpret.js";
export type { InterpretOptions } from "./lowering/interpret.js";
export { deriveKernelContract } from "./lowering/derive-contract.js";
export { emitRustCrate, KERNEL_TRAP_PREFIX } from "./lowering/backend-rust.js";
export { extractKernel } from "./lowering/extract.js";
export { emitTypeScriptWrapper } from "./lowering/wrapper-ts.js";
export { planRegionExtraction } from "./lowering/region.js";
export type { LineRange, RegionPlan, RegionRequest, RegionResult } from "./lowering/region.js";
export { emitRegionIntegration } from "./lowering/region-integration.js";
export { planInterning } from "./lowering/interning.js";
export type { InternPlan, InternRequest, InternResult } from "./lowering/interning.js";
export { emitInternIntegration } from "./lowering/intern-integration.js";
export { computeCoverage, KNOWN_PATTERN_FAMILIES } from "./analysis/coverage.js";
export type { CoverageAnnotation, CoverageCallSite, CoverageReport, SupportProbe, Transformability } from "./analysis/coverage.js";
export { planBatchInterning } from "./lowering/interning-batch.js";
export type { BatchInternPlan, BatchInternRequest, BatchInternResult, BatchOutputField } from "./lowering/interning-batch.js";
export { emitBatchIntegration } from "./lowering/batch-integration.js";
export { sealedGraphRuntime } from "./lowering/sealed-graph.js";
export type { ExtractRequest, ExtractResult } from "./lowering/extract.js";
export type { DeriveContractRequest, DerivedContract } from "./lowering/derive-contract.js";

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
  readonly inputSignaturePaths?: readonly string[];
  /** `--probe-inputs <dir>`: write an input-signature probe for the hoisting candidates instead of a report. */
  readonly probeInputsDir?: string;
  readonly target: string;
  readonly verbose: boolean;
}

/** Synchronous for every command except `observe`, which runs a workload and returns a promise. */
export function runCli(arguments_: readonly string[]): number | Promise<number> {
  const cliStart = performance.now();
  if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "help") {
    printUsage();
    return 0;
  }

  if (arguments_[0] === "extract") {
    return runExtract(arguments_.slice(1));
  }

  if (arguments_[0] === "observe") {
    return runObserve(arguments_.slice(1));
  }

  if (QUERY_COMMANDS.has(arguments_[0] as string)) {
    return runQueryCommand(arguments_[0] as string, arguments_.slice(1));
  }

  if (arguments_[0] === "schema") {
    console.log(JSON.stringify(sessionJsonSchemas(), null, 2));
    return 0;
  }

  if (arguments_[0] === "mcp") {
    return runMcp(arguments_.slice(1));
  }

  if (arguments_[0] === "observe-m0") {
    return runObserveM0(arguments_.slice(1));
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
      ...(options.inputSignaturePaths ? { inputSignaturePaths: options.inputSignaturePaths } : {}),
    });
    if (options.probeInputsDir) {
      if (!options.profilePath) {
        throw new Error("--probe-inputs needs --profile (candidates come from profiled call sites).");
      }
      const probe = writeHoistInputProbe(target, result, options.probeInputsDir, { workspaceReferences: options.workspaceReferences });
      console.log(`Input-signature probe for ${probe.sites.length} call site(s): ${probe.sites.join(", ")}`);
      console.log(`Run: CRANKTS_SIGNATURES_OUT=signatures.json node --import ${probe.importPath} <program>`);
      console.log("Then: crankts analyze ... --profile <profile> --input-signatures signatures.json");
      return 0;
    }
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

async function runMcp(arguments_: readonly string[]): Promise<number> {
  const options: { root?: string; sessionsDir?: string } = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if ((argument !== "--root" && argument !== "--sessions-dir") || value === undefined) {
      console.error("Usage: crankts mcp [--root <dir>] [--sessions-dir <dir>]");
      return 2;
    }
    if (argument === "--root") options.root = value;
    else options.sessionsDir = value;
  }
  await startMcpServer(options);
  // The stdio transport keeps the process alive until the client disconnects.
  return new Promise<number>((resolvePromise) => process.stdin.once("close", () => resolvePromise(0)));
}

async function runObserve(arguments_: readonly string[]): Promise<number> {
  const separator = arguments_.indexOf("--");
  const optionArguments = separator === -1 ? arguments_ : arguments_.slice(0, separator);
  const command = separator === -1 ? [] : arguments_.slice(separator + 1);
  const values = new Map<string, string>();
  const valueOptions = new Set(["--only", "--cpu-interval", "--heap-interval", "--timeout", "--entry", "--root", "--sessions-dir", "--workload"]);
  const flags = new Set<string>();
  for (let index = 0; index < optionArguments.length; index += 1) {
    const argument = optionArguments[index] as string;
    if (argument === "--help") {
      printUsage();
      return 0;
    }
    if (argument === "--verify-determinism" || argument === "--baseline") {
      flags.add(argument);
      continue;
    }
    const value = optionArguments[index + 1];
    if (!valueOptions.has(argument) || value === undefined) {
      console.error(valueOptions.has(argument) ? `${argument} requires a value.` : `Unknown option '${argument}'.`);
      return 2;
    }
    values.set(argument, value);
    index += 1;
  }
  if (command.length === 0) {
    console.error("Missing workload: crankts observe [options] -- <cmd...>");
    return 2;
  }
  const number = (name: string): number | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
    return parsed;
  };
  try {
    const cpuIntervalUs = number("--cpu-interval");
    const heapIntervalBytes = number("--heap-interval");
    const timeoutSec = number("--timeout");
    const result = await observeWorkload({
      command,
      ...(values.has("--only") ? { only: (values.get("--only") as string).split(",").map((kind) => kind.trim()) as MeasurementKind[] } : {}),
      ...(cpuIntervalUs !== undefined ? { cpuIntervalUs } : {}),
      ...(heapIntervalBytes !== undefined ? { heapIntervalBytes } : {}),
      ...(timeoutSec !== undefined ? { timeoutSec } : {}),
      ...(values.has("--entry") ? { entry: values.get("--entry") as string } : {}),
      ...(values.has("--root") ? { root: values.get("--root") as string } : {}),
      ...(values.has("--sessions-dir") ? { sessionsDir: values.get("--sessions-dir") as string } : {}),
      ...(values.has("--workload") ? { workloadId: values.get("--workload") as string } : {}),
      ...(flags.has("--verify-determinism") ? { verifyDeterminism: true } : {}),
      ...(flags.has("--baseline") ? { baseline: true } : {}),
    });
    // The workload owns stdout; the report goes to stderr.
    console.error("");
    console.error(`crankts observe: session ${result.session.sessionId} (quality ${result.session.quality.level}${result.session.quality.reasons.length ? `: ${result.session.quality.reasons.join(", ")}` : ""})`);
    for (const measurement of result.session.measurements) {
      const roles = measurement.processes.map((info) => `${info.role} pid ${info.pid}${info.threadId ? `/${info.threadId}` : ""}`).join(", ");
      const overhead = measurement.overhead ? ` (${measurement.overhead.wallRatio}× the uninstrumented ${measurement.overhead.baselineWallMs} ms)` : "";
      console.error(`${measurement.measurementId}: ${measurement.wallMs} ms${overhead}${roles ? `; ${roles}` : ""}`);
      for (const error of measurement.errors) console.error(`! ${error}`);
    }
    if (result.attribution) console.error(renderM0Text({ ...result.attribution, outDir: result.sessionDir }, 10));
    if (!result.attribution) return 1;
    return result.exitCode && result.exitCode !== 0 ? result.exitCode : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runObserveM0(arguments_: readonly string[]): number {
  let profilePath: string | undefined;
  let root = ".";
  let outDir = ".crankts/m0";
  let format = "text";
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    const value = arguments_[index + 1];
    if (argument === "--root" || argument === "--out" || argument === "--format") {
      if (!value) {
        console.error(`${argument} requires a value.`);
        return 2;
      }
      if (argument === "--root") root = value;
      else if (argument === "--out") outDir = value;
      else format = value;
      index += 1;
    } else if (argument === "--help") {
      printUsage();
      return 0;
    } else if (!profilePath && !argument.startsWith("--")) {
      profilePath = argument;
    } else {
      console.error(`Unknown option '${argument}'.`);
      return 2;
    }
  }
  if (!profilePath || (format !== "text" && format !== "json")) {
    printUsage();
    return 2;
  }
  try {
    const result = observeCpuProfile({ profilePath, root, outDir });
    console.log(format === "json" ? JSON.stringify(result.summary, null, 2) : renderM0Text(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runExtract(arguments_: readonly string[]): number {
  if (arguments_.includes("--help")) {
    printUsage();
    return 0;
  }
  let request: ExtractRequest;
  try {
    request = parseExtractOptions(arguments_);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    return 2;
  }
  const result = extractKernel(request);
  if (!result.ok) {
    console.error(`CrankTS extract failed closed at ${result.stage}:`);
    for (const message of result.messages) {
      console.error(`  ${message}`);
    }
    return 1;
  }
  console.log(`Extracted ${result.contract.name} (${result.contract.shape}); contract is lowerable.`);
  for (const obligation of result.contract.proofObligations) {
    console.log(`  ${obligation.kind}: ${obligation.status}${obligation.runtimeGuard ? ` (${obligation.runtimeGuard})` : ""}`);
  }
  for (const warning of result.warnings) {
    console.log(`  WARNING ${warning.code}: ${warning.message}`);
  }
  for (const file of result.files) {
    console.log(`  wrote ${file}`);
  }
  return 0;
}

function parseExtractOptions(arguments_: readonly string[]): ExtractRequest {
  let target: string | undefined;
  const values = new Map<string, string>();
  let batch = false;
  const valueOptions = new Set(["--shape", "--out", "--prepare", "--graph", "--direction", "--name", "--region", "--prepare-region", "--intern"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    const [flag, inline] = argument.includes("=") ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)] : [argument, undefined];
    if (valueOptions.has(flag)) {
      const value = inline ?? arguments_[index + 1];
      if (inline === undefined) {
        index += 1;
      }
      if (!value || value.startsWith("-")) {
        throw new Error(`${flag} requires a value.`);
      }
      values.set(flag, value);
      continue;
    }
    if (argument === "--batch") {
      batch = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown extract option '${argument}'.`);
    }
    if (target) {
      throw new Error("The extract command accepts exactly one <file>#<function> target.");
    }
    target = argument;
  }
  const shape = values.get("--shape");
  const outDir = values.get("--out");
  if (!target || !shape || !outDir) {
    throw new Error("extract requires <file>#<function>, --shape, and --out.");
  }
  if (!(SUPPORTED_KERNEL_SHAPES as readonly string[]).includes(shape)) {
    throw new Error(`--shape must be one of ${SUPPORTED_KERNEL_SHAPES.join(", ")}.`);
  }
  const graph = values.get("--graph");
  const direction = values.get("--direction") ?? "directed";
  if (direction !== "directed" && direction !== "undirected") {
    throw new Error("--direction must be 'directed' or 'undirected'.");
  }
  const [offsets, neighbors, ...extra] = graph?.split(",") ?? [];
  if (graph && (!offsets || !neighbors || extra.length > 0)) {
    throw new Error("--graph expects <offsetsParameter>,<neighborsParameter>.");
  }
  const prepare = values.get("--prepare");
  const name = values.get("--name");
  const parseRange = (flag: string): { startLine: number; endLine: number } | undefined => {
    const value = values.get(flag);
    if (!value) return undefined;
    const match = /^(\d+)-(\d+)$/.exec(value);
    if (!match || Number(match[1]) > Number(match[2])) {
      throw new Error(`${flag} expects <startLine>-<endLine>.`);
    }
    return { startLine: Number(match[1]), endLine: Number(match[2]) };
  };
  const region = parseRange("--region");
  const prepareRegion = parseRange("--prepare-region");
  if (prepareRegion && !region) {
    throw new Error("--prepare-region requires --region.");
  }
  if (batch && !values.get("--intern")) {
    throw new Error("--batch requires --intern.");
  }
  return {
    ...(region ? { region: { execute: region, ...(prepareRegion ? { prepare: prepareRegion } : {}) } } : {}),
    ...(values.get("--intern") ? { intern: values.get("--intern") as string } : {}),
    ...(batch ? { batch: true } : {}),
    target,
    shape: shape as SupportedKernelShape,
    outDir,
    ...(prepare ? { prepare } : {}),
    ...(offsets && neighbors ? { graph: { offsets, neighbors, direction } } : {}),
    ...(name ? { crateName: name } : {}),
  };
}

function printUsage(): void {
  console.log("Usage: crankts analyze [target] [options]");
  console.log("Analyze a TypeScript project or a file/directory within it.");
  console.log("Options:");
  console.log("  --format <text|json>  Select report format (default: text)");
  console.log("  --verbose             Include resolved and unresolved call edges");
  console.log("  --min-score <0-100>   Only report candidate islands at or above this score");
  console.log("  --profile <file>      Attach a Node/V8 .cpuprofile; Native Priority is unchanged");
  console.log("  --heap-profile <file> Attach a Node/V8 .heapprofile (--heap-prof keeps only objects alive at exit)");
  console.log("  --pipeline <file>     Add a versioned pipeline/sink evidence descriptor");
  console.log("  --workload <label>    Label the workload represented by attached profiles");
  console.log("  --workspace-references Analyze transitive TypeScript project references");
  console.log("  --timings <file>      Write per-stage wall time and memory to a separate JSON file");
  console.log("  --probe-inputs <dir>  With --profile: write an input-signature probe for hoisting candidates");
  console.log("  --input-signatures <file>  Attach input repetition evidence (repeatable) to hoisting candidates");
  console.log("");
  console.log("Usage: crankts extract <file>#<function> --shape <shape> --out <dir> [options]");
  console.log("Lower an explicitly selected function to a Rust/N-API crate; fails closed unless its contract is lowerable.");
  console.log("Options:");
  console.log(`  --shape <${SUPPORTED_KERNEL_SHAPES.join("|")}>`);
  console.log("  --out <dir>           Directory for Cargo.toml, src/lib.rs, contract.json, and kernel.ir");
  console.log("  --prepare <file>#<fn> PREPARED_STATE: the function that builds the native state");
  console.log("  --graph <offsets>,<neighbors>  GRAPH_BATCH: the CSR Uint32Array parameters");
  console.log("  --direction <directed|undirected>  GRAPH_BATCH graph direction (default: directed)");
  console.log("  --name <crate>        Crate name (default: <function>-kernel)");
  console.log("  --region <a>-<b>      Extract statement lines a-b inside <function> or <Class.method> (unmodified source)");
  console.log("  --prepare-region <a>-<b>  PREPARED_STATE: lines that build the state reused across calls (sliced)");
  console.log("  --intern <IdAlias>    Intern string ids of this type alias into indices (CSR graphs, bitmaps, ranks)");
  console.log("  --batch               With --intern: batch the per-group calls of f(group, graph) into one kernel call");
  console.log("                        and seal the graph after its producer (upstream packing)");
  console.log("");
  console.log("Usage: crankts observe [options] -- <cmd...>");
  console.log("Run a workload once per measurement (CPU profile, precise coverage, heap sampling) and attribute its primary");
  console.log("Node process to TypeScript code entities: CPU time, execution counts, hot block ranges, allocated bytes,");
  console.log("per-call estimates, and observed caller edges.");
  console.log("Writes .crankts/sessions/<id>/ (session.json, entities.json, metrics.json, edges.json, summary.json, raw/).");
  console.log("Options:");
  console.log("  --entry <script>      The primary process's script; needed when the command starts several Node processes");
  console.log("  --root <dir>          Project root for attribution (default: current directory)");
  console.log("  --cpu-interval <us>   CPU sampling interval in microseconds (default: 1000)");
  console.log("  --timeout <s>         SIGTERM after this many seconds, SIGKILL 10 s later (default: 600)");
  console.log("  --only <kinds>        Measurements to run, comma-separated: cpu, coverage, heap (default: all)");
  console.log("  --heap-interval <b>   Heap sampling interval in bytes (default: 524288)");
  console.log("  --sessions-dir <dir>  Where sessions go (default: <root>/.crankts/sessions)");
  console.log("  --workload <label>    Label stored as workloadId");
  console.log("  --verify-determinism  Run coverage twice and compare the top 50 execution counts (quality check)");
  console.log("  --baseline            Run once without instrumentation first and report each measurement's overhead");
  console.log("");
  console.log("Queries over the newest session (or --session <id>); add --json for the MCP data structures:");
  console.log("  crankts summary");
  console.log("  crankts top --by self|inclusive|alloc|executions|cpu-per-call [--limit 20] [--scope own|all]");
  console.log("  crankts inspect <key | name | file:line>");
  console.log("  crankts callers <key> [--limit 10]    crankts callees <key> [--limit 10]");
  console.log("  crankts deps [<key>]                  dependency time by the own code that caused it");
  console.log("  crankts sessions                      crankts gc --keep <n>");
  console.log("  Common: --root <dir> | --sessions-dir <dir>, --session <id>, --json");
  console.log("");
  console.log("Usage: crankts schema    JSON Schemas of session.json, entities.json, metrics.json, edges.json (0.3)");
  console.log("");
  console.log("Usage: crankts mcp [--root <dir>] [--sessions-dir <dir>]");
  console.log("Serve the sessions over MCP (stdio): get_summary, get_hot_functions, get_function_metrics, get_hot_allocators,");
  console.log("get_hot_ranges, get_callers, get_callees, get_dependency_costs, list_sessions.");
  console.log("");
  console.log("Usage: crankts observe-m0 <file.cpuprofile> [--root <dir>] [--out <dir>] [--format text|json]");
  console.log("Observe M0: attribute a V8 CPU profile to TypeScript code entities with observed caller edges.");
  console.log("Writes entities.json, metrics.json, edges.json, and summary.json (default --out .crankts/m0).");
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
  const inputSignaturePaths: string[] = [];
  let probeInputsDir: string | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--input-signatures" || argument === "--probe-inputs") {
      const value = arguments_[index + 1];
      index += 1;
      if (!value || value.startsWith("-")) {
        throw new Error(`${argument} requires a path.`);
      }
      if (argument === "--input-signatures") inputSignaturePaths.push(value);
      else probeInputsDir = value;
      continue;
    }
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
    ...(inputSignaturePaths.length > 0 ? { inputSignaturePaths } : {}),
    ...(probeInputsDir ? { probeInputsDir } : {}),
  };
}