/** Short-lived: 2000 arrays of 1000 numbers (about 8 KB each) allocated and dropped right away, about 16 MB. */
export function allocateTemporaries(): number {
  let total = 0;
  for (let i = 0; i < 2000; i += 1) {
    const buffer = new Array<number>(1000).fill(i);
    total += buffer.length;
  }
  return total;
}

/** Retained until exit: 100 arrays of the same size, about 0.8 MB. */
export const retained: number[][] = [];

export function retainSome(): void {
  for (let i = 0; i < 100; i += 1) retained.push(new Array<number>(1000).fill(i));
}
