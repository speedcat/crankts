import type { ProofObligation } from "./contract.js";
import { isReferenceType, type IrExpr, type IrFunction, type IrModule, type IrStmt, type IrType } from "./ir.js";

/**
 * Kernel IR verification (v0.2.1). Structural errors make a module invalid. The proof obligations of
 * a kernel contract are then discharged from the IR itself:
 *
 * - PURE: no mutation reaches parameter-derived storage (lowering already rejects captured state).
 * - NO_ALIASING: fresh storage is never copied into a second binding; struct literals of fresh
 *   storage appear only in `return`, i.e. they move out.
 * - DETERMINISTIC_ORDER: by construction (no unordered iteration; sorts are stable on integer keys).
 * - TERMINATION: PROVEN without `while` loops; otherwise GUARDED by an iteration budget.
 * - INTEGER_RANGE / STRING_SEMANTICS: GUARDED by the IR's checked operations where used.
 */

export interface VerifyDiagnostic {
  readonly function: string;
  readonly message: string;
}

export interface IrVerification {
  readonly valid: boolean;
  /** Every value the entry returns is fresh storage (no parameter-derived references). */
  readonly entryReturnsFresh: boolean;
  readonly errors: readonly VerifyDiagnostic[];
  readonly obligations: readonly ProofObligation[];
}

type Origin = "PARAM" | "FRESH";

export const ITERATION_BUDGET_GUARD = "while-loop iterations counted against a budget; exceeding it traps to the TypeScript fallback";
export const CHECKED_OPERATIONS_GUARD = "checked index, charCodeAt, slice, array length, and typed-store operations trap to the TypeScript fallback";
export const ASCII_LOWERCASE_GUARD = "toLowerAscii traps on any code unit >= 128, falling back to TypeScript toLowerCase";

