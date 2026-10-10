import type * as ts from "typescript";
import { isPathWithin } from "../compiler/compiler-facade.js";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import type { CallEdge, CallEdgeKind, FunctionId, RuntimeBoundaryKind } from "./model.js";
import { isFunctionBoundary } from "./functions.js";
import type { FunctionDefinition, FunctionIndex } from "./functions.js";

export function buildCallGraph(
  facade: CompilerFacade,
  index: FunctionIndex,
): ReadonlyMap<FunctionId, readonly CallEdge[]> {
  const callsByFunction = new Map<FunctionId, CallEdge[]>();

  for (const definition of index.definitions) {
    const calls: CallEdge[] = [];
    const body = definition.node.body;

    if (body) {
      const visit = (node: ts.Node): void => {
        if (node !== body && isFunctionBoundary(node, facade.typescript)) {
          return;
        }

        if (facade.typescript.isCallExpression(node)) {
          addCallEdges(node, "call", definition, calls, facade, index);
        } else if (facade.typescript.isNewExpression(node)) {
          addCallEdges(node, "constructor", definition, calls, facade, index);
        }

        facade.typescript.forEachChild(node, visit);
      };

      visit(body);
    }

    callsByFunction.set(definition.id, calls);
  }

  return callsByFunction;
}

function addCallEdges(
  call: ts.CallExpression | ts.NewExpression,
  callType: "call" | "constructor",
  from: FunctionDefinition,
  calls: CallEdge[],
  facade: CompilerFacade,
  index: FunctionIndex,
): void {
  const expression = unwrapExpression(call.expression, facade.typescript);
  const targetId = resolveTarget(expression, callType, facade, index);
  const edgeKind = getEdgeKind(expression, callType, targetId, facade);
  const boundaryKind = getBoundaryKind(expression, edgeKind, targetId, facade);
  const location = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart());
  const edge: CallEdge = {
    from: from.id,
    ...(targetId ? { to: targetId } : {}),
    kind: edgeKind,
    boundaryKind,
    callee: getExpressionText(expression, facade.typescript),
    line: location.line + 1,
    column: location.character + 1,
  };
  calls.push(edge);

  for (const argument of call.arguments ?? []) {
    const callbackId = resolveTarget(argument, "call", facade, index);
    if (!callbackId) {
      continue;
    }

    const callback = index.byId.get(callbackId);
    if (!callback) {
      continue;
    }

    calls.push({
      from: from.id,
      to: callbackId,
      kind: "CALLBACK",
      boundaryKind: "LOCAL_CALLBACK",
      callee: callback.name,
      line: location.line + 1,
      column: location.character + 1,
    });
  }
}

function getBoundaryKind(
  expression: ts.Expression,
  edgeKind: CallEdgeKind,
  targetId: FunctionId | undefined,
  facade: CompilerFacade,
): RuntimeBoundaryKind {
  if (edgeKind === "DYNAMIC") {
    return "DYNAMIC";
  }
  if (edgeKind === "UNRESOLVED") {
    return "UNRESOLVED";
  }
  if (targetId) {
    if (edgeKind === "CONSTRUCTOR") {
      return "LOCAL_CONSTRUCTOR";
    }
    if (edgeKind === "METHOD_RESOLVED") {
      return "LOCAL_METHOD";
    }
    return "LOCAL_DIRECT";
  }

  if (isDatabaseMethodCall(expression, facade)) {
    return "DATABASE";
  }

  const moduleName = getImportedModule(expression, facade);
  if (moduleName) {
    const knownModuleKind = classifyImportedModule(moduleName);
    if (knownModuleKind) {
      return knownModuleKind;
    }
    return isTypedExternalCall(expression, facade) ? "EXTERNAL_TYPED" : "EXTERNAL_UNKNOWN";
  }

  if (isCollectionCall(expression, facade)) {
    return "STDLIB_COLLECTION";
  }

  const expressionName = getExpressionText(expression, facade.typescript);
  if (expressionName === "fetch") {
    return "NETWORK";
  }
  if (expressionName.startsWith("console.")) {
    return "NODE_IO";
  }
  if (/^(Math|Number|BigInt|Boolean|JSON)\./.test(expressionName)) {
    return "STDLIB_PURE";
  }
  if (/^(Date|Promise|Reflect|RegExp|Intl|Symbol|Object|String|Array)\./.test(expressionName)) {
    return "STDLIB_RUNTIME";
  }

  return isTypedExternalCall(expression, facade) ? "EXTERNAL_TYPED" : "EXTERNAL_UNKNOWN";
}

