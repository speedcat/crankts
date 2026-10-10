import type * as ts from "typescript";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import { isFunctionBoundary } from "./functions.js";
import type { FunctionDefinition } from "./functions.js";
import type { CallEdge, Effect, FunctionAnalysis, FunctionId } from "./model.js";

const effectOrder: readonly Effect[] = [
  "ALLOCATES",
  "READS_EXTERNAL_STATE",
  "WRITES_EXTERNAL_STATE",
  "FILESYSTEM_IO",
  "NETWORK_IO",
  "DATABASE_IO",
  "PROCESS_CONTROL",
  "MUTATES_ARGUMENT",
  "MUTATES_LOCAL_STATE",
  "MUTATES_GLOBAL_STATE",
  "SPAWNS_ASYNC_WORK",
  "UNKNOWN_SIDE_EFFECT",
  "PURE",
];

const mutatingMethods = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

const allocatingArrayMethods = new Set([
  "concat",
  "filter",
  "flat",
  "flatMap",
  "map",
  "slice",
  "toReversed",
  "toSorted",
  "toSpliced",
  "with",
]);

const pureArrayMethods = new Set([
  "at",
  "entries",
  "every",
  "find",
  "findIndex",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "reduce",
  "reduceRight",
  "some",
  "values",
]);

const fsWriteMethods = new Set([
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "copyFile",
  "copyFileSync",
  "mkdir",
  "mkdirSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
]);

const databaseModules = new Set([
  "better-sqlite3",
  "drizzle-orm",
  "ioredis",
  "mongodb",
  "mongoose",
  "mysql",
  "mysql2",
  "pg",
  "redis",
  "sequelize",
  "sqlite3",
  "typeorm",
]);

const networkModules = new Set([
  "node:dgram",
  "node:dns",
  "node:http",
  "node:http2",
  "node:https",
  "node:net",
  "node:tls",
  "dgram",
  "dns",
  "http",
  "http2",
  "https",
  "net",
  "tls",
]);

const processModules = new Set([
  "node:child_process",
  "node:cluster",
  "node:process",
  "child_process",
  "cluster",
  "process",
]);

const resolvedInternalEdgeKinds = new Set([
  "DIRECT_RESOLVED",
  "METHOD_RESOLVED",
  "CONSTRUCTOR",
  "CALLBACK",
]);

export function inferDirectEffects(
  definition: FunctionDefinition,
  calls: readonly CallEdge[],
  facade: CompilerFacade,
): Effect[] {
  const effects = new Set<Effect>();
  const callsByLocation = new Map(calls.map((edge) => [`${edge.line}:${edge.column}`, edge]));
  const body = definition.node.body;

  if (!body) {
    return ["PURE"];
  }

  if (definition.node.modifiers?.some((modifier) => modifier.kind === facade.typescript.SyntaxKind.AsyncKeyword)) {
    effects.add("SPAWNS_ASYNC_WORK");
  }

  const visit = (node: ts.Node): void => {
    if (node !== body && isFunctionBoundary(node, facade.typescript)) {
      if (facade.typescript.isArrowFunction(node) || facade.typescript.isFunctionExpression(node)) {
        effects.add("ALLOCATES");
      }
      return;
    }

    if (facade.typescript.isArrayLiteralExpression(node)
      || facade.typescript.isObjectLiteralExpression(node)
      || facade.typescript.isNewExpression(node)) {
      effects.add("ALLOCATES");
    }

    if (facade.typescript.isAwaitExpression(node)) {
      effects.add("SPAWNS_ASYNC_WORK");
    }

    if (facade.typescript.isBinaryExpression(node) && isAssignment(node.operatorToken.kind, facade.typescript)) {
      recordMutation(node.left, false, definition, facade, effects);
    } else if ((facade.typescript.isPrefixUnaryExpression(node)
      || facade.typescript.isPostfixUnaryExpression(node))
      && (node.operator === facade.typescript.SyntaxKind.PlusPlusToken
        || node.operator === facade.typescript.SyntaxKind.MinusMinusToken)) {
      recordMutation(node.operand, false, definition, facade, effects);
    }

    if (facade.typescript.isCallExpression(node) || facade.typescript.isNewExpression(node)) {
      recordCallEffects(node, callsByLocation, definition, facade, effects);
    }

    if (facade.typescript.isPropertyAccessExpression(node)
      && node.expression.kind === facade.typescript.SyntaxKind.ThisKeyword) {
      effects.add("READS_EXTERNAL_STATE");
    }

    if (facade.typescript.isIdentifier(node)) {
      recordExternalVariableRead(node, definition, facade, effects);
    }

    facade.typescript.forEachChild(node, visit);
  };

  visit(body);
  return orderEffects(effects);
}

