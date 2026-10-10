import type { ArrayStorage, BinaryOperator, IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";

/**
 * Reference interpreter for the Kernel IR (v0.2.1). It defines what every backend must compute:
 * JavaScript semantics on the accepted subset, and a {@link KernelTrap} wherever a checked operation
 * fails or the iteration budget runs out. A trap means "use the TypeScript fallback", never an error
 * the caller sees.
 */

export class KernelTrap extends Error {
  constructor(readonly reason: string) {
    super(`kernel trap: ${reason}`);
    this.name = "KernelTrap";
  }
}

export interface InterpretOptions {
  /** Function to call; defaults to the module entry. */
  readonly entry?: string;
  /** Maximum total `while` iterations before trapping (TERMINATION guard). */
  readonly iterationBudget?: number;
}

type ArrayValue = unknown[] | Uint8Array | Uint32Array | Int32Array | Float64Array;
type Value = number | boolean | string | ArrayValue | Map<string, number> | Record<string, unknown> | undefined;
type Signal =
  | { readonly kind: "normal" }
  | { readonly kind: "break" }
  | { readonly kind: "continue" }
  | { readonly kind: "return"; readonly value: Value };

const NORMAL: Signal = { kind: "normal" };
const BREAK: Signal = { kind: "break" };
const CONTINUE: Signal = { kind: "continue" };
const MAX_ARRAY_LENGTH = 2 ** 32 - 1;

class Scope {
  private readonly values = new Map<string, Value>();

  constructor(private readonly parent?: Scope) {}

  declare(name: string, value: Value): void {
    this.values.set(name, value);
  }

  get(name: string): Value {
    if (this.values.has(name)) {
      return this.values.get(name);
    }
    if (!this.parent) {
      throw new Error(`unbound IR local ${name}`);
    }
    return this.parent.get(name);
  }

  set(name: string, value: Value): void {
    if (this.values.has(name)) {
      this.values.set(name, value);
      return;
    }
    if (!this.parent) {
      throw new Error(`unbound IR local ${name}`);
    }
    this.parent.set(name, value);
  }
}

export function interpretIr(module: IrModule, args: readonly unknown[], options: InterpretOptions = {}): unknown {
  return new Interpreter(module, options.iterationBudget ?? Number.MAX_SAFE_INTEGER).call(options.entry ?? module.entry, args as Value[]);
}

class Interpreter {
  private readonly functions: ReadonlyMap<string, IrFunction>;
  private readonly storageByStruct = new Map<string, ReadonlyMap<string, ArrayStorage | undefined>>();
  private iterations = 0;

  constructor(module: IrModule, private readonly iterationBudget: number) {
    this.functions = new Map(module.functions.map((fn) => [fn.name, fn]));
  }

  call(name: string, args: readonly Value[]): Value {
    const fn = this.functions.get(name);
    if (!fn) {
      throw new Error(`unknown IR function ${name}`);
    }
    if (args.length !== fn.params.length) {
      throw new Error(`${name} expects ${fn.params.length} arguments, got ${args.length}`);
    }
    const scope = new Scope();
    fn.params.forEach((param, index) => scope.declare(param.name, args[index]));
    const signal = this.block(fn.body, scope);
    return signal.kind === "return" ? signal.value : undefined;
  }

  private block(body: readonly IrStmt[], scope: Scope): Signal {
    for (const statement of body) {
      const signal = this.statement(statement, scope);
      if (signal.kind !== "normal") {
        return signal;
      }
    }
    return NORMAL;
  }

  private statement(statement: IrStmt, scope: Scope): Signal {
    switch (statement.stmt) {
      case "let":
        scope.declare(statement.name, this.expr(statement.init, scope));
        return NORMAL;
      case "assign":
        scope.set(statement.name, this.expr(statement.value, scope));
        return NORMAL;
      case "setIndex": {
        const target = this.array(statement.target, scope);
        const index = checkedIndex(this.number(statement.index, scope), target.length, "setIndex");
        const value = this.expr(statement.value, scope);
        checkTypedStore(target, value);
        (target as unknown[])[index] = value;
        return NORMAL;
      }
      case "push": {
        const target = this.array(statement.target, scope);
        if (!Array.isArray(target)) {
          throw new KernelTrap("push on a typed array");
        }
        target.push(this.expr(statement.value, scope));
        return NORMAL;
      }
      case "pop": {
        const target = this.array(statement.target, scope);
        if (!Array.isArray(target) || target.length === 0) {
          throw new KernelTrap("pop on an empty or typed array");
        }
        target.pop();
        return NORMAL;
      }
      case "clear": {
        const target = this.array(statement.target, scope);
        if (!Array.isArray(target)) {
          throw new KernelTrap("clear on a typed array");
        }
        target.length = 0;
        return NORMAL;
      }
      case "mapSet":
        this.map(statement.map, scope).set(this.string(statement.key, scope), this.number(statement.value, scope));
        return NORMAL;
      case "sortByKeys": {
        const target = this.array(statement.target, scope);
        const keys = statement.keys.map((key) => this.array(key, scope));
        for (const element of target) {
          for (const key of keys) {
            checkedIndex(element as number, key.length, "sortByKeys key");
          }
        }
        (target as number[]).sort((left, right) => {
          for (const key of keys) {
            const difference = (key[left] as number) - (key[right] as number);
            if (difference !== 0) {
              return difference;
            }
          }
          return 0;
        });
        return NORMAL;
      }
      case "if":
        return this.block(this.bool(statement.test, scope) ? statement.then : statement.otherwise, new Scope(scope));
      case "block":
        return this.block(statement.body, new Scope(scope));
      case "while":
        while (this.bool(statement.test, scope)) {
          this.iterations += 1;
          if (this.iterations > this.iterationBudget) {
            throw new KernelTrap("iteration budget exhausted");
          }
          const signal = this.block(statement.body, new Scope(scope));
          if (signal.kind === "break") {
            break;
          }
          if (signal.kind === "return") {
            return signal;
          }
        }
        return NORMAL;
      case "forRange": {
        const start = this.number(statement.start, scope);
        const end = this.number(statement.end, scope);
        for (let value = start; value < end; value += 1) {
          const iteration = new Scope(scope);
          iteration.declare(statement.variable, value);
          const signal = this.block(statement.body, iteration);
          if (signal.kind === "break") {
            break;
          }
          if (signal.kind === "return") {
            return signal;
          }
        }
        return NORMAL;
      }
      case "break":
        return BREAK;
      case "continue":
        return CONTINUE;
      case "return":
        return { kind: "return", value: statement.value ? this.expr(statement.value, scope) : undefined };
      case "expr":
        this.expr(statement.value, scope);
        return NORMAL;
    }
  }

  private expr(expr: IrExpr, scope: Scope): Value {
    switch (expr.op) {
      case "num":
      case "bool":
      case "str":
        return expr.value;
      case "local":
        return scope.get(expr.name);
      case "binary":
        return binary(expr.operator, this.expr(expr.left, scope), this.expr(expr.right, scope));
      case "and":
        return this.bool(expr.left, scope) && this.bool(expr.right, scope);
      case "or":
        return this.bool(expr.left, scope) || this.bool(expr.right, scope);
      case "not":
        return !this.bool(expr.operand, scope);
      case "neg":
        return -this.number(expr.operand, scope);
      case "cond":
        return this.bool(expr.test, scope) ? this.expr(expr.then, scope) : this.expr(expr.otherwise, scope);
      case "min":
        return Math.min(...expr.args.map((arg) => this.number(arg, scope)));
      case "max":
        return Math.max(...expr.args.map((arg) => this.number(arg, scope)));
      case "length": {
        const target = this.expr(expr.target, scope);
        return (target as { length: number }).length;
      }
      case "index": {
        const target = this.array(expr.target, scope);
        return target[checkedIndex(this.number(expr.index, scope), target.length, "index")] as Value;
      }
      case "charCodeAt": {
        const target = this.string(expr.target, scope);
        return target.charCodeAt(checkedIndex(this.number(expr.index, scope), target.length, "charCodeAt"));
      }
      case "slice": {
        const target = this.string(expr.target, scope);
        const start = this.number(expr.start, scope);
        const end = this.number(expr.end, scope);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > target.length) {
          throw new KernelTrap(`slice(${start}, ${end}) outside [0, ${target.length}]`);
        }
        return target.slice(start, end);
      }
      case "toLowerAscii": {
        const target = this.string(expr.target, scope);
        for (let index = 0; index < target.length; index += 1) {
          if (target.charCodeAt(index) >= 128) {
            throw new KernelTrap("toLowerAscii on a non-ASCII string");
          }
        }
        return target.toLowerCase();
      }
      case "mapGetOr": {
        const map = this.map(expr.map, scope);
        const key = this.string(expr.key, scope);
        return map.has(key) ? map.get(key) : this.number(expr.fallback, scope);
      }
      case "mapHas":
        return this.map(expr.map, scope).has(this.string(expr.key, scope));
      case "mapNew":
        return new Map<string, number>();
      case "field":
        return (this.expr(expr.target, scope) as Record<string, Value>)[expr.name];
      case "struct":
        return Object.fromEntries(expr.fields.map((field) => [field.name, this.expr(field.value, scope)]));
      case "arrayNew": {
        const length = this.number(expr.length, scope);
        if (!Number.isInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
          throw new KernelTrap(`array length ${length}`);
        }
        const fill = this.expr(expr.fill, scope);
        const created = createArray(expr.type.storage, length);
        checkTypedStore(created, fill);
        created.fill(fill as never);
        return created;
      }
      case "arrayLiteral":
        return expr.elements.map((element) => this.expr(element, scope));
      case "call":
        return this.call(expr.callee, expr.args.map((arg) => this.expr(arg, scope)));
    }
  }

  private number(expr: IrExpr, scope: Scope): number {
    return this.expr(expr, scope) as number;
  }

  private bool(expr: IrExpr, scope: Scope): boolean {
    return this.expr(expr, scope) as boolean;
  }

  private string(expr: IrExpr, scope: Scope): string {
    return this.expr(expr, scope) as string;
  }

  private array(expr: IrExpr, scope: Scope): ArrayValue {
    return this.expr(expr, scope) as ArrayValue;
  }

  private map(expr: IrExpr, scope: Scope): Map<string, number> {
    return this.expr(expr, scope) as Map<string, number>;
  }
}

