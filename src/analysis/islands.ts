import type {
  ArticulationImpact,
  CandidateIsland,
  CandidateIslandWarning,
  EligibilityMix,
  FunctionAnalysis,
  FunctionId,
  RuntimeBoundaryCounts,
  RuntimeBoundaryKind,
} from "./model.js";
import { calculateNativePriority } from "./opportunities.js";
import { accumulateStage, measureStage, type StageTimer } from "./timings.js";

const SIZE_PENALTY_REFERENCE = 20;
const BOUNDARY_COST_UNITS: Readonly<Record<RuntimeBoundaryKind, number>> = {
  LOCAL_DIRECT: 0,
  LOCAL_METHOD: 0,
  LOCAL_CALLBACK: 0,
  LOCAL_CONSTRUCTOR: 0,
  STDLIB_PURE: 0,
  STDLIB_COLLECTION: 0,
  STDLIB_RUNTIME: 1,
  NODE_IO: 4,
  DATABASE: 6,
  NETWORK: 8,
  PROCESS: 6,
  EXTERNAL_TYPED: 1,
  EXTERNAL_UNKNOWN: 4,
  DYNAMIC: 8,
  UNRESOLVED: 6,
};
const HIGH_RISK_BOUNDARIES = new Set<RuntimeBoundaryKind>([
  "DATABASE",
  "DYNAMIC",
  "NETWORK",
  "PROCESS",
  "UNRESOLVED",
]);

interface ComponentMetrics {
  readonly internalEdges: number;
  readonly rawEntryEdges: number;
  readonly rawExitEdges: number;
  readonly entryEdges: number;
  readonly exitEdges: number;
  readonly effectiveEntryEdges: number;
  readonly effectiveExitEdges: number;
  readonly boundaryKinds: RuntimeBoundaryCounts;
  readonly boundaryCostUnits: number;
  readonly boundaryRisk: "LOW" | "MEDIUM" | "HIGH";
  readonly boundaryRatio: number;
  readonly eligibilityMix: EligibilityMix;
  readonly boundaryEligibilityMix: EligibilityMix;
  readonly articulationCount: number;
  readonly largestArticulationImpact: ArticulationImpact | null;
  readonly sizePenalty: number;
  readonly warnings: readonly CandidateIslandWarning[];
}

