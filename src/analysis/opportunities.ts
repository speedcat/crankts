import type * as ts from "typescript";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import { isFunctionBoundary } from "./functions.js";
import type { FunctionDefinition } from "./functions.js";
import type { Effect, OpportunityScores } from "./model.js";

const riskyEffects = new Set<Effect>([
  "DATABASE_IO",
  "FILESYSTEM_IO",
  "MUTATES_ARGUMENT",
  "MUTATES_GLOBAL_STATE",
  "NETWORK_IO",
  "PROCESS_CONTROL",
  "READS_EXTERNAL_STATE",
  "SPAWNS_ASYNC_WORK",
  "UNKNOWN_SIDE_EFFECT",
  "WRITES_EXTERNAL_STATE",
]);

export function scoreOpportunities(
  definition: FunctionDefinition,
  effects: readonly Effect[],
  facade: CompilerFacade,
): OpportunityScores {
  const typescript = facade.typescript;
  const body = definition.node.body;
  if (!body) {
    return { cpu: 0, memory: 0, parallel: 0 };
  }
  const arithmeticOperatorKinds = getArithmeticOperatorKinds(typescript);

  let loopCount = 0;
  let maxLoopDepth = 0;
  let numericOperations = 0;
  let sortCalls = 0;
  let allocationsInLoops = 0;
  let allocatingCollectionCalls = 0;

  const visit = (node: ts.Node, loopDepth: number): void => {
    if (node !== body && isFunctionBoundary(node, typescript)) {
      return;
    }

    const entersLoop = isLoop(node, typescript);
    const currentLoopDepth = loopDepth + (entersLoop ? 1 : 0);
    if (entersLoop) {
      loopCount += 1;
      maxLoopDepth = Math.max(maxLoopDepth, currentLoopDepth);
    }

    if (currentLoopDepth > 0 && (
      typescript.isArrayLiteralExpression(node)
      || typescript.isObjectLiteralExpression(node)
      || typescript.isNewExpression(node)
    )) {
      allocationsInLoops += 1;
    }

    if (typescript.isBinaryExpression(node) && arithmeticOperatorKinds.has(node.operatorToken.kind)) {
      numericOperations += 1;
    }

    if (typescript.isCallExpression(node) || typescript.isNewExpression(node)) {
      const methodName = getMethodName(node.expression, typescript);
      if (methodName === "sort") {
        sortCalls += 1;
      }
      if (["filter", "flat", "flatMap", "map", "slice", "toReversed", "toSorted", "toSpliced", "with"].includes(methodName)) {
        allocatingCollectionCalls += 1;
      }
    }

    typescript.forEachChild(node, (child) => visit(child, currentLoopDepth));
  };

  visit(body, 0);

  const cpu = clampScore(
    (loopCount > 0 ? 20 : 0)
      + Math.min(30, Math.max(0, maxLoopDepth - 1) * 20)
      + Math.min(30, numericOperations * 5)
      + Math.min(45, sortCalls * 45)
      + (definition.node.body && containsSelfCall(definition, facade) ? 15 : 0),
  );
  const memory = clampScore(
    (effects.includes("ALLOCATES") ? 30 : 0)
      + Math.min(45, allocationsInLoops * 25)
      + Math.min(30, allocatingCollectionCalls * 20),
  );
  const parallel = loopCount === 0
    ? 0
    : clampScore(
      30
        + Math.min(20, numericOperations * 4)
        + (effects.some((effect) => riskyEffects.has(effect)) ? 0 : 30)
        + (maxLoopDepth > 1 ? 10 : 0),
    );

  return { cpu, memory, parallel };
}

export function calculateNativePriority(suitability: number, opportunities: OpportunityScores): number {
  const maximumOpportunity = Math.max(opportunities.cpu, opportunities.memory, opportunities.parallel);
  return Math.round(suitability * maximumOpportunity / 100);
}

function isLoop(node: ts.Node, typescript: typeof import("typescript")): boolean {
  return typescript.isForStatement(node)
    || typescript.isForInStatement(node)
    || typescript.isForOfStatement(node)
    || typescript.isWhileStatement(node)
    || typescript.isDoStatement(node);
}

function getArithmeticOperatorKinds(typescript: typeof import("typescript")): Set<ts.SyntaxKind> {
  return new Set([
    typescript.SyntaxKind.PlusToken,
    typescript.SyntaxKind.MinusToken,
    typescript.SyntaxKind.AsteriskToken,
    typescript.SyntaxKind.SlashToken,
    typescript.SyntaxKind.PercentToken,
    typescript.SyntaxKind.AsteriskAsteriskToken,
    typescript.SyntaxKind.LessThanLessThanToken,
    typescript.SyntaxKind.GreaterThanGreaterThanToken,
    typescript.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    typescript.SyntaxKind.AmpersandToken,
    typescript.SyntaxKind.BarToken,
    typescript.SyntaxKind.CaretToken,
  ]);
}

function getMethodName(expression: ts.Expression, typescript: typeof import("typescript")): string {
  if (typescript.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (typescript.isElementAccessExpression(expression) && expression.argumentExpression) {
    if (typescript.isStringLiteral(expression.argumentExpression)) {
      return expression.argumentExpression.text;
    }
  }
  return "";
}

function containsSelfCall(definition: FunctionDefinition, facade: CompilerFacade): boolean {
  const body = definition.node.body;
  if (!body) {
    return false;
  }
  const functionSymbol = getFunctionSymbol(definition, facade);
  if (!functionSymbol) {
    return false;
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (node !== body && isFunctionBoundary(node, facade.typescript))) {
      return;
    }
    if (facade.typescript.isCallExpression(node)
      && facade.checker.getSymbolAtLocation(node.expression) === functionSymbol) {
      found = true;
      return;
    }
    facade.typescript.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function getFunctionSymbol(definition: FunctionDefinition, facade: CompilerFacade): ts.Symbol | undefined {
  const node = definition.node;
  if ("name" in node && node.name) {
    return facade.checker.getSymbolAtLocation(node.name);
  }

  const parent = node.parent;
  if (facade.typescript.isVariableDeclaration(parent)
    || facade.typescript.isPropertyAssignment(parent)
    || facade.typescript.isPropertyDeclaration(parent)) {
    return facade.checker.getSymbolAtLocation(parent.name);
  }

  return undefined;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}