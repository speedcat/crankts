# Lowering: Kernel Contracts and Boundary Representations

Status: v0.2.1. This covers kernel contracts and boundary representations (v0.2.0), plus the Kernel IR, TS → IR lowering, IR verification, a reference interpreter, and contract derivation (v0.2.1). There is no native code generation yet; that is v0.2.2. The design follows [review.md](review.md) and comes from two manual PoCs: KWX (`PREPARED_STATE`, [MVP-8](../evaluation/intentweave-mvp8-native-poc.json)) and the CrankTS graph kernel (`GRAPH_BATCH`, [MVP-9b](../evaluation/crankts-mvp9b-graph-crossover.json)).

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

- **KWX** (`PREPARED_STATE`): `PreparedDictionary` is prepared from a `stringTable` with `BUILD` lifetime and `WRAP_MUTATORS` invalidation. That preserves the extractor's mutable-`Set` API, which the PoC preload did not. Each call takes the handle and a UTF-16 string and returns the first match per term as flat `u32` triples in term-index (dictionary) order. The source precondition still holds: the ASCII scan must first be extracted from `extractDictionary`. The original method takes an `addMatch` callback and an object with an optional field, and the representation analysis rejects both.
- **Graph** (`GRAPH_BATCH`): a symmetric, deduplicated `packedGraph` plus `fileRank` and `line` typed arrays, all packed `UPSTREAM`. It returns components in first-visit order with stably sorted members and articulation tie sets. Both `localeCompare` uses stay in TypeScript.

Both contracts are structurally valid. They are not lowerable today only because the obligations the PoCs established by differential parity (purity, string semantics, deterministic order, graph symmetry, termination) are still `UNPROVEN`. Value ranges are `GUARDED`. Running representation analysis on CrankTS's real `findArticulationPoints` yields the reference contract's `packedGraph`, apart from direction, which comes from the symmetry invariant.

## Kernel IR (v0.2.1)

[`ir.ts`](../src/lowering/ir.ts) defines a structured IR that contains only what the two validated kernels need:

- **Types:** `f64`, `bool`, UTF-16 `string`, arrays (`dynamic`, or typed `u8`/`u32`/`i32`/`f64` storage), `map` (string → f64, with no iteration operation), and named structs.
- **Statements:** `let`, `assign`, `setIndex`, `push`, `pop`, `clear`, `mapSet`, `sortByKeys`, `if`, `block`, `while`, `forRange`, `break`, `continue`, `return`, and expression statements.
- **Expressions:** arithmetic and comparisons, short-circuit `and`/`or`, `cond`, `min`/`max`, `length`, `index`, `charCodeAt`, `slice`, `toLowerAscii`, `mapGetOr`/`mapHas`, `field`, struct, array creation, and direct calls.

The IR keeps JavaScript semantics, with one rule added: **checked operations trap instead of emulating JS edge cases.**

- Index reads and writes, `charCodeAt`, `slice`, array lengths, typed-array stores, and `pop` require integer, in-range values. There is no `undefined` read, no clamping, and no wrap-around.
- `toLowerAscii` requires ASCII input.
- `while` loops count iterations against a budget.

A trap means the wrapper re-runs the original TypeScript function. Backends therefore never reproduce JS corner cases. They only reproduce the in-range behavior and trap otherwise. Numbers stay `f64` as in JS; integer use is enforced only at checked sites.

### Lowering

[`lowerKernel`](../src/lowering/lower.ts) lowers an entry function and its transitive callees in the same program. It accepts:

- `let`/`const` with initializers
- `if`, `while`, `for (let i = a; i < b; i++)`, and `for-of` over arrays
- `break`/`continue` without labels, and `return`
- numeric arithmetic and comparisons, and strict equality between numbers, booleans, or strings
- `&&`, `||`, and `!` on booleans only (no truthiness), and `?:`
- `Math.min`/`max`
- `.length`, `charCodeAt`, `slice(start, end)`, and `toLowerCase`
- array `push`, `pop`, element writes, `length = 0`, and `new Array<T>(n).fill(x)`
- typed arrays, `new Map<string, number>()` with `map.get(k) ?? fallback`, `has`, and `set`
- named interfaces as structs, and object literals of them
- `arr.sort((a, b) => k[a] - k[b] || ...)` over integer key arrays

