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
  /** Mutable outer state the project callee reads (its body only); empty when none, undefined when unknown. */
  readonly calleeReadsMutableState?: readonly string[];
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
    const calleeDefinition = calleeFunctionId ? index.byId.get(calleeFunctionId) : undefined;
    probes.set(call, {
      site: { file: definition.absoluteFile, call, key, ...(executedFile ? { executedFile } : {}) },
      info: {
        key, role, functionId: fn.id, callee: call.expression.getText(sourceFile).slice(0, 80), costPercent: round(costPercent),
        ...(calleeFunctionId ? { calleeFunctionId } : {}),
        ...(calleeFunctionId && effectsOf.has(calleeFunctionId) ? { calleeEffects: effectsOf.get(calleeFunctionId) ?? [] } : {}),
        ...(calleeDefinition ? { calleeReadsMutableState: mutableOuterReads(calleeDefinition.compilerFacade.typescript, calleeDefinition.compilerFacade.checker, calleeDefinition.node) } : {}),
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

/** Measured facts; they imply no optimization by themselves. */
export type ObservationKind = "IDENTICAL_OBJECT_FLOW" | "DUPLICATE_CONTENT_FLOW" | "REPEATED_INPUT" | "REPEATED_ARGUMENT";

/** What could be done about an observation, if its preconditions hold. */
export type HypothesisKind = "AVOID_REDUNDANT_WORK" | "AVOID_DUPLICATE_PROCESSING" | "CACHE_RESULT" | "HOIST_ARGUMENT_WORK";

export type PreconditionStatus = "MET" | "UNVERIFIED" | "VIOLATED";

export interface Precondition {
  readonly name: string;
  readonly status: PreconditionStatus;
  readonly detail?: string;
}

export interface Hypothesis {
  readonly kind: HypothesisKind;
  readonly text: string;
  readonly preconditions: readonly Precondition[];
  /**
   * Upper bound minus what the remedy itself costs, where a simple model exists (cache lookups); undefined when
   * there is no model. Only a validated gain is the truth: this is an estimate.
   */
  readonly estimatedAvoidablePercent?: number;
}

export interface Phenomenon {
  readonly observation: ObservationKind;
  readonly functionId: FunctionId;
  readonly call: string;
  readonly callee: string;
  /** At-risk share: the runtime the observed work accounts for at most. */
  readonly upperBoundPercent: number;
  readonly evidence: readonly string[];
  /** Present only when no precondition is violated. */
  readonly hypothesis?: Hypothesis;
  /** Why no hypothesis was derived (a violated precondition, or no avoidable work after remedy cost). */
  readonly withheld?: string;
}

export interface DerivePhenomenaOptions {
  /** Profiled runtime in microseconds; enables the per-call cost model. */
  readonly totalMicros?: number;
  /** Assumed cost of one cache lookup keyed by the inputs, in microseconds (rough model, default 0.1). */
  readonly lookupMicros?: number;
}

/**
 * Observations from measured facts, and hypotheses only where their preconditions are not violated:
 * - IDENTICAL_OBJECT_FLOW: a call receives two collections where >= 90% of one's elements are the same objects as
 *   in the other. Hypothesis AVOID_REDUNDANT_WORK (skip identical objects by reference).
 * - DUPLICATE_CONTENT_FLOW: calls in the same function receive the same content (>= 50% of distinct inputs).
 *   Hypothesis AVOID_DUPLICATE_PROCESSING; violated when the callee writes outer state or its arguments.
 * - REPEATED_INPUT: a call repeats with the same content-bearing inputs (whole-call reuse >= 0.75 over >= 90%
 *   content-bearing calls). Hypothesis CACHE_RESULT needs a callee that writes nothing outside its locals, reads
 *   no mutable outer state, and costs more per call than a lookup.
 * - REPEATED_ARGUMENT: one substantial argument (fingerprint >= 200 chars) repeats (reuse >= 0.9) while the call
 *   as a whole does not. Hypothesis HOIST_ARGUMENT_WORK; the bound is coarse (the callee's whole cost).
 * Identity-only inputs (no arguments, buffers, class instances) and recursive calls produce no observations.
 */
export function derivePhenomena(
  probed: readonly ProbedCall[],
  evidence: ReadonlyMap<string, InputRepetition>,
  options: DerivePhenomenaOptions = {},
): Phenomenon[] {
  const byKey = new Map(probed.map((call) => [call.key, call]));
  const lookupMicros = options.lookupMicros ?? 0.1;
  const phenomena: Phenomenon[] = [];
  const reported = new Set<string>();
  for (const call of probed) {
    const facts = evidence.get(call.key);
    if (!facts) continue;
    const base = { functionId: call.functionId, call: call.key, callee: call.callee };
    const purity = purityPreconditions(call);

    const identity = facts.identity?.find((entry) => entry.meanOverlap >= 0.9 && entry.meanElements >= 10);
    if (identity) {
      const upper = round(call.costPercent * identity.meanOverlap);
      phenomena.push({
        ...base,
        observation: "IDENTICAL_OBJECT_FLOW",
        upperBoundPercent: upper,
        evidence: [`${identity.pair}: ${(identity.meanOverlap * 100).toFixed(1)}% same objects (mean ${identity.meanElements} elements, ${identity.calls} calls)`, `callee cost ${call.costPercent}%`],
        hypothesis: {
          kind: "AVOID_REDUNDANT_WORK",
          text: `\`${call.callee}\` receives collections whose elements are mostly the same objects; per-element work that compares or fingerprints them cannot find a difference for those. A reference check before that work would skip it.`,
          preconditions: [
            { name: "PER_ELEMENT_WORK_IS_COMPARISON", status: "UNVERIFIED", detail: "that the callee's per-element work compares or fingerprints is not checked" },
            { name: "ELEMENTS_NOT_MUTATED_BETWEEN", status: "UNVERIFIED" },
          ],
        },
      });
    }

    const shared = (facts.sharedWith ?? []).filter((other) => other.shareOfDistinct >= 0.5 && byKey.get(other.site)?.functionId === call.functionId);
    if (shared.length > 0) {
      const group = [call.key, ...shared.map((other) => other.site)].sort();
      const groupKey = group.join("|");
      if (!reported.has(groupKey)) {
        reported.add(groupKey);
        const cost = Math.max(...group.map((key) => byKey.get(key)?.costPercent ?? 0));
        const writes = group.some((key) => (byKey.get(key)?.calleeEffects ?? []).some((effect) => WRITING_EFFECTS.has(effect)));
        const preconditions: Precondition[] = [
          writes
            ? { name: "CALLEES_HAVE_NO_OUTER_EFFECTS", status: "VIOLATED", detail: "a callee writes outer state or its arguments" }
            : { name: "CALLEES_HAVE_NO_OUTER_EFFECTS", status: group.every((key) => byKey.get(key)?.calleeEffects) ? "MET" : "UNVERIFIED" },
          { name: "SAME_RESULT_SERVES_ALL_CALLERS", status: "UNVERIFIED", detail: "the calls may need different results from the same content" },
        ];
        phenomena.push(withHypothesis({
          ...base,
          observation: "DUPLICATE_CONTENT_FLOW",
          upperBoundPercent: round((cost * (group.length - 1)) / group.length),
          evidence: shared.map((other) => `same content as ${other.site}: ${(other.shareOfDistinct * 100).toFixed(0)}% of ${facts.distinctSignatures} distinct inputs`),
        }, {
          kind: "AVOID_DUPLICATE_PROCESSING",
          text: `${group.length} calls in the same function process the same content (${group.map((key) => byKey.get(key)?.callee ?? key).join(", ")}). Doing the work once would remove up to ${group.length - 1} of ${group.length} shares.`,
          preconditions,
        }));
      }
    }

    // Recursive calls repeat small sub-values by nature (a serializer on its leaves); not a caching signal.
    const recursive = call.calleeFunctionId !== undefined && call.calleeFunctionId === call.functionId;
    const contentShare = facts.contentCalls === undefined ? 1 : facts.contentCalls / Math.max(1, facts.calls);
    if (recursive || facts.calls < 10 || call.costPercent < 0.5) continue;
    if (contentShare >= 0.9 && facts.reuseRatio >= 0.75) {
      const upper = round(call.costPercent * facts.reuseRatio);
      const perCall = options.totalMicros !== undefined ? (call.costPercent / 100) * options.totalMicros / facts.calls : undefined;
      // Every call pays a lookup; hits save the call: avoidable = cost × (reuse − lookup / per-call cost).
      const estimate = perCall !== undefined ? round(Math.max(0, call.costPercent * (facts.reuseRatio - lookupMicros / Math.max(perCall, 1e-9)))) : undefined;
      const preconditions: Precondition[] = [
        ...purity,
        // A cached object is shared by every caller that hits the cache; a caller that mutates it changes the others.
        { name: "CALLERS_DO_NOT_MUTATE_SHARED_RESULT", status: "UNVERIFIED", detail: "irrelevant for primitive results; not checked" },
        ...(perCall !== undefined
          ? [{ name: "CALL_COSTS_MORE_THAN_LOOKUP", status: (perCall > lookupMicros * 2 ? "MET" : "VIOLATED") as PreconditionStatus, detail: `${perCall.toFixed(2)} µs per call vs ~${lookupMicros} µs per lookup` }]
          : []),
      ];
      phenomena.push(withHypothesis({
        ...base,
        observation: "REPEATED_INPUT",
        upperBoundPercent: upper,
        evidence: [`${facts.calls} calls, ${facts.distinctSignatures} distinct inputs (reuse ${facts.reuseRatio})`, `callee cost ${call.costPercent}%${perCall !== undefined ? `, ${perCall.toFixed(2)} µs per call` : ""}`],
      }, {
        kind: "CACHE_RESULT",
        text: `\`${call.callee}\` is called again and again with the same inputs; caching its result by those inputs would avoid the repeated share, minus the lookups.`,
        preconditions,
        ...(estimate !== undefined ? { estimatedAvoidablePercent: estimate } : {}),
      }));
    } else if (facts.bestPath && facts.bestPath.reuseRatio >= 0.9) {
      phenomena.push(withHypothesis({
        ...base,
        observation: "REPEATED_ARGUMENT",
        upperBoundPercent: round(call.costPercent * facts.bestPath.reuseRatio),
        evidence: [`${facts.bestPath.path}: ${facts.bestPath.distinct} distinct values over ${facts.calls} calls (reuse ${facts.bestPath.reuseRatio}); whole call reuse ${facts.reuseRatio}`, `callee cost ${call.costPercent}% (coarse bound)`],
      }, {
        kind: "HOIST_ARGUMENT_WORK",
        text: `\`${call.callee}\` receives the same \`${facts.bestPath.path}\` again and again while other inputs vary; whatever it derives from that argument alone (compiled patterns, resolved config, indexes) could be prepared once.`,
        preconditions: [
          ...purity,
          { name: "CALLEE_DERIVES_WORK_FROM_ARGUMENT", status: "UNVERIFIED", detail: "the share of the callee's cost that depends on this argument alone is not measured" },
        ],
      }));
    }
  }
  // One entry per observation, function, and callee: unrolled code calls the same callee from many sites.
  const merged = new Map<string, Phenomenon & { sites: number }>();
  for (const phenomenon of phenomena) {
    const key = `${phenomenon.observation}\u0001${phenomenon.functionId}\u0001${phenomenon.callee}`;
    const previous = merged.get(key);
    if (!previous) merged.set(key, { ...phenomenon, sites: 1 });
    else merged.set(key, { ...(previous.upperBoundPercent >= phenomenon.upperBoundPercent ? previous : phenomenon), sites: previous.sites + 1 });
  }
  return [...merged.values()]
    .map(({ sites, ...phenomenon }) => (sites > 1 ? { ...phenomenon, evidence: [...phenomenon.evidence, `${sites} call sites`] } : phenomenon))
    .sort((left, right) => right.upperBoundPercent - left.upperBoundPercent);
}

/** Attaches the hypothesis unless a precondition is violated or nothing is left to avoid. */
function withHypothesis(observation: Omit<Phenomenon, "hypothesis" | "withheld">, hypothesis: Hypothesis): Phenomenon {
  const violated = hypothesis.preconditions.filter((precondition) => precondition.status === "VIOLATED");
  if (violated.length > 0) {
    return { ...observation, withheld: violated.map((precondition) => `${precondition.name}${precondition.detail ? ` (${precondition.detail})` : ""}`).join("; ") };
  }
  if (hypothesis.estimatedAvoidablePercent === 0) return { ...observation, withheld: "no avoidable work after the remedy's own cost" };
  return { ...observation, hypothesis };
}

/** Whether repeating inputs can mean a repeating result: static facts about the callee. */
function purityPreconditions(call: ProbedCall): Precondition[] {
  if (!call.calleeEffects) {
    return [{ name: "CALLEE_RESULT_DEPENDS_ONLY_ON_INPUTS", status: "UNVERIFIED", detail: "dependency or unresolved callee: effects unknown" }];
  }
  const writes = call.calleeEffects.filter((effect) => WRITING_EFFECTS.has(effect));
  return [
    writes.length > 0
      ? { name: "CALLEE_WRITES_NOTHING_OUTSIDE_LOCALS", status: "VIOLATED", detail: writes.join(", ") }
      : { name: "CALLEE_WRITES_NOTHING_OUTSIDE_LOCALS", status: "MET" },
    call.calleeReadsMutableState === undefined
      ? { name: "CALLEE_READS_NO_MUTABLE_OUTER_STATE", status: "UNVERIFIED" }
      : call.calleeReadsMutableState.length > 0
        ? { name: "CALLEE_READS_NO_MUTABLE_OUTER_STATE", status: "VIOLATED", detail: call.calleeReadsMutableState.join(", ") }
        : { name: "CALLEE_READS_NO_MUTABLE_OUTER_STATE", status: "MET", detail: "direct body only, callees not followed" },
  ];
}

const WRITING_EFFECTS: ReadonlySet<Effect> = new Set(["MUTATES_ARGUMENT", "MUTATES_GLOBAL_STATE", "WRITES_EXTERNAL_STATE", "UNKNOWN_SIDE_EFFECT"]);

/**
 * Mutable state a function reads besides its parameters (its body only): `this`, outer `let`/`var`, outer
 * `const` bound to an object, array, buffer, or instance (contents may change), clock, randomness, environment.
 * Outer `const` functions, primitives, and regular expressions are immutable inputs.
 */
function mutableOuterReads(t: typeof ts, checker: ts.TypeChecker, fn: ts.Node): string[] {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return [];
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node.kind === t.SyntaxKind.ThisKeyword) found.add("this");
    if (t.isPropertyAccessExpression(node)) {
      const text = node.getText();
      if (text === "Date.now" || text === "Math.random" || text === "process.env" || text === "performance.now") found.add(text);
    }
    if (t.isNewExpression(node) && t.isIdentifier(node.expression) && node.expression.text === "Date" && (node.arguments?.length ?? 0) === 0) found.add("new Date()");
    if (t.isIdentifier(node) && !(t.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
      if (declaration && t.isVariableDeclaration(declaration) && (declaration.getStart() < body.getStart() || declaration.getStart() > body.end)) {
        const list = declaration.parent;
        const isConst = t.isVariableDeclarationList(list) && (list.flags & t.NodeFlags.Const) !== 0;
        const init = declaration.initializer;
        const immutable = isConst && init !== undefined && (
          t.isArrowFunction(init) || t.isFunctionExpression(init) || t.isLiteralExpression(init) || t.isNoSubstitutionTemplateLiteral(init)
          || init.kind === t.SyntaxKind.TrueKeyword || init.kind === t.SyntaxKind.FalseKeyword || t.isRegularExpressionLiteral(init)
          || (t.isPrefixUnaryExpression(init) && t.isNumericLiteral(init.operand))
        );
        if (!immutable) found.add(node.text);
      }
    }
    node.forEachChild(visit);
  };
  visit(body);
  return [...found].sort();
}

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
