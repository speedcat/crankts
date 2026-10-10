import type { KernelContract } from "./contract.js";
import type { IrFunction, IrModule, IrType } from "./ir.js";

/**
 * TypeScript wrapper, parity runner, and benchmark generation (v0.2.3, taxonomy and gate v0.2.4).
 *
 * The wrapper keeps the original function's signature. Fallback to the original TypeScript function
 * is allowed for exactly three reasons:
 * - ADDON_MISSING: the addon could not be loaded;
 * - CONTRACT_GUARD: an argument is outside the contract's domain (checked in TypeScript first);
 * - KERNEL_TRAP: a checked operation in the kernel trapped (`CRANKTS_KERNEL_TRAP`).
 * Any other native failure is a CrankTS bug and is rethrown as `CRANKTS_INTERNAL_ERROR`, never masked.
 *
 * PREPARED_STATE: `prepare` returns a view typed as the original state. It owns the native handle and
 * a snapshot of the prepare inputs; its fields are lazy getters that build the TypeScript state on
 * first access. A state whose fields were observed may have been mutated by the caller, so from then
 * on it always runs in TypeScript (sound without proving anything about callers).
 */

export interface WrapperRequest {
  readonly contract: KernelContract;
  readonly crateName: string;
  readonly execute: IrModule;
  readonly prepare?: IrModule;
  /** Import specifier of the original source module, relative to the generated `ts/` directory. */
  readonly sourceImport: string;
}

/** Type descriptions the parity runner uses to generate inputs. */
export type InputSpec =
  | { readonly kind: "f64" | "bool" | "string" | "handle" }
  | { readonly kind: "array"; readonly element: InputSpec; readonly storage: string };

export function emitTypeScriptWrapper(request: WrapperRequest): ReadonlyMap<string, string> {
  const execute = entryOf(request.execute);
  const prepare = request.prepare ? entryOf(request.prepare) : undefined;
  const library = request.crateName.replace(/-/g, "_");
  const envVariable = `CRANKTS_ADDON_${library.toUpperCase()}`;
  const stateType = prepare?.returnType.kind === "struct" ? prepare.returnType.name : undefined;
  const handleIndex = stateType
    ? execute.params.findIndex((param) => param.type.kind === "struct" && param.type.name === stateType)
    : -1;
  const stateFields = stateType
    ? request.prepare?.structs.find((struct) => struct.name === stateType)?.fields.map((field) => field.name) ?? []
    : [];
  const output = request.contract.outputs[0]?.type;
  const materialize = output?.kind === "typedArray" && execute.returnType.kind === "array" && execute.returnType.storage === "dynamic";
  const executeSpecs = execute.params.map((param, index): InputSpec => (index === handleIndex ? { kind: "handle" } : inputSpec(param.type)));
  const prepareSpecs = prepare?.params.map((param) => inputSpec(param.type)) ?? [];

  const context: Context = { request, library, envVariable, materialize };
  const wrapper = prepare
    ? preparedWrapper(context, execute, prepare, handleIndex, stateFields, executeSpecs, prepareSpecs)
    : batchWrapper(context, execute, executeSpecs);
  const spec = {
    mode: prepare ? "prepared" : "batch",
    entry: execute.name,
    params: executeSpecs,
    ...(prepare ? { prepare: prepare.name, prepareParams: prepareSpecs, handleIndex } : {}),
  };
  return new Map([
    [`ts/${execute.name}.ts`, wrapper],
    ["ts/parity.ts", parityRunner(request, execute, prepare, JSON.stringify(spec, null, 2))],
    ["ts/benchmark.ts", benchmarkRunner(request, execute, prepare, JSON.stringify(spec, null, 2))],
  ]);
}

interface Context {
  readonly request: WrapperRequest;
  readonly library: string;
  readonly envVariable: string;
  readonly materialize: boolean;
}

function entryOf(module: IrModule): IrFunction {
  const entry = module.functions.find((fn) => fn.name === module.entry);
  if (!entry) {
    throw new Error(`IR module has no entry ${module.entry}`);
  }
  return entry;
}

