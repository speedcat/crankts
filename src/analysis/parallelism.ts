import type * as ts from "typescript";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import { isFunctionBoundary } from "./functions.js";
import type { FunctionDefinition } from "./functions.js";
import type {
  CallEdge,
  Effect,
  MemoryAccess,
  MemoryAccessScope,
  MemoryDependence,
  ParallelismAnalysis,
  ParallelismClass,
  ParallelismRegion,
} from "./model.js";

const externalBoundaries = new Set([
  "DATABASE",
  "DYNAMIC",
  "EXTERNAL_UNKNOWN",
  "NETWORK",
  "NODE_IO",
  "PROCESS",
  "UNRESOLVED",
]);

interface Access extends MemoryAccess {
  readonly reduction?: boolean;
}

interface LoopContext {
  readonly inductionVariables: Set<string>;
  readonly iterationSources: Map<string, string>;
  readonly localVariables: Set<string>;
}

export function analyzeParallelism(
  definition: FunctionDefinition,
  calls: readonly CallEdge[],
  effects: readonly Effect[],
  facade: CompilerFacade,
  effectsByFunction: ReadonlyMap<string, readonly Effect[]>,
): ParallelismAnalysis {
  const body = definition.node.body;
  if (!body) return emptyAnalysis();

  const regions: ParallelismRegion[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== body && isFunctionBoundary(node, facade.typescript)) return;
    if (isLoop(node, facade.typescript)) {
      regions.push(analyzeLoop(node, calls, effects, effectsByFunction, facade));
    }
    if (isPromiseAllMap(node, facade.typescript)) {
      regions.push(analyzePromiseAll(node, calls, effects, facade));
    }
    facade.typescript.forEachChild(node, visit);
  };
  visit(body);

  if (regions.length === 0) return emptyAnalysis();
  return {
    classification: combineClassifications(regions.map((region) => region.classification)),
    reads: unique(regions.flatMap((region) => region.reads.map((access) => access.target))),
    writes: unique(regions.flatMap((region) => region.writes.map((access) => access.target))),
    sharedWrites: unique(regions.flatMap((region) => region.sharedWrites)),
    dependences: uniqueDependences(regions.flatMap((region) => region.dependences)),
    regions,
  };
}

