import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { derivePhenomena, type ProbedCall } from "../src/analysis/evidence.js";
import { collectFunctions } from "../src/analysis/functions.js";
import { readInputSignatures, siteKey, writeInputSignatureProbe, type ProbeSite } from "../src/analysis/input-signatures.js";
import { createCompilerFacade } from "../src/compiler/compiler-facade.js";

const root = fileURLToPath(new URL("./fixtures/hoist", import.meta.url));
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function probeSites(): ProbeSite[] {
  const facade = createCompilerFacade(root);
  const sites: ProbeSite[] = [];
  for (const definition of collectFunctions(facade).definitions) {
    if (!["indexTwice", "diffRows"].includes(definition.name) || !definition.absoluteFile.endsWith("evidence.ts")) continue;
    const t = definition.compilerFacade.typescript;
    const visit = (node: ts.Node): void => {
      if (t.isCallExpression(node) && /\.add$/.test(node.expression.getText())) {
        const position = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
        sites.push({ file: definition.absoluteFile, call: node, key: siteKey(facade.projectRoot, definition.absoluteFile, position.line + 1, position.character + 1) });
      }
      node.forEachChild(visit);
    };
    visit(definition.node);
  }
  // The call into diffRows, from the runner (probes the arguments of the hot function itself).
  const runner = facade.program.getSourceFile(join(root, "src/run-evidence.ts"));
  const t = facade.typescript;
  const visitRunner = (node: ts.Node): void => {
    if (t.isCallExpression(node) && node.expression.getText() === "diffRows") {
      const position = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
      sites.push({ file: join(root, "src/run-evidence.ts"), call: node, key: siteKey(facade.projectRoot, join(root, "src/run-evidence.ts"), position.line + 1, position.character + 1) });
    }
    node.forEachChild(visitRunner);
  };
  if (runner) visitRunner(runner);
  return sites;
}

