import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as ts from "typescript";
import { createCompilerFacade } from "../compiler/compiler-facade.js";
import { packageRootFromUrl } from "./cpu-profile.js";
import { collectFunctions, type FunctionIndex } from "./functions.js";
import { siteKey, writeInputSignatureProbe, type ProbeSite } from "./input-signatures.js";
import type { AnalysisResult, Effect, FunctionAnalysis, FunctionId, InputRepetition } from "./model.js";

/**
 * Workload evidence for diagnosis (v0.2.6e). Instead of one recognizer per kind of waste, CrankTS probes the
 * expensive calls around the hottest call sites and records generic facts: how often a call runs, whether its
 * inputs repeat, whether two collections it receives contain the same objects, and whether the same content
 * reaches several call sites. `derivePhenomena` turns those facts into hypotheses with an upper bound on the
 * time at stake. The hypotheses are evidence for a human or an agent to check, not transformations.
 *
 * Probed calls, for each call site with at least `minSitePercent` of attributed time (the top `maxSites`):
 * - calls inside it into a dependency entry or a project function costing at least `minCalleePercent`
 * - the call edges along its dominant profile-weighted caller path (who passes what down to it)
 * - its HOIST_INVARIANT_WORK candidates
 */

export type ProbeRole = "INNER_CALL" | "CALLER_EDGE" | "HOIST_CANDIDATE";

export interface ProbedCall {
  readonly key: string;
  readonly role: ProbeRole;
  /** The function that contains the call. */
  readonly functionId: FunctionId;
  readonly callee: string;
  /** The project function the call goes to, if any (recursive calls are not reported as recomputation). */
  readonly calleeFunctionId?: FunctionId;
  /** Static effects of the project callee (`effects.ts`), when the call goes to a project function. */
  readonly calleeEffects?: readonly Effect[];
  /** Profiled cost of what the call runs, in percent of runtime (dependency entry or callee inclusive time). */
  readonly costPercent: number;
}

export interface EvidenceProbeOptions {
  readonly minSitePercent?: number;
  readonly maxSites?: number;
  readonly minCalleePercent?: number;
  readonly workspaceReferences?: boolean;
}

