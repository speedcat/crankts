import {
  getCallees,
  getCallers,
  getDependencyCosts,
  getFunctionMetrics,
  getHotFunctions,
  getSummary,
  listSessions,
  QueryError,
  SessionStore,
  type HotMetric,
  type Scope,
} from "../query/index.js";

/**
 * Query commands (docs/observe-plan.md §9): `summary`, `top`, `inspect`, `callers`, `callees`, `deps`, `sessions`,
 * `gc`. Each prints a table; `--json` prints the same structure the MCP tools return.
 */

export const QUERY_COMMANDS = new Set(["summary", "top", "inspect", "callers", "callees", "deps", "sessions", "gc"]);

const HOT_METRICS: readonly HotMetric[] = ["self", "inclusive", "alloc", "executions", "cpu-per-call"];

export function runQueryCommand(command: string, arguments_: readonly string[]): number {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string;
    if (argument === "--json") json = true;
    else if (argument.startsWith("--")) {
      const value = arguments_[index + 1];
      if (value === undefined) {
        console.error(`${argument} requires a value.`);
        return 2;
      }
      values.set(argument, value);
      index += 1;
    } else positional.push(argument);
  }
  const store = new SessionStore({
    ...(values.has("--root") ? { root: values.get("--root") as string } : {}),
    ...(values.has("--sessions-dir") ? { sessionsDir: values.get("--sessions-dir") as string } : {}),
  });
  const limit = values.has("--limit") ? Number(values.get("--limit")) : undefined;
  if (limit !== undefined && !(limit > 0)) {
    console.error("--limit must be a positive number.");
    return 2;
  }
  const sessionId = values.get("--session");

  try {
    let result: Record<string, unknown>;
    switch (command) {
      case "sessions":
        result = listSessions(store, limit !== undefined ? { limit } : {});
        break;
      case "gc": {
        const keep = Number(values.get("--keep"));
        if (!Number.isInteger(keep) || keep < 0) {
          console.error("crankts gc --keep <n>");
          return 2;
        }
        result = { removed: store.gc(keep), kept: store.ids() };
        break;
      }
      case "summary":
        result = getSummary(store.load(sessionId));
        break;
      case "top": {
        const by = (values.get("--by") ?? "self") as HotMetric;
        const scope = (values.get("--scope") ?? "own") as Scope;
        if (!HOT_METRICS.includes(by) || (scope !== "own" && scope !== "all")) {
          console.error(`crankts top --by ${HOT_METRICS.join("|")} [--scope own|all] [--limit n]`);
          return 2;
        }
        result = getHotFunctions(store.load(sessionId), { by, scope, ...(limit !== undefined ? { limit } : {}) });
        break;
      }
      case "inspect":
      case "callers":
      case "callees": {
        const query = positional[0];
        if (!query) {
          console.error(`crankts ${command} <key | name | file:line>`);
          return 2;
        }
        const loaded = store.load(sessionId);
        const options = limit !== undefined ? { limit } : {};
        result = command === "inspect" ? getFunctionMetrics(loaded, query) : command === "callers" ? getCallers(loaded, query, options) : getCallees(loaded, query, options);
        break;
      }
      case "deps":
        result = getDependencyCosts(store.load(sessionId), positional[0], limit !== undefined ? { limit } : {});
        break;
      default:
        console.error(`Unknown command '${command}'.`);
        return 2;
    }
    console.log(json ? JSON.stringify(result, null, 2) : renderText(result));
    return 0;
  } catch (error) {
    if (error instanceof QueryError) {
      console.error(error.message);
      if (error.candidates.length > 0) console.error(`Candidates:\n  ${error.candidates.join("\n  ")}`);
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Objects as `key: value` lines; arrays of objects as aligned tables. */
export function renderText(value: Record<string, unknown>, indent = ""): string {
  const lines: string[] = [];
  for (const [key, field] of Object.entries(value)) {
    if (Array.isArray(field) && field.length > 0 && field.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      lines.push(`${indent}${key}:`);
      lines.push(...table(field as Record<string, unknown>[], `${indent}  `));
    } else if (field && typeof field === "object" && !Array.isArray(field)) {
      lines.push(`${indent}${key}:`);
      lines.push(renderText(field as Record<string, unknown>, `${indent}  `));
    } else {
      lines.push(`${indent}${key}: ${Array.isArray(field) ? field.join(", ") : String(field)}`);
    }
  }
  return lines.join("\n");
}

function table(rows: readonly Record<string, unknown>[], indent: string): string[] {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: unknown): string => {
    if (value === undefined) return "";
    if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? JSON.stringify(item) : String(item))).join(", ");
    if (value && typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  const cells = rows.map((row) => columns.map((column) => cell(row[column])));
  // The key column is long; keep it last so the numbers line up.
  const order = columns.map((_, index) => index).sort((left, right) => Number(columns[left] === "key") - Number(columns[right] === "key"));
  const widths = columns.map((column, index) => Math.max(column.length, ...cells.map((row) => (row[index] ?? "").length)));
  // A column is right-aligned (header included) when all of its values are numbers.
  const numeric = columns.map((_, index) => cells.every((row) => /^-?[\d.]*$/.test(row[index] ?? "")));
  const format = (values: readonly string[]) => indent + order.map((index) => {
    const text = values[index] ?? "";
    return columns[index] === "key" ? text : numeric[index] ? text.padStart(widths[index] ?? 0) : text.padEnd(widths[index] ?? 0);
  }).join("  ").trimEnd();
  return [format(columns), ...cells.map(format)];
}
