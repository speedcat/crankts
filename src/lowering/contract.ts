/**
 * Kernel contracts (v0.2.0): a small, mechanically checkable description of a native kernel's
 * boundary. Derived from the two manual PoCs (KWX `PREPARED_STATE`, MVP-9b `GRAPH_BATCH`); not an IR.
 * Validation fails closed: anything the transformer cannot guarantee is an error, never a default.
 */

/** Shapes a v0.2 transformer may lower. */
export type SupportedKernelShape = "PURE_BATCH" | "PREPARED_STATE" | "GRAPH_BATCH";
/** Shapes that are named so analyses can refer to them, but cannot be lowered in v0.2. */
export type DeclaredKernelShape = "REDUCTION" | "PARALLEL_MAP" | "OWNED_NATIVE_STATE";
export type KernelShape = SupportedKernelShape | DeclaredKernelShape;

export const SUPPORTED_KERNEL_SHAPES: readonly SupportedKernelShape[] = ["PURE_BATCH", "PREPARED_STATE", "GRAPH_BATCH"];

export type ScalarType = "bool" | "u8" | "u32" | "i32" | "f64";
export type TypedArrayElement = "u8" | "u32" | "i32" | "f64";

export type BoundaryType =
  | { readonly kind: "scalar"; readonly scalar: ScalarType }
  /** JS strings cross as UTF-16; every offset/length reported back is in UTF-16 code units. */
  | { readonly kind: "string"; readonly encoding: "utf16" }
  | { readonly kind: "typedArray"; readonly element: TypedArrayElement }
  | { readonly kind: "array"; readonly element: BoundaryType }
  | { readonly kind: "struct"; readonly fields: readonly BoundaryField[] }
  /** Distinct strings interned to dense u32 indexes; native code sees indexes, never the strings' order. */
  | { readonly kind: "stringTable" }
  /** CSR graph over interned node ids: offsets (nodeCount + 1) and neighbor indexes, both u32. */
  | {
    readonly kind: "packedGraph";
    readonly direction: "directed" | "undirected";
    readonly deduplicated: boolean;
    /** Neighbor order inside a node's slice is part of the input (it drives traversal order). */
    readonly neighborOrder: "INSERTION" | "UNSPECIFIED";
  }
  | { readonly kind: "handle"; readonly state: string };

export interface BoundaryField {
  readonly name: string;
  readonly type: BoundaryType;
}

/** How a value crosses the boundary. */
export type Ownership =
  | "COPIED"
  | "BORROWED"
  /** Consumed by `prepare` into native state owned by a handle. */
  | "MOVED_INTO_HANDLE";

export type InputMutability =
  | "IMMUTABLE"
  /** The source may change while native state derived from it is alive; the state must be invalidated. */
  | "MUTABLE_INVALIDATES"
  /** The source may change during the call in ways the kernel cannot observe; never lowerable. */
  | "MUTABLE_UNSUPPORTED";

/**
 * Where the boundary representation is produced. MVP-9b measured `PER_CALL` packing of a
 * `Map<string, Set<string>>` at 75–90% of the native total, so packed representations should be
 * built `UPSTREAM` (by the producer) or kept `NATIVE_OWNED`.
 */
export type PackingSite = "PER_CALL" | "UPSTREAM" | "NATIVE_OWNED";

export interface KernelPort {
  readonly name: string;
  readonly type: BoundaryType;
  /** The TypeScript type this port replaces, as written in the source. */
  readonly sourceType: string;
  readonly ownership: Ownership;
  readonly mutability: InputMutability;
  readonly packing: PackingSite;
}

export interface KernelOutput {
  readonly name: string;
  readonly type: BoundaryType;
  readonly sourceType: string;
  readonly ordering: OutputOrdering;
}

export type OutputOrdering =
  | { readonly kind: "UNORDERED" }
  | { readonly kind: "INPUT_ORDER"; readonly input: string }
  /** e.g. dictionary order, component first-visit order. */
  | { readonly kind: "TRAVERSAL_ORDER"; readonly description: string }
  | { readonly kind: "SORTED"; readonly key: string; readonly stable: boolean };

