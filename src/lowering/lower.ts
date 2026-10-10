import { relative, sep } from "node:path";
import type * as ts from "typescript";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import type { ArrayStorage, BinaryOperator, IrExpr, IrFunction, IrModule, IrStmt, IrStruct, IrType } from "./ir.js";

/**
 * TS -> Kernel IR lowering (v0.2.1). Lowers an entry function and its transitive same-program
 * callees. The accepted subset is exactly what the two validated kernels need; every other construct
 * is a positioned diagnostic and the whole lowering fails closed.
 */

export interface LoweringDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly construct: string;
  readonly message: string;
}

export type LoweringResult =
  | { readonly ok: true; readonly module: IrModule }
  | { readonly ok: false; readonly diagnostics: readonly LoweringDiagnostic[] };

export interface LoweringOptions {
  /** Paths in diagnostics and `IrFunction.source` are relative to this directory. */
  readonly projectRoot?: string;
}

type Facade = Pick<CompilerFacade, "checker" | "typescript">;

const TYPED_ARRAY_STORAGE: Readonly<Record<string, ArrayStorage>> = {
  Uint8Array: "u8",
  Uint32Array: "u32",
  Int32Array: "i32",
  Float64Array: "f64",
};
const F64: IrType = { kind: "f64" };
const BOOL: IrType = { kind: "bool" };
const STRING: IrType = { kind: "string" };

export function lowerKernel(
  entry: ts.FunctionDeclaration,
  facade: Facade,
  options: LoweringOptions = {},
): LoweringResult {
  const lowerer = new Lowerer(facade, options);
  const entryName = lowerer.functionName(entry);
  lowerer.run();
  if (lowerer.diagnostics.length > 0) {
    return { ok: false, diagnostics: lowerer.diagnostics };
  }
  return {
    ok: true,
    module: {
      irVersion: 1,
      entry: entryName,
      functions: lowerer.orderedFunctions(),
      structs: [...lowerer.structs.values()],
    },
  };
}

class Lowerer {
  readonly diagnostics: LoweringDiagnostic[] = [];
  readonly structs = new Map<string, IrStruct>();
  private readonly ts: typeof ts;
  private readonly checker: ts.TypeChecker;
  private readonly names = new Map<ts.FunctionDeclaration, string>();
  private readonly pending: ts.FunctionDeclaration[] = [];
  private readonly lowered = new Map<string, IrFunction>();
  private readonly callees = new Map<string, Set<string>>();
  private current: ts.FunctionDeclaration | undefined;
  private hiddenCounter = 0;

  constructor(facade: Facade, private readonly options: LoweringOptions) {
    this.ts = facade.typescript;
    this.checker = facade.checker;
  }

  functionName(declaration: ts.FunctionDeclaration): string {
    const known = this.names.get(declaration);
    if (known) {
      return known;
    }
    const base = declaration.name?.text ?? "anonymous";
    let name = base;
    for (let suffix = 2; [...this.names.values()].includes(name); suffix += 1) {
      name = `${base}_${suffix}`;
    }
    this.names.set(declaration, name);
    this.pending.push(declaration);
    return name;
  }

  run(): void {
    while (this.pending.length > 0) {
      const declaration = this.pending.shift();
      if (declaration) {
        this.lowerFunction(declaration);
      }
    }
  }

