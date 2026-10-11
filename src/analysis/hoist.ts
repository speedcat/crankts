import type * as ts from "typescript";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import { packageRootFromUrl } from "./cpu-profile.js";
import type { CallSiteObservation, HoistCandidate } from "./model.js";

/**
 * HOIST_INVARIANT_WORK detection (v0.2.6d, R3). Recognition only, no transformation. A candidate is a call
 * that builds reusable state, made inside a function every time it runs:
 *
 * - REGEXP: `new RegExp(…)` / `RegExp(…)`
 * - RETURNS_FUNCTION: the call returns a function (matcher factories such as `picomatch(patterns)`)
 * - PACKAGE_INSTANCE: `new X(…)` of a class declared in a dependency (resolvers, parsers, …)
 * - COMPILE_LIKE_DEPENDENCY: a call into a dependency whose profiled time is mostly under compile-like frames
 *   (runtime evidence; e.g. a glob library recompiling its ignore patterns on every call)
 *
 * Each candidate's inputs are classified (see `HoistCandidate.invariance`). Static invariance comes from
 * the checker; repetition of parameter-dependent inputs needs an input-signature profile.
 */
export function detectHoistCandidates(
  fn: ts.Node,
  facade: CompilerFacade,
  callSite: CallSiteObservation | undefined,
  /** Inclusive profiled time (percent) of a project function, by declaration: the cost of calling it. */
  calleeCost: (declaration: ts.Node) => number | undefined = () => undefined,
): HoistCandidate[] {
  const t = facade.typescript;
  const checker = facade.checker;
  const sourceFile = fn.getSourceFile();
  const candidates: HoistCandidate[] = [];
  const entries = callSite?.entries ?? [];

  const visit = (node: ts.Node, loops: readonly ts.Node[]): void => {
    if (node !== fn && t.isFunctionLike(node) && !isInlineCallback(t, node)) return;
    const nextLoops = t.isIterationStatement(node, false) ? [...loops, node] : loops;
    if (t.isCallExpression(node) || t.isNewExpression(node)) {
      const kind = classifyCall(t, checker, node, entries);
      if (kind) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const entry = kind.entry;
        // The call's own cost: compile-like time under its dependency entry, the entry's time, or the
        // inclusive time of a project callee (an upper bound if the callee is also called elsewhere).
        const atStake = kind.kind === "COMPILE_LIKE_DEPENDENCY" ? entry?.compileLikePercent
          : entry?.percent ?? (kind.declaration ? calleeCost(kind.declaration) : undefined);
        candidates.push({
          line: position.line + 1,
          column: position.character + 1,
          callee: node.expression.getText(sourceFile).slice(0, 80),
          kind: kind.kind,
          invariance: classifyInvariance(t, checker, fn, node, loops),
          inLoop: loops.length > 0,
          ...(atStake !== undefined ? { atStakePercent: atStake } : {}),
          ...(entry ? { compileLikePercent: entry.compileLikePercent } : {}),
        });
      }
    }
    node.forEachChild((child) => visit(child, nextLoops));
  };
  visit(fn, []);
  return candidates;
}

type Entry = NonNullable<CallSiteObservation["entries"]>[number];
type Classified = { readonly kind: HoistCandidate["kind"]; readonly entry?: Entry; readonly declaration?: ts.Node };

