import type * as ts from "typescript";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import type { BoundaryField, BoundaryType, PackingSite, TypedArrayElement } from "./contract.js";

/**
 * Cost class of moving a value across the JS/native boundary.
 * `PACK` (interning, CSR construction) dominated the native total in MVP-9b (75-90%).
 */
export type TransferCost = "TRIVIAL" | "ZERO_COPY" | "COPY_LINEAR" | "CONVERT_LINEAR" | "PACK";

export type Representation =
  | {
    readonly supported: true;
    readonly sourceType: string;
    readonly type: BoundaryType;
    readonly transfer: TransferCost;
    /** `UPSTREAM` whenever per-call packing would dominate; see {@link TransferCost}. */
    readonly recommendedPacking: PackingSite;
  }
  | {
    readonly supported: false;
    readonly sourceType: string;
    readonly reason: string;
  };

export interface SignatureRepresentation {
  readonly parameters: readonly ({ readonly name: string } & Representation)[];
  /** `undefined` for `void` functions. */
  readonly returns?: Representation;
  /** All parameters and the return type have a boundary representation. */
  readonly supported: boolean;
}

const TYPED_ARRAYS: Readonly<Record<string, TypedArrayElement>> = {
  Uint8Array: "u8",
  Uint32Array: "u32",
  Int32Array: "i32",
  Float64Array: "f64",
};
const MAX_STRUCT_DEPTH = 3;

type Classified =
  | { readonly supported: true; readonly type: BoundaryType; readonly transfer: TransferCost }
  | { readonly supported: false; readonly reason: string };

export function deriveSignatureRepresentation(
  declaration: ts.SignatureDeclaration,
  facade: Pick<CompilerFacade, "checker" | "typescript">,
): SignatureRepresentation {
  const { checker, typescript } = facade;
  const signature = checker.getSignatureFromDeclaration(declaration);
  const parameters = declaration.parameters.map((parameter) => {
    const name = parameter.name.getText();
    if (parameter.dotDotDotToken) {
      return { name, ...unsupported(checker.getTypeAtLocation(parameter), checker, "rest parameters have no fixed boundary shape") };
    }
    if (parameter.questionToken || parameter.initializer) {
      return { name, ...unsupported(checker.getTypeAtLocation(parameter), checker, "optional parameters are not lowered in v0.2") };
    }
    return { name, ...representType(checker.getTypeAtLocation(parameter), facade) };
  });
  const returnType = signature ? checker.getReturnTypeOfSignature(signature) : undefined;
  const returns = returnType && (returnType.flags & typescript.TypeFlags.Void) === 0
    ? representType(returnType, facade)
    : undefined;
  return {
    parameters,
    ...(returns ? { returns } : {}),
    supported: parameters.every((parameter) => parameter.supported) && (returns?.supported ?? true),
  };
}

export function representType(
  type: ts.Type,
  facade: Pick<CompilerFacade, "checker" | "typescript">,
): Representation {
  const sourceType = facade.checker.typeToString(type);
  const classified = classify(type, facade, 0, new Set());
  return classified.supported
    ? {
      supported: true,
      sourceType,
      type: classified.type,
      transfer: classified.transfer,
      recommendedPacking: classified.transfer === "PACK" ? "UPSTREAM" : "PER_CALL",
    }
    : { supported: false, sourceType, reason: classified.reason };
}

function classify(
  type: ts.Type,
  facade: Pick<CompilerFacade, "checker" | "typescript">,
  depth: number,
  visiting: Set<ts.Type>,
): Classified {
  const { checker, typescript } = facade;
  const flags = type.flags;
  const { TypeFlags } = typescript;

  if (flags & (TypeFlags.Boolean | TypeFlags.BooleanLiteral)) {
    return { supported: true, type: { kind: "scalar", scalar: "bool" }, transfer: "TRIVIAL" };
  }
  if (flags & (TypeFlags.Number | TypeFlags.NumberLiteral)) {
    // Integer ranges are a proof obligation, not a type property; JS numbers cross as f64.
    return { supported: true, type: { kind: "scalar", scalar: "f64" }, transfer: "TRIVIAL" };
  }
  if (isStringLike(type, typescript)) {
    return { supported: true, type: { kind: "string", encoding: "utf16" }, transfer: "COPY_LINEAR" };
  }
  if (flags & TypeFlags.Union) {
    const members = (type as ts.UnionType).types;
    if (members.some((member) => member.flags & (TypeFlags.Undefined | TypeFlags.Null))) {
      return { supported: false, reason: "nullable values have no v0.2 boundary representation" };
    }
    // Boolean is `true | false`; literal unions of one primitive collapse to that primitive.
    const classifications = members.map((member) => classify(member, facade, depth, visiting));
    const first = classifications[0];
    if (first?.supported && classifications.every((entry) => entry.supported && sameBoundaryType(entry.type, first.type))) {
      return first;
    }
    return { supported: false, reason: "unions of different representations are not lowered" };
  }
  if (!(flags & TypeFlags.Object)) {
    return { supported: false, reason: `type flags ${flags} have no boundary representation` };
  }

  const name = type.getSymbol()?.getName() ?? "";
  const typedArray = TYPED_ARRAYS[name];
  if (typedArray) {
    return { supported: true, type: { kind: "typedArray", element: typedArray }, transfer: "ZERO_COPY" };
  }
  if (checker.isTupleType(type)) {
    return { supported: false, reason: "tuples are not lowered in v0.2" };
  }
  if (checker.isArrayType(type)) {
    const element = typeArguments(type, checker)[0];
    if (!element) {
      return { supported: false, reason: "array element type is unknown" };
    }
    const elementClass = classify(element, facade, depth + 1, visiting);
    if (!elementClass.supported) {
      return { supported: false, reason: `array element: ${elementClass.reason}` };
    }
    return {
      supported: true,
      type: { kind: "array", element: elementClass.type },
      transfer: elementClass.type.kind === "scalar" ? "COPY_LINEAR" : "CONVERT_LINEAR",
    };
  }
  if (name === "Set" || name === "ReadonlySet") {
    const element = typeArguments(type, checker)[0];
    if (element && isStringLike(element, typescript)) {
      return { supported: true, type: { kind: "stringTable" }, transfer: "PACK" };
    }
    return { supported: false, reason: "only sets of strings are lowered (as string tables)" };
  }
  if (name === "Map" || name === "ReadonlyMap") {
    return classifyMap(type, facade);
  }
  return classifyStruct(type, facade, depth, visiting);
}

