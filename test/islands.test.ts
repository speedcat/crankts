import { describe, expect, it } from "vitest";
import { findCandidateIslands } from "../src/analysis/islands.js";
import type { CallEdge, Eligibility, FunctionAnalysis, FunctionId } from "../src/analysis/model.js";

describe("candidate island quality", () => {
  it("reports edges, member/boundary mixes, and articulation impact without splitting", () => {
    const functions = [
      createFunction("a", [createEdge("a", "b")]),
      createFunction("b", [createEdge("b", "c")]),
      createFunction("c", [createEdge("c", "blocked"), createEdge("c", undefined, "EXTERNAL")], "CONDITIONAL"),
      createFunction("outside", [createEdge("outside", "a")]),
      createFunction("blocked-caller", [createEdge("blocked-caller", "b")], "BLOCKED"),
      createFunction("blocked", [], "BLOCKED"),
    ];
    const islands = findCandidateIslands(functions, new Set<FunctionId>(["a", "b", "c"]));

    expect(islands).toHaveLength(1);
    expect(islands[0]).toMatchObject({
      members: ["a", "b", "c"],
      internalEdges: 2,
      rawEntryEdges: 2,
      rawExitEdges: 2,
      entryEdges: 2,
      exitEdges: 2,
      effectiveEntryEdges: 0,
      effectiveExitEdges: 1,
      boundaryKinds: {
        LOCAL_DIRECT: 3,
        LOCAL_METHOD: 0,
        LOCAL_CALLBACK: 0,
        LOCAL_CONSTRUCTOR: 0,
        STDLIB_PURE: 0,
        STDLIB_COLLECTION: 0,
        STDLIB_RUNTIME: 0,
        NODE_IO: 0,
        DATABASE: 0,
        NETWORK: 0,
        PROCESS: 0,
        EXTERNAL_TYPED: 1,
        EXTERNAL_UNKNOWN: 0,
        DYNAMIC: 0,
        UNRESOLVED: 0,
      },
      boundaryCostUnits: 1,
      boundaryRisk: "LOW",
      boundaryRatio: 2 / 3,
      eligibilityMix: { supported: 2, conditional: 1, blocked: 0 },
      boundaryEligibilityMix: { supported: 1, conditional: 0, blocked: 2 },
      articulationCount: 1,
      largestArticulationImpact: {
        functionId: "b",
        impact: 1,
        componentsAfterRemoval: 2,
        largestRemainingPart: 1,
        internalCallers: 1,
      },
      sizePenalty: 0,
      warnings: [],
    });
    expect(islands[0]?.nativePriority).toBe(0);
  });

  it("warns when the highest-impact articulation is a shared helper", () => {
    const functions = [
      createFunction("left", [createEdge("left", "helper")]),
      createFunction("right", [createEdge("right", "helper")]),
      createFunction("helper", [createEdge("helper", "tail")]),
      createFunction("tail", []),
    ];
    const [island] = findCandidateIslands(functions, new Set(functions.map((functionAnalysis) => functionAnalysis.id)));

    expect(island?.internalEdges).toBe(3);
    expect(island?.articulationCount).toBe(1);
    expect(island?.largestArticulationImpact).toMatchObject({
      functionId: "helper",
      impact: 2,
      internalCallers: 2,
    });
    expect(island?.warnings[0]?.code).toBe("SHARED_HELPER_ARTICULATION");
  });

  it("reports excess component size without changing WCC membership", () => {
    const functions = Array.from({ length: 22 }, (_, index) => {
      const id = `node-${String(index).padStart(2, "0")}`;
      const nextId = index < 21 ? `node-${String(index + 1).padStart(2, "0")}` : undefined;
      return createFunction(id, nextId ? [createEdge(id, nextId)] : []);
    });
    const [island] = findCandidateIslands(functions, new Set(functions.map((functionAnalysis) => functionAnalysis.id)));

    expect(island?.members).toHaveLength(22);
    expect(island?.sizePenalty).toBe(2);
    expect(island?.internalEdges).toBe(21);
    expect(island?.articulationCount).toBe(20);
  });

  it("analyzes a large component without recursion-stack overflow", () => {
    const count = 12_000;
    const functions = Array.from({ length: count }, (_, index) => {
      const id = `node-${String(index).padStart(5, "0")}`;
      const nextId = index + 1 < count ? `node-${String(index + 1).padStart(5, "0")}` : undefined;
      return createFunction(id, nextId ? [createEdge(id, nextId)] : []);
    });
    const [island] = findCandidateIslands(functions, new Set(functions.map((functionAnalysis) => functionAnalysis.id)));

    expect(island?.members).toHaveLength(count);
    expect(island?.articulationCount).toBe(count - 2);
    expect(island?.largestArticulationImpact?.impact).toBe(Math.floor((count - 1) / 2));
    expect(island?.sizePenalty).toBe(count - 20);
  });
});

function createFunction(
  id: FunctionId,
  calls: readonly CallEdge[],
  status: "SUPPORTED" | "CONDITIONAL" | "BLOCKED" = "SUPPORTED",
): FunctionAnalysis {
  const eligibility: Eligibility = status === "SUPPORTED"
    ? { kind: "SUPPORTED" }
    : { kind: status, blockers: [] };
  return {
    id,
    name: id,
    file: `${id}.ts`,
    line: 1,
    eligibility,
    suitability: status === "BLOCKED" ? 0 : 100,
    opportunities: { cpu: 0, memory: 0, parallel: 0 },
    nativePriority: 0,
    directEffects: ["PURE"],
    effects: ["PURE"],
    calls,
  };
}

function createEdge(
  from: FunctionId,
  to: FunctionId | undefined,
  kind: CallEdge["kind"] = "DIRECT_RESOLVED",
): CallEdge {
  return {
    from,
    ...(to ? { to } : {}),
    kind,
    boundaryKind: boundaryKindForTest(kind),
    callee: to ?? "external",
    line: 1,
    column: 1,
  };
}

function boundaryKindForTest(kind: CallEdge["kind"]): CallEdge["boundaryKind"] {
  switch (kind) {
    case "DIRECT_RESOLVED":
      return "LOCAL_DIRECT";
    case "METHOD_RESOLVED":
      return "LOCAL_METHOD";
    case "CALLBACK":
      return "LOCAL_CALLBACK";
    case "CONSTRUCTOR":
      return "LOCAL_CONSTRUCTOR";
    case "DYNAMIC":
      return "DYNAMIC";
    case "UNRESOLVED":
      return "UNRESOLVED";
    case "EXTERNAL":
      return "EXTERNAL_TYPED";
  }
}