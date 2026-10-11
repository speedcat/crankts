import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

  it("derives hypotheses with upper bounds from the facts", () => {
    const probed: ProbedCall[] = [
      { key: "a.ts:10:5", role: "CALLER_EDGE", functionId: "a.ts:1", callee: "diff", costPercent: 16, calleeFunctionId: "a.ts:2" },
      { key: "a.ts:20:5", role: "INNER_CALL", functionId: "a.ts:3", callee: "index.add", costPercent: 30 },
      { key: "a.ts:21:5", role: "INNER_CALL", functionId: "a.ts:3", callee: "typed.add", costPercent: 30 },
      { key: "a.ts:30:5", role: "INNER_CALL", functionId: "a.ts:4", callee: "walk", costPercent: 10, calleeFunctionId: "a.ts:4" },
      { key: "a.ts:40:5", role: "INNER_CALL", functionId: "a.ts:5", callee: "glob", costPercent: 8 },
      { key: "a.ts:50:5", role: "INNER_CALL", functionId: "a.ts:6", callee: "this.keccak", costPercent: 30 },
      { key: "a.ts:60:5", role: "INNER_CALL", functionId: "a.ts:7", callee: "G", costPercent: 22, calleeFunctionId: "a.ts:8", calleeEffects: ["READS_EXTERNAL_STATE", "MUTATES_GLOBAL_STATE"] },
    ];
    const phenomena = derivePhenomena(probed, new Map([
      ["a.ts:10:5", { calls: 5, distinctSignatures: 5, reuseRatio: 0, identity: [{ pair: "args[0].emitted in args[0].base", meanOverlap: 1, meanElements: 20000, calls: 5 }] }],
      ["a.ts:20:5", { calls: 100, distinctSignatures: 100, reuseRatio: 0, sharedWith: [{ site: "a.ts:21:5", distinct: 100, shareOfDistinct: 1 }] }],
      ["a.ts:21:5", { calls: 100, distinctSignatures: 100, reuseRatio: 0, sharedWith: [{ site: "a.ts:20:5", distinct: 100, shareOfDistinct: 1 }] }],
      // A recursive call with repeating leaves is not a caching signal.
      ["a.ts:30:5", { calls: 1000, distinctSignatures: 10, reuseRatio: 0.99 }],
      // The options repeat while the cwd varies: an invariant argument, not recomputation of the call.
      ["a.ts:40:5", { calls: 400, distinctSignatures: 300, reuseRatio: 0.25, contentCalls: 400, bestPath: { path: "args[1]", distinct: 2, reuseRatio: 0.995 } }],
      // No arguments (state lives in `this`): repeats trivially, no evidence.
      ["a.ts:50:5", { calls: 300000, distinctSignatures: 1, reuseRatio: 1, contentCalls: 0 }],
      // Index arguments repeat, but the callee writes outer buffers: called for its effect.
      ["a.ts:60:5", { calls: 3000000, distinctSignatures: 16, reuseRatio: 1, contentCalls: 3000000 }],
    ]));
    expect(phenomena.map((phenomenon) => [phenomenon.kind, phenomenon.callee, phenomenon.upperBoundPercent])).toEqual([
      ["REDUNDANT_WORK_ON_IDENTICAL_OBJECTS", "diff", 16],
      ["DUPLICATE_PROCESSING", "index.add", 15],
      ["INVARIANT_ARGUMENT", "glob", 7.96],
    ]);
  });
});
