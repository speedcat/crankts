import { invokePlugin } from "./runtime.js";

export function sumSquares(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value * value;
  }
  return total;
}

export function buildRows(count: number): Array<{ id: number }> {
  const rows: Array<{ id: number }> = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({ id: index });
  }
  return rows;
}

export function sortValues(values: number[]): number[] {
  return values.slice().sort((left, right) => left - right);
}

export function loopAroundPlugin(
  plugin: Record<string, () => void>,
  name: string,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    invokePlugin(plugin, name);
  }
}

export function factorial(value: number): number {
  if (value <= 1) {
    return 1;
  }
  return value * factorial(value - 1);
}

export const recursiveArrow = (value: number): number => (
  value <= 1 ? 1 : value * recursiveArrow(value - 1)
);

export function profiledRoot(value: number): number {
  return profiledHelper(value);
}

export function profiledHelper(value: number): number {
  return value * 2;
}