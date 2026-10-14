import { UNIT_MS } from "./units.ts";

const CALLS = 2_000;

/** Cheap per call, but called often: two units of self time in total. */
export function normalizeToken(token: number): number {
  const end = performance.now() + (2 * UNIT_MS) / CALLS;
  let acc = token;
  do {
    for (let i = 0; i < 1000; i += 1) acc = (acc + Math.imul(i, 2654435761)) | 0;
  } while (performance.now() < end);
  return acc;
}

export function processTokens(): number {
  let total = 0;
  for (let call = 0; call < CALLS; call += 1) total ^= normalizeToken(call);
  return total;
}
