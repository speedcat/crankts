import type {
  BoundaryType,
  KernelContract,
  KernelOutput,
  KernelPort,
  ProofObligation,
  ProofStatus,
  SupportedKernelShape,
} from "./contract.js";
import { analyzeIntegers } from "./integer-analysis.js";
import { formatIrType, mergeModules, type IrModule, type IrType } from "./ir.js";
import { verifyIrModule, type IrVerification, type VerifyDiagnostic } from "./verify.js";

/**
 * Derives a {@link KernelContract} from verified Kernel IR (v0.2.1). Every obligation status comes
 * from the verifier; nothing is asserted by hand. Shape selection stays explicit (v0.2 has no
 * automatic selection).
 */

export interface DeriveContractRequest {
  readonly name: string;
  readonly shape: SupportedKernelShape;
  /** The kernel; for PREPARED_STATE, the execute function. */
  readonly execute: IrModule;
  /** PREPARED_STATE only: the function that builds the native state. */
  readonly prepare?: IrModule;
  /** GRAPH_BATCH only: the two typed-array parameters that form the CSR graph. */
  readonly graph?: { readonly offsets: string; readonly neighbors: string; readonly direction: "directed" | "undirected" };
}

export type DerivedContract =
  | { readonly ok: true; readonly contract: KernelContract; readonly verification: readonly IrVerification[] }
  | { readonly ok: false; readonly errors: readonly VerifyDiagnostic[] };

const STATUS_RANK: Readonly<Record<ProofStatus, number>> = { PROVEN: 0, GUARDED: 1, UNPROVEN: 2 };
const TRAP_FALLBACK = "a KernelTrap re-runs the original TypeScript function";

