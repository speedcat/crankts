/**
 * CrankTS Kernel IR (v0.2.1): the smallest structured IR that expresses the two validated kernels
 * (KWX `PREPARED_STATE`, MVP-9b `GRAPH_BATCH`). Semantics are JavaScript's with one rule added:
 * every operation whose JS result would depend on out-of-range or non-integer values is *checked*
 * and raises a trap instead, so the TypeScript fallback produces the JS result. Backends never
 * emulate JS edge cases; they trap.
 */

/** Numbers stay f64 as in JS; integer use is checked at index and typed-store sites. */
export type IrType =
  | { readonly kind: "f64" }
  | { readonly kind: "bool" }
  /** Immutable UTF-16 string; all positions are code-unit indexes. */
  | { readonly kind: "string" }
  /** `dynamic`: JS array; typed storages are typed arrays with checked stores. */
  | { readonly kind: "array"; readonly element: IrType; readonly storage: ArrayStorage }
  /** String-keyed map; no iteration operation exists, so order cannot leak. */
  | { readonly kind: "map"; readonly value: IrType }
  | { readonly kind: "struct"; readonly name: string }
  | { readonly kind: "void" };

export type ArrayStorage = "dynamic" | "u8" | "u32" | "i32" | "f64";

export interface IrStruct {
  readonly name: string;
  readonly fields: readonly { readonly name: string; readonly type: IrType }[];
}

export type BinaryOperator = "add" | "sub" | "mul" | "div" | "mod" | "lt" | "le" | "gt" | "ge" | "eq" | "ne";

export type IrExpr =
  | { readonly op: "num"; readonly value: number }
  | { readonly op: "bool"; readonly value: boolean }
  | { readonly op: "str"; readonly value: string }
  | { readonly op: "local"; readonly name: string }
  | { readonly op: "binary"; readonly operator: BinaryOperator; readonly left: IrExpr; readonly right: IrExpr }
  /** Short-circuit on bool operands only. */
  | { readonly op: "and" | "or"; readonly left: IrExpr; readonly right: IrExpr }
  | { readonly op: "not" | "neg"; readonly operand: IrExpr }
  | { readonly op: "cond"; readonly test: IrExpr; readonly then: IrExpr; readonly otherwise: IrExpr }
  /** `Math.min` / `Math.max` semantics, including NaN and -0. */
  | { readonly op: "min" | "max"; readonly args: readonly IrExpr[] }
  /** Array or string length. */
  | { readonly op: "length"; readonly target: IrExpr }
  /** Checked: index must be an integer in [0, length). */
  | { readonly op: "index"; readonly target: IrExpr; readonly index: IrExpr }
  /** Checked: index must be an integer in [0, length). */
  | { readonly op: "charCodeAt"; readonly target: IrExpr; readonly index: IrExpr }
  /** Checked: 0 <= start <= end <= length, integers (no JS clamping or negative indexes). */
  | { readonly op: "slice"; readonly target: IrExpr; readonly start: IrExpr; readonly end: IrExpr }
  /** Checked: every code unit < 128, so ASCII lower-casing equals `toLowerCase`. */
  | { readonly op: "toLowerAscii"; readonly target: IrExpr }
  | { readonly op: "mapGetOr"; readonly map: IrExpr; readonly key: IrExpr; readonly fallback: IrExpr }
  | { readonly op: "mapHas"; readonly map: IrExpr; readonly key: IrExpr }
  | { readonly op: "mapNew"; readonly type: IrType & { readonly kind: "map" } }
  /**
   * `/^[class]+$/.test(s)` (or `*`): every UTF-16 code unit lies in one of the inclusive ranges.
   * Equals the JS regex on code units (no flags, so no case folding or Unicode mode).
   */
  | { readonly op: "charClassAll"; readonly target: IrExpr; readonly ranges: readonly (readonly [number, number])[]; readonly allowEmpty: boolean }
  | { readonly op: "field"; readonly target: IrExpr; readonly name: string }
  | { readonly op: "struct"; readonly name: string; readonly fields: readonly { readonly name: string; readonly value: IrExpr }[] }
  /** Checked length (integer in [0, 2^28]); every element starts as `fill`. */
  | { readonly op: "arrayNew"; readonly type: IrType & { readonly kind: "array" }; readonly length: IrExpr; readonly fill: IrExpr }
  | { readonly op: "arrayLiteral"; readonly type: IrType & { readonly kind: "array" }; readonly elements: readonly IrExpr[] }
  | { readonly op: "call"; readonly callee: string; readonly args: readonly IrExpr[] };