function getImportedModule(expression: ts.Expression, facade: CompilerFacade): string | undefined {
  const locations: ts.Node[] = [expression];
  const receiver = getCallReceiver(expression, facade.typescript);
  if (receiver) {
    locations.push(receiver);
  }

  for (const symbol of locations.flatMap((location) => getSymbolsForExpression(location as ts.Expression, facade))) {
    for (const declaration of symbol.declarations ?? []) {
      let current: ts.Node | undefined = declaration;
      while (current) {
        if (facade.typescript.isImportDeclaration(current)
          && facade.typescript.isStringLiteral(current.moduleSpecifier)) {
          return current.moduleSpecifier.text;
        }
        current = current.parent;
      }
    }
  }
  return undefined;
}

function classifyImportedModule(moduleName: string): RuntimeBoundaryKind | undefined {
  const normalizedName = moduleName.replace(/^node:/, "");
  if (["fs", "fs/promises", "stream", "stream/promises", "readline", "child_process"].includes(normalizedName)) {
    return normalizedName === "child_process" ? "PROCESS" : "NODE_IO";
  }
  if (["http", "https", "http2", "net", "tls", "dgram", "dns", "undici"].includes(normalizedName)) {
    return "NETWORK";
  }
  if ([
    "better-sqlite3", "sqlite3", "sqlite", "mysql", "mysql2", "pg", "postgres",
    "mongodb", "mongoose", "redis", "ioredis", "drizzle-orm", "typeorm", "sequelize",
    "knex", "@prisma/client", "@libsql/client",
  ].some((name) => normalizedName === name || normalizedName.startsWith(`${name}/`))) {
    return "DATABASE";
  }
  if (["process", "cluster", "worker_threads"].includes(normalizedName)) {
    return "PROCESS";
  }
  if (normalizedName === "fs" || normalizedName.startsWith("fs/")) {
    return "NODE_IO";
  }
  if (["path", "path/posix", "path/win32", "url", "util", "os"].includes(normalizedName)) {
    return "STDLIB_RUNTIME";
  }
  return undefined;
}

function isCollectionCall(expression: ts.Expression, facade: CompilerFacade): boolean {
  const receiver = getCallReceiver(expression, facade.typescript);
  if (!receiver) {
    return false;
  }
  const receiverType = facade.checker.getTypeAtLocation(receiver);
  if (facade.checker.isArrayType(receiverType) || facade.checker.isTupleType(receiverType)) {
    return true;
  }
  const receiverName = receiverType.getSymbol()?.getName();
  return receiverName === "Map" || receiverName === "Set" || receiverName === "WeakMap" || receiverName === "WeakSet";
}

