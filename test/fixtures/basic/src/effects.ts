import { writeFileSync } from "node:fs";

let sharedCounter = 0;

export function pureHelper(value: number): number {
  return value + 1;
}

export function mutateArgument(values: number[]): number[] {
  values.push(1);
  return values;
}

export function callerMutatesArgument(values: number[]): number[] {
  return mutateArgument(values);
}

export function allocateLocally(count: number): number[] {
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(index);
  }
  return values;
}

export function readSharedState(): number {
  return sharedCounter + Date.now();
}

export function incrementSharedState(): number {
  sharedCounter += 1;
  return sharedCounter;
}

export function effectCycleA(): number {
  return effectCycleB();
}

export function effectCycleB(): number {
  sharedCounter += 1;
  return effectCycleA();
}

export function writeFile(path: string): void {
  writeFileSync(path, "data");
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  return response.text();
}

export function startFetch(url: string): void {
  fetch(url);
}