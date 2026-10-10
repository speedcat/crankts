import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCompilerFacade } from "../src/compiler/compiler-facade.js";
import { collectFunctions } from "../src/analysis/functions.js";
import { validateKernelContract, type KernelContract } from "../src/lowering/contract.js";
import { GRAPH_ISLANDS_CONTRACT, KWX_ASCII_SCAN_CONTRACT, REFERENCE_CONTRACTS } from "../src/lowering/reference-contracts.js";
import { deriveSignatureRepresentation } from "../src/lowering/representation.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/lowering", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function signatureOf(root: string, name: string, file?: string) {
  const facade = createCompilerFacade(root);
  const definition = collectFunctions(facade).definitions.find((candidate) => (
    candidate.name === name && (!file || candidate.file === file)
  ));
  if (!definition) throw new Error(`Expected function ${name}.`);
  return deriveSignatureRepresentation(definition.node, definition.compilerFacade);
}

function codes(contract: KernelContract): string[] {
  return validateKernelContract(contract).diagnostics
    .filter((diagnostic) => diagnostic.severity === "ERROR")
    .map((diagnostic) => diagnostic.code);
}

describe("validateKernelContract", () => {
  it("keeps both reference contracts structurally valid; only unproven obligations block lowering", () => {
    for (const contract of REFERENCE_CONTRACTS) {
      const validation = validateKernelContract(contract);
      expect(validation.lowerable, contract.name).toBe(false);
      expect(new Set(codes(contract)), contract.name).toEqual(new Set(["PROOF_UNPROVEN"]));
      expect(validation.diagnostics.filter((diagnostic) => diagnostic.severity === "WARNING"), contract.name).toEqual([]);
    }
  });

  it("becomes lowerable once every obligation is proven or guarded", () => {
    const proven: KernelContract = {
      ...GRAPH_ISLANDS_CONTRACT,
      proofObligations: GRAPH_ISLANDS_CONTRACT.proofObligations.map((obligation) => (
        obligation.status === "UNPROVEN" ? { ...obligation, status: "PROVEN" as const } : obligation
      )),
    };
    expect(validateKernelContract(proven)).toEqual({ lowerable: true, diagnostics: [] });
  });

  it("fails closed on shape and state errors", () => {
    const { state: _state, ...withoutState } = KWX_ASCII_SCAN_CONTRACT;
    expect(codes({ ...withoutState, shape: "PREPARED_STATE" })).toContain("STATE_REQUIRED");
    expect(codes({ ...KWX_ASCII_SCAN_CONTRACT, shape: "PURE_BATCH" })).toEqual(expect.arrayContaining([
      "STATE_NOT_ALLOWED",
      "HANDLE_OUTSIDE_PREPARED_STATE",
    ]));
    expect(codes({ ...GRAPH_ISLANDS_CONTRACT, shape: "OWNED_NATIVE_STATE" })).toContain("UNSUPPORTED_SHAPE");
    expect(codes({
      ...GRAPH_ISLANDS_CONTRACT,
      inputs: GRAPH_ISLANDS_CONTRACT.inputs.filter((input) => input.type.kind !== "packedGraph"),
    })).toContain("GRAPH_INPUT_REQUIRED");
    expect(codes({
      ...KWX_ASCII_SCAN_CONTRACT,
      inputs: KWX_ASCII_SCAN_CONTRACT.inputs.filter((input) => input.type.kind !== "handle"),
    })).toContain("HANDLE_INPUT_REQUIRED");
  });

  it("rejects mutable inputs without a sound invalidation strategy", () => {
    const state = KWX_ASCII_SCAN_CONTRACT.state;
    if (!state) throw new Error("Expected prepared state.");
    expect(codes({ ...KWX_ASCII_SCAN_CONTRACT, state: { ...state, invalidation: "PROVEN_IMMUTABLE" } })).toEqual(expect.arrayContaining([
      "MUTABLE_PREPARE_INPUT_NEEDS_INVALIDATION",
      "IMMUTABILITY_NOT_PROVEN",
    ]));
    const [adjacency, ...rest] = GRAPH_ISLANDS_CONTRACT.inputs;
    if (!adjacency) throw new Error("Expected adjacency input.");
    expect(codes({ ...GRAPH_ISLANDS_CONTRACT, inputs: [{ ...adjacency, mutability: "MUTABLE_INVALIDATES" }, ...rest] }))
      .toContain("MUTABLE_BORROW");
    expect(codes({ ...GRAPH_ISLANDS_CONTRACT, inputs: [{ ...adjacency, mutability: "MUTABLE_UNSUPPORTED" }, ...rest] }))
      .toContain("MUTABLE_INPUT_UNSUPPORTED");
    expect(codes({ ...GRAPH_ISLANDS_CONTRACT, inputs: [{ ...adjacency, ownership: "MOVED_INTO_HANDLE" }, ...rest] }))
      .toContain("MOVE_OUTSIDE_PREPARE");
  });

  it("requires fallback, ordering, guards, and unique names", () => {
    expect(codes({ ...GRAPH_ISLANDS_CONTRACT, fallback: { reference: "ORIGINAL_TS", conditions: ["ADDON_MISSING"] } }))
      .toContain("FALLBACK_INCOMPLETE");
    const [output] = GRAPH_ISLANDS_CONTRACT.outputs;
    if (!output) throw new Error("Expected output.");
    expect(codes({ ...GRAPH_ISLANDS_CONTRACT, outputs: [{ ...output, ordering: { kind: "UNORDERED" } }] }))
      .toContain("OUTPUT_ORDERING_REQUIRED");
    expect(codes({ ...GRAPH_ISLANDS_CONTRACT, outputs: [{ ...output, ordering: { kind: "INPUT_ORDER", input: "missing" } }] }))
      .toContain("UNKNOWN_ORDERING_INPUT");
    expect(codes({
      ...GRAPH_ISLANDS_CONTRACT,
      proofObligations: [{ kind: "INTEGER_RANGE", subject: "indexes", status: "GUARDED" }],
    })).toContain("GUARD_MISSING");
    expect(codes({ ...GRAPH_ISLANDS_CONTRACT, outputs: [output, output] })).toContain("DUPLICATE_NAME");
  });

  it("warns when a packed representation is rebuilt on every call", () => {
    const [adjacency, ...rest] = GRAPH_ISLANDS_CONTRACT.inputs;
    if (!adjacency) throw new Error("Expected adjacency input.");
    const validation = validateKernelContract({ ...GRAPH_ISLANDS_CONTRACT, inputs: [{ ...adjacency, packing: "PER_CALL" }, ...rest] });
    expect(validation.diagnostics).toContainEqual(expect.objectContaining({ severity: "WARNING", code: "PER_CALL_PACKING" }));
  });
});

