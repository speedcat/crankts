import { dirname, relative, resolve, sep } from "node:path";
import type * as ts from "typescript";
import { collectFunctions } from "../analysis/functions.js";
import { createCompilerFacade, type CompilerFacade } from "../compiler/compiler-facade.js";

/**
 * Region extraction from unmodified source (v0.2.5). An explicitly selected statement range inside
 * a function or method is outlined into a standalone function; the original region text is kept
 * verbatim. Every rule fails closed:
 *
 * - Interface: outer locals read in the region become parameters; outer maps the region mutates only
 *   with `has`/`set` become in-out parameters; anything else (captured module state, `this`, assigning
 *   outer variables, locals live after the region) is rejected.
 * - PREPARED_STATE: containers the prepare region fills that were created fresh just before it (and
 *   are unused in between) move into the prepare function and become the state. The prepare loop is
 *   sliced: statements that build the state go to the prepare function, all others stay in the
 *   source (the complement); shared conditions must be pure.
 * - Integration: a patched copy of the source file calls the generated integration instead of the
 *   regions. The original file is never modified.
 */

export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface RegionRequest {
  /** Source file containing the function or method. */
  readonly file: string;
  /** `functionName` or `ClassName.methodName`. */
  readonly function: string;
  readonly execute: LineRange;
  readonly prepare?: LineRange;
}

export interface RegionParameter {
  readonly name: string;
  readonly sourceType: string;
}

export interface RegionPlan {
  readonly function: string;
  readonly file: string;
  readonly stateName?: string;
  readonly prepareName?: string;
  readonly executeName: string;
  readonly prepareParams: readonly RegionParameter[];
  /** Execute parameters in call order; the state parameter (if any) is named `state`. */
  readonly executeParams: readonly (RegionParameter & { readonly role: "input" | "state" | "inout" })[];
  readonly stateFields: readonly RegionParameter[];
  /** The outlined regions as a TypeScript module (also the exact TypeScript fallback). */
  readonly outlinedModule: string;
  /** The patched source; `@@CRANKTS_INTEGRATION@@` is replaced by the integration import path. */
  readonly patchedSource: (integrationImport: string, patchedFile: string) => string;
  /** How the original source changed, for review. */
  readonly sourceEdits: readonly string[];
}

export type RegionResult =
  | { readonly ok: true; readonly plan: RegionPlan }
  | { readonly ok: false; readonly diagnostics: readonly string[] };

