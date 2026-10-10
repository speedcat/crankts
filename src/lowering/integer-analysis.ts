import type { IrExpr, IrFunction, IrModule, IrStmt, IrType } from "./ir.js";
import { walkStatements } from "./verify.js";

/**
 * Integer specialization analysis (v0.2.4). A numeric value is INT when every definition that can
 * reach it is an exact integer: integer literals (not -0), lengths, `charCodeAt`, integer typed-array
 * reads, and `+`, `-`, `min`, `max`, `?:` of INT operands. Backends represent INT as i64 with
 * arithmetic checked to |v| <= 2^53, so INT values are always exactly the JS f64 values; exceeding the
 * bound traps. `*`, `/`, `%`, and unary `-` stay f64 (they can produce -0 or non-integers).
 *
 * Flow-insensitive: scalar slots are keyed by (function, name); array element and map value classes
 * are unified (union-find) along every flow (bindings, calls, returns, struct fields). Entry
 * parameters come from JavaScript and are always f64. NONNEG additionally proves INT values >= 0.
 */

export interface IntegerAnalysis {
  /** f64-typed local or parameter `name` of `fn` is INT. */
  readonly localInt: (fn: string, name: string) => boolean;
  readonly localNonneg: (fn: string, name: string) => boolean;
  readonly returnInt: (fn: string) => boolean;
  readonly fieldInt: (struct: string, field: string) => boolean;
  /** Elements of the numeric dynamic array (or values of the map) denoted by `expr` are INT. */
  readonly elementsInt: (fn: string, expr: IrExpr) => boolean;
  readonly elementsNonneg: (fn: string, expr: IrExpr) => boolean;
  /** Elements of the array-typed local/param, struct field, or return value are INT. */
  readonly localElementsInt: (fn: string, name: string) => boolean;
  readonly fieldElementsInt: (struct: string, field: string) => boolean;
  readonly returnElementsInt: (fn: string) => boolean;
  readonly returnElementsNonneg: (fn: string) => boolean;
  readonly exprInt: (fn: string, expr: IrExpr) => boolean;
  readonly exprNonneg: (fn: string, expr: IrExpr) => boolean;
}

const MAX_EXACT = 2 ** 53;

interface Definition {
  readonly fn: string;
  readonly expr: IrExpr;
}

