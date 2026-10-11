// Fixtures for lowering arrow functions and methods (v0.2.6d, R4).
export const square = (value: number): number => value * value;

export const sumOfSquares = (values: readonly number[]): number => {
  let total = 0;
  for (const value of values) {
    total += square(value);
  }
  return total;
};

export const countAbove = function (values: readonly number[], limit: number): number {
  let count = 0;
  for (const value of values) {
    if (value > limit) count += 1;
  }
  return count;
};

export class Stats {
  factor = 2;

  static total(values: readonly number[]): number {
    let sum = 0;
    for (const value of values) sum += value;
    return sum;
  }

  scaled(values: readonly number[]): number {
    return this.factor * values.length;
  }
}

export function scaleAll(values: readonly number[]): number {
  const factor = 3;
  const scale = (value: number): number => value * factor;
  let total = 0;
  for (const value of values) total += scale(value);
  return total;
}