function analyzeLoop(
  loop: ts.IterationStatement,
  calls: readonly CallEdge[],
  effects: readonly Effect[],
  effectsByFunction: ReadonlyMap<string, readonly Effect[]>,
  facade: CompilerFacade,
): ParallelismRegion {
  const typescript = facade.typescript;
  const context = createLoopContext(loop, facade);
  const reads = new Map<string, Access>();
  const writes = new Map<string, Access>();
  const boundaries = boundariesIn(loop.statement, calls, facade);

  if (typescript.isForOfStatement(loop) || typescript.isForInStatement(loop)) {
    addAccess(reads, makeAccess(`${target(loop.expression, typescript)}[*]`, "READ", loop, context));
  }

  const visit = (node: ts.Node): void => {
    if (node !== loop.statement && isFunctionBoundary(node, typescript)) return;

    if (typescript.isBinaryExpression(node) && isAssignment(node.operatorToken.kind, typescript)) {
      const isReduction = isReductionOperator(node.operatorToken.kind, typescript);
      const write = makeAccess(target(node.left, typescript), "WRITE", node, context, isReduction);
      addAccess(writes, write);
      if (isReduction) addAccess(reads, { ...write, mode: "READ" });
      visit(node.right);
      return;
    }

    if ((typescript.isPrefixUnaryExpression(node) || typescript.isPostfixUnaryExpression(node))
      && isIncrementOrDecrement(node.operator, typescript)) {
      const access = makeAccess(target(node.operand, typescript), "WRITE", node, context, true);
      addAccess(writes, access);
      addAccess(reads, { ...access, mode: "READ" });
      return;
    }

    if (typescript.isCallExpression(node) || typescript.isNewExpression(node)) {
      recordMutation(node, context, reads, writes, facade);
    }

    if (typescript.isElementAccessExpression(node) && !isAssignmentTarget(node, typescript)) {
      addAccess(reads, makeAccess(target(node, typescript), "READ", node, context));
      if (node.argumentExpression) visit(node.argumentExpression);
      return;
    }

    if (typescript.isIdentifier(node) && isValueRead(node, typescript)) {
      const source = context.iterationSources.get(node.text);
      if (source) {
        addAccess(reads, makeAccess(source, "READ", node, context));
      } else if (!context.localVariables.has(node.text)) {
        addAccess(reads, makeAccess(node.text, "READ", node, context));
      }
    }

    facade.typescript.forEachChild(node, visit);
  };
  visit(loop.statement);

  const readSet = [...reads.values()];
  const writeSet = [...writes.values()];
  const dependences = inferDependences(readSet, writeSet);
  const sharedWrites = unique(writeSet.filter((access) => access.scope === "SHARED").map((access) => access.target));
  const regionCalls = callEdgesIn(loop.statement, calls, facade);
  const localCallEffects = unique(regionCalls.flatMap((edge) => (
    edge.to ? effectsByFunction.get(edge.to) ?? [] : []
  )).filter(isRegionSideEffect));
  const unknownBoundary = boundaries.some((boundary) => boundary === "DYNAMIC" || boundary === "EXTERNAL_UNKNOWN" || boundary === "UNRESOLVED")
    || localCallEffects.includes("UNKNOWN_SIDE_EFFECT");
  const externalEffects = unique([...relevantEffects(effects, boundaries), ...localCallEffects]);
  if (unknownBoundary && effects.includes("UNKNOWN_SIDE_EFFECT") && !externalEffects.includes("UNKNOWN_SIDE_EFFECT")) {
    externalEffects.push("UNKNOWN_SIDE_EFFECT");
  }
  const hasReduction = writeSet.some((access) => access.reduction);
  const hasNonReductionSharedWrite = writeSet.some((access) => access.scope === "SHARED" && !access.reduction);
  const hasPartitionKeyCandidate = writeSet.some((access) => access.partitionKeyCandidate);
  const hasEffectfulCall = localCallEffects.some(requiresCoordination);
  const hasNonReductionRaw = dependences.some((dependence) => (
    dependence.kind === "RAW" && !writeSet.some((access) => access.target === dependence.target && access.reduction)
  ));

  let classification: ParallelismClass;
  let explanation: string;
  if (hasNonReductionRaw) {
    classification = "SEQUENTIAL_DEPENDENCE";
    explanation = "A loop-carried read-after-write dependence requires iteration order.";
  } else if (unknownBoundary) {
    classification = "UNKNOWN";
    explanation = "An unresolved or dynamic call prevents a confident dependence classification.";
  } else if (hasExternalWrite(boundaries) || hasEffectfulCall) {
    classification = "PARALLEL_WITH_SYNCHRONIZATION";
    explanation = "Iterations perform external I/O and require coordination.";
  } else if (hasReduction && !hasNonReductionSharedWrite && !unknownBoundary) {
    classification = "PARALLEL_MAP_REDUCE";
    explanation = "Shared updates form a recognizable reduction candidate; reduction semantics are required to parallelize it.";
  } else if (hasPartitionKeyCandidate && !hasNonReductionRaw && !hasNonReductionSharedWrite) {
    classification = "PARALLEL_PARTITIONABLE";
    explanation = "Writes are keyed by per-iteration data and may be partitioned by key, but key uniqueness is not proven.";
  } else if (hasNonReductionSharedWrite) {
    classification = "PARALLEL_WITH_SYNCHRONIZATION";
    explanation = "Iterations mutate shared or external state and require coordination.";
  } else if (dependences.length > 0) {
    classification = "PARALLEL_PARTITIONABLE";
    explanation = "Dependence evidence remains, but independent partitions may be processed separately.";
  } else {
    classification = "PARALLEL_DOALL";
    explanation = "No loop-carried dependence or shared write was detected, so iterations appear independent.";
  }

  return {
    kind: "LOOP",
    line: lineOf(loop),
    classification,
    reads: readSet,
    writes: writeSet,
    sharedWrites,
    dependences,
    externalEffects,
    explanation,
  };
}

