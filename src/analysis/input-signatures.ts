import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type * as ts from "typescript";
import type { InputRepetition } from "./model.js";

/**
 * Input-signature profiling (v0.2.6d, R3): runtime evidence that a call's inputs repeat across executions
 * (DYNAMICALLY_REPEATED), for hoisting candidates whose inputs come from parameters.
 *
 * `writeInputSignatureProbe` writes a Node `--import` module. A load hook serves patched copies of the
 * target files in which each probed call's arguments become `...globalThis.__cranktsSig("site", [args])`.
 * That keeps the callee, `this`, and the argument values unchanged. The runtime fingerprints the whole
 * argument list and each argument path (`args[i]`, and one level of own properties) and writes
 * `{ site: { calls, signatures, paths } }` to `CRANKTS_SIGNATURES_OUT` on exit. The original files are not
 * modified. `readInputSignatures` turns that file into `InputRepetition` per site.
 */

export interface ProbeSite {
  /** Absolute path of the source file. */
  readonly file: string;
  /**
   * The file that actually runs, when it differs from `file` (e.g. `dist/x.js` built by tsc from `src/x.ts`):
   * the call is located there by its enclosing function name, callee text, and occurrence.
   */
  readonly executedFile?: string;
  /** The call (or `new`) expression whose arguments are fingerprinted. */
  readonly call: ts.CallExpression | ts.NewExpression;
  /** Site key, `<relative file>:<line>:<column>` (1-based), as in `HoistCandidate`. */
  readonly key: string;
}

export function siteKey(projectRoot: string, file: string, line: number, column: number): string {
  return `${relative(projectRoot, file).split(sep).join("/")}:${line}:${column}`;
}

