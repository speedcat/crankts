# Lowering: Kernel Contracts and Boundary Representations

Status: v0.2.0. This describes the first transformation building block. It covers types, validation, and representation analysis. It does not generate code yet. The design follows [review.md](review.md) and comes from two manual PoCs: KWX (`PREPARED_STATE`, [MVP-8](../evaluation/intentweave-mvp8-native-poc.json)) and the CrankTS graph kernel (`GRAPH_BATCH`, [MVP-9b](../evaluation/crankts-mvp9b-graph-crossover.json)).

## Kernel Contract

A [`KernelContract`](../src/lowering/contract.ts) describes everything that must hold at the JS/native boundary before a transformer may replace a TypeScript function:

| Field | Content |
| --- | --- |
| `shape` | `PURE_BATCH`, `PREPARED_STATE`, `GRAPH_BATCH` (lowerable in v0.2); `REDUCTION`, `PARALLEL_MAP`, `OWNED_NATIVE_STATE` (declared only) |
| `state` | `PREPARED_STATE` only: prepare inputs, handle lifetime (`CALL`, `BUILD`, `PROCESS`, `EXPLICIT`), invalidation |
| `inputs` / `outputs` | boundary type, original TS type, ownership, mutability, packing site; outputs declare their order |
| `batching` | `ITEM` (one call per element) or `WHOLE_INPUT`; calls per prepared handle |
| `fallback` | the original TypeScript function, used when the addon is missing, on native errors, and on contract violations |
| `proofObligations` | `PURE`, `NO_ALIASING`, `DETERMINISTIC_ORDER`, `STRING_SEMANTICS`, `INTEGER_RANGE`, `IMMUTABLE_DURING_HANDLE`, `EXCEPTION_FREE`, `TERMINATION`, `INPUT_INVARIANT`. Each one is `PROVEN`, `GUARDED` (with a runtime guard that falls back), or `UNPROVEN` |
| `typescriptSemantics` | behavior that deliberately stays in the TS wrapper, e.g. `localeCompare` tie-breaks |

Boundary types are scalars (`bool`, `u8`, `u32`, `i32`, `f64`), UTF-16 strings, typed arrays, arrays, structs, `stringTable` (interned strings), `packedGraph` (CSR over interned node ids, with direction, deduplication, and neighbor order), and native `handle`s.

`validateKernelContract` fails closed. Any `ERROR` makes the contract non-lowerable:

- the shape is not supported in v0.2, state is missing or forbidden, a `GRAPH_BATCH` has no packed graph, or a prepared kernel lacks a handle input
- an input is mutable but borrowed into a stateless call, can change in ways the kernel cannot observe, or moves into native state outside `prepare`
- a mutable prepare input relies on `PROVEN_IMMUTABLE`, or `PROVEN_IMMUTABLE` lacks a proven `IMMUTABLE_DURING_HANDLE` obligation
- a collection output has no declared order, or follows an unknown input
- the fallback does not cover `ADDON_MISSING` and `NATIVE_ERROR`
- an obligation is `UNPROVEN`, or `GUARDED` without a guard

Packing a `stringTable` or `packedGraph` on every stateless call is a `WARNING`. MVP-9b measured that conversion at 75 to 90% of the native total.

Invalidation is `WRAP_MUTATORS`, `REPREPARE_PER_CALL`, or `PROVEN_IMMUTABLE`. Checking only the identity and size of a `Set` is deliberately not offered: deleting one term and adding another keeps both unchanged, so the handle would silently go stale.

## Boundary Representations

[`deriveSignatureRepresentation`](../src/lowering/representation.ts) maps a function's parameter and return types to boundary types using the project's own checker. Each result carries a transfer cost class:

| TypeScript | Boundary type | Transfer |
| --- | --- | --- |
| `boolean`, `number` | scalar (`bool`, `f64`; integer ranges are proof obligations) | `TRIVIAL` |
| `string`, string literals, branded strings | UTF-16 string | `COPY_LINEAR` |
| `Uint8Array`, `Uint32Array`, `Int32Array`, `Float64Array` | typed array | `ZERO_COPY` |
| `T[]`, `readonly T[]` | array | `COPY_LINEAR` for scalars, otherwise `CONVERT_LINEAR` |
| plain object types with required, non-method fields (depth ≤ 3) | struct | `CONVERT_LINEAR` |
| `Set<string>`, `ReadonlySet<string>` | `stringTable` | `PACK` |
| `Map<K, Set<K>>`, `ReadonlyMap<K, ReadonlySet<K>>`, `Map<K, K[]>` with string-like `K` | `packedGraph` (directed; deduplicated for sets; insertion order) | `PACK` |

Everything else fails closed with a reason. That includes nullable values, optional and rest parameters, tuples, other maps, sets of non-strings, functions, class instances, objects with methods or index signatures, and recursive types. For every `PACK` result the recommended packing site is `UPSTREAM`: the producer should build the packed form instead of converting it at the call site. A type cannot express that an adjacency map is symmetric, so a contract that needs an undirected graph must state that as an `INPUT_INVARIANT` obligation.

## Reference Contracts

[`reference-contracts.ts`](../src/lowering/reference-contracts.ts) encodes both PoCs as the targets that v0.2.5 and v0.2.6 must reproduce mechanically:

- **KWX** (`PREPARED_STATE`): `PreparedDictionary` is prepared from a `stringTable` with `BUILD` lifetime and `WRAP_MUTATORS` invalidation. That preserves the extractor's mutable-`Set` API, which the PoC preload did not. Each call takes the handle and a UTF-16 string and returns flat `u32` triples in token, then dictionary, order. The source precondition still holds: the ASCII scan must first be extracted from `extractDictionary`. The original method takes an `addMatch` callback and an object with an optional field, and the representation analysis rejects both.
- **Graph** (`GRAPH_BATCH`): a symmetric, deduplicated `packedGraph` plus `fileRank` and `line` typed arrays, all packed `UPSTREAM`. It returns components in first-visit order with stably sorted members and articulation tie sets. Both `localeCompare` uses stay in TypeScript.

Both contracts are structurally valid. They are not lowerable today only because the obligations the PoCs established by differential parity (purity, string semantics, deterministic order, graph symmetry, termination) are still `UNPROVEN`. Value ranges are `GUARDED`. Running representation analysis on CrankTS's real `findArticulationPoints` yields the reference contract's `packedGraph`, apart from direction, which comes from the symmetry invariant.

## Next Steps (from review.md)

1. **v0.2.1:** a small Kernel IR that covers only what KWX and the graph kernel need, plus discharging the obligations above (purity from effect analysis, integer ranges, termination of explicit-stack loops).
2. **v0.2.2:** a Rust/N-API backend and an explicit `crankts extract --target <function>` command.
3. **v0.2.3:** a generated wrapper with TypeScript fallback and differential parity tests.
4. **v0.2.4:** a generated benchmark and a transformation acceptance gate. A transformation must not lose its speedup at the boundary.
5. **v0.2.5 / v0.2.6:** reproduce the KWX and MVP-9b contracts from unmodified-semantics TypeScript.
