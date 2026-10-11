// Eval #1: Knip 6.41.0 (dependency- and orchestration-heavy static analysis with native dependencies).
// Setup (pinned, outside the repo): ../crankts-eval/{knip@6.41.0, vite@v8.3.4 (vite built), tanstack-router@v1.166.7},
// dependencies installed with --ignore-scripts; ../intentweave and ../backstage (no dependencies) as local workloads.
import { resolve } from "node:path";
import type { StudyConfig } from "../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const evalRoot = resolve(repoRoot, "../crankts-eval");
const knip = (directory: string): string[] => [
  resolve(evalRoot, "knip/packages/knip/src/cli.ts"), "--directory", directory, "--no-progress", "--reporter", "compact", "--no-exit-code",
];

const study: StudyConfig = {
  name: "knip",
  version: "6.41.0",
  description: "Knip run from its TypeScript sources (Node type stripping) on five repositories",
  analysisRoot: resolve(evalRoot, "knip/packages/knip"),
  cwd: resolve(evalRoot, "knip"),
  // Exit code 2: Knip reports config files it could not load (degraded workloads); the run completes.
  acceptExitCodes: [0, 2],
  workloads: [
    { name: "knip (self)", args: knip(resolve(evalRoot, "knip")) },
    { name: "intentweave", args: knip(resolve(repoRoot, "../intentweave")) },
    { name: "vite@v8.3.4", args: knip(resolve(evalRoot, "vite")), degraded: "7 config files fail to load (unbuilt plugin-legacy)" },
    { name: "tanstack-router@v1.166.7", args: knip(resolve(evalRoot, "tanstack-router")), degraded: "~160 config files fail to load (workspace packages not built)" },
    { name: "backstage (local, no dependencies)", args: knip(resolve(repoRoot, "../backstage")), degraded: "~230 config files fail to load (no dependencies installed)" },
  ],
  annotations: resolve(repoRoot, "evaluation/knip/annotations.json"),
  output: resolve(repoRoot, "evaluation/crankts-knip-coverage.json"),
};
export default study;