export function writeInputSignatureProbe(
  sites: readonly ProbeSite[],
  outDir: string,
  /** Kept for API compatibility; calls are located at load time with CrankTS's own TypeScript parser. */
  typescript?: typeof ts,
): { readonly importPath: string } {
  void typescript;
  const directory = resolve(outDir);
  mkdirSync(directory, { recursive: true });
  // Each probed call is described by where it is, not by offsets: the enclosing named function, the callee
  // text, and its occurrence among same-callee calls there. The load hook finds it again in whatever source
  // the loader chain produces (TypeScript, tsx/esbuild output, or tsc-built dist files).
  const targets: Record<string, Array<{ key: string; owner: string | null; callee: string; occurrence: number }>> = {};
  for (const site of sites) {
    const descriptor = describeCall(site.call);
    if (!descriptor) continue;
    // Node loads modules by real path (a symlinked checkout, /var -> /private/var on macOS): key the targets that way.
    const location = site.executedFile ?? site.file;
    const url = pathToFileURL(existsSync(location) ? realpathSync(location) : location).href;
    (targets[url] ??= []).push({ key: site.key, ...descriptor });
  }
  const typescriptPath = createRequire(import.meta.url).resolve("typescript");
  writeFileSync(join(directory, "hooks.mjs"), `import { createRequire } from "node:module";
const ts = createRequire(${JSON.stringify(typescriptPath)})("typescript");
const targets = ${JSON.stringify(targets, null, 2)};
const isJs = (url) => /\\.[cm]?jsx?$/.test(url);
// Calls are matched by their last identifier: loaders rewrite imported calls (foo() becomes (0, import_x.foo)()).
function calleeKey(text) {
  const compact = text.replace(/\\s+/g, "");
  const match = /([A-Za-z_$][\\w$]*)\\)?$/.exec(compact);
  return match ? match[1] : compact;
}
function functionName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.getText();
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText();
  return null;
}
function locate(sourceFile, target) {
  let owner = sourceFile;
  if (target.owner !== null) {
    owner = undefined;
    const find = (node) => { if (owner) return; if (ts.isFunctionLike(node) && functionName(node) === target.owner) { owner = node; return; } node.forEachChild(find); };
    find(sourceFile);
    if (!owner) return undefined;
  }
  const calls = [];
  const visit = (node) => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && calleeKey(node.expression.getText()) === target.callee) calls.push(node);
    node.forEachChild(visit);
  };
  visit(owner);
  const call = calls[target.occurrence];
  return call && call.arguments ? { start: call.arguments.pos, end: call.arguments.end } : undefined;
}
// Rewrites the arguments of the probed calls in one module's code (any loader's output: TypeScript, tsx/esbuild
// JavaScript, tsc-built files). Returns undefined when there is nothing to do or the code was already patched.
export function patch(url, code) {
  const list = targets[url.split("?")[0]];
  if (!list || code.includes("/*crankts*/")) return undefined;
  let text = code;
  const sourceFile = ts.createSourceFile(url, text, ts.ScriptTarget.Latest, true, isJs(url) && !/\\.ts/.test(url) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const edits = list.map((target) => ({ target, range: locate(sourceFile, target) })).filter((edit) => edit.range);
  for (const edit of list.filter((target) => !edits.some((found) => found.target === target))) process._rawDebug("[crankts probe] not found: " + edit.key);
  edits.sort((left, right) => right.range.start - left.range.start);
  for (const { target, range } of edits) {
    text = text.slice(0, range.start) + "/*crankts*/...globalThis.__cranktsSig(" + JSON.stringify(target.key) + ", [" + text.slice(range.start, range.end) + "])" + text.slice(range.end);
  }
  return text;
}
// Synchronous, in-thread hook (module.registerHooks): sees ES modules and plain CommonJS source. CommonJS modules that a
// loader such as tsx compiles itself never pass their code through here; the probe patches their compile step instead.
export function load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (result.source == null) return result;
  const code = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
  const patched = patch(url, code);
  return patched === undefined ? result : { ...result, source: patched };
}
`);
  writeFileSync(join(directory, "probe.mjs"), `// Generated by CrankTS (input-signature profiling). Use: node --import <this file> <program>
import Module, { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { load, patch } from "./hooks.mjs";
// ES modules and plain CommonJS go through the load hook. Node 22 rejects the source that tsx 4 returns for TypeScript
// loaded through require() as soon as any synchronous load hook is registered, so with such a loader the hook needs Node >= 24.
const loaders = process.execArgv.join(" ") + " " + (process.env.NODE_OPTIONS ?? "");
if (Number(process.versions.node.split(".")[0]) >= 24 || !/tsx|ts-node/.test(loaders)) registerHooks({ load });
else process._rawDebug("[crankts probe] Node " + process.versions.node + " with a TypeScript loader: ES module sources are not instrumented (use Node >= 24)");
// CommonJS modules compiled by a loader (tsx, ts-node) reach Module.prototype._compile as transpiled JavaScript.
const compile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  const patched = typeof content === "string" ? patch(pathToFileURL(filename).href, content) : undefined;
  return compile.call(this, patched === undefined ? content : patched, filename);
};

const ids = new WeakMap();
let nextId = 0;
const identity = (value) => {
  let id = ids.get(value);
  if (id === undefined) { id = ++nextId; ids.set(value, id); }
  return id;
};
/** Structural fingerprint; functions and class instances by identity, collections capped. */
function fingerprint(value, depth = 0) {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? "fn#" + identity(value) : typeof value + ":" + String(value);
  }
  if (depth >= 4) return "deep#" + identity(value);
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < Math.min(value.length, 2000); i++) parts.push(fingerprint(value[i], depth + 1));
    return "[" + value.length + ":" + parts.join(",") + "]";
  }
  if (value instanceof Set) return "Set" + fingerprint([...value], depth);
  if (value instanceof Map) return "Map" + fingerprint([...value], depth);
  if (value instanceof RegExp) return "re:" + String(value);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "obj#" + identity(value);
  return "{" + Object.keys(value).sort().map((key) => key + "=" + fingerprint(value[key], depth + 1)).join(",") + "}";
}
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ":" + text.length;
}
const sites = new Map();
/** Whole-argument content hash → the sites it was seen at (duplicate processing across call sites). */
const contentSites = new Map();
/** Arrays reachable from the arguments through plain objects (depth <= 2), with their paths. */
function collections(args) {
  const found = [];
  const visit = (value, path, depth) => {
    if (Array.isArray(value)) { if (value.length >= 10) found.push([path, value]); return; }
    if (depth >= 2 || !value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return;
    for (const key of Object.keys(value)) visit(value[key], path + "." + key, depth + 1);
  };
  args.forEach((arg, i) => visit(arg, "args[" + i + "]", 0));
  return found;
}
globalThis.__cranktsSig = (key, args) => {
  let site = sites.get(key);
  if (!site) { site = { calls: 0, signatures: new Set(), paths: new Map(), identity: new Map() }; sites.set(key, site); }
  site.calls += 1;
  // Sampling budget: fingerprinting costs more than a hot call itself (a 500k-call workload ran 100x slower unsampled).
  // The first 2,000 calls are exact, then every 4th up to 20,000 calls, then every 64th; counts stay exact.
  const every = site.calls <= 2000 ? 1 : site.calls <= 20000 ? 4 : 64;
  if (site.calls % every !== 0) return args;
  site.sampled = (site.sampled ?? 0) + 1;
  const parts = args.map((arg) => fingerprint(arg));
  const whole = hash(parts.join("|"));
  site.signatures.add(whole);
  // Content weight: what the inputs say about values, not which objects they are. Identity-only inputs
  // (no arguments, mutable buffers and class instances fingerprinted by reference) repeat trivially.
  const content = parts.join("|").replace(/(?:fn|obj|deep)#\d+/g, "").length >= 16;
  if (content) site.contentCalls = (site.contentCalls ?? 0) + 1;
  // Per-site budget for the shared-content index, so one very hot call cannot crowd out the others.
  site.indexed ??= 0;
  if (content && (contentSites.has(whole) || site.indexed < 200000)) {
    if (!contentSites.has(whole)) site.indexed += 1;
    let seenAt = contentSites.get(whole);
    if (!seenAt) { seenAt = new Set(); contentSites.set(whole, seenAt); }
    seenAt.add(key);
  }
  // Identity overlap: the share of one collection's elements that are the very same objects in another.
  const lists = collections(args);
  for (let a = 0; a < lists.length; a++) {
    for (let b = 0; b < lists.length; b++) {
      if (a === b) continue;
      const [pathA, listA] = lists[a];
      const [pathB, listB] = lists[b];
      const refs = new Set(listA.length > 200000 ? listA.slice(0, 200000) : listA);
      let same = 0;
      const n = Math.min(listB.length, 200000);
      for (let i = 0; i < n; i++) if (refs.has(listB[i])) same++;
      const pair = pathB + " in " + pathA;
      const entry = site.identity.get(pair) ?? { calls: 0, overlap: 0, elements: 0 };
      entry.calls += 1; entry.overlap += n > 0 ? same / n : 0; entry.elements += n;
      site.identity.set(pair, entry);
    }
  }
  const record = (path, fp) => {
    let entry = site.paths.get(path);
    if (!entry) { entry = { calls: 0, distinct: new Set() }; site.paths.set(path, entry); }
    entry.calls += 1;
    if (entry.distinct.size < 100000) entry.distinct.add(hash(fp));
  };
  // A path counts when its value is large enough to be compiled input (pattern lists, source text, schemas):
  // a fingerprint of at least 200 characters. Small option objects are always "repeated" and say nothing.
  const substantial = (fp) => fp.length >= 200;
  args.forEach((arg, i) => {
    if (substantial(parts[i])) record("args[" + i + "]", parts[i]);
    if (arg && typeof arg === "object" && !Array.isArray(arg) && Object.getPrototypeOf(arg) === Object.prototype) {
      for (const key of Object.keys(arg)) {
        const fp = fingerprint(arg[key], 1);
        if (substantial(fp)) record("args[" + i + "]." + key, fp);
      }
    }
  });
  return args;
};
process.on("exit", () => {
  const out = process.env.CRANKTS_SIGNATURES_OUT;
  if (!out) return;
  const json = {};
  for (const [key, site] of sites) {
    const shared = {};
    for (const content of site.signatures) {
      for (const other of contentSites.get(content) ?? []) if (other !== key) shared[other] = (shared[other] ?? 0) + 1;
    }
    json[key] = {
      calls: site.calls,
      sampled: site.sampled ?? 0,
      contentCalls: site.contentCalls ?? 0,
      signatures: site.signatures.size,
      paths: Object.fromEntries([...site.paths].map(([path, entry]) => [path, { calls: entry.calls, distinct: entry.distinct.size }])),
      shared,
      identity: Object.fromEntries([...site.identity].map(([pair, entry]) => [pair, { calls: entry.calls, meanOverlap: entry.overlap / entry.calls, meanElements: entry.elements / entry.calls }])),
    };
  }
  writeFileSync(out, JSON.stringify(json, null, 2));
});
`);
  return { importPath: join(directory, "probe.mjs") };
}

