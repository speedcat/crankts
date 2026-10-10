import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type * as ts from "typescript";
import { collectFunctions } from "../analysis/functions.js";
import { createCompilerFacade } from "../compiler/compiler-facade.js";
import { applyEdits, relativeImportEdits, type Edit } from "./region.js";

/**
 * Batch id-domain pass (v0.2.6b). Turns a function that is called once per group of ids
 * (`f(members: readonly Id[], graph)`) into one packed kernel over all groups:
 *
 *   batch      f(members, G) per group           → f__batch(G__offsets, G__neighbors, groups__offsets, groups__nodes)
 *   id maps    new Map<Id, number>()              → hoisted presence + value arrays, reset per group via a touched list
 *              new Map<Id, Id | undefined>()      → hoisted value array, -1 encodes undefined (absent or stored)
 *              new Map<Id, number[]>()            → hoisted presence + nested arrays
 *              const v = m.get(k); if (v === undefined) A else B → if (!m__has[k]) A else { const v = m__value[k]; B }
 *   id sets    new Set(members)                   → hoisted bitmap, set and cleared per group
 *   frames     [{ node, neighbors: [...(G.get(node) ?? [])], cursor }] → struct of arrays; the neighbor
 *              snapshot reads the CSR slice of `node` (G is immutable during the call)
 *   best       objects pushed, sorted by a lexicographic comparator, then only `.length` and `[0] ?? null`
 *              → streaming argmin over the comparator's numeric prefix; candidates tied on it are output,
 *              and the adapter applies the original comparator to them (id localeCompare only on ties)
 *   normalized `reduce`, `[...a]`, and read-only array locals bound by conditionals become loops/copies
 *
 * Each rule has explicit preconditions; anything else is a diagnostic and the pass fails closed. The
 * emitted kernel and its helpers are TypeScript in the Kernel IR subset (the transformed-TS variant).
 */

export interface BatchInternRequest {
  readonly file: string;
  readonly function: string;
  readonly alias: string;
}

export interface BatchField {
  readonly name: string;
  readonly id: boolean;
}

/** Per group, the original return object: numbers, or a best element (present flag + fields). */
export type BatchOutputField =
  | { readonly name: string; readonly kind: "number" }
  /** The first minimum under the original comparator (verbatim), among the candidates tied on its numeric prefix. */
  | { readonly name: string; readonly kind: "bestOrNull"; readonly fields: readonly BatchField[]; readonly comparator: string };

export interface BatchInternPlan {
  readonly function: string;
  readonly batchName: string;
  readonly batchFunction: string;
  /** Same-file helpers the kernel calls, normalized to the kernel subset. */
  readonly helpers: readonly string[];
  readonly graph: string;
  readonly output: readonly BatchOutputField[];
  readonly guards: readonly string[];
  readonly typeImports: readonly { readonly specifier: string; readonly text: string }[];
  readonly sourceDirectory: string;
  /**
   * Patched copy of the source file: every `GROUPS.map((group, i) => ... f(group, G) ...)` call site is
   * batched into one `f__batch` call before the statement, and the graph's producer seals G (upstream
   * packing) right after its declaration, once G is proven immutable for the rest of the function.
   */
  readonly patchedSource: (integrationImport: string, patchedFile: string) => { readonly text: string; readonly diagnostics: readonly string[] };
}

export type BatchInternResult =
  | { readonly ok: true; readonly plan: BatchInternPlan }
  | { readonly ok: false; readonly diagnostics: readonly string[] };

export function planBatchInterning(request: BatchInternRequest): BatchInternResult {
  // Real path: the compiler reports real paths (e.g. /private/tmp on macOS for /tmp).
  const file = realpathSync(resolve(request.file));
  const facade = createCompilerFacade(file);
  const definition = collectFunctions(facade).definitions.find((candidate) => candidate.absoluteFile === file && candidate.name === request.function);
  const fn = definition?.node;
  const t = definition?.compilerFacade.typescript;
  if (!definition || !t || !fn || !t.isFunctionDeclaration(fn) || !fn.body) {
    return { ok: false, diagnostics: [`no function declaration ${request.function} with a body in ${file}`] };
  }
  return new BatchPass(t, definition.compilerFacade.checker, definition.sourceFile, fn, request.alias).run();
}

type MapKind = "number" | "id" | "list";

interface FrameStack {
  readonly name: string;
  /** Value fields in declaration order; the first is the frame's node. */
  readonly values: readonly string[];
  readonly neighbors: string;
}

interface BestList {
  readonly name: string;
  readonly fields: readonly BatchField[];
  comparator?: ts.ArrowFunction;
}

class BatchPass {
  private readonly diagnostics: string[] = [];
  private members: string | undefined;
  private graph: string | undefined;
  private readonly maps = new Map<ts.Symbol, { name: string; kind: MapKind }>();
  private memberSet: ts.Symbol | undefined;
  private readonly frames = new Map<ts.Symbol, FrameStack>();
  private readonly frameBindings = new Map<ts.Symbol, FrameStack>();
  private readonly bests = new Map<ts.Symbol, BestList>();
  private readonly optionalIds = new Set<ts.Symbol>();
  private readonly nonEmptyIds = new Set<ts.Symbol>();
  private readonly deferredBranches = new Map<ts.VariableStatement, ts.IfStatement>();
  private readonly renames = new Map<ts.Symbol, string>();
  private temp = 0;
  private readonly replacements = new Map<ts.Node, string>();
  /** Frame fields assigned through a frame binding; the others are captured when the binding is made. */
  private readonly mutatedFrameFields = new Set<string>();

  constructor(
    private readonly t: typeof ts,
    private readonly checker: ts.TypeChecker,
    private readonly sourceFile: ts.SourceFile,
    private readonly fn: ts.FunctionDeclaration,
    private readonly alias: string,
  ) {}