function classifyCall(
  t: typeof ts,
  checker: ts.TypeChecker,
  node: ts.CallExpression | ts.NewExpression,
  entries: readonly Entry[],
): Classified | undefined {
  const calleeName = t.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText();
  if (calleeName === "RegExp" && (!t.isPropertyAccessExpression(node.expression))) return { kind: "REGEXP" };
  const calleeNode = t.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
  let symbol = checker.getSymbolAtLocation(calleeNode);
  if (symbol && symbol.flags & t.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declarationFile = symbol?.declarations?.[0]?.getSourceFile().fileName ?? "";
  // TypeScript's lib and @types declarations (Map, Set, Node APIs) are not dependency code.
  const packageRoot = /\/node_modules\/(?:typescript\/lib|@types)\//.test(declarationFile) ? undefined : packageRootFromUrl(declarationFile);
  // The profiled dependency entry this call goes into (by package and function name).
  let entry: Entry | undefined;
  if (packageRoot) {
    const packageName = packageRoot.split("/node_modules/").pop() ?? "";
    const exported = symbol?.name ?? calleeName;
    entry = entries.find((candidate) => (
      candidate.origin === packageName
      && (candidate.functionName === exported || candidate.functionName.endsWith(`.${exported}`) || candidate.functionName === calleeName)
    ));
    // Runtime evidence: the entry's time is mostly compile-like work.
    if (entry && entry.micros > 0 && entry.compileLikeMicros / entry.micros >= 0.5) return { kind: "COMPILE_LIKE_DEPENDENCY", entry };
  }
  const declaration = packageRoot ? undefined : symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (t.isNewExpression(node)) {
    return packageRoot ? { kind: "PACKAGE_INSTANCE", ...(entry ? { entry } : {}) } : undefined;
  }
  // Builders: the call's result is a function (a compiled matcher, a predicate). Plain helpers that return
  // data are not candidates.
  const type = checker.getTypeAtLocation(node);
  if (type.getCallSignatures().length > 0 && !isBoundMethodLookup(t, node)) {
    return { kind: "RETURNS_FUNCTION", ...(entry ? { entry } : {}), ...(declaration ? { declaration } : {}) };
  }
  return undefined;
}

/** `arr.map(fn)` style calls return arrays; `obj.bind(…)` returns a function but is cheap. */
function isBoundMethodLookup(t: typeof ts, node: ts.CallExpression): boolean {
  return t.isPropertyAccessExpression(node.expression) && ["bind", "call", "apply"].includes(node.expression.name.text);
}

/** Arrow and function-expression arguments run as part of this function (`.map(x => …)`). */
function isInlineCallback(t: typeof ts, node: ts.Node): boolean {
  return (t.isArrowFunction(node) || t.isFunctionExpression(node)) && t.isCallExpression(node.parent) && node.parent.arguments.includes(node as ts.Expression);
}

/**
 * Where the call's inputs come from. Identifiers bound outside the function (module constants, imports)
 * and readonly instance fields are invariant; `const` locals inherit their initializer's class; parameters
 * make the call parameter-dependent; mutable locals make it variant. Loop invariance: no input is
 * declared or assigned inside the innermost enclosing loop.
 */
function classifyInvariance(
  t: typeof ts,
  checker: ts.TypeChecker,
  fn: ts.Node,
  call: ts.CallExpression | ts.NewExpression,
  loops: readonly ts.Node[],
): HoistCandidate["invariance"] {
  let worst: 0 | 1 | 2 = 0; // 0 invariant, 1 parameter-dependent, 2 variant
  const loop = loops[loops.length - 1];
  let loopVariant = false;
  const seen = new Set<ts.Symbol>();
  const raise = (level: 0 | 1 | 2): void => {
    worst = Math.max(worst, level) as 0 | 1 | 2;
  };
  const inspect = (expression: ts.Node): void => {
    if (t.isIdentifier(expression) && !(t.isPropertyAccessExpression(expression.parent) && expression.parent.name === expression)
      && !(t.isPropertyAssignment(expression.parent) && expression.parent.name === expression)) {
      let symbol = checker.getSymbolAtLocation(expression);
      if (symbol && t.isShorthandPropertyAssignment(expression.parent)) symbol = checker.getShorthandAssignmentValueSymbol(expression.parent);
      if (!symbol || seen.has(symbol)) return;
      seen.add(symbol);
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) return; // global
      if (t.isImportSpecifier(declaration) || t.isImportClause(declaration) || t.isNamespaceImport(declaration)
        || t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration) || t.isEnumDeclaration(declaration)) return;
      if (!isWithin(declaration, fn)) {
        // Module scope: invariant only for consts initialized with literals; other module state can change.
        const variable = owningVariable(t, declaration);
        if (!(variable && isConst(t, variable) && variable.initializer && isLiteralValue(t, variable.initializer))) raise(1);
        return;
      }
      if (loop && isWithin(declaration, loop)) loopVariant = true;
      if (t.isParameter(declaration) || (t.isBindingElement(declaration) && t.isParameter(owningParameter(t, declaration) ?? declaration))) {
        raise(1);
        return;
      }
      const variable = owningVariable(t, declaration);
      if (variable && isConst(t, variable) && variable.initializer) {
        inspect(variable.initializer);
        return;
      }
      raise(2);
      return;
    }
    if (expression.kind === t.SyntaxKind.ThisKeyword && t.isPropertyAccessExpression(expression.parent)) {
      const property = checker.getSymbolAtLocation(expression.parent.name)?.valueDeclaration;
      const readonly = property && t.canHaveModifiers(property)
        && (t.getModifiers(property)?.some((modifier) => modifier.kind === t.SyntaxKind.ReadonlyKeyword) ?? false);
      if (!readonly) raise(1);
      return;
    }
    // Results of other calls depend on runtime state unless measured otherwise.
    if ((t.isCallExpression(expression) || t.isNewExpression(expression)) && expression !== call) raise(1);
    if (t.isFunctionLike(expression)) return;
    expression.forEachChild(inspect);
  };
  for (const argument of call.arguments ?? []) inspect(argument);
  if (t.isPropertyAccessExpression(call.expression)) inspect(call.expression.expression);

  if (worst === 0) return "STATIC_INVARIANT";
  if (loop && !loopVariant) return "LOOP_INVARIANT";
  return worst === 1 ? "PARAM_DEPENDENT" : "VARIANT";
}

