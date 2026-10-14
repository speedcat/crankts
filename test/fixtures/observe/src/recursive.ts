import { UNIT_MS } from "./units.ts";

const DEPTH = 20;

/** Two units of self time spread over 20 recursion levels. */
export function walk(depth: number): number {
  const end = performance.now() + (2 * UNIT_MS) / DEPTH;
  let acc = depth;
  do {
    for (let i = 0; i < 1000; i += 1) acc = (acc + Math.imul(i, 2654435761)) | 0;
  } while (performance.now() < end);
  return depth > 1 ? acc ^ walk(depth - 1) : acc;
}

export function walkAll(): number {
  return walk(DEPTH);
}
