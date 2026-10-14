import { rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderText, runQueryCommand } from "../src/observe/cli/index.js";
import { createMcpServer } from "../src/observe/mcp/server.js";
import {
  getCallers,
  getDependencyCosts,
  getFunctionMetrics,
  getHotFunctions,
  getHotRanges,
  getSummary,
  QueryError,
  resolveKey,
  SessionStore,
  type LoadedSession,
} from "../src/observe/query/index.js";
import { observeWorkload } from "../src/observe/session.js";
import { createObserveFixture } from "./helpers/observe-fixture.js";

/** M4 (docs/observe-plan.md §9): CLI and MCP answer from one query layer over a recorded session. */

let root = "";
let store: SessionStore;
let loaded: LoadedSession;
const key = (name: string) => `observe-fixture::src/${name}`;

beforeAll(async () => {
  root = createObserveFixture({ build: true });
  process.env["OBSERVE_FIXTURE_UNIT_MS"] = "10";
  const result = await observeWorkload({ command: [process.execPath, "dist/main.js"], cwd: root, stdio: "ignore" });
  expect(result.error).toBeUndefined();
  store = new SessionStore({ root });
  loaded = store.load();
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("query layer", () => {
  it("loads the newest session and lists it", () => {
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ quality: "high", command: `${process.execPath} dist/main.js`, measurements: ["cpu", "coverage", "heap"] });
  });

  it("resolves keys, unique names, and file:line", () => {
    expect(resolveKey(loaded, "normalizeToken")).toBe(key("amplified.ts::normalizeToken"));
    expect(resolveKey(loaded, "amplified.ts::normalizeToken")).toBe(key("amplified.ts::normalizeToken"));
    expect(resolveKey(loaded, "src/loops.ts:7")).toBe(key("loops.ts::nestedLoops"));
    expect(resolveKey(loaded, "loops.ts:7")).toBe(key("loops.ts::nestedLoops"));
    expect(() => resolveKey(loaded, "cb0")).toThrow(QueryError);
    try {
      resolveKey(loaded, "cb0");
    } catch (error) {
      expect((error as QueryError).candidates).toHaveLength(2);
    }
  });

  it("answers with sessionId, quality, and compact rows", () => {
    const summary = getSummary(loaded);
    expect(summary).toMatchObject({ sessionId: loaded.sessionId, quality: "high" });
    // Shares are checked in the isolated profiled tests; under parallel load only the membership is stable.
    expect((summary["topSelfMs"] as { key: string }[]).slice(0, 3).map((row) => row.key)).toContain(key("expensive.ts::expensiveTransform"));

    const hot = getHotFunctions(loaded, { by: "executions", limit: 3 });
    expect(hot).toMatchObject({ sessionId: loaded.sessionId, quality: "high", by: "executions" });
    expect((hot["rows"] as { key: string; executions: number }[])[0]).toMatchObject({ key: key("amplified.ts::normalizeToken"), executions: 2000 });

    const ranges = getHotRanges(loaded, { limit: 1 })["rows"] as { at: string; count: number }[];
    expect(ranges[0]?.count).toBeGreaterThan(30_000);

    const metrics = getFunctionMetrics(loaded, "nestedLoops");
    expect(metrics["execution"]).toMatchObject({ count: 3, hotRanges: [{ lines: "6-8", count: 30_000 }, { lines: "4-9", count: 150 }] });

    // walk is called by walkAll and by itself. V8 may inline walkAll into the module's top level; a non-leaf inlined
    // frame then disappears from the stack, so the outer caller can show up as the module.
    const callers = (getCallers(loaded, "walk")["callers"] as { key: string }[]).map((caller) => caller.key);
    expect(callers).toContain(key("recursive.ts::walk"));
    expect([key("recursive.ts::walkAll"), key("main.ts::(module)")].some((outer) => callers.includes(outer))).toBe(true);

    const deps = getDependencyCosts(loaded)["rows"] as { package: string; topCausers: { key: string }[] }[];
    expect(deps[0]).toMatchObject({ package: "fakedep", topCausers: [{ key: key("dep-heavy.ts::useDependency") }] });
  });

  it("keeps typical answers small (under about 2k tokens)", () => {
    for (const answer of [getSummary(loaded), getHotFunctions(loaded), getFunctionMetrics(loaded, "normalizeToken"), getDependencyCosts(loaded)]) {
      expect(JSON.stringify(answer).length).toBeLessThan(8000);
    }
  });

  it("renders tables for the CLI and keeps --json identical to MCP", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(runQueryCommand("top", ["--root", root, "--by", "self", "--limit", "2", "--json"])).toBe(0);
      expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(getHotFunctions(loaded, { by: "self", limit: 2 }));
      expect(runQueryCommand("inspect", ["--root", root, "walk"])).toBe(0);
      expect(log.mock.calls[1]?.[0]).toContain("key: observe-fixture::src/recursive.ts::walk");
    } finally {
      log.mockRestore();
    }
    expect(renderText({ rows: [{ key: "a", n: 1 }, { key: "b", n: 22 }] })).toBe("rows:\n   n  key\n   1  a\n  22  b");
  });

  it("refuses sessions written with another schema version", async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "crankts-schema-"));
    try {
      mkdirSync(join(dir, "20200101-000000-0000"));
      for (const file of ["entities.json", "metrics.json", "edges.json"]) writeFileSync(join(dir, "20200101-000000-0000", file), "[]");
      writeFileSync(join(dir, "20200101-000000-0000", "session.json"), JSON.stringify({ schemaVersion: "0.2" }));
      expect(() => new SessionStore({ sessionsDir: dir }).load()).toThrow(/schemaVersion "0.2"; this CrankTS reads 0.3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes old sessions with gc", async () => {
    const extra = await observeWorkload({ command: [process.execPath, "-e", "0"], cwd: root, stdio: "ignore", only: ["cpu"] });
    expect(store.ids()).toHaveLength(2);
    expect(store.gc(1)).toEqual([loaded.sessionId]);
    expect(store.ids()).toEqual([extra.session.sessionId]);
    rmSync(join(store.dir, extra.session.sessionId), { recursive: true });
  });
});

