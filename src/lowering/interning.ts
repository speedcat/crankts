import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type * as ts from "typescript";
import { collectFunctions } from "../analysis/functions.js";
import { createCompilerFacade } from "../compiler/compiler-facade.js";
import { sealedGraphRuntime } from "./sealed-graph.js";
import { applyEdits, relativeImportEdits, type Edit } from "./region.js";

/**
 * Id-domain representation pass (v0.2.6). Rewrites a function that works on string ids (a type alias
 * such as `FunctionId`) into a packed function over dense integer indices, as TypeScript source:
 *
 *   universe `readonly T[]` (iterated, only `.id` read)     → its length; ids are interned in this order
 *   graph `ReadonlyMap<Id, ReadonlySet<Id>>` (`get(x) ?? []`) → CSR `offsets`/`neighbors` (Set insertion order)
 *   entity lookup `ReadonlyMap<Id, T>` used only by a sort  → a precomputed dense `rank` over the universe
 *   `new Set<Id>()` (has/add only)                          → `boolean[]` of universe size
 *   `Id[]` locals                                            → `number[]` of indices
 *   `Id[][]` result built by `push`                          → flat [count, (length, indices...)*]
 *
 * The packed function is the "transformed TypeScript" variant and lowers to the Kernel IR like any
 * kernel. Pack/unpack adapters (also generated) intern the ids, build the CSR and ranks, and check every
 * assumption at runtime (unique non-empty ids, closed graph, complete entity lookup, finite sort keys);
 * a failed check means "run the original function". Every rule has explicit preconditions; any use of
 * an id-typed value no rule covers is a diagnostic, and the pass fails closed.
 */

export interface InternRequest {
  readonly file: string;
  readonly function: string;
  /** The id type alias, e.g. `FunctionId`. */
  readonly alias: string;
}

export type ParamRole =
  | { readonly role: "universe"; readonly name: string }
  | { readonly role: "graph"; readonly name: string }
  | { readonly role: "entityRank"; readonly name: string }
  | { readonly role: "value"; readonly name: string; readonly sourceType: string };

export interface InternPlan {
  readonly function: string;
  readonly packedName: string;
  readonly params: readonly ParamRole[];
  readonly output: "idArrays" | "idArray" | "value";
  /** The packed function (TypeScript in the Kernel IR subset). */
  readonly packedFunction: string;
  /** `pack(...originalArgs)` and `unpack(result, ids)` adapters plus guards. */
  readonly adapters: string;
  /** Packed parameter names in order, and which of them form the CSR graph. */
  readonly packedParams: readonly string[];
  readonly graph?: { readonly offsets: string; readonly neighbors: string };
  readonly guards: readonly string[];
  /** Type-only imports of the original file (specifier, text), for the adapters module. */
  readonly typeImports: readonly { readonly specifier: string; readonly text: string }[];
  /** Absolute directory of the original file, to re-point relative type imports. */
  readonly sourceDirectory: string;
  /** Entity fields the comparator reads (for generated parity inputs). */
  readonly entityFields: readonly { readonly field: string; readonly kind: "locale" | "numeric" }[];
  /** The original file with every call of the function routed through `__crankts.<name>(<name>, ...)`. */
  readonly patchedSource: (integrationImport: string, patchedFile: string) => string;
}

export type InternResult =
  | { readonly ok: true; readonly plan: InternPlan }
  | { readonly ok: false; readonly diagnostics: readonly string[] };

export function planInterning(request: InternRequest): InternResult {
  // Real path: the compiler reports real paths (e.g. /private/tmp on macOS for /tmp).
  const file = realpathSync(resolve(request.file));
  const facade = createCompilerFacade(file);
  const definition = collectFunctions(facade).definitions.find((candidate) => candidate.absoluteFile === file && candidate.name === request.function);
  const fn = definition?.node;
  if (!definition || !fn?.body || !definition.compilerFacade.typescript.isFunctionDeclaration(fn) || !definition.compilerFacade.typescript.isBlock(fn.body)) {
    return { ok: false, diagnostics: [`no function declaration ${request.function} with a body in ${file}`] };
  }
  return new InternPass(definition.compilerFacade.typescript, definition.compilerFacade.checker, definition.sourceFile, fn, request.alias).run();
}

const ALIAS_PLACEHOLDER = "__ALIAS__";