export function propagateEffects(functions: readonly FunctionAnalysis[]): FunctionAnalysis[] {
  const effectsByFunction = new Map<FunctionId, Set<Effect>>(
    functions.map((functionAnalysis) => [
      functionAnalysis.id,
      new Set(functionAnalysis.directEffects.filter((effect) => effect !== "PURE")),
    ]),
  );
  const callersByCallee = new Map<FunctionId, FunctionId[]>();

  for (const functionAnalysis of functions) {
    for (const edge of functionAnalysis.calls) {
      if (!edge.to || !resolvedInternalEdgeKinds.has(edge.kind)) {
        continue;
      }
      const callers = callersByCallee.get(edge.to) ?? [];
      callers.push(edge.from);
      callersByCallee.set(edge.to, callers);
    }
  }

  const pending = functions
    .filter((functionAnalysis) => (effectsByFunction.get(functionAnalysis.id)?.size ?? 0) > 0)
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

    const calleeEffects = effectsByFunction.get(calleeId);
    if (!calleeEffects || calleeEffects.size === 0) {
      continue;
    }

    for (const callerId of callersByCallee.get(calleeId) ?? []) {
      const callerEffects = effectsByFunction.get(callerId);
      if (!callerEffects) {
        continue;
      }

      let changed = false;
      for (const effect of calleeEffects) {
        if (!callerEffects.has(effect)) {
          callerEffects.add(effect);
          changed = true;
        }
      }
      if (changed && !queued.has(callerId)) {
        pending.push(callerId);
        queued.add(callerId);
      }
    }
  }

  return functions.map((functionAnalysis) => ({
    ...functionAnalysis,
    effects: orderEffects(effectsByFunction.get(functionAnalysis.id) ?? new Set()),
  }));
}

function recordCallEffects(
  call: ts.CallExpression | ts.NewExpression,
  callsByLocation: ReadonlyMap<string, CallEdge>,
  definition: FunctionDefinition,
  facade: CompilerFacade,
  effects: Set<Effect>,
): void {
  const typescript = facade.typescript;
  const location = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart());
  const edge = callsByLocation.get(`${location.line + 1}:${location.character + 1}`);
  const moduleName = getImportedModule(call.expression, facade);
  const methodName = getCallName(call.expression, typescript);

  if (moduleName && !edge?.to) {
    recordModuleEffects(moduleName, methodName, effects);
    return;
  }

  if (methodName === "fetch") {
    effects.add("NETWORK_IO");
    effects.add("READS_EXTERNAL_STATE");
    effects.add("SPAWNS_ASYNC_WORK");
    return;
  }
  if (methodName.startsWith("console.")) {
    effects.add("WRITES_EXTERNAL_STATE");
    return;
  }
  if (methodName === "Date.now" || methodName === "Math.random") {
    effects.add("READS_EXTERNAL_STATE");
    return;
  }
  if (methodName === "JSON.parse" || methodName === "JSON.stringify") {
    effects.add("ALLOCATES");
    return;
  }

  if (isMutatingCollectionCall(call.expression, facade)) {
    const receiver = getCallReceiver(call.expression, typescript);
    if (receiver) {
      recordMutation(receiver, true, definition, facade, effects);
    }
    return;
  }

  if (isAllocatingArrayCall(call.expression, facade)) {
    effects.add("ALLOCATES");
    return;
  }

  if (isKnownPureLibraryCall(call.expression, facade)) {
    return;
  }

  if (edge?.kind === "DYNAMIC" || edge?.kind === "UNRESOLVED" || edge?.kind === "EXTERNAL") {
    effects.add("UNKNOWN_SIDE_EFFECT");
  }
}