export function findCandidateIslands(
  allFunctions: readonly FunctionAnalysis[],
  scopedFunctionIds: ReadonlySet<FunctionId>,
  timer?: StageTimer,
): CandidateIsland[] {
  const { candidateFunctions, functionById, adjacency } = measureStage(timer, "islands.adjacency", () => {
    const candidateFunctions = allFunctions.filter((functionAnalysis) => (
      scopedFunctionIds.has(functionAnalysis.id)
      && functionAnalysis.eligibility.kind !== "BLOCKED"
    ));
    const candidateIds = new Set(candidateFunctions.map((functionAnalysis) => functionAnalysis.id));
    const functionById = new Map(allFunctions.map((functionAnalysis) => [functionAnalysis.id, functionAnalysis]));
    const adjacency = new Map<FunctionId, Set<FunctionId>>(
      candidateFunctions.map((functionAnalysis) => [functionAnalysis.id, new Set<FunctionId>()]),
    );

    for (const functionAnalysis of candidateFunctions) {
      for (const edge of functionAnalysis.calls) {
        if (!edge.to || !candidateIds.has(edge.to)) {
          continue;
        }
        adjacency.get(functionAnalysis.id)?.add(edge.to);
        adjacency.get(edge.to)?.add(functionAnalysis.id);
      }
    }
    return { candidateFunctions, functionById, adjacency };
  });

  const componentMembers = measureStage(timer, "islands.wcc", () => (
    findWeaklyConnectedComponents(candidateFunctions, adjacency, functionById)
  ));
  const componentByFunction = new Map<FunctionId, number>();
  componentMembers.forEach((members, componentIndex) => {
    for (const memberId of members) {
      componentByFunction.set(memberId, componentIndex);
    }
  });

  const internalEdges = componentMembers.map(() => 0);
  const entryEdges = componentMembers.map(() => 0);
  const exitEdges = componentMembers.map(() => 0);
  const effectiveEntryEdges = componentMembers.map(() => 0);
  const effectiveExitEdges = componentMembers.map(() => 0);
  const boundaryKinds = componentMembers.map(() => createBoundaryCounts());
  const boundaryCostUnits = componentMembers.map(() => 0);
  const boundaryFunctions = componentMembers.map(() => new Set<FunctionId>());
  const internalCallers = new Map<FunctionId, Set<FunctionId>>();

  measureStage(timer, "islands.boundaries", () => {
    for (const source of allFunctions) {
      for (const edge of source.calls) {
        const sourceComponent = componentByFunction.get(edge.from);
        const targetComponent = edge.to ? componentByFunction.get(edge.to) : undefined;

        if (sourceComponent !== undefined && sourceComponent === targetComponent) {
          internalEdges[sourceComponent] = (internalEdges[sourceComponent] ?? 0) + 1;
          if (edge.to && edge.to !== edge.from) {
            const callers = internalCallers.get(edge.to) ?? new Set<FunctionId>();
            callers.add(edge.from);
            internalCallers.set(edge.to, callers);
          }
          continue;
        }

        if (targetComponent !== undefined) {
          entryEdges[targetComponent] = (entryEdges[targetComponent] ?? 0) + 1;
          boundaryFunctions[targetComponent]?.add(edge.from);
          recordBoundary(targetComponent, edge.boundaryKind, boundaryKinds, boundaryCostUnits, effectiveEntryEdges);
        }
        if (sourceComponent !== undefined) {
          exitEdges[sourceComponent] = (exitEdges[sourceComponent] ?? 0) + 1;
          recordBoundary(sourceComponent, edge.boundaryKind, boundaryKinds, boundaryCostUnits, effectiveExitEdges);
          if (edge.to) {
            boundaryFunctions[sourceComponent]?.add(edge.to);
          }
        }
      }
    }
  });

  const components: CandidateIsland[] = measureStage(timer, "islands.components", () => componentMembers.map((members, componentIndex) => {
    const memberFunctions = members.flatMap((memberId) => {
      const member = functionById.get(memberId);
      return member ? [member] : [];
    });
    let suitability = 100;
    const opportunities = { cpu: 0, memory: 0, parallel: 0 };
    for (const member of memberFunctions) {
      suitability = Math.min(suitability, member.suitability);
      opportunities.cpu = Math.max(opportunities.cpu, member.opportunities.cpu);
      opportunities.memory = Math.max(opportunities.memory, member.opportunities.memory);
      opportunities.parallel = Math.max(opportunities.parallel, member.opportunities.parallel);
    }
    const nativePriority = calculateNativePriority(suitability, opportunities);
    const articulation = accumulateStage(timer, "islands.components.articulation", () => (
      findArticulationPoints(members, adjacency)
    ));
    const largestArticulationImpact = articulation.largestImpact
      ? {
        ...articulation.largestImpact,
        internalCallers: internalCallers.get(articulation.largestImpact.functionId)?.size ?? 0,
      }
      : null;
    const qualityMetrics: ComponentMetrics = {
      internalEdges: internalEdges[componentIndex] ?? 0,
      rawEntryEdges: entryEdges[componentIndex] ?? 0,
      rawExitEdges: exitEdges[componentIndex] ?? 0,
      entryEdges: entryEdges[componentIndex] ?? 0,
      exitEdges: exitEdges[componentIndex] ?? 0,
      effectiveEntryEdges: effectiveEntryEdges[componentIndex] ?? 0,
      effectiveExitEdges: effectiveExitEdges[componentIndex] ?? 0,
      boundaryKinds: boundaryKinds[componentIndex] ?? createBoundaryCounts(),
      boundaryCostUnits: boundaryCostUnits[componentIndex] ?? 0,
      boundaryRisk: classifyBoundaryRisk(
        boundaryKinds[componentIndex] ?? createBoundaryCounts(),
        boundaryCostUnits[componentIndex] ?? 0,
      ),
      boundaryRatio: calculateBoundaryRatio(
        internalEdges[componentIndex] ?? 0,
        entryEdges[componentIndex] ?? 0,
        exitEdges[componentIndex] ?? 0,
      ),
      eligibilityMix: countEligibilityMix(memberFunctions),
      boundaryEligibilityMix: countBoundaryEligibilityMix(
        boundaryFunctions[componentIndex] ?? new Set(),
        functionById,
      ),
      articulationCount: articulation.count,
      largestArticulationImpact,
      sizePenalty: Math.max(0, members.length - SIZE_PENALTY_REFERENCE),
      warnings: createWarnings(largestArticulationImpact, functionById),
    };

    return {
      id: componentIndex + 1,
      status: memberFunctions.some((member) => member.eligibility.kind === "CONDITIONAL")
        ? "CONDITIONAL"
        : "SUPPORTED",
      suitability,
      opportunities,
      nativePriority,
      score: nativePriority,
      members,
      ...qualityMetrics,
    };
  }));

  return measureStage(timer, "islands.sort", () => components
    .sort((left, right) => {
      const scoreDifference = right.score - left.score;
      if (scoreDifference !== 0) {
        return scoreDifference;
      }
      return (left.members[0] ?? "").localeCompare(right.members[0] ?? "");
    })
    .map((component, index) => ({ ...component, id: index + 1 })));
}