function analyzePromiseAll(
  promiseAll: ts.CallExpression,
  calls: readonly CallEdge[],
  effects: readonly Effect[],
  facade: CompilerFacade,
): ParallelismRegion {
  const typescript = facade.typescript;
  const mapCall = promiseAll.arguments.find((argument): argument is ts.CallExpression => (
    typescript.isCallExpression(argument)
      && typescript.isPropertyAccessExpression(argument.expression)
      && argument.expression.name.text === "map"
  ));
  const reads: MemoryAccess[] = [];
  const writes: MemoryAccess[] = [];
  if (mapCall && typescript.isPropertyAccessExpression(mapCall.expression)) {
    reads.push({
      resource: target(mapCall.expression.expression, typescript),
      target: `${target(mapCall.expression.expression, typescript)}[*]`,
      mode: "READ",
      scope: "SHARED",
      line: lineOf(mapCall),
    });
  }

  const callback = mapCall?.arguments[0];
  if (callback && (typescript.isArrowFunction(callback) || typescript.isFunctionExpression(callback)) && callback.body) {
    const capturedWrites = collectCapturedWrites(callback.body, facade);
    writes.push(...capturedWrites.map((access) => ({ ...access, line: lineOf(callback) })));
  }

  const sharedWrites = unique(writes.filter((access) => access.scope === "SHARED").map((access) => access.target));
  const boundaries = boundariesIn(promiseAll, calls, facade);
  const synchronized = sharedWrites.length > 0 || hasExternalWrite(boundaries) || effects.includes("MUTATES_GLOBAL_STATE");
  return {
    kind: "ASYNC_BATCH",
    line: lineOf(promiseAll),
    classification: synchronized ? "PARALLEL_WITH_SYNCHRONIZATION" : "PARALLEL_PIPELINE",
    reads,
    writes,
    sharedWrites,
    dependences: inferDependences(reads, writes),
    externalEffects: relevantEffects(effects, boundaries),
    explanation: synchronized
      ? "Promise.all batches asynchronous work, but captured shared or external mutation requires coordination."
      : "Promise.all over map explicitly batches independent asynchronous work.",
  };
}

function createLoopContext(loop: ts.IterationStatement, facade: CompilerFacade): LoopContext {
  const typescript = facade.typescript;
  const inductionVariables = new Set<string>();
  const iterationSources = new Map<string, string>();
  const localVariables = new Set<string>();

  if (typescript.isForStatement(loop) && loop.initializer && typescript.isVariableDeclarationList(loop.initializer)) {
    for (const declaration of loop.initializer.declarations) {
      if (typescript.isIdentifier(declaration.name)) {
        inductionVariables.add(declaration.name.text);
        localVariables.add(declaration.name.text);
      }
    }
  } else if ((typescript.isForOfStatement(loop) || typescript.isForInStatement(loop))
    && typescript.isVariableDeclarationList(loop.initializer)) {
    const declaration = loop.initializer.declarations[0];
    if (declaration && typescript.isIdentifier(declaration.name)) {
      inductionVariables.add(declaration.name.text);
      localVariables.add(declaration.name.text);
      iterationSources.set(declaration.name.text, `${target(loop.expression, typescript)}[*]`);
    }
  }

  collectLoopLocals(loop.statement, localVariables, typescript);
  return { inductionVariables, iterationSources, localVariables };
}

function collectLoopLocals(node: ts.Node, locals: Set<string>, typescript: typeof import("typescript")): void {
  const visit = (current: ts.Node): void => {
    if (current !== node && isFunctionBoundary(current, typescript)) return;
    if (typescript.isVariableDeclaration(current) && typescript.isIdentifier(current.name)) {
      locals.add(current.name.text);
    }
    typescript.forEachChild(current, visit);
  };
  visit(node);
}