export function inputSpec(type: IrType): InputSpec {
  switch (type.kind) {
    case "f64":
    case "bool":
    case "string":
      return { kind: type.kind };
    case "array":
      return { kind: "array", element: inputSpec(type.element), storage: type.storage };
    default:
      throw new Error(`${type.kind} parameters cannot be generated`);
  }
}

/** TypeScript expression checking that `value` is inside the boundary domain of `spec`. */
export function guardExpression(spec: InputSpec, value: string): string {
  switch (spec.kind) {
    case "f64":
      return `typeof ${value} === "number"`;
    case "bool":
      return `typeof ${value} === "boolean"`;
    case "string":
      return `typeof ${value} === "string"`;
    case "handle":
      return "true";
    case "array": {
      if (spec.storage !== "dynamic") {
        const constructor = { u8: "Uint8Array", u32: "Uint32Array", i32: "Int32Array", f64: "Float64Array" }[spec.storage];
        return `${value} instanceof ${constructor}`;
      }
      const element = spec.element.kind === "f64" ? "number" : spec.element.kind === "bool" ? "boolean" : "string";
      return `isArrayOf(${value}, "${element}")`;
    }
  }
}

function guardFunction(name: string, specs: readonly InputSpec[]): string {
  const checks = specs.map((spec, index) => guardExpression(spec, `args[${index}]`));
  return `/** CONTRACT_GUARD: arguments the addon accepts; anything else runs the original TypeScript. */
function ${name}(args: readonly unknown[]): boolean {
  return args.length === ${specs.length}${checks.map((check) => `\n    && ${check}`).join("")};
}`;
}

function header(context: Context): string {
  const { request, library, envVariable } = context;
  return `// Generated by CrankTS (TypeScript wrapper). Do not edit; regenerate with \`crankts extract\`.
// Contract: ${request.contract.name} (${request.contract.shape}). The original TypeScript function remains the
// reference. It runs when the addon is missing (ADDON_MISSING), an argument is outside the contract
// (CONTRACT_GUARD), or the kernel traps (CRANKTS_KERNEL_TRAP). Any other native failure is a CrankTS
// bug and is rethrown as CRANKTS_INTERNAL_ERROR.
// Addon path: $${envVariable} or ../${library}.node next to this directory.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";`;
}

function runtime(context: Context): string {
  return wrapperRuntime(context.library, context.envVariable, context.materialize);
}

/** Addon loading, status counters, and the fallback taxonomy shared by all generated integrations. */
export function wrapperRuntime(library: string, envVariable: string, materialize: boolean): string {
  return `const TRAP_PREFIX = "CRANKTS_KERNEL_TRAP";

/** Observable wrapper state, for tests, benchmarks, and diagnostics. */
export const nativeStatus = {
  loaded: false,
  loadError: undefined as string | undefined,
  nativeCalls: 0,
  /** Fallbacks: kernel traps and arguments outside the contract. */
  traps: 0,
  contractGuards: 0,
  /** Rethrown as CRANKTS_INTERNAL_ERROR (never a fallback). */
  internalErrors: 0,
  /** Execute calls whose state did not come from this wrapper's prepare. */
  foreignStates: 0,
  /** Execute calls on states whose fields the caller has read (and may have mutated). */
  observedStates: 0,
};

type NativeAddon = Record<string, (...args: unknown[]) => unknown>;

/** The loaded addon, exposed for the generated parity runner and benchmark. */
export const nativeAddon: NativeAddon | undefined = loadNative();

function loadNative(): NativeAddon | undefined {
  const path = process.env["${envVariable}"] ?? fileURLToPath(new URL("../${library}.node", import.meta.url));
  try {
    const addon = createRequire(import.meta.url)(path) as NativeAddon;
    const budget = Number(process.env["CRANKTS_ITERATION_BUDGET"]);
    if (Number.isFinite(budget)) {
      addon["__setIterationBudget"]?.(budget);
    }
    nativeStatus.loaded = true;
    return addon;
  } catch (error) {
    nativeStatus.loadError = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

/** Returns normally for a trap (fallback allowed); throws CRANKTS_INTERNAL_ERROR otherwise. */
function handleNativeFailure(error: unknown, functionName: string): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(TRAP_PREFIX)) {
    nativeStatus.traps += 1;
    return;
  }
  nativeStatus.internalErrors += 1;
  const internal = new Error(
    message.startsWith("CRANKTS_INTERNAL_ERROR") ? message : \`CRANKTS_INTERNAL_ERROR in \${functionName}: \${message}\`,
    { cause: error },
  );
  throw internal;
}

function isArrayOf(value: unknown, type: string): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== type) {
      return false;
    }
  }
  return true;
}

/** Converts the addon's result to the original's return representation. */
export function materializeResult(value: unknown): unknown {
  ${materialize ? "return Array.from(value as ArrayLike<number>);" : "return value;"}
}`;
}

