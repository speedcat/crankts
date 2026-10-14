import { basename, resolve } from "node:path";
import type { ProcessInfo } from "../model.js";
import { canonicalPath } from "../paths.js";
import type { PreloadRecord } from "../preload/source.js";

/**
 * Process roles (docs/observe-plan.md §8, D4). The primary process is found by its script, never by size:
 * - `--entry <path>`, or the script of a `node`/`tsx`/`ts-node` command, must match exactly one main-thread `argv[1]`;
 * - otherwise a single recorded main-thread process is primary;
 * - anything else is an error that names the processes and asks for `--entry`.
 * The directly spawned process is not used: version managers (volta, nvm shims) and tsx put launchers in between.
 */

const NODE_RUNNERS = new Set(["node", "node.exe", "tsx", "ts-node", "ts-node-esm"]);
const RUNNER_SCRIPT = /(?:^|\/)(?:tsx\/dist\/cli\.m?js|\.bin\/(?:tsx|ts-node(?:-esm)?)|ts-node\/dist\/bin(?:-esm)?\.js)$/;
/** Node options that take a separate value (`--require x`). */
const OPTIONS_WITH_VALUE = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-e", "--eval", "-p", "--print", "--conditions", "-C", "--env-file", "--input-type", "--title"]);

export interface RoleAssignment {
  readonly primary?: PreloadRecord;
  readonly roles: ReadonlyMap<PreloadRecord, ProcessInfo["role"]>;
  readonly error?: string;
}

/** The script a `node`/`tsx` command runs, or undefined for other commands (npm, shell scripts, binaries). */
export function scriptOfCommand(command: readonly string[]): string | undefined {
  const runner = command[0] ? basename(command[0]) : "";
  if (!NODE_RUNNERS.has(runner)) return undefined;
  for (let index = 1; index < command.length; index += 1) {
    const argument = command[index] as string;
    if (argument === "--") return command[index + 1];
    if (OPTIONS_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    // `node node_modules/tsx/dist/cli.mjs src/main.ts`: the runner's CLI is a launcher, the script follows it.
    if (RUNNER_SCRIPT.test(argument.replace(/\\/g, "/"))) return scriptOfCommand(["tsx", ...command.slice(index + 1)]);
    return argument;
  }
  return undefined;
}

export function assignRoles(records: readonly PreloadRecord[], options: { readonly command: readonly string[]; readonly cwd: string; readonly entry?: string }): RoleAssignment {
  const mainThreads = records.filter((record) => record.threadId === 0);
  const entry = options.entry ?? scriptOfCommand(options.command);
  let primary: PreloadRecord | undefined;
  let error: string | undefined;

  if (entry !== undefined) {
    const wanted = canonicalPath(resolve(options.cwd, entry));
    const matches = mainThreads.filter((record) => record.argv[1] !== undefined && canonicalPath(resolve(record.cwd, record.argv[1])) === wanted);
    if (matches.length === 1) primary = matches[0];
    else if (matches.length === 0) error = `No observed process ran '${entry}'. ${describe(mainThreads)}`;
    else error = `${matches.length} processes ran '${entry}'; the primary process is ambiguous. ${describe(mainThreads)}`;
  } else if (mainThreads.length === 1) {
    primary = mainThreads[0];
  } else {
    error = mainThreads.length === 0
      ? "No Node process was observed (did the command start Node, and does it keep NODE_OPTIONS?)."
      : `The command started ${mainThreads.length} Node processes; pass --entry <script> to name the primary one. ${describe(mainThreads)}`;
  }

  const roles = new Map<PreloadRecord, ProcessInfo["role"]>();
  for (const record of records) roles.set(record, "unknown");
  if (!primary) return { roles, ...(error ? { error } : {}) };

  const byPid = new Map(mainThreads.map((record) => [record.pid, record]));
  const isDescendant = (record: PreloadRecord): boolean => {
    const seen = new Set<number>();
    for (let parent = byPid.get(record.ppid); parent && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
      if (parent === primary) return true;
      seen.add(parent.pid);
    }
    return false;
  };
  for (const record of records) {
    if (record === primary) roles.set(record, "primary");
    else if (record.threadId !== 0) roles.set(record, "worker");
    else if (isDescendant(record)) roles.set(record, "child");
    // Launchers wrap the primary process in time (npm, tsx's CLI, shell wrappers that run Node).
    else if (record.startedAt <= primary.startedAt && record.endedAt >= primary.endedAt) roles.set(record, "launcher");
  }
  return { primary, roles };
}

function describe(records: readonly PreloadRecord[]): string {
  if (records.length === 0) return "";
  return `Observed: ${records.map((record) => `pid ${record.pid} ${record.argv.slice(1, 3).join(" ") || "(no script)"}`).join("; ")}.`;
}
