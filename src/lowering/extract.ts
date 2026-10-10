import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type * as ts from "typescript";
import { collectFunctions } from "../analysis/functions.js";
import { createCompilerFacade } from "../compiler/compiler-facade.js";
import { emitRustCrate, RustBackendError } from "./backend-rust.js";
import { validateKernelContract, type ContractDiagnostic, type KernelContract, type SupportedKernelShape } from "./contract.js";
import { deriveKernelContract } from "./derive-contract.js";
import { printIrModule, type IrModule } from "./ir.js";
import { lowerKernel, type LoweringDiagnostic } from "./lower.js";
import type { VerifyDiagnostic } from "./verify.js";
import { emitTypeScriptWrapper } from "./wrapper-ts.js";
import { planRegionExtraction, type LineRange, type RegionPlan } from "./region.js";
import { emitRegionIntegration } from "./region-integration.js";
import { emitBatchIntegration } from "./batch-integration.js";
import { planBatchInterning } from "./interning-batch.js";
import { planInterning } from "./interning.js";
import { emitInternIntegration } from "./intern-integration.js";

/**
 * `crankts extract` (v0.2.2): explicit selection → lowering → contract derivation → validation →
 * Rust/N-API crate. Fails closed: nothing is written unless the contract is lowerable.
 */

export interface ExtractRequest {
  /** `path/to/file.ts#functionName` */
  readonly target: string;
  readonly shape: SupportedKernelShape;
  readonly outDir: string;
  /** PREPARED_STATE: `path/to/file.ts#prepareFunction` */
  readonly prepare?: string;
  /** GRAPH_BATCH: names of the CSR offsets and neighbors parameters. */
  readonly graph?: { readonly offsets: string; readonly neighbors: string; readonly direction: "directed" | "undirected" };
  readonly crateName?: string;
  /**
   * Region extraction from unmodified source (v0.2.5): `target` names the enclosing function or
   * `Class.method`; the regions are statement-aligned line ranges inside it.
   */
  readonly region?: { readonly execute: LineRange; readonly prepare?: LineRange };
  /**
   * Id-domain representation pass (v0.2.6): the id type alias (e.g. `FunctionId`) whose string values
   * are interned into dense indices; graphs, id sets, and comparators are packed accordingly.
   */
  readonly intern?: string;
  /**
   * With `intern` (v0.2.6b): `target` is a per-group function `f(group: readonly Id[], graph)`; its
   * `GROUPS.map(...)` call sites are batched into one packed kernel call, and the graph is sealed upstream.
   */
  readonly batch?: boolean;
}

export type ExtractResult =
  | {
    readonly ok: true;
    readonly contract: KernelContract;
    readonly warnings: readonly ContractDiagnostic[];
    readonly files: readonly string[];
  }
  | {
    readonly ok: false;
    readonly stage: "select" | "lower" | "verify" | "contract" | "backend";
    readonly messages: readonly string[];
  };

