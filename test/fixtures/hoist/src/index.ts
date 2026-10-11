// Fixtures for HOIST_INVARIANT_WORK detection (v0.2.6d, R3).
const PATTERN = "a+b";
let mutablePattern = "c+";

export function makeMatcher(pattern: string): (value: string) => boolean {
  const compiled = new RegExp(pattern);
  return (value) => compiled.test(value);
}

/** STATIC_INVARIANT: compiled from a module constant on every call. */
export function countStatic(items: readonly string[]): number {
  const re = new RegExp(PATTERN);
  let count = 0;
  for (const item of items) if (re.test(item)) count += 1;
  return count;
}

/** PARAM_DEPENDENT: the matcher depends on a parameter; only runtime repetition can justify hoisting. */
export function filterWith(items: readonly string[], pattern: string): string[] {
  const matches = makeMatcher(pattern);
  return items.filter((item) => matches(item));
}

/** LOOP_INVARIANT: rebuilt inside the loop although its input does not change there. */
export function countInLoop(items: readonly string[], pattern: string): number {
  let count = 0;
  for (const item of items) {
    if (makeMatcher(pattern)(item)) count += 1;
  }
  return count;
}

/** Module state that can change: not invariant. Containers are not candidates at all. */
export function withMutable(items: readonly string[]): number {
  const seen = new Set<string>(items);
  return makeMatcher(mutablePattern)("cc") ? seen.size : 0;
}

export function setMutable(pattern: string): void {
  mutablePattern = pattern;
}
