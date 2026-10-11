import { builtinModules } from "node:module";
import type * as ts from "typescript";
import { isPathWithin } from "../compiler/compiler-facade.js";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import type { Blocker, BlockerCode, CallEdge, CallEdgeKind, Eligibility, FunctionAnalysis, FunctionId } from "./model.js";
import { isFunctionBoundary } from "./functions.js";
import type { FunctionDefinition } from "./functions.js";

export interface EligibilityResult {
  readonly eligibility: Eligibility;
  readonly suitability: number;
}

const nodeBuiltinNames = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, "")));
const typedArrayNames = new Set([
  "DataView",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
]);
const resolvedInternalEdgeKinds = new Set<CallEdgeKind>([
  "DIRECT_RESOLVED",
  "METHOD_RESOLVED",
  "CONSTRUCTOR",
  "CALLBACK",
]);

export function evaluateEligibility(
  definition: FunctionDefinition,
  calls: readonly CallEdge[],
  facade: CompilerFacade,
): EligibilityResult {
  const blockers: Blocker[] = [];
  const blockerKeys = new Set<string>();
  const addBlocker = (
    code: BlockerCode,
    message: string,
    disposition: Blocker["disposition"],
    line = definition.line,
  ): void => {
    const key = `${code}:${message}:${line}`;
    if (blockerKeys.has(key)) {
      return;
    }
    blockerKeys.add(key);
    blockers.push({ code, message, disposition, line });
  };

  for (const edge of calls) {
    if (edge.kind === "DYNAMIC") {
      addBlocker("DYNAMIC_CALL", `Dynamic call through '${edge.callee}'.`, "blocked", edge.line);
    } else if (edge.kind === "UNRESOLVED") {
      addBlocker("UNRESOLVED_CALL", `Call to '${edge.callee}' could not be resolved.`, "conditional", edge.line);
    } else if (edge.kind === "CONSTRUCTOR" && !edge.to && ERROR_CONSTRUCTORS.has(edge.callee)) {
      // `throw new TypeError(…)` is a guard: a native kernel traps there and the TypeScript path throws.
      continue;
    } else if ((edge.kind === "EXTERNAL" || edge.kind === "CONSTRUCTOR") && !edge.to) {
      addBlocker("UNKNOWN_EXTERNAL_CALL", `External call '${edge.callee}' has no in-project implementation.`, "conditional", edge.line);
    }
  }

  checkFunctionTypes(definition, facade, addBlocker);
  scanFunctionBody(definition, facade, addBlocker);

  return createEligibilityResult(blockers);
}

export function propagateEligibility(functions: readonly FunctionAnalysis[]): FunctionAnalysis[] {
  const functionById = new Map(functions.map((functionAnalysis) => [functionAnalysis.id, functionAnalysis]));
  const callersByCallee = new Map<FunctionId, CallEdge[]>();

  for (const functionAnalysis of functions) {
    for (const edge of functionAnalysis.calls) {
      if (!edge.to || !resolvedInternalEdgeKinds.has(edge.kind)) {
        continue;
      }
      const callers = callersByCallee.get(edge.to) ?? [];
      callers.push(edge);
      callersByCallee.set(edge.to, callers);
    }
  }

  const pending = functions
    .filter((functionAnalysis) => functionAnalysis.eligibility.kind !== "SUPPORTED")
    .map((functionAnalysis) => functionAnalysis.id);
  const queued = new Set(pending);
  let pendingIndex = 0;

  while (pendingIndex < pending.length) {
    const calleeId = pending[pendingIndex];
    pendingIndex += 1;
    if (!calleeId) {
      continue;
    }
    queued.delete(calleeId);

    const callee = functionById.get(calleeId);
    if (!callee || callee.eligibility.kind === "SUPPORTED") {
      continue;
    }

    for (const edge of callersByCallee.get(calleeId) ?? []) {
      const caller = functionById.get(edge.from);
      if (!caller || caller.eligibility.kind === "BLOCKED") {
        continue;
      }

      const blocker: Blocker = {
        code: "CALLEE_NOT_SUPPORTED",
        message: `Calls ${callee.name}(), which is ${callee.eligibility.kind.toLowerCase()}.`,
        disposition: "conditional",
        line: edge.line,
      };
      const existingBlockers = getEligibilityBlockers(caller.eligibility);
      const isDuplicate = existingBlockers.some((existing) => (
        existing.code === blocker.code
        && existing.message === blocker.message
        && existing.line === blocker.line
      ));
      if (isDuplicate) {
        continue;
      }

      const next = createEligibilityResult([...existingBlockers, blocker]);
      functionById.set(edge.from, {
        ...caller,
        eligibility: next.eligibility,
        suitability: next.suitability,
      });
      if (next.eligibility.kind !== "SUPPORTED" && !queued.has(edge.from)) {
        pending.push(edge.from);
        queued.add(edge.from);
      }
    }
  }

  return functions.map((functionAnalysis) => functionById.get(functionAnalysis.id) ?? functionAnalysis);
}

