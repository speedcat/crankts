#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const options = parseOptions(process.argv.slice(2));
const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
const indexPath = resolve(options.indexDb);
const database = new DatabaseSync(indexPath, { readOnly: true });
const indexedDocumentPaths = database
  .prepare("SELECT path FROM files WHERE is_doc = 1 ORDER BY path")
  .all()
  .map((row) => row.path);
database.close();

const facadeModule = await import(pathToFileURL(join(workspaceRoot, "packages/index/src/facade.ts")).href);
const analyzerModule = await import(pathToFileURL(join(workspaceRoot, "packages/analyzer/src/stages/in.ts")).href);
const axModule = await import(pathToFileURL(join(workspaceRoot, "packages/analyzer/src/stages/ax.ts")).href);
const extractorModule = await import(pathToFileURL(join(workspaceRoot, "packages/analyzer/src/kwg/heuristicExtractor.ts")).href);
const contextModule = await import(pathToFileURL(join(workspaceRoot, "packages/analyzer/src/pipeline/context.ts")).href);
const {
  buildExcludeList,
  discoverFiles,
  loadIwIgnore,
} = facadeModule;
const { runInStage } = analyzerModule;
const { runAxStage } = axModule;
const { HeuristicKeywordExtractor } = extractorModule;
const { DEFAULT_PROFILE, NoopLogger } = contextModule;
const excludePatterns = buildExcludeList([], await loadIwIgnore(workspaceRoot));
const discoveredFiles = await discoverFiles([workspaceRoot], workspaceRoot, {
  exclude: excludePatterns,
});
const discoveredDocumentPaths = new Set(discoveredFiles.map((filePath) => (
  relative(workspaceRoot, filePath).split(sep).join("/")
)));
const missingIndexedDocuments = indexedDocumentPaths.filter((filePath) => !discoveredDocumentPaths.has(filePath));

const nativePath = resolve(options.nativeAddon);
const nativeRequire = createRequire(import.meta.url);
const native = nativeRequire(nativePath);
const documents = [];
const sourceCommentExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".swift", ".go", ".java", ".cs"]);
const context = {
  workspaceRoot,
  profile: DEFAULT_PROFILE,
  logger: new NoopLogger(),
};
const axOutput = await runAxStage({ workspaceRoot, maxFileSize: 262144 });
const dictionary = [...new Set(axOutput.files.flatMap((file) => (
  file.symbols.map((symbol) => symbol.name.toLowerCase())
)))];

for (const absolutePath of discoveredFiles) {
  const filePath = relative(workspaceRoot, absolutePath).split(sep).join("/");
  const content = readFileSync(absolutePath, "utf8");
  await addInStageDocument(filePath, content, "document");
}

let sourceCommentFiles = 0;
for (const file of axOutput.files) {
  if (!sourceCommentExtensions.has(extname(file.filePath).toLowerCase())) continue;
  try {
    const rawContent = readFileSync(join(workspaceRoot, file.filePath), "utf8");
    const commentContent = extractSourceCommentContent(rawContent);
    if (!commentContent.trim()) continue;
    await addInStageDocument(file.filePath, commentContent, "source-comment", "text", { minChunkSize: 1 });
    sourceCommentFiles += 1;
  } catch {
    // Match buildFromPaths: unreadable source files do not abort comment extraction.
  }
}

const simpleTermCount = dictionary.filter((term) => (
  term.length >= 3 && /^[A-Za-z0-9_]+$/.test(term)
)).length;
const flatChunks = documents.flatMap((document, documentIndex) => document.chunks.map((chunk) => ({
  documentIndex,
  inputKind: document.inputKind,
  rawText: chunk.raw,
  text: chunk.stripped,
})));
const documentChunks = flatChunks.filter((chunk) => chunk.inputKind === "document");
const sourceCommentChunks = flatChunks.filter((chunk) => chunk.inputKind === "source-comment");
const scanTextUtf16Chars = flatChunks.reduce((total, chunk) => total + chunk.text.length, 0);

assert.equal(typeof native.PreparedDictionary, "function", "Native PreparedDictionary export is missing");
assert.equal(typeof native.scanAsciiTerms, "function", "Native scanAsciiTerms export is missing");