const ALLOWED_TYPE_NAMES = new Set([
  "Map", "ReadonlyMap", "Set", "ReadonlySet", "Array", "ReadonlyArray",
  "Uint8Array", "Uint32Array", "Int32Array", "Float64Array",
]);
const PURE_STRING_METHODS = new Set(["toLowerCase", "toUpperCase", "slice", "charCodeAt", "includes", "startsWith", "endsWith", "indexOf", "trim"]);
const MUTATING_METHODS = new Set(["set", "delete", "clear", "add", "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function planRegionExtraction(request: RegionRequest): RegionResult {
  const diagnostics: string[] = [];
  const file = resolve(request.file);
  const facade = createCompilerFacade(file);
  const definition = collectFunctions(facade).definitions.find((candidate) => (
    candidate.absoluteFile === file && candidate.name === request.function
  ));
  if (!definition?.node.body || !definition.compilerFacade.typescript.isBlock(definition.node.body)) {
    return { ok: false, diagnostics: [`no function or method ${request.function} with a body in ${file}`] };
  }
  const t = definition.compilerFacade.typescript;
  const checker = definition.compilerFacade.checker;
  const sourceFile = definition.sourceFile;
  const fn = definition.node;
  const body = definition.node.body;
  const lineOf = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const columnOf = (node: ts.Node | undefined): number => (node ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).character : 0);
  const context: Context = { t, checker, sourceFile, fn, diagnostics, facade: definition.compilerFacade };

  const executeStatements = selectStatements(body, request.execute, "execute", context);
  const prepareStatements = request.prepare ? selectStatements(body, request.prepare, "prepare", context) : [];
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  if (request.prepare && (prepareStatements[prepareStatements.length - 1]?.getEnd() ?? 0) > (executeStatements[0]?.getStart(sourceFile) ?? 0)) {
    return { ok: false, diagnostics: ["the prepare region must end before the execute region starts"] };
  }

  const pascal = pascalCase(request.function.split(".").pop() ?? request.function);
  const executeName = `execute${pascal}`;
  const prepareName = request.prepare ? `prepare${pascal}` : undefined;
  const stateName = request.prepare ? `${pascal}State` : undefined;

  // --- prepare: pull state containers in, slice the loop ----------------------------------------
  const execRefs = analyzeRegion(executeStatements, context);
  const prepRefs = request.prepare ? analyzeRegion(prepareStatements, context) : undefined;
  const stateContainers: ts.VariableStatement[] = [];
  const stateNames: string[] = [];
  const stateFields: RegionParameter[] = [];
  let prepareBody = "";
  let complementText = "";
  const prepareParams: RegionParameter[] = [];

  if (prepRefs && prepareStatements.length > 0) {
    for (const [name, use] of prepRefs.outer) {
      // State: containers the prepare region fills and the execute region reads. Other containers
      // the prepare region mutates (e.g. regexTerms) belong to the complement slice.
      if (use.mutated && !execRefs.outer.has(name)) {
        continue;
      }
      if (use.mutated) {
        const declaration = freshContainerDeclaration(use.symbol, prepareStatements[0] as ts.Statement, body, context);
        if (!declaration) {
          diagnostics.push(`prepare region mutates ${name}, which is not a fresh container declared just before the region`);
          continue;
        }
        stateContainers.push(declaration);
        stateNames.push(name);
        stateFields.push({ name, sourceType: typeText(use.symbol, context) });
      } else {
        if (!isStableBinding(use.symbol, context)) {
          diagnostics.push(`prepare input ${name} must be a const binding that the function never mutates`);
        }
        prepareParams.push({ name, sourceType: typeText(use.symbol, context) });
      }
    }
    for (const statement of prepRefs.livesAfter) {
      diagnostics.push(`prepare region declares ${statement}, which is used after the region`);
    }
    const sliced = slicePrepare(prepareStatements, new Set(stateNames), context);
    prepareBody = [
      ...stateContainers.map((statement) => statement.getText(sourceFile)),
      sliced.state,
    ].join("\n__CRANKTS_SPLIT__\n");
    complementText = sliced.complement;
  }

  // --- execute interface ------------------------------------------------------------------------
  const executeParams: (RegionParameter & { role: "input" | "state" | "inout" })[] = [];
  const usedStateFields: string[] = [];
  for (const [name, use] of execRefs.outer) {
    if (stateNames.includes(name)) {
      if (use.mutated) {
        diagnostics.push(`execute region mutates state ${name}; the prepared state must be read-only`);
      }
      usedStateFields.push(name);
      continue;
    }
    if (use.mutated) {
      if (!use.mapHasSetOnly) {
        diagnostics.push(`execute region mutates ${name} with operations other than Map has()/set()`);
      }
      executeParams.push({ name, sourceType: typeText(use.symbol, context), role: "inout" });
    } else {
      executeParams.push({ name, sourceType: typeText(use.symbol, context), role: "input" });
    }
  }
  for (const statement of execRefs.livesAfter) {
    diagnostics.push(`execute region declares ${statement}, which is used after the region`);
  }
  if (stateName) {
    const firstInout = executeParams.findIndex((param) => param.role === "inout");
    executeParams.splice(firstInout < 0 ? executeParams.length : firstInout, 0, { name: "state", sourceType: stateName, role: "state" });
  }
  for (const param of [...prepareParams, ...executeParams.filter((entry) => entry.role !== "state"), ...stateFields]) {
    const unknown = [...param.sourceType.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((match) => match[1]).filter((name) => name && !ALLOWED_TYPE_NAMES.has(name));
    if (unknown.length > 0) {
      diagnostics.push(`type of ${param.name} (${param.sourceType}) refers to ${unknown.join(", ")}; only built-in types can be outlined`);
    }
  }
  const callees = [...new Set([...execRefs.callees, ...(prepRefs?.callees ?? [])])];
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // --- outlined module ------------------------------------------------------------------------
  const location = `${relative(process.cwd(), file).split(sep).join("/")}#${request.function}`;
  const executeText = executeStatements.map((statement) => statement.getText(sourceFile)).join("\n");
  const lines = [
    `// Generated by CrankTS (v0.2.5 region extraction) from ${location}. Do not edit; regenerate with \`crankts extract\`.`,
    `// Region text is verbatim: execute lines ${request.execute.startLine}-${request.execute.endLine}${request.prepare ? `, prepare lines ${request.prepare.startLine}-${request.prepare.endLine} (sliced on the prepared state)` : ""}.`,
    ...callees.map((callee) => callee.getText(sourceFile)),
  ];
  if (stateName && prepareName) {
    lines.push(
      `export interface ${stateName} {\n${stateFields.map((field) => `  readonly ${field.name}: ${field.sourceType};`).join("\n")}\n}`,
      `export function ${prepareName}(${prepareParams.map((param) => `${param.name}: ${param.sourceType}`).join(", ")}): ${stateName} {\n${prepareBody.split("\n__CRANKTS_SPLIT__\n").map((part) => indent(part, columnOf(prepareStatements[0]))).join("\n")}\n  return { ${stateNames.join(", ")} };\n}`,
    );
  }
  lines.push(
    `export function ${executeName}(${executeParams.map((param) => `${param.name}: ${param.sourceType}`).join(", ")}): void {\n${
      usedStateFields.map((field) => `  const ${field} = state.${field};\n`).join("")
    }${indent(executeText, columnOf(executeStatements[0]))}\n}`,
  );
  const outlinedModule = `${lines.join("\n\n")}\n`;

  // --- patched source ---------------------------------------------------------------------------
  const edits: Edit[] = [];
  const sourceEdits: string[] = [];
  for (const statement of stateContainers) {
    edits.push({ start: statement.getFullStart(), end: statement.getEnd(), text: "" });
    sourceEdits.push(`line ${lineOf(statement.getStart(sourceFile))}: moved \`${statement.getText(sourceFile).split("\n")[0]}\` into ${prepareName}`);
  }
  if (prepareStatements.length > 0) {
    const first = prepareStatements[0] as ts.Statement;
    const last = prepareStatements[prepareStatements.length - 1] as ts.Statement;
    edits.push({ start: first.getStart(sourceFile), end: last.getEnd(), text: complementText });
    sourceEdits.push(`lines ${request.prepare?.startLine}-${request.prepare?.endLine}: kept only the complement slice (statements that do not build ${stateNames.join(", ")})`);
  }
  const owner = isMethodLike(fn, t) ? "this" : "undefined";
  const call = `__crankts.${executeName}(${owner}, [${prepareParams.map((param) => param.name).join(", ")}], ${executeParams.filter((param) => param.role !== "state").map((param) => param.name).join(", ")});`;
  const executeFirst = executeStatements[0] as ts.Statement;
  const executeLast = executeStatements[executeStatements.length - 1] as ts.Statement;
  edits.push({ start: executeFirst.getStart(sourceFile), end: executeLast.getEnd(), text: call });
  sourceEdits.push(`lines ${request.execute.startLine}-${request.execute.endLine}: replaced by a call to the generated integration (native kernel with TypeScript fallback)`);

  const patchedSource = (integrationImport: string, patchedFile: string): string => {
    const allEdits = [...edits, ...relativeImportEdits(sourceFile, dirname(file), dirname(patchedFile), context)];
    const header = `// Generated by CrankTS from ${location}: patched copy that calls native kernels. Do not edit.\nimport * as __crankts from "${integrationImport}";\n`;
    return header + applyEdits(sourceFile.text, allEdits);
  };

  return {
    ok: true,
    plan: {
      function: request.function,
      file,
      ...(stateName ? { stateName } : {}),
      ...(prepareName ? { prepareName } : {}),
      executeName,
      prepareParams,
      executeParams,
      stateFields,
      outlinedModule,
      patchedSource,
      sourceEdits,
    },
  };
}

interface Context {
  readonly t: typeof ts;
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly fn: ts.FunctionLikeDeclaration;
  readonly diagnostics: string[];
  readonly facade: CompilerFacade;
}

interface OuterUse {
  readonly symbol: ts.Symbol;
  mutated: boolean;
  mapHasSetOnly: boolean;
}

/** Top-level statements of the function body inside the line range (statement-aligned). */
function selectStatements(body: ts.Block, range: LineRange, label: string, context: Context): ts.Statement[] {
  const { sourceFile } = context;
  const line = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const selected: ts.Statement[] = [];
  for (const statement of body.statements) {
    const start = line(statement.getStart(sourceFile));
    const end = line(statement.getEnd());
    const inside = start >= range.startLine && end <= range.endLine;
    const overlaps = start <= range.endLine && end >= range.startLine;
    if (inside) {
      selected.push(statement);
    } else if (overlaps) {
      context.diagnostics.push(`${label} region ${range.startLine}-${range.endLine} cuts through the statement at lines ${start}-${end}`);
    }
  }
  if (selected.length === 0) {
    context.diagnostics.push(`${label} region ${range.startLine}-${range.endLine} contains no complete top-level statement of the function body`);
  }
  return selected;
}

function analyzeRegion(statements: readonly ts.Statement[], context: Context): {
  outer: Map<string, OuterUse>;
  livesAfter: string[];
  callees: ts.FunctionDeclaration[];
} {
  const { t, checker, fn, diagnostics } = context;
  const outer = new Map<string, OuterUse>();
  const declaredInside = new Set<ts.Symbol>();
  const callees: ts.FunctionDeclaration[] = [];
  const regionStart = statements[0]?.getStart(context.sourceFile) ?? 0;
  const regionEnd = statements[statements.length - 1]?.getEnd() ?? 0;
  const within = (node: ts.Node): boolean => node.getStart(context.sourceFile) >= regionStart && node.getEnd() <= regionEnd;

  const visit = (node: ts.Node): void => {
    if (node.kind === t.SyntaxKind.ThisKeyword) {
      diagnostics.push("regions that use `this` are not extracted in v0.2.5");
    }
    if (t.isIdentifier(node)) {
      classify(node);
    }
    node.forEachChild(visit);
  };

  const classify = (node: ts.Identifier): void => {
    if (t.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
    if (t.isPropertyAssignment(node.parent) && node.parent.name === node) return;
    const symbol = t.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!symbol || !declaration) return;
    if (within(declaration)) {
      declaredInside.add(symbol);
      return;
    }
    if (t.isFunctionDeclaration(declaration)) {
      if (declaration.getSourceFile() === context.sourceFile && declaration.body && !callees.includes(declaration)) {
        callees.push(declaration);
      }
      return;
    }
    let owner: ts.Node | undefined = declaration;
    while (owner && !t.isFunctionLike(owner)) owner = owner.parent;
    if (owner !== fn) {
      if (declaration.getSourceFile() !== context.sourceFile || t.isTypeAliasDeclaration(declaration) || t.isInterfaceDeclaration(declaration)) {
        return; // types and globals such as Math; the lowerer decides what it supports
      }
      diagnostics.push(`region captures ${node.text}, which is not a local of ${context.fn.name?.getText() ?? "the function"}`);
      return;
    }
    const use = outer.get(node.text) ?? { symbol, mutated: false, mapHasSetOnly: true };
    outer.set(node.text, use);
    const parent = node.parent;
    if ((t.isBinaryExpression(parent) && parent.left === node && isAssignment(parent.operatorToken.kind, t))
      || ((t.isPrefixUnaryExpression(parent) || t.isPostfixUnaryExpression(parent))
        && (parent.operator === t.SyntaxKind.PlusPlusToken || parent.operator === t.SyntaxKind.MinusMinusToken))) {
      diagnostics.push(`region assigns outer variable ${node.text}`);
    }
    if (t.isPropertyAccessExpression(parent) && parent.expression === node && t.isCallExpression(parent.parent)
      && MUTATING_METHODS.has(parent.name.text)) {
      use.mutated = true;
      const isMap = checker.getTypeAtLocation(node).getSymbol()?.getName() === "Map";
      if (!isMap || parent.name.text !== "set") use.mapHasSetOnly = false;
    } else if (t.isPropertyAccessExpression(parent) && parent.expression === node) {
      const isMap = checker.getTypeAtLocation(node).getSymbol()?.getName() === "Map";
      if (!isMap || !["has", "get", "set"].includes(parent.name.text)) use.mapHasSetOnly = false;
      if (parent.name.text === "get") use.mapHasSetOnly = false;
    } else if (t.isElementAccessExpression(parent) && parent.expression === node
      && t.isBinaryExpression(parent.parent) && parent.parent.left === parent && isAssignment(parent.parent.operatorToken.kind, t)) {
      use.mutated = true;
      use.mapHasSetOnly = false;
    } else {
      use.mapHasSetOnly = false;
    }
  };

  for (const statement of statements) visit(statement);

  // Locals declared in the region must not be read after it.
  const livesAfter: string[] = [];
  const afterVisit = (node: ts.Node): void => {
    if (t.isIdentifier(node) && node.getStart(context.sourceFile) > regionEnd) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && declaredInside.has(symbol)) livesAfter.push(node.text);
    }
    node.forEachChild(afterVisit);
  };
  if (fn.body) afterVisit(fn.body);
  return { outer, livesAfter: [...new Set(livesAfter)], callees };
}