export type HandleLifetime = "CALL" | "BUILD" | "PROCESS" | "EXPLICIT";

// Snapshotting identity + size is deliberately absent: delete-then-add keeps both and is unsound.
export type InvalidationStrategy =
  /** Wrap the source's mutators so every change invalidates the handle. */
  | "WRAP_MUTATORS"
  /** Sound but cold: MVP-8 measured per-chunk re-preparation slower than TypeScript. */
  | "REPREPARE_PER_CALL"
  /** No invalidation needed; requires a PROVEN `IMMUTABLE_DURING_HANDLE` obligation. */
  | "PROVEN_IMMUTABLE";

export interface PreparedState {
  readonly name: string;
  readonly prepareInputs: readonly KernelPort[];
  readonly lifetime: HandleLifetime;
  readonly invalidation: InvalidationStrategy;
}

export interface Batching {
  /** `ITEM`: one call per element (KWX chunk); `WHOLE_INPUT`: one call for the complete input (graph). */
  readonly granularity: "ITEM" | "WHOLE_INPUT";
  /** Expected calls per prepared handle; only meaningful for PREPARED_STATE. */
  readonly callsPerPrepare?: "ONE" | "MANY";
}

export type FallbackCondition =
  | "ADDON_MISSING"
  | "NATIVE_ERROR"
  | "CONTRACT_VIOLATION"
  | "INPUT_OUT_OF_RANGE"
  | "UNSUPPORTED_INPUT";

export interface Fallback {
  /** The original TypeScript function stays the reference and the fallback. */
  readonly reference: "ORIGINAL_TS";
  readonly conditions: readonly FallbackCondition[];
}

export type ProofObligationKind =
  | "PURE"
  | "NO_ALIASING"
  | "DETERMINISTIC_ORDER"
  | "STRING_SEMANTICS"
  | "INTEGER_RANGE"
  | "IMMUTABLE_DURING_HANDLE"
  | "EXCEPTION_FREE"
  | "TERMINATION"
  /** A property of the input the type system cannot express, e.g. a symmetric adjacency map. */
  | "INPUT_INVARIANT";

export type ProofStatus =
  | "PROVEN"
  /** Not statically proven, but enforced at runtime by `runtimeGuard` (falls back on violation). */
  | "GUARDED"
  | "UNPROVEN";

export interface ProofObligation {
  readonly kind: ProofObligationKind;
  readonly subject: string;
  readonly status: ProofStatus;
  readonly evidence?: string;
  readonly runtimeGuard?: string;
}

export interface KernelContract {
  readonly contractVersion: 1;
  readonly name: string;
  /** The TypeScript function (FunctionId or `file#name`) this kernel replaces. */
  readonly source: string;
  readonly shape: KernelShape;
  readonly state?: PreparedState;
  readonly inputs: readonly KernelPort[];
  readonly outputs: readonly KernelOutput[];
  readonly batching: Batching;
  readonly fallback: Fallback;
  readonly proofObligations: readonly ProofObligation[];
  /** Semantics that deliberately stay in the TypeScript wrapper (e.g. `localeCompare` tie-breaks). */
  readonly typescriptSemantics: readonly string[];
}

export type ContractDiagnosticCode =
  | "UNSUPPORTED_SHAPE"
  | "STATE_REQUIRED"
  | "STATE_NOT_ALLOWED"
  | "GRAPH_INPUT_REQUIRED"
  | "HANDLE_OUTSIDE_PREPARED_STATE"
  | "HANDLE_INPUT_REQUIRED"
  | "MOVE_OUTSIDE_PREPARE"
  | "MUTABLE_INPUT_UNSUPPORTED"
  | "MUTABLE_PREPARE_INPUT_NEEDS_INVALIDATION"
  | "IMMUTABILITY_NOT_PROVEN"
  | "MUTABLE_BORROW"
  | "DUPLICATE_NAME"
  | "UNKNOWN_ORDERING_INPUT"
  | "OUTPUT_ORDERING_REQUIRED"
  | "FALLBACK_INCOMPLETE"
  | "PROOF_UNPROVEN"
  | "GUARD_MISSING"
  | "PER_CALL_PACKING";