/** `entries`: functions called from JavaScript (all parameters f64); defaults to the module entry. */
export function analyzeIntegers(module: IrModule, entries: readonly string[] = [module.entry]): IntegerAnalysis {
  const functions = new Map(module.functions.map((fn) => [fn.name, fn]));
  const structFields = new Map(module.structs.map((struct) => [struct.name, new Map(struct.fields.map((field) => [field.name, field.type]))]));
  const localTypes = new Map<string, Map<string, IrType>>();
  for (const fn of module.functions) {
    localTypes.set(fn.name, collectTypes(fn));
  }

  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(leftRoot, rightRoot);
    }
  };

  const scalarDefinitions = new Map<string, Definition[]>();
  const classDefinitions: Array<{ readonly classKey: string; readonly definition: Definition }> = [];
  const externalScalars = new Set<string>();
  const externalClasses = new Set<string>();
  const siteKeys = new Map<IrExpr, string>();
  let siteCounter = 0;

  const typeOf = (fn: string, expr: IrExpr): IrType | undefined => exprType(expr, localTypes.get(fn) ?? new Map(), structFields, functions);
  const isNumericCollection = (type: IrType | undefined): boolean => (
    type?.kind === "map" || (type?.kind === "array" && type.storage === "dynamic" && type.element.kind === "f64")
  );

  /** Union-find key of the element/value class an array- or map-typed expression denotes. */
  const classKey = (fn: string, expr: IrExpr): string => {
    switch (expr.op) {
      case "local":
        return `C:${fn}:${expr.name}`;
      case "field": {
        const target = typeOf(fn, expr.target);
        return target?.kind === "struct" ? `CF:${target.name}.${expr.name}` : external();
      }
      case "call":
        return `CR:${expr.callee}`;
      case "arrayNew":
      case "arrayLiteral":
      case "mapNew": {
        let key = siteKeys.get(expr);
        if (!key) {
          key = `CS:${siteCounter++}`;
          siteKeys.set(expr, key);
        }
        return key;
      }
      case "cond": {
        const key = classKey(fn, expr.then);
        union(key, classKey(fn, expr.otherwise));
        return key;
      }
      default:
        // e.g. an element of an array of arrays: not tracked, so never INT.
        return external();
    }
  };
  const external = (): string => {
    const key = `CX:${siteCounter++}`;
    externalClasses.add(key);
    return key;
  };

  const defineScalar = (key: string, definition: Definition): void => {
    const definitions = scalarDefinitions.get(key) ?? [];
    definitions.push(definition);
    scalarDefinitions.set(key, definitions);
  };

  // --- collect definitions and flows ----------------------------------------------------------
  const entryNames = new Set(entries);
  for (const fn of module.functions) {
    if (entryNames.has(fn.name)) {
      for (const param of fn.params) {
        if (param.type.kind === "f64") {
          externalScalars.add(`L:${fn.name}:${param.name}`);
        }
        if (isNumericCollection(param.type)) {
          externalClasses.add(find(`C:${fn.name}:${param.name}`));
        }
      }
    }
    const bind = (name: string, type: IrType, value: IrExpr): void => {
      if (type.kind === "f64") {
        defineScalar(`L:${fn.name}:${name}`, { fn: fn.name, expr: value });
      } else if (isNumericCollection(type)) {
        union(`C:${fn.name}:${name}`, classKey(fn.name, value));
      }
    };
    walkStatements(fn.body, (statement) => {
      switch (statement.stmt) {
        case "let":
          bind(statement.name, statement.type, statement.init);
          break;
        case "assign": {
          const type = localTypes.get(fn.name)?.get(statement.name);
          if (type) {
            bind(statement.name, type, statement.value);
          }
          break;
        }
        case "forRange":
          defineScalar(`L:${fn.name}:${statement.variable}`, { fn: fn.name, expr: statement.start });
          break;
        case "setIndex":
        case "push":
          if (isNumericCollection(typeOf(fn.name, statement.target))) {
            classDefinitions.push({ classKey: classKey(fn.name, statement.target), definition: { fn: fn.name, expr: statement.value } });
          }
          break;
        case "mapSet":
          classDefinitions.push({ classKey: classKey(fn.name, statement.map), definition: { fn: fn.name, expr: statement.value } });
          break;
        case "return":
          if (statement.value && fn.returnType.kind === "f64") {
            defineScalar(`R:${fn.name}`, { fn: fn.name, expr: statement.value });
          } else if (statement.value && isNumericCollection(fn.returnType)) {
            union(`CR:${fn.name}`, classKey(fn.name, statement.value));
          }
          break;
        default:
          break;
      }
    }, (expr) => {
      if (expr.op === "arrayNew" && expr.type.storage === "dynamic" && expr.type.element.kind === "f64") {
        classDefinitions.push({ classKey: classKey(fn.name, expr), definition: { fn: fn.name, expr: expr.fill } });
      }
      if (expr.op === "arrayLiteral" && expr.type.element.kind === "f64") {
        for (const element of expr.elements) {
          classDefinitions.push({ classKey: classKey(fn.name, expr), definition: { fn: fn.name, expr: element } });
        }
      }
      if (expr.op === "struct") {
        for (const field of expr.fields) {
          const type = structFields.get(expr.name)?.get(field.name);
          if (type?.kind === "f64") {
            defineScalar(`F:${expr.name}.${field.name}`, { fn: fn.name, expr: field.value });
          } else if (type && isNumericCollection(type)) {
            union(`CF:${expr.name}.${field.name}`, classKey(fn.name, field.value));
          }
        }
      }
      if (expr.op === "call") {
        const callee = functions.get(expr.callee);
        callee?.params.forEach((param, index) => {
          const arg = expr.args[index];
          if (!arg) {
            return;
          }
          if (param.type.kind === "f64") {
            defineScalar(`L:${callee.name}:${param.name}`, { fn: fn.name, expr: arg });
          } else if (isNumericCollection(param.type)) {
            union(`C:${callee.name}:${param.name}`, classKey(fn.name, arg));
          }
        });
      }
    });
  }

  // --- fixpoint: start optimistic, demote on any non-INT definition -----------------------------
  const intScalars = new Set<string>([...scalarDefinitions.keys()].filter((key) => !externalScalars.has(key)));
  const nonnegScalars = new Set(intScalars);
  const intClasses = new Set<string>();
  const nonnegClasses = new Set<string>();
  const allClassKeys = [...parent.keys(), ...classDefinitions.map((entry) => entry.classKey)];
  for (const key of allClassKeys) {
    intClasses.add(find(key));
    nonnegClasses.add(find(key));
  }
  for (const key of externalClasses) {
    intClasses.delete(find(key));
    nonnegClasses.delete(find(key));
  }
  for (const key of externalScalars) {
    intScalars.delete(key);
    nonnegScalars.delete(key);
  }

  const isInt = (fn: string, expr: IrExpr): boolean => {
    switch (expr.op) {
      case "num":
        return Number.isInteger(expr.value) && !Object.is(expr.value, -0) && Math.abs(expr.value) <= MAX_EXACT;
      case "local":
        return intScalars.has(`L:${fn}:${expr.name}`);
      case "binary":
        return (expr.operator === "add" || expr.operator === "sub") && isInt(fn, expr.left) && isInt(fn, expr.right);
      case "min":
      case "max":
        return expr.args.every((arg) => isInt(fn, arg));
      case "cond":
        return isInt(fn, expr.then) && isInt(fn, expr.otherwise);
      case "length":
      case "charCodeAt":
        return true;
      case "index": {
        const target = typeOf(fn, expr.target);
        if (target?.kind !== "array") {
          return false;
        }
        if (target.storage !== "dynamic") {
          return target.storage !== "f64";
        }
        return target.element.kind === "f64" && intClasses.has(find(classKey(fn, expr.target)));
      }
      case "field": {
        const target = typeOf(fn, expr.target);
        return target?.kind === "struct" && intScalars.has(`F:${target.name}.${expr.name}`);
      }
      case "mapGetOr":
        return intClasses.has(find(classKey(fn, expr.map))) && isInt(fn, expr.fallback);
      case "call":
        return intScalars.has(`R:${expr.callee}`);
      default:
        return false;
    }
  };

  const isNonneg = (fn: string, expr: IrExpr): boolean => {
    if (!isInt(fn, expr)) {
      return false;
    }
    switch (expr.op) {
      case "num":
        return expr.value >= 0;
      case "local":
        return nonnegScalars.has(`L:${fn}:${expr.name}`);
      case "binary":
        return expr.operator === "add" && isNonneg(fn, expr.left) && isNonneg(fn, expr.right);
      case "min":
        return expr.args.every((arg) => isNonneg(fn, arg));
      case "max":
        return expr.args.some((arg) => isNonneg(fn, arg));
      case "cond":
        return isNonneg(fn, expr.then) && isNonneg(fn, expr.otherwise);
      case "length":
      case "charCodeAt":
        return true;
      case "index": {
        const target = typeOf(fn, expr.target);
        if (target?.kind === "array" && target.storage !== "dynamic") {
          return target.storage === "u8" || target.storage === "u32";
        }
        return nonnegClasses.has(find(classKey(fn, expr.target)));
      }
      case "field": {
        const target = typeOf(fn, expr.target);
        return target?.kind === "struct" && nonnegScalars.has(`F:${target.name}.${expr.name}`);
      }
      case "mapGetOr":
        return nonnegClasses.has(find(classKey(fn, expr.map))) && isNonneg(fn, expr.fallback);
      case "call":
        return nonnegScalars.has(`R:${expr.callee}`);
      default:
        return false;
    }
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, definitions] of scalarDefinitions) {
      if (intScalars.has(key) && definitions.some((definition) => !isInt(definition.fn, definition.expr))) {
        intScalars.delete(key);
        nonnegScalars.delete(key);
        changed = true;
      } else if (nonnegScalars.has(key) && definitions.some((definition) => !isNonneg(definition.fn, definition.expr))) {
        nonnegScalars.delete(key);
        changed = true;
      }
    }
    for (const { classKey: key, definition } of classDefinitions) {
      const root = find(key);
      if (intClasses.has(root) && !isInt(definition.fn, definition.expr)) {
        intClasses.delete(root);
        nonnegClasses.delete(root);
        changed = true;
      } else if (nonnegClasses.has(root) && !isNonneg(definition.fn, definition.expr)) {
        nonnegClasses.delete(root);
        changed = true;
      }
    }
  }

  return {
    localInt: (fn, name) => intScalars.has(`L:${fn}:${name}`),
    localNonneg: (fn, name) => nonnegScalars.has(`L:${fn}:${name}`),
    returnInt: (fn) => intScalars.has(`R:${fn}`),
    fieldInt: (struct, field) => intScalars.has(`F:${struct}.${field}`),
    elementsInt: (fn, expr) => intClasses.has(find(classKey(fn, expr))),
    elementsNonneg: (fn, expr) => nonnegClasses.has(find(classKey(fn, expr))),
    localElementsInt: (fn, name) => intClasses.has(find(`C:${fn}:${name}`)),
    fieldElementsInt: (struct, field) => intClasses.has(find(`CF:${struct}.${field}`)),
    returnElementsInt: (fn) => intClasses.has(find(`CR:${fn}`)),
    returnElementsNonneg: (fn) => nonnegClasses.has(find(`CR:${fn}`)),
    exprInt: isInt,
    exprNonneg: isNonneg,
  };
}