export function findWeaklyConnectedComponents(
  candidateFunctions: readonly FunctionAnalysis[],
  adjacency: ReadonlyMap<FunctionId, ReadonlySet<FunctionId>>,
  functionById: ReadonlyMap<FunctionId, FunctionAnalysis>,
): FunctionId[][] {
  const visited = new Set<FunctionId>();
  const components: FunctionId[][] = [];

  for (const functionAnalysis of candidateFunctions) {
    if (visited.has(functionAnalysis.id)) {
      continue;
    }

    const members: FunctionId[] = [];
    const pending = [functionAnalysis.id];
    while (pending.length > 0) {
      const currentId = pending.pop();
      if (!currentId || visited.has(currentId)) {
        continue;
      }
      visited.add(currentId);
      members.push(currentId);
      for (const neighborId of adjacency.get(currentId) ?? []) {
        if (!visited.has(neighborId)) {
          pending.push(neighborId);
        }
      }
    }

    members.sort((leftId, rightId) => {
      const left = functionById.get(leftId);
      const right = functionById.get(rightId);
      if (!left || !right) {
        return leftId.localeCompare(rightId);
      }
      return left.file.localeCompare(right.file) || left.line - right.line;
    });
    components.push(members);
  }

  return components;
}

export function findArticulationPoints(
  members: readonly FunctionId[],
  adjacency: ReadonlyMap<FunctionId, ReadonlySet<FunctionId>>,
): { readonly count: number; readonly largestImpact: Omit<ArticulationImpact, "internalCallers"> | null } {
  const memberSet = new Set(members);
  const discovery = new Map<FunctionId, number>();
  const low = new Map<FunctionId, number>();
  const parent = new Map<FunctionId, FunctionId | undefined>();
  const childCounts = new Map<FunctionId, number>();
  const subtreeSizes = new Map<FunctionId, number>();
  const separatedSubtreeSizes = new Map<FunctionId, number[]>();
  const rootChildSubtreeSizes = new Map<FunctionId, number[]>();
  const articulationImpacts: Array<Omit<ArticulationImpact, "internalCallers">> = [];
  let clock = 0;

  for (const memberId of members) {
    if (!discovery.has(memberId)) {
      clock += 1;
      discovery.set(memberId, clock);
      low.set(memberId, clock);
      parent.set(memberId, undefined);
      childCounts.set(memberId, 0);
      subtreeSizes.set(memberId, 1);
      separatedSubtreeSizes.set(memberId, []);
      rootChildSubtreeSizes.set(memberId, []);

      const pending = [{
        node: memberId,
        neighbors: [...(adjacency.get(memberId) ?? [])],
        nextNeighbor: 0,
      }];

      while (pending.length > 0) {
        const frame = pending[pending.length - 1];
        if (!frame) {
          break;
        }

        if (frame.nextNeighbor < frame.neighbors.length) {
          const neighbor = frame.neighbors[frame.nextNeighbor];
          frame.nextNeighbor += 1;
          if (!neighbor || !memberSet.has(neighbor) || neighbor === parent.get(frame.node)) {
            continue;
          }

          const neighborDiscovery = discovery.get(neighbor);
          if (neighborDiscovery === undefined) {
            clock += 1;
            discovery.set(neighbor, clock);
            low.set(neighbor, clock);
            parent.set(neighbor, frame.node);
            childCounts.set(neighbor, 0);
            childCounts.set(frame.node, (childCounts.get(frame.node) ?? 0) + 1);
            subtreeSizes.set(neighbor, 1);
            separatedSubtreeSizes.set(neighbor, []);
            rootChildSubtreeSizes.set(neighbor, []);
            pending.push({
              node: neighbor,
              neighbors: [...(adjacency.get(neighbor) ?? [])],
              nextNeighbor: 0,
            });
          } else {
            low.set(frame.node, Math.min(low.get(frame.node) ?? neighborDiscovery, neighborDiscovery));
          }
          continue;
        }

        pending.pop();
        const nodeParent = parent.get(frame.node);
        if (nodeParent === undefined) {
          continue;
        }

        const nodeSubtreeSize = subtreeSizes.get(frame.node) ?? 1;
        subtreeSizes.set(nodeParent, (subtreeSizes.get(nodeParent) ?? 1) + nodeSubtreeSize);
        low.set(nodeParent, Math.min(low.get(nodeParent) ?? 0, low.get(frame.node) ?? 0));

        if (parent.get(nodeParent) === undefined) {
          rootChildSubtreeSizes.get(nodeParent)?.push(nodeSubtreeSize);
        } else if ((low.get(frame.node) ?? 0) >= (discovery.get(nodeParent) ?? 0)) {
          separatedSubtreeSizes.get(nodeParent)?.push(nodeSubtreeSize);
        }
      }
    }
  }

  for (const memberId of members) {
    const nodeParent = parent.get(memberId);
    const isRoot = nodeParent === undefined;
    const splitSubtreeSizes = isRoot
      ? rootChildSubtreeSizes.get(memberId) ?? []
      : separatedSubtreeSizes.get(memberId) ?? [];
    const isArticulationPoint = isRoot
      ? (childCounts.get(memberId) ?? 0) > 1
      : splitSubtreeSizes.length > 0;
    if (!isArticulationPoint) {
      continue;
    }

    const resultingParts = isRoot
      ? splitSubtreeSizes
      : getNonRootParts(members.length, splitSubtreeSizes);
    const largestRemainingPart = resultingParts.reduce((largest, partSize) => Math.max(largest, partSize), 0);
    articulationImpacts.push({
      functionId: memberId,
      impact: Math.max(0, members.length - 1 - largestRemainingPart),
      componentsAfterRemoval: resultingParts.length,
      largestRemainingPart,
    });
  }

  articulationImpacts.sort((left, right) => (
    right.impact - left.impact
    || right.componentsAfterRemoval - left.componentsAfterRemoval
    || left.functionId.localeCompare(right.functionId)
  ));

  return {
    count: articulationImpacts.length,
    largestImpact: articulationImpacts[0] ?? null,
  };
}

