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
  readonly targetPath: string;
  readonly targetIsDirectory: boolean;
  readonly configPath: string;
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

export function createCompilerFacade(target: string): CompilerFacade {
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
    ...(parsedConfig.projectReferences ? { projectReferences: parsedConfig.projectReferences } : {}),
  });

  return {
    typescript: compiler.typescript,
    version: compiler.typescript.version,
    source: compiler.source,
    program,
    checker: program.getTypeChecker(),
    projectRoot,
    targetPath,
    targetIsDirectory,
    configPath,
  };
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
        return {
          typescript: projectRequire("typescript") as typeof ts,
          source: "project",
        };
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