export function writeEvidenceProbe(
  target: string,
  analysis: AnalysisResult,
  outDir: string,
  options: EvidenceProbeOptions = {},
): { readonly importPath: string; readonly probed: readonly ProbedCall[] } {
  const facade = createCompilerFacade(target, { workspaceReferences: options.workspaceReferences === true });
  const index = collectFunctions(facade);
  const total = Math.max(1, analysis.cpuProfile?.totalSampleMicros ?? 1);
  const effectsOf = new Map(analysis.functions.map((fn) => [fn.id, fn.effects]));
  const inclusive = new Map(analysis.functions.map((fn) => [fn.id, ((fn.observedCpu?.totalCpuMicros ?? 0) / total) * 100]));
  const minCallee = options.minCalleePercent ?? 1;
  const sites = analysis.functions
    .filter((fn) => (fn.observedCpu?.callSite?.attributedPercent ?? 0) >= (options.minSitePercent ?? 2))
    .sort((left, right) => (right.observedCpu?.callSite?.attributedMicros ?? 0) - (left.observedCpu?.callSite?.attributedMicros ?? 0))
    .slice(0, options.maxSites ?? 10);

  const probes = new Map<ts.Node, { site: ProbeSite; info: ProbedCall }>();
  const add = (fn: FunctionAnalysis, call: ts.CallExpression | ts.NewExpression, role: ProbeRole, costPercent: number, calleeFunctionId?: FunctionId): void => {
    if (probes.has(call)) return;
    const definition = index.byId.get(fn.id);
    if (!definition) return;
    const sourceFile = call.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
    const key = siteKey(facade.projectRoot, definition.absoluteFile, position.line + 1, position.character + 1);
    const executedFile = builtCounterpart(definition.absoluteFile);
    probes.set(call, {
      site: { file: definition.absoluteFile, call, key, ...(executedFile ? { executedFile } : {}) },
      info: {
        key, role, functionId: fn.id, callee: call.expression.getText(sourceFile).slice(0, 80), costPercent: round(costPercent),
        ...(calleeFunctionId ? { calleeFunctionId } : {}),
        ...(calleeFunctionId && effectsOf.has(calleeFunctionId) ? { calleeEffects: effectsOf.get(calleeFunctionId) ?? [] } : {}),
      },
    });
  };

  for (const fn of sites) {
    const definition = index.byId.get(fn.id);
    const site = fn.observedCpu?.callSite;
    if (!definition || !site) continue;
    const t = definition.compilerFacade.typescript;
    const checker = definition.compilerFacade.checker;
    // Calls inside the site into something expensive.
    for (const call of callsIn(t, definition.node)) {
      const callee = resolveCallee(t, checker, index, call);
      const cost = callee.functionId !== undefined
        ? inclusive.get(callee.functionId) ?? 0
        : site.entries?.filter((entry) => callee.packageName !== undefined && entry.origin === callee.packageName && entry.functionName.split(".").pop() === callee.name)
          .reduce((sum, entry) => sum + entry.percent, 0) ?? 0;
      if (cost >= minCallee) add(fn, call, "INNER_CALL", cost, callee.functionId);
    }
    // Edges along the dominant caller path: what each caller passes down.
    const chain = [fn.id, ...(site.callerPaths?.[0]?.path ?? [])];
    for (let level = 0; level + 1 < chain.length; level += 1) {
      const calleeId = chain[level] as FunctionId;
      const callerId = chain[level + 1] as FunctionId;
      const caller = analysis.functions.find((candidate) => candidate.id === callerId);
      const callerDefinition = index.byId.get(callerId);
      if (!caller || !callerDefinition) continue;
      const t = callerDefinition.compilerFacade.typescript;
      for (const call of callsIn(t, callerDefinition.node)) {
        if (resolveCallee(t, callerDefinition.compilerFacade.checker, index, call).functionId === calleeId) {
          add(caller, call, "CALLER_EDGE", inclusive.get(calleeId) ?? 0, calleeId);
        }
      }
    }
    // Hoisting candidates of the site.
    for (const candidate of fn.hoistCandidates ?? []) {
      const call = callsIn(t, definition.node).find((node) => {
        const position = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
        return position.line + 1 === candidate.line && position.character + 1 === candidate.column;
      });
      if (call && candidate.invariance !== "LOOP_INVARIANT") add(fn, call, "HOIST_CANDIDATE", candidate.atStakePercent ?? 0);
    }
  }

  const all = [...probes.values()];
  const firstFacade = index.definitions[0]?.compilerFacade;
  const probe = writeInputSignatureProbe(all.map((entry) => entry.site), outDir, firstFacade?.typescript);
  const probed = all.map((entry) => entry.info);
  writeFileSync(join(outDir, "probed-calls.json"), JSON.stringify(probed, null, 2));
  return { importPath: probe.importPath, probed };
}

