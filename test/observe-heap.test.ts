import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateHeapProfile, type V8HeapProfileNode } from "../src/observe/aggregate/heap.js";
import { FrameResolver } from "../src/observe/resolve/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("heap aggregation", () => {
  it("charges self bytes to the leaf and inclusive bytes once per entity on the path", () => {
    const root = mkdtempSync(join(tmpdir(), "crankts-observe-heap-"));
    directories.push(root);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(join(root, "src", "a.ts"), "export function outer() { return inner(); }\nexport function inner() { return [1]; }\n");
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "export function make() { return {}; }\n");
    const url = pathToFileURL(join(root, "src", "a.ts")).href;
    const depUrl = pathToFileURL(join(root, "node_modules", "dep", "index.js")).href;
    let id = 0;
    const node = (functionName: string, frameUrl: string, line: number, column: number, selfSize: number, children: V8HeapProfileNode[] = []): V8HeapProfileNode => ({
      id: ++id, callFrame: { functionName, url: frameUrl, lineNumber: line, columnNumber: column }, selfSize, children,
    });
    const inner = node("inner", url, 1, 7, 100);
    const viaDep = node("make", depUrl, 0, 7, 30);
    const recursive = node("outer", url, 0, 7, 20);
    const outer = node("outer", url, 0, 7, 50, [inner, viaDep, recursive]);
    const head = node("(root)", "", -1, -1, 0, [outer]);
    const result = aggregateHeapProfile({ head, samples: [{ size: 100, nodeId: inner.id }, { size: 100, nodeId: inner.id }, { size: 30, nodeId: viaDep.id }] }, new FrameResolver(root));

    expect(result.allocations.get("app::src/a.ts::inner")).toEqual({ selfBytes: 100, inclusiveBytes: 100, samples: 2, inclusiveSamples: 2 });
    // outer: self 50 + 20 (its recursive call); inclusive counts each byte once even though outer is on the path twice.
    expect(result.allocations.get("app::src/a.ts::outer")).toEqual({ selfBytes: 70, inclusiveBytes: 200, samples: 0, inclusiveSamples: 3 });
    expect(result.allocations.get("dep::*")).toMatchObject({ selfBytes: 30, inclusiveBytes: 30 });
    expect(result.summary).toMatchObject({ totalBytes: 200, sampleCount: 3, byCategory: { own: 170, dependency: 30 }, includesCollected: true });
  });
});