function collectTypes(fn: IrFunction): Map<string, IrType> {
  const types = new Map<string, IrType>(fn.params.map((param) => [param.name, param.type]));
  const visit = (statement: IrStmt): void => {
    if (statement.stmt === "let") {
      types.set(statement.name, statement.type);
    } else if (statement.stmt === "forRange") {
      types.set(statement.variable, { kind: "f64" });
    }
  };
  walkStatements(fn.body, visit, () => undefined);
  return types;
}

function exprType(
  expr: IrExpr,
  types: ReadonlyMap<string, IrType>,
  structFields: ReadonlyMap<string, ReadonlyMap<string, IrType>>,
  functions: ReadonlyMap<string, IrFunction>,
): IrType | undefined {
  switch (expr.op) {
    case "local":
      return types.get(expr.name);
    case "field": {
      const target = exprType(expr.target, types, structFields, functions);
      return target?.kind === "struct" ? structFields.get(target.name)?.get(expr.name) : undefined;
    }
    case "index": {
      const target = exprType(expr.target, types, structFields, functions);
      return target?.kind === "array" ? target.element : undefined;
    }
    case "arrayNew":
    case "arrayLiteral":
      return expr.type;
    case "mapNew":
      return { kind: "map" };
    case "struct":
      return { kind: "struct", name: expr.name };
    case "call":
      return functions.get(expr.callee)?.returnType;
    case "cond":
      return exprType(expr.then, types, structFields, functions);
    default:
      return undefined;
  }
}