export function verifyIrModule(module: IrModule): IrVerification {
  const errors: VerifyDiagnostic[] = [];
  const purity: string[] = [];
  const aliasing: string[] = [];
  const functions = new Map(module.functions.map((fn) => [fn.name, fn]));
  const structFields = new Map(module.structs.map((struct) => [struct.name, new Map(struct.fields.map((field) => [field.name, field.type]))]));

  checkCallGraph(module, functions, errors);

  const returnsFresh = new Map<string, boolean>();
  let usesWhile = false;
  let usesChecked = false;
  let usesLowerAscii = false;

  for (const fn of module.functions) {
    const types = collectLocalTypes(fn);
    const origins = computeOrigins(fn, types, returnsFresh);
    const originOf = (expr: IrExpr): Origin => exprOrigin(expr, origins, returnsFresh);
    const typeOf = (expr: IrExpr): IrType | undefined => exprType(expr, types, structFields, functions);
    returnsFresh.set(fn.name, returnExpressions(fn.body).every((expr) => originOf(expr) === "FRESH"));

    walkStatements(fn.body, (statement) => {
      switch (statement.stmt) {
        case "while":
          usesWhile = true;
          break;
        case "setIndex":
        case "push":
        case "pop":
        case "clear":
        case "sortByKeys":
          if (statement.stmt === "setIndex" || statement.stmt === "push") {
            const valueType = typeOf(statement.value);
            if (valueType && isReferenceType(valueType) && isCopyOfBinding(statement.value) && originOf(statement.value) === "FRESH") {
              aliasing.push(`${fn.name}: fresh storage stored into another array while still bound`);
            }
          }
          if (originOf(statement.target) !== "FRESH") {
            purity.push(`${fn.name}: ${statement.stmt} on parameter-derived storage`);
          }
          if (statement.stmt === "sortByKeys") {
            for (const key of statement.keys) {
              const keyType = typeOf(key);
              if (keyType?.kind !== "array" || !["u8", "u32", "i32"].includes(keyType.storage)) {
                errors.push({ function: fn.name, message: "sortByKeys keys must be integer typed arrays" });
              }
            }
          }
          break;
        case "mapSet":
          if (originOf(statement.map) !== "FRESH") {
            purity.push(`${fn.name}: mapSet on parameter-derived storage`);
          }
          break;
        case "let":
        case "assign": {
          const value = statement.stmt === "let" ? statement.init : statement.value;
          const type = statement.stmt === "let" ? statement.type : types.get(statement.name);
          if (type && isReferenceType(type) && isCopyOfBinding(value) && originOf(value) === "FRESH") {
            aliasing.push(`${fn.name}: ${statement.name} aliases fresh storage`);
          }
          break;
        }
        case "forRange":
          checkInvariantRange(fn, statement, errors);
          break;
        default:
          break;
      }
    }, (expr, inReturn) => {
      if (expr.op === "struct" && !inReturn) {
        aliasing.push(`${fn.name}: struct literal outside return may alias its fields`);
      }
      if (expr.op === "struct" || expr.op === "arrayLiteral") {
        const values = expr.op === "struct" ? expr.fields.map((field) => field.value) : expr.elements;
        for (const value of values) {
          const valueType = typeOf(value);
          if (valueType && isReferenceType(valueType) && originOf(value) === "FRESH" && !inReturn) {
            aliasing.push(`${fn.name}: fresh storage stored inside another value`);
          }
        }
      }
      if (["index", "charCodeAt", "slice", "arrayNew"].includes(expr.op)) {
        usesChecked = true;
      }
      if (expr.op === "toLowerAscii") {
        usesLowerAscii = true;
      }
    });
    walkStatements(fn.body, (statement) => {
      if (statement.stmt === "setIndex" || statement.stmt === "pop") {
        usesChecked = true;
      }
    }, () => undefined);
  }

  const subject = module.entry;
  const recursion = errors.some((error) => error.message.includes("recursion"));
  const obligations: ProofObligation[] = [
    purity.length === 0
      ? { kind: "PURE", subject, status: "PROVEN", evidence: "Kernel IR: no captured state, no mutation of parameter-derived storage" }
      : { kind: "PURE", subject, status: "UNPROVEN", evidence: purity.join("; ") },
    aliasing.length === 0
      ? { kind: "NO_ALIASING", subject, status: "PROVEN", evidence: "Kernel IR: fresh storage has a single binding; struct literals move out in return" }
      : { kind: "NO_ALIASING", subject, status: "UNPROVEN", evidence: aliasing.join("; ") },
    {
      kind: "DETERMINISTIC_ORDER",
      subject,
      status: "PROVEN",
      evidence: "Kernel IR has no unordered iteration; sortByKeys is stable on integer keys",
    },
    recursion
      ? { kind: "TERMINATION", subject, status: "UNPROVEN", evidence: "recursive call graph" }
      : usesWhile
        ? { kind: "TERMINATION", subject, status: "GUARDED", runtimeGuard: ITERATION_BUDGET_GUARD }
        : { kind: "TERMINATION", subject, status: "PROVEN", evidence: "acyclic call graph and loop-invariant forRange bounds only" },
    usesChecked
      ? { kind: "INTEGER_RANGE", subject, status: "GUARDED", runtimeGuard: CHECKED_OPERATIONS_GUARD }
      : { kind: "INTEGER_RANGE", subject, status: "PROVEN", evidence: "no index or typed-store operations" },
    usesLowerAscii
      ? { kind: "STRING_SEMANTICS", subject, status: "GUARDED", runtimeGuard: ASCII_LOWERCASE_GUARD }
      : { kind: "STRING_SEMANTICS", subject, status: "PROVEN", evidence: "string operations are UTF-16 code-unit operations" },
  ];

  return { valid: errors.length === 0, entryReturnsFresh: returnsFresh.get(module.entry) === true, errors, obligations };
}