export function extractKernel(request: ExtractRequest): ExtractResult {
  if (request.region) {
    return extractRegion(request, request.region);
  }
  if (request.intern) {
    return extractInterned(request, request.intern);
  }
  const execute = lowerTarget(request.target);
  if (!execute.ok) {
    return execute.result;
  }
  const prepare = request.prepare ? lowerTarget(request.prepare) : undefined;
  if (prepare && !prepare.ok) {
    return prepare.result;
  }
  if (prepare?.ok && prepare.file !== execute.file) {
    return {
      ok: false,
      stage: "select",
      messages: ["the generated wrapper imports prepare and execute from one module; they must be in the same file"],
    };
  }

  const derived = deriveKernelContract({
    name: request.crateName ?? execute.module.entry,
    shape: request.shape,
    execute: execute.module,
    ...(prepare?.ok ? { prepare: prepare.module } : {}),
    ...(request.graph ? { graph: request.graph } : {}),
  });
  if (!derived.ok) {
    return { ok: false, stage: "verify", messages: derived.errors.map(formatVerifyDiagnostic) };
  }
  const validation = validateKernelContract(derived.contract);
  if (!validation.lowerable) {
    return {
      ok: false,
      stage: "contract",
      messages: validation.diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`),
    };
  }

  const crateName = toCrateName(request.crateName ?? `${execute.module.entry}-kernel`);
  const outDir = resolve(request.outDir);
  let files: ReadonlyMap<string, string>;
  try {
    files = new Map([
      ...emitRustCrate({
        crateName,
        contract: derived.contract,
        execute: execute.module,
        ...(prepare?.ok ? { prepare: prepare.module } : {}),
      }).files,
      ...emitTypeScriptWrapper({
        contract: derived.contract,
        crateName,
        execute: execute.module,
        ...(prepare?.ok ? { prepare: prepare.module } : {}),
        sourceImport: importSpecifier(join(realOutDir(outDir), "ts"), realpathSync(execute.file)),
      }),
    ]);
  } catch (error) {
    if (error instanceof RustBackendError) {
      return { ok: false, stage: "backend", messages: [error.message] };
    }
    throw error;
  }

  const written = new Map(files);
  written.set("contract.json", `${JSON.stringify(derived.contract, null, 2)}\n`);
  written.set("kernel.ir", [prepare?.ok ? printIrModule(prepare.module) : "", printIrModule(execute.module)].filter(Boolean).join("\n"));
  written.set("README.md", readme(crateName, derived.contract));
  for (const [path, content] of written) {
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    ok: true,
    contract: derived.contract,
    warnings: validation.diagnostics,
    files: [...written.keys()].map((path) => join(outDir, path)),
  };
}

function extractRegion(request: ExtractRequest, region: NonNullable<ExtractRequest["region"]>): ExtractResult {
  const separator = request.target.lastIndexOf("#");
  if (separator <= 0) {
    return { ok: false, stage: "select", messages: [`expected <file>#<function>, got '${request.target}'`] };
  }
  if ((request.shape === "PREPARED_STATE") !== (region.prepare !== undefined)) {
    return { ok: false, stage: "select", messages: ["PREPARED_STATE needs --prepare-region, and --prepare-region needs PREPARED_STATE"] };
  }
  const sourceFile = resolve(request.target.slice(0, separator));
  const planned = planRegionExtraction({
    file: sourceFile,
    function: request.target.slice(separator + 1),
    execute: region.execute,
    ...(region.prepare ? { prepare: region.prepare } : {}),
  });
  if (!planned.ok) {
    return { ok: false, stage: "select", messages: planned.diagnostics };
  }
  const plan = planned.plan;
  const outDir = realOutDir(resolve(request.outDir));
  const tsDirectory = join(outDir, "ts");
  mkdirSync(tsDirectory, { recursive: true });
  // The outlined regions are an ordinary TypeScript module: lowered like any kernel, and the fallback.
  const regionsFile = join(tsDirectory, "regions.ts");
  writeFileSync(regionsFile, plan.outlinedModule);
  writeFileSync(join(tsDirectory, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true },
    files: ["regions.ts"],
  }, null, 2)}\n`);

  const execute = lowerTarget(`${regionsFile}#${plan.executeName}`);
  if (!execute.ok) {
    return execute.result;
  }
  const prepare = plan.prepareName ? lowerTarget(`${regionsFile}#${plan.prepareName}`) : undefined;
  if (prepare && !prepare.ok) {
    return prepare.result;
  }
  const crateName = toCrateName(request.crateName ?? `${plan.executeName}-kernel`);
  const derived = deriveKernelContract({
    name: crateName,
    shape: request.shape,
    execute: execute.module,
    ...(prepare?.ok ? { prepare: prepare.module } : {}),
  });
  if (!derived.ok) {
    return { ok: false, stage: "verify", messages: derived.errors.map(formatVerifyDiagnostic) };
  }
  // The prepare inputs come from caller-owned data (e.g. a mutable Set); the integration revalidates
  // the native state against a snapshot of them on every call.
  const contract: KernelContract = derived.contract.state
    ? { ...derived.contract, source: `${plan.file}#${plan.function}`, state: { ...derived.contract.state, invalidation: "CONTENT_SNAPSHOT" } }
    : { ...derived.contract, source: `${plan.file}#${plan.function}` };
  const validation = validateKernelContract(contract);
  if (!validation.lowerable) {
    return {
      ok: false,
      stage: "contract",
      messages: validation.diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`),
    };
  }

  let files: Map<string, string>;
  try {
    files = new Map([
      ...emitRustCrate({ crateName, contract, execute: execute.module, ...(prepare?.ok ? { prepare: prepare.module } : {}) }).files,
      ...emitRegionIntegration({ plan, crateName, execute: execute.module, ...(prepare?.ok ? { prepare: prepare.module } : {}) }),
    ]);
  } catch (error) {
    if (error instanceof RustBackendError) {
      return { ok: false, stage: "backend", messages: [error.message] };
    }
    throw error;
  }
  const patchedName = basename(sourceFile).replace(/(\.crankts)?\.ts$/, ".crankts.ts");
  files.set(`ts/${patchedName}`, plan.patchedSource("./integration.js", join(tsDirectory, patchedName)));
  files.set("contract.json", `${JSON.stringify(contract, null, 2)}\n`);
  files.set("kernel.ir", [prepare?.ok ? printIrModule(prepare.module) : "", printIrModule(execute.module)].filter(Boolean).join("\n"));
  files.set("README.md", regionReadme(crateName, plan, patchedName));
  for (const [path, content] of files) {
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    ok: true,
    contract,
    warnings: validation.diagnostics,
    files: [...files.keys(), "ts/regions.ts", "ts/tsconfig.json"].map((path) => join(outDir, path)),
  };
}

function regionReadme(crateName: string, plan: RegionPlan, patchedName: string): string {
  const library = crateName.replace(/-/g, "_");
  return `# ${crateName}

Generated by \`crankts extract --region\` from \`${plan.file}#${plan.function}\`. Do not edit; regenerate instead.
The original source file is not modified.

- \`ts/regions.ts\`: the selected regions, outlined verbatim into standalone functions. It is lowered to the
  Kernel IR and is also the exact TypeScript fallback.
- \`ts/${patchedName}\`: a patched copy of the source file that calls the integration instead of the regions.
- \`ts/integration.ts\`: native calls, prepared-state cache (revalidated by a snapshot of the prepare inputs on every
  call), in-out map replay, and the fallback taxonomy (ADDON_MISSING, CONTRACT_GUARD, CRANKTS_KERNEL_TRAP; any
  other failure is rethrown as CRANKTS_INTERNAL_ERROR).
- \`ts/parity.ts\`: region parity (outlined TypeScript vs. integration vs. raw addon + replay).
- \`contract.json\`, \`kernel.ir\`, \`src/lib.rs\`: contract, IR, and Rust/N-API kernel.

Source edits in the patched copy:

${plan.sourceEdits.map((edit) => `- ${edit}`).join("\n")}

Build (macOS shown; use \`lib${library}.so\` on Linux), then import the patched copy instead of the original:

\`\`\`bash
cargo build --release
cp target/release/lib${library}.dylib ${library}.node
node --import tsx ts/parity.ts --iterations 1000
\`\`\`
`;
}

function extractInterned(request: ExtractRequest, alias: string): ExtractResult {
  if (request.batch) {
    return extractBatched(request, alias);
  }
  const separator = request.target.lastIndexOf("#");
  if (separator <= 0) {
    return { ok: false, stage: "select", messages: [`expected <file>#<function>, got '${request.target}'`] };
  }
  const sourceFile = resolve(request.target.slice(0, separator));
  const planned = planInterning({ file: sourceFile, function: request.target.slice(separator + 1), alias });
  if (!planned.ok) {
    return { ok: false, stage: "select", messages: planned.diagnostics };
  }
  const plan = planned.plan;
  if (request.shape === "GRAPH_BATCH" && !plan.graph) {
    return { ok: false, stage: "select", messages: ["GRAPH_BATCH needs a graph parameter (Map<Id, Set<Id>>)"] };
  }
  const outDir = realOutDir(resolve(request.outDir));
  const tsDirectory = join(outDir, "ts");
  mkdirSync(tsDirectory, { recursive: true });
  const crateName = toCrateName(request.crateName ?? `${plan.function}-packed`);
  const generated = emitInternIntegration({ plan, crateName, tsDirectory });
  const packedFile = join(tsDirectory, "packed.ts");
  writeFileSync(packedFile, generated.get("ts/packed.ts") ?? "");
  writeFileSync(join(tsDirectory, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true },
    files: ["packed.ts"],
  }, null, 2)}\n`);

  const execute = lowerTarget(`${packedFile}#${plan.packedName}`);
  if (!execute.ok) {
    return execute.result;
  }
  const derived = deriveKernelContract({
    name: crateName,
    shape: request.shape,
    execute: execute.module,
    ...(request.shape === "GRAPH_BATCH" && plan.graph ? { graph: { ...plan.graph, direction: "directed" as const } } : {}),
  });
  if (!derived.ok) {
    return { ok: false, stage: "verify", messages: derived.errors.map(formatVerifyDiagnostic) };
  }
  const contract: KernelContract = { ...derived.contract, source: `${sourceFile}#${plan.function}` };
  const validation = validateKernelContract(contract);
  if (!validation.lowerable) {
    return {
      ok: false,
      stage: "contract",
      messages: validation.diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`),
    };
  }
  let files: Map<string, string>;
  try {
    files = new Map([...emitRustCrate({ crateName, contract, execute: execute.module }).files, ...generated]);
  } catch (error) {
    if (error instanceof RustBackendError) {
      return { ok: false, stage: "backend", messages: [error.message] };
    }
    throw error;
  }
  const patchedName = basename(sourceFile).replace(/(\.crankts)?\.ts$/, ".crankts.ts");
  files.set(`ts/${patchedName}`, plan.patchedSource("./integration.js", join(tsDirectory, patchedName)));
  files.set("contract.json", `${JSON.stringify(contract, null, 2)}\n`);
  files.set("kernel.ir", printIrModule(execute.module));
  files.set("README.md", `# ${crateName}

Generated by \`crankts extract --intern ${alias}\` from \`${sourceFile}#${plan.function}\`. Do not edit; regenerate instead.
The original source file is not modified.

- \`ts/packed.ts\`: the function over interned indices (CSR graph, bitmaps, ranks): the transformed TypeScript
  variant, lowered to \`kernel.ir\` and \`src/lib.rs\`.
- \`ts/adapters.ts\`: pack/unpack with guards (${plan.guards.concat(["unique, non-empty ids", "graph closed over the universe"]).join("; ")}).
- \`ts/integration.ts\`: pack → native (or packed TypeScript without the addon) → unpack; guard or trap → original.
- \`ts/${patchedName}\`: patched copy whose calls of ${plan.function}() go through the integration.
- \`ts/parity.ts\`: original vs. packed TypeScript vs. native on generated inputs.
`);
  for (const [path, content] of files) {
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    ok: true,
    contract,
    warnings: validation.diagnostics,
    files: [...files.keys(), "ts/tsconfig.json"].map((path) => join(outDir, path)),
  };
}

