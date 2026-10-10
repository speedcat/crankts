// Expected outlining of the two regions of IntentWeave's HeuristicKeywordExtractor.extractDictionary
// (region text verbatim; state fields rebound to their original names).

export interface ExtractDictionaryState {
  readonly simpleTermsByLower: Map<string, string[]>;
}

export function prepareExtractDictionary(terms: string[]): ExtractDictionaryState {
  const simpleTermsByLower = new Map<string, string[]>();
  for (const term of terms) {
    if (/^[A-Za-z0-9_]+$/.test(term)) {
      const key = term.toLowerCase();
      const variants = simpleTermsByLower.get(key) ?? [];
      variants.push(term);
      simpleTermsByLower.set(key, variants);
      continue;
    }
  }
  return { simpleTermsByLower };
}

export function scanExtractDictionary(
  stripped: string,
  state: ExtractDictionaryState,
  firstMatches: Map<string, { text: string; offset: number }>,
): void {
  const simpleTermsByLower = state.simpleTermsByLower;
  let index = 0;
  while (index < stripped.length) {
    const firstCharCode = stripped.charCodeAt(index);
    if (
      !(
        (firstCharCode >= 48 && firstCharCode <= 57) ||
        (firstCharCode >= 65 && firstCharCode <= 90) ||
        (firstCharCode >= 97 && firstCharCode <= 122) ||
        firstCharCode === 95
      )
    ) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < stripped.length) {
      const charCode = stripped.charCodeAt(index);
      if (
        !(
          (charCode >= 48 && charCode <= 57) ||
          (charCode >= 65 && charCode <= 90) ||
          (charCode >= 97 && charCode <= 122) ||
          charCode === 95
        )
      )
        break;
      index += 1;
    }
    const matchText = stripped.slice(start, index);
    const variants = simpleTermsByLower.get(matchText.toLowerCase());
    for (const term of variants ?? []) {
      if (!firstMatches.has(term))
        firstMatches.set(term, { text: matchText, offset: start });
    }
  }
}