/** The variable declaration a (possibly destructured) binding belongs to. */
function owningVariable(t: typeof ts, declaration: ts.Node): ts.VariableDeclaration | undefined {
  let node: ts.Node | undefined = declaration;
  while (node && (t.isBindingElement(node) || t.isObjectBindingPattern(node) || t.isArrayBindingPattern(node))) node = node.parent;
  return node && t.isVariableDeclaration(node) ? node : undefined;
}

function owningParameter(t: typeof ts, declaration: ts.Node): ts.ParameterDeclaration | undefined {
  let node: ts.Node | undefined = declaration;
  while (node && (t.isBindingElement(node) || t.isObjectBindingPattern(node) || t.isArrayBindingPattern(node))) node = node.parent;
  return node && t.isParameter(node) ? node : undefined;
}

function isConst(t: typeof ts, declaration: ts.VariableDeclaration): boolean {
  return t.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & t.NodeFlags.Const) !== 0;
}

/** Literals and arrays/objects of literals: values that cannot change after module initialization. */
function isLiteralValue(t: typeof ts, node: ts.Expression): boolean {
  if (t.isParenthesizedExpression(node) || t.isAsExpression(node) || t.isSatisfiesExpression(node)) return isLiteralValue(t, node.expression);
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isNoSubstitutionTemplateLiteral(node) || t.isRegularExpressionLiteral(node)
    || node.kind === t.SyntaxKind.TrueKeyword || node.kind === t.SyntaxKind.FalseKeyword) return true;
  if (t.isArrayLiteralExpression(node)) return node.elements.every((element) => isLiteralValue(t, element as ts.Expression));
  if (t.isObjectLiteralExpression(node)) return node.properties.every((property) => t.isPropertyAssignment(property) && isLiteralValue(t, property.initializer));
  return false;
}

function isWithin(node: ts.Node, container: ts.Node): boolean {
  return node.getSourceFile() === container.getSourceFile() && node.pos >= container.pos && node.end <= container.end;
}

