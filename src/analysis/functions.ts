import { relative, resolve, sep } from "node:path";
import type * as ts from "typescript";
import { isPathWithin } from "../compiler/compiler-facade.js";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import type { FunctionId } from "./model.js";

export interface FunctionDefinition {
  readonly id: FunctionId;
  readonly name: string;
  readonly file: string;
  readonly absoluteFile: string;
  readonly line: number;
  readonly node: ts.FunctionLikeDeclaration;
  readonly sourceFile: ts.SourceFile;
  readonly isSeed: boolean;
}

export interface FunctionIndex {
  readonly definitions: readonly FunctionDefinition[];
  readonly byId: ReadonlyMap<FunctionId, FunctionDefinition>;
  readonly byNode: WeakMap<ts.Node, FunctionId>;
  readonly symbolToFunction: ReadonlyMap<ts.Symbol, FunctionId>;
  readonly classSymbolToConstructor: ReadonlyMap<ts.Symbol, FunctionId>;
}

export function collectFunctions(facade: CompilerFacade): FunctionIndex {
  const definitions: FunctionDefinition[] = [];
  const byId = new Map<FunctionId, FunctionDefinition>();
  const byNode = new WeakMap<ts.Node, FunctionId>();
  const symbolToFunction = new Map<ts.Symbol, FunctionId>();
  const classSymbolToConstructor = new Map<ts.Symbol, FunctionId>();

  for (const sourceFile of facade.program.getSourceFiles()) {
    const absoluteFile = resolve(sourceFile.fileName);
    if (!isProjectSourceFile(absoluteFile, sourceFile, facade.projectRoot)) {
      continue;
    }

    const file = relative(facade.projectRoot, absoluteFile).split(sep).join("/");
    const visit = (node: ts.Node): void => {
      if (isFunctionBoundary(node, facade.typescript) && hasBody(node)) {
        const start = node.getStart(sourceFile);
        const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        const definition: FunctionDefinition = {
          id: `${file}:${start}`,
          name: getFunctionName(node, line, facade.typescript),
          file,
          absoluteFile,
          line,
          node,
          sourceFile,
          isSeed: isTargetFile(facade, absoluteFile),
        };

        definitions.push(definition);
        byId.set(definition.id, definition);
        byNode.set(node, definition.id);

        for (const symbol of getFunctionSymbols(node, facade.checker, facade.typescript)) {
          symbolToFunction.set(symbol, definition.id);
        }

        if (facade.typescript.isConstructorDeclaration(node)
          && facade.typescript.isClassLike(node.parent)
          && node.parent.name) {
          const classSymbol = facade.checker.getSymbolAtLocation(node.parent.name);
          if (classSymbol) {
            classSymbolToConstructor.set(classSymbol, definition.id);
          }
        }
      }

      facade.typescript.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  definitions.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return {
    definitions,
    byId,
    byNode,
    symbolToFunction,
    classSymbolToConstructor,
  };
}

export function isFunctionBoundary(node: ts.Node, typescript: typeof import("typescript")): node is ts.FunctionLikeDeclaration {
  return typescript.isFunctionDeclaration(node)
    || typescript.isFunctionExpression(node)
    || typescript.isArrowFunction(node)
    || typescript.isMethodDeclaration(node)
    || typescript.isConstructorDeclaration(node)
    || typescript.isGetAccessorDeclaration(node)
    || typescript.isSetAccessorDeclaration(node);
}

function hasBody(node: ts.FunctionLikeDeclaration): boolean {
  return Boolean(node.body);
}

function isProjectSourceFile(filePath: string, sourceFile: ts.SourceFile, projectRoot: string): boolean {
  if (sourceFile.isDeclarationFile || !isPathWithin(projectRoot, filePath)) {
    return false;
  }

  return !filePath.split(/[\\/]/).includes("node_modules");
}

function isTargetFile(facade: CompilerFacade, filePath: string): boolean {
  if (facade.targetIsDirectory) {
    return isPathWithin(facade.targetPath, filePath);
  }
  return resolve(facade.targetPath) === resolve(filePath);
}

function getFunctionName(
  node: ts.FunctionLikeDeclaration,
  line: number,
  typescript: typeof import("typescript"),
): string {
  if (typescript.isConstructorDeclaration(node) && typescript.isClassLike(node.parent)) {
    const className = node.parent.name ? getNameText(node.parent.name, typescript) : "anonymous class";
    return `${className}.constructor`;
  }

  if ((typescript.isMethodDeclaration(node)
    || typescript.isGetAccessorDeclaration(node)
    || typescript.isSetAccessorDeclaration(node))
    && typescript.isClassLike(node.parent)) {
    const className = node.parent.name ? getNameText(node.parent.name, typescript) : "anonymous class";
    return `${className}.${getNameText(node.name, typescript)}`;
  }

  if ("name" in node && node.name) {
    return getNameText(node.name, typescript);
  }

  const parent = node.parent;
  if (typescript.isVariableDeclaration(parent) && parent.initializer === node) {
    return getNameText(parent.name, typescript);
  }
  if (typescript.isPropertyAssignment(parent) && parent.initializer === node) {
    return getNameText(parent.name, typescript);
  }
  if (typescript.isPropertyDeclaration(parent) && parent.initializer === node) {
    return getNameText(parent.name, typescript);
  }

  return `callback@${line}`;
}

function getNameText(name: ts.PropertyName | ts.BindingName, typescript: typeof import("typescript")): string {
  if (typescript.isIdentifier(name) || typescript.isStringLiteral(name) || typescript.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

function getFunctionSymbols(
  node: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  typescript: typeof import("typescript"),
): ts.Symbol[] {
  const symbols: ts.Symbol[] = [];
  const addSymbol = (name: ts.Node | undefined): void => {
    if (!name) {
      return;
    }
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol && !symbols.includes(symbol)) {
      symbols.push(symbol);
    }
  };

  if ("name" in node && node.name) {
    addSymbol(node.name);
  }

  const parent = node.parent;
  if (typescript.isVariableDeclaration(parent) && parent.initializer === node) {
    addSymbol(parent.name);
  } else if (typescript.isPropertyAssignment(parent) && parent.initializer === node) {
    addSymbol(parent.name);
  } else if (typescript.isPropertyDeclaration(parent) && parent.initializer === node) {
    addSymbol(parent.name);
  }

  return symbols;
}
