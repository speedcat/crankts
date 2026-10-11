import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type * as ts from "typescript";

export type CompilerSource = "project" | "bundled";

export interface CompilerFacade {
  readonly typescript: typeof ts;
  readonly version: string;
  readonly source: CompilerSource;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly projectFacades?: readonly CompilerFacade[];
  readonly skippedProjectReferences?: readonly string[];
  readonly targetPath: string;
  readonly targetIsDirectory: boolean;
  readonly configPath: string;
}

export interface CompilerFacadeOptions {
  readonly workspaceReferences?: boolean;
}

interface LoadedCompiler {
  readonly typescript: typeof ts;
  readonly source: CompilerSource;
}

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

const bundledRequire = createRequire(import.meta.url);
const bundledTypescript = bundledRequire("typescript") as typeof ts;
const bundledTypescriptPath = bundledRequire.resolve("typescript");

export function createCompilerFacade(target: string, options: CompilerFacadeOptions = {}): CompilerFacade {
  const targetPath = resolve(target);
  if (!existsSync(targetPath)) {
    throw new Error(`Target does not exist: ${targetPath}`);
  }

  const targetIsDirectory = statSync(targetPath).isDirectory();
  const configSearchDirectory = targetIsDirectory ? targetPath : dirname(targetPath);
  const configPath = findTsconfig(configSearchDirectory);
  if (!configPath) {
    throw new Error(`No tsconfig.json found from ${configSearchDirectory} or its parent directories.`);
  }

  const rootFacade = createFacadeFromConfig(
    targetPath,
    targetIsDirectory,
    configPath,
    !options.workspaceReferences,
  );
  if (!options.workspaceReferences) {
    return { ...rootFacade, workspaceRoot: rootFacade.projectRoot };
  }

  const skippedProjectReferences: string[] = [];
  const projectFacades = collectReferencedFacades(rootFacade, skippedProjectReferences);
  const workspaceRoot = findCommonDirectory(projectFacades.map((facade) => facade.projectRoot));
  return {
    ...rootFacade,
    workspaceRoot,
    projectFacades,
    skippedProjectReferences: [...new Set(skippedProjectReferences)].sort(),
  };
}

function createFacadeFromConfig(
  targetPath: string,
  targetIsDirectory: boolean,
  configPath: string,
  includeProjectReferences = true,
): CompilerFacade {
  const projectRoot = dirname(configPath);
  const compiler = loadProjectCompiler(projectRoot);
  const configDiagnostics: ts.Diagnostic[] = [];
  const configHost: ts.ParseConfigFileHost = {
    ...compiler.typescript.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => configDiagnostics.push(diagnostic),
  };
  const parsedConfig = compiler.typescript.getParsedCommandLineOfConfigFile(configPath, {}, configHost);
  const diagnostics = [
    ...configDiagnostics,
    ...(parsedConfig?.errors ?? []),
  ];

  if (!parsedConfig || diagnostics.length > 0) {
    throw new Error(formatDiagnostics(compiler.typescript, diagnostics));
  }

  const program = compiler.typescript.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
    ...(includeProjectReferences && parsedConfig.projectReferences
      ? { projectReferences: parsedConfig.projectReferences }
      : {}),
  });

  return {
    typescript: compiler.typescript,
    version: compiler.typescript.version,
    source: compiler.source,
    program,
    checker: program.getTypeChecker(),
    projectRoot,
    workspaceRoot: projectRoot,
    targetPath,
    targetIsDirectory,
    configPath,
  };
}

