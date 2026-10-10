// Signatures for boundary-representation tests; bodies are irrelevant.
type FunctionId = string;
type NodeId = string & { readonly __brand: "NodeId" };

export interface AsciiTermMatch {
  readonly termIndex: number;
  readonly offset: number;
  readonly length: number;
}

export interface KeywordMatch {
  text: string;
  offset: number;
  source?: "dictionary" | "heading";
}

// Target of the v0.2a source refactor (KWX).
export function scanAsciiTerms(text: string, dictionary: ReadonlySet<string>): AsciiTermMatch[] {
  return text.length > 0 && dictionary.size > 0 ? [] : [];
}

// Shape of the real HeuristicKeywordExtractor.extractDictionary.
export function extractDictionary(
  text: string,
  seen: Set<string>,
  matches: KeywordMatch[],
  addMatch: (text: string, offset: number, source: KeywordMatch["source"]) => void,
): void {
  addMatch(text, seen.size, matches[0]?.source);
}

export function componentsOf(
  members: readonly FunctionId[],
  adjacency: ReadonlyMap<FunctionId, ReadonlySet<FunctionId>>,
): FunctionId[][] {
  return members.length > 0 && adjacency.size > 0 ? [] : [];
}

export function brandedGraph(adjacency: Map<NodeId, NodeId[]>, weights: Float64Array): number {
  return adjacency.size + weights.length;
}

export class Holder {
  value = 1;
}

export function unsupportedInputs(
  maybe: string | undefined,
  pair: [number, number],
  counts: Map<string, number>,
  numbers: Set<number>,
  date: Date,
  holder: Holder,
): boolean {
  return Boolean(maybe) && pair.length === 2 && counts.size + numbers.size > 0 && date.getTime() > holder.value;
}

export function optionalInput(limit = 10, flag?: boolean): void {
  void limit;
  void flag;
}