function isDatabaseMethodCall(expression: ts.Expression, facade: CompilerFacade): boolean {
  const receiver = getCallReceiver(expression, facade.typescript);
  if (!receiver || !facade.typescript.isPropertyAccessExpression(expression)) {
    return false;
  }
  if (!["prepare", "query", "exec", "execute", "all", "get", "run", "iterate", "transaction", "batch"].includes(expression.name.text)) {
    return false;
  }

  const receiverType = facade.checker.getTypeAtLocation(receiver);
  const types = receiverType.isUnionOrIntersection() ? receiverType.types : [receiverType];
  return types.some((type) => {
    const symbols = [type.aliasSymbol, type.getSymbol()].filter((symbol): symbol is ts.Symbol => Boolean(symbol));
    return symbols.some((symbol) => {
      const qualifiedName = facade.checker.getFullyQualifiedName(symbol).toLowerCase();
      const declarations = symbol.declarations ?? [];
      const declarationPaths = declarations.map((declaration) => declaration.getSourceFile().fileName.toLowerCase());
      const isDatabaseType = /database|statement|pool|client|connection|prismaclient/.test(symbol.getName().toLowerCase());
      const hasDatabaseProvenance = /sqlite|better-sqlite|(^|[^a-z])pg([^a-z]|$)|mysql|mongodb|mongoose|redis|typeorm|sequelize|knex|prisma/.test(qualifiedName)
        || declarationPaths.some((fileName) => /sqlite-compat|better-sqlite3|node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:sqlite3|pg|mysql2?|postgres|mongodb|mongoose|redis|ioredis|typeorm|sequelize|knex)/.test(fileName));
      return isDatabaseType && hasDatabaseProvenance;
    });
  });
}

function getCallReceiver(expression: ts.Expression, typescript: typeof import("typescript")): ts.Expression | undefined {
  if (typescript.isPropertyAccessExpression(expression) || typescript.isElementAccessExpression(expression)) {
    return expression.expression;
  }
  return undefined;
}

function isTypedExternalCall(expression: ts.Expression, facade: CompilerFacade): boolean {
  const signatureKind = facade.typescript.SignatureKind.Call;
  const callType = facade.checker.getTypeAtLocation(expression);
  const signatures = facade.checker.getSignaturesOfType(callType, signatureKind);
  if (signatures.length === 0) {
    return false;
  }

  return signatures.every((signature) => {
    const types = [
      facade.checker.getReturnTypeOfSignature(signature),
      ...signature.getParameters().map((parameter) => facade.checker.getTypeOfSymbolAtLocation(parameter, expression)),
    ];
    return types.every((type) => !(
      type.flags & (facade.typescript.TypeFlags.Any | facade.typescript.TypeFlags.Unknown)
    ));
  });
}

function getEdgeKind(
  expression: ts.Expression,
  callType: "call" | "constructor",
  targetId: FunctionId | undefined,
  facade: CompilerFacade,
): CallEdgeKind {
  if (callType === "constructor") {
    return "CONSTRUCTOR";
  }

  if (isDynamicCall(expression, facade)) {
    return "DYNAMIC";
  }
  if (targetId) {
    return facade.typescript.isPropertyAccessExpression(expression)
      || facade.typescript.isElementAccessExpression(expression)
      ? "METHOD_RESOLVED"
      : "DIRECT_RESOLVED";
  }

  const symbols = getSymbolsForExpression(expression, facade);
  const declarations = symbols.flatMap((symbol) => symbol.declarations ?? []);
  if (declarations.length === 0) {
    return "UNRESOLVED";
  }

  const projectDeclarations = declarations.filter((declaration) => isLocalCallDeclaration(declaration, facade));
  const hasProjectImplementation = projectDeclarations.some((declaration) => hasFunctionBody(declaration, facade));
  return hasProjectImplementation || projectDeclarations.length > 0 ? "UNRESOLVED" : "EXTERNAL";
}

function isLocalCallDeclaration(declaration: ts.Declaration, facade: CompilerFacade): boolean {
  if (facade.typescript.isImportClause(declaration)
    || facade.typescript.isImportSpecifier(declaration)
    || facade.typescript.isNamespaceImport(declaration)
    || facade.typescript.isImportEqualsDeclaration(declaration)
    || facade.typescript.isExportSpecifier(declaration)) {
    return false;
  }

  const sourceFile = declaration.getSourceFile();
  return !sourceFile.isDeclarationFile
    && !sourceFile.fileName.split(/[\\/]/).includes("node_modules")
    && isPathWithin(facade.projectRoot, sourceFile.fileName);
}

