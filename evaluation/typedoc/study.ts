// Eval #2: TypeDoc 0.28.20 (TypeScript checker- and AST-heavy documentation generator).
// Setup (pinned, outside the repo): ../crankts-eval/typedoc@v0.28.20, dependencies installed with
// --ignore-scripts, `hereby build` for static assets. TypeDoc runs from its TypeScript sources through tsx
// (its build is an esbuild bundle, whose frames would not map back to source files): `--conditions=typedoc-ts`
// resolves its self-imports (`import … from "typedoc"`) to src/lib, and tsx uses src/lib/tsconfig.json
// (JSX factory of the HTML theme).
import { resolve } from "node:path";
import type { StudyConfig } from "../coverage/run-study.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const evalRoot = resolve(repoRoot, "../crankts-eval");
const typedoc = resolve(evalRoot, "typedoc");
const run = (name: string, entry: string, tsconfig: string): StudyConfig["workloads"][number] => ({
  name,
  env: { TSX_TSCONFIG_PATH: resolve(typedoc, "src/lib/tsconfig.json") },
  args: ["--conditions=typedoc-ts", "--import", "tsx", resolve(typedoc, "src/lib/cli.ts"), "--entryPoints", entry, "--tsconfig", tsconfig,
    "--out", resolve(evalRoot, "out/typedoc", name.replace(/\W+/g, "-")), "--logLevel", "Error", "--skipErrorChecking"],
});

const study: StudyConfig = {
  name: "typedoc",
  version: "0.28.20",
  description: "TypeDoc generating HTML documentation for five TypeScript projects (run from source through tsx)",
  analysisRoot: resolve(typedoc, "src/lib"),
  cwd: typedoc,
  workloads: [
    run("typedoc (self)", resolve(typedoc, "src/lib/index.ts"), resolve(typedoc, "src/lib/tsconfig.json")),
    run("crankts", resolve(repoRoot, "src/index.ts"), resolve(repoRoot, "tsconfig.json")),
    run("knip", resolve(evalRoot, "knip/packages/knip/src/index.ts"), resolve(evalRoot, "knip/packages/knip/tsconfig.json")),
    run("tanstack router-core", resolve(evalRoot, "tanstack-router/packages/router-core/src/index.ts"), resolve(evalRoot, "tanstack-router/packages/router-core/tsconfig.json")),
    run("vite (node API)", resolve(evalRoot, "vite/packages/vite/src/node/index.ts"), resolve(evalRoot, "vite/packages/vite/src/node/tsconfig.json")),
  ],
  annotations: resolve(repoRoot, "evaluation/typedoc/annotations.json"),
  output: resolve(repoRoot, "evaluation/crankts-typedoc-coverage.json"),
};
export default study;