export function readProbedCalls(outDir: string): ProbedCall[] {
  const file = join(outDir, "probed-calls.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as ProbedCall[] : [];
}

// --- phenomena ---------------------------------------------------------------------------------

export type PhenomenonKind = "REDUNDANT_WORK_ON_IDENTICAL_OBJECTS" | "DUPLICATE_PROCESSING" | "RECOMPUTATION" | "INVARIANT_ARGUMENT";

export interface Phenomenon {
  readonly kind: PhenomenonKind;
  readonly functionId: FunctionId;
  readonly call: string;
  readonly callee: string;
  /** Upper bound on the runtime share the phenomenon could account for. */
  readonly upperBoundPercent: number;
  readonly evidence: readonly string[];
  readonly hypothesis: string;
}

/**
 * Hypotheses from measured facts, with deliberately simple thresholds:
 * - REDUNDANT_WORK_ON_IDENTICAL_OBJECTS: a call receives two collections where >= 90% of one's elements are the
 *   same objects as in the other; per-element work on them (serialize, hash, compare) cannot find differences.
 * - DUPLICATE_PROCESSING: calls in the same function receive the same content (>= 50% of distinct inputs shared).
 * - RECOMPUTATION: a call repeats with the same content-bearing inputs (whole-call reuse >= 0.75 over >= 90%
 *   content-bearing calls); identity-only inputs (no arguments, mutable buffers) are not evidence.
 * - INVARIANT_ARGUMENT: otherwise, one substantial argument (fingerprint >= 200 chars) repeats (reuse >= 0.9)
 *   while the call as a whole does not; work the callee derives from it alone could be hoisted. The bound is
 *   coarse (the callee's whole cost), since the share derived from that argument is not measured.
 */
export function derivePhenomena(probed: readonly ProbedCall[], evidence: ReadonlyMap<string, InputRepetition>): Phenomenon[] {
  const byKey = new Map(probed.map((call) => [call.key, call]));
  const phenomena: Phenomenon[] = [];
  const reported = new Set<string>();
  for (const call of probed) {
    const facts = evidence.get(call.key);
    if (!facts) continue;
    const identity = facts.identity?.find((entry) => entry.meanOverlap >= 0.9 && entry.meanElements >= 10);
    if (identity) {
      phenomena.push({
        kind: "REDUNDANT_WORK_ON_IDENTICAL_OBJECTS",
        functionId: call.functionId,
        call: call.key,
        callee: call.callee,
        upperBoundPercent: round(call.costPercent * identity.meanOverlap),
        evidence: [`${identity.pair}: ${(identity.meanOverlap * 100).toFixed(1)}% same objects (mean ${identity.meanElements} elements, ${identity.calls} calls)`, `callee cost ${call.costPercent}%`],
        hypothesis: `\`${call.callee}\` receives collections whose elements are mostly the same objects; per-element work that compares or fingerprints them cannot find a difference for those. Skipping identical objects (reference check) would remove up to that share of its cost.`,
      });
    }
    const writes = (call.calleeEffects ?? []).some((effect) => WRITING_EFFECTS.has(effect));
    const duplicates = writes ? [] : (facts.sharedWith ?? []).filter((other) => other.shareOfDistinct >= 0.5 && byKey.get(other.site)?.functionId === call.functionId);
    if (duplicates.length > 0) {
      const group = [call.key, ...duplicates.map((other) => other.site)].sort();
      const groupKey = group.join("|");
      if (!reported.has(groupKey)) {
        reported.add(groupKey);
        const cost = Math.max(...group.map((key) => byKey.get(key)?.costPercent ?? 0));
        phenomena.push({
          kind: "DUPLICATE_PROCESSING",
          functionId: call.functionId,
          call: call.key,
          callee: call.callee,
          upperBoundPercent: round((cost * (group.length - 1)) / group.length),
          evidence: duplicates.map((other) => `same content as ${other.site}: ${(other.shareOfDistinct * 100).toFixed(0)}% of ${facts.distinctSignatures} distinct inputs`),
          hypothesis: `${group.length} calls in the same function process the same content (${group.map((key) => byKey.get(key)?.callee ?? key).join(", ")}). Doing the work once and reusing it would remove up to ${group.length - 1} of ${group.length} shares.`,
        });
      }
    }
    // Whole-call repetition over content-bearing inputs only. A single repeating argument path is a hoisting
    // signal (HOIST_INVARIANT_WORK), not recomputation of the call; identity-only inputs repeat trivially.
    const reuse = facts.reuseRatio;
    // Recursive calls repeat small sub-values by nature (a serializer on its leaves); not a caching signal.
    const recursive = call.calleeFunctionId !== undefined && call.calleeFunctionId === call.functionId;
    // A callee that writes outer state or its arguments is called for its effect: repeating inputs do not mean
    // a repeating, reusable result. (Reads alone do not disqualify: module constants count as reads.)
    if ((call.calleeEffects ?? []).some((effect) => WRITING_EFFECTS.has(effect))) continue;
    const contentShare = facts.contentCalls === undefined ? 1 : facts.contentCalls / Math.max(1, facts.calls);
    if (!recursive && contentShare >= 0.9 && reuse >= 0.75 && facts.calls >= 10 && call.costPercent >= 0.5) {
      phenomena.push({
        kind: "RECOMPUTATION",
        functionId: call.functionId,
        call: call.key,
        callee: call.callee,
        upperBoundPercent: round(call.costPercent * reuse),
        evidence: [`${facts.calls} calls, ${facts.distinctSignatures} distinct inputs (reuse ${reuse})`, `callee cost ${call.costPercent}%`],
        hypothesis: `\`${call.callee}\` is called again and again with inputs that repeat; caching or hoisting its result by those inputs would remove up to the repeated share.`,
      });    } else if (!recursive && facts.bestPath && facts.bestPath.reuseRatio >= 0.9 && facts.calls >= 10 && call.costPercent >= 0.5) {
      phenomena.push({
        kind: "INVARIANT_ARGUMENT",
        functionId: call.functionId,
        call: call.key,
        callee: call.callee,
        upperBoundPercent: round(call.costPercent * facts.bestPath.reuseRatio),
        evidence: [`${facts.bestPath.path}: ${facts.bestPath.distinct} distinct values over ${facts.calls} calls (reuse ${facts.bestPath.reuseRatio}); whole call reuse ${facts.reuseRatio}`, `callee cost ${call.costPercent}% (coarse bound)`],
        hypothesis: `\`${call.callee}\` receives the same \`${facts.bestPath.path}\` again and again while other inputs vary; whatever it derives from that argument alone (compiled patterns, resolved config, indexes) could be prepared once.`,
      });
    }
  }
  // One entry per kind, function, and callee: unrolled code calls the same callee from many sites.
  const merged = new Map<string, Phenomenon & { sites: number }>();
  for (const phenomenon of phenomena) {
    const key = `${phenomenon.kind}\u0001${phenomenon.functionId}\u0001${phenomenon.callee}`;
    const previous = merged.get(key);
    if (!previous) merged.set(key, { ...phenomenon, sites: 1 });
    else merged.set(key, { ...(previous.upperBoundPercent >= phenomenon.upperBoundPercent ? previous : phenomenon), sites: previous.sites + 1 });
  }
  return [...merged.values()]
    .map(({ sites, ...phenomenon }) => (sites > 1 ? { ...phenomenon, evidence: [...phenomenon.evidence, `${sites} call sites`] } : phenomenon))
    .sort((left, right) => right.upperBoundPercent - left.upperBoundPercent);
}

const WRITING_EFFECTS: ReadonlySet<Effect> = new Set(["MUTATES_ARGUMENT", "MUTATES_GLOBAL_STATE", "WRITES_EXTERNAL_STATE", "UNKNOWN_SIDE_EFFECT"]);

// --- helpers -------------------------------------------------------------------------------------

/** Calls in a function body, including inline callbacks, excluding nested named functions. */
function callsIn(t: typeof ts, fn: ts.Node): Array<ts.CallExpression | ts.NewExpression> {
  const calls: Array<ts.CallExpression | ts.NewExpression> = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && (t.isFunctionDeclaration(node) || t.isMethodDeclaration(node) || t.isClassLike(node))) return;
    if (t.isCallExpression(node) || t.isNewExpression(node)) calls.push(node);
    node.forEachChild(visit);
  };
  visit(fn);
  return calls;
}

