// Functions that lower to Kernel IR but must fail verification or obligations.

export function mutatesParameter(values: number[]): number {
  values[0] = 1;
  return values.length;
}

export function aliasesFresh(count: number): number[] {
  const first: number[] = [];
  const second = first;
  second.push(count);
  return first;
}

export function storesFresh(count: number): number[][] {
  const rows: number[][] = [];
  const row: number[] = [count];
  rows.push(row);
  row.push(count);
  return rows;
}

export function recursive(depth: number): number {
  return depth <= 0 ? 0 : recursive(depth - 1);
}

export function growsWhileIterating(values: number[]): number[] {
  const copy: number[] = [];
  for (let index = 0; index < copy.length + 1; index++) {
    copy.push(index);
    if (index > values.length) {
      break;
    }
  }
  return copy;
}

export function lowersCase(text: string): string {
  return text.toLowerCase();
}

export function spins(limit: number): number {
  let count = 0;
  while (count < limit) {
    count += 1;
  }
  return count;
}

export function truthiness(value: number): boolean {
  return value ? true : false;
}

export function mixedNumbers(values: number[], scale: number): number[] {
  const out: number[] = [];
  let count = 0;
  for (let index = 0; index < values.length; index++) {
    out.push(index * 2);
    count += 1;
  }
  const negativeZero = -0;
  const scaled = count + scale;
  out.push(count + negativeZero + scaled);
  return out;
}