export type IrStmt =
  | { readonly stmt: "let"; readonly name: string; readonly type: IrType; readonly init: IrExpr }
  | { readonly stmt: "assign"; readonly name: string; readonly value: IrExpr }
  /** Checked index; typed storages also check the stored value's range. */
  | { readonly stmt: "setIndex"; readonly target: IrExpr; readonly index: IrExpr; readonly value: IrExpr }
  | { readonly stmt: "push"; readonly target: IrExpr; readonly value: IrExpr }
  /** Checked: the array must not be empty. */
  | { readonly stmt: "pop"; readonly target: IrExpr }
  | { readonly stmt: "clear"; readonly target: IrExpr }
  | { readonly stmt: "mapSet"; readonly map: IrExpr; readonly key: IrExpr; readonly value: IrExpr }
  /**
   * Multimap append, the lowering of `const v = m.get(k) ?? []; v.push(x); m.set(k, v);`:
   * appends to the stored array, or stores `[x]` when `k` is absent (insertion order unchanged).
   */
  | { readonly stmt: "mapAppend"; readonly map: IrExpr; readonly key: IrExpr; readonly value: IrExpr }
  /**
   * Stable ascending sort of an index array by integer key arrays (`keys[0][a] - keys[0][b] || ...`).
   * Checked: every element indexes every key array.
   */
  | { readonly stmt: "sortByKeys"; readonly target: IrExpr; readonly keys: readonly IrExpr[] }
  | { readonly stmt: "if"; readonly test: IrExpr; readonly then: readonly IrStmt[]; readonly otherwise: readonly IrStmt[] }
  /** Termination is not proven; backends count iterations against a budget and trap when exceeded. */
  | { readonly stmt: "while"; readonly test: IrExpr; readonly body: readonly IrStmt[] }
  /**
   * `for (let v = start; v < end; v++)` with `v` not assigned in the body and `end` loop-invariant
   * (verified), so `end` is evaluated once and the loop provably terminates.
   */
  | { readonly stmt: "forRange"; readonly variable: string; readonly start: IrExpr; readonly end: IrExpr; readonly body: readonly IrStmt[] }
  /** A nested lexical scope. */
  | { readonly stmt: "block"; readonly body: readonly IrStmt[] }
  | { readonly stmt: "break" }
  | { readonly stmt: "continue" }
  | { readonly stmt: "return"; readonly value?: IrExpr }
  | { readonly stmt: "expr"; readonly value: IrExpr };

export interface IrFunction {
  readonly name: string;
  /** Where the function was lowered from (`file:line`). */
  readonly source: string;
  /**
   * `inout`: a map parameter the kernel mutates with `has`/`set` only. Backends copy its keys in and
   * return the ordered set-log, which the caller replays; the JS map ends in the same state.
   */
  readonly params: readonly { readonly name: string; readonly type: IrType; readonly inout?: boolean }[];
  readonly returnType: IrType;
  readonly body: readonly IrStmt[];
}

export interface IrModule {
  readonly irVersion: 1;
  readonly entry: string;
  /** Callees before callers; the call graph is acyclic (verified). */
  readonly functions: readonly IrFunction[];
  readonly structs: readonly IrStruct[];
}

/** PREPARED_STATE lowers two modules that may share helpers and structs; they must agree. */
export function mergeModules(execute: IrModule, prepare?: IrModule): IrModule {
  if (!prepare) {
    return execute;
  }
  const functions = new Map(prepare.functions.map((fn) => [fn.name, fn]));
  for (const fn of execute.functions) {
    const existing = functions.get(fn.name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(fn)) {
      throw new Error(`prepare and execute define different functions named ${fn.name}`);
    }
    functions.set(fn.name, fn);
  }
  const structs = new Map(prepare.structs.map((struct) => [struct.name, struct]));
  for (const struct of execute.structs) {
    const existing = structs.get(struct.name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(struct)) {
      throw new Error(`prepare and execute define different structs named ${struct.name}`);
    }
    structs.set(struct.name, struct);
  }
  return { irVersion: 1, entry: execute.entry, functions: [...functions.values()], structs: [...structs.values()] };
}

export function isReferenceType(type: IrType): boolean {
  return type.kind === "array" || type.kind === "map" || type.kind === "struct";
}

export function formatIrType(type: IrType): string {
  switch (type.kind) {
    case "array":
      return type.storage === "dynamic" ? `${formatIrType(type.element)}[]` : `${type.storage}[]`;
    case "struct":
      return type.name;
    case "map":
      return `map<string, ${formatIrType(type.value)}>`;
    default:
      return type.kind;
  }
}

/** Human-readable listing, stable enough for documentation and snapshot tests. */
export function printIrModule(module: IrModule): string {
  const lines: string[] = [];
  for (const struct of module.structs) {
    lines.push(`struct ${struct.name} { ${struct.fields.map((field) => `${field.name}: ${formatIrType(field.type)}`).join(", ")} }`);
  }
  for (const fn of module.functions) {
    const params = fn.params.map((param) => `${param.inout ? "inout " : ""}${param.name}: ${formatIrType(param.type)}`).join(", ");
    lines.push(`fn ${fn.name}(${params}) -> ${formatIrType(fn.returnType)} {`);
    printBlock(fn.body, 1, lines);
    lines.push("}");
  }
  return `${lines.join("\n")}\n`;
}

