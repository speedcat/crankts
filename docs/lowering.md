# Lowering: Kernel Contracts and Boundary Representations

Status: v0.2.4. This covers:

- kernel contracts and boundary representations (v0.2.0)
- the Kernel IR with lowering, verification, interpreter, and contract derivation (v0.2.1)
- the Rust/N-API backend with `crankts extract` (v0.2.2)
- the generated TypeScript wrapper and parity runner (v0.2.3)
- the backend quality pass with the generated benchmark and acceptance gate (v0.2.4) The design follows [review.md](review.md) and comes from two manual PoCs: KWX (`PREPARED_STATE`, [MVP-8](../evaluation/intentweave-mvp8-native-poc.json)) and the CrankTS graph kernel (`GRAPH_BATCH`, [MVP-9b](../evaluation/crankts-mvp9b-graph-crossover.json)).

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

## Rust/N-API Backend and `crankts extract` (v0.2.2)

```bash
crankts extract test/fixtures/lowering/src/graph-kernel.ts#graphBatch \
  --shape GRAPH_BATCH --graph offsets,neighbors --out /tmp/graph-kernel

crankts extract test/fixtures/lowering/src/kwx-kernel.ts#scanAsciiTerms \
  --prepare test/fixtures/lowering/src/kwx-kernel.ts#prepareDictionary \
  --shape PREPARED_STATE --name kwx-scan --out /tmp/kwx-scan
```

[`extractKernel`](../src/lowering/extract.ts) selects the named function declarations and lowers them. It then derives and validates the contract, and only writes output if the contract is lowerable. The output is `Cargo.toml`, `src/lib.rs`, `contract.json`, `kernel.ir`, and a README. Lowering, verification, contract, and backend failures exit with code 1 and list every diagnostic; nothing is written.

[`emitRustCrate`](../src/lowering/backend-rust.ts) translates verified IR into a napi-rs crate:

- **Storage follows the verifier's origin analysis.** Fresh arrays, maps, and structs are owned (`Vec`, `HashMap<Rc<[u16]>, f64>`, `struct`); parameter-derived storage is borrowed. `NO_ALIASING` is what makes owned values behave like JS references.
- **Strings are `Rc<[u16]>`.** They cross the boundary as `Utf16String` (`napi_get_value_string_utf16`). That keeps UTF-16 code units, including lone surrogates. A UTF-8 `String` would replace them and change `charCodeAt`.
- **Every checked IR operation is a `Result` helper.** A failed check returns an error whose message starts with `CRANKTS_KERNEL_TRAP`. `Math.min`/`max` keep JS `NaN` and `-0` semantics. `while` loops tick an iteration budget, which `__setIterationBudget(n)` sets.
- **The N-API surface follows the contract.**
  - Scalars, `Utf16String`, typed arrays (zero-copy borrows), and arrays of scalars or strings cross directly.
  - `PREPARED_STATE` becomes a `#[napi]` class (here `PreparedDictionary`) that `prepare` returns and `execute` takes as `&H_PreparedDictionary`.

### Native Parity

[`native-backend.test.ts`](../test/native-backend.test.ts) runs `crankts extract` for four kernels, builds them with cargo, and loads the addons. It runs locally when `cargo` is available, and in CI only with `CRANKTS_NATIVE_TESTS=1`, so the default CI job stays Rust-free. It checks four things:

- the graph kernel equals TypeScript on the same 206 graphs as the interpreter tests
- the KWX kernel equals TypeScript through a native handle, on 60 dictionaries plus texts with lone surrogates
- malformed CSR input, non-ASCII `toLowerCase`, and an exhausted iteration budget trap with `CRANKTS_KERNEL_TRAP`
- the budget can be reset

### Performance Smoke Check (not a gate; superseded by v0.2.4 below)

The release build of the generated graph addon ran through the unchanged [MVP-9b harness](../evaluation/graph-native-poc/README.md), on W1 with the `replicate` topology, with 5 runs each. Its results matched TypeScript in every run. The handwritten PoC is shown for comparison:

| W1 | TS kernel | Handwritten (total / call) | Generated (total / call) |
| --- | ---: | ---: | ---: |
| 1× (3,679 nodes) | 4.4 to 4.7 ms | 1.60 / 0.26 ms (3.0x) | 2.75 / 0.94 ms (1.6x) |
| 10× | 44 ms | 16.4 / 1.5 ms (2.7x) | 20.9 / 6.1 ms (2.1x) |
| 100× (367,900 nodes) | 575 ms | 138 / 13.7 ms (4.2x) | 187 / 59 ms (3.1x) |

The generated code is already faster than TypeScript including transfer, but its call is 3.6 to 4.3 times slower than the handwritten kernel. The known causes:

