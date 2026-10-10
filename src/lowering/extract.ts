import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
