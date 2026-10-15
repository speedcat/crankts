// Second Observe agent comparison (docs/observe-agent-comparison.md, "Next comparison"): arms P, P+, O; outcome measured.
import { homedir } from "node:os";
import { resolve } from "node:path";

const here = import.meta.dirname;
export const cranktsRoot = resolve(here, "../..");
export const cranktsCli = resolve(cranktsRoot, "dist/cli.js");
export const evalRoot = resolve(cranktsRoot, "../crankts-eval");
export const campaignRoot = resolve(evalRoot, process.env.COMPARISON_CAMPAIGN ?? "observe-comparison-2026-10");

// The Node the subjects were set up and baselined with (dataset manifests); tsx 4.20 workloads.
export const node = process.env.COMPARISON_NODE ?? resolve(homedir(), ".volta/tools/image/node/24.21.0/bin/node");

export const arms = ["P", "P+", "O"];
export const repetitions = 2;

export const workloads = [
  {
    id: "typeorm-insert",
    subject: "typeorm",
    name: "relational-insert-500000-orders",
    args: ["--import", "./crankts-workloads/node_modules/tsx/dist/loader.mjs", "crankts-workloads/typeorm-workloads.mjs", "insert"],
    env: { TSX_TSCONFIG_PATH: "./packages/typeorm/tsconfig.json" },
    description: "TypeORM (better-sqlite3) inserts 500,000 orders with relations through the query builder in chunks.",
    // Agents and the outcome harness run the same tests.
    tests: {
      cwd: "packages/typeorm",
      commands: [
        "corepack pnpm run compile",
        // The full sqlite suite (about 3,100 tests, 20 s). The Redis integration needs Docker, as in the dataset manifest.
        "node_modules/.bin/mocha --config .mocharc.json --reporter dot --grep 'RedisQueryResultCache Integration' --invert",
      ],
    },
    editable: ["packages/typeorm/src/**"],
  },
  {
    id: "pdflib-modify",
    subject: "pdf-lib",
    name: "modify-large-existing-pdf",
    args: ["--import", "./crankts-workloads/node_modules/tsx/dist/loader.mjs", "./crankts-workloads/modify-large-pdf.mjs"],
    env: {},
    description: "pdf-lib loads a large existing PDF, adds text and an image to every page, and saves it.",
    tests: { cwd: ".", commands: ["corepack yarn@1.22.22 test"] },
    editable: ["src/**"],
  },
];

export const paths = {
  baseline: (subject) => resolve(campaignRoot, "baseline", subject),
  materials: (workloadId) => resolve(campaignRoot, "materials", workloadId),
  workspace: (runId) => resolve(campaignRoot, "workspaces", runId),
  prompt: (runId) => resolve(campaignRoot, "prompts", `${runId}.md`),
  outcome: (runId) => resolve(campaignRoot, "outcomes", `${runId}.json`),
  report: (runId) => resolve(campaignRoot, "reports", `${runId}.md`),
  runMap: resolve(campaignRoot, "control", "run-map.json"),
};
