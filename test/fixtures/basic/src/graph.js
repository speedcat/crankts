export function normalizeNode(nodeId) {
    return nodeId | 0;
}
export function resolveEdges(edges, source) {
    return edges
        .filter((edge) => edge.source === source)
        .map((edge) => normalizeNode(edge.target));
}
export function buildGraph(edges, source) {
    const builder = new GraphBuilder(1);
    return builder.build(resolveEdges(edges, source));
}
export function buildGraphThroughHelper(edges, source) {
    return buildGraph(edges, source);
}
export function buildGraphThroughCaller(edges, source) {
    return buildGraphThroughHelper(edges, source);
}
class GraphBuilder {
    offset;
    constructor(offset) {
        this.offset = offset;
    }
    build(nodes) {
        return nodes
            .map((node) => normalizeNode(node + this.offset))
            .sort((left, right) => left - right);
    }
}