function batchWrapper(context: Context, execute: IrFunction, specs: readonly InputSpec[]): string {
  const name = execute.name;
  return `${header(context)}
import { ${name} as original_${name} } from "${context.request.sourceImport}";

${runtime(context)}

${guardFunction("inContract", specs)}

export function ${name}(...args: Parameters<typeof original_${name}>): ReturnType<typeof original_${name}> {
  const kernel = nativeAddon?.["${name}"];
  if (kernel) {
    if (!inContract(args)) {
      nativeStatus.contractGuards += 1;
    } else {
      try {
        const result = kernel(...args);
        nativeStatus.nativeCalls += 1;
        return materializeResult(result) as ReturnType<typeof original_${name}>;
      } catch (error) {
        handleNativeFailure(error, "${name}");
      }
    }
  }
  return original_${name}(...args);
}
`;
}

function preparedWrapper(
  context: Context,
  execute: IrFunction,
  prepare: IrFunction,
  handleIndex: number,
  stateFields: readonly string[],
  executeSpecs: readonly InputSpec[],
  prepareSpecs: readonly InputSpec[],
): string {
  const run = execute.name;
  const make = prepare.name;
  return `${header(context)}
import { ${make} as original_${make}, ${run} as original_${run} } from "${context.request.sourceImport}";

${runtime(context)}

${guardFunction("prepareInContract", prepareSpecs)}

${guardFunction("executeInContract", executeSpecs)}

type State = ReturnType<typeof original_${make}>;

interface NativeState {
  readonly handle: unknown;
  /** Snapshot of the prepare arguments, so a late TypeScript state equals one built at prepare time. */
  readonly inputs: Parameters<typeof original_${make}>;
  state: State | undefined;
  observed: boolean;
}

const nativeStates = new WeakMap<object, NativeState>();

function snapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return [...value] as T;
  }
  return ArrayBuffer.isView(value) && "slice" in value ? (value as unknown as { slice(): T }).slice() : value;
}

function typescriptState(slot: NativeState): State {
  slot.state ??= original_${make}(...slot.inputs);
  return slot.state;
}

export function ${make}(...args: Parameters<typeof original_${make}>): State {
  const kernel = nativeAddon?.["${make}"];
  if (!kernel) {
    return original_${make}(...args);
  }
  if (!prepareInContract(args)) {
    nativeStatus.contractGuards += 1;
    return original_${make}(...args);
  }
  const inputs = args.map(snapshot) as Parameters<typeof original_${make}>;
  let handle: unknown;
  try {
    handle = kernel(...inputs);
    nativeStatus.nativeCalls += 1;
  } catch (error) {
    handleNativeFailure(error, "${make}");
    return original_${make}(...args);
  }
  const slot: NativeState = { handle, inputs, state: undefined, observed: false };
  const view = {} as State;
  for (const field of ${JSON.stringify(stateFields)} as const) {
    Object.defineProperty(view, field, {
      enumerable: true,
      get: () => {
        slot.observed = true;
        return typescriptState(slot)[field as keyof State];
      },
    });
  }
  nativeStates.set(view as object, slot);
  return view;
}

export function ${run}(...args: Parameters<typeof original_${run}>): ReturnType<typeof original_${run}> {
  const slot = nativeStates.get(args[${handleIndex}] as object);
  const kernel = nativeAddon?.["${run}"];
  if (kernel && slot && !slot.observed) {
    if (!executeInContract(args)) {
      nativeStatus.contractGuards += 1;
    } else {
      const nativeArgs: unknown[] = [...args];
      nativeArgs[${handleIndex}] = slot.handle;
      try {
        const result = kernel(...nativeArgs);
        nativeStatus.nativeCalls += 1;
        return materializeResult(result) as ReturnType<typeof original_${run}>;
      } catch (error) {
        handleNativeFailure(error, "${run}");
      }
    }
  } else if (kernel && !slot) {
    nativeStatus.foreignStates += 1;
  } else if (kernel && slot?.observed) {
    nativeStatus.observedStates += 1;
  }
  if (!slot) {
    return original_${run}(...args);
  }
  const typescriptArgs = [...args] as Parameters<typeof original_${run}>;
  typescriptArgs[${handleIndex}] = typescriptState(slot);
  return original_${run}(...typescriptArgs);
}
`;
}

