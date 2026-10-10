import { spawn } from "node:child_process";
import { request } from "node:http";
import { query } from "pg";
import { typedLookup } from "typed-helper";
import { unknownLookup } from "unknown-helper";
export function queryDatabase(statement) {
    return query(statement);
}
export function sendNetworkRequest() {
    request({ hostname: "example.test" });
}
export function spawnProcess() {
    spawn("echo", ["ready"]);
}
export function usePureStandardLibrary(value) {
    return Math.abs(value);
}
export function useRuntimeStandardLibrary() {
    return Date.now();
}
export function useTypedExternal(value) {
    return typedLookup(value);
}
export function useUnknownExternal(value) {
    return unknownLookup(value);
}