/** `const x = new Map()/new Set()/[]` declared before the region with no use in between. */
function freshContainerDeclaration(symbol: ts.Symbol, regionStart: ts.Statement, body: ts.Block, context: Context): ts.VariableStatement | undefined {
  const { t, checker, sourceFile } = context;
  const declaration = symbol.valueDeclaration;
  if (!declaration || !t.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
  const list = declaration.parent;
  const statement = list.parent;
  if (!t.isVariableDeclarationList(list) || !(list.flags & t.NodeFlags.Const) || list.declarations.length !== 1
    || !t.isVariableStatement(statement) || statement.parent !== body) return undefined;
  const init = declaration.initializer;
  const fresh = (t.isNewExpression(init) && t.isIdentifier(init.expression) && ["Map", "Set"].includes(init.expression.text) && (init.arguments?.length ?? 0) === 0)
    || (t.isArrayLiteralExpression(init) && init.elements.length === 0);
  if (!fresh) return undefined;
  let usedBetween = false;
  const visit = (node: ts.Node): void => {
    if (t.isIdentifier(node) && node.getStart(sourceFile) > statement.getEnd() && node.getStart(sourceFile) < regionStart.getStart(sourceFile)
      && checker.getSymbolAtLocation(node) === symbol) {
      usedBetween = true;
    }
    node.forEachChild(visit);
  };
  visit(body);
  return usedBetween ? undefined : statement;
}

/** A const binding (or parameter) that the function never mutates through a known mutating method. */
function isStableBinding(symbol: ts.Symbol, context: Context): boolean {
  const { t, sourceFile } = context;
  const declaration = symbol.valueDeclaration;
  const isConst = declaration !== undefined && t.isVariableDeclaration(declaration)
    && t.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & t.NodeFlags.Const) !== 0;
  if (!isConst) return false;
  let mutated = false;
  const visit = (node: ts.Node): void => {
    if (t.isIdentifier(node) && context.checker.getSymbolAtLocation(node) === symbol && node !== (declaration as ts.VariableDeclaration).name) {
      const parent = node.parent;
      if (t.isPropertyAccessExpression(parent) && parent.expression === node && MUTATING_METHODS.has(parent.name.text) && t.isCallExpression(parent.parent)) mutated = true;
      if (t.isElementAccessExpression(parent) && parent.expression === node && t.isBinaryExpression(parent.parent)
        && parent.parent.left === parent && isAssignment(parent.parent.operatorToken.kind, t)) mutated = true;
    }
    node.forEachChild(visit);
  };
  if (context.fn.body) visit(context.fn.body);
  void sourceFile;
  return !mutated;
}