Anything else is a positioned diagnostic and the whole lowering fails, including captured variables, unions and optional values, sets, other maps, closures, methods, classes, and generic functions.

### Verification and Obligations

[`verifyIrModule`](../src/lowering/verify.ts) rejects recursion, `forRange` bounds the loop body could change, and non-integer sort keys. It then discharges each proof obligation from the IR alone:

| Obligation | How it is discharged |
| --- | --- |
| `PURE` | `PROVEN` when no `setIndex`, `push`, `pop`, `clear`, `mapSet`, or `sort` reaches parameter-derived storage (origin analysis); lowering already excludes captured state |
| `NO_ALIASING` | `PROVEN` when fresh storage never gets a second binding: no copies into locals, no stores into other containers, and struct literals only in `return` |
| `DETERMINISTIC_ORDER` | `PROVEN` by construction: the IR has no unordered iteration, and `sortByKeys` is stable over integer keys |
| `TERMINATION` | `PROVEN` with an acyclic call graph and only `forRange` loops; otherwise `GUARDED` by the iteration budget |
| `INTEGER_RANGE` | `GUARDED` by the checked operations |
| `STRING_SEMANTICS` | `PROVEN` for UTF-16 code-unit operations; `GUARDED` when `toLowerAscii` is used |

[`deriveKernelContract`](../src/lowering/derive-contract.ts) builds a `KernelContract` from verified IR with an explicitly chosen shape. `GRAPH_BATCH` names the CSR `offsets`/`neighbors` parameters. `PREPARED_STATE` takes a prepare module whose struct return value becomes the handle. `IMMUTABLE_DURING_HANDLE` is `PROVEN` when prepare returns fresh state and execute is `PURE`. The handle then owns a copy whose behavior matches TypeScript, so no invalidation is needed (`PROVEN_IMMUTABLE`, `EXPLICIT` lifetime).

### Reference Interpreter and Parity

[`interpretIr`](../src/lowering/interpret.ts) defines what a backend must compute, and raises `KernelTrap` exactly where a backend must trap. The tests use two kernel-style fixtures that mirror the PoCs:

- [`graph-kernel.ts`](../test/fixtures/lowering/src/graph-kernel.ts): WCC plus Tarjan over CSR.
- [`kwx-kernel.ts`](../test/fixtures/lowering/src/kwx-kernel.ts): `prepareDictionary` builds a packed head/next index; `scanAsciiTerms` returns the first match per term.

Both lower and verify. Their derived contracts validate as **lowerable**, with every obligation `PROVEN` or `GUARDED`. The interpreter's results equal the TypeScript results:

- on 206 shaped and random graphs, with more than 50 components that have articulation points
- on 60 random dictionaries with 480 texts that include non-ASCII and astral characters, with more than 500 matches; the IR-built prepared state also equals the TypeScript one

On the same graphs, the decoded graph kernel output equals CrankTS's real `findWeaklyConnectedComponents` and `findArticulationPoints`. The chain real code ≡ kernel TS ≡ Kernel IR is therefore tested.

The real sources still fail closed with exact diagnostics:

- `islands.ts` uses `Set` and `Map<FunctionId, …>`.
- The unrefactored `extractDictionary` takes a callback.

Turning those into the kernel form, by interning ids and producing packed layouts upstream, is the job of v0.2.5 and v0.2.6.

## Next Steps (from review.md)

1. **v0.2.2:** a Rust/N-API backend and an explicit `crankts extract --target <function>` command.
   The backend emits Rust from verified IR. It is tested against `interpretIr` (same results, same traps), so v0.2.1's parity suites carry over unchanged.
2. **v0.2.3:** a generated wrapper with TypeScript fallback on `KernelTrap`, and differential parity tests.
3. **v0.2.4:** a generated benchmark and a transformation acceptance gate. A transformation must not lose its speedup at the boundary.
4. **v0.2.5 / v0.2.6:** reproduce the KWX and MVP-9b contracts from the original sources. That requires interning string ids and packing layouts upstream before lowering.