function recordModuleEffects(moduleName: string, methodName: string, effects: Set<Effect>): void {
  const normalizedName = moduleName.replace(/^node:/, "");
  if (normalizedName === "fs" || normalizedName.startsWith("fs/")) {
    effects.add("FILESYSTEM_IO");
    effects.add(fsWriteMethods.has(methodName) ? "WRITES_EXTERNAL_STATE" : "READS_EXTERNAL_STATE");
  } else if (networkModules.has(moduleName) || networkModules.has(normalizedName)) {
    effects.add("NETWORK_IO");
    effects.add("READS_EXTERNAL_STATE");
  } else if (processModules.has(moduleName) || processModules.has(normalizedName)) {
    effects.add("PROCESS_CONTROL");
  } else if (databaseModules.has(normalizedName)
    || [...databaseModules].some((databaseModule) => normalizedName.startsWith(`${databaseModule}/`))) {
    effects.add("DATABASE_IO");
    effects.add("READS_EXTERNAL_STATE");
  } else {
    effects.add("UNKNOWN_SIDE_EFFECT");
  }
}

function isMutatingCollectionCall(expression: ts.Expression, facade: CompilerFacade): boolean {
  const receiver = getCallReceiver(expression, facade.typescript);
  const methodName = getCallName(expression, facade.typescript).split(".").at(-1);
  return Boolean(receiver
    && methodName
    && mutatingMethods.has(methodName)
    && isCollectionType(facade.checker.getTypeAtLocation(receiver), facade));
}

function isAllocatingArrayCall(expression: ts.Expression, facade: CompilerFacade): boolean {
  const receiver = getCallReceiver(expression, facade.typescript);
  const methodName = getCallName(expression, facade.typescript).split(".").at(-1);
  return Boolean(receiver
    && methodName
    && allocatingArrayMethods.has(methodName)
    && (facade.checker.isArrayType(facade.checker.getTypeAtLocation(receiver))
      || facade.checker.isTupleType(facade.checker.getTypeAtLocation(receiver))));
}

function isKnownPureLibraryCall(expression: ts.Expression, facade: CompilerFacade): boolean {
  const typescript = facade.typescript;
  const methodName = getCallName(expression, typescript);
  if (["Math.abs", "Math.ceil", "Math.floor", "Math.max", "Math.min", "Math.trunc", "Number.isFinite", "Number.isInteger"].includes(methodName)) {
    return true;
  }

  const receiver = getCallReceiver(expression, typescript);
  if (!receiver) {
    return false;
  }

  const receiverType = facade.checker.getTypeAtLocation(receiver);
  if (facade.checker.isArrayType(receiverType) || facade.checker.isTupleType(receiverType)) {
    const finalMethod = methodName.split(".").at(-1);
    return finalMethod !== undefined && pureArrayMethods.has(finalMethod);
  }
  if (receiverType.flags & typescript.TypeFlags.StringLike) {
    return true;
  }
  return false;
}

function isCollectionType(type: ts.Type, facade: CompilerFacade): boolean {
  if (facade.checker.isArrayType(type) || facade.checker.isTupleType(type)) {
    return true;
  }
  const name = type.getSymbol()?.getName();
  return name === "Map" || name === "Set" || name === "WeakMap" || name === "WeakSet"
    || (name !== undefined && facade.checker.getApparentType(type).getSymbol()?.getName() !== undefined
      && (name.startsWith("Int") || name.startsWith("Uint") || name.startsWith("Float")));
}

function getCallReceiver(expression: ts.Expression, typescript: typeof import("typescript")): ts.Expression | undefined {
  if (typescript.isPropertyAccessExpression(expression)) {
    return expression.expression;
  }
  if (typescript.isElementAccessExpression(expression)) {
    return expression.expression;
  }
  return undefined;
}

function getCallName(expression: ts.Expression, typescript: typeof import("typescript")): string {
  if (typescript.isIdentifier(expression)) {
    return expression.text;
  }
  if (typescript.isPropertyAccessExpression(expression)) {
    return `${getCallName(expression.expression, typescript)}.${expression.name.text}`;
  }
  if (typescript.isElementAccessExpression(expression)) {
    return `${getCallName(expression.expression, typescript)}[]`;
  }
  if (typescript.isCallExpression(expression)) {
    return `${getCallName(expression.expression, typescript)}()`;
  }
  return "";
}

