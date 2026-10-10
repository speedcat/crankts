export interface Edge {
  source: number;
  target: number;
}

export function normalizeNode(nodeId: number): number {
  return nodeId | 0;
}

export function resolveEdges(edges: Edge[], source: number): number[] {
  return edges
    .filter((edge) => edge.source === source)
    .map((edge) => normalizeNode(edge.target));
}

export function buildGraph(edges: Edge[], source: number): number[] {
  const builder = new GraphBuilder(1);
  return builder.build(resolveEdges(edges, source));
}

export function buildGraphThroughHelper(edges: Edge[], source: number): number[] {
  return buildGraph(edges, source);
}

export function buildGraphThroughCaller(edges: Edge[], source: number): number[] {
  return buildGraphThroughHelper(edges, source);
}

class GraphBuilder {
  constructor(private offset: number) {}

  build(nodes: number[]): number[] {
    return nodes
      .map((node) => normalizeNode(node + this.offset))
      .sort((left, right) => left - right);
  }
}