/**
 * Upstream packing runtime (v0.2.6b), emitted into generated adapters.
 *
 * A producer that builds `Map<Id, Set<Id>>` and provably never mutates it afterwards (checked by the batch
 * pass on the patched function) calls `sealGraph(graph)` once. Every packed consumer of that graph object
 * (from any generated crate: the registry lives on `globalThis` under a registered symbol) then reuses the
 * interned ids and the CSR instead of packing per call. Consumers verify that the sealed id order is the
 * order they would have used; otherwise they pack as before.
 */
export function sealedGraphRuntime(): string {
  return `/** A graph packed once by its producer (ids in key order, CSR in Set insertion order). */
export interface SealedGraph {
  readonly ids: readonly string[];
  readonly index: ReadonlyMap<string, number>;
  readonly offsets: Uint32Array;
  readonly neighbors: Uint32Array;
}

const SEALED_GRAPHS = Symbol.for("crankts.sealedGraphs");
const sealedGraphRegistry = globalThis as unknown as Record<symbol, WeakMap<object, SealedGraph> | undefined>;
const sealedGraphs: WeakMap<object, SealedGraph> = (sealedGraphRegistry[SEALED_GRAPHS] ??= new WeakMap());

/** Interns ids in key order and builds the CSR; PackingGuard if an id is empty or a neighbor is not a key. */
export function packGraphByKeys(graph: ReadonlyMap<string, ReadonlySet<string>>): SealedGraph {
  const ids = [...graph.keys()];
  const index = new Map<string, number>();
  for (const id of ids) {
    if (id === "") throw new PackingGuard("ids must be non-empty");
    index.set(id, index.size);
  }
  const offsets = new Uint32Array(ids.length + 1);
  const list: number[] = [];
  let node = 0;
  for (const neighbors of graph.values()) {
    for (const neighbor of neighbors) {
      const neighborIndex = index.get(neighbor);
      if (neighborIndex === undefined) throw new PackingGuard("graph references an id outside its keys");
      list.push(neighborIndex);
    }
    offsets[++node] = list.length;
  }
  return { ids, index, offsets, neighbors: Uint32Array.from(list) };
}

/** Graphs sealed, and packings served from a sealed graph (per generated module). */
export const sealedGraphStats = { sealed: 0, reused: 0 };

/** Called by the patched producer after the graph's last mutation. A guard leaves the graph unsealed. */
export function sealGraph(graph: ReadonlyMap<string, ReadonlySet<string>>): void {
  try {
    sealedGraphs.set(graph, packGraphByKeys(graph));
    sealedGraphStats.sealed += 1;
  } catch (error) {
    if (!(error instanceof PackingGuard)) throw error;
  }
}

export function sealedGraph(graph: object): SealedGraph | undefined {
  return sealedGraphs.get(graph);
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let position = 0; position < left.length; position += 1) {
    if (left[position] !== right[position]) return false;
  }
  return true;
}
`;
}