/**
 * Splits the prepare region into the statements that build the state and the complement. Supported
 * shape: top-level statements and loops whose bodies contain declarations, expression statements,
 * `continue`/`break`, and `if` blocks (recursively) with pure conditions.
 */
function slicePrepare(statements: readonly ts.Statement[], state: ReadonlySet<string>, context: Context): { state: string; complement: string } {
  const { t, sourceFile, diagnostics } = context;
  const stateEdits: Edit[] = [];
  const complementEdits: Edit[] = [];
  const derived = new Set<string>(state);

  const mentions = (node: ts.Node, names: ReadonlySet<string>): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (t.isIdentifier(child) && names.has(child.text) && !(t.isPropertyAccessExpression(child.parent) && child.parent.name === child)) found = true;
      child.forEachChild(visit);
    };
    visit(node);
    return found;
  };

  const split = (list: readonly ts.Statement[]): void => {
    // Declarations whose initializer reads state-derived bindings derive state themselves (e.g. `variants`).
    for (const statement of list) {
      if (t.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (t.isIdentifier(declaration.name) && declaration.initializer && mentions(declaration.initializer, derived)) {
            derived.add(declaration.name.text);
          }
        }
      }
    }
    // Locals used by state statements also belong to the state slice (e.g. `key`).
    const stateUses = new Set<string>();
    for (const statement of list) {
      if (!t.isIfStatement(statement) && mentions(statement, derived)) {
        statement.forEachChild(function collect(child: ts.Node): void {
          if (t.isIdentifier(child)) stateUses.add(child.text);
          child.forEachChild(collect);
        });
      }
    }
    for (const statement of list) {
      if (t.isContinueStatement(statement) || t.isBreakStatement(statement)) continue;
      if (t.isIfStatement(statement)) {
        if (!isPure(statement.expression, context)) {
          diagnostics.push(`condition at line ${line(statement)} must be pure to appear in both slices`);
        }
        const branches = [statement.thenStatement, statement.elseStatement].filter((branch): branch is ts.Statement => branch !== undefined);
        for (const branch of branches) {
          split(t.isBlock(branch) ? branch.statements : [branch]);
        }
        continue;
      }
      if (t.isForOfStatement(statement) || t.isForStatement(statement)) {
        if (!t.isBlock(statement.statement)) {
          diagnostics.push(`loop at line ${line(statement)} needs a block body to be sliced`);
          continue;
        }
        split(statement.statement.statements);
        continue;
      }
      const declared = t.isVariableStatement(statement)
        ? statement.declarationList.declarations.map((declaration) => declaration.name.getText(sourceFile))
        : [];
      const isState = mentions(statement, derived) || declared.some((name) => stateUses.has(name));
      const usedByRest = declared.some((name) => list.some((other) => other !== statement && !mentions(other, derived)
        && mentions(other, new Set([name]))));
      if (isState && usedByRest) {
        if (!t.isVariableStatement(statement) || !statement.declarationList.declarations.every((declaration) => !declaration.initializer || isPure(declaration.initializer, context))) {
          diagnostics.push(`statement at line ${line(statement)} feeds both the state and the rest; only pure declarations can be duplicated`);
        }
        continue; // kept in both slices
      }
      const removal = { start: statement.getFullStart(), end: statement.getEnd(), text: "" };
      if (isState) {
        complementEdits.push(removal);
      } else {
        stateEdits.push(removal);
      }
    }
  };
  const line = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  split(statements);
  const start = statements[0]?.getStart(sourceFile) ?? 0;
  const end = statements[statements.length - 1]?.getEnd() ?? start;
  const text = sourceFile.text.slice(start, end);
  const relativeEdits = (edits: readonly Edit[]): Edit[] => edits.map((edit) => ({ ...edit, start: Math.max(edit.start, start) - start, end: edit.end - start }));
  const complement = applyEdits(text, relativeEdits(complementEdits));
  // A complement loop that only skips (no remaining work) is dropped entirely.
  const hasWork = complementEdits.length < countSliceable(statements, context);
  return { state: applyEdits(text, relativeEdits(stateEdits)), complement: hasWork ? complement : "" };
}