function createEligibilityResult(blockers: readonly Blocker[]): EligibilityResult {
  const hasBlockedSignal = blockers.some((blocker) => blocker.disposition === "blocked");
  const conditionalCodes = new Set(
    blockers.filter((blocker) => blocker.disposition === "conditional").map((blocker) => blocker.code),
  );
  const suitability = hasBlockedSignal ? 0 : Math.max(0, 100 - conditionalCodes.size * 15);

  if (hasBlockedSignal) {
    return { eligibility: { kind: "BLOCKED", blockers }, suitability };
  }
  if (blockers.length > 0) {
    return { eligibility: { kind: "CONDITIONAL", blockers }, suitability };
  }
  return { eligibility: { kind: "SUPPORTED" }, suitability };
}

function getEligibilityBlockers(eligibility: Eligibility): readonly Blocker[] {
  return eligibility.kind === "SUPPORTED" ? [] : eligibility.blockers;
}

function checkFunctionTypes(
  definition: FunctionDefinition,
  facade: CompilerFacade,
  addBlocker: (code: BlockerCode, message: string, disposition: Blocker["disposition"], line?: number) => void,
): void {
  for (const parameter of definition.node.parameters) {
    const parameterType = facade.checker.getTypeAtLocation(parameter);
    const dynamicType = findDynamicType(parameterType, facade, new Set(), 0);
    if (dynamicType) {
      const name = parameter.name.getText(definition.sourceFile);
      addBlocker(
        "DYNAMIC_TYPE",
        `Parameter '${name}' contains ${dynamicType}.`,
        "conditional",
        definition.sourceFile.getLineAndCharacterOfPosition(parameter.getStart()).line + 1,
      );
    }
  }

  const signature = facade.checker.getSignatureFromDeclaration(definition.node);
  if (signature) {
    const returnType = facade.checker.getReturnTypeOfSignature(signature);
    const dynamicType = findDynamicType(returnType, facade, new Set(), 0);
    if (dynamicType) {
      addBlocker("DYNAMIC_TYPE", `Return type contains ${dynamicType}.`, "conditional");
    }
  }
}

