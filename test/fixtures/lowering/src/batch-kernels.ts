// Fixtures for the batch id-domain pass (v0.2.6b): a minimal per-group function, producers whose graph
// can and cannot be sealed, and a per-group function the pass must reject.
export type Id = string;

export function memberCount(members: readonly Id[], graph: ReadonlyMap<Id, ReadonlySet<Id>>): { readonly count: number; readonly repeats: number } {
  const seen = new Map<Id, number>();
  let count = 0;
  let repeats = 0;
  for (const member of members) {
    const previous = seen.get(member);
    if (previous === undefined) {
      count += 1;
      seen.set(member, 1);
    } else {
      repeats += previous;
      seen.set(member, previous + 1);
    }
  }
  return { count, repeats };
}

export function countsSealed(groups: readonly (readonly Id[])[], ids: readonly Id[]): number[] {
  const graph = new Map<Id, Set<Id>>(ids.map((id) => [id, new Set<Id>()]));
  return groups.map((members, index) => memberCount(members, graph).count + index);
}

export function countsMutatedLater(groups: readonly (readonly Id[])[], ids: readonly Id[]): number[] {
  const graph = new Map<Id, Set<Id>>(ids.map((id) => [id, new Set<Id>()]));
  const counts = groups.map((members, index) => memberCount(members, graph).repeats + index);
  graph.get(ids[0] ?? "")?.add("late");
  return counts;
}

export function earlyExit(members: readonly Id[], graph: ReadonlyMap<Id, ReadonlySet<Id>>): { readonly count: number } {
  if (members.length === 0) {
    return { count: 0 };
  }
  return { count: members.length };
}
