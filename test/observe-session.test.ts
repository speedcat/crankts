import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectLoader } from "../src/observe/artifact/index.js";
import type { ObservationSession } from "../src/observe/model.js";
import type { PreloadRecord } from "../src/observe/preload/source.js";
import { assignRoles, scriptOfCommand } from "../src/observe/runner/roles.js";
import { observeWorkload, type ObserveOptions } from "../src/observe/session.js";
import { createObserveFixture, typeStripping } from "./helpers/observe-fixture.js";

/** M1 acceptance (docs/observe-plan.md §10): `crankts observe` writes complete sessions and finds the primary process. */

let root = "";
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const npmAvailable = (() => {
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => {
  root = createObserveFixture({ build: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "observe-fixture", private: true, type: "module", scripts: { start: "node dist/main.js" } }));
  writeFileSync(join(root, "sleepy.mjs"), "let x = 0; for (let i = 0; i < 2e7; i += 1) x ^= i; setTimeout(() => {}, 60_000);\n");
  writeFileSync(join(root, "fails.mjs"), "process.exitCode = 3;\n");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function observe(command: string[], options: Partial<ObserveOptions> = {}) {
  return observeWorkload({ command, cwd: root, stdio: "ignore", ...options });
}

describe("crankts observe", () => {
  it("writes a complete session for `node dist/main.js`", async () => {
    process.env["OBSERVE_FIXTURE_UNIT_MS"] = "10";
    const result = await observe([process.execPath, "dist/main.js"]);
    expect(result.error).toBeUndefined();
    for (const file of ["session.json", "entities.json", "metrics.json", "edges.json", "summary.json"]) {
      expect(existsSync(join(result.sessionDir, file))).toBe(true);
    }
    const session = JSON.parse(readFileSync(join(result.sessionDir, "session.json"), "utf8")) as ObservationSession;
    expect(session.schemaVersion).toBe("0.3");
    expect(session.quality.level).toBe("high");
    const measurement = session.measurements[0];
    expect(measurement?.processes.filter((info) => info.role === "primary")).toHaveLength(1);
    expect(measurement?.artifact).toMatchObject({ entrypoint: "dist/main.js", loader: "node" });
    expect(measurement?.artifact?.entrypointHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(measurement?.artifact?.sourceMapHashes ?? {})).toContain("dist/main.js.map");
    expect(Object.keys(measurement?.artifact?.moduleHashes ?? {}).some((file) => file.includes(".crankts"))).toBe(false);
    for (const file of measurement?.rawFiles ?? []) expect(existsSync(join(result.sessionDir, "raw", file))).toBe(true);
    const keys = result.attribution?.metrics.map((metric) => metric.key) ?? [];
    expect(keys).toContain("observe-fixture::src/expensive.ts::expensiveTransform");
    expect(keys.some((key) => key.includes(".crankts"))).toBe(false);
    expect(keys.filter((key) => key.startsWith("observe-fixture::")).every((key) => !key.includes("preload"))).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it.skipIf(!npmAvailable)("asks for --entry when `npm run` starts several Node processes, and uses it", async () => {
    process.env["OBSERVE_FIXTURE_UNIT_MS"] = "5";
    const ambiguous = await observe(["npm", "run", "--silent", "start"]);
    expect(ambiguous.error).toMatch(/pass --entry/);
    expect(ambiguous.session.quality.level).toBe("low");
    expect(ambiguous.session.measurements[0]?.processes.every((info) => info.role === "unknown")).toBe(true);

    const named = await observe(["npm", "run", "--silent", "start"], { entry: "dist/main.js" });
    expect(named.error).toBeUndefined();
    const roles = named.session.measurements[0]?.processes.map((info) => info.role);
    expect(roles).toContain("primary");
    expect(roles).toContain("launcher");
  });

  it("finds the script process behind tsx's launcher", async () => {
    process.env["OBSERVE_FIXTURE_UNIT_MS"] = "5";
    const result = await observe([process.execPath, tsxCli, "src/main.ts"]);
    expect(result.error).toBeUndefined();
    expect(result.session.measurements[0]?.artifact?.loader).toBe("tsx");
    const roles = result.session.measurements[0]?.processes.map((info) => info.role) ?? [];
    expect(roles.filter((role) => role === "primary")).toHaveLength(1);
    expect(roles).toContain("launcher");
    // tsx's module-loader thread writes a profile without a preload record.
    expect(roles.every((role) => role !== "unknown")).toBe(true);
  });

  it.skipIf(!typeStripping)("records type-stripped runs", async () => {
    process.env["OBSERVE_FIXTURE_UNIT_MS"] = "5";
    const result = await observe([process.execPath, "src/main.ts"]);
    expect(result.session.measurements[0]?.artifact).toMatchObject({ entrypoint: "src/main.ts", loader: "node-strip-types" });
    expect(Object.keys(result.session.measurements[0]?.artifact?.moduleHashes ?? {})).toContain("src/expensive.ts");
  });

  it("terminates on timeout and still keeps the profile", async () => {
    const result = await observe([process.execPath, "sleepy.mjs"], { timeoutSec: 1, graceMs: 3000 });
    const measurement = result.session.measurements[0];
    expect(measurement?.exit.timedOut).toBe(true);
    expect(measurement?.errors.join(" ")).toMatch(/timed out/);
    expect(result.attribution?.summary).toBeDefined();
    expect(result.session.quality.reasons).toContain("timedOut:cpu-01");
  });

  it("passes the workload's exit code through", async () => {
    const result = await observe([process.execPath, "fails.mjs"]);
    expect(result.exitCode).toBe(3);
    expect(result.session.measurements[0]?.processes[0]?.exitCode).toBe(3);
  });

  it("rejects unknown measurements", async () => {
    await expect(observe([process.execPath, "fails.mjs"], { only: ["gpu" as "heap"] })).rejects.toThrow(/Unknown measurement gpu/);
  });
});

describe("process roles", () => {
  const record = (pid: number, ppid: number, script: string, startedAt: number, endedAt: number, threadId = 0): PreloadRecord => ({
    pid, ppid, threadId, argv: ["node", script], execArgv: [], cwd: "/w", versions: { node: "22", v8: "12" }, startedAt, endedAt, exitCode: 0,
    resourceUsage: { userCpuMs: 0, systemCpuMs: 0, maxRssKb: 0 }, eventLoop: { utilization: 0 },
  });

  it("reads the script from node and tsx commands", () => {
    expect(scriptOfCommand(["node", "--max-old-space-size=4096", "--import", "tsx", "src/cli.ts", "index"])).toBe("src/cli.ts");
    expect(scriptOfCommand(["/usr/local/bin/node", "-r", "x.cjs", "dist/main.js"])).toBe("dist/main.js");
    expect(scriptOfCommand(["tsx", "src/main.ts"])).toBe("src/main.ts");
    expect(scriptOfCommand(["node", "/x/node_modules/tsx/dist/cli.mjs", "src/main.ts"])).toBe("src/main.ts");
    expect(scriptOfCommand(["npm", "run", "start"])).toBeUndefined();
  });

  it("assigns primary, launcher, child, and worker", () => {
    const npm = record(10, 1, "/w/npm-cli.js", 0, 100);
    const main = record(20, 15, "/w/dist/main.js", 10, 90);
    const child = record(30, 20, "/w/dist/child.js", 20, 30);
    const worker = record(20, 15, "[worker eval]", 12, 80, 1);
    const result = assignRoles([npm, main, child, worker], { command: ["npm", "run", "start"], cwd: "/w", entry: "dist/main.js" });
    expect(result.error).toBeUndefined();
    expect([npm, main, child, worker].map((entry) => result.roles.get(entry))).toEqual(["launcher", "primary", "child", "worker"]);
  });

  it("refuses to guess between several processes", () => {
    const result = assignRoles([record(1, 0, "/w/a.js", 0, 1), record(2, 0, "/w/b.js", 0, 1)], { command: ["sh", "run.sh"], cwd: "/w" });
    expect(result.primary).toBeUndefined();
    expect(result.error).toMatch(/--entry/);
  });

  it("detects the loader", () => {
    expect(detectLoader({ argv: ["node", "/w/a.ts"], execArgv: ["--import", "file:///x/node_modules/tsx/dist/loader.mjs"] })).toBe("tsx");
    expect(detectLoader({ argv: ["node", "/w/a.ts"], execArgv: [] })).toBe("node-strip-types");
    expect(detectLoader({ argv: ["node", "/w/a.js"], execArgv: [] })).toBe("node");
  });
});