- every number is `f64`, and each index goes through a checked conversion
- the result is a JS array instead of a `Uint32Array`
- a fresh `members` vector is allocated per component

These are v0.2.4 work: integer range analysis to lower proven indexes to `u32`, typed outputs, and buffer reuse. The acceptance gate there must measure them.

## Generated Wrapper and Parity Runner (v0.2.3)

`crankts extract` also writes `ts/<entry>.ts` and `ts/parity.ts` ([`wrapper-ts.ts`](../src/lowering/wrapper-ts.ts)). Wrapped entries must be exported, because the wrapper imports them as its fallback. For `PREPARED_STATE`, prepare and execute must be in the same module.

**Wrapper.** Each wrapped function keeps the original signature (`(...args: Parameters<typeof original>) => ReturnType<typeof original>`). It loads `<crate>.node` from next to the crate, or from `$CRANKTS_ADDON_<CRATE>`. It runs the original TypeScript function in exactly three cases (tightened in v0.2.4):

- `ADDON_MISSING`: the addon cannot be loaded.
- `CONTRACT_GUARD`: an argument is outside the contract's domain. Generated TypeScript guards check this before the call (e.g. `instanceof Uint32Array`, or arrays whose elements are all numbers).
- `CRANKTS_KERNEL_TRAP`: a checked operation in the kernel trapped.

Any other native failure, including a Rust panic (caught with `catch_unwind`), is a CrankTS bug. It is rethrown as `CRANKTS_INTERNAL_ERROR` and never masked by the fallback; the parity runner then reports a wrapper mismatch.

`nativeStatus` counts native calls, traps, contract guards, internal errors, and state fallbacks. `CRANKTS_ITERATION_BUDGET` sets the TERMINATION guard.

**`PREPARED_STATE`.** The contract's `IMMUTABLE_DURING_HANDLE` proof covers the kernel, not its callers. The original API returns a plain state object that callers may read and mutate. The wrapper therefore returns a view typed as the original state:

- **The view holds the native handle and a snapshot of the prepare arguments.** A later TypeScript state then equals one built at prepare time, even if the caller mutates its input array afterwards.
- **Its fields are lazy getters.** The first access builds the TypeScript state and marks the view as observed.
- **Once observed, a state always runs in TypeScript,** because the caller may have mutated it. This keeps the wrapper sound without proving anything about callers.
- **States the wrapper did not create (`foreignStates`) also run in TypeScript.**
- **When an execute call traps, it falls back** to the original with the internally built TypeScript state.

**Parity runner.** `ts/parity.ts` checks two properties for every case:

1. The wrapper's outcome (value or exception) equals the original's.
2. The addon either traps or returns exactly the original's value.

Values are compared with `Object.is`, element-wise for arrays and typed arrays, and entry-wise for maps. Inputs come from seeded, type-directed fuzzing over the contract's parameter types, in four categories that are reported separately (v0.2.4):

- `normal`: small integers and ASCII text
- `boundary`: `NaN`, `-0`, `±Infinity`, `2^31`, `2^53`, empty and single-element values
- `strings`: non-ASCII text, astral characters, and lone surrogates
- `trapDomain`: index values outside their arrays, and non-integers Further cases can be supplied as tagged JSON (`--cases`, e.g. `{"$u32": [...]}`). The report includes `nativeAgreed`, because fuzzing alone can mostly hit traps: on 2,000 fuzzed graph cases, 1,670 were malformed CSR that trapped and 330 ran natively. For KWX, all 2,000 ran natively. There were no mismatches in either.

Fallbacks are only safe if native code cannot crash the process. Allocation lengths are therefore capped at 2^28 elements in the interpreter and in Rust; larger requests trap instead of risking an out-of-memory abort.

The native test suite checks four things:

- the wrapper runs natively, falls back on traps and on arguments outside the contract, and returns the original's results
- prepare inputs are snapshotted
- an observed and mutated state matches the original
- the parity runner passes on fuzzed and supplied cases

Without an addon, the wrapper and parity runner fall back fully; this case is tested without Rust.

## Backend Quality Pass and Acceptance Gate (v0.2.4)

**Integer specialization.** [`analyzeIntegers`](../src/lowering/integer-analysis.ts) is a flow-insensitive dataflow analysis over the IR. A numeric value is INT when every definition reaching it is an exact integer. Its sources are:

- integer literals other than `-0`
- lengths, `charCodeAt`, and integer typed-array reads
- `+`, `-`, `min`, `max`, and `?:` of INT operands
- INT locals, fields, returns, array elements, and map values