interface RawSignatures {
  readonly [site: string]: {
    readonly calls: number;
    readonly sampled?: number;
    readonly contentCalls?: number;
    readonly signatures: number;
    readonly paths: Readonly<Record<string, { readonly calls: number; readonly distinct: number }>>;
    readonly shared?: Readonly<Record<string, number>>;
    readonly identity?: Readonly<Record<string, { readonly calls: number; readonly meanOverlap: number; readonly meanElements: number }>>;
  };
}

/** Site key → repetition. Several runs (files) are merged by summing calls and taking the larger counts. */
export function readInputSignatures(files: readonly string[]): ReadonlyMap<string, InputRepetition> {
  const merged = new Map<string, {
    calls: number;
    sampled: number;
    contentCalls: number;
    signatures: number;
    paths: Map<string, { calls: number; distinct: number }>;
    shared: Map<string, number>;
    identity: Map<string, { calls: number; overlap: number; elements: number }>;
  }>();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as RawSignatures;
    for (const [key, site] of Object.entries(raw)) {
      const entry = merged.get(key) ?? { calls: 0, sampled: 0, contentCalls: 0, signatures: 0, paths: new Map(), shared: new Map(), identity: new Map() };
      entry.calls += site.calls;
      entry.sampled += site.sampled ?? site.calls;
      entry.contentCalls += site.contentCalls ?? site.calls;
      entry.signatures = Math.max(entry.signatures, site.signatures);
      for (const [other, count] of Object.entries(site.shared ?? {})) entry.shared.set(other, Math.max(entry.shared.get(other) ?? 0, count));
      for (const [pair, stats] of Object.entries(site.identity ?? {})) {
        const previous = entry.identity.get(pair) ?? { calls: 0, overlap: 0, elements: 0 };
        entry.identity.set(pair, { calls: previous.calls + stats.calls, overlap: previous.overlap + stats.meanOverlap * stats.calls, elements: previous.elements + stats.meanElements * stats.calls });
      }
      for (const [path, stats] of Object.entries(site.paths)) {
        const previous = entry.paths.get(path) ?? { calls: 0, distinct: 0 };
        entry.paths.set(path, { calls: previous.calls + stats.calls, distinct: Math.max(previous.distinct, stats.distinct) });
      }
      merged.set(key, entry);
    }
  }
  const reuse = (distinct: number, calls: number): number => (calls > 0 ? Math.round((1 - distinct / calls) * 1000) / 1000 : 0);
  return new Map([...merged].map(([key, site]) => {
    // Only paths seen in at least half of the calls: a path present in a few calls says little.
    const best = [...site.paths]
      .filter(([, stats]) => stats.calls * 2 >= site.sampled)
      .map(([path, stats]) => ({ path, distinct: stats.distinct, reuseRatio: reuse(stats.distinct, stats.calls) }))
      .sort((left, right) => right.reuseRatio - left.reuseRatio)[0];
    const identity = [...site.identity]
      .map(([pair, stats]) => ({ pair, meanOverlap: Math.round((stats.overlap / stats.calls) * 1000) / 1000, meanElements: Math.round(stats.elements / stats.calls), calls: stats.calls }))
      .sort((left, right) => right.meanOverlap - left.meanOverlap);
    const shared = [...site.shared]
      .map(([other, distinct]) => ({ site: other, distinct, shareOfDistinct: site.signatures > 0 ? Math.round((distinct / site.signatures) * 1000) / 1000 : 0 }))
      .sort((left, right) => right.distinct - left.distinct);
    const repetition: InputRepetition = {
      calls: site.calls,
      ...(site.sampled < site.calls ? { sampledCalls: site.sampled } : {}),
      contentCalls: site.contentCalls,
      distinctSignatures: site.signatures,
      reuseRatio: reuse(site.signatures, site.sampled),
      ...(best ? { bestPath: best } : {}),
      ...(identity.length > 0 ? { identity } : {}),
      ...(shared.length > 0 ? { sharedWith: shared } : {}),
    };
    return [key, repetition];
  }));
}

