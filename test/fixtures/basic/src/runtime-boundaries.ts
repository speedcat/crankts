import { spawn } from "node:child_process";
import { request } from "node:http";
import { query } from "pg";
import type { Database as CompatDatabase } from "@intentweave/sqlite-compat";
import { typedLookup } from "typed-helper";
import { unknownLookup } from "unknown-helper";

export function queryDatabase(statement: string): string {
  return query(statement);
}

export function queryThroughCompatDatabase(db: CompatDatabase): unknown[] {
  return db.prepare("SELECT 1").all();
}

export function sendNetworkRequest(): void {
  request({ hostname: "example.test" });
}

export function spawnProcess(): void {
  spawn("echo", ["ready"]);
}

export function usePureStandardLibrary(value: number): number {
  return Math.abs(value);
}

export function useRuntimeStandardLibrary(): number {
  return Date.now();
}

export function useTypedExternal(value: string): string {
  return typedLookup(value);
}

export function useUnknownExternal(value: string): unknown {
  return unknownLookup(value);
}