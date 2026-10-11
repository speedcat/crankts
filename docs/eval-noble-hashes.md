# External Evaluation #5: noble-hashes (Compute-Heavy Control)

noble-hashes 2.4.0 is hand-optimized pure TypeScript: SHA-2, SHA-3, BLAKE, scrypt, argon2, pbkdf2 over typed arrays. It is the opposite of [Knip](eval-knip.md): no I/O, no native dependencies, no AST graphs. It is an **upper bound**, not representative backend code, and cryptography is exactly what one would write natively. If CrankTS finds little here, that is a harsh signal about the lowering; if it finds a lot, that says little about typical applications.

- **Data:** [crankts-noble-hashes-coverage.json](../evaluation/crankts-noble-hashes-coverage.json), config [noble-hashes/study.ts](../evaluation/noble-hashes/study.ts), labels in `annotations.json` (my judgment; they need your review).
- **Workloads** (scratch files in `../crankts-eval/noble-hashes/crankts-workloads/`): bulk hashing (30 rounds × 8 hashes × 1 MiB), KDFs (pbkdf2 1M iterations, scrypt N=2^15, argon2id with 64 MiB), and 300k small messages through hash/hmac/hkdf. Node runs the TypeScript sources directly; the analysis used the project's TypeScript 6.0.3.

## Result

Percent of profiled runtime, medians over 3 runs:

| Workload | Attributable | Own JS | Human-plausible | Evidence-supported | Recognized | Transformable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| bulk hashing | 95.5 | 95.4 | 78.4 | 0 | 0 | 0 |
| KDFs | 95.6 | 95.6 | 71.6 | 0 | 0 | 0 |
| small messages | 91.8 | 88.0 | 65.4 | 0 | 0 | 0 |

**The hot code is pure compute (88–96% own JavaScript), and CrankTS recognizes none of it.** The call sites: `keccakP` (35–38%), BLAKE3 `_compress` (15%), the BLAKE2 mixing functions (5–7% each), `SHA2_32B.process`/`SHA2_64B.process` (7–33%), and Argon2's `block`/`G` (17–22%).

## Why Nothing Is Recognized

The advisor does not even recommend native execution for `keccakP`, the most native-shaped kernel in the study. The reasons are in the static analysis and the lowering, not in the profile:

1. **The eligibility analysis marks typed-array indexing as dynamic.** `keccakP` is `CONDITIONAL` because `s[x]`, `s[x + 10]`, … on a `Uint32Array` are reported as "computed property access … not modeled" (`DYNAMIC_PROPERTY_ACCESS`), and because `throw new TypeError(…)` counts as an unknown external call. Together they set `boundaryRisk: HIGH` and native potential `LOW`. This is a recognition bug-class: integer-indexed typed-array access is the core of numeric kernels.
2. **The lowering rejects every hot function**, for reasons that are several separate capabilities, not one missing IR piece. Weighted by runtime (a call site counts for its first rejection reason):

| Blocker | Bulk | KDF | Small messages |
| --- | ---: | ---: | ---: |
| union types (`TArg<Uint32Array>`, noble's conditional type that resolves to a union with `ArrayBufferLike` buffers) | 64.7 | 16.7 | 51.3 |
| method uses `this` (the `process` methods of the SHA-2 classes) | 7.0 | 33.1 | 23.6 |
| captured module-level state (argon2's shared buffer) | – | 21.8 | – |
| operator not lowered (`\|`, bitwise OR) | 5.4 | – | – |
| not a kernel function form | – | 5.5 | – |

A first-rejection histogram understates the problem: after `TArg`, `keccakP` still has `instanceof`, `throw`, a default parameter, and module-level constant tables (`SHA3_IOTA_H`), and the BLAKE functions use shifts and rotations. The lowering today has no bitwise operators at all (confirmed by the `|` rejection), and the integer analysis models `+`, `-`, `min`, `max`.

## What This Says

- **The pattern family exists** (native kernels over typed arrays, family recall 1.0), **the instances are not reachable**: the gap is a bundle of capabilities (bitwise and rotation semantics with 32-bit wrapping, generic typed-array types, `this`-bound state objects, throwing guards as traps, constant tables), not one small piece. This is the measured answer to the review's question "does one small IR addition unlock a lot?": no. Several are needed before the first function lowers.
- **The native-gain question is open too.** Whether Rust beats V8 on these loops is unmeasured here. V8 compiles 32-bit integer loops well, and KWX's native scan was at parity. The labels stay PLAUSIBLE until a kernel is built and measured; this study does not build one.
- **The static eligibility analysis needs a fix before the next study**, since it hides exactly the kernels it should surface (typed-array indexing, throw as guard). This is a recognition improvement, not a new transformer, and I have not made it (the rule is to measure first). It is the cheapest high-yield item the studies have shown.