// --- shared generated helpers ------------------------------------------------------------------

const SHARED_HELPERS = `type Spec = { readonly kind: string; readonly element?: Spec; readonly storage?: string };
type Fn = (...args: unknown[]) => unknown;

function invoke(functions: Record<string, Fn>, prepareArgs: readonly unknown[] | undefined, args: readonly unknown[], clone: boolean): unknown {
  const copy = (values: readonly unknown[]): unknown[] => (clone ? values.map(cloneValue) : [...values]);
  if (SPEC.mode === "batch") {
    return call(functions, SPEC.entry, copy(args));
  }
  const prepared = SPEC as unknown as { prepare: string; handleIndex: number };
  const state = call(functions, prepared.prepare, copy(prepareArgs ?? []));
  const callArgs = copy(args);
  callArgs[prepared.handleIndex] = state;
  return call(functions, SPEC.entry, callArgs);
}

function call(functions: Record<string, Fn>, name: string, args: unknown[]): unknown {
  const fn = functions[name];
  if (!fn) {
    throw new Error(\`missing function \${name}\`);
  }
  return fn(...args);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (ArrayBuffer.isView(value) && "slice" in value) {
    return (value as unknown as { slice(): unknown }).slice();
  }
  return value;
}

function typedArray(storage: string, values: readonly number[]): unknown {
  switch (storage) {
    case "u8":
      return Uint8Array.from(values);
    case "u32":
      return Uint32Array.from(values);
    case "i32":
      return Int32Array.from(values);
    default:
      return Float64Array.from(values);
  }
}

/** Tagged JSON: {"$u32": [...]}, {"$u8": ...}, {"$i32": ...}, {"$f64": ...}, {"$number": "NaN" | "-0" | "Infinity" | "-Infinity"}. */
export function decodeCase(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeCase);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const storage of ["u8", "u32", "i32", "f64"]) {
      if (Array.isArray(record[\`$\${storage}\`])) {
        return typedArray(storage, record[\`$\${storage}\`] as number[]);
      }
    }
    if (typeof record["$number"] === "string") {
      return record["$number"] === "-0" ? -0 : Number(record["$number"]);
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decodeCase(entry)]));
  }
  return value;
}

function option(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}`;

// --- parity runner ----------------------------------------------------------------------------