  /** Callees before callers (reverse post-order of the call graph); cycles are reported by the verifier. */
  orderedFunctions(): IrFunction[] {
    const ordered: IrFunction[] = [];
    const visited = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name)) {
        return;
      }
      visited.add(name);
      for (const callee of this.callees.get(name) ?? []) {
        visit(callee);
      }
      const fn = this.lowered.get(name);
      if (fn) {
        ordered.push(fn);
      }
    };
    for (const name of this.lowered.keys()) {
      visit(name);
    }
    return ordered;
  }

  private lowerFunction(declaration: ts.FunctionDeclaration): void {
    const name = this.functionName(declaration);
    this.current = declaration;
    this.callees.set(name, new Set());
    if (!declaration.body) {
      this.report(declaration, "function has no body");
      return;
    }
    if (declaration.asteriskToken || declaration.modifiers?.some((modifier) => modifier.kind === this.ts.SyntaxKind.AsyncKeyword)) {
      this.report(declaration, "generators and async functions are not lowered");
    }
    if (declaration.typeParameters?.length) {
      this.report(declaration, "generic functions are not lowered");
    }
    const params = declaration.parameters.flatMap((parameter) => {
      if (!this.ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || parameter.questionToken || parameter.initializer) {
        this.report(parameter, "parameters must be plain identifiers without default, optional, or rest");
        return [];
      }
      const type = this.irType(this.checker.getTypeAtLocation(parameter), parameter);
      return type ? [{ name: parameter.name.text, type }] : [];
    });
    const signature = this.checker.getSignatureFromDeclaration(declaration);
    const returnType = signature ? this.irType(this.checker.getReturnTypeOfSignature(signature), declaration, true) : undefined;
    const body = this.block(declaration.body.statements);
    if (returnType) {
      this.lowered.set(name, {
        name,
        source: this.location(declaration),
        params,
        returnType,
        body,
      });
    }
  }

  // --- statements -----------------------------------------------------------------------------

  private block(statements: readonly ts.Statement[]): IrStmt[] {
    return statements.flatMap((statement) => this.statement(statement));
  }

  private statement(node: ts.Statement): IrStmt[] {
    const t = this.ts;
    if (t.isVariableStatement(node)) {
      const flags = node.declarationList.flags;
      if (!(flags & (t.NodeFlags.Let | t.NodeFlags.Const))) {
        this.report(node, "only let and const declarations are lowered");
        return [];
      }
      return node.declarationList.declarations.flatMap((declaration) => this.variable(declaration));
    }
    if (t.isExpressionStatement(node)) {
      return this.expressionStatement(node.expression);
    }
    if (t.isIfStatement(node)) {
      const test = this.boolExpr(node.expression);
      const then = this.nested(node.thenStatement);
      const otherwise = node.elseStatement ? this.nested(node.elseStatement) : [];
      return test ? [{ stmt: "if", test, then, otherwise }] : [];
    }
    if (t.isWhileStatement(node)) {
      const test = this.boolExpr(node.expression);
      const body = this.nested(node.statement);
      return test ? [{ stmt: "while", test, body }] : [];
    }
    if (t.isForStatement(node)) {
      return this.forStatement(node);
    }
    if (t.isForOfStatement(node)) {
      return this.forOfStatement(node);
    }
    if (t.isBreakStatement(node) || t.isContinueStatement(node)) {
      if (node.label) {
        this.report(node, "labeled break/continue is not lowered");
        return [];
      }
      return [{ stmt: t.isBreakStatement(node) ? "break" : "continue" }];
    }
    if (t.isReturnStatement(node)) {
      if (!node.expression) {
        return [{ stmt: "return" }];
      }
      const value = this.expr(node.expression, this.returnTypeHint());
      return value ? [{ stmt: "return", value }] : [];
    }
    if (t.isBlock(node)) {
      return [{ stmt: "block", body: this.block(node.statements) }];
    }
    this.report(node, `statement ${t.SyntaxKind[node.kind]} is not lowered`);
    return [];
  }

  private nested(node: ts.Statement): IrStmt[] {
    return this.ts.isBlock(node) ? this.block(node.statements) : this.statement(node);
  }

  private variable(declaration: ts.VariableDeclaration): IrStmt[] {
    if (!this.ts.isIdentifier(declaration.name) || !declaration.initializer) {
      this.report(declaration, "declarations need an identifier and an initializer");
      return [];
    }
    const type = this.irType(this.checker.getTypeAtLocation(declaration.name), declaration);
    if (!type) {
      return [];
    }
    const init = this.expr(declaration.initializer, type);
    return init ? [{ stmt: "let", name: declaration.name.text, type, init }] : [];
  }

  private forStatement(node: ts.ForStatement): IrStmt[] {
    const t = this.ts;
    const initializer = node.initializer;
    const declaration = initializer && t.isVariableDeclarationList(initializer) && initializer.declarations.length === 1
      && initializer.flags & t.NodeFlags.Let
      ? initializer.declarations[0]
      : undefined;
    const variable = declaration && t.isIdentifier(declaration.name) ? declaration.name.text : undefined;
    const condition = node.condition;
    const incrementor = node.incrementor;
    const isIncrement = incrementor !== undefined && variable !== undefined && (
      ((t.isPostfixUnaryExpression(incrementor) || t.isPrefixUnaryExpression(incrementor))
        && incrementor.operator === t.SyntaxKind.PlusPlusToken
        && t.isIdentifier(incrementor.operand) && incrementor.operand.text === variable)
      || (t.isBinaryExpression(incrementor) && incrementor.operatorToken.kind === t.SyntaxKind.PlusEqualsToken
        && t.isIdentifier(incrementor.left) && incrementor.left.text === variable
        && t.isNumericLiteral(incrementor.right) && incrementor.right.text === "1")
    );
    if (!declaration?.initializer || !variable || !condition || !t.isBinaryExpression(condition)
      || condition.operatorToken.kind !== t.SyntaxKind.LessThanToken
      || !t.isIdentifier(condition.left) || condition.left.text !== variable || !isIncrement) {
      this.report(node, "only `for (let i = start; i < end; i++)` loops are lowered");
      return [];
    }
    const start = this.numberExpr(declaration.initializer);
    const end = this.numberExpr(condition.right);
    const body = this.nested(node.statement);
    return start && end ? [{ stmt: "forRange", variable, start, end, body }] : [];
  }

  private forOfStatement(node: ts.ForOfStatement): IrStmt[] {
    const t = this.ts;
    const initializer = node.initializer;
    const declaration = t.isVariableDeclarationList(initializer) && initializer.declarations.length === 1
      ? initializer.declarations[0]
      : undefined;
    if (!declaration || !t.isIdentifier(declaration.name) || node.awaitModifier) {
      this.report(node, "for-of needs a single const/let identifier");
      return [];
    }
    const iterable = this.expr(node.expression);
    const iterableType = this.irType(this.checker.getTypeAtLocation(node.expression), node.expression);
    if (!iterable || !iterableType) {
      return [];
    }
    if (iterableType.kind !== "array") {
      this.report(node.expression, "for-of is lowered only over arrays (map and set iteration is not lowered)");
      return [];
    }
    const index = `__index${this.hiddenCounter++}`;
    const element: IrStmt = {
      stmt: "let",
      name: declaration.name.text,
      type: iterableType.element,
      init: { op: "index", target: iterable, index: { op: "local", name: index } },
    };
    return [{
      stmt: "forRange",
      variable: index,
      start: { op: "num", value: 0 },
      end: { op: "length", target: iterable },
      body: [element, ...this.nested(node.statement)],
    }];
  }

  private expressionStatement(node: ts.Expression): IrStmt[] {
    const t = this.ts;
    if (t.isParenthesizedExpression(node)) {
      return this.expressionStatement(node.expression);
    }
    if (t.isBinaryExpression(node)) {
      return this.assignment(node);
    }
    if ((t.isPostfixUnaryExpression(node) || t.isPrefixUnaryExpression(node))
      && (node.operator === t.SyntaxKind.PlusPlusToken || node.operator === t.SyntaxKind.MinusMinusToken)) {
      return this.update(node.operand, node.operator === t.SyntaxKind.PlusPlusToken ? "add" : "sub", { op: "num", value: 1 }, node);
    }
    if (t.isCallExpression(node)) {
      return this.callStatement(node);
    }
    this.report(node, `expression statement ${t.SyntaxKind[node.kind]} is not lowered`);
    return [];
  }

  private assignment(node: ts.BinaryExpression): IrStmt[] {
    const t = this.ts;
    const compound: Partial<Record<ts.SyntaxKind, BinaryOperator>> = {
      [t.SyntaxKind.PlusEqualsToken]: "add",
      [t.SyntaxKind.MinusEqualsToken]: "sub",
      [t.SyntaxKind.AsteriskEqualsToken]: "mul",
    };
    const operatorKind = node.operatorToken.kind;
    if (operatorKind === t.SyntaxKind.EqualsToken) {
      if (t.isPropertyAccessExpression(node.left) && node.left.name.text === "length"
        && t.isNumericLiteral(node.right) && node.right.text === "0") {
        const target = this.arrayExpr(node.left.expression);
        return target ? [{ stmt: "clear", target }] : [];
      }
      return this.store(node.left, (expected) => this.expr(node.right, expected), node);
    }
    const operator = compound[operatorKind];
    if (operator) {
      const right = this.numberExpr(node.right);
      return right ? this.update(node.left, operator, right, node) : [];
    }
    this.report(node, `operator ${t.tokenToString(operatorKind) ?? t.SyntaxKind[operatorKind]} as a statement is not lowered`);
    return [];
  }

  private update(target: ts.Expression, operator: BinaryOperator, amount: IrExpr, node: ts.Node): IrStmt[] {
    const current = this.numberExpr(target);
    return current
      ? this.store(target, () => ({ op: "binary", operator, left: current, right: amount }), node)
      : [];
  }

  private store(target: ts.Expression, value: (expected?: IrType) => IrExpr | undefined, node: ts.Node): IrStmt[] {
    const t = this.ts;
    if (t.isIdentifier(target)) {
      if (!this.isLocal(target)) {
        return [];
      }
      const type = this.irType(this.checker.getTypeAtLocation(target), target);
      const lowered = type ? value(type) : undefined;
      return lowered ? [{ stmt: "assign", name: target.text, value: lowered }] : [];
    }
    if (t.isElementAccessExpression(target)) {
      const array = this.arrayExpr(target.expression);
      const index = this.numberExpr(target.argumentExpression);
      const arrayType = this.irType(this.checker.getTypeAtLocation(target.expression), target.expression);
      const lowered = value(arrayType?.kind === "array" ? arrayType.element : undefined);
      return array && index && lowered ? [{ stmt: "setIndex", target: array, index, value: lowered }] : [];
    }
    this.report(node, "assignments are lowered only to locals and array elements (struct fields are immutable)");
    return [];
  }

  private callStatement(node: ts.CallExpression): IrStmt[] {
    const t = this.ts;
    const callee = node.expression;
    if (t.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const receiverType = this.irType(this.checker.getTypeAtLocation(callee.expression), callee.expression, false, true);
      if (receiverType?.kind === "array" && method === "push") {
        const target = this.expr(callee.expression);
        const values = node.arguments.map((argument) => this.expr(argument, receiverType.element));
        return target && values.every(Boolean)
          ? values.map((value) => ({ stmt: "push" as const, target, value: value as IrExpr }))
          : [];
      }
      if (receiverType?.kind === "array" && method === "pop" && node.arguments.length === 0) {
        const target = this.expr(callee.expression);
        return target ? [{ stmt: "pop", target }] : [];
      }
      if (receiverType?.kind === "array" && method === "sort") {
        return this.sort(node, callee.expression);
      }
      if (receiverType?.kind === "map" && method === "set" && node.arguments.length === 2) {
        const map = this.expr(callee.expression);
        const key = this.stringExpr(node.arguments[0] as ts.Expression);
        const value = this.numberExpr(node.arguments[1] as ts.Expression);
        return map && key && value ? [{ stmt: "mapSet", map, key, value }] : [];
      }
    }
    const value = this.expr(node);
    return value ? [{ stmt: "expr", value }] : [];
  }

  /** `arr.sort((a, b) => k0[a] - k0[b] || k1[a] - k1[b])` → stable sort by integer key arrays. */
  private sort(node: ts.CallExpression, receiver: ts.Expression): IrStmt[] {
    const t = this.ts;
    const comparator = node.arguments[0];
    const fail = (): IrStmt[] => {
      this.report(node, "sort is lowered only with a comparator `(a, b) => k[a] - k[b] || ...` over key arrays");
      return [];
    };
    if (node.arguments.length !== 1 || !comparator || !t.isArrowFunction(comparator) || comparator.parameters.length !== 2) {
      return fail();
    }
    const [left, right] = comparator.parameters.map((parameter) => (t.isIdentifier(parameter.name) ? parameter.name.text : ""));
    let body: ts.Node = comparator.body;
    if (t.isBlock(body)) {
      const only = body.statements[0];
      if (body.statements.length !== 1 || !only || !t.isReturnStatement(only) || !only.expression) {
        return fail();
      }
      body = only.expression;
    }
    const terms: ts.Expression[] = [];
    const collect = (expression: ts.Node): boolean => {
      if (t.isParenthesizedExpression(expression)) {
        return collect(expression.expression);
      }
      if (t.isBinaryExpression(expression) && expression.operatorToken.kind === t.SyntaxKind.BarBarToken) {
        return collect(expression.left) && collect(expression.right);
      }
      if (t.isBinaryExpression(expression) && expression.operatorToken.kind === t.SyntaxKind.MinusToken) {
        terms.push(expression);
        return true;
      }
      return false;
    };
    if (!collect(body)) {
      return fail();
    }
    const keys: IrExpr[] = [];
    for (const term of terms as ts.BinaryExpression[]) {
      const isKeyAccess = (expression: ts.Expression, parameter: string): expression is ts.ElementAccessExpression => (
        t.isElementAccessExpression(expression)
        && t.isIdentifier(expression.argumentExpression) && expression.argumentExpression.text === parameter
      );
      if (!isKeyAccess(term.left, left ?? "") || !isKeyAccess(term.right, right ?? "")
        || term.left.expression.getText() !== term.right.expression.getText()) {
        return fail();
      }
      const key = this.arrayExpr(term.left.expression);
      if (!key) {
        return [];
      }
      keys.push(key);
    }
    const target = this.arrayExpr(receiver);
    return target ? [{ stmt: "sortByKeys", target, keys }] : [];
  }

  // --- expressions ----------------------------------------------------------------------------

  private expr(node: ts.Expression, expected?: IrType): IrExpr | undefined {
    const t = this.ts;
    if (t.isParenthesizedExpression(node)) {
      return this.expr(node.expression, expected);
    }
    if (t.isNumericLiteral(node)) {
      return { op: "num", value: Number(node.text) };
    }
    if (node.kind === t.SyntaxKind.TrueKeyword || node.kind === t.SyntaxKind.FalseKeyword) {
      return { op: "bool", value: node.kind === t.SyntaxKind.TrueKeyword };
    }
    if (t.isStringLiteral(node) || t.isNoSubstitutionTemplateLiteral(node)) {
      return { op: "str", value: node.text };
    }
    if (t.isIdentifier(node)) {
      return this.isLocal(node) ? { op: "local", name: node.text } : undefined;
    }
    if (t.isPrefixUnaryExpression(node)) {
      if (node.operator === t.SyntaxKind.ExclamationToken) {
        const operand = this.boolExpr(node.operand);
        return operand ? { op: "not", operand } : undefined;
      }
      if (node.operator === t.SyntaxKind.MinusToken) {
        if (t.isNumericLiteral(node.operand)) {
          return { op: "num", value: -Number(node.operand.text) };
        }
        const operand = this.numberExpr(node.operand);
        return operand ? { op: "neg", operand } : undefined;
      }
    }
    if (t.isBinaryExpression(node)) {
      return this.binary(node);
    }
    if (t.isConditionalExpression(node)) {
      const test = this.boolExpr(node.condition);
      const then = this.expr(node.whenTrue, expected);
      const otherwise = this.expr(node.whenFalse, expected);
      return test && then && otherwise ? { op: "cond", test, then, otherwise } : undefined;
    }
    if (t.isElementAccessExpression(node)) {
      const targetType = this.irType(this.checker.getTypeAtLocation(node.expression), node.expression);
      if (targetType?.kind !== "array") {
        if (targetType) {
          this.report(node, "element access is lowered only on arrays (use charCodeAt for strings)");
        }
        return undefined;
      }
      const target = this.expr(node.expression);
      const index = this.numberExpr(node.argumentExpression);
      return target && index ? { op: "index", target, index } : undefined;
    }
    if (t.isPropertyAccessExpression(node)) {
      return this.property(node);
    }
    if (t.isCallExpression(node)) {
      return this.call(node);
    }
    if (t.isNewExpression(node)) {
      return this.newExpression(node);
    }
    if (t.isArrayLiteralExpression(node)) {
      const type = (expected?.kind === "array" ? expected : undefined)
        ?? this.irType(this.checker.getTypeAtLocation(node), node);
      if (type?.kind !== "array" || type.storage !== "dynamic") {
        this.report(node, "array literals need a known dynamic array type");
        return undefined;
      }
      if (node.elements.some((element) => t.isSpreadElement(element) || t.isOmittedExpression(element))) {
        this.report(node, "spread and holes in array literals are not lowered");
        return undefined;
      }
      const elements = node.elements.map((element) => this.expr(element, type.element));
      return elements.every(Boolean) ? { op: "arrayLiteral", type, elements: elements as IrExpr[] } : undefined;
    }
    if (t.isObjectLiteralExpression(node)) {
      return this.objectLiteral(node, expected);
    }
    this.report(node, `expression ${t.SyntaxKind[node.kind]} is not lowered`);
    return undefined;
  }

  private binary(node: ts.BinaryExpression): IrExpr | undefined {
    const t = this.ts;
    const kind = node.operatorToken.kind;
    if (kind === t.SyntaxKind.AmpersandAmpersandToken || kind === t.SyntaxKind.BarBarToken) {
      const left = this.boolExpr(node.left);
      const right = this.boolExpr(node.right);
      return left && right ? { op: kind === t.SyntaxKind.AmpersandAmpersandToken ? "and" : "or", left, right } : undefined;
    }
    if (kind === t.SyntaxKind.QuestionQuestionToken) {
      return this.mapGetOr(node);
    }
    const arithmetic: Partial<Record<ts.SyntaxKind, BinaryOperator>> = {
      [t.SyntaxKind.PlusToken]: "add",
      [t.SyntaxKind.MinusToken]: "sub",
      [t.SyntaxKind.AsteriskToken]: "mul",
      [t.SyntaxKind.SlashToken]: "div",
      [t.SyntaxKind.PercentToken]: "mod",
      [t.SyntaxKind.LessThanToken]: "lt",
      [t.SyntaxKind.LessThanEqualsToken]: "le",
      [t.SyntaxKind.GreaterThanToken]: "gt",
      [t.SyntaxKind.GreaterThanEqualsToken]: "ge",
    };
    const operator = arithmetic[kind];
    if (operator) {
      const left = this.numberExpr(node.left);
      const right = this.numberExpr(node.right);
      return left && right ? { op: "binary", operator, left, right } : undefined;
    }
    if (kind === t.SyntaxKind.EqualsEqualsEqualsToken || kind === t.SyntaxKind.ExclamationEqualsEqualsToken) {
      const leftType = this.irType(this.checker.getTypeAtLocation(node.left), node.left);
      const rightType = this.irType(this.checker.getTypeAtLocation(node.right), node.right);
      if (!leftType || !rightType) {
        return undefined;
      }
      if (leftType.kind !== rightType.kind || !["f64", "bool", "string"].includes(leftType.kind)) {
        this.report(node, "strict equality is lowered only between two numbers, booleans, or strings");
        return undefined;
      }
      const left = this.expr(node.left);
      const right = this.expr(node.right);
      return left && right
        ? { op: "binary", operator: kind === t.SyntaxKind.EqualsEqualsEqualsToken ? "eq" : "ne", left, right }
        : undefined;
    }
    this.report(node, `operator ${t.tokenToString(kind) ?? t.SyntaxKind[kind]} is not lowered`);
    return undefined;
  }

  /** `map.get(key) ?? fallback` is the only lowered form of a map lookup. */
  private mapGetOr(node: ts.BinaryExpression): IrExpr | undefined {
    const t = this.ts;
    const left = node.left;
    if (t.isCallExpression(left) && t.isPropertyAccessExpression(left.expression) && left.expression.name.text === "get"
      && left.arguments.length === 1
      && this.irType(this.checker.getTypeAtLocation(left.expression.expression), left.expression.expression)?.kind === "map") {
      const map = this.expr(left.expression.expression);
      const key = this.stringExpr(left.arguments[0] as ts.Expression);
      const fallback = this.numberExpr(node.right);
      return map && key && fallback ? { op: "mapGetOr", map, key, fallback } : undefined;
    }
    this.report(node, "?? is lowered only as `map.get(key) ?? fallback`");
    return undefined;
  }

  private property(node: ts.PropertyAccessExpression): IrExpr | undefined {
    const targetType = this.irType(this.checker.getTypeAtLocation(node.expression), node.expression);
    if (!targetType) {
      return undefined;
    }
    const name = node.name.text;
    if (name === "length" && (targetType.kind === "array" || targetType.kind === "string")) {
      const target = this.expr(node.expression);
      return target ? { op: "length", target } : undefined;
    }
    if (targetType.kind === "struct") {
      const target = this.expr(node.expression);
      return target ? { op: "field", target, name } : undefined;
    }
    this.report(node, `property ${name} on ${targetType.kind} is not lowered`);
    return undefined;
  }

  private call(node: ts.CallExpression): IrExpr | undefined {
    const t = this.ts;
    const callee = node.expression;
    const args = node.arguments;
    if (t.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (t.isIdentifier(callee.expression) && callee.expression.text === "Math" && (method === "min" || method === "max")) {
        const lowered = args.map((argument) => this.numberExpr(argument));
        return lowered.length > 0 && lowered.every(Boolean) ? { op: method, args: lowered as IrExpr[] } : this.fail(node, "Math.min/max need numeric arguments");
      }
      if (t.isNewExpression(callee.expression) && method === "fill") {
        return this.arrayNew(callee.expression, args[0]);
      }
      const receiverType = this.irType(this.checker.getTypeAtLocation(callee.expression), callee.expression, false, true);
      if (receiverType?.kind === "string") {
        const target = this.expr(callee.expression);
        if (method === "charCodeAt" && args.length === 1) {
          const index = this.numberExpr(args[0] as ts.Expression);
          return target && index ? { op: "charCodeAt", target, index } : undefined;
        }
        if (method === "slice" && args.length === 2) {
          const start = this.numberExpr(args[0] as ts.Expression);
          const end = this.numberExpr(args[1] as ts.Expression);
          return target && start && end ? { op: "slice", target, start, end } : undefined;
        }
        if (method === "toLowerCase" && args.length === 0) {
          return target ? { op: "toLowerAscii", target } : undefined;
        }
      }
      if (receiverType?.kind === "map" && method === "has" && args.length === 1) {
        const map = this.expr(callee.expression);
        const key = this.stringExpr(args[0] as ts.Expression);
        return map && key ? { op: "mapHas", map, key } : undefined;
      }
      if (receiverType?.kind === "map" && method === "get") {
        return this.fail(node, "map.get is lowered only as `map.get(key) ?? fallback`");
      }
      return this.fail(node, `method ${method} is not lowered`);
    }
    if (t.isIdentifier(callee)) {
      const symbol = this.checker.getSymbolAtLocation(callee);
      const resolved = symbol && symbol.flags & t.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
      const declaration = resolved?.declarations?.find((candidate): candidate is ts.FunctionDeclaration => (
        t.isFunctionDeclaration(candidate) && candidate.body !== undefined
      ));
      if (!declaration) {
        return this.fail(node, `call to ${callee.text} does not resolve to a function declaration with a body`);
      }
      const name = this.functionName(declaration);
      if (this.current) {
        this.callees.get(this.functionName(this.current))?.add(name);
      }
      const lowered = args.map((argument) => this.expr(argument));
      return lowered.every(Boolean) ? { op: "call", callee: name, args: lowered as IrExpr[] } : undefined;
    }
    return this.fail(node, "only direct calls to function declarations are lowered");
  }

  private newExpression(node: ts.NewExpression): IrExpr | undefined {
    const t = this.ts;
    const name = t.isIdentifier(node.expression) ? node.expression.text : "";
    if (name === "Map" && (node.arguments?.length ?? 0) === 0) {
      const type = this.irType(this.checker.getTypeAtLocation(node), node);
      return type?.kind === "map" ? { op: "mapNew" } : undefined;
    }
    const storage = TYPED_ARRAY_STORAGE[name];
    if (storage && node.arguments?.length === 1) {
      const length = this.numberExpr(node.arguments[0] as ts.Expression);
      return length
        ? { op: "arrayNew", type: { kind: "array", element: F64, storage }, length, fill: { op: "num", value: 0 } }
        : undefined;
    }
    return this.fail(node, "new is lowered only for `new Map()`, typed arrays, and `new Array<T>(n).fill(x)`");
  }

  private arrayNew(node: ts.NewExpression, fillArgument: ts.Expression | undefined): IrExpr | undefined {
    const t = this.ts;
    if (!t.isIdentifier(node.expression) || node.expression.text !== "Array" || node.arguments?.length !== 1 || !fillArgument) {
      return this.fail(node, "fill is lowered only as `new Array<T>(length).fill(value)`");
    }
    const type = this.irType(this.checker.getTypeAtLocation(node), node);
    if (type?.kind !== "array") {
      return undefined;
    }
    const length = this.numberExpr(node.arguments[0] as ts.Expression);
    const fill = this.expr(fillArgument, type.element);
    return length && fill ? { op: "arrayNew", type, length, fill } : undefined;
  }

  private objectLiteral(node: ts.ObjectLiteralExpression, expected?: IrType): IrExpr | undefined {
    const t = this.ts;
    const type = expected?.kind === "struct" ? expected : this.irType(this.checker.getContextualType(node) ?? this.checker.getTypeAtLocation(node), node);
    const struct = type?.kind === "struct" ? this.structs.get(type.name) : undefined;
    if (!struct) {
      return this.fail(node, "object literals are lowered only where a named struct type is expected");
    }
    const values = new Map<string, ts.Expression>();
    for (const property of node.properties) {
      if (t.isPropertyAssignment(property) && t.isIdentifier(property.name)) {
        values.set(property.name.text, property.initializer);
      } else if (t.isShorthandPropertyAssignment(property)) {
        values.set(property.name.text, property.name);
      } else {
        return this.fail(property, "object literal properties must be plain or shorthand assignments");
      }
    }
    if (values.size !== struct.fields.length || struct.fields.some((field) => !values.has(field.name))) {
      return this.fail(node, `object literal must set exactly the fields of ${struct.name}`);
    }
    const fields = struct.fields.map((field) => ({ name: field.name, value: this.expr(values.get(field.name) as ts.Expression, field.type) }));
    return fields.every((field) => field.value)
      ? { op: "struct", name: struct.name, fields: fields as { name: string; value: IrExpr }[] }
      : undefined;
  }

  private numberExpr(node: ts.Expression): IrExpr | undefined {
    return this.typedExpr(node, "f64", "a number");
  }

  private boolExpr(node: ts.Expression): IrExpr | undefined {
    return this.typedExpr(node, "bool", "a boolean (no truthiness coercion)");
  }

  private stringExpr(node: ts.Expression): IrExpr | undefined {
    return this.typedExpr(node, "string", "a string");
  }

  private arrayExpr(node: ts.Expression): IrExpr | undefined {
    const type = this.irType(this.checker.getTypeAtLocation(node), node);
    if (type && type.kind !== "array") {
      return this.fail(node, "expected an array");
    }
    return type ? this.expr(node) : undefined;
  }

  private typedExpr(node: ts.Expression, kind: IrType["kind"], description: string): IrExpr | undefined {
    const type = this.irType(this.checker.getTypeAtLocation(node), node);
    if (!type) {
      return undefined;
    }
    if (type.kind !== kind) {
      return this.fail(node, `expected ${description}, got ${type.kind}`);
    }
    return this.expr(node, type);
  }

  // --- types ----------------------------------------------------------------------------------

  private irType(type: ts.Type, node: ts.Node, allowVoid = false, quiet = false): IrType | undefined {
    const result = this.classifyType(type, allowVoid);
    if (typeof result === "string") {
      if (!quiet) {
        this.report(node, `type ${this.checker.typeToString(type)}: ${result}`);
      }
      return undefined;
    }
    return result;
  }

  private classifyType(type: ts.Type, allowVoid: boolean): IrType | string {
    const t = this.ts;
    const flags = type.flags;
    if (flags & (t.TypeFlags.Boolean | t.TypeFlags.BooleanLiteral)) {
      return BOOL;
    }
    if (flags & (t.TypeFlags.Number | t.TypeFlags.NumberLiteral)) {
      return F64;
    }
    if (flags & (t.TypeFlags.String | t.TypeFlags.StringLiteral)) {
      return STRING;
    }
    if (allowVoid && flags & t.TypeFlags.Void) {
      return { kind: "void" };
    }
    if (flags & t.TypeFlags.Union) {
      return "unions (including optional values) are not lowered";
    }
    if (!(flags & t.TypeFlags.Object)) {
      return "has no Kernel IR type";
    }
    const symbolName = type.getSymbol()?.getName() ?? "";
    const storage = TYPED_ARRAY_STORAGE[symbolName];
    if (storage) {
      return { kind: "array", element: F64, storage };
    }
    if (this.checker.isTupleType(type)) {
      return "tuples are not lowered";
    }
    if (this.checker.isArrayType(type)) {
      const element = this.typeArguments(type)[0];
      const elementType = element ? this.classifyType(element, false) : "unknown element type";
      return typeof elementType === "string" ? `array element ${elementType}` : { kind: "array", element: elementType, storage: "dynamic" };
    }
    if (symbolName === "Set" || symbolName === "ReadonlySet") {
      return "sets are not lowered; prepare them into a Map<string, number> index";
    }
    if (symbolName === "Map" || symbolName === "ReadonlyMap") {
      const [key, value] = this.typeArguments(type);
      return key && value && key.flags & t.TypeFlags.String && value.flags & t.TypeFlags.Number
        ? { kind: "map" }
        : "maps are lowered only as Map<string, number>";
    }
    if (type.getCallSignatures().length > 0) {
      return "functions cannot be lowered as values";
    }
    return this.structType(type);
  }

  private structType(type: ts.Type): IrType | string {
    const t = this.ts;
    const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
    if (!name || name === "__type" || name === "__object") {
      return "anonymous object types are not lowered; declare a named interface";
    }
    if (type.isClass() || (type.getSymbol()?.flags ?? 0) & t.SymbolFlags.Class) {
      return "class instances are not lowered";
    }
    if (this.structs.has(name)) {
      return { kind: "struct", name };
    }
    // Reserve the name first so recursive types fail instead of looping.
    this.structs.set(name, { name, fields: [] });
    const fields: { name: string; type: IrType }[] = [];
    for (const property of this.checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration || property.flags & (t.SymbolFlags.Optional | t.SymbolFlags.Method)) {
        this.structs.delete(name);
        return `struct field ${property.getName()} must be a required, non-method property`;
      }
      const fieldType = this.classifyType(this.checker.getTypeOfSymbolAtLocation(property, declaration), false);
      if (typeof fieldType === "string") {
        this.structs.delete(name);
        return `struct field ${property.getName()}: ${fieldType}`;
      }
      if (fieldType.kind === "struct" && fieldType.name === name) {
        this.structs.delete(name);
        return "recursive structs are not lowered";
      }
      fields.push({ name: property.getName(), type: fieldType });
    }
    this.structs.set(name, { name, fields });
    return { kind: "struct", name };
  }

  private typeArguments(type: ts.Type): readonly ts.Type[] {
    const reference = type as ts.TypeReference;
    return reference.target ? this.checker.getTypeArguments(reference) : type.aliasTypeArguments ?? [];
  }

  // --- helpers --------------------------------------------------------------------------------

  /** Identifiers must be parameters or locals of the function being lowered (no captured state). */
  private isLocal(node: ts.Identifier): boolean {
    const t = this.ts;
    const symbol = t.isShorthandPropertyAssignment(node.parent)
      ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
      : this.checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    let owner: ts.Node | undefined = declaration;
    while (owner && !t.isFunctionLike(owner)) {
      owner = owner.parent;
    }
    const isOwnBinding = declaration !== undefined
      && (t.isParameter(declaration) || t.isVariableDeclaration(declaration))
      && owner === this.current;
    if (!isOwnBinding) {
      this.report(node, `${node.text} is not a parameter or local of the lowered function`);
    }
    return isOwnBinding;
  }

  private returnTypeHint(): IrType | undefined {
    if (!this.current) {
      return undefined;
    }
    const signature = this.checker.getSignatureFromDeclaration(this.current);
    if (!signature) {
      return undefined;
    }
    const result = this.classifyType(this.checker.getReturnTypeOfSignature(signature), true);
    return typeof result === "string" ? undefined : result;
  }

  private fail(node: ts.Node, message: string): undefined {
    this.report(node, message);
    return undefined;
  }

  private report(node: ts.Node, message: string): void {
    const sourceFile = node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    this.diagnostics.push({
      file: this.relativeFile(sourceFile.fileName),
      line: position.line + 1,
      column: position.character + 1,
      construct: this.ts.SyntaxKind[node.kind],
      message,
    });
  }

  private location(node: ts.Node): string {
    const sourceFile = node.getSourceFile();
    return `${this.relativeFile(sourceFile.fileName)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
  }

  private relativeFile(fileName: string): string {
    return this.options.projectRoot ? relative(this.options.projectRoot, fileName).split(sep).join("/") : fileName;
  }
}