export function deriveKernelContract(request: DeriveContractRequest): DerivedContract {
  const errors: VerifyDiagnostic[] = [];
  const executeVerification = verifyIrModule(request.execute);
  const prepareVerification = request.prepare ? verifyIrModule(request.prepare) : undefined;
  errors.push(...executeVerification.errors, ...(prepareVerification?.errors ?? []));

  const execute = entryOf(request.execute);
  const prepare = request.prepare ? entryOf(request.prepare) : undefined;
  const fail = (message: string): DerivedContract => ({ ok: false, errors: [...errors, { function: execute.name, message }] });

  if ((request.shape === "PREPARED_STATE") !== (prepare !== undefined)) {
    return fail("PREPARED_STATE requires a prepare module, and only PREPARED_STATE accepts one");
  }
  if ((request.shape === "GRAPH_BATCH") !== (request.graph !== undefined)) {
    return fail("GRAPH_BATCH requires the CSR offsets/neighbors parameters, and only GRAPH_BATCH accepts them");
  }

  const stateType = prepare?.returnType;
  if (prepare && stateType?.kind !== "struct") {
    return fail("prepare must return a named struct (the native state)");
  }

  const inputs: KernelPort[] = [];
  for (const param of execute.params) {
    if (stateType?.kind === "struct" && param.type.kind === "struct" && param.type.name === stateType.name) {
      inputs.push({
        name: param.name,
        type: { kind: "handle", state: stateType.name },
        sourceType: stateType.name,
        ownership: "BORROWED",
        mutability: "IMMUTABLE",
        packing: "NATIVE_OWNED",
      });
      continue;
    }
    if (request.graph && param.name === request.graph.neighbors) {
      continue;
    }
    if (request.graph && param.name === request.graph.offsets) {
      const neighbors = execute.params.find((candidate) => candidate.name === request.graph?.neighbors);
      if (!isTypedArray(param.type, "u32") || !neighbors || !isTypedArray(neighbors.type, "u32")) {
        return fail("CSR offsets and neighbors must both be Uint32Array parameters");
      }
      inputs.push({
        name: "graph",
        type: { kind: "packedGraph", direction: request.graph.direction, deduplicated: false, neighborOrder: "INSERTION" },
        sourceType: `${param.name}: Uint32Array, ${neighbors.name}: Uint32Array`,
        ownership: "BORROWED",
        mutability: "IMMUTABLE",
        packing: "UPSTREAM",
      });
      continue;
    }
    const port = boundaryPort(param.name, param.type);
    if (!port) {
      return fail(`parameter ${param.name}: ${formatIrType(param.type)} cannot cross the boundary`);
    }
    inputs.push(port);
  }

  const outputs: KernelOutput[] = [];
  if (execute.returnType.kind !== "void") {
    const returnsNumbers = execute.returnType.kind === "array" && execute.returnType.storage === "dynamic"
      && execute.returnType.element.kind === "f64";
    let type = boundaryType(execute.returnType);
    if (returnsNumbers) {
      // Typed outputs avoid per-element N-API conversion: Uint32Array when the integer analysis proves
      // every element a non-negative INT, else Float64Array (exact for every number, incl. NaN and -0).
      const merged = request.prepare ? mergeModules(request.execute, request.prepare) : request.execute;
      const integers = analyzeIntegers(merged, [execute.name, ...(prepare ? [prepare.name] : [])]);
      type = { kind: "typedArray", element: integers.returnElementsNonneg(execute.name) ? "u32" : "f64" };
    }
    if (!type) {
      return fail(`return type ${formatIrType(execute.returnType)} cannot cross the boundary`);
    }
    outputs.push({
      name: "result",
      type,
      sourceType: formatIrType(execute.returnType),
      ordering: { kind: "TRAVERSAL_ORDER", description: "computed by the Kernel IR, deterministic by construction" },
    });
  }

  const prepareInputs: KernelPort[] = [];
  for (const param of prepare?.params ?? []) {
    const port = boundaryPort(param.name, param.type);
    if (!port) {
      return fail(`prepare parameter ${param.name}: ${formatIrType(param.type)} cannot cross the boundary`);
    }
    prepareInputs.push(port);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const obligations = mergeObligations(
    request.name,
    [executeVerification, ...(prepareVerification ? [prepareVerification] : [])],
  );
  if (prepareVerification) {
    const executePure = executeVerification.obligations.some((obligation) => obligation.kind === "PURE" && obligation.status === "PROVEN");
    obligations.push(prepareVerification.entryReturnsFresh && executePure
      ? {
        kind: "IMMUTABLE_DURING_HANDLE",
        subject: stateType?.kind === "struct" ? stateType.name : "state",
        status: "PROVEN",
        evidence: "prepare returns fresh state that references no input; execute never mutates its parameters",
      }
      : {
        kind: "IMMUTABLE_DURING_HANDLE",
        subject: stateType?.kind === "struct" ? stateType.name : "state",
        status: "UNPROVEN",
        evidence: "prepare may return parameter-derived storage, or execute may mutate the state",
      });
  }

  const contract: KernelContract = {
    contractVersion: 1,
    name: request.name,
    source: prepare ? `${prepare.source} + ${execute.source}` : execute.source,
    shape: request.shape,
    ...(prepare && stateType?.kind === "struct"
      ? {
        state: {
          name: stateType.name,
          prepareInputs,
          lifetime: "EXPLICIT" as const,
          invalidation: "PROVEN_IMMUTABLE" as const,
        },
      }
      : {}),
    inputs,
    outputs,
    batching: prepare ? { granularity: "ITEM", callsPerPrepare: "MANY" } : { granularity: "WHOLE_INPUT" },
    fallback: { reference: "ORIGINAL_TS", conditions: ["ADDON_MISSING", "NATIVE_ERROR", "CONTRACT_VIOLATION", "INPUT_OUT_OF_RANGE"] },
    proofObligations: obligations,
    typescriptSemantics: [TRAP_FALLBACK],
  };
  return { ok: true, contract, verification: [executeVerification, ...(prepareVerification ? [prepareVerification] : [])] };
}

function entryOf(module: IrModule) {
  const entry = module.functions.find((fn) => fn.name === module.entry);
  if (!entry) {
    throw new Error(`IR module has no entry function ${module.entry}`);
  }
  return entry;
}

/** Per obligation kind, keep the weakest status across modules. */
function mergeObligations(subject: string, verifications: readonly IrVerification[]): ProofObligation[] {
  const merged = new Map<ProofObligation["kind"], ProofObligation>();
  for (const verification of verifications) {
    for (const obligation of verification.obligations) {
      const existing = merged.get(obligation.kind);
      if (!existing || STATUS_RANK[obligation.status] > STATUS_RANK[existing.status]) {
        merged.set(obligation.kind, { ...obligation, subject });
      }
    }
  }
  return [...merged.values()];
}

function boundaryPort(name: string, type: IrType): KernelPort | undefined {
  const boundary = boundaryType(type);
  if (!boundary) {
    return undefined;
  }
  const isTyped = type.kind === "array" && type.storage !== "dynamic";
  return {
    name,
    type: boundary,
    sourceType: formatIrType(type),
    ownership: isTyped ? "BORROWED" : "COPIED",
    // PURE (verified) guarantees the kernel never writes through a parameter.
    mutability: "IMMUTABLE",
    packing: isTyped ? "UPSTREAM" : "PER_CALL",
  };
}

function boundaryType(type: IrType): BoundaryType | undefined {
  switch (type.kind) {
    case "f64":
      return { kind: "scalar", scalar: "f64" };
    case "bool":
      return { kind: "scalar", scalar: "bool" };
    case "string":
      return { kind: "string", encoding: "utf16" };
    case "array": {
      if (type.storage !== "dynamic") {
        return { kind: "typedArray", element: type.storage };
      }
      const element = boundaryType(type.element);
      return element ? { kind: "array", element } : undefined;
    }
    default:
      return undefined;
  }
}

function isTypedArray(type: IrType, storage: string): boolean {
  return type.kind === "array" && type.storage === storage;
}