function resolveCallee(
  t: typeof ts,
  checker: ts.TypeChecker,
  index: FunctionIndex,
  call: ts.CallExpression | ts.NewExpression,
): { functionId?: FunctionId; packageName?: string; name: string } {
  const calleeNode = t.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  const name = t.isIdentifier(calleeNode) ? calleeNode.text : calleeNode.getText();
  let symbol = checker.getSymbolAtLocation(calleeNode);
  if (symbol && symbol.flags & t.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const functionId = symbol ? index.symbolToFunction.get(symbol) : undefined;
  if (functionId) return { functionId, name };
  for (const declaration of symbol?.declarations ?? []) {
    const id = index.byNode.get(declaration) ?? (t.isVariableDeclaration(declaration) && declaration.initializer ? index.byNode.get(declaration.initializer) : undefined);
    if (id) return { functionId: id, name };
  }
  const file = symbol?.declarations?.[0]?.getSourceFile().fileName ?? "";
  const root = /\/node_modules\/(?:typescript\/lib|@types)\//.test(file) ? undefined : packageRootFromUrl(file);
  return { ...(root ? { packageName: root.split("/node_modules/").pop() ?? "" } : {}), name };
}

/** `…/src/x.ts` → `…/dist/x.js` when that tsc output exists (the code that actually runs). */
function builtCounterpart(file: string): string | undefined {
  const match = /^(.*)\/src\/(.*)\.(c|m)?tsx?$/.exec(file);
  if (!match) return undefined;
  const built = `${match[1]}/dist/${match[2]}.${match[3] ?? ""}js`;
  return existsSync(built) ? built : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
