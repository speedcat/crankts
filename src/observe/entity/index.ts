import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { parseSync } from "oxc-parser";
import type { Entity, EntityFlag, NameSource, OwnEntityKind } from "../model.js";

/**
 * Entity index (docs/observe-plan.md §4.1, §4.2, D10): parses one module with oxc-parser and names every function
 * with a readable key that survives edits elsewhere in the file. No TypeScript program or checker is needed.
 */

// oxc-parser's ESTree nodes; only the fields used here are typed.
interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [field: string]: unknown;
}

export interface IndexedEntity {
  readonly key: string;
  readonly kind: OwnEntityKind;
  readonly qualifiedName: string;
  readonly nameSource: NameSource;
  readonly parentKey?: string;
  /** Range used to match profile positions (includes a method's key). */
  readonly start: number;
  readonly end: number;
  /**
   * [headerStart, bodyStart] is the header, where V8 and source maps put the function's own position. headerStart
   * includes a wrapping `export`/`export default`, which source maps often point at.
   */
  readonly headerStart: number;
  readonly bodyStart: number;
  readonly async: boolean;
  readonly flags: readonly EntityFlag[];
  /** The function node the fingerprints hash. */
  readonly node?: AstNode;
}

export interface ModuleIndex {
  readonly absoluteFile: string;
  /** Project-relative path with `/` separators. */
  readonly file: string;
  readonly packageName: string;
  readonly language: "typescript" | "javascript";
  /** Sorted by start; the module-init entity is first. */
  readonly entities: readonly IndexedEntity[];
  readonly lineStarts: readonly number[];
  readonly parseErrors: number;
  /** The parsed text, for checks against generated code (source-map column extrapolation). */
  readonly source: string;
}

const WRAPPERS = new Set([
  "ParenthesizedExpression", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion",
  "TSInstantiationExpression",
]);

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export const MODULE_INIT_NAME = "(module)";

