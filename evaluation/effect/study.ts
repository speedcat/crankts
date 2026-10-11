// Eval #4: Effect 4.0.3 core (runtime-, state-, and concurrency-heavy TypeScript library).
// Setup (pinned, outside the repo): ../crankts-eval/effect@effect@4.0.3, `pnpm install --ignore-scripts --filter effect...`.
// Node runs the package's TypeScript sources directly (its exports point at src). Scratch workloads in
// packages/effect/crankts-workloads/: fiber-heavy programs, stream pipelines, and schema decode/encode.
import { resolve } from "node:path";
import type { StudyConfig } from "../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const pkg = resolve(repoRoot, "../crankts-eval/effect/packages/effect");

const study: StudyConfig = {
  name: "effect",
  version: "4.0.3",
  description: "Effect core on fiber, stream, and schema workloads (run from source)",
  analysisRoot: pkg,
  cwd: pkg,
  workloads: [
    { name: "fibers (Effect.gen, forEach, concurrency)", args: ["crankts-workloads/effects.ts"] },
    { name: "streams (map/filter/rechunk/fold, splitLines)", args: ["crankts-workloads/streams.ts"] },
    { name: "schema (decode/encode of 50-item orders)", args: ["crankts-workloads/schema.ts"] },
  ],
  annotations: resolve(repoRoot, "evaluation/effect/annotations.json"),
  output: resolve(repoRoot, "evaluation/crankts-effect-coverage.json"),
};
export default study;