function extractBatched(request: ExtractRequest, alias: string): ExtractResult {
  const separator = request.target.lastIndexOf("#");
  if (separator <= 0) {
    return { ok: false, stage: "select", messages: [`expected <file>#<function>, got '${request.target}'`] };
  }
  if (request.shape !== "GRAPH_BATCH") {
    return { ok: false, stage: "select", messages: ["--batch produces a GRAPH_BATCH kernel"] };
  }
  const sourceFile = resolve(request.target.slice(0, separator));
  const planned = planBatchInterning({ file: sourceFile, function: request.target.slice(separator + 1), alias });
  if (!planned.ok) {
    return { ok: false, stage: "select", messages: planned.diagnostics };
  }
  const plan = planned.plan;
  const outDir = realOutDir(resolve(request.outDir));
  const tsDirectory = join(outDir, "ts");
  mkdirSync(tsDirectory, { recursive: true });
  const patchedName = basename(sourceFile).replace(/(\.crankts)?\.ts$/, ".crankts.ts");
  const patched = plan.patchedSource("./integration.js", join(tsDirectory, patchedName));
  if (patched.text === "" || patched.diagnostics.some((message) => message.startsWith("call at") || message.startsWith("no batchable"))) {
    return { ok: false, stage: "select", messages: [...patched.diagnostics] };
  }
  const crateName = toCrateName(request.crateName ?? `${plan.function}-batch`);
  const generated = emitBatchIntegration({ plan, crateName, tsDirectory });
  const packedFile = join(tsDirectory, "packed.ts");
  writeFileSync(packedFile, generated.get("ts/packed.ts") ?? "");
  // The patched copy is part of the project too, so later passes (e.g. --intern on another function) can
  // run on it: passes can be chained, each patching the previous copy.
  writeFileSync(join(tsDirectory, patchedName), patched.text);
  writeFileSync(join(tsDirectory, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true },
    files: ["packed.ts", patchedName],
  }, null, 2)}\n`);

  const execute = lowerTarget(`${packedFile}#${plan.batchName}`);
  if (!execute.ok) {
    return execute.result;
  }
  const derived = deriveKernelContract({
    name: crateName,
    shape: "GRAPH_BATCH",
    execute: execute.module,
    graph: { offsets: `${plan.graph}__offsets`, neighbors: `${plan.graph}__neighbors`, direction: "directed" },
  });
  if (!derived.ok) {
    return { ok: false, stage: "verify", messages: derived.errors.map(formatVerifyDiagnostic) };
  }
  const contract: KernelContract = { ...derived.contract, source: `${sourceFile}#${plan.function}` };
  const validation = validateKernelContract(contract);
  if (!validation.lowerable) {
    return {
      ok: false,
      stage: "contract",
      messages: validation.diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`),
    };
  }
  let files: Map<string, string>;
  try {
    files = new Map([...emitRustCrate({ crateName, contract, execute: execute.module }).files, ...generated]);
  } catch (error) {
    if (error instanceof RustBackendError) {
      return { ok: false, stage: "backend", messages: [error.message] };
    }
    throw error;
  }
  files.set(`ts/${patchedName}`, patched.text);
  files.set("contract.json", `${JSON.stringify(contract, null, 2)}\n`);
  files.set("kernel.ir", printIrModule(execute.module));
  files.set("README.md", `# ${crateName}

Generated by \`crankts extract --intern ${alias} --batch\` from \`${sourceFile}#${plan.function}\`. Do not edit; regenerate instead.
The original source file is not modified.

- \`ts/packed.ts\`: all groups in one call over interned indices (CSR graph, hoisted id maps reset per group,
  struct-of-arrays frames, streaming argmin): the transformed TypeScript variant, lowered to \`kernel.ir\` and \`src/lib.rs\`.
- \`ts/adapters.ts\`: graph sealing (upstream packing), group packing and unpacking with guards (${plan.guards.join("; ")}).
- \`ts/integration.ts\`: \`${plan.function}Batch(original, groups, graph)\`: pack → native (or packed TypeScript) → unpack; guard or trap → original per group.
- \`ts/${patchedName}\`: patched copy: ${plan.function}() call sites batched, the graph sealed after its producer.${patched.diagnostics.length > 0 ? `\n  Notes: ${patched.diagnostics.join("; ")}` : ""}
- \`ts/parity.ts\`: original per group vs. packed TypeScript vs. native batch on generated inputs.
`);
  for (const [path, content] of files) {
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    ok: true,
    contract,
    warnings: validation.diagnostics,
    files: [...files.keys(), "ts/tsconfig.json"].map((path) => join(outDir, path)),
  };
}

