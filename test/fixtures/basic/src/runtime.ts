import { readFileSync } from "node:fs";
import { buildGraph } from "./graph.js";
import type { Edge } from "./graph.js";

export function loadConfigAndBuild(path: string, edges: Edge[]): number[] {
  readFileSync(path, "utf8");
  return buildGraph(edges, 0);
}

export function invokePlugin(plugin: Record<string, () => void>, name: string): void {
  plugin[name]();
}

export function initialize(path: string, edges: Edge[], plugin: Record<string, () => void>): void {
  loadConfigAndBuild(path, edges);
  invokePlugin(plugin, "ready");
}