export function indexModuleSource(
  source: string,
  options: { readonly absoluteFile: string; readonly file: string; readonly packageName: string; readonly packagePath: string },
): ModuleIndex {
  const extension = extname(options.absoluteFile);
  const language = TS_EXTENSIONS.has(extension) ? "typescript" : "javascript";
  const parsed = parseSync(options.absoluteFile, source, { sourceType: "unambiguous", preserveParens: true });
  const program = parsed.program as unknown as AstNode;
  const keyPrefix = `${options.packageName}::${options.packagePath}::`;

  const moduleEntity: IndexedEntity = {
    key: keyPrefix + MODULE_INIT_NAME,
    kind: "module-init",
    qualifiedName: MODULE_INIT_NAME,
    nameSource: "declared",
    start: 0,
    end: source.length,
    headerStart: 0,
    bodyStart: 0,
    async: false,
    flags: [],
  };
  const entities: IndexedEntity[] = [];
  const keyCount = new Map<string, number>();
  const ordinalByParent = new Map<string, number>();

  interface Scope {
    readonly entity?: IndexedEntity;
    /** Qualified name of the innermost class (with its function prefix). */
    readonly className?: string;
  }

  const qualify = (scope: Scope, name: string): string => (scope.entity ? `${scope.entity.qualifiedName}/${name}` : name);

  const addEntity = (
    node: AstNode,
    range: AstNode,
    scope: Scope,
    kind: OwnEntityKind,
    qualifiedName: string,
    nameSource: NameSource,
    headerStart: number,
  ): IndexedEntity => {
    let name = qualifiedName;
    const seen = keyCount.get(name) ?? 0;
    keyCount.set(name, seen + 1);
    // Later duplicates get an occurrence suffix; the first keeps its name, so adding a duplicate below renames nothing.
    if (seen > 0) name = `${qualifiedName}~${seen + 1}`;
    const flags: EntityFlag[] = nameSource === "ordinal" ? ["anonymousOrdinal"] : [];
    const entity: IndexedEntity = {
      key: keyPrefix + name,
      kind,
      qualifiedName: name,
      nameSource,
      ...(scope.entity ? { parentKey: scope.entity.key } : {}),
      start: range.start,
      end: range.end,
      headerStart: Math.min(headerStart, range.start),
      bodyStart: (node["body"] as AstNode | undefined)?.start ?? range.start,
      async: node["async"] === true,
      flags,
      node,
    };
    entities.push(entity);
    return entity;
  };

  const nameFunction = (
    node: AstNode,
    parents: readonly AstNode[],
    scope: Scope,
  ): { range: AstNode; kind: OwnEntityKind; qualifiedName: string; nameSource: NameSource } => {
    const { parent, child } = effectiveParent(node, parents);
    const baseKind: OwnEntityKind = node.type === "ArrowFunctionExpression"
      ? "arrow"
      : node.type === "FunctionDeclaration" ? "function" : "function-expression";
    const id = node["id"] as AstNode | null | undefined;

    if (parent?.type === "MethodDefinition" || parent?.type === "TSAbstractMethodDefinition") {
      const methodKind = parent["kind"] as string;
      const kind: OwnEntityKind = methodKind === "constructor" ? "constructor" : methodKind === "get" ? "getter" : methodKind === "set" ? "setter" : "method";
      const member = methodKind === "constructor" ? "constructor" : accessorPrefix(methodKind) + propertyKeyText(parent, source);
      return { range: parent, kind, qualifiedName: `${scope.className ?? "(class)"}.${member}`, nameSource: "declared" };
    }
    if (parent?.type === "PropertyDefinition" || parent?.type === "AccessorProperty") {
      return { range: node, kind: baseKind, qualifiedName: `${scope.className ?? "(class)"}.${propertyKeyText(parent, source)}`, nameSource: "inferred" };
    }
    if (parent?.type === "Property" && parent["value"] === child) {
      const propertyKind = parent["kind"] as string;
      const isMethod = parent["method"] === true || propertyKind === "get" || propertyKind === "set";
      const kind: OwnEntityKind = propertyKind === "get" ? "getter" : propertyKind === "set" ? "setter" : parent["method"] === true ? "method" : baseKind;
      const objectNode = parents[parents.indexOf(parent) - 1];
      const owner = objectNode ? objectName(objectNode, parents.slice(0, parents.indexOf(parent) - 1), source) : "{}";
      const member = `${owner}.${accessorPrefix(propertyKind)}${propertyKeyText(parent, source)}`;
      return { range: isMethod ? parent : node, kind, qualifiedName: qualify(scope, member), nameSource: isMethod ? "declared" : "inferred" };
    }
    if (id && typeof id["name"] === "string") {
      return { range: node, kind: baseKind, qualifiedName: qualify(scope, id["name"]), nameSource: "declared" };
    }
    if (parent?.type === "VariableDeclarator" && parent["init"] === child) {
      const target = parent["id"] as AstNode;
      if (target.type === "Identifier") {
        return { range: node, kind: baseKind, qualifiedName: qualify(scope, target["name"] as string), nameSource: "inferred" };
      }
    }
    if (parent?.type === "AssignmentExpression" && parent["right"] === child) {
      const target = parent["left"] as AstNode;
      const assigned = assignmentTargetName(target, scope.className, source);
      if (assigned) {
        return { range: node, kind: baseKind, qualifiedName: assigned.member ? assigned.name : qualify(scope, assigned.name), nameSource: "inferred" };
      }
    }
    if (parent?.type === "ExportDefaultDeclaration") {
      return { range: node, kind: baseKind, qualifiedName: "default", nameSource: "inferred" };
    }
    if ((parent?.type === "CallExpression" || parent?.type === "NewExpression") && parent["callee"] !== child) {
      const argumentsList = parent["arguments"] as AstNode[];
      const index = argumentsList.indexOf(child);
      const callee = calleeText(parent["callee"] as AstNode);
      const prefix = parent.type === "NewExpression" ? "new " : "";
      // A leading string literal usually labels the callback: `it("parses", () => …)`, `measure("symbols", () => …)`.
      const label = argumentsList[0] !== child ? stringLabel(argumentsList[0]) : undefined;
      const name = `${prefix}${callee}${label === undefined ? "" : `(${JSON.stringify(label)})`}#cb${index}`;
      return { range: node, kind: baseKind, qualifiedName: qualify(scope, name), nameSource: "context" };
    }
    if (parent?.type === "ReturnStatement" || (parent?.type === "ArrowFunctionExpression" && parent["body"] === child)) {
      return { range: node, kind: baseKind, qualifiedName: qualify(scope, "return"), nameSource: "context" };
    }
    const parentName = scope.entity?.qualifiedName ?? "";
    const ordinal = (ordinalByParent.get(parentName) ?? 0) + 1;
    ordinalByParent.set(parentName, ordinal);
    return { range: node, kind: baseKind, qualifiedName: qualify(scope, `anon#${ordinal}`), nameSource: "ordinal" };
  };

  const visit = (node: AstNode, parents: AstNode[], scope: Scope): void => {
    let innerScope = scope;
    if (FUNCTION_TYPES.has(node.type) && node["body"]) {
      const named = nameFunction(node, parents, scope);
      const wrapper = effectiveParent(node, parents).parent;
      const exported = wrapper?.type === "ExportNamedDeclaration" || wrapper?.type === "ExportDefaultDeclaration" ? wrapper.start : named.range.start;
      const entity = addEntity(node, named.range, scope, named.kind, named.qualifiedName, named.nameSource, exported);
      innerScope = { entity, ...(scope.className ? { className: scope.className } : {}) };
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      innerScope = { ...scope, className: qualify(scope, className(node, parents, source)) };
    }
    parents.push(node);
    for (const key in node) {
      if (key === "start" || key === "end" || key === "range" || key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) visit(item, parents, innerScope);
        }
      } else if (isNode(value)) {
        visit(value, parents, innerScope);
      }
    }
    parents.pop();
  };

  visit(program, [], {});
  entities.sort((left, right) => left.start - right.start || right.end - left.end);
  return {
    absoluteFile: options.absoluteFile,
    file: options.file,
    packageName: options.packageName,
    language,
    entities: [moduleEntity, ...entities],
    lineStarts: computeLineStarts(source),
    parseErrors: parsed.errors.length,
    source,
  };
}