class InternPass {
  private readonly diagnostics: string[] = [];
  private readonly roles = new Map<string, ParamRole>();
  /** Locals rewritten to indices or index collections, by symbol. */
  private readonly idSets = new Set<ts.Symbol>();
  private readonly idValues = new Set<ts.Symbol>();
  private readonly idArrays = new Set<ts.Symbol>();
  private readonly universeElements = new Set<ts.Symbol>();
  private readonly guardedPops = new Set<ts.Symbol>();
  private comparator: { readonly param: string; readonly text: string; readonly keys: readonly { field: string; kind: "locale" | "numeric" }[] } | undefined;
  private result: ts.Symbol | undefined;
  private universe: string | undefined;
  private slotCounter = 0;
  private readonly guards: string[] = [];

  constructor(
    private readonly t: typeof ts,
    private readonly checker: ts.TypeChecker,
    private readonly sourceFile: ts.SourceFile,
    private readonly fn: ts.FunctionDeclaration,
    private readonly alias: string,
  ) {}

  run(): InternResult {
    const name = this.fn.name?.text ?? "anonymous";
    this.inferParamRoles();
    this.inferLocals();
    const returnType = this.fn.type?.getText(this.sourceFile) ?? "";
    const output = this.isAliasArrayArray(returnType) ? "idArrays" : this.isAliasArray(returnType) ? "idArray" : "value";
    if (output === "idArray") {
      this.diagnostics.push("returning a flat id array is not supported yet");
    }
    const body = this.fn.body as ts.Block;
    const bodyText = body.statements.map((statement) => this.print(statement)).join("\n");
    if (this.diagnostics.length > 0) {
      return { ok: false, diagnostics: this.diagnostics };
    }

    const packedParams: string[] = [];
    let graph: { offsets: string; neighbors: string } | undefined;
    for (const role of this.roles.values()) {
      if (role.role === "universe") packedParams.push(`${role.name}__count: number`);
      if (role.role === "graph") {
        packedParams.push(`${role.name}__offsets: Uint32Array`, `${role.name}__neighbors: Uint32Array`);
        graph = { offsets: `${role.name}__offsets`, neighbors: `${role.name}__neighbors` };
      }
      if (role.role === "entityRank") packedParams.push(`${role.name}__rank: Uint32Array`);
      if (role.role === "value") packedParams.push(`${role.name}: ${role.sourceType}`);
    }
    const packedName = `${name}__packed`;
    const packedReturn = output === "idArrays" ? "number[]" : returnType;
    const packedFunction = `export function ${packedName}(\n${packedParams.map((param) => `  ${param},`).join("\n")}\n): ${packedReturn} {\n${indent(bodyText, this.column(body.statements[0]))}\n}`;
    if (packedFunction.includes(this.alias)) {
      return { ok: false, diagnostics: [`the packed function still mentions ${this.alias}; some id use is not covered by a rewrite rule`] };
    }
    return {
      ok: true,
      plan: {
        function: name,
        packedName,
        params: [...this.roles.values()],
        output,
        packedFunction,
        adapters: this.adapters(name, packedParams.map((param) => param.split(":")[0] as string), output),
        packedParams: packedParams.map((param) => param.split(":")[0] as string),
        ...(graph ? { graph } : {}),
        guards: this.guards,
        typeImports: this.sourceFile.statements.flatMap((statement) => (
          this.t.isImportDeclaration(statement) && statement.importClause?.isTypeOnly && this.t.isStringLiteral(statement.moduleSpecifier)
            ? [{ specifier: statement.moduleSpecifier.text, text: statement.getText(this.sourceFile) }]
            : []
        )),
        sourceDirectory: dirname(this.sourceFile.fileName),
        entityFields: this.comparator?.keys ?? [],
        patchedSource: (integrationImport, patchedFile) => this.patchCallers(name, integrationImport, patchedFile),
      },
    };
  }

  // --- roles ------------------------------------------------------------------------------------

