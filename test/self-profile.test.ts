import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeProject } from "../src/analysis/analyze-project.js";
import { classifyOrigin } from "../src/analysis/cpu-profile.js";
import { StageTimer } from "../src/analysis/timings.js";
import { runCli } from "../src/index.js";
import { renderJsonReport } from "../src/report/json.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/basic", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runCliCapturing(arguments_: readonly string[]): { readonly exitCode: number; readonly output: string; readonly error: string } {
  let output = "";
  let error = "";
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
    error += String(message);
  });
  try {
    return { exitCode: runCli(arguments_), output, error };
  } finally {
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("stage timings", () => {
  it("records every analysis stage without changing the analysis result", () => {
    const timer = new StageTimer();
    const timed = analyzeProject(fixtureRoot, { timings: timer });
    const untimed = analyzeProject(fixtureRoot);
    const stages = timer.toJSON().stages;
    const stageNames = stages.map((stage) => stage.name);

    expect(renderJsonReport(timed)).toBe(renderJsonReport(untimed));
    expect(stageNames).toEqual(expect.arrayContaining([
      "program",
      "functions",
      "callGraph",
      "direct",
      "direct.eligibility",
      "direct.effects",
      "propagation.eligibility",
      "propagation.effects",
      "scoring",
      "scoring.opportunities",
      "scoring.parallelism",
      "callClosure",
      "islands",
      "islands.adjacency",
      "islands.wcc",
      "islands.boundaries",
      "islands.components",
      "islands.components.articulation",
      "islands.sort",
      "assessment",
    ]));
    const eligibility = stages.find((stage) => stage.name === "direct.eligibility");
    expect(eligibility).toMatchObject({ kind: "accumulated" });
    expect(eligibility?.calls).toBeGreaterThan(1);
    const program = stages.find((stage) => stage.name === "program");
    expect(program).toMatchObject({ kind: "stage", calls: 1 });
    expect(program?.before?.rss).toBeGreaterThan(0);
    expect(program?.rssDelta).toBe((program?.after?.rss ?? 0) - (program?.before?.rss ?? 0));
  });

  it("writes a separate timings file from the CLI and keeps the report identical", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "crankts-timings-"));
    temporaryDirectories.push(temporaryDirectory);
    const timingsPath = join(temporaryDirectory, "timings.json");

    const timed = runCliCapturing(["analyze", fixtureRoot, "--format=json", "--timings", timingsPath]);
    const untimed = runCliCapturing(["analyze", fixtureRoot, "--format=json"]);
    expect(timed.exitCode, timed.error).toBe(0);
    expect(timed.output).toBe(untimed.output);

    const timings = JSON.parse(readFileSync(timingsPath, "utf8")) as {
      schemaVersion: number;
      stages: Array<{ name: string }>;
      totalMs: number;
      peakRssBytes: number;
    };
    expect(timings.schemaVersion).toBe(1);
    expect(timings.stages[0]?.name).toBe("startup");
    expect(timings.stages.at(-1)?.name).toBe("report");
    expect(timings.totalMs).toBeGreaterThan(0);
    expect(timings.peakRssBytes).toBeGreaterThan(0);
    expect(JSON.parse(timed.output)).not.toHaveProperty("timings");
  });

  it("rejects --timings without a path", () => {
    const result = runCliCapturing(["analyze", fixtureRoot, "--timings"]);
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain("--timings requires an output file path.");
  });
});

describe("CPU profile origins", () => {
  const projectRoot = "/work/project";

  it.each([
    [{ functionName: "(garbage collector)", url: "" }, "(garbage collector)", "GC"],
    [{ functionName: "(program)", url: "" }, "(program)", "PROGRAM"],
    [{ functionName: "(idle)", url: "" }, "(idle)", "IDLE"],
    [{ functionName: "sort", url: "" }, "(native)", "NATIVE"],
    [{ functionName: "toString", url: "" }, "(native)", "NATIVE"],
    [{ functionName: "readFileSync", url: "node:fs" }, "node", "NODE"],
    [{ functionName: "checkExpression", url: "file:///work/project/node_modules/typescript/lib/typescript.js" }, "typescript", "PACKAGE"],
    [{ functionName: "x", url: "file:///work/project/node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/index.js" }, "@scope/pkg", "PACKAGE"],
    [{ functionName: "local", url: "file:///work/project/dist/cli.js" }, "project", "PROJECT"],
    [{ functionName: "elsewhere", url: "file:///opt/other.js" }, "other", "OTHER"],
  ] as const)("classifies %o as %s", (callFrame, origin, kind) => {
    expect(classifyOrigin(callFrame, projectRoot)).toEqual({ origin, kind });
  });

  it("breaks down self and unmatched sample time by origin", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "crankts-origins-"));
    temporaryDirectories.push(temporaryDirectory);
    const profilePath = join(temporaryDirectory, "origins.cpuprofile");
    const sourceUrl = pathToFileURL(join(fixtureRoot, "src", "opportunities.ts")).href;
    const typescriptUrl = pathToFileURL(join(fixtureRoot, "node_modules", "typescript", "lib", "typescript.js")).href;
    writeFileSync(profilePath, JSON.stringify({
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2, 4, 5] },
        { id: 2, callFrame: { functionName: "profiledRoot", url: sourceUrl, lineNumber: 0 }, children: [3] },
        { id: 3, callFrame: { functionName: "checkSourceFile", url: typescriptUrl, lineNumber: 0 } },
        { id: 4, callFrame: { functionName: "createProgram", url: typescriptUrl, lineNumber: 0 } },
        { id: 5, callFrame: { functionName: "(garbage collector)", url: "" } },
      ],
      samples: [2, 3, 4, 5],
      timeDeltas: [100, 200, 300, 400],
    }));

    const result = analyzeProject(fixtureRoot, { profilePath });
    expect(result.cpuProfile?.matchedSampleMicros).toBe(300);
    expect(result.cpuProfile?.origins).toEqual([
      { origin: "typescript", kind: "PACKAGE", selfMicros: 500, selfPercent: 50, unmatchedMicros: 300, unmatchedPercent: 30 },
      { origin: "(garbage collector)", kind: "GC", selfMicros: 400, selfPercent: 40, unmatchedMicros: 400, unmatchedPercent: 40 },
      { origin: "project", kind: "PROJECT", selfMicros: 100, selfPercent: 10, unmatchedMicros: 0, unmatchedPercent: 0 },
    ]);
  });
});