describe("deriveSignatureRepresentation", () => {
  it("represents the extracted KWX scan as a UTF-16 string, a string table, and match structs", () => {
    const signature = signatureOf(fixtureRoot, "scanAsciiTerms");
    expect(signature.supported).toBe(true);
    expect(signature.parameters).toEqual([
      expect.objectContaining({ name: "text", type: { kind: "string", encoding: "utf16" }, transfer: "COPY_LINEAR" }),
      expect.objectContaining({ name: "dictionary", type: { kind: "stringTable" }, transfer: "PACK", recommendedPacking: "UPSTREAM" }),
    ]);
    expect(signature.returns).toMatchObject({
      supported: true,
      transfer: "CONVERT_LINEAR",
      type: {
        kind: "array",
        element: {
          kind: "struct",
          fields: [
            { name: "termIndex", type: { kind: "scalar", scalar: "f64" } },
            { name: "offset", type: { kind: "scalar", scalar: "f64" } },
            { name: "length", type: { kind: "scalar", scalar: "f64" } },
          ],
        },
      },
    });
    const prepare = KWX_ASCII_SCAN_CONTRACT.state?.prepareInputs[0];
    expect(signature.parameters[1]).toMatchObject({ supported: true, type: prepare?.type });
  });

  it("explains why the unrefactored extractDictionary cannot be lowered", () => {
    const signature = signatureOf(fixtureRoot, "extractDictionary");
    expect(signature.supported).toBe(false);
    const byName = new Map(signature.parameters.map((parameter) => [parameter.name, parameter]));
    expect(byName.get("addMatch")).toMatchObject({ supported: false, reason: expect.stringContaining("functions") });
    expect(byName.get("matches")).toMatchObject({ supported: false, reason: expect.stringContaining("optional property source") });
    expect(signature.returns).toBeUndefined();
  });

  it("represents adjacency maps as packed graphs, including branded ids and arrays", () => {
    const components = signatureOf(fixtureRoot, "componentsOf");
    expect(components.parameters[1]).toMatchObject({
      supported: true,
      type: { kind: "packedGraph", direction: "directed", deduplicated: true, neighborOrder: "INSERTION" },
      transfer: "PACK",
      recommendedPacking: "UPSTREAM",
    });
    const branded = signatureOf(fixtureRoot, "brandedGraph");
    expect(branded.parameters).toEqual([
      expect.objectContaining({ type: expect.objectContaining({ kind: "packedGraph", deduplicated: false }) }),
      expect.objectContaining({ type: { kind: "typedArray", element: "f64" }, transfer: "ZERO_COPY" }),
    ]);
    expect(branded.returns).toMatchObject({ type: { kind: "scalar", scalar: "f64" }, transfer: "TRIVIAL" });
  });

  it("fails closed on nullable, tuple, non-adjacency map, numeric set, class, and optional inputs", () => {
    const reasons = signatureOf(fixtureRoot, "unsupportedInputs").parameters.map((parameter) => (
      parameter.supported ? "supported" : parameter.reason
    ));
    expect(reasons).toEqual([
      expect.stringContaining("nullable"),
      expect.stringContaining("tuples"),
      expect.stringContaining("adjacency maps"),
      expect.stringContaining("sets of strings"),
      // lib.d.ts declares Date as interface + var, so it fails on its methods rather than as a class.
      expect.stringContaining("method"),
      expect.stringContaining("class instances"),
    ]);
    expect(signatureOf(fixtureRoot, "optionalInput").parameters.every((parameter) => (
      !parameter.supported && parameter.reason.includes("optional parameters")
    ))).toBe(true);
  });

  it("represents CrankTS's real findArticulationPoints adjacency like the MVP-9b reference contract", () => {
    const signature = signatureOf(repoRoot, "findArticulationPoints", "src/analysis/islands.ts");
    const adjacency = signature.parameters.find((parameter) => parameter.name === "adjacency");
    const reference = GRAPH_ISLANDS_CONTRACT.inputs.find((input) => input.name === "adjacency");
    expect(adjacency).toMatchObject({ supported: true, transfer: "PACK", recommendedPacking: reference?.packing });
    // The type proves dedup and insertion order; symmetry stays an INPUT_INVARIANT obligation.
    expect(adjacency?.supported && adjacency.type).toEqual({ ...reference?.type, direction: "directed" });
    expect(GRAPH_ISLANDS_CONTRACT.proofObligations).toContainEqual(expect.objectContaining({ kind: "INPUT_INVARIANT" }));
  });
});