type Lowered =
  | { readonly ok: true; readonly module: IrModule; readonly file: string }
  | { readonly ok: false; readonly result: ExtractResult };

function lowerTarget(target: string): Lowered {
  const separator = target.lastIndexOf("#");
  if (separator <= 0 || separator === target.length - 1) {
    return { ok: false, result: { ok: false, stage: "select", messages: [`expected <file>#<function>, got '${target}'`] } };
  }
  const file = resolve(target.slice(0, separator));
  const name = target.slice(separator + 1);
  const facade = createCompilerFacade(file);
  const candidates = collectFunctions(facade).definitions.filter((definition) => (
    definition.absoluteFile === file && definition.name === name
  ));
  const declaration = candidates
    .map((definition) => ({ definition, node: definition.node }))
    .find((candidate): candidate is { definition: typeof candidate.definition; node: ts.FunctionDeclaration } => (
      candidate.definition.compilerFacade.typescript.isFunctionDeclaration(candidate.node)
    ));
  if (!declaration) {
    return {
      ok: false,
      result: {
        ok: false,
        stage: "select",
        messages: [candidates.length > 0
          ? `${name} in ${file} is not a function declaration`
          : `no function ${name} found in ${file}`],
      },
    };
  }
  const typescript = declaration.definition.compilerFacade.typescript;
  const exported = declaration.node.modifiers?.some((modifier) => modifier.kind === typescript.SyntaxKind.ExportKeyword) ?? false;
  if (!exported) {
    return {
      ok: false,
      result: { ok: false, stage: "select", messages: [`${name} must be exported so the generated wrapper can fall back to it`] },
    };
  }
  const lowered = lowerKernel(declaration.node, declaration.definition.compilerFacade, { projectRoot: facade.projectRoot });
  if (!lowered.ok) {
    return { ok: false, result: { ok: false, stage: "lower", messages: lowered.diagnostics.map(formatLoweringDiagnostic) } };
  }
  return { ok: true, module: lowered.module, file };
}