function getImportedModule(expression: ts.Expression, facade: CompilerFacade): string | undefined {
  const typescript = facade.typescript;
  const locations: ts.Node[] = [expression];
  const receiver = getCallReceiver(expression, typescript);
  if (receiver) {
    locations.push(receiver);
  }

  for (const location of locations) {
    const symbol = facade.checker.getSymbolAtLocation(location);
    for (const declaration of symbol?.declarations ?? []) {
      let current: ts.Node | undefined = declaration;
      while (current) {
        if (typescript.isImportDeclaration(current) && typescript.isStringLiteral(current.moduleSpecifier)) {
          return current.moduleSpecifier.text;
        }
        current = current.parent;
      }
    }
  }
  return undefined;
}

function recordMutation(
  target: ts.Expression,
  mutatesReceiver: boolean,
  definition: FunctionDefinition,
  facade: CompilerFacade,
  effects: Set<Effect>,
): void {
  const typescript = facade.typescript;
  const targetIsProperty = mutatesReceiver
    || typescript.isPropertyAccessExpression(target)
    || typescript.isElementAccessExpression(target);
  const root = getRootExpression(target, typescript);

  if (root.kind === typescript.SyntaxKind.ThisKeyword) {
    effects.add(targetIsProperty ? "MUTATES_ARGUMENT" : "MUTATES_LOCAL_STATE");
    return;
  }
  if (!typescript.isIdentifier(root)) {
    effects.add("MUTATES_LOCAL_STATE");
    return;
  }

  const name = root.text;
  const isParameter = definition.node.parameters.some((parameter) => (
    typescript.isIdentifier(parameter.name) && parameter.name.text === name
  ));
  if (isParameter && targetIsProperty) {
    effects.add("MUTATES_ARGUMENT");
  } else if (isParameter || isDeclaredInsideFunction(root, definition, facade)) {
    effects.add("MUTATES_LOCAL_STATE");
  } else {
    effects.add("MUTATES_GLOBAL_STATE");
  }
}

function getRootExpression(expression: ts.Expression, typescript: typeof import("typescript")): ts.Expression {
  let current = expression;
  while (typescript.isPropertyAccessExpression(current)
    || typescript.isElementAccessExpression(current)
    || typescript.isParenthesizedExpression(current)
    || typescript.isAsExpression(current)
    || typescript.isTypeAssertionExpression(current)
    || typescript.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function isDeclaredInsideFunction(
  identifier: ts.Identifier,
  definition: FunctionDefinition,
  facade: CompilerFacade,
): boolean {
  const body = definition.node.body;
  if (!body) {
    return false;
  }
  const bodyStart = body.getStart(definition.sourceFile);
  const bodyEnd = body.end;
  const symbol = facade.checker.getSymbolAtLocation(identifier);
  return (symbol?.declarations ?? []).some((declaration) => (
    declaration.getSourceFile() === definition.sourceFile
    && declaration.getStart() >= bodyStart
    && declaration.getStart() <= bodyEnd
  ));
}

function recordExternalVariableRead(
  identifier: ts.Identifier,
  definition: FunctionDefinition,
  facade: CompilerFacade,
  effects: Set<Effect>,
): void {
  const typescript = facade.typescript;
  if (identifier.text === "process"
    && typescript.isPropertyAccessExpression(identifier.parent)
    && identifier.parent.name.text === "env") {
    effects.add("READS_EXTERNAL_STATE");
  }

  const symbol = facade.checker.getSymbolAtLocation(identifier);
  const declarations = symbol?.declarations ?? [];
  if (declarations.some((declaration) => {
    if (!typescript.isVariableDeclaration(declaration)) {
      return false;
    }
    const start = definition.node.body?.getStart(definition.sourceFile) ?? 0;
    const end = definition.node.body?.end ?? 0;
    const declarationStart = declaration.getStart();
    return declarationStart < start || declarationStart > end;
  })) {
    effects.add("READS_EXTERNAL_STATE");
  }
}

function isAssignment(kind: ts.SyntaxKind, typescript: typeof import("typescript")): boolean {
  return kind >= typescript.SyntaxKind.FirstAssignment && kind <= typescript.SyntaxKind.LastAssignment;
}

function orderEffects(effects: ReadonlySet<Effect>): Effect[] {
  if (effects.size === 0) {
    return ["PURE"];
  }
  return effectOrder.filter((effect) => effects.has(effect));
}