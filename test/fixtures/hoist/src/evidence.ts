// Fixtures for workload evidence (v0.2.6e): a diff over collections sharing objects, and duplicate processing.
export interface Row { id: string; value: number }

export function diffRows(params: { base: Row[]; emitted: Row[] }): number {
  let changed = 0;
  const byId = new Map(params.base.map((row) => [row.id, JSON.stringify(row)]));
  for (const row of params.emitted) if (byId.get(row.id) !== JSON.stringify(row)) changed += 1;
  return changed;
}

export function indexTwice(rows: Row[], sink: { add(doc: { id: string; text: string }): void }, typed: { add(doc: { id: string; text: string }): void }): void {
  for (const row of rows) {
    const text = `${row.id}:${row.value}`;
    sink.add({ id: row.id, text });
    typed.add({ id: row.id, text });
  }
}