/** `Map<K, Set<K>>`, `Map<K, ReadonlySet<K>>`, and `Map<K, K[]>` with string-like K are adjacency lists. */
function classifyMap(type: ts.Type, facade: Pick<CompilerFacade, "checker" | "typescript">): Classified {
  const { checker, typescript } = facade;
  const [key, value] = typeArguments(type, checker);
  if (!key || !value || !isStringLike(key, typescript)) {
    return { supported: false, reason: "only maps with string-like keys are lowered" };
  }
  const valueName = value.getSymbol()?.getName() ?? "";
  const isSet = valueName === "Set" || valueName === "ReadonlySet";
  const isArray = checker.isArrayType(value);
  const neighbor = isSet || isArray ? typeArguments(value, checker)[0] : undefined;
  if (!neighbor || neighbor !== key) {
    return {
      supported: false,
      reason: "only adjacency maps (Map<K, Set<K> | K[]>) are lowered; other maps need an explicit layout",
    };
  }
  return {
    supported: true,
    type: {
      kind: "packedGraph",
      // Direction and symmetry are program properties, not type properties; a contract must assert them.
      direction: "directed",
      deduplicated: isSet,
      neighborOrder: "INSERTION",
    },
    transfer: "PACK",
  };
}

function classifyStruct(
  type: ts.Type,
  facade: Pick<CompilerFacade, "checker" | "typescript">,
  depth: number,
  visiting: Set<ts.Type>,
): Classified {
  const { checker, typescript } = facade;
  if (depth >= MAX_STRUCT_DEPTH) {
    return { supported: false, reason: `structs nested deeper than ${MAX_STRUCT_DEPTH} levels are not lowered` };
  }
  if (visiting.has(type)) {
    return { supported: false, reason: "recursive types are not lowered" };
  }
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return { supported: false, reason: "functions and constructors cannot cross the boundary" };
  }
  if (type.isClass() || (type.getSymbol()?.flags ?? 0) & typescript.SymbolFlags.Class) {
    return { supported: false, reason: "class instances carry identity and prototype methods" };
  }
  if (checker.getIndexInfosOfType(type).length > 0) {
    return { supported: false, reason: "index signatures have no fixed layout" };
  }

  visiting.add(type);
  const fields: BoundaryField[] = [];
  try {
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) {
        return { supported: false, reason: `property ${property.getName()} has no declaration` };
      }
      if (property.flags & typescript.SymbolFlags.Optional) {
        return { supported: false, reason: `optional property ${property.getName()} is not lowered` };
      }
      if (property.flags & typescript.SymbolFlags.Method) {
        return { supported: false, reason: `method ${property.getName()} cannot cross the boundary` };
      }
      const fieldClass = classify(checker.getTypeOfSymbolAtLocation(property, declaration), facade, depth + 1, visiting);
      if (!fieldClass.supported) {
        return { supported: false, reason: `property ${property.getName()}: ${fieldClass.reason}` };
      }
      fields.push({ name: property.getName(), type: fieldClass.type });
    }
  } finally {
    visiting.delete(type);
  }
  if (fields.length === 0) {
    return { supported: false, reason: "empty object types have no layout" };
  }
  return { supported: true, type: { kind: "struct", fields }, transfer: "CONVERT_LINEAR" };
}

function isStringLike(type: ts.Type, typescript: typeof ts): boolean {
  const { TypeFlags } = typescript;
  if (type.flags & (TypeFlags.String | TypeFlags.StringLiteral | TypeFlags.TemplateLiteral)) {
    return true;
  }
  // Branded strings, e.g. `string & { readonly __brand: "Id" }`.
  return Boolean(type.flags & TypeFlags.Intersection)
    && (type as ts.IntersectionType).types.some((member) => Boolean(member.flags & TypeFlags.String));
}

function typeArguments(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  const reference = type as ts.TypeReference;
  return reference.target ? checker.getTypeArguments(reference) : type.aliasTypeArguments ?? [];
}

function sameBoundaryType(left: BoundaryType, right: BoundaryType): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unsupported(type: ts.Type, checker: ts.TypeChecker, reason: string): Representation {
  return { supported: false, sourceType: checker.typeToString(type), reason };
}