export interface ContractDiagnostic {
  readonly severity: "ERROR" | "WARNING";
  readonly code: ContractDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ContractValidation {
  /** True only without ERROR diagnostics; a transformer must refuse anything else. */
  readonly lowerable: boolean;
  readonly diagnostics: readonly ContractDiagnostic[];
}

const REQUIRED_FALLBACK: readonly FallbackCondition[] = ["ADDON_MISSING", "NATIVE_ERROR"];
const PACKED_KINDS: ReadonlySet<BoundaryType["kind"]> = new Set(["packedGraph", "stringTable"]);

export function validateKernelContract(contract: KernelContract): ContractValidation {
  const diagnostics: ContractDiagnostic[] = [];
  const error = (code: ContractDiagnosticCode, path: string, message: string): void => {
    diagnostics.push({ severity: "ERROR", code, path, message });
  };
  const warning = (code: ContractDiagnosticCode, path: string, message: string): void => {
    diagnostics.push({ severity: "WARNING", code, path, message });
  };

  if (!(SUPPORTED_KERNEL_SHAPES as readonly string[]).includes(contract.shape)) {
    error("UNSUPPORTED_SHAPE", "shape", `${contract.shape} is declared but cannot be lowered in v0.2.`);
  }

  const isPrepared = contract.shape === "PREPARED_STATE";
  if (isPrepared && !contract.state) {
    error("STATE_REQUIRED", "state", "PREPARED_STATE requires a prepared state with prepare inputs, lifetime, and invalidation.");
  }
  if (!isPrepared && contract.state) {
    error("STATE_NOT_ALLOWED", "state", `${contract.shape} kernels are stateless; use PREPARED_STATE for native state.`);
  }
  if (contract.shape === "GRAPH_BATCH" && !contract.inputs.some((input) => input.type.kind === "packedGraph")) {
    error("GRAPH_INPUT_REQUIRED", "inputs", "GRAPH_BATCH requires at least one packedGraph input.");
  }

  const prepareInputs = contract.state?.prepareInputs ?? [];
  const allPorts: Array<{ readonly port: KernelPort; readonly path: string; readonly isPrepare: boolean }> = [
    ...prepareInputs.map((port, index) => ({ port, path: `state.prepareInputs[${index}]`, isPrepare: true })),
    ...contract.inputs.map((port, index) => ({ port, path: `inputs[${index}]`, isPrepare: false })),
  ];

  checkUniqueNames(allPorts.map(({ port, path }) => ({ name: port.name, path })), error);
  checkUniqueNames(contract.outputs.map((output, index) => ({ name: output.name, path: `outputs[${index}]` })), error);

  for (const { port, path, isPrepare } of allPorts) {
    if (containsHandle(port.type) && !isPrepared) {
      error("HANDLE_OUTSIDE_PREPARED_STATE", `${path}.type`, "Native handles exist only in PREPARED_STATE kernels.");
    }
    if (port.ownership === "MOVED_INTO_HANDLE" && !isPrepare) {
      error("MOVE_OUTSIDE_PREPARE", `${path}.ownership`, `${port.name} can move into native state only as a prepare input.`);
    }
    if (port.mutability === "MUTABLE_UNSUPPORTED") {
      error("MUTABLE_INPUT_UNSUPPORTED", `${path}.mutability`, `${port.name} may change in ways the kernel cannot observe.`);
    }
    if (port.mutability === "MUTABLE_INVALIDATES" && !isPrepare && port.ownership === "BORROWED") {
      error("MUTABLE_BORROW", `${path}.ownership`, `${port.name} is mutable and must be copied, not borrowed, into a stateless call.`);
    }
    if (isPrepare && port.mutability === "MUTABLE_INVALIDATES" && contract.state?.invalidation === "PROVEN_IMMUTABLE") {
      error(
        "MUTABLE_PREPARE_INPUT_NEEDS_INVALIDATION",
        `${path}.mutability`,
        `${port.name} is mutable; use WRAP_MUTATORS or REPREPARE_PER_CALL instead of PROVEN_IMMUTABLE.`,
      );
    }
    if (port.packing === "PER_CALL" && PACKED_KINDS.has(port.type.kind) && !isPrepare) {
      warning(
        "PER_CALL_PACKING",
        `${path}.packing`,
        `${port.name} is packed on every call; MVP-9b measured this at 75-90% of the native total. Prefer UPSTREAM packing.`,
      );
    }
  }

  if (isPrepared && contract.state) {
    if (!contract.inputs.some((input) => input.type.kind === "handle" && input.type.state === contract.state?.name)) {
      error("HANDLE_INPUT_REQUIRED", "inputs", `PREPARED_STATE execute inputs must include the '${contract.state.name}' handle.`);
    }
    if (contract.state.invalidation === "PROVEN_IMMUTABLE" && !contract.proofObligations.some((obligation) => (
      obligation.kind === "IMMUTABLE_DURING_HANDLE" && obligation.status === "PROVEN"
    ))) {
      error("IMMUTABILITY_NOT_PROVEN", "state.invalidation", "PROVEN_IMMUTABLE requires a PROVEN IMMUTABLE_DURING_HANDLE obligation.");
    }
  }

  const inputNames = new Set(allPorts.map(({ port }) => port.name));
  contract.outputs.forEach((output, index) => {
    if (output.ordering.kind === "INPUT_ORDER" && !inputNames.has(output.ordering.input)) {
      error("UNKNOWN_ORDERING_INPUT", `outputs[${index}].ordering`, `${output.name} follows unknown input '${output.ordering.input}'.`);
    }
    if (output.ordering.kind === "UNORDERED" && output.type.kind !== "scalar" && output.type.kind !== "struct") {
      error(
        "OUTPUT_ORDERING_REQUIRED",
        `outputs[${index}].ordering`,
        `${output.name} is a collection; parity with TypeScript requires a declared order.`,
      );
    }
  });

  for (const condition of REQUIRED_FALLBACK) {
    if (!contract.fallback.conditions.includes(condition)) {
      error("FALLBACK_INCOMPLETE", "fallback.conditions", `Fallback to the original TypeScript must cover ${condition}.`);
    }
  }

  contract.proofObligations.forEach((obligation, index) => {
    const path = `proofObligations[${index}]`;
    if (obligation.status === "UNPROVEN") {
      error("PROOF_UNPROVEN", path, `${obligation.kind} for ${obligation.subject} is neither proven nor runtime-guarded.`);
    }
    if (obligation.status === "GUARDED" && !obligation.runtimeGuard) {
      error("GUARD_MISSING", path, `${obligation.kind} for ${obligation.subject} is GUARDED but names no runtime guard.`);
    }
  });

  return {
    lowerable: diagnostics.every((diagnostic) => diagnostic.severity !== "ERROR"),
    diagnostics,
  };
}

function checkUniqueNames(
  entries: readonly { readonly name: string; readonly path: string }[],
  error: (code: ContractDiagnosticCode, path: string, message: string) => void,
): void {
  const seen = new Set<string>();
  for (const { name, path } of entries) {
    if (seen.has(name)) {
      error("DUPLICATE_NAME", path, `Name '${name}' is used more than once.`);
    }
    seen.add(name);
  }
}

function containsHandle(type: BoundaryType): boolean {
  switch (type.kind) {
    case "handle":
      return true;
    case "array":
      return containsHandle(type.element);
    case "struct":
      return type.fields.some((field) => containsHandle(field.type));
    default:
      return false;
  }
}