function parityRunner(request: WrapperRequest, execute: IrFunction, prepare: IrFunction | undefined, spec: string): string {
  const imports = prepare ? `${prepare.name}, ${execute.name}` : execute.name;
  const originals = prepare
    ? `{ ${prepare.name}: original.${prepare.name}, ${execute.name}: original.${execute.name} }`
    : `{ ${execute.name}: original.${execute.name} }`;
  return `// Generated by CrankTS (differential parity runner). Do not edit; regenerate with \`crankts extract\`.
// Properties checked for every case:
//   1. the wrapper's outcome (value or exception) equals the original TypeScript function's;
//   2. the native addon either traps (CRANKTS_KERNEL_TRAP) or returns exactly the original's value.
// Generated cases come in four categories: normal, boundary (NaN, -0, 2^31, empty), strings (non-ASCII,
// astral, lone surrogates), and trapDomain (values outside index ranges). Supplied cases are reported
// as "supplied". Run: node --import tsx parity.ts [--iterations 1000] [--seed 1] [--cases cases.json]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as original from "${request.sourceImport}";
import { ${imports}, materializeResult, nativeAddon, nativeStatus } from "./${execute.name}.js";

const SPEC = ${spec} as const;

${SHARED_HELPERS}

export const CATEGORIES = ["normal", "boundary", "strings", "trapDomain"] as const;
export type Category = (typeof CATEGORIES)[number] | "supplied";

export interface ParityCase {
  readonly args: readonly unknown[];
  readonly prepareArgs?: readonly unknown[];
  readonly category?: Category;
}

export interface CategoryReport {
  cases: number;
  nativeAgreed: number;
  nativeTrapped: number;
  mismatches: number;
}

export interface ParityReport {
  readonly cases: number;
  readonly nativeAvailable: boolean;
  readonly nativeAgreed: number;
  readonly nativeTrapped: number;
  readonly byCategory: Readonly<Record<string, CategoryReport>>;
  readonly mismatches: readonly { readonly kind: "wrapper" | "native"; readonly category: Category; readonly detail: string }[];
}

const wrapped = { ${imports} } as unknown as Record<string, Fn>;
const originals = ${originals} as unknown as Record<string, Fn>;

export function runParity(options: { readonly iterations?: number; readonly seed?: number; readonly cases?: readonly ParityCase[] } = {}): ParityReport {
  const next = random(options.seed ?? 1);
  const iterations = options.iterations ?? 1000;
  const cases: ParityCase[] = [
    ...(options.cases ?? []).map((parityCase) => ({ ...parityCase, category: parityCase.category ?? ("supplied" as const) })),
    ...Array.from({ length: iterations }, (_, index) => generateCase(next, CATEGORIES[index % CATEGORIES.length] ?? "normal")),
  ];
  let nativeAgreed = 0;
  let nativeTrapped = 0;
  const byCategory: Record<string, CategoryReport> = {};
  const mismatches: { kind: "wrapper" | "native"; category: Category; detail: string }[] = [];
  for (const parityCase of cases) {
    const category = parityCase.category ?? "supplied";
    const report = (byCategory[category] ??= { cases: 0, nativeAgreed: 0, nativeTrapped: 0, mismatches: 0 });
    report.cases += 1;
    const expected = outcome(() => invoke(originals, parityCase.prepareArgs, parityCase.args, true));
    const viaWrapper = outcome(() => invoke(wrapped, parityCase.prepareArgs, parityCase.args, true));
    if (!sameOutcome(expected, viaWrapper)) {
      report.mismatches += 1;
      mismatches.push({ kind: "wrapper", category, detail: describe(parityCase, expected, viaWrapper) });
    }
    if (nativeAddon) {
      const direct = outcome(() => materializeResult(invoke(nativeAddon ?? {}, parityCase.prepareArgs, parityCase.args, true)));
      if (direct.threw && String(direct.value).startsWith("CRANKTS_KERNEL_TRAP")) {
        nativeTrapped += 1;
        report.nativeTrapped += 1;
      } else if (sameOutcome(expected, direct) && !direct.threw) {
        nativeAgreed += 1;
        report.nativeAgreed += 1;
      } else {
        report.mismatches += 1;
        mismatches.push({ kind: "native", category, detail: describe(parityCase, expected, direct) });
      }
    }
  }
  return { cases: cases.length, nativeAvailable: nativeAddon !== undefined, nativeAgreed, nativeTrapped, byCategory, mismatches };
}

interface Outcome {
  readonly threw: boolean;
  readonly value: unknown;
}

function outcome(run: () => unknown): Outcome {
  try {
    return { threw: false, value: run() };
  } catch (error) {
    return { threw: true, value: error instanceof Error ? error.message : error };
  }
}

function sameOutcome(left: Outcome, right: Outcome): boolean {
  // Both must throw or both must return equal values. A wrapper that throws CRANKTS_INTERNAL_ERROR
  // where the original returns is a mismatch, so codegen bugs cannot hide behind the fallback.
  return left.threw === right.threw && (left.threw || same(left.value, right.value));
}

export function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    return left.constructor === right.constructor && same([...(left as unknown as Iterable<unknown>)], [...(right as unknown as Iterable<unknown>)]);
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => same(value, right[index]));
  }
  if (left instanceof Map && right instanceof Map) {
    return left.size === right.size && [...left].every(([key, value]) => right.has(key) && same(value, right.get(key)));
  }
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

function describe(parityCase: ParityCase, expected: Outcome, actual: Outcome): string {
  return JSON.stringify({ case: encode(parityCase), expected: encode(expected), actual: encode(actual) }).slice(0, 2000);
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const BOUNDARY_NUMBERS = [0, -0, 1, -1, 0.5, 2 ** 31, 2 ** 32, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
const ASCII_UNITS = ["a", "B", "z", "Z", "0", "9", "_", " ", ".", "-", "graph", "Node", "KWX", "node_1"];
const UNICODE_UNITS = ["é", "ß", "İ", "😀", "\\uD800", "\\uDC00", "\\u0000", "ﬀ"];

function generate(spec: Spec, next: () => number, category: Category, depth = 0): unknown {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  switch (spec.kind) {
    case "f64":
      if (category === "boundary") return pick(BOUNDARY_NUMBERS);
      if (category === "trapDomain") return pick([0.5, -3, 1e9, 2 ** 40, Math.floor(next() * 50)]);
      return Math.floor(next() * 12);
    case "bool":
      return next() < 0.5;
    case "string": {
      if (category === "boundary") return pick(["", "a", "\\uD800", "😀"]);
      const units = category === "strings" || category === "trapDomain" ? [...ASCII_UNITS, ...UNICODE_UNITS, ...UNICODE_UNITS] : ASCII_UNITS;
      return Array.from({ length: Math.floor(next() * 12) }, () => pick(units)).join("");
    }
    case "array": {
      const length = category === "boundary" ? pick([0, 1]) : Math.floor(next() * (depth === 0 ? 12 : 4));
      if (spec.storage && spec.storage !== "dynamic") {
        const range = category === "trapDomain" ? (length + 2) * 3 : length + 1;
        return typedArray(spec.storage, Array.from({ length }, () => Math.floor(next() * range)));
      }
      return Array.from({ length }, () => generate(spec.element ?? { kind: "f64" }, next, category, depth + 1));
    }
    default:
      return undefined;
  }
}

function generateCase(next: () => number, category: Category): ParityCase {
  const args = SPEC.params.map((spec) => generate(spec as Spec, next, category));
  const prepareParams = (SPEC as unknown as { prepareParams?: readonly Spec[] }).prepareParams;
  return prepareParams
    ? { args, prepareArgs: prepareParams.map((spec) => generate(spec, next, category)), category }
    : { args, category };
}

function encode(value: unknown): unknown {
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { $number: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (ArrayBuffer.isView(value)) {
    const tag = { Uint8Array: "$u8", Uint32Array: "$u32", Int32Array: "$i32", Float64Array: "$f64" }[value.constructor.name] ?? "$f64";
    return { [tag]: [...(value as unknown as Iterable<number>)] };
  }
  if (Array.isArray(value)) {
    return value.map(encode);
  }
  if (value instanceof Map) {
    return { $map: [...value].map(([key, entry]) => [key, encode(entry)]) };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]));
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const casesPath = option("--cases");
  const cases = casesPath ? (decodeCase(JSON.parse(readFileSync(casesPath, "utf8"))) as ParityCase[]) : [];
  const report = runParity({ iterations: Number(option("--iterations") ?? 1000), seed: Number(option("--seed") ?? 1), cases });
  console.log(JSON.stringify({ ...report, mismatches: report.mismatches.slice(0, 5), nativeStatus }, null, 2));
  process.exitCode = report.mismatches.length > 0 ? 1 : 0;
}
`;
}

