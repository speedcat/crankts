import { UNIT_MS } from "./units.ts";

/** One call, four units of self time. */
export function expensiveTransform(seed: number): number {
  const end = performance.now() + 4 * UNIT_MS;
  let acc = seed;
  do {
    for (let i = 0; i < 1000; i += 1) acc = (acc + Math.imul(i, 2654435761)) | 0;
  } while (performance.now() < end);
  return acc;
}
