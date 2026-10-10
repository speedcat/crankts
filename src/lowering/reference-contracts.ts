import type { KernelContract } from "./contract.js";

/**
 * Reference contracts for the two manual PoCs. They are the targets a v0.2 transformer must
 * reproduce mechanically (v0.2.5: KWX, v0.2.6: MVP-9b). Obligations the PoCs established only by
 * differential parity stay UNPROVEN until CrankTS discharges them statically, so neither contract
 * is lowerable yet; `validateKernelContract` lists exactly what is missing.
 */

/**
 * MVP-8 KWX ASCII dictionary scan (evaluation/kwx-native-poc). Source precondition: the ASCII scan
 * loop is extracted from `HeuristicKeywordExtractor.extractDictionary` into a standalone function
 * `scanAsciiTerms(text, dictionary)`; the original method takes a callback and mutates its arguments.
 */
export const KWX_ASCII_SCAN_CONTRACT: KernelContract = {
  contractVersion: 1,
  name: "kwx-ascii-dictionary-scan",
  source: "packages/analyzer/src/kwg/heuristicExtractor.ts#scanAsciiTerms",
  shape: "PREPARED_STATE",
  state: {
    name: "PreparedDictionary",
    prepareInputs: [{
      name: "dictionary",
      type: { kind: "stringTable" },
      sourceType: "ReadonlySet<string>",
      ownership: "MOVED_INTO_HANDLE",
      // The extractor accepts a caller-owned mutable Set; the PoC assumed it never changed.
      mutability: "MUTABLE_INVALIDATES",
      packing: "PER_CALL",
    }],
    lifetime: "BUILD",
    invalidation: "WRAP_MUTATORS",
  },
  inputs: [
    {
      name: "dictionaryHandle",
      type: { kind: "handle", state: "PreparedDictionary" },
      sourceType: "ReadonlySet<string>",
      ownership: "BORROWED",
      mutability: "IMMUTABLE",
      packing: "NATIVE_OWNED",
    },
    {
      name: "text",
      type: { kind: "string", encoding: "utf16" },
      sourceType: "string",
      ownership: "COPIED",
      mutability: "IMMUTABLE",
      packing: "PER_CALL",
    },
  ],
  outputs: [{
    name: "matches",
    // Flat [dictionary index, UTF-16 offset, UTF-16 length] triples, as in the PoC addon.
    type: { kind: "typedArray", element: "u32" },
    sourceType: "AsciiTermMatch[]",
    ordering: { kind: "TRAVERSAL_ORDER", description: "first match per term, in term-index (dictionary) order" },
  }],
  batching: { granularity: "ITEM", callsPerPrepare: "MANY" },
  fallback: {
    reference: "ORIGINAL_TS",
    conditions: ["ADDON_MISSING", "NATIVE_ERROR", "CONTRACT_VIOLATION", "INPUT_OUT_OF_RANGE"],
  },
  proofObligations: [
    {
      kind: "PURE",
      subject: "scanAsciiTerms",
      status: "UNPROVEN",
      evidence: "MVP-8 parity: 49,002 KeywordMatch objects over 11,010 chunks",
    },
    {
      kind: "STRING_SEMANTICS",
      subject: "ASCII word characters [0-9A-Za-z_] and lower-casing equal the JS regex word boundary",
      status: "UNPROVEN",
      evidence: "MVP-8 parity including UTF-16 offsets after astral Unicode",
    },
    {
      kind: "DETERMINISTIC_ORDER",
      subject: "matches",
      status: "UNPROVEN",
      evidence: "MVP-8 scanner parity on every chunk",
    },
    {
      kind: "INTEGER_RANGE",
      subject: "UTF-16 offsets and dictionary indexes fit u32",
      status: "GUARDED",
      runtimeGuard: "text.length <= 0xffffffff && dictionary.size <= 0xffffffff",
    },
  ],
  typescriptSemantics: [
    "terms shorter than minLength or outside [0-9A-Za-z_] (regex terms)",
    "seen-set deduplication and addMatch",
    "markdown stripping",
  ],
};

/**
 * MVP-9b WCC + articulation points over CrankTS candidate islands (evaluation/graph-native-poc).
 * Packing is UPSTREAM: MVP-9b measured per-call Map -> CSR conversion at 75-90% of the native total.
 */
export const GRAPH_ISLANDS_CONTRACT: KernelContract = {
  contractVersion: 1,
  name: "crankts-islands-wcc-articulation",
  source: "src/analysis/islands.ts#findWeaklyConnectedComponents+findArticulationPoints",
  shape: "GRAPH_BATCH",
  inputs: [
    {
      name: "adjacency",
      type: { kind: "packedGraph", direction: "undirected", deduplicated: true, neighborOrder: "INSERTION" },
      sourceType: "ReadonlyMap<FunctionId, ReadonlySet<FunctionId>>",
      ownership: "BORROWED",
      mutability: "IMMUTABLE",
      packing: "UPSTREAM",
    },
    {
      name: "fileRank",
      type: { kind: "typedArray", element: "u32" },
      sourceType: "string (FunctionAnalysis.file, ranked by localeCompare)",
      ownership: "BORROWED",
      mutability: "IMMUTABLE",
      packing: "UPSTREAM",
    },
    {
      name: "line",
      type: { kind: "typedArray", element: "u32" },
      sourceType: "number (FunctionAnalysis.line)",
      ownership: "BORROWED",
      mutability: "IMMUTABLE",
      packing: "UPSTREAM",
    },
  ],
  outputs: [{
    name: "components",
    // Per component: members, articulation count, articulation points tied for the largest impact.
    type: { kind: "typedArray", element: "u32" },
    sourceType: "FunctionId[][] + articulation summaries",
    ordering: {
      kind: "TRAVERSAL_ORDER",
      description: "components in first-visit order of node index; members stably sorted by (fileRank, line)",
    },
  }],
  batching: { granularity: "WHOLE_INPUT" },
  fallback: {
    reference: "ORIGINAL_TS",
    conditions: ["ADDON_MISSING", "NATIVE_ERROR", "INPUT_OUT_OF_RANGE"],
  },
  proofObligations: [
    {
      kind: "PURE",
      subject: "findWeaklyConnectedComponents, findArticulationPoints",
      status: "UNPROVEN",
      evidence: "MVP-9b parity in 34 configurations, 12 to 367,900 nodes",
    },
    {
      kind: "INPUT_INVARIANT",
      subject: "adjacency is symmetric (findCandidateIslands adds both directions)",
      status: "UNPROVEN",
    },
    {
      kind: "DETERMINISTIC_ORDER",
      subject: "components",
      status: "UNPROVEN",
      evidence: "MVP-9b sha256 parity of canonical results",
    },
    {
      kind: "TERMINATION",
      subject: "iterative DFS with explicit stack",
      status: "UNPROVEN",
    },
    {
      kind: "INTEGER_RANGE",
      subject: "node indexes and subtree sizes fit u32",
      status: "GUARDED",
      runtimeGuard: "nodeCount < 0xffffffff",
    },
  ],
  typescriptSemantics: [
    "file order via localeCompare (ranked once into fileRank)",
    "articulation tie-break via FunctionId.localeCompare over the returned tie set",
    "internalCallers, warnings, eligibility mix, scoring",
  ],
};

export const REFERENCE_CONTRACTS: readonly KernelContract[] = [KWX_ASCII_SCAN_CONTRACT, GRAPH_ISLANDS_CONTRACT];