describe("MCP server", () => {
  it("serves the query tools over MCP", async () => {
    const mcpStore = new SessionStore({ sessionsDir: store.dir });
    const sessionRoot = createObserveFixture({ build: true });
    try {
      // gc above removed the first session; record a fresh one for the MCP client.
      process.env["OBSERVE_FIXTURE_UNIT_MS"] = "5";
      await observeWorkload({ command: [process.execPath, "dist/main.js"], cwd: sessionRoot, stdio: "ignore", sessionsDir: store.dir });
      const server = createMcpServer(mcpStore);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "1.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(tools).toEqual([
        "get_callees", "get_callers", "get_dependency_costs", "get_function_metrics", "get_hot_allocators",
        "get_hot_functions", "get_hot_ranges", "get_summary", "list_sessions",
      ]);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
        return { isError: result.isError === true, text };
      };
      const hot = JSON.parse((await call("get_hot_functions", { by: "self", limit: 3 })).text) as { quality: string; rows: { key: string }[] };
      expect(hot.quality).toBe("high");
      expect(hot.rows.map((row) => row.key)).toContain(key("expensive.ts::expensiveTransform"));
      const metrics = JSON.parse((await call("get_function_metrics", { key: "normalizeToken" })).text) as { execution: { count: number }; topCallers: { key: string }[] };
      expect(metrics.execution.count).toBe(2000);
      expect(metrics.topCallers[0]?.key).toBe(key("amplified.ts::processTokens"));
      const allocators = JSON.parse((await call("get_hot_allocators", { limit: 1 })).text) as { rows: { key: string }[] };
      expect(allocators.rows[0]?.key).toBe(key("alloc-loop.ts::allocateTemporaries"));
      const missing = await call("get_callers", { key: "doesNotExist" });
      expect(missing.isError).toBe(true);
      expect(missing.text).toMatch(/No entity matches/);
      await client.close();
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
