// Differential scenarios for HeuristicKeywordExtractor: IntentWeave's own dictionary test inputs plus
// seeded random dictionaries and texts. Original and patched classes must produce identical output.
import { random } from "./kernel-inputs.js";

export interface ExtractorLike {
  extract(text: string, heading?: string): unknown[];
}

export type ExtractorClass = new (options?: { minLength?: number; depth?: "structured" | "full"; dictionary?: Set<string> }) => ExtractorLike;

/** IntentWeave packages/analyzer/src/__tests__/kwg-heuristicExtractor.test.ts inputs. */
export const INTENTWEAVE_SCENARIOS: readonly { readonly dictionary: readonly string[]; readonly text: string }[] = [
  { dictionary: ["widget"], text: "xwidget widgetized (WIDGET), widget!" },
  { dictionary: ["beta", "alpha"], text: "alpha appears before beta" },
  { dictionary: ["a+b", "state machine"], text: "Use a+b inside a State Machine." },
  { dictionary: ["authservice"], text: "`AuthService` handles login; authservice is mentioned again." },
];

const WORDS = ["graph", "Graph", "node", "Node_1", "AuthService", "kwx", "KWX", "scan", "widget", "state", "machine", "alpha", "beta", "a1", "x_y"];
const NOISE = [" ", ". ", ", ", "\n", "-", "(", ")", "**", "`", "# ", "é", "😀", "\uD800", "a+b", "state machine"];

export function randomScenario(seed: number): { dictionary: string[]; texts: string[]; minLength: number } {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const dictionary = Array.from({ length: 1 + Math.floor(next() * 12) }, () => (
    next() < 0.8 ? pick(WORDS) : pick(["a+b", "state machine", "é", "x.y", "ab"])
  ));
  const texts = Array.from({ length: 6 }, () => Array.from({ length: Math.floor(next() * 30) }, () => (
    next() < 0.55 ? pick(WORDS) : pick(NOISE)
  )).join(""));
  return { dictionary, texts, minLength: 2 + Math.floor(next() * 3) };
}

/** Runs every scenario on both classes, including Set mutation between extractions. */
export function compareExtractors(original: ExtractorClass, patched: ExtractorClass, seeds: number): { compared: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let compared = 0;
  const check = (label: string, left: unknown, right: unknown): void => {
    compared += 1;
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      mismatches.push(`${label}: ${JSON.stringify(left).slice(0, 300)} vs ${JSON.stringify(right).slice(0, 300)}`);
    }
  };
  for (const [index, scenario] of INTENTWEAVE_SCENARIOS.entries()) {
    const make = (Extractor: ExtractorClass) => new Extractor({ depth: "full", dictionary: new Set(scenario.dictionary) });
    check(`intentweave ${index}`, make(original).extract(scenario.text), make(patched).extract(scenario.text));
  }
  for (let seed = 1; seed <= seeds; seed += 1) {
    const { dictionary, texts, minLength } = randomScenario(seed);
    const originalSet = new Set(dictionary);
    const patchedSet = new Set(dictionary);
    const left = new original({ depth: "full", dictionary: originalSet, minLength });
    const right = new patched({ depth: "full", dictionary: patchedSet, minLength });
    for (const [textIndex, text] of texts.entries()) {
      check(`seed ${seed} text ${textIndex}`, left.extract(text), right.extract(text));
      // The caller-owned dictionary changes between extractions (IntentWeave's mutation contract).
      if (textIndex === 2) {
        for (const set of [originalSet, patchedSet]) {
          set.add("scan");
          set.delete(dictionary[0] ?? "");
        }
      }
    }
  }
  return { compared, mismatches };
}
