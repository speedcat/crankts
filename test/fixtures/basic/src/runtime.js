import { readFileSync } from "node:fs";
import { buildGraph } from "./graph.js";
export function loadConfigAndBuild(path, edges) {
    readFileSync(path, "utf8");
    return buildGraph(edges, 0);
}
export function invokePlugin(plugin, name) {
    plugin[name]();
}
export function initialize(path, edges, plugin) {
    loadConfigAndBuild(path, edges);
    invokePlugin(plugin, "ready");
}
