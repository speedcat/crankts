import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = new URL("../fixtures/observe", import.meta.url).pathname;

export const fixtureSource = fixture;

/** Whether this Node runs `.ts` files directly (type stripping, unflagged since 22.18). */
export const typeStripping = ((process as { features?: { typescript?: unknown } }).features?.typescript ?? false) !== false;

/** A temporary copy of test/fixtures/observe with the `fakedep` package installed; optionally built with tsc. */
export function createObserveFixture(options: { readonly build?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "crankts-observe-"));
  cpSync(fixture, root, { recursive: true });
  const dep = join(root, "node_modules", "fakedep");
  mkdirSync(dep, { recursive: true });
  writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "fakedep", version: "1.0.0", type: "module", main: "index.js", types: "index.d.ts" }));
  writeFileSync(join(dep, "index.js"), [
    "export function heavy(ms) {",
    "  const end = performance.now() + ms;",
    "  let acc = 0;",
    "  do {",
    "    for (let i = 0; i < 1000; i += 1) acc = (acc + Math.imul(i, 2654435761)) | 0;",
    "  } while (performance.now() < end);",
    "  return acc;",
    "}",
  ].join("\n"));
  writeFileSync(join(dep, "index.d.ts"), "export declare function heavy(ms: number): number;\n");
  if (options.build) {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: root, stdio: "pipe" });
  }
  return root;
}
