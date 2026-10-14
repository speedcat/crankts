import { z } from "zod";
import type { Entity, EntityMetrics, ObservationSession, ObservedCallEdge } from "./model.js";

/**
 * Schemas of the session files (docs/observe-plan.md §5, schemaVersion "0.3"). Each is typed against the model
 * interface, so the compiler keeps them in sync. Writers validate before writing; the query layer validates on load.
 * `crankts schema` prints them as JSON Schema.
 */

export const SCHEMA_VERSION = "0.3";

const confidence = z.enum(["high", "medium", "low", "none"]);
const flag = z.enum(["asyncTruncated", "unmappedFrames", "anonymousOrdinal", "inlinedSuspected"]);
const count = z.number().int().nonnegative();
const amount = z.number().nonnegative();

export const entitySchema: z.ZodType<Entity> = z.object({
  identity: z.object({
    key: z.string().min(1),
    fingerprint: z.object({ body: z.string(), shape: z.string() }),
    anchor: z.object({
      package: z.string(),
      module: z.string(),
      qualifiedName: z.string(),
      nameSource: z.enum(["declared", "inferred", "context", "ordinal"]),
      parentKey: z.string().exactOptional(),
    }),
  }),
  kind: z.enum([
    "function", "method", "getter", "setter", "constructor", "arrow", "function-expression", "module-init",
    "dependency", "runtime", "native", "gc", "program", "idle", "unmapped",
  ]),
  source: z.object({
    file: z.string(),
    line: count,
    column: count,
    endLine: count,
    language: z.enum(["typescript", "javascript"]),
    async: z.boolean().exactOptional(),
  }).exactOptional(),
  dependency: z.object({ package: z.string(), nativeAddon: z.boolean() }).exactOptional(),
});

const executionRange = z.object({
  kind: z.enum(["function", "block"]),
  startLine: count,
  startColumn: count,
  endLine: count,
  endColumn: count,
  rangeExecutionCount: count,
});

export const metricsSchema: z.ZodType<EntityMetrics> = z.object({
  key: z.string().min(1),
  cpu: z.object({
    measurementId: z.string(),
    selfMs: amount,
    selfPct: amount,
    inclusiveMs: amount,
    inclusivePct: amount,
    samples: count,
    inclusiveSamples: count,
    caused: z.object({ dependencyMs: amount, runtimeMs: amount, nativeMs: amount, gcMs: amount }),
    causedByPackage: z.record(z.string(), amount).exactOptional(),
  }).exactOptional(),
  allocation: z.object({
    measurementId: z.string(),
    selfBytes: amount,
    inclusiveBytes: amount,
    selfPct: amount,
    samples: count,
    inclusiveSamples: count,
    includesCollected: z.boolean(),
  }).exactOptional(),
  estimates: z.object({
    selfCpuPerCall: z.object({ estimatedNs: amount, cpuSamples: count, executionCount: count, confidence }).exactOptional(),
    bytesPerCall: z.object({ estimatedBytes: amount, allocSamples: count, executionCount: count, confidence }).exactOptional(),
  }).exactOptional(),
  execution: z.object({
    measurementId: z.string(),
    functionExecutionCount: count.exactOptional(),
    hotRanges: z.array(executionRange),
  }).exactOptional(),
  confidence: z.object({ cpu: confidence, allocation: confidence, execution: confidence }),
  flags: z.array(flag),
});

export const edgeSchema: z.ZodType<ObservedCallEdge> = z.object({
  callerKey: z.string().min(1),
  calleeKey: z.string().min(1),
  measurementId: z.string(),
  sampledInclusiveMs: amount,
  samples: count,
  shareOfCallee: z.number().min(0).max(1),
  via: z.enum(["direct", "dependency", "runtime"]),
});

const processInfo = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  threadId: count,
  role: z.enum(["primary", "launcher", "worker", "child", "unknown"]),
  argv: z.array(z.string()),
  execArgv: z.array(z.string()),
  resourceUsage: z.object({ userCpuMs: amount, systemCpuMs: amount, maxRssKb: amount }).exactOptional(),
  eventLoop: z.object({ utilization: amount, delayP50Ms: amount.exactOptional(), delayP99Ms: amount.exactOptional() }).exactOptional(),
  exitCode: z.number().int().exactOptional(),
  wallMs: amount.exactOptional(),
  rawFiles: z.array(z.string()),
});

const artifact = z.object({
  entrypoint: z.string(),
  entrypointHash: z.string(),
  sourceMapHashes: z.record(z.string(), z.string()),
  moduleHashes: z.record(z.string(), z.string()),
  loader: z.enum(["node", "node-strip-types", "tsx", "ts-node", "other"]),
});

export const sessionSchema: z.ZodType<ObservationSession> = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sessionId: z.string().min(1),
  createdAt: z.string(),
  workload: z.object({ command: z.array(z.string()), cwd: z.string(), root: z.string(), workloadId: z.string().exactOptional() }),
  git: z.object({ sha: z.string().nullable(), dirty: z.boolean(), dirtyHash: z.string().exactOptional() }),
  environment: z.object({ node: z.string(), v8: z.string(), os: z.string(), cpu: z.string(), cores: count }),
  measurements: z.array(z.object({
    measurementId: z.string(),
    kind: z.enum(["cpu", "coverage", "heap"]),
    config: z.record(z.string(), z.union([z.string(), z.number()])),
    processes: z.array(processInfo),
    artifact: artifact.exactOptional(),
    rawFiles: z.array(z.string()),
    wallMs: amount,
    exit: z.object({ code: z.number().int().nullable(), signal: z.string().nullable(), timedOut: z.boolean() }),
    errors: z.array(z.string()),
    overheadNote: z.string().exactOptional(),
    overhead: z.object({ baselineWallMs: amount, wallRatio: amount }).exactOptional(),
  })),
  quality: z.object({
    level: z.enum(["high", "medium", "low"]),
    reasons: z.array(z.string()),
    checks: z.object({
      artifactAgreement: z.boolean(),
      sampledButNotExecutedRatio: amount.exactOptional(),
      allocatedButNotExecutedRatio: amount.exactOptional(),
      unmappedOwnSampleRatio: amount.exactOptional(),
      repeatCountAgreement: amount.exactOptional(),
    }),
  }),
  timing: z.object({ attributionMs: amount, baselineWallMs: amount.exactOptional() }).exactOptional(),
});

export const sessionFileSchemas = {
  "session.json": sessionSchema,
  "entities.json": z.array(entitySchema),
  "metrics.json": z.array(metricsSchema),
  "edges.json": z.array(edgeSchema),
} as const;

export type SessionFile = keyof typeof sessionFileSchemas;

/** Throws with the file name and the first problems when `value` does not match its schema. */
export function assertValid(file: SessionFile, value: unknown): void {
  const result = sessionFileSchemas[file].safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(`${file} does not match schema ${SCHEMA_VERSION}: ${issues}`);
  }
}

/** JSON Schemas of the session files (draft 2020-12). */
export function sessionJsonSchemas(): Record<SessionFile, unknown> {
  return Object.fromEntries(Object.entries(sessionFileSchemas).map(([file, schema]) => [file, z.toJSONSchema(schema)])) as Record<SessionFile, unknown>;
}
