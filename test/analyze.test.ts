import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeProject } from "../src/analysis/analyze-project.js";
import { createCompilerFacade } from "../src/compiler/compiler-facade.js";
import { runCli } from "../src/index.js";
import { renderJsonReport } from "../src/report/json.js";
import { renderTextReport } from "../src/report/text.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/basic", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("analyzeProject", () => {
  it("loads the fixture, classifies functions, and discovers candidate components", () => {
    const result = analyzeProject(fixtureRoot);
    const functionByName = new Map(result.functions.map((functionAnalysis) => [functionAnalysis.name, functionAnalysis]));
    const buildGraph = functionByName.get("buildGraph");
    const resolveEdges = functionByName.get("resolveEdges");
    const constructor = functionByName.get("GraphBuilder.constructor");
    const multiHopCaller = functionByName.get("buildGraphThroughCaller");
    const pluginInvoker = functionByName.get("invokePlugin");
    const configLoader = functionByName.get("loadConfigAndBuild");
    const unknownFunction = functionByName.get("acceptsUnknown");
    const evalFunction = functionByName.get("invokesEval");
    const proxyFunction = functionByName.get("wrapsProxy");
    const reflectionFunction = functionByName.get("readsReflectively");
    const unresolvedFunction = functionByName.get("callsMissingHelper");
    const initialize = functionByName.get("initialize");
    const cycleA = functionByName.get("cycleA");
    const databaseQuery = functionByName.get("queryDatabase");
    const compatibilityDatabaseQuery = functionByName.get("queryThroughCompatDatabase");
    const networkRequest = functionByName.get("sendNetworkRequest");
    const processSpawner = functionByName.get("spawnProcess");
    const pureStandardLibrary = functionByName.get("usePureStandardLibrary");
    const runtimeStandardLibrary = functionByName.get("useRuntimeStandardLibrary");
    const typedExternal = functionByName.get("useTypedExternal");
    const unknownExternal = functionByName.get("useUnknownExternal");

    expect(result.typescript.source).toBe("bundled");
    expect(result.functions.length).toBeGreaterThanOrEqual(10);
    expect(buildGraph?.calls.some((edge) => edge.kind === "DIRECT_RESOLVED" && edge.callee === "resolveEdges")).toBe(true);
        expect(buildGraph?.calls.some((edge) => edge.callee === "resolveEdges" && edge.boundaryKind === "LOCAL_DIRECT")).toBe(true);
    expect(buildGraph?.calls.some((edge) => edge.kind === "CONSTRUCTOR" && edge.to === constructor?.id)).toBe(true);
    expect(buildGraph?.calls.some((edge) => edge.kind === "METHOD_RESOLVED" && edge.callee === "builder.build")).toBe(true);
    expect(resolveEdges?.calls.some((edge) => edge.kind === "CALLBACK")).toBe(true);
        expect(resolveEdges?.calls.some((edge) => edge.kind === "CALLBACK" && edge.boundaryKind === "LOCAL_CALLBACK")).toBe(true);
    expect(resolveEdges?.calls.some((edge) => edge.kind === "EXTERNAL" && edge.callee === "edges.filter")).toBe(true);
        expect(resolveEdges?.calls.some((edge) => edge.callee === "edges.filter" && edge.boundaryKind === "STDLIB_COLLECTION")).toBe(true);
    expect(pluginInvoker?.eligibility.kind).toBe("BLOCKED");
    expect(pluginInvoker?.eligibility.kind === "BLOCKED"
      && pluginInvoker.eligibility.blockers.some((blocker) => blocker.code === "DYNAMIC_CALL")).toBe(true);
    expect(configLoader?.eligibility.kind).toBe("BLOCKED");
    expect(configLoader?.calls.some((edge) => edge.kind === "DIRECT_RESOLVED" && edge.callee === "buildGraph")).toBe(true);
    expect(configLoader?.calls.some((edge) => edge.kind === "EXTERNAL" && edge.callee === "readFileSync")).toBe(true);
        expect(pluginInvoker?.calls.some((edge) => edge.kind === "DYNAMIC" && edge.boundaryKind === "DYNAMIC")).toBe(true);
        expect(configLoader?.calls.some((edge) => edge.kind === "EXTERNAL" && edge.callee === "readFileSync" && edge.boundaryKind === "NODE_IO")).toBe(true);
        expect(databaseQuery?.calls.some((edge) => edge.boundaryKind === "DATABASE")).toBe(true);
        expect(compatibilityDatabaseQuery?.calls.filter((edge) => edge.boundaryKind === "DATABASE")).toHaveLength(2);
        expect(networkRequest?.calls.some((edge) => edge.boundaryKind === "NETWORK")).toBe(true);
        expect(processSpawner?.calls.some((edge) => edge.boundaryKind === "PROCESS")).toBe(true);
        expect(pureStandardLibrary?.calls.some((edge) => edge.boundaryKind === "STDLIB_PURE")).toBe(true);
        expect(runtimeStandardLibrary?.calls.some((edge) => edge.boundaryKind === "STDLIB_RUNTIME")).toBe(true);
        expect(typedExternal?.calls.some((edge) => edge.boundaryKind === "EXTERNAL_TYPED")).toBe(true);
        expect(unknownExternal?.calls.some((edge) => edge.boundaryKind === "EXTERNAL_UNKNOWN")).toBe(true);
        const databaseIsland = result.candidateIslands.find((island) => island.members.includes(databaseQuery?.id ?? ""));
        expect(databaseIsland).toMatchObject({
          rawExitEdges: 1,
          effectiveExitEdges: 1,
          boundaryKinds: { DATABASE: 1 },
          boundaryRisk: "HIGH",
        });
        const pureLibraryIsland = result.candidateIslands.find((island) => island.members.includes(pureStandardLibrary?.id ?? ""));
        expect(pureLibraryIsland).toMatchObject({
          rawExitEdges: 1,
          effectiveExitEdges: 0,
          boundaryKinds: { STDLIB_PURE: 1 },
          boundaryRisk: "LOW",
        });
    expect(configLoader?.eligibility.kind === "BLOCKED"
      && configLoader.eligibility.blockers.some((blocker) => blocker.code === "NODE_RUNTIME_DEPENDENCY")).toBe(true);
    expect(unknownFunction?.eligibility.kind).toBe("CONDITIONAL");
    expect(unknownFunction?.eligibility.kind === "CONDITIONAL"
      && unknownFunction.eligibility.blockers.some((blocker) => blocker.code === "DYNAMIC_TYPE")).toBe(true);
    expect(evalFunction?.eligibility.kind).toBe("BLOCKED");
    expect(evalFunction?.eligibility.kind === "BLOCKED"
      && evalFunction.eligibility.blockers.some((blocker) => blocker.code === "EVAL_USAGE")).toBe(true);
    expect(proxyFunction?.eligibility.kind).toBe("BLOCKED");
    expect(proxyFunction?.eligibility.kind === "BLOCKED"
      && proxyFunction.eligibility.blockers.some((blocker) => blocker.code === "PROXY_USAGE")).toBe(true);
    expect(reflectionFunction?.eligibility.kind).toBe("CONDITIONAL");
    expect(reflectionFunction?.eligibility.kind === "CONDITIONAL"
      && reflectionFunction.eligibility.blockers.some((blocker) => blocker.code === "REFLECTION")).toBe(true);
    expect(unresolvedFunction?.calls.some((edge) => edge.kind === "UNRESOLVED")).toBe(true);
    expect(initialize?.eligibility.kind).toBe("CONDITIONAL");
    expect(initialize?.eligibility.kind === "CONDITIONAL"
      && initialize.eligibility.blockers.some((blocker) => blocker.code === "CALLEE_NOT_SUPPORTED")).toBe(true);
    expect(multiHopCaller?.eligibility.kind).toBe("CONDITIONAL");
    expect(cycleA?.eligibility.kind).toBe("CONDITIONAL");
    expect(result.candidateIslands.length).toBeGreaterThan(0);
    expect(result.candidateIslands.some((island) => island.entryEdges > 0 && island.exitEdges > 0)).toBe(true);
  });

  it("treats a file target as a seed scope and includes its local callees", () => {
    const graphFile = join(fixtureRoot, "src", "graph.ts");
    const result = analyzeProject(graphFile);
    const names = new Set(result.functions.map((functionAnalysis) => functionAnalysis.name));

    expect(names.has("buildGraph")).toBe(true);
    expect(names.has("GraphBuilder.build")).toBe(true);
    expect(names.has("invokePlugin")).toBe(false);
    expect(names.has("loadConfigAndBuild")).toBe(false);
  });

  it("does not execute project source files during analysis", () => {
    const previousValue = process.env.CRANKTS_FIXTURE_SHOULD_NOT_RUN;
    process.env.CRANKTS_FIXTURE_SHOULD_NOT_RUN = "yes";
    try {
      expect(() => analyzeProject(fixtureRoot)).not.toThrow();
    } finally {
      if (previousValue === undefined) {
        delete process.env.CRANKTS_FIXTURE_SHOULD_NOT_RUN;
      } else {
        process.env.CRANKTS_FIXTURE_SHOULD_NOT_RUN = previousValue;
      }
    }
  });

  it("renders versioned JSON and applies the minimum candidate score", () => {
    const result = analyzeProject(fixtureRoot);
    const report = JSON.parse(renderJsonReport(result, { minScore: 100 })) as {
      schemaVersion: number;
      summary: { candidateIslands: { total: number; reported: number } };
      candidateIslands: Array<{ score: number }>;
    };

    expect(report.schemaVersion).toBe(1);
    expect(report.summary.candidateIslands.total).toBe(result.candidateIslands.length);
    expect(report.summary.candidateIslands.reported).toBeLessThan(report.summary.candidateIslands.total);
    expect(report.candidateIslands.every((island) => island.score >= 100)).toBe(true);
  });
  it("includes typed call details in verbose text output", () => {
    const result = analyzeProject(fixtureRoot);
    const report = renderTextReport(result, { verbose: true });

    expect(report).toContain("Call edges:");
    expect(report).toContain("DIRECT_RESOLVED/LOCAL_DIRECT: buildGraph -> buildGraph()");
    expect(report).toContain("Internal edges:");
    expect(report).toContain("Boundary ratio:");
    expect(report).toContain("Articulation points:");
    expect(report).toContain("Boundary risk:");
    expect(report).toContain("DIRECT_RESOLVED/LOCAL_DIRECT:");
    expect(result.candidateIslands.every((island) => island.score === island.nativePriority)).toBe(true);
  });

  it("writes clean versioned JSON from the CLI and rejects invalid scores", () => {
    let output = "";
    let cliError = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(runCli(["analyze", fixtureRoot, "--format=json", "--min-score", "100"])).toBe(0);
      const report = JSON.parse(output) as {
        schemaVersion: number;
        summary: { candidateIslands: { total: number; reported: number } };
        candidateIslands: Array<{ score: number }>;
      };
      expect(report.schemaVersion).toBe(1);
      expect(report.summary.candidateIslands.reported).toBeLessThan(report.summary.candidateIslands.total);
      expect(report.candidateIslands.every((island) => island.score >= 100)).toBe(true);
      expect(runCli(["analyze", fixtureRoot, "--min-score", "101"])).toBe(2);
    } finally {
      stdoutSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("infers direct effects and propagates them through resolved calls", () => {
    const result = analyzeProject(fixtureRoot);
    const functionByName = new Map(result.functions.map((functionAnalysis) => [functionAnalysis.name, functionAnalysis]));
    const pureHelper = functionByName.get("pureHelper");
    const mutatingHelper = functionByName.get("mutateArgument");
    const mutatingCaller = functionByName.get("callerMutatesArgument");
    const allocator = functionByName.get("allocateLocally");
    const sharedStateReader = functionByName.get("readSharedState");
    const sharedStateWriter = functionByName.get("incrementSharedState");
    const effectCycleA = functionByName.get("effectCycleA");
    const fileWriter = functionByName.get("writeFile");
    const networkCaller = functionByName.get("fetchText");
    const fireAndForgetNetworkCaller = functionByName.get("startFetch");

    expect(pureHelper?.directEffects).toEqual(["PURE"]);
    expect(mutatingHelper?.directEffects).toContain("MUTATES_ARGUMENT");
    expect(mutatingCaller?.effects).toContain("MUTATES_ARGUMENT");
    expect(allocator?.directEffects).toContain("ALLOCATES");
    expect(allocator?.directEffects).toContain("MUTATES_LOCAL_STATE");
    expect(sharedStateReader?.directEffects).toContain("READS_EXTERNAL_STATE");
    expect(sharedStateWriter?.directEffects).toContain("MUTATES_GLOBAL_STATE");
    expect(effectCycleA?.effects).toContain("MUTATES_GLOBAL_STATE");
    expect(fileWriter?.directEffects).toContain("FILESYSTEM_IO");
    expect(fileWriter?.directEffects).toContain("WRITES_EXTERNAL_STATE");
    expect(networkCaller?.directEffects).toContain("NETWORK_IO");
    expect(networkCaller?.directEffects).toContain("SPAWNS_ASYNC_WORK");
    expect(fireAndForgetNetworkCaller?.directEffects).toContain("SPAWNS_ASYNC_WORK");
    expect(fireAndForgetNetworkCaller?.calls.some((edge) => edge.callee === "fetch" && edge.boundaryKind === "NETWORK")).toBe(true);

    const report = renderTextReport(result);
    expect(report).toContain("callerMutatesArgument(): MUTATES_ARGUMENT");
    expect(report).toContain("propagated: MUTATES_ARGUMENT");
  });

  it("scores CPU, memory, and parallel opportunity independently", () => {
    const result = analyzeProject(fixtureRoot);
    const functionByName = new Map(result.functions.map((functionAnalysis) => [functionAnalysis.name, functionAnalysis]));
    const sumSquares = functionByName.get("sumSquares");
    const buildRows = functionByName.get("buildRows");
    const sortValues = functionByName.get("sortValues");
    const loopAroundPlugin = functionByName.get("loopAroundPlugin");
    const factorial = functionByName.get("factorial");
    const recursiveArrow = functionByName.get("recursiveArrow");

    expect(sumSquares?.opportunities.cpu).toBeGreaterThan(0);
    expect(sumSquares?.opportunities.parallel).toBeGreaterThan(0);
    expect(buildRows?.opportunities.memory).toBeGreaterThan(0);
    expect(sortValues?.opportunities.cpu).toBeGreaterThan(0);
    expect(factorial?.opportunities.cpu).toBeGreaterThan(0);
    expect(recursiveArrow?.opportunities.cpu).toBeGreaterThan(0);
    for (const functionAnalysis of [sumSquares, buildRows, sortValues, loopAroundPlugin, factorial, recursiveArrow]) {
      if (!functionAnalysis) {
        throw new Error("Expected opportunity fixture function to be analyzed.");
      }
      const maxOpportunity = Math.max(
        functionAnalysis.opportunities.cpu,
        functionAnalysis.opportunities.memory,
        functionAnalysis.opportunities.parallel,
      );
      expect(functionAnalysis.nativePriority).toBe(
        Math.round(functionAnalysis.suitability * maxOpportunity / 100),
      );
    }
    for (const island of result.candidateIslands) {
      const maximumOpportunity = Math.max(
        island.opportunities.cpu,
        island.opportunities.memory,
        island.opportunities.parallel,
      );
      expect(island.nativePriority).toBe(Math.round(island.suitability * maximumOpportunity / 100));
      expect(island.score).toBe(island.nativePriority);
    }
    expect(loopAroundPlugin?.eligibility.kind).toBe("CONDITIONAL");
    expect(loopAroundPlugin?.suitability).toBe(85);
    expect(loopAroundPlugin?.directEffects).not.toContain("UNKNOWN_SIDE_EFFECT");
    expect(loopAroundPlugin?.effects).toContain("UNKNOWN_SIDE_EFFECT");
    expect(loopAroundPlugin?.opportunities.parallel).toBe(30);
    expect(loopAroundPlugin?.nativePriority).toBe(26);
  });

  it("maps V8 CPU profile samples to functions and orders candidates without changing native priority", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "crankts-cpuprofile-"));
    temporaryDirectories.push(temporaryDirectory);
    const profilePath = join(temporaryDirectory, "ingest.cpuprofile");
    const sourceUrl = pathToFileURL(join(fixtureRoot, "src", "opportunities.ts")).href;
    writeFileSync(profilePath, JSON.stringify({
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [2, 4] },
        { id: 2, callFrame: { functionName: "profiledRoot", url: sourceUrl, lineNumber: 0, columnNumber: 0 }, children: [3] },
        { id: 3, callFrame: { functionName: "profiledHelper", url: sourceUrl, lineNumber: 0, columnNumber: 0 } },
        { id: 4, callFrame: { functionName: "(idle)", url: "", lineNumber: 0, columnNumber: 0 } },
      ],
      samples: [2, 3, 2, 3, 4],
      timeDeltas: [100, 200, 150, 100, 450],
    }));

    let output = "";
    let cliError = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
      cliError = String(message);
    });

    try {
      expect(runCli(["analyze", fixtureRoot, "--profile", profilePath, "--format=json"]), cliError).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const report = JSON.parse(output) as {
      cpuProfile: { matchedSampleMicros: number; matchedSamplePercent: number; confidence: string };
      functions: Array<{ name: string; nativePriority: number; observedCpu?: { selfCpuMicros: number; totalCpuMicros: number; samplePercent: number; callCount: null } }>;
      candidateIslands: Array<{ members: string[]; nativePriority: number; observedCpu?: { selfCpuMicros: number; totalCpuMicros: number; samplePercent: number } }>;
    };
    const profiledRoot = report.functions.find((functionAnalysis) => functionAnalysis.name === "profiledRoot");
    const profiledHelper = report.functions.find((functionAnalysis) => functionAnalysis.name === "profiledHelper");
    const profiledIsland = report.candidateIslands.find((island) => (
      island.members.includes(profiledRoot?.id ?? "")
    ));
    const baseline = analyzeProject(fixtureRoot);
    const baselineRoot = baseline.functions.find((functionAnalysis) => functionAnalysis.name === "profiledRoot");

    expect(report.cpuProfile).toMatchObject({
      matchedSampleMicros: 550,
      matchedSamplePercent: 55,
      confidence: "LOW",
    });
    expect(profiledRoot?.observedCpu).toMatchObject({ selfCpuMicros: 250, totalCpuMicros: 550, samplePercent: 25, callCount: null });
    expect(profiledHelper?.observedCpu).toMatchObject({ selfCpuMicros: 300, totalCpuMicros: 300, samplePercent: 30, callCount: null });
    expect(profiledIsland?.observedCpu).toMatchObject({ selfCpuMicros: 550, totalCpuMicros: 550, samplePercent: 55 });
    expect(report.candidateIslands[0]?.members).toEqual(profiledIsland?.members);
    expect(profiledRoot?.nativePriority).toBe(baselineRoot?.nativePriority);
  });

  it("reports malformed V8 profiles with an actionable CLI error", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "crankts-invalid-profile-"));
    temporaryDirectories.push(temporaryDirectory);
    const profilePath = join(temporaryDirectory, "invalid.cpuprofile");
    writeFileSync(profilePath, JSON.stringify({ nodes: [], samples: [1], timeDeltas: [] }));
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });

    try {
      expect(runCli(["analyze", fixtureRoot, "--profile", profilePath])).toBe(1);
      expect(errors.join("\n")).toContain("expected nodes and aligned samples/timeDeltas arrays");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("createCompilerFacade", () => {
  it("uses a project's installed TypeScript when its package declares it", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "crankts-project-ts-"));
    temporaryDirectories.push(projectRoot);
    mkdirSync(join(projectRoot, "node_modules"), { recursive: true });
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({
      name: "compiler-facade-fixture",
      devDependencies: { typescript: "*" },
    }));
    writeFileSync(join(projectRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
      files: ["index.ts"],
    }));
    writeFileSync(join(projectRoot, "index.ts"), "export const value: number = 1;\n");

    const requireFromTest = createRequire(fileURLToPath(new URL("../package.json", import.meta.url)));
    const typescriptEntry = requireFromTest.resolve("typescript");
    const typescriptPackage = dirname(dirname(typescriptEntry));
    symlinkSync(typescriptPackage, join(projectRoot, "node_modules", "typescript"), "dir");

    const facade = createCompilerFacade(projectRoot);
    expect(facade.source).toBe("project");
    expect(facade.version).toMatch(/^\d+\.\d+/);
  });

  it("reports a missing tsconfig without attempting to execute the target", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "crankts-no-config-"));
    temporaryDirectories.push(projectRoot);
    expect(() => createCompilerFacade(projectRoot)).toThrow(/No tsconfig\.json found/);
  });
});