function findDynamicType(
  type: ts.Type,
  facade: CompilerFacade,
  visited: Set<ts.Type>,
  depth: number,
): "any" | "unknown" | undefined {
  if (type.flags & facade.typescript.TypeFlags.Any) {
    return "any";
  }
  if (type.flags & facade.typescript.TypeFlags.Unknown) {
    return "unknown";
  }
  if (visited.has(type) || depth > 4) {
    return undefined;
  }
  visited.add(type);

  if (type.isUnionOrIntersection()) {
    for (const memberType of type.types) {
      const dynamicType = findDynamicType(memberType, facade, visited, depth + 1);
      if (dynamicType) {
        return dynamicType;
      }
    }
  }

  if (type.flags & facade.typescript.TypeFlags.Object) {
    const objectType = type as ts.TypeReference;
    if (objectType.objectFlags & facade.typescript.ObjectFlags.Reference) {
      try {
        for (const typeArgument of facade.checker.getTypeArguments(objectType)) {
          const dynamicType = findDynamicType(typeArgument, facade, visited, depth + 1);
          if (dynamicType) {
            return dynamicType;
          }
        }
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

function scanFunctionBody(
  definition: FunctionDefinition,
  facade: CompilerFacade,
  addBlocker: (code: BlockerCode, message: string, disposition: Blocker["disposition"], line?: number) => void,
): void {
  const body = definition.node.body;
  if (!body) {
    return;
  }

  const visit = (node: ts.Node): void => {
    if (node !== body && isFunctionBoundary(node, facade.typescript)) {
      return;
    }

    if (facade.typescript.isElementAccessExpression(node) && !isLiteralElementAccess(node, facade.typescript)) {
      const baseType = facade.checker.getTypeAtLocation(node.expression);
      if (!isSafeIndexedCollection(baseType, facade)) {
        addBlocker(
          "DYNAMIC_PROPERTY_ACCESS",
          `Computed property access '${node.expression.getText()}[${node.argumentExpression?.getText() ?? ""}]' is not modeled.`,
          "conditional",
          getLine(node, definition),
        );
      }
    }

    if ((facade.typescript.isCallExpression(node) || facade.typescript.isNewExpression(node))
      && facade.typescript.isIdentifier(node.expression)) {
      const identifier = node.expression;
      const name = identifier.text;
      if (name === "eval" && isGlobalIdentifier(identifier, facade)) {
        addBlocker("EVAL_USAGE", "Uses eval().", "blocked", getLine(node, definition));
      } else if (name === "Function" && isGlobalIdentifier(identifier, facade)) {
        addBlocker("EVAL_USAGE", "Constructs a function dynamically.", "blocked", getLine(node, definition));
      } else if (name === "Proxy" && isGlobalIdentifier(identifier, facade)) {
        addBlocker("PROXY_USAGE", "Uses Proxy.", "blocked", getLine(node, definition));
      } else if (name === "require" && isGlobalIdentifier(identifier, facade)) {
        addBlocker("NODE_RUNTIME_DEPENDENCY", "Uses the Node.js require() loader.", "blocked", getLine(node, definition));
      }
    }

    if (facade.typescript.isIdentifier(node)) {
      if (["process", "Buffer", "__dirname", "__filename"].includes(node.text)
        && isGlobalIdentifier(node, facade)) {
        addBlocker(
          "NODE_RUNTIME_DEPENDENCY",
          `Uses the Node.js global '${node.text}'.`,
          "blocked",
          getLine(node, definition),
        );
      }

      const importModule = getImportedModule(node, facade);
      if (importModule && isNodeBuiltin(importModule)) {
        addBlocker(
          "NODE_RUNTIME_DEPENDENCY",
          `Uses Node.js module '${importModule}'.`,
          "blocked",
          getLine(node, definition),
        );
      }

      if (node.text === "Reflect"
        && facade.typescript.isPropertyAccessExpression(node.parent)
        && node.parent.expression === node
        && isGlobalIdentifier(node, facade)) {
        addBlocker("REFLECTION", "Uses the Reflect API.", "conditional", getLine(node, definition));
      }
    }

    facade.typescript.forEachChild(node, visit);
  };

  visit(body);
}

function isLiteralElementAccess(node: ts.ElementAccessExpression, facadeTypescript: typeof import("typescript")): boolean {
  const argument = node.argumentExpression;
  return Boolean(argument && (
    facadeTypescript.isStringLiteral(argument)
    || facadeTypescript.isNoSubstitutionTemplateLiteral(argument)
    || facadeTypescript.isNumericLiteral(argument)
  ));
}

function isSafeIndexedCollection(type: ts.Type, facade: CompilerFacade): boolean {
  if (type.flags & (facade.typescript.TypeFlags.StringLike | facade.typescript.TypeFlags.NumberLike)) {
    return true;
  }
  if (facade.checker.isArrayType(type) || facade.checker.isTupleType(type)) {
    return true;
  }
  // Aliases and generic wrappers around arrays and typed arrays (`TArg<Uint32Array>`, unions of typed arrays):
  // safe when every union member is, or when an intersection contains one.
  if (type.isUnion()) {
    return type.types.every((member) => isSafeIndexedCollection(member, facade));
  }
  if (type.isIntersection()) {
    return type.types.some((member) => isSafeIndexedCollection(member, facade));
  }

  const typeName = type.getSymbol()?.getName();
  if (typeName !== undefined && typedArrayNames.has(typeName)) {
    return true;
  }
  const apparent = facade.checker.getApparentType(type);
  const apparentName = apparent.getSymbol()?.getName();
  return apparent !== type && apparentName !== undefined && typedArrayNames.has(apparentName);
}

const ERROR_CONSTRUCTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError"]);

function isGlobalIdentifier(identifier: ts.Identifier, facade: CompilerFacade): boolean {
  const symbol = facade.checker.getSymbolAtLocation(identifier);
  if (!symbol) {
    return true;
  }
  return (symbol.declarations ?? []).every((declaration) => !isProjectDeclaration(declaration, facade));
}

function isProjectDeclaration(declaration: ts.Declaration, facade: CompilerFacade): boolean {
  const sourceFile = declaration.getSourceFile();
  return !sourceFile.isDeclarationFile
    && !sourceFile.fileName.split(/[\\/]/).includes("node_modules")
    && isPathWithin(facade.projectRoot, sourceFile.fileName);
}

function getImportedModule(identifier: ts.Identifier, facade: CompilerFacade): string | undefined {
  const symbol = facade.checker.getSymbolAtLocation(identifier);
  for (const declaration of symbol?.declarations ?? []) {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (facade.typescript.isImportDeclaration(current)
        && facade.typescript.isStringLiteral(current.moduleSpecifier)) {
        return current.moduleSpecifier.text;
      }
      current = current.parent;
    }
  }
  return undefined;
}

function isNodeBuiltin(moduleName: string): boolean {
  const normalizedName = moduleName.replace(/^node:/, "");
  return nodeBuiltinNames.has(normalizedName);
}

function getLine(node: ts.Node, definition: FunctionDefinition): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1 || definition.line;
}