function printBlock(body: readonly IrStmt[], depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  for (const statement of body) {
    switch (statement.stmt) {
      case "let":
        lines.push(`${indent}let ${statement.name}: ${formatIrType(statement.type)} = ${printExpr(statement.init)}`);
        break;
      case "assign":
        lines.push(`${indent}${statement.name} = ${printExpr(statement.value)}`);
        break;
      case "setIndex":
        lines.push(`${indent}${printExpr(statement.target)}[${printExpr(statement.index)}] = ${printExpr(statement.value)}`);
        break;
      case "push":
        lines.push(`${indent}push ${printExpr(statement.target)}, ${printExpr(statement.value)}`);
        break;
      case "pop":
      case "clear":
        lines.push(`${indent}${statement.stmt} ${printExpr(statement.target)}`);
        break;
      case "mapSet":
      case "mapAppend":
        lines.push(`${indent}${statement.stmt} ${printExpr(statement.map)}, ${printExpr(statement.key)}, ${printExpr(statement.value)}`);
        break;
      case "sortByKeys":
        lines.push(`${indent}sortByKeys ${printExpr(statement.target)} by ${statement.keys.map(printExpr).join(", ")}`);
        break;
      case "if":
        lines.push(`${indent}if ${printExpr(statement.test)} {`);
        printBlock(statement.then, depth + 1, lines);
        if (statement.otherwise.length > 0) {
          lines.push(`${indent}} else {`);
          printBlock(statement.otherwise, depth + 1, lines);
        }
        lines.push(`${indent}}`);
        break;
      case "while":
        lines.push(`${indent}while ${printExpr(statement.test)} {`);
        printBlock(statement.body, depth + 1, lines);
        lines.push(`${indent}}`);
        break;
      case "forRange":
        lines.push(`${indent}for ${statement.variable} in ${printExpr(statement.start)}..${printExpr(statement.end)} {`);
        printBlock(statement.body, depth + 1, lines);
        lines.push(`${indent}}`);
        break;
      case "block":
        lines.push(`${indent}{`);
        printBlock(statement.body, depth + 1, lines);
        lines.push(`${indent}}`);
        break;
      case "break":
      case "continue":
        lines.push(`${indent}${statement.stmt}`);
        break;
      case "return":
        lines.push(`${indent}return${statement.value ? ` ${printExpr(statement.value)}` : ""}`);
        break;
      case "expr":
        lines.push(`${indent}${printExpr(statement.value)}`);
        break;
    }
  }
}

const OPERATOR_SYMBOLS: Readonly<Record<BinaryOperator, string>> = {
  add: "+", sub: "-", mul: "*", div: "/", mod: "%", lt: "<", le: "<=", gt: ">", ge: ">=", eq: "==", ne: "!=",
};

export function printExpr(expr: IrExpr): string {
  switch (expr.op) {
    case "num":
    case "bool":
      return String(expr.value);
    case "str":
      return JSON.stringify(expr.value);
    case "local":
      return expr.name;
    case "binary":
      return `(${printExpr(expr.left)} ${OPERATOR_SYMBOLS[expr.operator]} ${printExpr(expr.right)})`;
    case "and":
      return `(${printExpr(expr.left)} && ${printExpr(expr.right)})`;
    case "or":
      return `(${printExpr(expr.left)} || ${printExpr(expr.right)})`;
    case "not":
      return `!${printExpr(expr.operand)}`;
    case "neg":
      return `-${printExpr(expr.operand)}`;
    case "cond":
      return `(${printExpr(expr.test)} ? ${printExpr(expr.then)} : ${printExpr(expr.otherwise)})`;
    case "min":
    case "max":
      return `${expr.op}(${expr.args.map(printExpr).join(", ")})`;
    case "length":
      return `len(${printExpr(expr.target)})`;
    case "index":
      return `${printExpr(expr.target)}[${printExpr(expr.index)}]`;
    case "charCodeAt":
      return `charCodeAt(${printExpr(expr.target)}, ${printExpr(expr.index)})`;
    case "slice":
      return `slice(${printExpr(expr.target)}, ${printExpr(expr.start)}, ${printExpr(expr.end)})`;
    case "toLowerAscii":
      return `toLowerAscii(${printExpr(expr.target)})`;
    case "mapGetOr":
      return `mapGetOr(${printExpr(expr.map)}, ${printExpr(expr.key)}, ${printExpr(expr.fallback)})`;
    case "mapHas":
      return `mapHas(${printExpr(expr.map)}, ${printExpr(expr.key)})`;
    case "mapNew":
      return "mapNew()";
    case "charClassAll":
      return `charClassAll(${printExpr(expr.target)}, [${expr.ranges.map(([low, high]) => `${low}-${high}`).join(" ")}]${expr.allowEmpty ? ", empty" : ""})`;
    case "field":
      return `${printExpr(expr.target)}.${expr.name}`;
    case "struct":
      return `${expr.name} { ${expr.fields.map((field) => `${field.name}: ${printExpr(field.value)}`).join(", ")} }`;
    case "arrayNew":
      return `arrayNew<${formatIrType(expr.type)}>(${printExpr(expr.length)}, ${printExpr(expr.fill)})`;
    case "arrayLiteral":
      return `[${expr.elements.map(printExpr).join(", ")}]`;
    case "call":
      return `${expr.callee}(${expr.args.map(printExpr).join(", ")})`;
  }
}