function collectReferencedFacades(
  rootFacade: CompilerFacade,
  skippedReferences: string[],
): CompilerFacade[] {
  const facades = [rootFacade];
  const visitedConfigs = new Set([resolve(rootFacade.configPath)]);
  let currentIndex = 0;

  while (currentIndex < facades.length) {
    const currentFacade = facades[currentIndex];
    currentIndex += 1;
    if (!currentFacade) {
      continue;
    }

    const configDiagnostics: ts.Diagnostic[] = [];
    const configHost: ts.ParseConfigFileHost = {
      ...currentFacade.typescript.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => configDiagnostics.push(diagnostic),
    };
    const parsedConfig = currentFacade.typescript.getParsedCommandLineOfConfigFile(
      currentFacade.configPath,
      {},
      configHost,
    );
    const diagnostics = [...configDiagnostics, ...(parsedConfig?.errors ?? [])];
    if (!parsedConfig || diagnostics.length > 0) {
      throw new Error(formatDiagnostics(currentFacade.typescript, diagnostics));
    }

    for (const reference of parsedConfig.projectReferences ?? []) {
      const referencePath = resolve(dirname(currentFacade.configPath), reference.path);
      const referenceConfigPath = reference.path.toLowerCase().endsWith(".json")
        ? referencePath
        : join(referencePath, "tsconfig.json");
      if (!existsSync(referenceConfigPath) || !statSync(referenceConfigPath).isFile()) {
        skippedReferences.push(relative(rootFacade.projectRoot, referenceConfigPath).split(sep).join("/"));
        continue;
      }
      const canonicalConfigPath = resolve(referenceConfigPath);
      if (visitedConfigs.has(canonicalConfigPath)) {
        continue;
      }
      visitedConfigs.add(canonicalConfigPath);
      facades.push(createFacadeFromConfig(
        rootFacade.targetPath,
        rootFacade.targetIsDirectory,
        canonicalConfigPath,
        false,
      ));
    }
  }

  return facades;
}

function findCommonDirectory(paths: readonly string[]): string {
  const [firstPath, ...remainingPaths] = paths;
  if (!firstPath) {
    throw new Error("Cannot determine a workspace root without project references.");
  }

  let commonDirectory = resolve(firstPath);
  while (!remainingPaths.every((path) => isPathWithin(commonDirectory, path))) {
    const parentDirectory = dirname(commonDirectory);
    if (parentDirectory === commonDirectory) {
      return commonDirectory;
    }
    commonDirectory = parentDirectory;
  }
  return commonDirectory;
}

function findTsconfig(startDirectory: string): string | undefined {
  let currentDirectory = resolve(startDirectory);

  while (true) {
    const candidate = join(currentDirectory, "tsconfig.json");
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

function loadProjectCompiler(projectRoot: string): LoadedCompiler {
  const packagePath = join(projectRoot, "package.json");
  if (existsSync(packagePath) && packageDeclaresTypeScript(packagePath)) {
    try {
      const projectRequire = createRequire(packagePath);
      const projectTypescriptPath = projectRequire.resolve("typescript");
      const hasProjectInstallation = existsSync(join(projectRoot, "node_modules", "typescript"));

      if (projectTypescriptPath !== bundledTypescriptPath || hasProjectInstallation) {
        const projectTypescript = projectRequire("typescript") as typeof ts;
        // TypeScript 7 (the Go port) ships no JavaScript compiler/checker API: analyze with the bundled 5.x.
        if (hasCompilerApi(projectTypescript)) {
          return {
            typescript: projectTypescript,
            source: "project",
          };
        }
      }
    } catch {
      // A declared but unavailable project compiler falls back to CrankTS's compiler.
    }
  }

  return {
    typescript: bundledTypescript,
    source: "bundled",
  };
}

/** The parts of the TypeScript API CrankTS needs (absent from TypeScript 7's JavaScript package). */
function hasCompilerApi(candidate: typeof ts): boolean {
  return typeof candidate.createProgram === "function"
    && typeof candidate.getParsedCommandLineOfConfigFile === "function"
    && typeof candidate.createCompilerHost === "function";
}

function packageDeclaresTypeScript(packagePath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as PackageManifest;
    return Boolean(
      manifest.dependencies?.typescript
      || manifest.devDependencies?.typescript
      || manifest.peerDependencies?.typescript,
    );
  } catch {
    return false;
  }
}

function formatDiagnostics(typescript: typeof ts, diagnostics: readonly ts.Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return "Unable to parse the project's tsconfig.json.";
  }

  return typescript.formatDiagnostics(diagnostics, {
    getCurrentDirectory: () => typescript.sys.getCurrentDirectory(),
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => typescript.sys.newLine,
  }).trim();
}

export function isPathWithin(rootDirectory: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(rootDirectory), resolve(candidatePath));
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath));
}