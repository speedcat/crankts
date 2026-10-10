import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspaceRoot = process.env.CRANKTS_IW_ROOT;
const nativeAddonPath = process.env.CRANKTS_KWX_NATIVE_ADDON;
if (!workspaceRoot || !nativeAddonPath) {
  throw new Error("CRANKTS_IW_ROOT and CRANKTS_KWX_NATIVE_ADDON are required for the manual KWX PoC");
}

const native = createRequire(import.meta.url)(nativeAddonPath);
const extractorModule = await import(pathToFileURL(join(
  workspaceRoot,
  "packages/analyzer/dist/kwg/heuristicExtractor.js",
)).href);
const { HeuristicKeywordExtractor } = extractorModule;
const preparedByExtractor = new WeakMap();
let preparedDictionaryCount = 0;
const sourceStripFunction = /\*\*(.+?)\*\*|__(.+?)__/g;

HeuristicKeywordExtractor.prototype.extractDictionary = function extractDictionaryWithNativeScan(
  text,
  seen,
  matches,
  addMatch,
) {
  let prepared = preparedByExtractor.get(this);
  if (!prepared) {
    prepared = {
      terms: [...this.dictionary],
      dictionary: new native.PreparedDictionary([...this.dictionary]),
    };
    preparedByExtractor.set(this, prepared);
    preparedDictionaryCount += 1;
  }

  const stripped = stripForDictionary(text);
  const terms = prepared.terms.filter((term) => term.length >= this.minLength);
  const regexTerms = [];
  const firstMatches = new Map();

  for (const term of terms) {
    if (/^[A-Za-z0-9_]+$/.test(term)) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regexTerms.push({ term, pattern: new RegExp(`\\b${escaped}\\b`, "gi") });
  }

  for (const { term, pattern } of regexTerms) {
    const match = pattern.exec(stripped);
    if (match) firstMatches.set(term, { text: match[0], offset: match.index });
  }

  const nativeMatches = prepared.dictionary.scan(stripped);
  for (let index = 0; index < nativeMatches.length; index += 3) {
    const termIndex = nativeMatches[index];
    const term = prepared.terms[termIndex];
    const offset = nativeMatches[index + 1];
    const length = nativeMatches[index + 2];
    if (term !== undefined && term.length >= this.minLength && offset !== undefined && length !== undefined) {
      firstMatches.set(term, { text: stripped.slice(offset, offset + length), offset });
    }
  }

  for (const term of terms) {
    if (seen.has(term)) continue;
    const match = firstMatches.get(term);
    if (match) addMatch(match.text, match.offset, "dictionary");
  }
};

process.on("exit", () => {
  process.stderr.write(`[kwx-native-poc] prepared dictionaries: ${preparedDictionaryCount}\n`);
});

function stripForDictionary(text) {
  return text
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(sourceStripFunction, (_match, bold, alternateBold) => bold ?? alternateBold)
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}