function checkCallGraph(module: IrModule, functions: ReadonlyMap<string, IrFunction>, errors: VerifyDiagnostic[]): void {
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): void => {
    const fn = functions.get(name);
    if (!fn) {
      errors.push({ function: name, message: "call to an unknown function" });
      return;
    }
    state.set(name, "visiting");
    walkStatements(fn.body, () => undefined, (expr) => {
      if (expr.op !== "call") {
        return;
      }
      const calleeState = state.get(expr.callee);
      if (calleeState === "visiting") {
        errors.push({ function: name, message: `recursion through ${expr.callee} is not lowered` });
      } else if (calleeState === undefined) {
        visit(expr.callee);
      }
    });
    state.set(name, "done");
  };
  visit(module.entry);
  if (!functions.has(module.entry)) {
    errors.push({ function: module.entry, message: "entry function is missing" });
  }
}

/** The loop variable is never assigned in the body, and nothing `end` reads is assigned or mutated. */
function checkInvariantRange(fn: IrFunction, loop: Extract<IrStmt, { stmt: "forRange" }>, errors: VerifyDiagnostic[]): void {
  const endLocals = new Set<string>();
  walkExpression(loop.end, (expr) => {
    if (expr.op === "local") {
      endLocals.add(expr.name);
    }
  });
  walkStatements(loop.body, (statement) => {
    if (statement.stmt === "assign" && (statement.name === loop.variable || endLocals.has(statement.name))) {
      errors.push({ function: fn.name, message: `forRange ${loop.variable}: ${statement.name} is assigned in the loop body` });
    }
    if (["setIndex", "push", "pop", "clear", "sortByKeys"].includes(statement.stmt)) {
      const base = baseLocal((statement as { readonly target: IrExpr }).target);
      if (base && endLocals.has(base)) {
        errors.push({ function: fn.name, message: `forRange ${loop.variable}: bound reads ${base}, which the body mutates` });
      }
    }
  }, () => undefined);
}

function collectLocalTypes(fn: IrFunction): Map<string, IrType> {
  const types = new Map<string, IrType>(fn.params.map((param) => [param.name, param.type]));
  walkStatements(fn.body, (statement) => {
    if (statement.stmt === "let") {
      types.set(statement.name, statement.type);
    }
    if (statement.stmt === "forRange") {
      types.set(statement.variable, { kind: "f64" });
    }
  }, () => undefined);
  return types;
}

/** Flow-insensitive: a local is FRESH only if every binding of that name is a fresh value. */
function computeOrigins(fn: IrFunction, types: ReadonlyMap<string, IrType>, returnsFresh: ReadonlyMap<string, boolean>): Map<string, Origin> {
  const origins = new Map<string, Origin>(fn.params.map((param) => [param.name, "PARAM" as const]));
  const bindings: Array<{ readonly name: string; readonly value: IrExpr }> = [];
  walkStatements(fn.body, (statement) => {
    if (statement.stmt === "let") {
      bindings.push({ name: statement.name, value: statement.init });
    } else if (statement.stmt === "assign") {
      bindings.push({ name: statement.name, value: statement.value });
    }
  }, () => undefined);
  for (const { name } of bindings) {
    if (!origins.has(name) && isReferenceType(types.get(name) ?? { kind: "f64" })) {
      origins.set(name, "FRESH");
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, value } of bindings) {
      if (origins.get(name) === "FRESH" && exprOrigin(value, origins, returnsFresh) === "PARAM") {
        origins.set(name, "PARAM");
        changed = true;
      }
    }
  }
  return origins;
}

