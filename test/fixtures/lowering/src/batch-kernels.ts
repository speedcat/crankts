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

// IMMUTABLE_AFTER_CAPTURE: the last group is mutated (through an alias) after the batch ran but before its
// result is used; the capture guard must recompute it with the original.
export function countsAliased(groups: Id[][], ids: readonly Id[]): number[] {
  const graph = new Map<Id, Set<Id>>(ids.map((id) => [id, new Set<Id>()]));
  const last = groups[groups.length - 1];
  return groups.map((members, index) => {
    if (index === 0 && last) {
      last.push(last[0] ?? "extra");
    }
    return memberCount(members, graph).repeats;
  });
}

// TOTAL_ORDER_KEY: `ratio` is a quotient, not provably an exact integer, so the batch kernel is rejected.
export function bestRatio(members: readonly Id[], graph: ReadonlyMap<Id, ReadonlySet<Id>>): { readonly best: { readonly id: Id; readonly ratio: number } | null } {
  const items: Array<{ id: Id; ratio: number }> = [];
  for (const member of members) {
    items.push({ id: member, ratio: members.length / 3 });
  }
  items.sort((left, right) => right.ratio - left.ratio || left.id.localeCompare(right.id));
  return { best: items[0] ?? null };
}

export function ratios(groups: readonly (readonly Id[])[], ids: readonly Id[]): number[] {
  const graph = new Map<Id, Set<Id>>(ids.map((id) => [id, new Set<Id>()]));
  return groups.map((members, index) => (bestRatio(members, graph).best?.ratio ?? 0) + index);
}