const syntheticTerms = ["beta", "widget", "alpha", "a+b", "Ångström"];
const syntheticText = "🧪 xwidget widgetized (WIDGET), alpha then beta";
assert.deepEqual(
  native.scanAsciiTerms(syntheticText, syntheticTerms),
  scanAsciiTermsTypescript(syntheticText, syntheticTerms),
  "cold native scanner must preserve JS word boundaries, ordering, and UTF-16 offsets",
);
const syntheticPrepared = new native.PreparedDictionary(syntheticTerms);
assert.deepEqual(
  syntheticPrepared.scan(syntheticText),
  scanAsciiTermsTypescript(syntheticText, syntheticTerms),
  "prepared native scanner must preserve JS word boundaries, ordering, and UTF-16 offsets",
);

let verifiedChunks = 0;
let verifiedColdDocumentChunks = 0;
for (const document of documents) {
  const prepared = new native.PreparedDictionary(dictionary);
  for (const chunk of document.chunks) {
    const expected = scanAsciiTermsTypescript(chunk.stripped, dictionary);
    assert.deepEqual(prepared.scan(chunk.stripped), expected, `prepared parity failed in ${document.filePath}`);
    if (document.inputKind === "document") {
      assert.deepEqual(native.scanAsciiTerms(chunk.stripped, dictionary), expected, `cold parity failed in ${document.filePath}`);
      verifiedColdDocumentChunks += 1;
    }
    verifiedChunks += 1;
  }
}

const typescriptExtractors = documents.map(() => new HeuristicKeywordExtractor({
  depth: "full",
  dictionary: new Set(dictionary),
}));
const nativeExtractors = documents.map(() => createNativeExtractor(
  new native.PreparedDictionary(dictionary),
));
let verifiedExtractorMatches = 0;
for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
  const document = documents[documentIndex];
  const typescriptExtractor = typescriptExtractors[documentIndex];
  const nativeExtractor = nativeExtractors[documentIndex];
  for (const chunk of document.chunks) {
    const expected = typescriptExtractor.extract(chunk.raw);
    const actual = nativeExtractor.extract(chunk.raw);
    assert.deepEqual(actual, expected, `full extractor parity failed in ${document.filePath}`);
    verifiedExtractorMatches += expected.length;
  }
}

const modes = [
  ["typescriptKernel", runTypescript],
  ["napiPreparedKernelPerDocument", runPreparedNative],
  ["typescriptKernelDocumentsOnly", runTypescriptDocumentKernel],
  ["typescriptExtractor", runTypescriptExtractor],
  ["napiPreparedExtractorPerDocument", runPreparedExtractor],
  ["napiDictionaryPerChunkDocumentsOnly", runColdNative],
];
const warmup = Object.fromEntries(modes.map(([name, run]) => [name, run().checksum]));
for (const [name, run] of modes) {
  assert.equal(run().checksum, warmup[name], `${name} warm-up changed its output`);
}

const timings = Object.fromEntries(modes.map(([name]) => [name, []]));
const rounds = 5;
for (let round = 0; round < rounds; round += 1) {
  const startIndex = round % modes.length;
  for (let offset = 0; offset < modes.length; offset += 1) {
    const [name, run] = modes[(startIndex + offset) % modes.length];
    const start = performance.now();
    const result = run();
    const elapsedMs = performance.now() - start;
    assert.equal(result.checksum, warmup[name], `${name} output changed in measured round ${round + 1}`);
    timings[name].push(elapsedMs);
  }
}

