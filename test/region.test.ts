import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extractKernel } from "../src/lowering/extract.js";
import { planRegionExtraction } from "../src/lowering/region.js";
import { HeuristicKeywordExtractor } from "./fixtures/lowering/src/kwx-real/heuristicExtractor.js";
import { compareExtractors, type ExtractorClass } from "./helpers/kwx-scenarios.js";

const realFile = fileURLToPath(new URL("./fixtures/lowering/src/kwx-real/heuristicExtractor.ts", import.meta.url));
const generatedRoot = fileURLToPath(new URL("./.generated", import.meta.url));
const method = "HeuristicKeywordExtractor.extractDictionary";
// Line numbers in the verbatim fixture (IntentWeave lines + 9 for the replaced import).
const EXECUTE = { startLine: 334, endLine: 369 };
const PREPARE = { startLine: 312, endLine: 324 };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("region extraction from unmodified source", () => {
  it("outlines the scan and slices the prepare loop of the real extractDictionary", () => {
    const result = planRegionExtraction({ file: realFile, function: method, execute: EXECUTE, prepare: PREPARE });
    if (!result.ok) throw new Error(result.diagnostics.join("\n"));
    const plan = result.plan;
    expect(plan.prepareParams).toEqual([{ name: "terms", sourceType: "string[]" }]);
    expect(plan.stateFields).toEqual([{ name: "simpleTermsByLower", sourceType: "Map<string, string[]>" }]);
    expect(plan.executeParams.map((param) => [param.name, param.role])).toEqual([
      ["stripped", "input"], ["state", "state"], ["firstMatches", "inout"],
    ]);
    // The prepare function holds only the state-building branch; the regex-term work stays in the source.
    expect(plan.outlinedModule).toContain("export function prepareExtractDictionary(terms: string[]): ExtractDictionaryState {");
    expect(plan.outlinedModule).not.toContain("regexTerms");
    const patched = plan.patchedSource("./integration.js", join(generatedRoot, "x", "ts", "patched.ts"));
    expect(patched).toContain("__crankts.executeExtractDictionary(this, [terms], stripped, firstMatches);");
    expect(patched).toContain("regexTerms.push({ term, pattern: new RegExp(");
    expect(patched).not.toContain("const simpleTermsByLower = new Map");
    expect(patched).not.toContain("variants.push(term)");
    // Everything outside the method is untouched.
    const original = readFileSync(realFile, "utf8");
    expect(patched.slice(patched.indexOf("const NOISE_WORDS"), patched.indexOf("private extractDictionary(")))
      .toBe(original.slice(original.indexOf("const NOISE_WORDS"), original.indexOf("private extractDictionary(")));
  });

  it("fails closed on regions it cannot extract", () => {
    const plan = (execute: { startLine: number; endLine: number }) => planRegionExtraction({ file: realFile, function: method, execute });
    const messages = (result: ReturnType<typeof plan>) => (result.ok ? [] : result.diagnostics);
    expect(messages(plan({ startLine: 336, endLine: 350 }))).toEqual([
      expect.stringContaining("cuts through the statement at lines 335-369"),
      expect.stringContaining("contains no complete top-level statement"),
    ]);
    expect(messages(plan({ startLine: 305, endLine: 307 }))).toEqual(expect.arrayContaining([expect.stringContaining("`this`")]));
    expect(messages(plan(PREPARE))).toEqual(expect.arrayContaining([
      expect.stringContaining("mutates regexTerms with operations other than Map has()/set()"),
    ]));
  });

  it("generates a patched class that equals the original without an addon (TypeScript fallback)", async () => {
    mkdirSync(generatedRoot, { recursive: true });
    const out = mkdtempSync(join(generatedRoot, "region-"));
    temporaryDirectories.push(out);
    const result = extractKernel({
      target: `${realFile}#${method}`,
      shape: "PREPARED_STATE",
      outDir: out,
      crateName: "kwx-region-fallback",
      region: { execute: EXECUTE, prepare: PREPARE },
    });
    if (!result.ok) throw new Error(`${result.stage}: ${result.messages.join("\n")}`);
    expect(result.contract.state?.invalidation).toBe("CONTENT_SNAPSHOT");
    expect(result.contract.inputs.find((input) => input.name === "firstMatches")).toMatchObject({
      ownership: "IN_OUT_REPLAYED",
      type: { kind: "inoutMap", value: { kind: "struct" } },
    });

    const patched = await import(pathToFileURL(join(out, "ts/heuristicExtractor.crankts.ts")).href) as { HeuristicKeywordExtractor: ExtractorClass };
    const integration = await import(pathToFileURL(join(out, "ts/integration.ts")).href) as {
      nativeStatus: { loaded: boolean };
      regionStatus: { preparations: number; cacheHits: number };
    };
    expect(integration.nativeStatus.loaded).toBe(false);
    const comparison = compareExtractors(HeuristicKeywordExtractor as unknown as ExtractorClass, patched.HeuristicKeywordExtractor, 40);
    expect(comparison.mismatches).toEqual([]);
    expect(comparison.compared).toBeGreaterThan(200);
    // Reuse and revalidation of the prepared state across extractions and Set mutations.
    expect(integration.regionStatus.cacheHits).toBeGreaterThan(0);
    expect(integration.regionStatus.preparations).toBeGreaterThan(40);

    const parity = await import(pathToFileURL(join(out, "ts/parity.ts")).href) as {
      runRegionParity(options: { iterations: number }): { nativeAvailable: boolean; mismatches: string[] };
    };
    expect(parity.runRegionParity({ iterations: 300 })).toMatchObject({ nativeAvailable: false, mismatches: [] });
  });
});