// --- benchmark and acceptance gate ------------------------------------------------------------

function benchmarkRunner(request: WrapperRequest, execute: IrFunction, prepare: IrFunction | undefined, spec: string): string {
  const imports = prepare ? `${prepare.name}, ${execute.name}` : execute.name;
  const originals = prepare
    ? `{ ${prepare.name}: original.${prepare.name}, ${execute.name}: original.${execute.name} }`
    : `{ ${execute.name}: original.${execute.name} }`;
  return `// Generated by CrankTS (benchmark and acceptance gate). Do not edit; regenerate with \`crankts extract\`.
// Times the original TypeScript, the wrapper (guards + addon + result materialization), the raw addon
// call (incl. N-API conversion), the Rust-side kernel compute (__lastKernelNanos), and an optional
// reference implementation (e.g. a handwritten PoC), then evaluates the acceptance gate:
//   correctness     parity (wrapper ≡ original, native ≡ original or trap) on supplied + fuzzed cases
//   performance     wrapper total < original total
//   backendQuality  addon call <= ${"`"}maxReferenceRatio${"`"} × reference call (only with a reference)
//   boundary        (wrapper - kernel) / (original - kernel) <= ${"`"}maxBoundaryShare${"`"}
// Run: node --import tsx benchmark.ts --cases cases.json [--reference addon.node] [--runs 5]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import * as original from "${request.sourceImport}";
import { runParity, type ParityCase, type ParityReport } from "./parity.js";
import { ${imports}, nativeAddon, nativeStatus } from "./${execute.name}.js";

const SPEC = ${spec} as const;

${SHARED_HELPERS}

/** One workload unit: a prepare (PREPARED_STATE only) followed by \`calls\` executes. */
export interface BenchmarkCase {
  readonly prepareArgs?: readonly unknown[];
  readonly calls: readonly (readonly unknown[])[];
}

export interface Thresholds {
  readonly maxReferenceRatio: number;
  readonly maxBoundaryShare: number;
}

export interface Spread {
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

export interface BenchmarkReport {
  readonly runs: number;
  readonly calls: number;
  readonly originalMs: Spread;
  readonly wrapperMs: Spread;
  readonly nativeCallMs: Spread;
  readonly kernelMs: Spread;
  readonly referenceMs?: Spread;
  readonly netSavedMs: number;
  readonly boundaryShare: number;
  readonly referenceRatio?: number;
  readonly parity: Pick<ParityReport, "cases" | "nativeAgreed" | "nativeTrapped" | "byCategory"> & { readonly mismatches: number };
  readonly gate: Readonly<Record<"correctness" | "performance" | "backendQuality" | "boundary", "PASS" | "FAIL" | "NOT_EVALUATED">>;
  readonly accepted: boolean;
  readonly nativeStatus: typeof nativeStatus;
}

const wrapped = { ${imports} } as unknown as Record<string, Fn>;
const originals = ${originals} as unknown as Record<string, Fn>;

export function runBenchmark(options: {
  readonly cases: readonly BenchmarkCase[];
  readonly runs?: number;
  readonly warmup?: number;
  readonly reference?: Record<string, Fn>;
  readonly thresholds?: Partial<Thresholds>;
  readonly parityIterations?: number;
  readonly paritySample?: number;
}): BenchmarkReport {
  if (!nativeAddon) {
    throw new Error(\`benchmark needs the addon: \${nativeStatus.loadError ?? "not loaded"}\`);
  }
  const thresholds: Thresholds = { maxReferenceRatio: 2, maxBoundaryShare: 0.5, ...options.thresholds };
  const runs = options.runs ?? 5;
  const warmup = options.warmup ?? 1;
  const kernelNanos = nativeAddon["__lastKernelNanos"] as () => number;
  const samples: Record<string, number[]> = { original: [], wrapper: [], native: [], kernel: [], reference: [] };

  for (let run = 0; run < warmup + runs; run += 1) {
    const measured = run >= warmup;
    const time = (implementation: Record<string, Fn>): number => {
      const start = performance.now();
      for (const workload of options.cases) {
        runWorkload(implementation, workload);
      }
      return performance.now() - start;
    };
    const originalMs = time(originals);
    const wrapperMs = time(wrapped);
    let kernel = 0;
    const nativeStart = performance.now();
    for (const workload of options.cases) {
      runWorkload(nativeAddon, workload, () => {
        kernel += kernelNanos() / 1e6;
      });
    }
    const nativeMs = performance.now() - nativeStart;
    const referenceMs = options.reference ? time(options.reference) : undefined;
    if (measured) {
      samples.original?.push(originalMs);
      samples.wrapper?.push(wrapperMs);
      samples.native?.push(nativeMs);
      samples.kernel?.push(kernel);
      if (referenceMs !== undefined) samples.reference?.push(referenceMs);
    }
  }

  const sample = options.paritySample ?? 200;
  const parityCases: ParityCase[] = options.cases.flatMap((workload) => workload.calls.map((args) => ({
    args,
    ...(workload.prepareArgs ? { prepareArgs: workload.prepareArgs } : {}),
  }))).filter((_, index, all) => index % Math.max(1, Math.ceil(all.length / sample)) === 0);
  const parity = runParity({ cases: parityCases, iterations: options.parityIterations ?? 400, seed: 7 });

  const originalMs = spread(samples.original ?? []);
  const wrapperMs = spread(samples.wrapper ?? []);
  const nativeCallMs = spread(samples.native ?? []);
  const kernelMs = spread(samples.kernel ?? []);
  const referenceMs = options.reference ? spread(samples.reference ?? []) : undefined;
  const netSavedMs = originalMs.median - wrapperMs.median;
  const potential = originalMs.median - kernelMs.median;
  const boundaryShare = potential > 0 ? (wrapperMs.median - kernelMs.median) / potential : Number.POSITIVE_INFINITY;
  const referenceRatio = referenceMs ? nativeCallMs.median / referenceMs.median : undefined;
  const gate = {
    correctness: parity.mismatches.length === 0 ? "PASS" : "FAIL",
    performance: netSavedMs > 0 ? "PASS" : "FAIL",
    backendQuality: referenceRatio === undefined ? "NOT_EVALUATED" : referenceRatio <= thresholds.maxReferenceRatio ? "PASS" : "FAIL",
    boundary: boundaryShare <= thresholds.maxBoundaryShare ? "PASS" : "FAIL",
  } as const;
  return {
    runs,
    calls: options.cases.reduce((sum, workload) => sum + workload.calls.length, 0),
    originalMs,
    wrapperMs,
    nativeCallMs,
    kernelMs,
    ...(referenceMs ? { referenceMs } : {}),
    netSavedMs: round(netSavedMs),
    boundaryShare: round(boundaryShare),
    ...(referenceRatio !== undefined ? { referenceRatio: round(referenceRatio) } : {}),
    parity: {
      cases: parity.cases,
      nativeAgreed: parity.nativeAgreed,
      nativeTrapped: parity.nativeTrapped,
      byCategory: parity.byCategory,
      mismatches: parity.mismatches.length,
    },
    gate,
    accepted: Object.values(gate).every((status) => status !== "FAIL"),
    nativeStatus,
  };
}

function runWorkload(functions: Record<string, Fn>, workload: BenchmarkCase, afterCall?: () => void): void {
  if (SPEC.mode === "batch") {
    for (const args of workload.calls) {
      call(functions, SPEC.entry, [...args]);
      afterCall?.();
    }
    return;
  }
  const prepared = SPEC as unknown as { prepare: string; handleIndex: number };
  const state = call(functions, prepared.prepare, [...(workload.prepareArgs ?? [])]);
  afterCall?.();
  for (const args of workload.calls) {
    const callArgs = [...args];
    callArgs[prepared.handleIndex] = state;
    call(functions, SPEC.entry, callArgs);
    afterCall?.();
  }
}

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return { median: round(median), min: round(sorted[0] ?? 0), max: round(sorted[sorted.length - 1] ?? 0) };
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
}

// Unused in the benchmark, but shared helpers reference it.
void invoke;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const casesPath = option("--cases");
  if (!casesPath) {
    throw new Error("--cases <file> is required (tagged JSON BenchmarkCase[])");
  }
  const cases = decodeCase(JSON.parse(readFileSync(casesPath, "utf8"))) as BenchmarkCase[];
  const referencePath = option("--reference");
  const reference = referencePath ? createRequire(import.meta.url)(referencePath) as Record<string, Fn> : undefined;
  const report = runBenchmark({ cases, runs: Number(option("--runs") ?? 5), ...(reference ? { reference } : {}) });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.accepted ? 0 : 1;
}
`;
}