const measurements = Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, summarize(values)]));
const report = {
  schemaVersion: 1,
  experiment: "KWX ASCII dictionary token-scan N-API microkernel",
  claim: "Manual full-extractor comparison; not an integrated KWX-stage or end-to-end speedup claim.",
  capturedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    workspaceRoot,
    indexDatabase: basename(indexPath),
    nativeAddon: basename(nativePath),
    indexedDocumentRows: indexedDocumentPaths.length,
    discoveredDocuments: discoveredFiles.length,
    missingIndexedDocuments,
    axFiles: axOutput.totalFiles,
    axSymbols: axOutput.totalSymbols,
    skippedAxFiles: axOutput.files.filter((file) => file.skipped).length,
    sourceCommentFiles,
    inputGroups: documents.length,
    documentChunks: documentChunks.length,
    sourceCommentChunks: sourceCommentChunks.length,
    chunks: flatChunks.length,
    dictionaryTerms: dictionary.length,
    asciiDictionaryTerms: simpleTermCount,
    scanTextUtf16Chars,
  },
  methodology: {
    warmupRounds: 1,
    measuredRounds: rounds,
    parityCheckedChunks: verifiedChunks,
    completeExtractorParityCheckedChunks: verifiedChunks,
    completeExtractorMatchesCompared: verifiedExtractorMatches,
    coldNativeDocumentChunksChecked: verifiedColdDocumentChunks,
    nativePreparedLifetime: "one N-API dictionary object per document/comment input group; one scan call per IN chunk",
    nativeColdLifetime: "dictionary terms cross N-API and rebuild the native index for document chunks only",
    outputs: "flattened [dictionary index, UTF-16 offset, UTF-16 length] triples in dictionary order",
  },
  parity: {
    syntheticUnicodeAndBoundaryCases: "PASS",
    preparedNativeKernelAllChunks: "PASS",
    coldNativeKernelDocumentChunks: "PASS",
    completeKeywordMatchObjectsAllChunks: "PASS",
  },
  measurements,
  speedup: {
    preparedNativeKernelVsTypescriptKernel: round(
      measurements.typescriptKernel.medianMs / measurements.napiPreparedKernelPerDocument.medianMs,
      3,
    ),
    preparedNativeExtractorVsTypescriptExtractor: round(
      measurements.typescriptExtractor.medianMs / measurements.napiPreparedExtractorPerDocument.medianMs,
      3,
    ),
    coldNativeVsTypescriptKernelOnDocuments: round(
      measurements.typescriptKernelDocumentsOnly.medianMs / measurements.napiDictionaryPerChunkDocumentsOnly.medianMs,
      3,
    ),
  },
};

const output = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resolve(options.output), output);
} else {
  process.stdout.write(output);
}

  async function addInStageDocument(filePath, content, inputKind, artifactFormat, inOptions) {
    const input = {
      artifactId: toArtifactId(filePath),
      filePath,
      content,
      ...(artifactFormat ? { artifactFormat } : {}),
    };
    const inOutput = await runInStage(input, context, inOptions);
    documents.push({
      filePath,
      inputKind,
      chunks: inOutput.chunks.map((chunk) => ({
        raw: chunk.content,
        stripped: stripForDictionary(chunk.content),
      })),
    });
  }

function runTypescript() {
  let checksum = 2166136261;
  let matchTriples = 0;
  for (const chunk of flatChunks) {
    const matches = scanAsciiTermsTypescript(chunk.text, dictionary);
    matchTriples += matches.length;
    checksum = updateChecksum(checksum, matches);
  }
  return { checksum, matchTriples };
}

function runTypescriptDocumentKernel() {
  let checksum = 2166136261;
  let matchTriples = 0;
  for (const chunk of documentChunks) {
    const matches = scanAsciiTermsTypescript(chunk.text, dictionary);
    matchTriples += matches.length;
    checksum = updateChecksum(checksum, matches);
  }
  return { checksum, matchTriples };
}

function runPreparedNative() {
  let checksum = 2166136261;
  let matchTriples = 0;
  const preparedByDocument = documents.map(() => new native.PreparedDictionary(dictionary));
  for (const chunk of flatChunks) {
    const matches = preparedByDocument[chunk.documentIndex].scan(chunk.text);
    matchTriples += matches.length;
    checksum = updateChecksum(checksum, matches);
  }
  return { checksum, matchTriples };
}

function runColdNative() {
  let checksum = 2166136261;
  let matchTriples = 0;
  for (const chunk of documentChunks) {
    const matches = native.scanAsciiTerms(chunk.text, dictionary);
    matchTriples += matches.length;
    checksum = updateChecksum(checksum, matches);
  }
  return { checksum, matchTriples };
}

function runTypescriptExtractor() {
  let checksum = 2166136261;
  let matchCount = 0;
  const extractors = documents.map(() => new HeuristicKeywordExtractor({
    depth: "full",
    dictionary: new Set(dictionary),
  }));
  for (const chunk of flatChunks) {
    const matches = extractors[chunk.documentIndex].extract(chunk.rawText);
    matchCount += matches.length;
    checksum = updateMatchChecksum(checksum, matches);
  }
  return { checksum, matchCount };
}

function runPreparedExtractor() {
  let checksum = 2166136261;
  let matchCount = 0;
  const extractors = documents.map(() => createNativeExtractor(
    new native.PreparedDictionary(dictionary),
  ));
  for (const chunk of flatChunks) {
    const matches = extractors[chunk.documentIndex].extract(chunk.rawText);
    matchCount += matches.length;
    checksum = updateMatchChecksum(checksum, matches);
  }
  return { checksum, matchCount };
}