function getNonRootParts(componentSize: number, separatedSubtreeSizes: readonly number[]): number[] {
  const parts = [...separatedSubtreeSizes];
  const remainderSize = componentSize - 1 - separatedSubtreeSizes.reduce((sum, size) => sum + size, 0);
  if (remainderSize > 0) {
    parts.push(remainderSize);
  }
  return parts;
}

function calculateBoundaryRatio(internalEdges: number, entryEdges: number, exitEdges: number): number {
  const boundaryEdges = entryEdges + exitEdges;
  const totalEdges = internalEdges + boundaryEdges;
  return totalEdges === 0 ? 0 : boundaryEdges / totalEdges;
}

function createBoundaryCounts(): RuntimeBoundaryCounts {
  return {
    LOCAL_DIRECT: 0,
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
    EXTERNAL_TYPED: 0,
    EXTERNAL_UNKNOWN: 0,
    DYNAMIC: 0,
    UNRESOLVED: 0,
  };
}

function recordBoundary(
  componentIndex: number,
  boundaryKind: RuntimeBoundaryKind,
  boundaryCounts: RuntimeBoundaryCounts[],
  componentCosts: number[],
  effectiveEdges: number[],
): void {
  const counts = boundaryCounts[componentIndex];
  if (counts) {
    counts[boundaryKind] += 1;
  }
  const cost = BOUNDARY_COST_UNITS[boundaryKind];
  componentCosts[componentIndex] = (componentCosts[componentIndex] ?? 0) + cost;
  if (cost > 0) {
    effectiveEdges[componentIndex] = (effectiveEdges[componentIndex] ?? 0) + 1;
  }
}