  private inferParamRoles(): void {
    const t = this.t;
    for (const parameter of this.fn.parameters) {
      if (!t.isIdentifier(parameter.name)) {
        this.diagnostics.push("destructured parameters are not supported");
        continue;
      }
      const name = parameter.name.text;
      const typeText = parameter.type?.getText(this.sourceFile) ?? "";
      const symbol = this.checker.getSymbolAtLocation(parameter.name);
      const uses = symbol ? this.references(symbol) : [];
      if (new RegExp(`^(Readonly)?Map<${this.alias},\\s*(Readonly)?Set<${this.alias}>>$`).test(typeText)) {
        this.roles.set(name, { role: "graph", name });
        const ok = uses.every((use) => this.graphLookup(use) !== undefined && this.t.isForOfStatement(this.graphLookupStatement(use)));
        if (!ok) this.diagnostics.push(`graph parameter ${name} must be used only as \`for (const x of ${name}.get(id) ?? [])\``);
      } else if (new RegExp(`^(Readonly)?Map<${this.alias},`).test(typeText)) {
        this.roles.set(name, { role: "entityRank", name });
        const ok = uses.every((use) => this.enclosingSortComparator(use) !== undefined);
        if (!ok) this.diagnostics.push(`entity lookup ${name} must be used only inside a sort comparator`);
      } else if (/^(readonly\s+)?\w+\[\]$/.test(typeText) && this.hasIdProperty(parameter)) {
        this.universe = name;
        this.roles.set(name, { role: "universe", name });
      } else if (typeText.includes(this.alias)) {
        this.diagnostics.push(`parameter ${name}: ${typeText} has no packing rule yet`);
      } else {
        this.roles.set(name, { role: "value", name, sourceType: typeText });
      }
    }
    if (!this.universe) {
      this.diagnostics.push("no universe parameter (an array of entities with an id property) to intern ids from");
    }
  }

  /** Locals: id sets, id arrays, and the values flowing through them. */
  private inferLocals(): void {
    const t = this.t;
    const visit = (node: ts.Node): void => {
      if (t.isForOfStatement(node) && t.isIdentifier(node.expression) && node.expression.text === this.universe) {
        const declaration = this.loopDeclaration(node);
        const symbol = declaration ? this.checker.getSymbolAtLocation(declaration.name) : undefined;
        if (symbol && this.references(symbol).every((use) => t.isPropertyAccessExpression(use.parent) && use.parent.name.text === "id")) {
          this.universeElements.add(symbol);
        } else {
          this.diagnostics.push(`universe elements may only be used as \`.id\` (line ${this.line(node)})`);
        }
      }
      if (t.isVariableDeclaration(node) && t.isIdentifier(node.name)) {
        const symbol = this.checker.getSymbolAtLocation(node.name);
        const typeText = node.type?.getText(this.sourceFile) ?? "";
        const init = node.initializer;
        if (symbol && init && t.isNewExpression(init) && t.isIdentifier(init.expression) && init.expression.text === "Set"
          && init.typeArguments?.[0]?.getText(this.sourceFile) === this.alias && (init.arguments?.length ?? 0) === 0) {
          const ok = this.references(symbol).every((use) => this.setOperation(use) !== undefined);
          if (!ok) this.diagnostics.push(`id set ${node.name.text} may only be used with has()/add()`);
          this.idSets.add(symbol);
        } else if (symbol && (this.isAliasArray(typeText) || this.isAliasArrayArray(typeText))) {
          this.idArrays.add(symbol);
        } else if (symbol && init && t.isArrayLiteralExpression(init) && init.elements.length > 0 && init.elements.every((element) => this.isIdExpression(element))) {
          this.idArrays.add(symbol);
        } else if (symbol && init && t.isCallExpression(init) && t.isPropertyAccessExpression(init.expression) && init.expression.name.text === "pop"
          && t.isIdentifier(init.expression.expression)) {
          const arraySymbol = this.checker.getSymbolAtLocation(init.expression.expression);
          if (arraySymbol && this.idArrays.has(arraySymbol)) {
            this.idValues.add(symbol);
            if (this.isGuardedPop(node, init.expression.expression.text)) this.guardedPops.add(symbol);
            else this.diagnostics.push(`pop() of ${init.expression.expression.text} at line ${this.line(node)} must be the first statement of a \`while (${init.expression.expression.text}.length > 0)\` body`);
          }
        }
      }
      if (t.isForOfStatement(node) && this.graphLookup(node.expression)) {
        const declaration = this.loopDeclaration(node);
        const symbol = declaration ? this.checker.getSymbolAtLocation(declaration.name) : undefined;
        if (symbol) this.idValues.add(symbol);
      }
      if (t.isForOfStatement(node) && t.isIdentifier(node.expression)) {
        const iterated = this.checker.getSymbolAtLocation(node.expression);
        const declaration = this.loopDeclaration(node);
        const symbol = declaration ? this.checker.getSymbolAtLocation(declaration.name) : undefined;
        if (iterated && symbol && this.idArrays.has(iterated)) this.idValues.add(symbol);
      }
      node.forEachChild(visit);
    };
    visit(this.fn.body as ts.Block);
    // The function's result, when it is an id-array-of-arrays local returned at the end.
    const statements = (this.fn.body as ts.Block).statements;
    const last = statements[statements.length - 1];
    if (last && t.isReturnStatement(last) && last.expression && t.isIdentifier(last.expression)) {
      const symbol = this.checker.getSymbolAtLocation(last.expression);
      const declaration = symbol?.valueDeclaration;
      if (symbol && declaration && t.isVariableDeclaration(declaration) && this.isAliasArrayArray(declaration.type?.getText(this.sourceFile) ?? "")) {
        this.result = symbol;
      }
    }
  }

