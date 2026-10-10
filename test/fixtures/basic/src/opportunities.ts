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

function parseOne(file: string): { file: string } {
  return { file };
}

export function parseFiles(files: string[], output: Array<{ file: string }>): Array<{ file: string }> {
  for (let index = 0; index < files.length; index += 1) {
    output[index] = parseOne(files[index]);
  }
  return output;
}

export function sumValues(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

export function countDegrees(edges: Array<{ target: number }>): Map<number, number> {
  const degree = new Map<number, number>();
  for (const edge of edges) {
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

export function indexNodesById(nodes: Array<{ id: number }>): Map<number, { id: number }> {
  const byId = new Map<number, { id: number }>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }
  return byId;
}

export function enqueueNodes(nodes: number[], queue: number[]): number[] {
  for (const node of nodes) {
    queue.push(node);
  }
  return queue;
}

export function prefixSums(values: number[], output: number[]): number[] {
  for (let index = 1; index < values.length; index += 1) {
    output[index] = output[index - 1] + values[index];
  }
  return output;
}

export function readAheadAndWrite(values: number[], output: number[]): void {
  for (let index = 0; index < values.length; index += 1) {
    const next = output[index + 1];
    output[index] = next ?? values[index];
  }
}

export async function parseFilesConcurrently(files: string[]): Promise<Array<{ file: string }>> {
  return Promise.all(files.map(async (file) => parseOne(file)));
}

export async function parseAndQueueConcurrently(nodes: number[], queue: number[]): Promise<void> {
  await Promise.all(nodes.map(async (node) => {
    queue.push(node);
  }));
}