function classifyBoundaryRisk(
  boundaryCounts: RuntimeBoundaryCounts,
  costUnits: number,
): "LOW" | "MEDIUM" | "HIGH" {
  if (costUnits === 0) {
    return "LOW";
  }
  if (Object.entries(boundaryCounts).some(([kind, count]) => (
    count > 0 && HIGH_RISK_BOUNDARIES.has(kind as RuntimeBoundaryKind)
  ))) {
    return "HIGH";
  }
  if (costUnits >= 8 || boundaryCounts.NODE_IO > 0 || boundaryCounts.EXTERNAL_UNKNOWN > 0) {
    return "MEDIUM";
  }
  return "LOW";
}

function countEligibilityMix(functions: readonly FunctionAnalysis[]): EligibilityMix {
  return functions.reduce<EligibilityMix>((mix, functionAnalysis) => ({
    ...mix,
    [functionAnalysis.eligibility.kind.toLowerCase()]: mix[functionAnalysis.eligibility.kind.toLowerCase() as keyof EligibilityMix] + 1,
  }), { supported: 0, conditional: 0, blocked: 0 });
}

function countBoundaryEligibilityMix(
  boundaryFunctionIds: ReadonlySet<FunctionId>,
  functionById: ReadonlyMap<FunctionId, FunctionAnalysis>,
): EligibilityMix {
  return countEligibilityMix([...boundaryFunctionIds].flatMap((functionId) => {
    const functionAnalysis = functionById.get(functionId);
    return functionAnalysis ? [functionAnalysis] : [];
  }));
}

function createWarnings(
  articulation: ArticulationImpact | null,
  functionById: ReadonlyMap<FunctionId, FunctionAnalysis>,
): CandidateIslandWarning[] {
  if (!articulation || articulation.internalCallers < 2) {
    return [];
  }

  const helper = functionById.get(articulation.functionId);
  return [{
    code: "SHARED_HELPER_ARTICULATION",
    functionId: articulation.functionId,
    message: `${helper?.name ?? articulation.functionId}() is a shared articulation helper (${articulation.internalCallers} internal callers); removing it separates ${articulation.impact} member(s).`,
  }];
}