function countSliceable(statements: readonly ts.Statement[], context: Context): number {
  const { t } = context;
  let count = 0;
  const visit = (list: readonly ts.Statement[]): void => {
    for (const statement of list) {
      if (t.isContinueStatement(statement) || t.isBreakStatement(statement)) continue;
      if (t.isIfStatement(statement)) {
        for (const branch of [statement.thenStatement, statement.elseStatement]) {
          if (branch) visit(t.isBlock(branch) ? branch.statements : [branch]);
        }
      } else if ((t.isForOfStatement(statement) || t.isForStatement(statement)) && t.isBlock(statement.statement)) {
        visit(statement.statement.statements);
      } else {
        count += 1;
      }
    }
  };
  visit(statements);
  return count;
}

/** No assignments, no `new`, and calls only to known pure operations. */
function isPure(node: ts.Node, context: Context): boolean {
  const { t, checker } = context;
  let pure = true;
  const visit = (child: ts.Node): void => {
    if (t.isBinaryExpression(child) && isAssignment(child.operatorToken.kind, t)) pure = false;
    if ((t.isPrefixUnaryExpression(child) || t.isPostfixUnaryExpression(child))
      && (child.operator === t.SyntaxKind.PlusPlusToken || child.operator === t.SyntaxKind.MinusMinusToken)) pure = false;
    if (t.isNewExpression(child) || t.isDeleteExpression(child)) pure = false;
    if (t.isCallExpression(child)) {
      const callee = child.expression;
      const ok = t.isPropertyAccessExpression(callee) && (
        (t.isRegularExpressionLiteral(callee.expression) && callee.name.text === "test"
          && !/\/[a-z]*[gy][a-z]*$/.test(callee.expression.text))
        || (PURE_STRING_METHODS.has(callee.name.text) && Boolean(checker.getTypeAtLocation(callee.expression).flags & t.TypeFlags.StringLike))
        || (["has", "get"].includes(callee.name.text) && ["Map", "Set", "ReadonlyMap", "ReadonlySet"].includes(checker.getTypeAtLocation(callee.expression).getSymbol()?.getName() ?? ""))
      );
      if (!ok) pure = false;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return pure;
}

function isAssignment(kind: ts.SyntaxKind, t: typeof ts): boolean {
  return kind >= t.SyntaxKind.FirstAssignment && kind <= t.SyntaxKind.LastAssignment;
}

function isMethodLike(fn: ts.FunctionLikeDeclaration, t: typeof ts): boolean {
  return t.isMethodDeclaration(fn) || t.isConstructorDeclaration(fn) || t.isGetAccessorDeclaration(fn) || t.isSetAccessorDeclaration(fn);
}

function typeText(symbol: ts.Symbol, context: Context): string {
  const { t, checker } = context;
  const declaration = symbol.valueDeclaration;
  const type = declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : checker.getDeclaredTypeOfSymbol(symbol);
  return checker.typeToString(type, undefined, t.TypeFormatFlags.NoTruncation);
}

/** Relative module specifiers of the original file, re-pointed from the patched file's directory. */
function relativeImportEdits(sourceFile: ts.SourceFile, originalDirectory: string, patchedDirectory: string, context: Context): Edit[] {
  const { t } = context;
  const edits: Edit[] = [];
  for (const statement of sourceFile.statements) {
    const specifier = (t.isImportDeclaration(statement) || t.isExportDeclaration(statement)) ? statement.moduleSpecifier : undefined;
    if (specifier && t.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
      let target = relative(patchedDirectory, resolve(originalDirectory, specifier.text)).split(sep).join("/");
      if (!target.startsWith(".")) target = `./${target}`;
      edits.push({ start: specifier.getStart(sourceFile), end: specifier.getEnd(), text: JSON.stringify(target) });
    }
  }
  return edits;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/** Re-indents region text that started at `column` in the original file to two spaces. */
function indent(text: string, column: number): string {
  return text.split("\n").map((line, index) => {
    if (index === 0) return `  ${line}`;
    const leading = line.length - line.trimStart().length;
    return line.trim().length === 0 ? "" : `  ${line.slice(Math.min(column, leading))}`;
  }).join("\n");
}

function pascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