function hasFunctionBody(declaration: ts.Declaration, facade: CompilerFacade): boolean {
  return (facade.typescript.isFunctionDeclaration(declaration)
      || facade.typescript.isFunctionExpression(declaration)
      || facade.typescript.isArrowFunction(declaration)
      || facade.typescript.isMethodDeclaration(declaration)
      || facade.typescript.isConstructorDeclaration(declaration)
      || facade.typescript.isGetAccessorDeclaration(declaration)
      || facade.typescript.isSetAccessorDeclaration(declaration))
    && Boolean(declaration.body);
}

function isDynamicCall(expression: ts.Expression, facade: CompilerFacade): boolean {
  if (facade.typescript.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    return !argument
      || !(facade.typescript.isStringLiteral(argument)
        || facade.typescript.isNoSubstitutionTemplateLiteral(argument)
        || facade.typescript.isNumericLiteral(argument));
  }

  if (facade.typescript.isPropertyAccessExpression(expression)) {
    const receiverType = facade.checker.getTypeAtLocation(expression.expression);
    return Boolean(receiverType.flags & (facade.typescript.TypeFlags.Any | facade.typescript.TypeFlags.Unknown));
  }

  return false;
}

function resolveTarget(
  expression: ts.Expression,
  callType: "call" | "constructor",
  facade: CompilerFacade,
  index: FunctionIndex,
): FunctionId | undefined {
  const unwrapped = unwrapExpression(expression, facade.typescript);
  const nodeId = index.byNode.get(unwrapped);
  if (nodeId) {
    return nodeId;
  }

  for (const symbol of getSymbolsForExpression(unwrapped, facade)) {
    const functionId = index.symbolToFunction.get(symbol);
    if (functionId) {
      return functionId;
    }

    if (callType === "constructor") {
      const constructorId = index.classSymbolToConstructor.get(symbol);
      if (constructorId) {
        return constructorId;
      }
    }
  }

  return undefined;
}

function getSymbolsForExpression(expression: ts.Expression, facade: CompilerFacade): ts.Symbol[] {
  const locations: ts.Node[] = [expression];
  if (facade.typescript.isPropertyAccessExpression(expression)) {
    locations.unshift(expression.name);
  }

  const symbols: ts.Symbol[] = [];
  for (const location of locations) {
    const symbol = facade.checker.getSymbolAtLocation(location);
    if (!symbol) {
      continue;
    }

    if (!symbols.includes(symbol)) {
      symbols.push(symbol);
    }
    if (symbol.flags & facade.typescript.SymbolFlags.Alias) {
      try {
        const aliasedSymbol = facade.checker.getAliasedSymbol(symbol);
        if (!symbols.includes(aliasedSymbol)) {
          symbols.push(aliasedSymbol);
        }
      } catch {
        // Some unresolved import aliases do not have a target symbol.
      }
    }
  }

  return symbols;
}

function unwrapExpression(expression: ts.Expression, facadeTypescript: typeof import("typescript")): ts.Expression {
  let current = expression;
  while (facadeTypescript.isParenthesizedExpression(current)
    || facadeTypescript.isAsExpression(current)
    || facadeTypescript.isTypeAssertionExpression(current)
    || facadeTypescript.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function getExpressionText(expression: ts.Expression, typescript: typeof import("typescript")): string {
  let text: string;
  if (typescript.isIdentifier(expression)) {
    text = expression.text;
  } else if (typescript.isPropertyAccessExpression(expression)) {
    text = `${getExpressionText(expression.expression, typescript)}.${expression.name.text}`;
  } else if (typescript.isElementAccessExpression(expression)) {
    text = `${getExpressionText(expression.expression, typescript)}[${expression.argumentExpression?.getText() ?? ""}]`;
  } else if (typescript.isCallExpression(expression)) {
    text = `${getExpressionText(expression.expression, typescript)}()`;
  } else {
    text = expression.getText().replace(/\s+/g, " ");
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}