function createNativeExtractor(preparedDictionary) {
  const extractor = new HeuristicKeywordExtractor({
    depth: "full",
    dictionary: new Set(dictionary),
  });

  extractor.extractDictionary = (text, seen, matches, addMatch) => {
    const stripped = stripForDictionary(text);
    const terms = dictionary.filter((term) => term.length >= 3);
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

    const nativeMatches = preparedDictionary.scan(stripped);
    for (let index = 0; index < nativeMatches.length; index += 3) {
      const term = dictionary[nativeMatches[index]];
      const offset = nativeMatches[index + 1];
      const length = nativeMatches[index + 2];
      if (term !== undefined && offset !== undefined && length !== undefined) {
        firstMatches.set(term, { text: stripped.slice(offset, offset + length), offset });
      }
    }

    for (const term of terms) {
      if (seen.has(term)) continue;
      const match = firstMatches.get(term);
      if (match) addMatch(match.text, match.offset, "dictionary");
    }
  };

  return extractor;
}

function scanAsciiTermsTypescript(text, terms) {
  const termsByLowercase = new Map();
  const firstMatches = new Map();
  for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
    const term = terms[termIndex];
    if (term.length < 3 || !/^[A-Za-z0-9_]+$/.test(term)) continue;
    const key = term.toLowerCase();
    const variants = termsByLowercase.get(key) ?? [];
    variants.push(termIndex);
    termsByLowercase.set(key, variants);
  }

  let index = 0;
  while (index < text.length) {
    if (!isWordCodeUnit(text.charCodeAt(index))) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < text.length && isWordCodeUnit(text.charCodeAt(index))) index += 1;
    const token = text.slice(start, index);
    for (const termIndex of termsByLowercase.get(token.toLowerCase()) ?? []) {
      if (!firstMatches.has(termIndex)) firstMatches.set(termIndex, [start, index - start]);
    }
  }

  const flattenedMatches = [];
  for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
    const firstMatch = firstMatches.get(termIndex);
    if (firstMatch) flattenedMatches.push(termIndex, firstMatch[0], firstMatch[1]);
  }
  return flattenedMatches;
}

function stripForDictionary(text) {
  return text
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function extractSourceCommentContent(content) {
  const lines = content.split("\n");
  const result = [];
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) {
        const before = trimmed.slice(0, trimmed.indexOf("*/")).replace(/^\*?\s?/, "");
        result.push(before.trim());
        inBlock = false;
      } else {
        result.push(trimmed.replace(/^\*\s?/, ""));
      }
    } else if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) {
      inBlock = true;
      const afterOpen = trimmed.replace(/^\/\*+\s?/, "");
      if (afterOpen.includes("*/")) {
        result.push(afterOpen.slice(0, afterOpen.indexOf("*/")).trim());
        inBlock = false;
      } else {
        result.push(afterOpen.trim());
      }
    } else if (trimmed.startsWith("//")) {
      result.push(trimmed.replace(/^\/\/\s?/, "").trim());
    } else if (trimmed.startsWith("#") && !trimmed.startsWith("#!")) {
      result.push(trimmed.replace(/^#+\s?/, "").trim());
    } else {
      result.push("");
    }
  }

  return result.join("\n");
}

function toArtifactId(filePath) {
  return filePath.replace(/[/\\]/g, ".").replace(/\.[^.]+$/, "");
}

function isWordCodeUnit(codeUnit) {
  return (codeUnit >= 48 && codeUnit <= 57)
    || (codeUnit >= 65 && codeUnit <= 90)
    || (codeUnit >= 97 && codeUnit <= 122)
    || codeUnit === 95;
}

function updateChecksum(checksum, values) {
  for (const value of values) checksum = Math.imul(checksum ^ value, 16777619) >>> 0;
  return checksum;
}

function updateMatchChecksum(checksum, matches) {
  for (const match of matches) {
    checksum = updateChecksum(checksum, [match.offset, match.length]);
    for (const text of [match.name, match.originalText, match.source]) {
      for (let index = 0; index < text.length; index += 1) {
        checksum = Math.imul(checksum ^ text.charCodeAt(index), 16777619) >>> 0;
      }
    }
  }
  return checksum;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    roundsMs: values.map(round),
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    minMs: round(sorted[0]),
    maxMs: round(sorted.at(-1)),
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function parseOptions(arguments_) {
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--workspace-root" || argument === "--index-db" || argument === "--native-addon" || argument === "--output") {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      parsed[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (!parsed.indexDb) throw new Error("--index-db is required");
  if (!parsed.nativeAddon) throw new Error("--native-addon is required");
  return parsed;
}