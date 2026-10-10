# KWX Native Scanner PoC

This isolated napi-rs experiment validates the ASCII dictionary-token scan inside IntentWeave's `HeuristicKeywordExtractor.extractDictionary`. It includes a manual full-extractor override and a runtime preload for a complete `iw index build`; neither is a production integration.

The addon returns flattened `[dictionary index, UTF-16 offset, UTF-16 length]` triples in dictionary order. The benchmark checks scanner parity on all document/comment chunks, then checks complete `KeywordMatch` objects after replacing only the simple ASCII scan. It measures a prepared native dictionary per input group and a cold document-only mode that transfers/rebuilds the dictionary per chunk.

## Run

Build the addon outside the workspace:

```bash
# From the CrankTS root on macOS
export CARGO_TARGET_DIR=/tmp/crankts-kwx-native-target
cargo test --manifest-path evaluation/kwx-native-poc/Cargo.toml
cargo build --release --manifest-path evaluation/kwx-native-poc/Cargo.toml
cp "$CARGO_TARGET_DIR/release/libkwx_native_poc.dylib" /tmp/kwx_native_poc.node
```

Run from the IntentWeave root, using a fresh full-depth TypeScript index DB:

```bash
node --import tsx ../crankts/evaluation/kwx-native-poc/benchmark.mjs \
  --index-db /tmp/crankts-iw-mvp8-profile/index.db \
  --native-addon /tmp/kwx_native_poc.node \
  --output /tmp/intentweave-mvp8-native.json
```

The runner uses IntentWeave's document discovery, AX output, source-comment extraction, and IN stage. It performs one warm-up and five measured rounds across both documentation chunks and source-comment chunks. The index DB is used only to identify stale document rows; missing paths are listed rather than silently read from cache.

## Full Build Probe

From the IntentWeave root, compare a normal TS build with the manual preload. Both outputs must stay outside the workspace:

```bash
node --max-old-space-size=4096 --import tsx packages/cli/src/cli.ts index build \
  --depth full --no-native --output /tmp/iw-ts.db --verbose .

CRANKTS_IW_ROOT="$PWD" CRANKTS_KWX_NATIVE_ADDON=/tmp/kwx_native_poc.node \
node --max-old-space-size=4096 --import tsx \
  --import ../crankts/evaluation/kwx-native-poc/native-preload.mjs \
  packages/cli/src/cli.ts index build --depth full --no-native \
  --output /tmp/iw-native.db --verbose .
```

## Limits

Scanner timing excludes markdown stripping, structured extraction, regex terms, `seen` handling, and `addMatch`; full-extractor timing includes those TypeScript paths and N-API/result conversion. The full-build preload assumes each dictionary remains immutable for the lifetime of an extractor. This does not preserve the public API's mutable-Set behavior in general, and it records no peak RSS or GC data. Do not enable it in production or infer automatic-offload safety from this PoC.