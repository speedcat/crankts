import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { CRANKTS_VERSION } from "../../version.js";
import {
  getCallees,
  getCallers,
  getDependencyCosts,
  getFunctionMetrics,
  getHotAllocators,
  getHotFunctions,
  getHotRanges,
  getSummary,
  listSessions,
  MAX_LIMIT,
  QueryError,
  SessionStore,
} from "../query/index.js";

/**
 * MCP server over the query layer (docs/observe-plan.md §9). Read-only: it serves sessions that `crankts observe`
 * wrote. Every answer carries `sessionId` and the session's quality level; limits default to 10.
 */

const session = z.string().optional().describe("Session id (default: the newest session with results). See list_sessions.");
const limit = z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Rows to return (default 10, max ${MAX_LIMIT}).`);
const key = z.string().describe("Entity key (<package>::<module>::<name>), a unique name suffix such as 'GraphParser.parseNode', or 'file:line'.");

export function createMcpServer(store: SessionStore): McpServer {
  const server = new McpServer({ name: "crankts-observe", version: CRANKTS_VERSION });
  const tool = <Shape extends z.ZodRawShape>(name: string, description: string, inputSchema: Shape, run: (input: z.infer<z.ZodObject<Shape>>) => Record<string, unknown>) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } }, ((input: z.infer<z.ZodObject<Shape>>) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(run(input)) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const candidates = error instanceof QueryError && error.candidates.length > 0 ? `\nCandidates:\n${error.candidates.join("\n")}` : "";
        return { content: [{ type: "text" as const, text: `${message}${candidates}` }], isError: true };
      }
    }) as never);
  };

  tool(
    "get_summary",
    "Overview of an observed workload run: quality, measurements, CPU/heap totals by category, and the top 5 own entities by self time, inclusive time, caused dependency time, executions, and allocations. Start here.",
    { session },
    (input) => getSummary(store.load(input.session)),
  );
  tool(
    "get_hot_functions",
    "Own code entities ranked by a metric: self (CPU ms in the function itself), inclusive (with callees), alloc (allocated bytes), executions (exact call count), cpu-per-call (estimated self ns per call). scope 'all' includes dependencies, runtime, and GC.",
    { by: z.enum(["self", "inclusive", "alloc", "executions", "cpu-per-call"]).optional(), scope: z.enum(["own", "all"]).optional(), limit, session },
    (input) => getHotFunctions(store.load(input.session), { ...(input.by ? { by: input.by } : {}), ...(input.scope ? { scope: input.scope } : {}), ...(input.limit ? { limit: input.limit } : {}) }),
  );
  tool(
    "get_function_metrics",
    "Everything measured for one entity: CPU (self/inclusive/caused by package), exact execution count and hottest block ranges, allocations, per-call estimates with confidence, flags, and top callers and callees.",
    { key, session },
    (input) => getFunctionMetrics(store.load(input.session), input.key),
  );
  tool(
    "get_hot_allocators",
    "Own entities ranked by allocated bytes (sampled, including short-lived objects that GC already collected), with bytes per call where execution counts exist.",
    { limit, session },
    (input) => getHotAllocators(store.load(input.session), input.limit ? { limit: input.limit } : {}),
  );
  tool(
    "get_hot_ranges",
    "Code blocks (file:startLine-endLine) with the highest exact execution counts, e.g. loop bodies.",
    { limit, session },
    (input) => getHotRanges(store.load(input.session), input.limit ? { limit: input.limit } : {}),
  );
  tool(
    "get_callers",
    "Observed callers of an entity: sampled time of its subtree under each caller and that caller's share. 'via' says whether dependency or runtime frames sat in between.",
    { key, limit, session },
    (input) => getCallers(store.load(input.session), input.key, input.limit ? { limit: input.limit } : {}),
  );
  tool(
    "get_callees",
    "Observed callees of an entity with sampled time under it and their execution counts.",
    { key, limit, session },
    (input) => getCallees(store.load(input.session), input.key, input.limit ? { limit: input.limit } : {}),
  );
  tool(
    "get_dependency_costs",
    "Time spent in dependencies, charged to the own code that called them. Without key: by package with the top causing entities. With key: that entity's caused time by category and package.",
    { key: key.optional(), limit, session },
    (input) => getDependencyCosts(store.load(input.session), input.key, input.limit ? { limit: input.limit } : {}),
  );
  tool(
    "list_sessions",
    "Observed sessions, newest first, with date, git SHA, quality, command, and measurements.",
    { limit },
    (input) => listSessions(store, input.limit ? { limit: input.limit } : {}),
  );
  return server;
}

export async function startMcpServer(options: { readonly root?: string; readonly sessionsDir?: string }, transport: Transport = new StdioServerTransport()): Promise<McpServer> {
  const server = createMcpServer(new SessionStore(options));
  await server.connect(transport);
  return server;
}