  run(): BatchInternResult {
    const name = this.fn.name?.text ?? "anonymous";
    this.inferParams();
    this.inferLocals();
    const body = this.fn.body as ts.Block;
    const statements = [...body.statements];
    const last = statements.pop();
    if (!last || !this.t.isReturnStatement(last) || !last.expression || !this.t.isObjectLiteralExpression(last.expression)) {
      this.diagnostics.push("the function must end with `return { ... }` (single exit)");
      return { ok: false, diagnostics: this.diagnostics };
    }
    this.checkNoEarlyReturn(statements);
    const column = this.column(statements[0]);
    const bodyText = statements.map((statement) => this.print(statement)).join("\n");
    const output = this.outputFields(last.expression);
    const outputText = this.outputCode(last.expression, output);
    const helpers = this.helpers();
    if (this.diagnostics.length > 0) {
      return { ok: false, diagnostics: this.diagnostics };
    }

    const graph = this.graph as string;
    const hoisted: string[] = ["const __n = " + `${graph}__offsets.length - 1;`, "const __touched: number[] = [];"];
    if (this.memberSet) hoisted.push(`const ${this.memberSet.getName()} = new Array<boolean>(__n).fill(false);`);
    const resets: string[] = [];
    for (const { name: map, kind } of this.maps.values()) {
      if (kind === "number") {
        hoisted.push(`const ${map}__has = new Array<boolean>(__n).fill(false);`, `const ${map}__value = new Array<number>(__n).fill(0);`);
        resets.push(`${map}__has[__key] = false;`);
      } else if (kind === "id") {
        hoisted.push(`const ${map}__has = new Array<boolean>(__n).fill(false);`, `const ${map}__value = new Array<number>(__n).fill(-1);`);
        resets.push(`${map}__has[__key] = false;`, `${map}__value[__key] = -1;`);
      } else {
        hoisted.push(`const ${map}__has = new Array<boolean>(__n).fill(false);`, `const ${map}__value: number[][] = [];`,
          `for (let __node = 0; __node < __n; __node++) {`, `  ${map}__value.push([]);`, "}");
        resets.push(`${map}__has[__key] = false;`);
      }
    }
    const batchName = `${name}__batch`;
    const membersName = this.members as string;
    const lines = [
      `export function ${batchName}(`,
      `  ${graph}__offsets: Uint32Array,`,
      `  ${graph}__neighbors: Uint32Array,`,
      "  groups__offsets: Uint32Array,",
      "  groups__nodes: Uint32Array,",
      "): number[] {",
      ...hoisted.map((line) => `  ${line}`),
      "  const __groups = groups__offsets.length - 1;",
      "  const __out: number[] = [__groups];",
      "  for (let __group = 0; __group < __groups; __group++) {",
      `    const ${membersName}: number[] = [];`,
      "    for (let __slot = groups__offsets[__group]; __slot < groups__offsets[__group + 1]; __slot++) {",
      `      ${membersName}.push(groups__nodes[__slot]);`,
      "    }",
      indent(bodyText, column, "    "),
      indent(outputText, 0, "    "),
      "    for (const __key of __touched) {",
      ...resets.map((line) => `      ${line}`),
      "    }",
      "    __touched.length = 0;",
      ...(this.memberSet ? [`    for (const __member of ${membersName}) {`, `      ${this.memberSet.getName()}[__member] = false;`, "    }"] : []),
      "  }",
      "  return __out;",
      "}",
    ];
    const batchFunction = lines.join("\n").replace(/\n(\s*\n)+/g, "\n");
    if (new RegExp(`\\b${this.alias}\\b`).test(batchFunction) || /\.(get|has|set)\(/.test(batchFunction.replace(/\.has\b(?!\()/g, ""))) {
      const leftover = batchFunction.split("\n").filter((line) => new RegExp(`\\b${this.alias}\\b|\\.(get|set)\\(`).test(line)).slice(0, 3);
      return { ok: false, diagnostics: [`uncovered id or map operations remain: ${leftover.join(" | ")}`] };
    }
    return {
      ok: true,
      plan: {
        function: name,
        batchName,
        batchFunction,
        helpers,
        graph,
        output,
        guards: ["every group id is a graph key", "graph closed over its keys", "ids non-empty"],
        typeImports: this.sourceFile.statements
          .filter((statement): statement is ts.ImportDeclaration => this.t.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true)
          .map((statement) => ({ specifier: (statement.moduleSpecifier as ts.StringLiteral).text, text: statement.getText(this.sourceFile) })),
        sourceDirectory: dirname(this.sourceFile.fileName),
        patchedSource: (integrationImport, patchedFile) => this.patchCallSites(integrationImport, patchedFile),
      },
    };
  }

  // --- inference --------------------------------------------------------------------------------

  private inferParams(): void {
    const t = this.t;
    for (const parameter of this.fn.parameters) {
      const name = parameter.name.getText(this.sourceFile);
      const type = parameter.type?.getText(this.sourceFile) ?? "";
      if (new RegExp(`^(readonly\\s+)?${this.alias}\\[\\]$`).test(type)) {
        this.members = name;
      } else if (new RegExp(`^(Readonly)?Map<${this.alias},\\s*(Readonly)?Set<${this.alias}>>$`).test(type)) {
        this.graph = name;
      } else {
        this.diagnostics.push(`parameter ${name}: ${type} has no batch packing rule`);
      }
      void t;
    }
    if (!this.members) this.diagnostics.push("batching needs one `readonly Id[]` group parameter");
    if (!this.graph) this.diagnostics.push("batching needs a `Map<Id, Set<Id>>` graph parameter");
  }

  private inferLocals(): void {
    const t = this.t;
    const visit = (node: ts.Node): void => {
      if (t.isVariableDeclaration(node) && t.isIdentifier(node.name) && node.initializer) {
        const symbol = this.checker.getSymbolAtLocation(node.name);
        const init = node.initializer;
        if (symbol && t.isNewExpression(init) && t.isIdentifier(init.expression)) {
          const args = init.typeArguments?.map((argument) => argument.getText(this.sourceFile).replace(/\s+/g, " ")) ?? [];
          if (init.expression.text === "Set" && init.arguments?.length === 1 && init.arguments[0]?.getText(this.sourceFile) === this.members) {
            this.memberSet = symbol;
          } else if (init.expression.text === "Map" && args[0] === this.alias && (init.arguments?.length ?? 0) === 0) {
            const kind: MapKind | undefined = args[1] === "number" ? "number"
              : args[1] === `${this.alias} | undefined` ? "id"
                : args[1] === "number[]" ? "list" : undefined;
            if (!kind) this.diagnostics.push(`Map<${args.join(", ")}> at line ${this.line(node)} has no packing rule`);
            else this.maps.set(symbol, { name: node.name.text, kind });
          }
        }
        if (symbol && t.isArrayLiteralExpression(init) && init.elements.length === 1 && t.isObjectLiteralExpression(init.elements[0] as ts.Node)) {
          const frame = this.frameShape(node.name.text, init.elements[0] as ts.ObjectLiteralExpression);
          if (frame) this.frames.set(symbol, frame);
        }
        if (symbol && t.isArrayLiteralExpression(init) && init.elements.length === 0 && node.type) {
          const best = this.bestShape(symbol, node.name.text);
          if (best) this.bests.set(symbol, best);
        }
        // const frame = stack[stack.length - 1] (first statement of `while (stack.length > 0)`)
        if (symbol && t.isElementAccessExpression(init) && t.isIdentifier(init.expression)) {
          const stack = this.checker.getSymbolAtLocation(init.expression);
          const frame = stack ? this.frames.get(stack) : undefined;
          if (frame && init.argumentExpression.getText(this.sourceFile).replace(/\s+/g, "") === `${init.expression.text}.length-1`) {
            // Only directly inside `while (stack.length > 0)`: the binding is then always defined.
            const loop = node.parent.parent.parent?.parent;
            if (loop && t.isWhileStatement(loop) && loop.expression.getText(this.sourceFile).replace(/\s+/g, "") === `${init.expression.text}.length>0`) {
              this.frameBindings.set(symbol, frame);
            } else {
              this.diagnostics.push(`frame ${node.name.text} at line ${this.line(node)} must be the top of \`while (${init.expression.text}.length > 0)\``);
            }
          }
        }
        if (symbol && t.isElementAccessExpression(init) && t.isPropertyAccessExpression(init.expression)
          && t.isIdentifier(init.expression.expression)) {
          const frameSymbol = this.checker.getSymbolAtLocation(init.expression.expression);
          const frame = frameSymbol ? this.frameBindings.get(frameSymbol) : undefined;
          if (frame && init.expression.name.text === frame.neighbors) this.nonEmptyIds.add(symbol);
        }
        // const v = idMap.get(k) → Id | undefined
        if (symbol && t.isCallExpression(init) && t.isPropertyAccessExpression(init.expression) && init.expression.name.text === "get"
          && t.isIdentifier(init.expression.expression)) {
          const map = this.mapOf(init.expression.expression);
          if (map?.kind === "id") this.optionalIds.add(symbol);
          if (map?.kind === "number") {
            const statement = node.parent.parent;
            const next = t.isVariableStatement(statement) && t.isBlock(statement.parent)
              ? statement.parent.statements[statement.parent.statements.indexOf(statement) + 1]
              : undefined;
            const uses = this.references(symbol);
            const branch = next && t.isIfStatement(next) && next.elseStatement
              && next.expression.getText(this.sourceFile).replace(/\s+/g, " ") === `${node.name.text} === undefined`
              ? next : undefined;
            if (branch && t.isVariableStatement(statement)
              && uses.every((use) => use.parent === branch.expression || isWithin(use, branch.elseStatement as ts.Statement))) {
              this.deferredBranches.set(statement, branch);
            } else {
              this.diagnostics.push(`const ${node.name.text} = ${init.getText(this.sourceFile)} at line ${this.line(node)} must be followed by \`if (${node.name.text} === undefined) ... else ...\` and used only in the else branch`);
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(this.fn.body as ts.Block);
    const mutations = (node: ts.Node): void => {
      const target = t.isBinaryExpression(node) && node.operatorToken.kind >= t.SyntaxKind.FirstAssignment && node.operatorToken.kind <= t.SyntaxKind.LastAssignment ? node.left
        : (t.isPrefixUnaryExpression(node) || t.isPostfixUnaryExpression(node)) && [t.SyntaxKind.PlusPlusToken, t.SyntaxKind.MinusMinusToken].includes(node.operator) ? node.operand : undefined;
      if (target && t.isPropertyAccessExpression(target) && t.isIdentifier(target.expression)) {
        const symbol = this.checker.getSymbolAtLocation(target.expression);
        if (symbol && this.frameBindings.has(symbol)) this.mutatedFrameFields.add(target.name.text);
      }
      node.forEachChild(mutations);
    };
    mutations(this.fn.body as ts.Block);
    for (const frame of new Set(this.frameBindings.values())) {
      if (frame.values.every((field) => this.mutatedFrameFields.has(field))) continue;
      if (this.mutatedFrameFields.has(frame.values[0] as string)) this.diagnostics.push(`frame ${frame.name}: its node field must not be reassigned`);
    }
  }

  private frameShape(name: string, literal: ts.ObjectLiteralExpression): FrameStack | undefined {
    const t = this.t;
    const values: string[] = [];
    let neighbors: string | undefined;
    for (const property of literal.properties) {
      if (!t.isPropertyAssignment(property) || !t.isIdentifier(property.name)) return undefined;
      const value = property.initializer;
      if (t.isArrayLiteralExpression(value) && value.elements.length === 1 && t.isSpreadElement(value.elements[0] as ts.Node)) {
        const lookup = this.graphLookup((value.elements[0] as ts.SpreadElement).expression);
        if (!lookup || neighbors) return undefined;
        neighbors = property.name.text;
        continue;
      }
      values.push(property.name.text);
    }
    if (!neighbors || values.length === 0) return undefined;
    // The neighbor snapshot must be keyed by the frame's first value field (its node).
    const node = literal.properties.find((property) => t.isPropertyAssignment(property) && property.name.getText(this.sourceFile) === values[0]) as ts.PropertyAssignment | undefined;
    const neighborProperty = literal.properties.find((property) => t.isPropertyAssignment(property) && property.name.getText(this.sourceFile) === neighbors) as ts.PropertyAssignment;
    const key = this.graphLookup(((neighborProperty.initializer as ts.ArrayLiteralExpression).elements[0] as ts.SpreadElement).expression)?.key;
    if (!node || !key || key.getText(this.sourceFile) !== node.initializer.getText(this.sourceFile)) {
      this.diagnostics.push(`frame ${name}: the neighbor snapshot must be taken from the frame's node`);
      return undefined;
    }
    return { name, values, neighbors };
  }

  /** Objects pushed, then one sort, then only `.length` and `[0] ?? null` (inside the final return). */
  private bestShape(symbol: ts.Symbol, name: string): BestList | undefined {
    const t = this.t;
    const uses = this.references(symbol);
    let fields: BatchField[] | undefined;
    let comparator: ts.ArrowFunction | undefined;
    for (const use of uses) {
      const parent = use.parent;
      if (t.isPropertyAccessExpression(parent) && parent.name.text === "push" && t.isCallExpression(parent.parent)
        && parent.parent.arguments.length === 1 && t.isObjectLiteralExpression(parent.parent.arguments[0] as ts.Node)) {
        const literal = parent.parent.arguments[0] as ts.ObjectLiteralExpression;
        const shape = literal.properties.map((property) => (t.isPropertyAssignment(property) || t.isShorthandPropertyAssignment(property) ? property.name.getText(this.sourceFile) : ""));
        const next = shape.map((field) => ({ name: field, id: this.isIdField(literal, field) }));
        if (fields && JSON.stringify(fields) !== JSON.stringify(next)) return undefined;
        fields = next;
        continue;
      }
      if (t.isPropertyAccessExpression(parent) && parent.name.text === "sort" && t.isCallExpression(parent.parent)
        && t.isArrowFunction(parent.parent.arguments[0] as ts.Node) && !comparator) {
        comparator = parent.parent.arguments[0] as ts.ArrowFunction;
        continue;
      }
      if (t.isPropertyAccessExpression(parent) && parent.name.text === "length") continue;
      if (t.isElementAccessExpression(parent) && parent.argumentExpression.getText(this.sourceFile) === "0"
        && t.isBinaryExpression(parent.parent) && parent.parent.operatorToken.kind === t.SyntaxKind.QuestionQuestionToken
        && parent.parent.right.kind === t.SyntaxKind.NullKeyword && this.inFinalReturn(parent.parent)) continue;
      return undefined;
    }
    if (!fields || !comparator) return undefined;
    return { name, fields, comparator };
  }

  private isIdField(literal: ts.ObjectLiteralExpression, field: string): boolean {
    const t = this.t;
    const property = literal.properties.find((candidate) => candidate.name?.getText(this.sourceFile) === field);
    const value = property && t.isPropertyAssignment(property) ? property.initializer : property && t.isShorthandPropertyAssignment(property) ? property.name : undefined;
    return value !== undefined && this.isIdValue(value);
  }

  private isIdValue(node: ts.Node): boolean {
    const t = this.t;
    if (!t.isIdentifier(node)) return false;
    const symbol = this.checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (!declaration) return false;
    // for (const x of members)
    const loop = declaration.parent?.parent;
    return loop !== undefined && t.isForOfStatement(loop) && loop.expression.getText(this.sourceFile) === this.members;
  }

  // --- printing ---------------------------------------------------------------------------------

  private print(node: ts.Node): string {
    const replaced = this.replacements.get(node);
    if (replaced !== undefined) return replaced;
    const rewritten = this.rewrite(node);
    if (rewritten !== undefined) return rewritten;
    return this.printChildren(node);
  }

  private printChildren(node: ts.Node): string {
    const start = node.getStart(this.sourceFile);
    let text = "";
    let cursor = start;
    for (const child of node.getChildren(this.sourceFile)) {
      text += this.sourceFile.text.slice(cursor, child.getStart(this.sourceFile)) + this.print(child);
      cursor = child.getEnd();
    }
    return text + this.sourceFile.text.slice(cursor, node.getEnd());
  }

  private rewrite(node: ts.Node): string | undefined {
    const t = this.t;
    const nl = (): string => `\n${" ".repeat(this.column(node))}`;

    if (t.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      const renamed = symbol ? this.renames.get(symbol) : undefined;
      if (renamed && !(t.isPropertyAccessExpression(node.parent) && node.parent.name === node)) return renamed;
    }

    if (t.isVariableStatement(node)) {
      const declaration = node.declarationList.declarations[0];
      const symbol = declaration && t.isIdentifier(declaration.name) ? this.checker.getSymbolAtLocation(declaration.name) : undefined;
      if (symbol && declaration && node.declarationList.declarations.length === 1) {
        if (this.maps.has(symbol)) return "";
        if (symbol === this.memberSet) return `for (const __member of ${this.members}) {${nl()}  ${symbol.getName()}[__member] = true;${nl()}}`;
        const frame = this.frames.get(symbol);
        if (frame) return this.frameDeclaration(frame, (declaration.initializer as ts.ArrayLiteralExpression).elements[0] as ts.ObjectLiteralExpression, nl());
        const best = this.bests.get(symbol);
        if (best) return [`let ${best.name}__count = 0;`, ...best.fields.map((field) => `const ${best.name}__ties_${field.name}: number[] = [];`)].join(nl());
        const frameBinding = this.frameBindings.get(symbol);
        if (frameBinding) {
          const binding = declaration.name.getText(this.sourceFile);
          // Immutable fields are captured now, so they stay readable after the frame is popped.
          return [`const ${binding} = ${frameBinding.name}__${frameBinding.values[0]}.length - 1;`,
            ...frameBinding.values.filter((field) => !this.mutatedFrameFields.has(field)).map((field) => `const ${binding}__${field} = ${frameBinding.name}__${field}[${binding}];`)].join(nl());
        }
        const branch = this.deferredBranches.get(node);
        if (branch) return "";
        const normalized = this.normalizeDeclaration(declaration, symbol, nl());
        if (normalized !== undefined) return normalized;
      }
    }

    // if (!frame) break;  right after a frame binding: the stack is non-empty (loop condition).
    if (t.isIfStatement(node) && t.isPrefixUnaryExpression(node.expression) && node.expression.operator === t.SyntaxKind.ExclamationToken
      && t.isIdentifier(node.expression.operand)) {
      const symbol = this.checker.getSymbolAtLocation(node.expression.operand);
      if (symbol && this.frameBindings.has(symbol)) return "";
    }

    // Deferred `v = m.get(k)` branch
    if (t.isIfStatement(node)) {
      for (const [statement, branch] of this.deferredBranches) {
        if (branch !== node) continue;
        const declaration = statement.declarationList.declarations[0] as ts.VariableDeclaration;
        const call = declaration.initializer as ts.CallExpression;
        const map = this.mapOf((call.expression as ts.PropertyAccessExpression).expression as ts.Identifier);
        const key = this.print(call.arguments[0] as ts.Expression);
        const otherwise = this.print(branch.elseStatement as ts.Statement);
        const open = otherwise.indexOf("{");
        return `if (!${map?.name}__has[${key}]) ${this.print(branch.thenStatement)} else {${nl()}  const ${declaration.name.getText(this.sourceFile)} = ${map?.name}__value[${key}];${otherwise.slice(open + 1)}`;
      }
    }

    // Map operations
    if (t.isExpressionStatement(node) && t.isCallExpression(node.expression)) {
      const call = node.expression;
      // m.set(k, v)
      if (t.isPropertyAccessExpression(call.expression) && call.expression.name.text === "set" && t.isIdentifier(call.expression.expression)) {
        const map = this.mapOf(call.expression.expression);
        if (map) {
          const key = this.print(call.arguments[0] as ts.Expression);
          const valueNode = call.arguments[1] as ts.Expression;
          let value = this.print(valueNode);
          if (map.kind === "id" && valueNode.kind === t.SyntaxKind.Identifier && valueNode.getText(this.sourceFile) === "undefined") value = "-1";
          if (map.kind === "list" && !(t.isArrayLiteralExpression(valueNode) && valueNode.elements.length === 0)) {
            this.diagnostics.push(`list map ${map.name} may only be set to [] (line ${this.line(node)})`);
          }
          return `if (!${map.name}__has[${key}]) {${nl()}  ${map.name}__has[${key}] = true;${nl()}  __touched.push(${key});${nl()}}${nl()}${map.name}__value[${key}] = ${value};`;
        }
      }
      // m.get(k)?.push(v) on a list map
      if (t.isPropertyAccessExpression(call.expression) && call.expression.name.text === "push" && call.expression.questionDotToken
        && t.isCallExpression(call.expression.expression) && t.isPropertyAccessExpression(call.expression.expression.expression)
        && call.expression.expression.expression.name.text === "get" && t.isIdentifier(call.expression.expression.expression.expression)) {
        const map = this.mapOf(call.expression.expression.expression.expression);
        if (map?.kind === "list") {
          const key = this.print(call.expression.expression.arguments[0] as ts.Expression);
          return `if (${map.name}__has[${key}]) {${nl()}  ${map.name}__value[${key}].push(${this.print(call.arguments[0] as ts.Expression)});${nl()}}`;
        }
      }
      // frame stack push / pop
      if (t.isPropertyAccessExpression(call.expression) && t.isIdentifier(call.expression.expression)) {
        const symbol = this.checker.getSymbolAtLocation(call.expression.expression);
        const frame = symbol ? this.frames.get(symbol) : undefined;
        if (frame && call.expression.name.text === "pop") {
          return frame.values.map((field) => `${frame.name}__${field}.pop();`).join(nl());
        }
        if (frame && call.expression.name.text === "push" && t.isObjectLiteralExpression(call.arguments[0] as ts.Node)) {
          return this.framePush(frame, call.arguments[0] as ts.ObjectLiteralExpression, nl());
        }
        const best = symbol ? this.bests.get(symbol) : undefined;
        if (best && call.expression.name.text === "sort") return "";
        if (best && call.expression.name.text === "push") {
          return this.bestPush(best, call.arguments[0] as ts.ObjectLiteralExpression, nl());
        }
      }
    }

    // m.get(k) ?? d
    if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.QuestionQuestionToken && t.isCallExpression(node.left)
      && t.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === "get" && t.isIdentifier(node.left.expression.expression)) {
      const map = this.mapOf(node.left.expression.expression);
      if (map && map.kind !== "id") {
        const key = this.print(node.left.arguments[0] as ts.Expression);
        return `(${map.name}__has[${key}] ? ${map.name}__value[${key}] : ${this.print(node.right)})`;
      }
    }
    // idMap.get(k) → value (-1 = undefined)
    if (t.isCallExpression(node) && t.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get" && t.isIdentifier(node.expression.expression)) {
      const map = this.mapOf(node.expression.expression);
      if (map?.kind === "id") return `${map.name}__value[${this.print(node.arguments[0] as ts.Expression)}]`;
      if (map) this.diagnostics.push(`${map.name}.get() at line ${this.line(node)} must be used as \`?? fallback\` or in the undefined-branch idiom`);
    }
    // m.has(k)
    if (t.isCallExpression(node) && t.isPropertyAccessExpression(node.expression) && node.expression.name.text === "has" && t.isIdentifier(node.expression.expression)) {
      const target = this.checker.getSymbolAtLocation(node.expression.expression);
      const key = this.print(node.arguments[0] as ts.Expression);
      if (target && target === this.memberSet) return `${target.getName()}[${key}]`;
      const map = this.mapOf(node.expression.expression);
      if (map) return `${map.name}__has[${key}]`;
    }
    // x === undefined for optional ids (idMap values) → x === -1
    if (t.isBinaryExpression(node) && (node.operatorToken.kind === t.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === t.SyntaxKind.ExclamationEqualsEqualsToken)
      && node.right.getText(this.sourceFile) === "undefined" && this.isOptionalId(node.left)) {
      return `${this.print(node.left)} ${node.operatorToken.getText(this.sourceFile)} -1`;
    }
    // !x || rest  /  !x for guarded non-empty ids
    if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.BarBarToken && this.isGuardedFalsy(node.left)) {
      return this.print(node.right);
    }
    if (this.isGuardedFalsy(node)) return "false";

    // frame field access
    if (t.isPropertyAccessExpression(node) && t.isIdentifier(node.expression)) {
      const symbol = this.checker.getSymbolAtLocation(node.expression);
      const frame = symbol ? this.frameBindings.get(symbol) : undefined;
      if (frame) {
        const index = node.expression.text;
        if (frame.values.includes(node.name.text)) {
          if (!this.mutatedFrameFields.has(node.name.text)) return `${index}__${node.name.text}`;
          if (this.afterPop(node, frame)) this.diagnostics.push(`mutable frame field ${index}.${node.name.text} is read after the pop (line ${this.line(node)})`);
          return `${frame.name}__${node.name.text}[${index}]`;
        }
        if (node.name.text === frame.neighbors) {
          this.diagnostics.push(`frame neighbors at line ${this.line(node)} must be used as .length or [i]`);
        }
      }
      const stack = symbol ? this.frames.get(symbol) : undefined;
      if (stack && node.name.text === "length") return `${stack.name}__${stack.values[0]}.length`;
      const best = symbol ? this.bests.get(symbol) : undefined;
      if (best && node.name.text === "length") return `${best.name}__count`;
    }
    if (t.isPropertyAccessExpression(node) && node.name.text === "length" && t.isPropertyAccessExpression(node.expression)) {
      const neighbors = this.frameNeighbors(node.expression);
      if (neighbors) return `(${this.graph}__offsets[${neighbors.node} + 1] - ${this.graph}__offsets[${neighbors.node}])`;
    }
    if (t.isElementAccessExpression(node) && t.isPropertyAccessExpression(node.expression)) {
      const neighbors = this.frameNeighbors(node.expression);
      if (neighbors) return `${this.graph}__neighbors[${this.graph}__offsets[${neighbors.node}] + ${this.print(node.argumentExpression)}]`;
    }

    // Type annotations with the alias (e.g. on locals) → number
    if (t.isTypeReferenceNode(node) && node.typeName.getText(this.sourceFile) === this.alias) return "number";
    return undefined;
  }

  private frameNeighbors(access: ts.PropertyAccessExpression): { node: string } | undefined {
    const t = this.t;
    if (!t.isIdentifier(access.expression)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(access.expression);
    const frame = symbol ? this.frameBindings.get(symbol) : undefined;
    return frame && access.name.text === frame.neighbors ? { node: `${access.expression.text}__${frame.values[0]}` } : undefined;
  }

  /** Is `node` after a `stack.pop()` statement of the same block chain? */
  private afterPop(node: ts.Node, frame: FrameStack): boolean {
    const t = this.t;
    for (let current: ts.Node = node; current.parent; current = current.parent) {
      const block = current.parent;
      if (!t.isBlock(block)) continue;
      const index = block.statements.indexOf(current as ts.Statement);
      if (block.statements.slice(0, index).some((statement) => statement.getText(this.sourceFile).replace(/\s+/g, "") === `${frame.name}.pop();`)) return true;
    }
    return false;
  }

  private frameDeclaration(frame: FrameStack, literal: ts.ObjectLiteralExpression, nl: string): string {
    return frame.values.map((field) => `const ${frame.name}__${field}: number[] = [${this.frameValue(literal, field)}];`).join(nl);
  }

  private framePush(frame: FrameStack, literal: ts.ObjectLiteralExpression, nl: string): string {
    const shape = literal.properties.map((property) => property.name?.getText(this.sourceFile));
    if (JSON.stringify(shape) !== JSON.stringify([...frame.values.slice(0, 1), frame.neighbors, ...frame.values.slice(1)])
      && JSON.stringify([...shape].sort()) !== JSON.stringify([...frame.values, frame.neighbors].sort())) {
      this.diagnostics.push(`frame push at line ${this.line(literal)} has a different shape`);
    }
    const lookup = literal.properties.find((property) => property.name?.getText(this.sourceFile) === frame.neighbors) as ts.PropertyAssignment;
    const key = this.graphLookup(((lookup.initializer as ts.ArrayLiteralExpression).elements[0] as ts.SpreadElement).expression)?.key;
    const node = literal.properties.find((property) => property.name?.getText(this.sourceFile) === frame.values[0]) as ts.PropertyAssignment;
    if (!key || key.getText(this.sourceFile) !== node.initializer.getText(this.sourceFile)) {
      this.diagnostics.push(`frame push at line ${this.line(literal)}: the neighbor snapshot must be taken from the frame's node`);
    }
    return frame.values.map((field) => `${frame.name}__${field}.push(${this.frameValue(literal, field)});`).join(nl);
  }

  private frameValue(literal: ts.ObjectLiteralExpression, field: string): string {
    const property = literal.properties.find((candidate) => candidate.name?.getText(this.sourceFile) === field) as ts.PropertyAssignment;
    return this.print(property.initializer);
  }

  /**
   * Streaming argmin of a sorted-then-first list over the numeric comparator prefix. Candidates tied on it
   * are kept in order; the adapter applies the original comparator verbatim to the ties and keeps the first
   * minimum (what a stable sort followed by `[0]` returns). Id terms such as `a.id.localeCompare(b.id)`
   * thus cost only on ties instead of a localeCompare rank of every id.
   */
  private bestPush(best: BestList, literal: ts.ObjectLiteralExpression, nl: string): string {
    const t = this.t;
    const comparator = best.comparator;
    if (!comparator || comparator.parameters.length !== 2) {
      this.diagnostics.push(`${best.name}: missing comparator`);
      return "";
    }
    const temps = best.fields.map((field) => {
      const property = literal.properties.find((candidate) => candidate.name?.getText(this.sourceFile) === field.name);
      const value = property && t.isPropertyAssignment(property) ? property.initializer : property && t.isShorthandPropertyAssignment(property) ? property.name : undefined;
      return { field, temp: `__${best.name}_${field.name}${this.temp++}`, value: value ? this.print(value) : "0" };
    });
    const [left, right] = comparator.parameters.map((parameter) => parameter.name.getText(this.sourceFile));
    const candidate = Object.fromEntries(temps.map((entry) => [entry.field.name, entry.temp]));
    // The current best is the first tie (ties share the numeric prefix).
    const current = Object.fromEntries(best.fields.map((field) => [field.name, `${best.name}__ties_${field.name}[0]`]));
    const numeric = this.numericPrefix(comparator.body, { [left as string]: candidate, [right as string]: current }, best);
    const difference = `__${best.name}_order${this.temp++}`;
    const reset = temps.flatMap((entry) => [`  ${best.name}__ties_${entry.field.name}.length = 0;`, `  ${best.name}__ties_${entry.field.name}.push(${entry.temp});`]);
    const append = temps.map((entry) => `  ${best.name}__ties_${entry.field.name}.push(${entry.temp});`);
    if (numeric === undefined) {
      return [...temps.map((entry) => `const ${entry.temp} = ${entry.value};`), `${best.name}__count += 1;`, ...append.map((line) => line.trim())].join(nl);
    }
    return [
      ...temps.map((entry) => `const ${entry.temp} = ${entry.value};`),
      `${best.name}__count += 1;`,
      `const ${difference} = ${best.name}__count === 1 ? -1 : ${numeric};`,
      `if (${difference} < 0) {`,
      ...reset,
      `} else if (${difference} === 0) {`,
      ...append,
      "}",
    ].join(nl);
  }

  /**
   * The comparator as a lexicographic chain `t1 || t2 || ...` of numeric field differences followed by id
   * `localeCompare` terms; returns the numeric prefix (undefined if there is none). `a || b` on numbers is
   * `a` unless it is 0 or NaN.
   */
  private numericPrefix(body: ts.Node, sides: Record<string, Record<string, string>>, best: BestList): string | undefined {
    const t = this.t;
    const side = (access: ts.Node): string | undefined => {
      if (!t.isPropertyAccessExpression(access) || !t.isIdentifier(access.expression)) return undefined;
      return sides[access.expression.text]?.[access.name.text];
    };
    const terms: ts.Expression[] = [];
    const flatten = (expression: ts.Expression): void => {
      if (t.isParenthesizedExpression(expression)) return flatten(expression.expression);
      if (t.isBinaryExpression(expression) && expression.operatorToken.kind === t.SyntaxKind.BarBarToken) {
        flatten(expression.left);
        flatten(expression.right);
        return;
      }
      terms.push(expression);
    };
    if (t.isBlock(body)) {
      this.diagnostics.push(`comparator of ${best.name} must be an expression`);
      return undefined;
    }
    flatten(body as ts.Expression);
    const numeric: string[] = [];
    let idTerms = 0;
    for (const term of terms) {
      if (t.isBinaryExpression(term) && term.operatorToken.kind === t.SyntaxKind.MinusToken && !idTerms) {
        const left = side(term.left);
        const right = side(term.right);
        if (left && right) {
          numeric.push(`(${left} - ${right})`);
          continue;
        }
      }
      if (t.isCallExpression(term) && t.isPropertyAccessExpression(term.expression) && term.expression.name.text === "localeCompare"
        && t.isPropertyAccessExpression(term.expression.expression) && term.arguments.length === 1) {
        const field = term.expression.expression.name.text;
        if (best.fields.find((entry) => entry.name === field)?.id && side(term.expression.expression) && side(term.arguments[0] as ts.Node)) {
          idTerms += 1;
          continue;
        }
      }
      this.diagnostics.push(`comparator of ${best.name}: term \`${term.getText(this.sourceFile)}\` is not a numeric field difference before id localeCompare terms`);
      return undefined;
    }
    if (numeric.length === 0) return undefined;
    return numeric.reduceRight((rest, term) => `(${term} !== 0 && ${term} === ${term} ? ${term} : ${rest})`);
  }

  // --- normalizations ---------------------------------------------------------------------------

  /** reduce → loop; [...a] → copy; read-only conditional/lookup array locals → explicit copy. */
  private normalizeDeclaration(declaration: ts.VariableDeclaration, symbol: ts.Symbol, nl: string): string | undefined {
    const t = this.t;
    const name = declaration.name.getText(this.sourceFile);
    const init = declaration.initializer;
    if (!init) return undefined;
    // const r = a.reduce((acc, x) => e, init)
    if (t.isCallExpression(init) && t.isPropertyAccessExpression(init.expression) && init.expression.name.text === "reduce" && init.arguments.length === 2) {
      const callback = init.arguments[0];
      if (callback && t.isArrowFunction(callback) && callback.parameters.length === 2 && !t.isBlock(callback.body)) {
        const accumulator = this.checker.getSymbolAtLocation(callback.parameters[0]?.name as ts.Node);
        const element = callback.parameters[1]?.name.getText(this.sourceFile);
        if (accumulator) this.renames.set(accumulator, name);
        const text = `let ${name} = ${this.print(init.arguments[1] as ts.Expression)};${nl}for (const ${element} of ${this.print(init.expression.expression)}) {${nl}  ${name} = ${this.print(callback.body)};${nl}}`;
        if (accumulator) this.renames.delete(accumulator);
        return text;
      }
    }
    // const x = ... a.reduce((acc, v) => e, init) ...  → reduce hoisted into a loop before the statement
    const nested: ts.CallExpression[] = [];
    const findReduce = (child: ts.Node): void => {
      if (t.isFunctionLike(child)) return;
      if (t.isCallExpression(child) && t.isPropertyAccessExpression(child.expression) && child.expression.name.text === "reduce") nested.push(child);
      child.forEachChild(findReduce);
    };
    findReduce(init);
    if (nested.length > 0) {
      const preamble: string[] = [];
      for (const call of nested) {
        const callback = call.arguments[0];
        if (call.arguments.length !== 2 || !callback || !t.isArrowFunction(callback) || callback.parameters.length !== 2 || t.isBlock(callback.body)) {
          this.diagnostics.push(`reduce at line ${this.line(call)} needs (acc, value) => expression and an initial value`);
          return undefined;
        }
        const temp = `__reduce${this.temp++}`;
        const accumulator = this.checker.getSymbolAtLocation(callback.parameters[0]?.name as ts.Node);
        if (accumulator) this.renames.set(accumulator, temp);
        preamble.push(`let ${temp} = ${this.print(call.arguments[1] as ts.Expression)};`, `for (const ${callback.parameters[1]?.name.getText(this.sourceFile)} of ${this.print((call.expression as ts.PropertyAccessExpression).expression)}) {`, `  ${temp} = ${this.print(callback.body)};`, "}");
        if (accumulator) this.renames.delete(accumulator);
        this.replacements.set(call, temp);
      }
      const statement = declaration.parent.parent;
      return [...preamble, this.printChildren(statement)].join(nl);
    }
    // const c = [...a]
    if (t.isArrayLiteralExpression(init) && init.elements.length === 1 && t.isSpreadElement(init.elements[0] as ts.Node)) {
      const source = (init.elements[0] as ts.SpreadElement).expression;
      return `const ${name}: number[] = [];${nl}for (const __value of ${this.print(source)}) {${nl}  ${name}.push(__value);${nl}}`;
    }
    // const s = cond ? a : b   (array type, read-only local) → explicit copy
    const type = this.checker.getTypeAtLocation(declaration.name);
    if (t.isConditionalExpression(init) && this.checker.isArrayType(type)) {
      if (this.references(symbol).some((use) => !this.isReadOnlyUse(use))) {
        this.diagnostics.push(`${name} at line ${this.line(declaration)} aliases arrays and is mutated or escapes`);
        return undefined;
      }
      return `const ${name}: number[] = [];${nl}${this.copyInto(name, init, nl)}`;
    }
    return undefined;
  }

  private copyInto(target: string, expression: ts.Expression, nl: string): string {
    const t = this.t;
    if (t.isParenthesizedExpression(expression)) return this.copyInto(target, expression.expression, nl);
    if (t.isConditionalExpression(expression)) {
      return `if (${this.print(expression.condition)}) {${nl}  ${this.copyInto(target, expression.whenTrue, `${nl}  `)}${nl}} else {${nl}  ${this.copyInto(target, expression.whenFalse, `${nl}  `)}${nl}}`;
    }
    if (t.isBinaryExpression(expression) && expression.operatorToken.kind === t.SyntaxKind.QuestionQuestionToken && t.isCallExpression(expression.left)
      && t.isPropertyAccessExpression(expression.left.expression) && t.isIdentifier(expression.left.expression.expression)) {
      const map = this.mapOf(expression.left.expression.expression);
      if (map?.kind === "list" && t.isArrayLiteralExpression(expression.right) && expression.right.elements.length === 0) {
        const key = this.print(expression.left.arguments[0] as ts.Expression);
        // Index loop: a for-of over a nested element would bind a (read-only) alias of fresh storage.
        const slot = `__slot${this.temp++}`;
        return `if (${map.name}__has[${key}]) {${nl}  for (let ${slot} = 0; ${slot} < ${map.name}__value[${key}].length; ${slot}++) {${nl}    ${target}.push(${map.name}__value[${key}][${slot}]);${nl}  }${nl}}`;
      }
    }
    return `for (const __value of ${this.print(expression)}) {${nl}  ${target}.push(__value);${nl}}`;
  }

  private isReadOnlyUse(use: ts.Identifier): boolean {
    const t = this.t;
    const parent = use.parent;
    if (t.isPropertyAccessExpression(parent) && parent.expression === use) return ["length", "reduce"].includes(parent.name.text);
    if (t.isElementAccessExpression(parent) && parent.expression === use) return !(t.isBinaryExpression(parent.parent) && parent.parent.left === parent);
    if (t.isCallExpression(parent)) return true; // passed to a (pure, lowered) helper
    if (t.isConditionalExpression(parent)) return true;
    if (t.isForOfStatement(parent)) return true;
    return false;
  }

  /** Same-file helpers called by the function, normalized (they must not touch ids). */
  private helpers(): string[] {
    const t = this.t;
    const found = new Map<string, ts.FunctionDeclaration>();
    const visit = (node: ts.Node): void => {
      if (t.isCallExpression(node) && t.isIdentifier(node.expression)) {
        const declaration = this.checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
        if (declaration && t.isFunctionDeclaration(declaration) && declaration.getSourceFile() === this.sourceFile && declaration.body && declaration !== this.fn) {
          found.set(node.expression.text, declaration);
        }
      }
      node.forEachChild(visit);
    };
    visit(this.fn.body as ts.Block);
    return [...found.values()].map((helper) => {
      const body = (helper.body as ts.Block).statements.map((statement) => this.print(statement)).join("\n");
      const signature = helper.getText(this.sourceFile).slice(0, (helper.body as ts.Block).getStart(this.sourceFile) - helper.getStart(this.sourceFile));
      return `${signature}{\n${indent(body, this.column((helper.body as ts.Block).statements[0]), "  ")}\n}`;
    });
  }

  // --- call-site batching and upstream sealing ----------------------------------------------------

  private patchCallSites(integrationImport: string, patchedFile: string): { text: string; diagnostics: string[] } {
    const t = this.t;
    const diagnostics: string[] = [];
    const name = this.fn.name?.text ?? "";
    const self = this.fn.name ? this.checker.getSymbolAtLocation(this.fn.name) : undefined;
    const membersPosition = this.fn.parameters.findIndex((parameter) => parameter.name.getText(this.sourceFile) === this.members);
    const graphPosition = this.fn.parameters.findIndex((parameter) => parameter.name.getText(this.sourceFile) === this.graph);
    const edits: Edit[] = [];
    const sealed = new Set<ts.Symbol>();
    let batchIndex = 0;
    const visit = (node: ts.Node): void => {
      if (t.isCallExpression(node) && t.isIdentifier(node.expression) && self && this.checker.getSymbolAtLocation(node.expression) === self
        && node.parent !== this.fn) {
        const site = this.batchSite(node, membersPosition, graphPosition);
        if (typeof site === "string") {
          diagnostics.push(`call at line ${this.line(node)}: ${site}`);
        } else {
          const batch = `__${name}Batch${batchIndex++}`;
          const indentText = " ".repeat(this.column(site.statement));
          edits.push({
            start: site.statement.getStart(this.sourceFile),
            end: site.statement.getStart(this.sourceFile),
            text: `const ${batch} = __cranktsBatch.${name}Batch(${name}, ${site.groups.getText(this.sourceFile)}, ${site.graph.getText(this.sourceFile)});\n${indentText}`,
          });
          edits.push({ start: node.getStart(this.sourceFile), end: node.getEnd(), text: `(${batch}[${site.index}] as ReturnType<typeof ${name}>)` });
          const graphSymbol = this.checker.getSymbolAtLocation(site.graph);
          if (graphSymbol && !sealed.has(graphSymbol)) {
            sealed.add(graphSymbol);
            const seal = this.sealPoint(graphSymbol, site.call);
            if (typeof seal === "string") {
              diagnostics.push(`graph ${site.graph.text} is not sealed (per-call packing instead): ${seal}`);
            } else {
              edits.push({ start: seal.getEnd(), end: seal.getEnd(), text: `\n${" ".repeat(this.column(seal))}__cranktsBatch.sealGraph(${site.graph.text});` });
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(this.sourceFile);
    if (batchIndex === 0) diagnostics.push(`no batchable call of ${name} found`);
    const header = `// Generated by CrankTS: patched copy that batches ${name}() calls into one packed kernel call. Do not edit.\nimport * as __cranktsBatch from "${integrationImport}";\n`;
    return {
      text: header + applyEdits(this.sourceFile.text, [
        ...edits,
        ...relativeImportEdits(this.sourceFile, dirname(this.sourceFile.fileName), dirname(patchedFile), { t }),
      ]),
      diagnostics,
    };
  }

  /** `GROUPS.map((group, index) => ... f(group, G) ...)` with GROUPS and G bound before the statement. */
  private batchSite(call: ts.CallExpression, membersPosition: number, graphPosition: number):
    { statement: ts.Statement; groups: ts.Identifier; graph: ts.Identifier; index: string; call: ts.CallExpression } | string {
    const t = this.t;
    const membersArgument = call.arguments[membersPosition];
    const graph = call.arguments[graphPosition];
    if (call.arguments.length !== this.fn.parameters.length || !membersArgument || !graph || !t.isIdentifier(membersArgument) || !t.isIdentifier(graph)) {
      return "arguments must be plain identifiers";
    }
    // The nearest enclosing `GROUPS.map(callback)`; callbacks in between (e.g. a timing wrapper) are fine:
    // the call is pure, so computing it ahead of them changes nothing but where its time is spent.
    const isMapCallback = (node: ts.Node): boolean => {
      const parent = node.parent;
      return (t.isArrowFunction(node) || t.isFunctionExpression(node)) && t.isCallExpression(parent) && parent.arguments[0] === node
        && t.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "map" && t.isIdentifier(parent.expression.expression);
    };
    let callback: ts.Node | undefined = call.parent;
    while (callback && !isMapCallback(callback) && callback !== this.sourceFile) callback = callback.parent;
    if (!callback || !(t.isArrowFunction(callback) || t.isFunctionExpression(callback))) return "not inside a `GROUPS.map(...)` callback";
    const mapCall = callback.parent as ts.CallExpression;
    if (!t.isPropertyAccessExpression(mapCall.expression) || !t.isIdentifier(mapCall.expression.expression)) return "unreachable";
    const groups = mapCall.expression.expression;
    const [groupParameter, indexParameter] = callback.parameters;
    if (!groupParameter || !indexParameter || !t.isIdentifier(groupParameter.name) || !t.isIdentifier(indexParameter.name)
      || this.checker.getSymbolAtLocation(membersArgument) !== this.checker.getSymbolAtLocation(groupParameter.name)) {
      return "the group argument must be the map callback's element, and the callback must take the index";
    }
    const groupsSymbol = this.checker.getSymbolAtLocation(groups);
    const callbackBody = callback.body;
    if (groupsSymbol && this.referencesIn(groupsSymbol, callbackBody).length > 0) return `${groups.text} is referenced inside the callback`;
    let statement: ts.Node = mapCall;
    while (statement.parent && !t.isBlock(statement.parent) && !t.isSourceFile(statement.parent)) statement = statement.parent;
    for (const bound of [groups, graph]) {
      const declaration = this.checker.getSymbolAtLocation(bound)?.valueDeclaration;
      if (!declaration || declaration.getEnd() > statement.getStart(this.sourceFile) || isWithin(declaration, callback)) {
        return `${bound.text} must be bound before the statement that maps the groups`;
      }
    }
    // Hoisting moves the call before the statement: inside it, neither the graph nor a group may change.
    const graphSymbol = this.checker.getSymbolAtLocation(graph);
    for (const use of graphSymbol ? this.referencesIn(graphSymbol, statement) : []) {
      if (use.parent === call) continue;
      const contextual = this.checker.getContextualType(use);
      if (!t.isCallExpression(use.parent) || !/^ReadonlyMap<.*ReadonlySet</.test(contextual ? this.checker.typeToString(contextual) : "")) {
        return `${graph.text} is used at line ${this.line(use)} inside the batched statement other than as a ReadonlyMap argument`;
      }
    }
    const groupSymbol = this.checker.getSymbolAtLocation(groupParameter.name);
    for (const use of groupSymbol ? this.referencesIn(groupSymbol, callbackBody) : []) {
      if (!this.isNonMutatingArrayUse(use, call)) return `group ${groupParameter.name.text} may be mutated at line ${this.line(use)}`;
    }
    return { statement: statement as ts.Statement, groups, graph, index: indexParameter.name.text, call };
  }

  private isNonMutatingArrayUse(use: ts.Identifier, call: ts.CallExpression): boolean {
    const t = this.t;
    const parent = use.parent;
    if (parent === call) return true;
    if (t.isPropertyAccessExpression(parent) && parent.expression === use) {
      return ["length", "at", "concat", "entries", "every", "filter", "find", "findIndex", "flatMap", "forEach", "includes", "indexOf",
        "join", "keys", "map", "reduce", "slice", "some", "values"].includes(parent.name.text);
    }
    if (t.isElementAccessExpression(parent) && parent.expression === use) {
      return !(t.isBinaryExpression(parent.parent) && parent.parent.left === parent && parent.parent.operatorToken.kind >= t.SyntaxKind.FirstAssignment && parent.parent.operatorToken.kind <= t.SyntaxKind.LastAssignment);
    }
    if (t.isForOfStatement(parent) && parent.expression === use) return true;
    // Escapes into the callback's result happen after the call: they cannot change its input.
    return t.isShorthandPropertyAssignment(parent) || (t.isPropertyAssignment(parent) && parent.initializer === use);
  }

  /**
   * The statement after which G is never mutated again: G is a const binding whose later references are
   * readonly-typed arguments or the batched call; in its initializer, graph-typed locals are only built
   * (`new Map`, `.get(k)?.add(v)`) and returned, so no other alias of G or its sets survives the statement.
   */
  private sealPoint(graph: ts.Symbol, batched: ts.CallExpression): ts.Statement | string {
    const t = this.t;
    const declaration = graph.valueDeclaration;
    if (!declaration) return "no declaration";
    let statement: ts.Node = declaration;
    while (statement.parent && !t.isBlock(statement.parent)) statement = statement.parent;
    if (!t.isVariableStatement(statement) || !(statement.declarationList.flags & t.NodeFlags.Const)) return "must be a const binding";
    const scope = statement.parent;
    for (const use of this.referencesIn(graph, scope)) {
      if (isWithin(use, statement) || use.parent === batched) continue;
      const contextual = this.checker.getContextualType(use as ts.Expression);
      const text = contextual ? this.checker.typeToString(contextual) : "";
      if (!t.isCallExpression(use.parent) || !/^ReadonlyMap<.*ReadonlySet</.test(text)) {
        return `reference at line ${this.line(use)} is not a ReadonlyMap<_, ReadonlySet<_>> argument`;
      }
    }
    const graphLocals = new Set<ts.Symbol>();
    const collect = (node: ts.Node): void => {
      if (t.isVariableDeclaration(node) && t.isIdentifier(node.name)) {
        const symbol = this.checker.getSymbolAtLocation(node.name);
        const type = symbol ? this.checker.typeToString(this.checker.getTypeAtLocation(node.name)) : "";
        if (symbol && /^Map<\w+, Set<\w+>>$/.test(type)) graphLocals.add(symbol);
      }
      node.forEachChild(collect);
    };
    collect(statement);
    for (const local of graphLocals) {
      if (local === graph) continue;
      for (const use of this.referencesIn(local, statement)) {
        const parent = use.parent;
        const builds = t.isPropertyAccessExpression(parent) && parent.name.text === "get" && t.isCallExpression(parent.parent)
          && t.isPropertyAccessExpression(parent.parent.parent) && parent.parent.parent.questionDotToken !== undefined
          && ["add", "has"].includes(parent.parent.parent.name.text);
        const returned = t.isShorthandPropertyAssignment(parent) && t.isObjectLiteralExpression(parent.parent) && t.isReturnStatement(parent.parent.parent);
        if (!builds && !returned) return `local graph ${local.getName()} escapes at line ${this.line(use)}`;
      }
    }
    return statement;
  }

  private referencesIn(symbol: ts.Symbol, scope: ts.Node): ts.Identifier[] {
    const found: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (this.t.isIdentifier(node) && this.checker.getSymbolAtLocation(node) === symbol
        && !(symbol.valueDeclaration && (node.parent === symbol.valueDeclaration))) found.push(node);
      node.forEachChild(visit);
    };
    visit(scope);
    return found;
  }

  // --- output -----------------------------------------------------------------------------------

  private outputFields(literal: ts.ObjectLiteralExpression): BatchOutputField[] {
    const t = this.t;
    return literal.properties.map((property): BatchOutputField => {
      const name = property.name?.getText(this.sourceFile) ?? "";
      const value = t.isPropertyAssignment(property) ? property.initializer : undefined;
      if (value && t.isBinaryExpression(value) && value.operatorToken.kind === t.SyntaxKind.QuestionQuestionToken
        && t.isElementAccessExpression(value.left) && t.isIdentifier(value.left.expression)) {
        const symbol = this.checker.getSymbolAtLocation(value.left.expression);
        const best = symbol ? this.bests.get(symbol) : undefined;
        if (best) return { name, kind: "bestOrNull", fields: best.fields, comparator: best.comparator?.getText(this.sourceFile) ?? "" };
      }
      return { name, kind: "number" };
    });
  }

  private outputCode(literal: ts.ObjectLiteralExpression, output: readonly BatchOutputField[]): string {
    const t = this.t;
    const lines: string[] = [];
    literal.properties.forEach((property, index) => {
      const field = output[index];
      if (field?.kind === "bestOrNull") {
        const value = (property as ts.PropertyAssignment).initializer as ts.BinaryExpression;
        const best = this.bests.get(this.checker.getSymbolAtLocation((value.left as ts.ElementAccessExpression).expression) as ts.Symbol) as BestList;
        const first = best.fields[0] as BatchField;
        lines.push(`__out.push(${best.name}__ties_${first.name}.length);`,
          `for (let __tie = 0; __tie < ${best.name}__ties_${first.name}.length; __tie++) {`,
          ...best.fields.map((entry) => `  __out.push(${best.name}__ties_${entry.name}[__tie]);`),
          "}");
      } else if (t.isPropertyAssignment(property)) {
        lines.push(`__out.push(${this.print(property.initializer)});`);
      } else if (t.isShorthandPropertyAssignment(property)) {
        lines.push(`__out.push(${this.print(property.name)});`);
      } else {
        this.diagnostics.push("return properties must be plain assignments");
      }
    });
    return lines.join("\n");
  }

  // --- helpers ----------------------------------------------------------------------------------

  private graphLookup(node: ts.Node): { key: ts.Expression } | undefined {
    const t = this.t;
    let expression = node;
    while (t.isParenthesizedExpression(expression)) expression = expression.expression;
    if (t.isBinaryExpression(expression) && expression.operatorToken.kind === t.SyntaxKind.QuestionQuestionToken
      && t.isArrayLiteralExpression(expression.right) && expression.right.elements.length === 0
      && t.isCallExpression(expression.left) && t.isPropertyAccessExpression(expression.left.expression)
      && expression.left.expression.name.text === "get" && expression.left.expression.expression.getText(this.sourceFile) === this.graph) {
      return { key: expression.left.arguments[0] as ts.Expression };
    }
    return undefined;
  }

  private mapOf(identifier: ts.Identifier): { name: string; kind: MapKind } | undefined {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    return symbol ? this.maps.get(symbol) : undefined;
  }

  private isOptionalId(node: ts.Node): boolean {
    const t = this.t;
    if (t.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      return symbol !== undefined && this.optionalIds.has(symbol);
    }
    return t.isCallExpression(node) && t.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get"
      && t.isIdentifier(node.expression.expression) && this.mapOf(node.expression.expression)?.kind === "id";
  }

  private isGuardedFalsy(node: ts.Node): boolean {
    const t = this.t;
    if (!t.isPrefixUnaryExpression(node) || node.operator !== t.SyntaxKind.ExclamationToken || !t.isIdentifier(node.operand)) return false;
    const symbol = this.checker.getSymbolAtLocation(node.operand);
    return symbol !== undefined && this.nonEmptyIds.has(symbol);
  }

  private inFinalReturn(node: ts.Node): boolean {
    const statements = (this.fn.body as ts.Block).statements;
    const last = statements[statements.length - 1];
    return last !== undefined && isWithin(node, last);
  }

  private checkNoEarlyReturn(statements: readonly ts.Statement[]): void {
    const t = this.t;
    const visit = (node: ts.Node): void => {
      if (t.isReturnStatement(node)) this.diagnostics.push(`early return at line ${this.line(node)} cannot be batched`);
      if (t.isFunctionLike(node)) return;
      node.forEachChild(visit);
    };
    statements.forEach(visit);
  }

  private references(symbol: ts.Symbol): ts.Identifier[] {
    const found: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (this.t.isIdentifier(node) && node.parent !== symbol.valueDeclaration && this.checker.getSymbolAtLocation(node) === symbol) found.push(node);
      node.forEachChild(visit);
    };
    if (this.fn.body) visit(this.fn.body);
    return found;
  }

  private line(node: ts.Node): number {
    return this.sourceFile.getLineAndCharacterOfPosition(node.getStart(this.sourceFile)).line + 1;
  }

  private column(node: ts.Node | undefined): number {
    return node ? this.sourceFile.getLineAndCharacterOfPosition(node.getStart(this.sourceFile)).character : 0;
  }
}

function isWithin(node: ts.Node, container: ts.Node): boolean {
  return node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd();
}

function indent(text: string, column: number, prefix: string): string {
  return text.split("\n").map((line, index) => {
    if (index === 0) return `${prefix}${line}`;
    const leading = line.length - line.trimStart().length;
    return line.trim().length === 0 ? "" : `${prefix}${line.slice(Math.min(column, leading))}`;
  }).join("\n");
}