/** Innermost entity whose range contains the offset; the module-init entity when none does. */
export function entityAtOffset(index: ModuleIndex, offset: number): IndexedEntity {
  let best = index.entities[0] as IndexedEntity;
  for (let position = 1; position < index.entities.length; position += 1) {
    const entity = index.entities[position] as IndexedEntity;
    if (entity.start > offset) break;
    if (offset < entity.end && entity.end - entity.start <= best.end - best.start) best = entity;
  }
  return best;
}

/** The innermost entity whose header contains the offset (module init has none). */
export function entityWithHeaderAt(index: ModuleIndex, offset: number): IndexedEntity | undefined {
  let best: IndexedEntity | undefined;
  for (let position = 1; position < index.entities.length; position += 1) {
    const entity = index.entities[position] as IndexedEntity;
    if (entity.headerStart > offset) continue;
    if (offset <= entity.bodyStart && (!best || entity.headerStart >= best.headerStart)) best = entity;
  }
  return best;
}

/** 0-based line and column (UTF-16 code units, as V8 reports them) → offset. */
export function offsetOf(index: ModuleIndex, line: number, column: number): number | undefined {
  const lineStart = index.lineStarts[line];
  return lineStart === undefined ? undefined : lineStart + column;
}

export function positionOf(index: ModuleIndex, offset: number): { line: number; column: number } {
  let low = 0;
  let high = index.lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((index.lineStarts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (index.lineStarts[low] as number) + 1 };
}

export function toEntity(index: ModuleIndex, indexed: IndexedEntity): Entity {
  const start = positionOf(index, indexed.start);
  const end = positionOf(index, Math.max(indexed.start, indexed.end - 1));
  return {
    identity: {
      key: indexed.key,
      fingerprint: indexed.node ? fingerprints(indexed.node) : { body: "", shape: "" },
      anchor: {
        package: index.packageName,
        module: index.file,
        qualifiedName: indexed.qualifiedName,
        nameSource: indexed.nameSource,
        ...(indexed.parentKey ? { parentKey: indexed.parentKey } : {}),
      },
    },
    kind: indexed.kind,
    source: {
      file: index.file,
      line: start.line,
      column: start.column,
      endLine: end.line,
      language: index.language,
      ...(indexed.kind === "module-init" ? {} : { async: indexed.async }),
    },
  };
}

/**
 * `body`: sha256 over the function's syntax tree without positions, comments, or its own name.
 * `shape`: the same with identifiers and literals normalized. Both are truncated to 16 hex digits.
 */
export function fingerprints(node: AstNode): { body: string; shape: string } {
  const body = createHash("sha256");
  const shape = createHash("sha256");
  const emit = (value: AstNode, root: boolean): void => {
    body.update(`(${value.type}`);
    shape.update(`(${value.type}`);
    for (const key in value) {
      if (key === "start" || key === "end" || key === "range" || key === "loc" || key === "type") continue;
      if (root && key === "id") continue;
      const field = value[key];
      if (Array.isArray(field)) {
        body.update(`[${key}`);
        shape.update(`[${key}`);
        for (const item of field) {
          if (isNode(item)) emit(item, false);
          else scalar(key, item, value.type);
        }
        body.update("]");
        shape.update("]");
      } else if (isNode(field)) {
        body.update(`:${key}`);
        shape.update(`:${key}`);
        emit(field, false);
      } else {
        scalar(key, field, value.type);
      }
    }
    body.update(")");
    shape.update(")");
  };
  const scalar = (key: string, field: unknown, type: string): void => {
    if (field === null || field === undefined || typeof field === "object") return;
    const text = `${key}=${typeof field === "bigint" ? `${field}n` : String(field)};`;
    body.update(text);
    if ((key === "name" && type.endsWith("Identifier")) || key === "raw" || key === "cooked") {
      shape.update(`${key}=$id;`);
    } else if (key === "value" && (type === "Literal" || type === "TemplateElement")) {
      shape.update(`${key}=$${typeof field === "string" ? "str" : typeof field === "number" ? "num" : typeof field};`);
    } else {
      shape.update(text);
    }
  };
  emit(node, true);
  return { body: body.digest("hex").slice(0, 16), shape: shape.digest("hex").slice(0, 16) };
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function effectiveParent(node: AstNode, parents: readonly AstNode[]): { parent: AstNode | undefined; child: AstNode } {
  let child = node;
  for (let position = parents.length - 1; position >= 0; position -= 1) {
    const parent = parents[position] as AstNode;
    if (!WRAPPERS.has(parent.type)) return { parent, child };
    child = parent;
  }
  return { parent: undefined, child };
}

function accessorPrefix(kind: string): string {
  return kind === "get" ? "get " : kind === "set" ? "set " : "";
}

function propertyKeyText(property: AstNode, source: string): string {
  const key = property["key"] as AstNode;
  if (property["computed"] === true) return `[${compact(source.slice(key.start, key.end))}]`;
  if (key.type === "Identifier") return key["name"] as string;
  if (key.type === "PrivateIdentifier") return `#${key["name"] as string}`;
  if (key.type === "Literal") return String(key["value"]);
  return compact(source.slice(key.start, key.end));
}

function className(node: AstNode, parents: readonly AstNode[], source: string): string {
  const id = node["id"] as AstNode | null;
  if (id && typeof id["name"] === "string") return id["name"];
  const { parent, child } = effectiveParent(node, parents);
  if (parent?.type === "VariableDeclarator" && parent["init"] === child) {
    const target = parent["id"] as AstNode;
    if (target.type === "Identifier") return target["name"] as string;
  }
  if (parent?.type === "ExportDefaultDeclaration") return "default";
  if (parent?.type === "AssignmentExpression") {
    const assigned = assignmentTargetName(parent["left"] as AstNode, undefined, source);
    if (assigned) return assigned.name;
  }
  return "(class)";
}

/** Name for an object literal that owns a method: its variable, property path, call argument slot, or `{}`. */
function objectName(objectNode: AstNode, parents: readonly AstNode[], source: string): string {
  const { parent, child } = effectiveParent(objectNode, parents);
  if (parent?.type === "VariableDeclarator" && parent["init"] === child) {
    const target = parent["id"] as AstNode;
    if (target.type === "Identifier") return target["name"] as string;
  }
  if (parent?.type === "Property" && parent["value"] === child) {
    const outer = parents[parents.indexOf(parent) - 1];
    const owner = outer ? objectName(outer, parents.slice(0, parents.indexOf(parent) - 1), source) : "{}";
    return `${owner}.${propertyKeyText(parent, source)}`;
  }
  if (parent?.type === "ExportDefaultDeclaration") return "default";
  if ((parent?.type === "CallExpression" || parent?.type === "NewExpression") && parent["callee"] !== child) {
    const index = (parent["arguments"] as AstNode[]).indexOf(child);
    return `${parent.type === "NewExpression" ? "new " : ""}${calleeText(parent["callee"] as AstNode)}#arg${index}`;
  }
  if (parent?.type === "AssignmentExpression" && parent["right"] === child) {
    const assigned = assignmentTargetName(parent["left"] as AstNode, undefined, source);
    if (assigned) return assigned.name;
  }
  if (parent?.type === "ReturnStatement") return "return";
  return "{}";
}

/** `this.x` inside a class → `Class.x` (a member name); `exports.x`/`module.exports.x` → `x`; `a.b` → `a.b`. */
function assignmentTargetName(target: AstNode, enclosingClass: string | undefined, source: string): { name: string; member: boolean } | undefined {
  if (target.type === "Identifier") return { name: target["name"] as string, member: false };
  if (target.type !== "MemberExpression") return undefined;
  const object = target["object"] as AstNode;
  const property = target["computed"] === true
    ? `[${compact(source.slice((target["property"] as AstNode).start, (target["property"] as AstNode).end))}]`
    : ((target["property"] as AstNode)["name"] as string);
  if (object.type === "ThisExpression") {
    return enclosingClass ? { name: `${enclosingClass}.${property}`, member: true } : { name: `this.${property}`, member: false };
  }
  const objectText = calleeText(object);
  if (objectText === "exports" || objectText === "module.exports") return { name: property, member: false };
  return { name: `${objectText}.${property}`, member: false };
}

function calleeText(node: AstNode): string {
  const text = memberChain(node);
  if (text.length <= 60) return text;
  const parts = text.split(".");
  return `….${parts.slice(-2).join(".")}`;
}

function memberChain(node: AstNode): string {
  switch (node.type) {
    case "Identifier":
      return node["name"] as string;
    case "ThisExpression":
      return "this";
    case "Super":
      return "super";
    case "MemberExpression": {
      const object = memberChain(node["object"] as AstNode);
      const property = node["property"] as AstNode;
      if (node["computed"] === true) {
        return property.type === "Literal" ? `${object}[${JSON.stringify(property["value"])}]` : `${object}[…]`;
      }
      return `${object}.${property.type === "PrivateIdentifier" ? "#" : ""}${property["name"] as string}`;
    }
    case "CallExpression":
      return `${memberChain(node["callee"] as AstNode)}()`;
    case "ChainExpression":
    case "ParenthesizedExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
      return memberChain(node["expression"] as AstNode);
    default:
      return "…";
  }
}

function stringLabel(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  let text: unknown;
  if (node.type === "Literal") text = node["value"];
  else if (node.type === "TemplateLiteral" && (node["expressions"] as unknown[]).length === 0) {
    text = ((node["quasis"] as AstNode[])[0]?.["value"] as { cooked?: unknown } | undefined)?.cooked;
  }
  return typeof text === "string" && text.length > 0 && text.length <= 40 && !/[\n\r]/.test(text) ? text : undefined;
}

function compact(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 40 ? `${single.slice(0, 39)}…` : single;
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let position = 0; position < source.length; position += 1) {
    const code = source.charCodeAt(position);
    if (code === 10) starts.push(position + 1);
    else if (code === 13 && source.charCodeAt(position + 1) !== 10) starts.push(position + 1);
  }
  return starts;
}

/** Lazily indexes project files and finds each file's package (nearest package.json up to the project root). */
export class EntityIndex {
  private readonly modules = new Map<string, ModuleIndex | null>();
  private readonly packageByDirectory = new Map<string, { name: string; root: string }>();

  constructor(readonly projectRoot: string) {}

  module(absoluteFile: string): ModuleIndex | undefined {
    const file = resolve(absoluteFile);
    let index = this.modules.get(file);
    if (index === undefined) {
      index = null;
      if (existsSync(file)) {
        try {
          const owner = this.packageOf(dirname(file));
          index = indexModuleSource(readFileSync(file, "utf8"), {
            absoluteFile: file,
            file: toPosix(relative(this.projectRoot, file)),
            packageName: owner.name,
            packagePath: toPosix(relative(owner.root, file)),
          });
        } catch {
          index = null;
        }
      }
      this.modules.set(file, index);
    }
    return index ?? undefined;
  }

  packageOf(directory: string): { name: string; root: string } {
    const cached = this.packageByDirectory.get(directory);
    if (cached) return cached;
    let owner: { name: string; root: string } | undefined;
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name;
        if (typeof name === "string" && name) owner = { name, root: directory };
      } catch {
        // Unreadable manifest: keep walking up.
      }
    }
    if (!owner) {
      const parent = dirname(directory);
      const atRoot = resolve(directory) === resolve(this.projectRoot) || parent === directory
        || relative(this.projectRoot, directory).startsWith("..");
      owner = atRoot ? { name: basename(resolve(this.projectRoot)), root: resolve(this.projectRoot) } : this.packageOf(parent);
    }
    this.packageByDirectory.set(directory, owner);
    return owner;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
