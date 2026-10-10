import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { analyzeProject } from "../src/analysis/analyze-project.js";
import { runCli } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workspace project-reference analysis", () => {
  it("resolves a cross-project implementation edge only in opt-in mode", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "crankts-project-refs-"));
    temporaryDirectories.push(workspaceRoot);
    const appSource = join(workspaceRoot, "packages", "app", "src");
    const coreSource = join(workspaceRoot, "packages", "core", "src");
    const coreDist = join(workspaceRoot, "packages", "core", "dist");
    const unreferencedSource = join(workspaceRoot, "packages", "unreferenced", "src");
    mkdirSync(appSource, { recursive: true });
    mkdirSync(coreSource, { recursive: true });
    mkdirSync(unreferencedSource, { recursive: true });

    writeFileSync(join(workspaceRoot, "tsconfig.json"), JSON.stringify({
      files: [],
      references: [{ path: "./packages/app" }, { path: "./packages/removed" }],
    }));
    for (const packageName of ["app", "core"]) {
      writeFileSync(join(workspaceRoot, "packages", packageName, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          rootDir: "src",
          outDir: "dist",
          ...(packageName === "core" ? { declarationMap: true } : {}),
        },
        include: ["src/**/*.ts"],
        ...(packageName === "app" ? { references: [{ path: "../core" }] } : {}),
      }));
    }
    writeFileSync(join(coreSource, "calculate.ts"), [
      "export function twice(value: number): number {",
      "  return value * 2;",
      "}",
      "export function mapped(value: number): number {",
      "  return value + 1;",
      "}",
    ].join("\n"));
    writeFileSync(join(coreSource, "unmapped.ts"), [
      "export function declarationOnly(value: number): number {",
      "  return value + 1;",
      "}",
    ].join("\n"));
    const coreConfigPath = join(workspaceRoot, "packages", "core", "tsconfig.json");
    const coreConfig = ts.readConfigFile(coreConfigPath, ts.sys.readFile);
    const coreParsedConfig = ts.parseJsonConfigFileContent(
      coreConfig.config,
      ts.sys,
      dirname(coreConfigPath),
    );
    const coreProgram = ts.createProgram(coreParsedConfig.fileNames, coreParsedConfig.options);
    expect(coreProgram.emit().emitSkipped).toBe(false);
    rmSync(join(coreDist, "unmapped.d.ts.map"), { force: true });
    writeFileSync(join(coreDist, "unmapped.d.ts"), [
      "export declare function declarationOnly(value: number): number;",
    ].join("\n"));
    writeFileSync(join(unreferencedSource, "other.ts"), [
      "export function unreferenced(value: number): number {",
      "  return value - 1;",
      "}",
    ].join("\n"));
    writeFileSync(join(appSource, "run.ts"), [
      'import { twice } from "../../core/src/calculate.js";',
      'import { mapped } from "../../core/dist/calculate.js";',
      'import { declarationOnly } from "../../core/dist/unmapped.js";',
      'import { unreferenced } from "../../unreferenced/src/other.js";',
      "export function run(value: number): number {",
      "  return twice(value) + mapped(value) + declarationOnly(value) + unreferenced(value);",
      "}",
    ].join("\n"));

    const packageOnly = analyzeProject(workspaceRoot);
    const workspace = analyzeProject(workspaceRoot, { workspaceReferences: true });
    const packageWorkspace = analyzeProject(join(workspaceRoot, "packages", "app"), {
      workspaceReferences: true,
    });
    const caller = workspace.functions.find((functionAnalysis) => functionAnalysis.name === "run");
    const callee = workspace.functions.find((functionAnalysis) => functionAnalysis.name === "twice");
    const mappedCallee = workspace.functions.find((functionAnalysis) => functionAnalysis.name === "mapped");
    const packageCaller = packageWorkspace.functions.find((functionAnalysis) => functionAnalysis.name === "run");
    const packageCallee = packageWorkspace.functions.find((functionAnalysis) => functionAnalysis.name === "twice");

    expect(packageOnly.functions).toHaveLength(0);
    expect(packageOnly.workspace).toBeUndefined();
    expect(workspace.workspace).toEqual({
      projectConfigsLoaded: 3,
      skippedReferences: ["packages/removed/tsconfig.json"],
    });
    expect(caller).toBeDefined();
    expect(callee).toBeDefined();
    expect(caller?.calls).toContainEqual(expect.objectContaining({
      callee: "twice",
      to: callee?.id,
      boundaryKind: "LOCAL_DIRECT",
    }));
    expect(caller?.calls).toContainEqual(expect.objectContaining({
      callee: "mapped",
      to: mappedCallee?.id,
      boundaryKind: "LOCAL_DIRECT",
    }));
    expect(packageCaller?.calls).toContainEqual(expect.objectContaining({
      callee: "twice",
      to: packageCallee?.id,
      boundaryKind: "LOCAL_DIRECT",
    }));
    expect(packageCaller?.file).toBe("src/run.ts");
    expect(packageCallee?.file).toBe("../core/src/calculate.ts");
    expect(packageCaller?.id).toMatch(/^app\/src\/run\.ts:/);
    expect(packageCallee?.id).toMatch(/^core\/src\/calculate\.ts:/);
    const declarationCall = caller?.calls.find((edge) => edge.callee === "declarationOnly");
    expect(declarationCall).toMatchObject({ kind: "EXTERNAL", boundaryKind: "EXTERNAL_TYPED" });
    expect(declarationCall?.to).toBeUndefined();
    expect(workspace.functions.some((functionAnalysis) => functionAnalysis.name === "declarationOnly")).toBe(true);
    expect(workspace.functions.some((functionAnalysis) => functionAnalysis.name === "unreferenced")).toBe(false);
    expect(new Set(workspace.functions.map((functionAnalysis) => functionAnalysis.id)).size)
      .toBe(workspace.functions.length);

    const profilePath = join(workspaceRoot, "workspace.cpuprofile");
    writeFileSync(profilePath, JSON.stringify({
      nodes: [{
        id: 1,
        callFrame: {
          functionName: "mapped",
          url: pathToFileURL(join(coreDist, "calculate.js")).href,
          lineNumber: 1,
        },
      }],
      samples: [1],
      timeDeltas: [1000],
    }));
    const profiledWorkspace = analyzeProject(workspaceRoot, {
      workspaceReferences: true,
      profilePath,
    });
    expect(profiledWorkspace.cpuProfile).toMatchObject({
      matchedSamplePercent: 100,
      confidence: "LOW",
    });
    expect(profiledWorkspace.functions.find((functionAnalysis) => functionAnalysis.name === "mapped")?.observedCpu)
      .toMatchObject({ selfCpuMicros: 1000, samplePercent: 100 });

    let cliOutput = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      cliOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    try {
      expect(runCli(["analyze", workspaceRoot, "--workspace-references", "--format=json"])).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
    }
    expect(JSON.parse(cliOutput).functions.map((functionAnalysis: { name: string }) => functionAnalysis.name))
      .toContain("twice");
  }, 30_000); // Builds several TypeScript programs; under parallel test load this exceeds the 5 s default.
});