function makeAccess(
  rawTarget: string,
  mode: "READ" | "WRITE",
  node: ts.Node,
  context: LoopContext,
  reduction = false,
): Access {
  const resource = rawTarget.split(/[.[]/, 1)[0] ?? rawTarget;
  const indexMatch = rawTarget.match(/^([^[]+)\[([^\]]+)\]$/);
  const index = indexMatch?.[2];
  const scope: MemoryAccessScope = context.localVariables.has(resource)
    ? "ITERATION_LOCAL"
    : index && context.inductionVariables.has(index)
      ? "PARTITIONED"
      : "SHARED";
  const iterationSource = context.iterationSources.get(resource);
  const resolvedTarget = mode === "READ" && scope === "PARTITIONED"
    ? `${resource}[*]`
    : iterationSource && !indexMatch
    ? `${iterationSource}${rawTarget === resource ? "" : rawTarget.slice(resource.length)}`
    : rawTarget;
  return {
    resource: iterationSource?.replace(/\[\*\]$/, "") ?? resource,
    target: resolvedTarget,
    mode,
    scope,
    line: lineOf(node),
    ...(reduction ? { reduction: true } : {}),
  };
}

function recordMutation(
  call: ts.CallExpression | ts.NewExpression,
  context: LoopContext,
  reads: Map<string, Access>,
  writes: Map<string, Access>,
  facade: CompilerFacade,
): void {
  const typescript = facade.typescript;
  if (!typescript.isCallExpression(call) || !typescript.isPropertyAccessExpression(call.expression)) return;
  const method = call.expression.name.text;
  const receiver = call.expression.expression;
  const receiverName = target(receiver, typescript);
  const symbolName = facade.checker.getTypeAtLocation(receiver).getSymbol()?.getName();
  const isMapOrSet = symbolName === "Map" || symbolName === "Set" || symbolName === "WeakMap" || symbolName === "WeakSet";

  if ((method === "get" || method === "has") && isMapOrSet) {
    addAccess(reads, makeAccess(`${receiverName}[*]`, "READ", call, context));
    return;
  }
  if (!isMapOrSet && !["add", "clear", "delete", "pop", "push", "set", "shift", "splice", "unshift"].includes(method)) return;

  const isMapSetReduction = isMapOrSet
    && method === "set"
    && call.arguments[1]
    && containsMapGet(call.arguments[1], receiverName, facade);
  const mutationTarget = isMapOrSet ? `${receiverName}[*]` : receiverName;
  const keyedByIteration = isMapOrSet
    && method === "set"
    && call.arguments[0]
    && usesIterationValue(call.arguments[0], context, typescript);
  const baseWrite = makeAccess(mutationTarget, "WRITE", call, context, Boolean(isMapSetReduction));
  const write: Access = keyedByIteration
    ? { ...baseWrite, scope: "PARTITIONED", partitionKeyCandidate: true }
    : baseWrite;
  addAccess(writes, write);
  if (isMapSetReduction) addAccess(reads, { ...write, mode: "READ" });
}

function collectCapturedWrites(body: ts.ConciseBody, facade: CompilerFacade): MemoryAccess[] {
  const typescript = facade.typescript;
  const localNames = new Set<string>();
  collectLoopLocals(body, localNames, typescript);
  const accesses = new Map<string, MemoryAccess>();
  const visit = (node: ts.Node): void => {
    if (node !== body && isFunctionBoundary(node, typescript)) return;
    if (typescript.isBinaryExpression(node) && isAssignment(node.operatorToken.kind, typescript)) {
      const expression = target(node.left, typescript);
      const resource = expression.split(/[.[]/, 1)[0] ?? expression;
      if (!localNames.has(resource)) {
        accesses.set(resource, { resource, target: expression, mode: "WRITE", scope: "SHARED", line: lineOf(node) });
      }
    }
    if (typescript.isCallExpression(node) && typescript.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (["add", "clear", "delete", "pop", "push", "set", "shift", "splice", "unshift"].includes(method)) {
        const expression = target(node.expression.expression, typescript);
        const resource = expression.split(/[.[]/, 1)[0] ?? expression;
        if (!localNames.has(resource)) {
          accesses.set(resource, { resource, target: expression, mode: "WRITE", scope: "SHARED", line: lineOf(node) });
        }
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(body);
  return [...accesses.values()];
}

function inferDependences(reads: readonly MemoryAccess[], writes: readonly MemoryAccess[]): MemoryDependence[] {
  const result: MemoryDependence[] = [];
  for (const write of writes) {
    if (write.scope === "ITERATION_LOCAL") continue;
    const matchingReads = reads.filter((read) => read.resource === write.resource && read.scope !== "ITERATION_LOCAL");
    const matchingWrites = writes.filter((other) => other.resource === write.resource && other.scope !== "ITERATION_LOCAL");
    const partitionedSameIndex = write.scope === "PARTITIONED" && matchingReads.some((read) => (
      read.scope === "PARTITIONED" && read.target === write.target
    ));

    if (matchingReads.length > 0 && !partitionedSameIndex) {
      result.push({
        kind: "RAW",
        target: matchingReads[0]?.target ?? write.target,
        loopCarried: true,
        reason: `Reads and writes to '${write.resource}' may cross iteration boundaries.`,
      });
    }
    if (matchingWrites.length > 1 || write.scope === "SHARED" || write.partitionKeyCandidate) {
      result.push({
        kind: "WAW",
        target: write.target,
        loopCarried: true,
        reason: `Iterations may write overlapping locations in '${write.resource}'.`,
      });
    }
    if (matchingReads.length > 0 && write.scope === "PARTITIONED" && !partitionedSameIndex) {
      result.push({
        kind: "WAR",
        target: write.target,
        loopCarried: true,
        reason: `A read of '${write.resource}' may overlap another iteration's write.`,
      });
    }
  }
  return uniqueDependences(result);
}

function callEdgesIn(node: ts.Node, calls: readonly CallEdge[], facade: CompilerFacade): CallEdge[] {
  const locations = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (current !== node && isFunctionBoundary(current, facade.typescript)) return;
    if (facade.typescript.isCallExpression(current) || facade.typescript.isNewExpression(current)) {
      locations.add(`${lineOf(current)}:${columnOf(current)}`);
    }
    facade.typescript.forEachChild(current, visit);
  };
  visit(node);
  return calls.filter((call) => locations.has(`${call.line}:${call.column}`));
}

function boundariesIn(node: ts.Node, calls: readonly CallEdge[], facade: CompilerFacade): string[] {
  return unique(callEdgesIn(node, calls, facade)
    .filter((call) => externalBoundaries.has(call.boundaryKind))
    .map((call) => call.boundaryKind));
}

function relevantEffects(effects: readonly Effect[], boundaries: readonly string[]): Effect[] {
  if (boundaries.length === 0) return [];
  return effects.filter((effect) => effect !== "PURE" && effect !== "ALLOCATES" && effect !== "MUTATES_LOCAL_STATE");
}

function hasExternalWrite(boundaries: readonly string[]): boolean {
  return boundaries.some((boundary) => ["DATABASE", "NETWORK", "NODE_IO", "PROCESS"].includes(boundary));
}

function isRegionSideEffect(effect: Effect): boolean {
  return effect === "DATABASE_IO"
    || effect === "FILESYSTEM_IO"
    || effect === "MUTATES_ARGUMENT"
    || effect === "MUTATES_GLOBAL_STATE"
    || effect === "NETWORK_IO"
    || effect === "PROCESS_CONTROL"
    || effect === "READS_EXTERNAL_STATE"
    || effect === "UNKNOWN_SIDE_EFFECT"
    || effect === "WRITES_EXTERNAL_STATE";
}

function requiresCoordination(effect: Effect): boolean {
  return effect !== "READS_EXTERNAL_STATE";
}

function isPromiseAllMap(node: ts.Node, typescript: typeof import("typescript")): node is ts.CallExpression {
  return typescript.isCallExpression(node)
    && typescript.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText() === "Promise"
    && node.expression.name.text === "all"
    && node.arguments.some((argument) => (
      typescript.isCallExpression(argument)
        && typescript.isPropertyAccessExpression(argument.expression)
        && argument.expression.name.text === "map"
    ));
}

function containsMapGet(expression: ts.Expression, receiver: string, facade: CompilerFacade): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (facade.typescript.isCallExpression(node)
      && facade.typescript.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "get"
      && target(node.expression.expression, facade.typescript) === receiver) {
      found = true;
    }
    facade.typescript.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function usesIterationValue(expression: ts.Expression, context: LoopContext, typescript: typeof import("typescript")): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (typescript.isIdentifier(node) && context.iterationSources.has(node.text)) found = true;
    if (!found) typescript.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function isAssignmentTarget(node: ts.ElementAccessExpression, typescript: typeof import("typescript")): boolean {
  return typescript.isBinaryExpression(node.parent)
    && node.parent.left === node
    && isAssignment(node.parent.operatorToken.kind, typescript);
}

function isValueRead(node: ts.Identifier, typescript: typeof import("typescript")): boolean {
  const parent = node.parent;
  if (typescript.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (typescript.isPropertyAccessExpression(parent)
    && parent.expression === node
    && typescript.isCallExpression(parent.parent)
    && parent.parent.expression === parent) return false;
  if (typescript.isPropertyAssignment(parent) && parent.name === node) return false;
  if (typescript.isVariableDeclaration(parent) && parent.name === node) return false;
  if (typescript.isParameter(parent) && parent.name === node) return false;
  if (typescript.isBinaryExpression(parent) && parent.left === node && isAssignment(parent.operatorToken.kind, typescript)) return false;
  if (typescript.isPropertyAccessExpression(parent) && parent.expression === node) return true;
  if (typescript.isElementAccessExpression(parent) && parent.expression === node) return true;
  return true;
}

function target(expression: ts.Expression, typescript: typeof import("typescript")): string {
  if (typescript.isIdentifier(expression)) return expression.text;
  if (typescript.isPropertyAccessExpression(expression)) return `${target(expression.expression, typescript)}.${expression.name.text}`;
  if (typescript.isElementAccessExpression(expression)) {
    const base = target(expression.expression, typescript);
    const index = expression.argumentExpression;
    if (index && (typescript.isIdentifier(index) || typescript.isNumericLiteral(index))) {
      return `${base}[${index.getText()}]`;
    }
    return `${base}[*]`;
  }
  return expression.getText().replace(/\s+/g, " ");
}

function isReductionOperator(kind: ts.SyntaxKind, typescript: typeof import("typescript")): boolean {
  return [
    typescript.SyntaxKind.PlusEqualsToken,
    typescript.SyntaxKind.MinusEqualsToken,
    typescript.SyntaxKind.AsteriskEqualsToken,
    typescript.SyntaxKind.BarEqualsToken,
    typescript.SyntaxKind.AmpersandEqualsToken,
    typescript.SyntaxKind.CaretEqualsToken,
  ].includes(kind);
}

function isIncrementOrDecrement(kind: ts.SyntaxKind, typescript: typeof import("typescript")): boolean {
  return kind === typescript.SyntaxKind.PlusPlusToken || kind === typescript.SyntaxKind.MinusMinusToken;
}

function isAssignment(kind: ts.SyntaxKind, typescript: typeof import("typescript")): boolean {
  return kind >= typescript.SyntaxKind.FirstAssignment && kind <= typescript.SyntaxKind.LastAssignment;
}

function isLoop(node: ts.Node, typescript: typeof import("typescript")): node is ts.IterationStatement {
  return typescript.isForStatement(node)
    || typescript.isForOfStatement(node)
    || typescript.isForInStatement(node)
    || typescript.isWhileStatement(node)
    || typescript.isDoStatement(node);
}

function combineClassifications(classifications: readonly ParallelismClass[]): ParallelismClass {
  const order: readonly ParallelismClass[] = [
    "SEQUENTIAL_DEPENDENCE",
    "PARALLEL_WITH_SYNCHRONIZATION",
    "UNKNOWN",
    "PARALLEL_MAP_REDUCE",
    "PARALLEL_PARTITIONABLE",
    "PARALLEL_PIPELINE",
    "PARALLEL_DOALL",
  ];
  return order.find((classification) => classifications.includes(classification)) ?? "UNKNOWN";
}

function addAccess(targetMap: Map<string, Access>, access: Access): void {
  const key = `${access.resource}:${access.target}:${access.mode}`;
  const previous = targetMap.get(key);
  if (!previous || previous.scope === "PARTITIONED" && access.scope === "SHARED") targetMap.set(key, access);
}

function uniqueDependences(dependences: readonly MemoryDependence[]): MemoryDependence[] {
  const seen = new Set<string>();
  return dependences.filter((dependence) => {
    const key = `${dependence.kind}:${dependence.target}:${dependence.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function lineOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function columnOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).character + 1;
}

function emptyAnalysis(): ParallelismAnalysis {
  return { classification: "UNKNOWN", reads: [], writes: [], sharedWrites: [], dependences: [], regions: [] };
}