`*`, `/`, `%`, and unary `-` stay `f64`, because they can produce `-0` or non-integers. Array element and map value classes are unified with union-find along every flow (bindings, calls, returns, struct fields). One non-INT store demotes the whole class. Parameters that come from JavaScript are always `f64`. INT values become `i64` in Rust, with arithmetic checked to |v| ≤ 2^53, so they always equal the JS `f64` values; exceeding the bound traps. A `NONNEG` flag additionally proves values ≥ 0.

On the fixtures:

- **Graph kernel:** every local and array is INT, and its output is non-negative.
- **KWX:** the prepared state (`termCount`, `headByLower` values, `next`) and all scan locals are INT. The JS-supplied `minLength` stays `f64`. The output is INT but not provably non-negative (`firstOffset` starts at -1).

**Typed outputs in the contract.** A `number[]` return now crosses as a typed array declared in the contract's `BoundaryType`. It is `Uint32Array` when every element is proven non-negative INT, and `Float64Array` otherwise, which is exact for every number. The wrapper materializes `number[]` with `Array.from`, so the original signature is kept. A source that returns a typed array itself avoids that copy.

**Allocation reuse.** A non-escaping array allocated inside a loop gets one buffer per allocation site. At the original site the buffer is cleared and refilled. Non-escaping means it is never returned, stored, moved into a struct or container, or copied into another binding.

**Generated benchmark and gate.** `crankts extract` also writes `ts/benchmark.ts`. It times five things over supplied workloads:

- the original TypeScript
- the wrapper (guards, addon call, result materialization)
- the raw addon call, including N-API conversion
- the Rust-side kernel compute (`__lastKernelNanos`)
- an optional reference implementation, such as a handwritten PoC

It then evaluates the acceptance gate:

| Gate | Criterion |
| --- | --- |
| Correctness | generated parity on supplied and fuzzed cases: wrapper ≡ original, native ≡ original or trap |
| Performance | wrapper total < original total (median), i.e. the net saved time is positive |
| Backend quality | addon call ≤ 2× reference call (only with a reference) |
| Boundary | (wrapper − kernel compute) / (original − kernel compute) ≤ 0.5: transfer and materialization consume at most half of the possible saving |

**Results** ([crankts-v024-backend-quality.json](../evaluation/crankts-v024-backend-quality.json), [run-v024.ts](../evaluation/backend-quality/run-v024.ts)). Release builds, median of 5 runs, with the handwritten MVP-9b and MVP-8 addons as references. All four gates pass on every workload.

| Workload | Original TS | Wrapper | Generated call | Kernel | Handwritten | Ratio | Boundary share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph W1 (3,679 nodes) | 2.89 ms | 0.39 ms | 0.24 ms | 0.22 ms | 0.31 ms | 0.77x | 0.06 |
| Graph W1 ×10 | 10.9 ms | 2.78 ms | 1.53 ms | 1.48 ms | 1.44 ms | 1.06x | 0.14 |
| Graph W1 ×100 (367,900 nodes) | 106 ms | 29.9 ms | 16.7 ms | 16.4 ms | 13.6 ms | 1.23x | 0.15 |
| KWX (3,231 terms, 18,331 texts) | 217 ms | 139 ms | 133 ms | 119 ms | 90.7 ms | 1.47x | 0.20 |

Before v0.2.4 the generated graph call was 0.94, 6.1, and 59 ms (3.6 to 4.3 times the handwritten kernel). It is now 0.77 to 1.23 times the handwritten kernel. Three caveats apply to these numbers:

- **"Original" is the kernel-style TypeScript.** The graph original is 2.89 ms on W1, already faster than `islands.ts` with `Map`/`Set` (4.4 ms in MVP-9b). The speedups are therefore relative to an optimized TypeScript baseline.
- **The KWX workload is a stand-in for MVP-8's AX dictionary and chunks.** It uses IntentWeave's function names as the dictionary and paragraphs of its Markdown and `packages/*/src` TypeScript as texts, with no traps, guards, or internal errors in 111,192 native calls.
- **Each W1 graph run is a single call,** so the 1× numbers are close to timer resolution.

## Next Steps (from review.md)

1. **v0.2.5:** real KWX source → `PREPARED_STATE`. This needs callback and fast-path extraction from `extractDictionary`, plus mutation and lifetime handling of the caller's dictionary `Set`.
2. **v0.2.6:** real graph source → `GRAPH_BATCH`. This needs `FunctionId` interning, CSR packing upstream in the producer, and a producer-aware transformation.
3. **v0.2.7:** an explicit `TransformationPlan` that unifies both: extraction region, producer changes, preparation site, call replacement, fallback path, and validation plan. It also covers reversible source integration. This is a separate model between the TS semantic model and the Kernel IR; it does not belong in the IR.
4. **v0.3:** automatic candidate selection (advisor → qualifier → transformer), enabled only after validation.
