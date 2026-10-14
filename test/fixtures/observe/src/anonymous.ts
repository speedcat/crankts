import { UNIT_MS } from "./units.ts";

/** One unit in a map callback, half a unit in a forEach callback. */
export function buildIndex(items: readonly number[]): number {
  const mapped = items.map((item) => {
    const end = performance.now() + UNIT_MS / items.length;
    let acc = item;
    do {
      for (let i = 0; i < 1000; i += 1) acc = (acc + Math.imul(i, 2654435761)) | 0;
    } while (performance.now() < end);
    return acc;
  });
  let total = 0;
  mapped.forEach(function (value) {
    const end = performance.now() + UNIT_MS / 2 / items.length;
    let acc = value;
    do {
      for (let i = 0; i < 1000; i += 1) acc = (acc + Math.imul(i, 2654435761)) | 0;
    } while (performance.now() < end);
    total ^= acc;
  });
  return total;
}
