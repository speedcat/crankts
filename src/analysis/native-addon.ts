import type * as ts from "typescript";
import type { CompilerFacade } from "../compiler/compiler-facade.js";
import { isNativeAddonPackageRoot, packageRootFromUrl } from "./cpu-profile.js";

/**
 * Lines (1-based) where a function calls into a native addon package (v0.2.6d, R2). N-API functions have
 * no profile frame: the time a call spends in Rust/C++ is the calling JavaScript frame's self time. Such
 * calls are found statically: the callee's declaration lives in a package whose manifest marks it as a
 * native addon (napi-rs, node-gyp, prebuild, per-platform binding packages). Nested functions are skipped
 * (they are profiled frames of their own).
 */
export function nativeAddonCallLines(fn: ts.Node, facade: CompilerFacade): ReadonlySet<number> {
  const cached = cache.get(fn);
  if (cached) return cached;
  const t = facade.typescript;
  const checker = facade.checker;
  const sourceFile = fn.getSourceFile();
  const lines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (node !== fn && t.isFunctionLike(node)) return;
    if (t.isCallExpression(node) || t.isNewExpression(node)) {
      const callee = t.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      let symbol = checker.getSymbolAtLocation(callee);
      if (symbol && symbol.flags & t.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declarationFile = symbol?.declarations?.[0]?.getSourceFile().fileName;
      const root = declarationFile ? packageRootFromUrl(declarationFile) : undefined;
      if (root && isNativeAddonPackageRoot(root)) {
        // V8 attributes a call's ticks to the line of the call position; cover the callee's lines.
        for (const position of [node.getStart(sourceFile), callee.getStart(sourceFile), callee.getEnd()]) {
          lines.add(sourceFile.getLineAndCharacterOfPosition(position).line + 1);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(fn);
  cache.set(fn, lines);
  return lines;
}

const cache = new WeakMap<ts.Node, ReadonlySet<number>>();