function exprOrigin(expr: IrExpr, origins: ReadonlyMap<string, Origin>, returnsFresh: ReadonlyMap<string, boolean>): Origin {
  switch (expr.op) {
    case "local":
      return origins.get(expr.name) ?? "FRESH";
    case "index":
    case "field":
      return exprOrigin(expr.target, origins, returnsFresh);
    case "cond":
      return exprOrigin(expr.then, origins, returnsFresh) === "PARAM" || exprOrigin(expr.otherwise, origins, returnsFresh) === "PARAM"
        ? "PARAM"
        : "FRESH";
    case "call":
      return returnsFresh.get(expr.callee) === true ? "FRESH" : "PARAM";
    default:
      return "FRESH";
  }
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
    case "str":
    case "slice":
    case "toLowerAscii":
      return { kind: "string" };
    default:
      return undefined;
  }
}

function isCopyOfBinding(expr: IrExpr): boolean {
  return expr.op === "local" || expr.op === "index" || expr.op === "field" || expr.op === "cond";
}

function baseLocal(expr: IrExpr): string | undefined {
  if (expr.op === "local") {
    return expr.name;
  }
  return expr.op === "index" || expr.op === "field" ? baseLocal(expr.target) : undefined;
}

function returnExpressions(body: readonly IrStmt[]): IrExpr[] {
  const values: IrExpr[] = [];
  walkStatements(body, (statement) => {
    if (statement.stmt === "return" && statement.value) {
      values.push(statement.value);
    }
  }, () => undefined);
  return values;
}

export function walkStatements(
  body: readonly IrStmt[],
  onStatement: (statement: IrStmt) => void,
  onExpression: (expr: IrExpr, inReturn: boolean) => void,
): void {
  for (const statement of body) {
    onStatement(statement);
    const inReturn = statement.stmt === "return";
    for (const expr of statementExpressions(statement)) {
      walkExpression(expr, (inner) => onExpression(inner, inReturn));
    }
    for (const nested of nestedBodies(statement)) {
      walkStatements(nested, onStatement, onExpression);
    }
  }
}

function statementExpressions(statement: IrStmt): IrExpr[] {
  switch (statement.stmt) {
    case "let":
      return [statement.init];
    case "assign":
      return [statement.value];
    case "setIndex":
      return [statement.target, statement.index, statement.value];
    case "push":
      return [statement.target, statement.value];
    case "pop":
    case "clear":
      return [statement.target];
    case "mapSet":
      return [statement.map, statement.key, statement.value];
    case "sortByKeys":
      return [statement.target, ...statement.keys];
    case "if":
    case "while":
      return [statement.test];
    case "forRange":
      return [statement.start, statement.end];
    case "return":
      return statement.value ? [statement.value] : [];
    case "expr":
      return [statement.value];
    default:
      return [];
  }
}

function nestedBodies(statement: IrStmt): (readonly IrStmt[])[] {
  switch (statement.stmt) {
    case "if":
      return [statement.then, statement.otherwise];
    case "while":
    case "forRange":
    case "block":
      return [statement.body];
    default:
      return [];
  }
}

export function walkExpression(expr: IrExpr, visit: (expr: IrExpr) => void): void {
  visit(expr);
  for (const child of childExpressions(expr)) {
    walkExpression(child, visit);
  }
}

function childExpressions(expr: IrExpr): readonly IrExpr[] {
  switch (expr.op) {
    case "binary":
    case "and":
    case "or":
      return [expr.left, expr.right];
    case "not":
    case "neg":
      return [expr.operand];
    case "cond":
      return [expr.test, expr.then, expr.otherwise];
    case "min":
    case "max":
      return expr.args;
    case "length":
    case "toLowerAscii":
      return [expr.target];
    case "index":
    case "charCodeAt":
      return [expr.target, expr.index];
    case "slice":
      return [expr.target, expr.start, expr.end];
    case "mapGetOr":
      return [expr.map, expr.key, expr.fallback];
    case "mapHas":
      return [expr.map, expr.key];
    case "field":
      return [expr.target];
    case "struct":
      return expr.fields.map((field) => field.value);
    case "arrayNew":
      return [expr.length, expr.fill];
    case "arrayLiteral":
      return expr.elements;
    case "call":
      return expr.args;
    default:
      return [];
  }
}