/** Symlinked paths (e.g. macOS /tmp → /private/tmp) would break relative imports at runtime. */
function realOutDir(outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  return realpathSync(outDir);
}

/** NodeNext-style relative import (`.ts` → `.js`) from `fromDirectory` to `file`. */
function importSpecifier(fromDirectory: string, file: string): string {
  const path = relative(fromDirectory, file).split(sep).join("/").replace(/\.ts$/, ".js").replace(/\.mts$/, ".mjs").replace(/\.tsx$/, ".js");
  return path.startsWith(".") ? path : `./${path}`;
}

function formatLoweringDiagnostic(diagnostic: LoweringDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.construct}: ${diagnostic.message}`;
}

function formatVerifyDiagnostic(diagnostic: VerifyDiagnostic): string {
  return `${diagnostic.function}: ${diagnostic.message}`;
}

function toCrateName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase();
}

function readme(crateName: string, contract: KernelContract): string {
  const library = crateName.replace(/-/g, "_");
  return `# ${crateName}

Generated by \`crankts extract\` from \`${contract.source}\` (shape \`${contract.shape}\`). Do not edit; regenerate instead.

- \`contract.json\`: the derived, validated kernel contract and its proof obligations.
- \`kernel.ir\`: the Kernel IR the crate was generated from.
- \`src/lib.rs\`: the Rust/N-API implementation.
- \`ts/\`: the TypeScript wrapper (same signature as the original) and \`parity.ts\`, a differential parity runner.

Build (macOS shown; use \`lib${library}.so\` on Linux):

\`\`\`bash
cargo build --release
cp target/release/lib${library}.dylib ${library}.node
\`\`\`

Import the kernel from \`ts/\` instead of the original module. The wrapper loads \`${library}.node\` (or \`$CRANKTS_ADDON_${library.toUpperCase()}\`) and runs the original TypeScript function whenever the addon is missing, a check in the kernel traps (\`CRANKTS_KERNEL_TRAP\`), or the call fails otherwise. \`nativeStatus\` reports native calls and fallbacks; \`CRANKTS_ITERATION_BUDGET\` limits while-loop iterations per call (TERMINATION guard).

Check parity after every build (exit code 1 on any mismatch):

\`\`\`bash
node --import tsx ts/parity.ts --iterations 1000 --seed 1 [--cases cases.json]
\`\`\`

Fuzzed inputs often trap on malformed structures (e.g. invalid CSR); the report's \`nativeAgreed\` count shows how many cases exercised the native path. Supply realistic cases with \`--cases\`.
`;
}