/** Enclosing named function, normalized callee text, and occurrence index among same-callee calls there. */
function describeCall(call: ts.CallExpression | ts.NewExpression): { owner: string | null; callee: string; occurrence: number } | undefined {
  const sourceFile = call.getSourceFile();
  const callee = calleeKey(call.expression.getText(sourceFile));
  let owner: ts.Node | undefined = call.parent;
  let ownerName: string | undefined;
  while (owner && !(ownerName = nameOf(owner))) owner = owner.parent;
  const scope = owner ?? sourceFile;
  const calls: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if ((node.kind === call.kind) && "expression" in node && calleeKey((node as ts.CallExpression).expression.getText(sourceFile)) === callee) calls.push(node);
    node.forEachChild(visit);
  };
  visit(scope);
  const occurrence = calls.indexOf(call);
  return occurrence < 0 ? undefined : { owner: ownerName ?? null, callee, occurrence };
}

/** Calls are matched by their last identifier: loaders rewrite imported calls (`foo()` becomes `(0, import_x.foo)()`). */
function calleeKey(text: string): string {
  const compact = text.replace(/\s+/g, "");
  return /([A-Za-z_$][\w$]*)\)?$/.exec(compact)?.[1] ?? compact;
}

function nameOf(node: ts.Node): string | undefined {
  // Structural checks only (no TypeScript module needed): named functions, methods, and `const f = (…) => …`.
  const named = node as { name?: { getText(): string }; kind: number; parent?: ts.Node };
  const isFunctionLike = "body" in node && "parameters" in node;
  if (!isFunctionLike) return undefined;
  if (named.name && typeof named.name.getText === "function") return named.name.getText();
  const parent = node.parent as (ts.Node & { name?: { getText(): string }; initializer?: ts.Node }) | undefined;
  if (parent && parent.initializer === node && parent.name) return parent.name.getText();
  return undefined;
}
