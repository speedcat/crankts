// Kernel-style TypeScript of the MVP-8 KWX ASCII scan (evaluation/kwx-native-poc/src/lib.rs), as the
// v0.2a refactor would extract it from HeuristicKeywordExtractor.extractDictionary.
// prepareDictionary builds the prepared state; scanAsciiTerms returns the first match per term as
// flat [termIndex, UTF-16 offset, UTF-16 length] triples in term-index order.

export interface PreparedDictionary {
  readonly termCount: number;
  /** Lower-cased simple term -> most recent term index with that key (chain head). */
  readonly headByLower: Map<string, number>;
  /** Term index -> previous term index with the same key, or -1. */
  readonly next: number[];
}

function isWordCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isSimpleTerm(term: string, minLength: number): boolean {
  if (term.length < minLength || term.length === 0) {
    return false;
  }
  for (let index = 0; index < term.length; index++) {
    if (!isWordCode(term.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

export function prepareDictionary(terms: readonly string[], minLength: number): PreparedDictionary {
  const headByLower = new Map<string, number>();
  const next = new Array<number>(terms.length).fill(-1);
  for (let termIndex = 0; termIndex < terms.length; termIndex++) {
    const term = terms[termIndex];
    if (!isSimpleTerm(term, minLength)) {
      continue;
    }
    const key = term.toLowerCase();
    next[termIndex] = headByLower.get(key) ?? -1;
    headByLower.set(key, termIndex);
  }
  return { termCount: terms.length, headByLower, next };
}

export function scanAsciiTerms(text: string, dictionary: PreparedDictionary): number[] {
  const firstOffset = new Array<number>(dictionary.termCount).fill(-1);
  const firstLength = new Array<number>(dictionary.termCount).fill(0);
  let index = 0;
  while (index < text.length) {
    if (!isWordCode(text.charCodeAt(index))) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length && isWordCode(text.charCodeAt(index))) {
      index += 1;
    }
    let term = dictionary.headByLower.get(text.slice(start, index).toLowerCase()) ?? -1;
    while (term !== -1) {
      if (firstOffset[term] === -1) {
        firstOffset[term] = start;
        firstLength[term] = index - start;
      }
      term = dictionary.next[term];
    }
  }

  const matches: number[] = [];
  for (let term = 0; term < dictionary.termCount; term++) {
    if (firstOffset[term] !== -1) {
      matches.push(term, firstOffset[term], firstLength[term]);
    }
  }
  return matches;
}