describe("workload evidence and phenomena (v0.2.6e)", () => {
  it("measures identity overlap and shared content in a real run", () => {
    const sites = probeSites();
    expect(sites).toHaveLength(3);
    const out = mkdtempSync(join(tmpdir(), "crankts-evidence-"));
    temporaryDirectories.push(out);
    const probe = writeInputSignatureProbe(sites, out);
    const signatures = join(out, "signatures.json");
    const child = spawnSync(process.execPath, ["--import", probe.importPath, join(root, "src/run-evidence.ts")], {
      encoding: "utf8",
      env: { ...process.env, CRANKTS_SIGNATURES_OUT: signatures },
    });
    expect(child.status, child.stderr).toBe(0);
    const evidence = readInputSignatures([signatures]);
    const [firstAdd, secondAdd, diffCall] = sites.map((site) => evidence.get(site.key));
    expect(diffCall?.identity?.[0]).toMatchObject({ pair: "args[0].emitted in args[0].base", meanOverlap: 1, meanElements: 50, calls: 5 });
    expect(firstAdd?.sharedWith).toEqual([{ site: sites[1]?.key, distinct: 50, shareOfDistinct: 1 }]);
    expect(secondAdd?.calls).toBe(50);
  });

  it("samples hot calls: the call count stays exact, ratios use the sampled calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "crankts-sampling-"));
    temporaryDirectories.push(dir);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "esnext", target: "es2022", allowImportingTsExtensions: true, noEmit: true }, include: ["*.ts"] }));
    writeFileSync(join(dir, "hot.ts"), "export function hot(value: string): number {\n  return value.length;\n}\n");
    writeFileSync(join(dir, "run.ts"), 'import { hot } from "./hot.ts";\nlet sink = 0;\nfor (let index = 0; index < 30000; index += 1) sink += hot("repeating input that is long enough to count as content");\nconsole.log(sink);\n');
    const facade = createCompilerFacade(dir);
    const file = join(dir, "run.ts");
    const t = facade.typescript;
    let site: ProbeSite | undefined;
    const visit = (node: ts.Node): void => {
      if (t.isCallExpression(node) && node.expression.getText() === "hot") {
        const position = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
        site = { file, call: node, key: siteKey(facade.projectRoot, file, position.line + 1, position.character + 1) };
      }
      node.forEachChild(visit);
    };
    const source = facade.program.getSourceFile(file);
    if (source) visit(source);
    expect(site).toBeDefined();
    const probe = writeInputSignatureProbe([site as ProbeSite], join(dir, "probe"));
    const signatures = join(dir, "signatures.json");
    const child = spawnSync(process.execPath, ["--import", probe.importPath, file], { encoding: "utf8", env: { ...process.env, CRANKTS_SIGNATURES_OUT: signatures } });
    expect(child.status, child.stderr).toBe(0);
    const facts = readInputSignatures([signatures]).get((site as ProbeSite).key);
    expect(facts?.calls).toBe(30000);
    // 2,000 exact + (20,000 − 2,000) / 4 + (30,000 − 20,000) / 64, rounded the way the modulo schedule counts them.
    expect(facts?.sampledCalls).toBeGreaterThan(6000);
    expect(facts?.sampledCalls).toBeLessThan(7500);
    expect(facts?.distinctSignatures).toBe(1);
    expect(facts?.reuseRatio).toBeGreaterThan(0.99);
  });

  it("separates observations from hypotheses, which need their preconditions", () => {
    const probed: ProbedCall[] = [
      { key: "a.ts:10:5", role: "CALLER_EDGE", functionId: "a.ts:1", callee: "diff", costPercent: 16, calleeFunctionId: "a.ts:2" },
      { key: "a.ts:20:5", role: "INNER_CALL", functionId: "a.ts:3", callee: "index.add", costPercent: 30 },
      { key: "a.ts:21:5", role: "INNER_CALL", functionId: "a.ts:3", callee: "typed.add", costPercent: 30 },
      { key: "a.ts:30:5", role: "INNER_CALL", functionId: "a.ts:4", callee: "walk", costPercent: 10, calleeFunctionId: "a.ts:4" },
      { key: "a.ts:40:5", role: "INNER_CALL", functionId: "a.ts:5", callee: "glob", costPercent: 8 },
      { key: "a.ts:50:5", role: "INNER_CALL", functionId: "a.ts:6", callee: "this.keccak", costPercent: 30 },
      { key: "a.ts:60:5", role: "INNER_CALL", functionId: "a.ts:7", callee: "G", costPercent: 22, calleeFunctionId: "a.ts:8", calleeEffects: ["READS_EXTERNAL_STATE", "MUTATES_GLOBAL_STATE"], calleeReadsMutableState: ["BBUF"] },
      { key: "a.ts:70:5", role: "INNER_CALL", functionId: "a.ts:9", callee: "parseJson", costPercent: 3, calleeFunctionId: "a.ts:10", calleeEffects: ["ALLOCATES", "READS_EXTERNAL_STATE"], calleeReadsMutableState: [] },
      { key: "a.ts:80:5", role: "INNER_CALL", functionId: "a.ts:11", callee: "G1s", costPercent: 5, calleeFunctionId: "a.ts:12", calleeEffects: ["ALLOCATES", "MUTATES_LOCAL_STATE"], calleeReadsMutableState: [] },
    ];
    const phenomena = derivePhenomena(probed, new Map([
      ["a.ts:10:5", { calls: 5, distinctSignatures: 5, reuseRatio: 0, identity: [{ pair: "args[0].emitted in args[0].base", meanOverlap: 1, meanElements: 20000, calls: 5 }] }],
      ["a.ts:20:5", { calls: 100, distinctSignatures: 100, reuseRatio: 0, sharedWith: [{ site: "a.ts:21:5", distinct: 100, shareOfDistinct: 1 }] }],
      ["a.ts:21:5", { calls: 100, distinctSignatures: 100, reuseRatio: 0, sharedWith: [{ site: "a.ts:20:5", distinct: 100, shareOfDistinct: 1 }] }],
      // A recursive call with repeating leaves is not a caching signal.
      ["a.ts:30:5", { calls: 1000, distinctSignatures: 10, reuseRatio: 0.99 }],
      // The options repeat while the cwd varies: a repeated argument, not a repeated call.
      ["a.ts:40:5", { calls: 400, distinctSignatures: 300, reuseRatio: 0.25, contentCalls: 400, bestPath: { path: "args[1]", distinct: 2, reuseRatio: 0.995 } }],
      // No arguments (state lives in `this`): repeats trivially, no observation.
      ["a.ts:50:5", { calls: 300000, distinctSignatures: 1, reuseRatio: 1, contentCalls: 0 }],
      // Index arguments repeat, but the callee writes and reads outer buffers: observation only.
      ["a.ts:60:5", { calls: 3000000, distinctSignatures: 16, reuseRatio: 1, contentCalls: 3000000 }],
      // 400k parses over 40 inputs, 0.75 µs each (10 s runtime): worth a cache.
      ["a.ts:70:5", { calls: 400000, distinctSignatures: 40, reuseRatio: 1, contentCalls: 400000 }],
      // Pure, repeating, but 0.06 µs per call: a lookup costs more than the call.
      ["a.ts:80:5", { calls: 8000000, distinctSignatures: 280000, reuseRatio: 0.965, contentCalls: 8000000 }],
    ]), { totalMicros: 10_000_000 });
    const summary = phenomena.map((phenomenon) => [phenomenon.observation, phenomenon.callee, phenomenon.upperBoundPercent, phenomenon.hypothesis?.kind ?? "withheld"]);
    expect(summary).toEqual([
      ["REPEATED_INPUT", "G", 22, "withheld"],
      ["IDENTICAL_OBJECT_FLOW", "diff", 16, "AVOID_REDUNDANT_WORK"],
      ["DUPLICATE_CONTENT_FLOW", "index.add", 15, "AVOID_DUPLICATE_PROCESSING"],
      ["REPEATED_ARGUMENT", "glob", 7.96, "HOIST_ARGUMENT_WORK"],
      ["REPEATED_INPUT", "G1s", 4.83, "withheld"],
      ["REPEATED_INPUT", "parseJson", 3, "CACHE_RESULT"],
    ]);
    const byCallee = new Map(phenomena.map((phenomenon) => [phenomenon.callee, phenomenon]));
    expect(byCallee.get("G")?.withheld).toContain("CALLEE_WRITES_NOTHING_OUTSIDE_LOCALS");
    expect(byCallee.get("G1s")?.withheld).toContain("CALL_COSTS_MORE_THAN_LOOKUP");
    // 3% × (1 − 0.1 µs / 0.75 µs) = 2.6%
    expect(byCallee.get("parseJson")?.hypothesis?.estimatedAvoidablePercent).toBe(2.6);
    // A dependency callee's purity cannot be checked: the hypothesis stays, marked unverified.
    expect(byCallee.get("glob")?.hypothesis?.preconditions[0]).toMatchObject({ name: "CALLEE_RESULT_DEPENDS_ONLY_ON_INPUTS", status: "UNVERIFIED" });
  });
});