function binary(operator: BinaryOperator, left: Value, right: Value): Value {
  switch (operator) {
    case "add":
      return (left as number) + (right as number);
    case "sub":
      return (left as number) - (right as number);
    case "mul":
      return (left as number) * (right as number);
    case "div":
      return (left as number) / (right as number);
    case "mod":
      return (left as number) % (right as number);
    case "lt":
      return (left as number) < (right as number);
    case "le":
      return (left as number) <= (right as number);
    case "gt":
      return (left as number) > (right as number);
    case "ge":
      return (left as number) >= (right as number);
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
  }
}

function checkedIndex(index: number, length: number, operation: string): number {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new KernelTrap(`${operation} index ${index} outside [0, ${length})`);
  }
  return index;
}

const TYPED_RANGES = new Map<unknown, readonly [number, number]>([
  [Uint8Array, [0, 255]],
  [Uint32Array, [0, 2 ** 32 - 1]],
  [Int32Array, [-(2 ** 31), 2 ** 31 - 1]],
]);

/** Typed stores must not rely on JS wrap-around or truncation. */
function checkTypedStore(target: ArrayValue, value: Value): void {
  const range = TYPED_RANGES.get(target.constructor);
  if (range && (typeof value !== "number" || !Number.isInteger(value) || value < range[0] || value > range[1])) {
    throw new KernelTrap(`value ${String(value)} does not fit ${target.constructor.name}`);
  }
}

function createArray(storage: ArrayStorage, length: number): ArrayValue {
  switch (storage) {
    case "u8":
      return new Uint8Array(length);
    case "u32":
      return new Uint32Array(length);
    case "i32":
      return new Int32Array(length);
    case "f64":
      return new Float64Array(length);
    case "dynamic":
      return new Array<unknown>(length);
  }
}
