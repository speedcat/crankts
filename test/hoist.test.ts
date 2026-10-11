import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectFunctions } from "../src/analysis/functions.js";
import { detectHoistCandidates } from "../src/analysis/hoist.js";
import { readInputSignatures, siteKey, writeInputSignatureProbe } from "../src/analysis/input-signatures.js";
import { createCompilerFacade } from "../src/compiler/compiler-facade.js";

const root = fileURLToPath(new URL("./fixtures/hoist", import.meta.url));
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function candidates(name: string) {
  const facade = createCompilerFacade(root);
  const definition = collectFunctions(facade).definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`no ${name}`);
  return detectHoistCandidates(definition.node, definition.compilerFacade, undefined)
    .map((candidate) => [candidate.callee, candidate.kind, candidate.invariance, candidate.inLoop]);
}

describe("HOIST_INVARIANT_WORK detection (v0.2.6d)", () => {
  it("classifies builders of reusable state by where their inputs come from", () => {
    expect(candidates("countStatic")).toEqual([["RegExp", "REGEXP", "STATIC_INVARIANT", false]]);
    expect(candidates("filterWith")).toEqual([["makeMatcher", "RETURNS_FUNCTION", "PARAM_DEPENDENT", false]]);
    expect(candidates("countInLoop")).toEqual([["makeMatcher", "RETURNS_FUNCTION", "LOOP_INVARIANT", true]]);
    // Module state that can change is runtime-dependent; `new Set` (a lib container) is no candidate.
    expect(candidates("withMutable")).toEqual([["makeMatcher", "RETURNS_FUNCTION", "PARAM_DEPENDENT", false]]);
  });

  it("measures input repetition with an instrumented run, leaving the source untouched", () => {
    const facade = createCompilerFacade(root);
    const definition = collectFunctions(facade).definitions.find((candidate) => candidate.name === "filterWith");
    if (!definition) throw new Error("no filterWith");
    const t = definition.compilerFacade.typescript;
    let call: import("typescript").CallExpression | undefined;
    const visit = (node: import("typescript").Node): void => {
      if (!call && t.isCallExpression(node) && node.expression.getText() === "makeMatcher") call = node;
      node.forEachChild(visit);
    };
    visit(definition.node);
    if (!call) throw new Error("no call");
    const position = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart());
    const key = siteKey(facade.projectRoot, definition.absoluteFile, position.line + 1, position.character + 1);
    const out = mkdtempSync(join(tmpdir(), "crankts-signatures-"));
    temporaryDirectories.push(out);
    const probe = writeInputSignatureProbe([{ file: definition.absoluteFile, call, key }], out);
    const signatures = join(out, "signatures.json");
    const child = spawnSync(process.execPath, ["--import", probe.importPath, join(root, "src/run.ts")], {
      encoding: "utf8",
      env: { ...process.env, CRANKTS_SIGNATURES_OUT: signatures },
    });
    expect(child.status, child.stderr).toBe(0);
    // 50 calls, two distinct patterns ("a+b" 45×, "c" 5×).
    expect(readInputSignatures([signatures]).get(key)).toEqual({ calls: 50, distinctSignatures: 2, reuseRatio: 0.96 });
  });
});