  // --- printing with rewrites -------------------------------------------------------------------

  /** Prints `node`, applying rewrite rules; untouched text is copied verbatim. */
  private print(node: ts.Node): string {
    const rewritten = this.rewrite(node);
    if (rewritten !== undefined) {
      return rewritten;
    }
    const start = node.getStart(this.sourceFile);
    let text = "";
    let cursor = start;
    for (const child of node.getChildren(this.sourceFile)) {
      if (child.kind === this.t.SyntaxKind.EndOfFileToken) continue;
      const childStart = child.getStart(this.sourceFile);
      text += this.sourceFile.text.slice(cursor, childStart) + this.print(child);
      cursor = child.getEnd();
    }
    return text + this.sourceFile.text.slice(cursor, node.getEnd());
  }

  private rewrite(node: ts.Node): string | undefined {
    const t = this.t;
    // Universe loop: for (const e of universe) → for (let e = 0; e < universe__count; e++)
    if (t.isForOfStatement(node) && t.isIdentifier(node.expression) && node.expression.text === this.universe) {
      const declaration = this.loopDeclaration(node);
      const name = declaration?.name.getText(this.sourceFile) ?? "__element";
      return `for (let ${name} = 0; ${name} < ${this.universe}__count; ${name}++) ${this.print(node.statement)}`;
    }
    // e.id on a universe element → the element's index
    if (t.isPropertyAccessExpression(node) && node.name.text === "id" && t.isIdentifier(node.expression)) {
      const symbol = this.checker.getSymbolAtLocation(node.expression);
      if (symbol && this.universeElements.has(symbol)) return node.expression.text;
    }
    // Graph iteration: for (const y of G.get(x) ?? []) → CSR slice
    if (t.isForOfStatement(node)) {
      const lookup = this.graphLookup(node.expression);
      const declaration = this.loopDeclaration(node);
      if (lookup && declaration && t.isBlock(node.statement)) {
        const slot = `__slot${this.slotCounter++}`;
        const key = this.print(lookup.key);
        const body = this.print(node.statement);
        const open = body.indexOf("{");
        return `for (let ${slot} = ${lookup.graph}__offsets[${key}]; ${slot} < ${lookup.graph}__offsets[${key} + 1]; ${slot}++) {`
          + `${this.newline(node)}  const ${declaration.name.getText(this.sourceFile)} = ${lookup.graph}__neighbors[${slot}];${body.slice(open + 1)}`;
      }
    }
    // Id set: new Set<Id>() → boolean bitmap; has/add → index
    if (t.isNewExpression(node) && t.isIdentifier(node.expression) && node.expression.text === "Set" && node.typeArguments?.[0]?.getText(this.sourceFile) === this.alias) {
      return `new Array<boolean>(${this.universe}__count).fill(false)`;
    }
    if (t.isCallExpression(node)) {
      const operation = this.setOperation(node.expression.kind === t.SyntaxKind.PropertyAccessExpression ? (node.expression as ts.PropertyAccessExpression).expression : node);
      if (operation && operation.call === node) {
        const argument = this.print(node.arguments[0] as ts.Expression);
        return operation.method === "has" ? `${operation.set}[${argument}]` : `${operation.set}[${argument}] = true`;
      }
    }
    // Guarded pop: const x = a.pop(); → const x = a[a.length - 1]; a.pop();
    if (t.isVariableStatement(node)) {
      const declaration = node.declarationList.declarations[0];
      const symbol = declaration && t.isIdentifier(declaration.name) ? this.checker.getSymbolAtLocation(declaration.name) : undefined;
      if (symbol && this.guardedPops.has(symbol) && declaration?.initializer && t.isCallExpression(declaration.initializer)) {
        const array = (declaration.initializer.expression as ts.PropertyAccessExpression).expression.getText(this.sourceFile);
        return `const ${declaration.name.getText(this.sourceFile)} = ${array}[${array}.length - 1];${this.newline(node)}${array}.pop();`;
      }
    }
    // `!x || rest` / `!x` on a guarded pop: ids are guarded non-empty and the pop non-empty, so `!x` is false.
    if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.BarBarToken && this.isGuardedFalsy(node.left)) {
      return this.print(node.right);
    }
    if (this.isGuardedFalsy(node)) {
      return "false";
    }
    // Sort with an entity-lookup comparator → sort by precomputed rank
    if (t.isCallExpression(node) && t.isPropertyAccessExpression(node.expression) && node.expression.name.text === "sort") {
      const comparator = node.arguments[0];
      const lookup = comparator ? this.comparatorLookup(comparator) : undefined;
      if (comparator && lookup && (t.isArrowFunction(comparator) || t.isFunctionExpression(comparator))) {
        const [left, right] = comparator.parameters.map((parameter) => parameter.name.getText(this.sourceFile));
        this.recordComparator(lookup, comparator);
        return `${this.print(node.expression.expression)}.sort((${left}, ${right}) => ${lookup}__rank[${left}] - ${lookup}__rank[${right}])`;
      }
    }
    // Result: Id[][] declaration → flat number[]; result.push(ids) → flat append
    if (t.isVariableDeclaration(node) && this.result && t.isIdentifier(node.name) && this.checker.getSymbolAtLocation(node.name) === this.result) {
      return `${node.name.text}: number[] = [0]`;
    }
    if (t.isExpressionStatement(node) && t.isCallExpression(node.expression) && t.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text === "push" && t.isIdentifier(node.expression.expression.expression)
      && this.result && this.checker.getSymbolAtLocation(node.expression.expression.expression) === this.result) {
      const target = node.expression.expression.expression.text;
      const value = node.expression.arguments[0];
      if (node.expression.arguments.length !== 1 || !value || !t.isIdentifier(value)) {
        this.diagnostics.push(`result pushes must append one id-array local (line ${this.line(node)})`);
        return undefined;
      }
      const nl = this.newline(node);
      return `${target}[0] += 1;${nl}${target}.push(${value.text}.length);${nl}for (const __member of ${value.text}) {${nl}  ${target}.push(__member);${nl}}`;
    }
    // Type annotations mentioning the alias → number
    if (t.isTypeReferenceNode(node) && node.typeName.getText(this.sourceFile) === this.alias) {
      return "number";
    }
    // Any other id-typed operation is not covered.
    if (t.isPropertyAccessExpression(node) && this.isIdExpression(node.expression) && !t.isCallExpression(node.parent)) {
      this.diagnostics.push(`property ${node.name.text} on an id at line ${this.line(node)} has no rewrite rule`);
    }
    if (t.isCallExpression(node) && t.isPropertyAccessExpression(node.expression) && this.isIdExpression(node.expression.expression)) {
      this.diagnostics.push(`method ${node.expression.name.text} on an id at line ${this.line(node)} has no rewrite rule`);
    }
    return undefined;
  }

  // --- rule helpers -----------------------------------------------------------------------------

  /** `G.get(x) ?? []` where G is a graph parameter. */
  private graphLookup(node: ts.Node): { graph: string; key: ts.Expression } | undefined {
    const t = this.t;
    let expression = node;
    if (t.isIdentifier(node) && t.isPropertyAccessExpression(node.parent)) {
      expression = node.parent.parent.parent;
    }
    if (t.isBinaryExpression(expression) && expression.operatorToken.kind === t.SyntaxKind.QuestionQuestionToken
      && t.isArrayLiteralExpression(expression.right) && expression.right.elements.length === 0
      && t.isCallExpression(expression.left) && t.isPropertyAccessExpression(expression.left.expression)
      && expression.left.expression.name.text === "get" && t.isIdentifier(expression.left.expression.expression)
      && this.roles.get(expression.left.expression.expression.text)?.role === "graph" && expression.left.arguments.length === 1) {
      return { graph: expression.left.expression.expression.text, key: expression.left.arguments[0] as ts.Expression };
    }
    return undefined;
  }

  /** The statement owning a graph lookup expression (expected: a for-of over it). */
  private graphLookupStatement(use: ts.Node): ts.Node {
    return use.parent.parent.parent.parent;
  }

  /** `s.has(x)` / `s.add(x)` on an id set; `use` is the set identifier or the call. */
  private setOperation(use: ts.Node): { set: string; method: "has" | "add"; call: ts.CallExpression } | undefined {
    const t = this.t;
    const identifier = t.isIdentifier(use) ? use : undefined;
    const access = identifier && t.isPropertyAccessExpression(identifier.parent) ? identifier.parent : undefined;
    const call = access && t.isCallExpression(access.parent) && access.parent.expression === access ? access.parent : undefined;
    if (!identifier || !access || !call || call.arguments.length !== 1 || !["has", "add"].includes(access.name.text)) return undefined;
    if (access.name.text === "add" && !t.isExpressionStatement(call.parent)) return undefined;
    return { set: identifier.text, method: access.name.text as "has" | "add", call };
  }

  private enclosingSortComparator(node: ts.Node): ts.Node | undefined {
    const t = this.t;
    let current: ts.Node | undefined = node;
    while (current && current !== this.fn) {
      if ((t.isArrowFunction(current) || t.isFunctionExpression(current)) && t.isCallExpression(current.parent)
        && t.isPropertyAccessExpression(current.parent.expression) && current.parent.expression.name.text === "sort") {
        return current;
      }
      current = current.parent;
    }
    return undefined;
  }

  private comparatorLookup(comparator: ts.Node): string | undefined {
    const t = this.t;
    let found: string | undefined;
    const visit = (node: ts.Node): void => {
      if (t.isIdentifier(node) && this.roles.get(node.text)?.role === "entityRank") found = node.text;
      node.forEachChild(visit);
    };
    visit(comparator);
    return found;
  }

  /**
   * Accepts comparators of the form
   *   (a, b) => { const l = M.get(a); const r = M.get(b); if (!l || !r) return a.localeCompare(b);
   *               return l.f.localeCompare(r.f) || l.g - r.g ...; }
   * A lexicographic chain of total preorders (localeCompare, numeric differences) is a total preorder,
   * so sorting by its dense rank equals sorting with it (both stable). The missing-entity branch mixes
   * two orders; the pack adapter guards that every universe id has an entity and finite numeric keys.
   */
  private recordComparator(lookup: string, comparator: ts.ArrowFunction | ts.FunctionExpression): void {
    const t = this.t;
    const body = comparator.body;
    const statements = body && t.isBlock(body) ? body.statements : [];
    const last = statements[statements.length - 1];
    const keys: { field: string; kind: "locale" | "numeric" }[] = [];
    const collect = (expression: ts.Expression): boolean => {
      if (t.isParenthesizedExpression(expression)) return collect(expression.expression);
      if (t.isBinaryExpression(expression) && expression.operatorToken.kind === t.SyntaxKind.BarBarToken) {
        return collect(expression.left) && collect(expression.right);
      }
      if (t.isCallExpression(expression) && t.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "localeCompare"
        && t.isPropertyAccessExpression(expression.expression.expression) && expression.arguments.length === 1) {
        keys.push({ field: expression.expression.expression.name.text, kind: "locale" });
        return true;
      }
      if (t.isBinaryExpression(expression) && expression.operatorToken.kind === t.SyntaxKind.MinusToken
        && t.isPropertyAccessExpression(expression.left) && t.isPropertyAccessExpression(expression.right)
        && expression.left.name.text === expression.right.name.text) {
        keys.push({ field: expression.left.name.text, kind: "numeric" });
        return true;
      }
      return false;
    };
    const hasMissingBranch = statements.some((statement) => t.isIfStatement(statement) && /^!\w+ \|\| !\w+$/.test(statement.expression.getText(this.sourceFile)));
    if (!last || !t.isReturnStatement(last) || !last.expression || !collect(last.expression) || statements.length > 4 || !hasMissingBranch) {
      this.diagnostics.push(`sort comparator at line ${this.line(comparator)} is not a recognized lexicographic chain of localeCompare / numeric keys`);
      return;
    }
    this.comparator = { param: lookup, text: comparator.getText(this.sourceFile), keys };
    this.guards.push(`every universe id has an entry in ${lookup}`);
    for (const key of keys.filter((entry) => entry.kind === "numeric")) {
      this.guards.push(`${lookup} entries have a finite numeric ${key.field}`);
    }
  }

  private isGuardedPop(declaration: ts.VariableDeclaration, array: string): boolean {
    const t = this.t;
    const statement = declaration.parent.parent;
    const block = statement.parent;
    const loop = block?.parent;
    return t.isVariableStatement(statement) && t.isBlock(block) && block.statements[0] === statement
      && loop !== undefined && t.isWhileStatement(loop)
      && loop.expression.getText(this.sourceFile).replace(/\s+/g, " ") === `${array}.length > 0`
      && (declaration.parent.flags & t.NodeFlags.Const) !== 0;
  }

  private isGuardedFalsy(node: ts.Node): boolean {
    const t = this.t;
    if (!t.isPrefixUnaryExpression(node) || node.operator !== t.SyntaxKind.ExclamationToken || !t.isIdentifier(node.operand)) return false;
    const symbol = this.checker.getSymbolAtLocation(node.operand);
    return symbol !== undefined && this.guardedPops.has(symbol);
  }

  private isIdExpression(node: ts.Node): boolean {
    const t = this.t;
    if (t.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      return symbol !== undefined && this.idValues.has(symbol);
    }
    if (t.isPropertyAccessExpression(node) && node.name.text === "id" && t.isIdentifier(node.expression)) {
      const symbol = this.checker.getSymbolAtLocation(node.expression);
      if (symbol) {
        // A universe loop variable is classified while walking; accept the pattern syntactically here.
        const declaration = symbol.valueDeclaration;
        const loop = declaration?.parent?.parent;
        return loop !== undefined && t.isForOfStatement(loop) && t.isIdentifier(loop.expression) && loop.expression.text === this.universe;
      }
    }
    return false;
  }

  private hasIdProperty(parameter: ts.ParameterDeclaration): boolean {
    const type = this.checker.getTypeAtLocation(parameter);
    const element = (type as ts.TypeReference).target ? this.checker.getTypeArguments(type as ts.TypeReference)[0] : undefined;
    const id = element?.getProperty("id");
    const declaration = id?.valueDeclaration;
    return declaration !== undefined && (this.t.isPropertySignature(declaration) || this.t.isPropertyDeclaration(declaration))
      && declaration.type?.getText() === this.alias;
  }

  private isAliasArray(typeText: string): boolean {
    return new RegExp(`^(readonly\\s+)?${this.alias}\\[\\]$`).test(typeText.trim());
  }

  private isAliasArrayArray(typeText: string): boolean {
    return new RegExp(`^${this.alias}\\[\\]\\[\\]$`).test(typeText.trim());
  }

  private loopDeclaration(node: ts.ForOfStatement): ts.VariableDeclaration | undefined {
    const initializer = node.initializer;
    return this.t.isVariableDeclarationList(initializer) && initializer.declarations.length === 1 && this.t.isIdentifier(initializer.declarations[0]!.name)
      ? initializer.declarations[0]
      : undefined;
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

  /** A newline followed by the indentation of `node`'s line. */
  private newline(node: ts.Node): string {
    return `\n${" ".repeat(this.column(node))}`;
  }

  private line(node: ts.Node): number {
    return this.sourceFile.getLineAndCharacterOfPosition(node.getStart(this.sourceFile)).line + 1;
  }

  private column(node: ts.Node | undefined): number {
    return node ? this.sourceFile.getLineAndCharacterOfPosition(node.getStart(this.sourceFile)).character : 0;
  }

  /** Routes every call of the function in its own file through the generated integration. */
  private patchCallers(name: string, integrationImport: string, patchedFile: string): string {
    const t = this.t;
    const symbol = this.fn.name ? this.checker.getSymbolAtLocation(this.fn.name) : undefined;
    const edits: Edit[] = [];
    const visit = (node: ts.Node): void => {
      if (t.isCallExpression(node) && t.isIdentifier(node.expression) && symbol && this.checker.getSymbolAtLocation(node.expression) === symbol) {
        edits.push({
          start: node.expression.getStart(this.sourceFile),
          end: node.arguments.pos,
          text: `__crankts.${name}(${name}, `,
        });
        if (node.arguments.length === 0) {
          this.diagnostics.push("calls without arguments cannot be routed");
        }
      }
      node.forEachChild(visit);
    };
    visit(this.sourceFile);
    const header = `// Generated by CrankTS: patched copy that routes ${name}() through packed kernels. Do not edit.\nimport * as __crankts from "${integrationImport}";\n`;
    return header + applyEdits(this.sourceFile.text, [
      ...edits,
      ...relativeImportEdits(this.sourceFile, dirname(this.sourceFile.fileName), dirname(patchedFile), { t }),
    ]);
  }

  // --- adapters ---------------------------------------------------------------------------------

  private adapters(name: string, packedParams: readonly string[], output: InternPlan["output"]): string {
    const original = this.fn.parameters.map((parameter) => parameter.name.getText(this.sourceFile));
    const signature = this.fn.parameters.map((parameter) => parameter.getText(this.sourceFile)).join(", ");
    const universe = this.universe ?? "universe";
    const lines: string[] = [];
    const graphRole = [...this.roles.values()].find((role) => role.role === "graph");
    lines.push(`/** Thrown when a packing guard fails: the caller must run the original function. */
export class PackingGuard extends Error {}

${sealedGraphRuntime()}

export interface Packed${pascal(name)} {
  readonly ids: readonly string[];
  readonly args: readonly unknown[];
}

/** Interns ids in ${universe} order and builds the packed arguments; throws PackingGuard if an assumption fails. */
export function pack${pascal(name)}(${signature.replaceAll(this.alias, ALIAS_PLACEHOLDER).replaceAll(ALIAS_PLACEHOLDER, "string")}): Packed${pascal(name)} {
  const ids = ${universe}.map((entity) => entity.id);
  ${graphRole ? `// Upstream packing: reuse the producer's sealed graph when it interned the same ids in the same order.
  const sealed = sealedGraph(${graphRole.name});
  const reuse = sealed !== undefined && sameIds(sealed.ids, ids) ? sealed : undefined;
  if (reuse) sealedGraphStats.reused += 1;
  const index = reuse?.index ?? new Map<string, number>();
  if (!reuse) {
    for (const id of ids) {
      if (id === "" || index.has(id)) throw new PackingGuard("ids must be unique and non-empty");
      (index as Map<string, number>).set(id, index.size);
    }
  }` : `const index = new Map<string, number>();
  for (const id of ids) {
    if (id === "" || index.has(id)) throw new PackingGuard("ids must be unique and non-empty");
    index.set(id, index.size);
  }`}`);
    const args: string[] = [];
    for (const role of this.roles.values()) {
      if (role.role === "universe") {
        args.push("ids.length");
      } else if (role.role === "graph") {
        lines.push(`  let ${role.name}__offsets: Uint32Array;
  let ${role.name}__neighbors: Uint32Array;
  if (reuse) {
    ${role.name}__offsets = reuse.offsets;
    ${role.name}__neighbors = reuse.neighbors;
  } else {
    ${role.name}__offsets = new Uint32Array(ids.length + 1);
    const ${role.name}__list: number[] = [];
    for (let node = 0; node < ids.length; node += 1) {
      for (const neighbor of ${role.name}.get(ids[node] as string) ?? []) {
        const neighborIndex = index.get(neighbor);
        if (neighborIndex === undefined) throw new PackingGuard("graph references an id outside the universe");
        ${role.name}__list.push(neighborIndex);
      }
      ${role.name}__offsets[node + 1] = ${role.name}__list.length;
    }
    ${role.name}__neighbors = Uint32Array.from(${role.name}__list);
  }`);
        args.push(`${role.name}__offsets`, `${role.name}__neighbors`);
      } else if (role.role === "entityRank") {
        const comparator = this.comparator;
        if (!comparator) continue;
        const numericChecks = comparator.keys.filter((key) => key.kind === "numeric")
          .map((key) => ` || !Number.isFinite((${role.name}.get(id) as { ${key.field}: number }).${key.field})`).join("");
        lines.push(`  for (const id of ids) {
    if (!${role.name}.has(id)${numericChecks}) throw new PackingGuard("sort keys must be complete and finite");
  }
  // The original comparator, verbatim: a total preorder (see the pass), so a dense rank reproduces it.
  const ${role.name}__compare: (left: string, right: string) => number = ${comparator.text};
  const ${role.name}__order = [...ids].sort(${role.name}__compare);
  const ${role.name}__rank = new Uint32Array(ids.length);
  let ${role.name}__current = 0;
  ${role.name}__order.forEach((id, position) => {
    if (position > 0 && ${role.name}__compare(${role.name}__order[position - 1] as string, id) !== 0) ${role.name}__current += 1;
    ${role.name}__rank[index.get(id) as number] = ${role.name}__current;
  });`);
        args.push(`${role.name}__rank`);
      } else {
        args.push(role.name);
      }
    }
    lines.push(`  return { ids, args: [${args.join(", ")}] };
}`);
    if (output === "idArrays") {
      lines.push(`/** [count, (length, indices...)*] → string[][] */
export function unpack${pascal(name)}(flat: ArrayLike<number>, ids: readonly string[]): string[][] {
  const result: string[][] = [];
  let position = 1;
  for (let item = 0; item < (flat[0] ?? 0); item += 1) {
    const length = flat[position++] ?? 0;
    const members: string[] = new Array(length);
    for (let member = 0; member < length; member += 1) members[member] = ids[flat[position++] ?? 0] as string;
    result.push(members);
  }
  return result;
}`);
    }
    void original;
    void packedParams;
    return lines.join("\n\n");
  }
}

function indent(text: string, column: number): string {
  return text.split("\n").map((line, index) => {
    if (index === 0) return `  ${line}`;
    const leading = line.length - line.trimStart().length;
    return line.trim().length === 0 ? "" : `  ${line.slice(Math.min(column, leading))}`;
  }).join("\n");
}

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
