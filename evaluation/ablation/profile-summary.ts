// Neutral profiler summary for the ablation's P arm: what a plain profiler shows, with no CrankTS analysis.
// Self and total time per function (by name and location), self time per package, idle/GC/program shares.
// Usage: node --experimental-strip-types evaluation/ablation/profile-summary.ts <file.cpuprofile> [projectRoot]
import { readFileSync } from "node:fs";

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
const [file, projectRoot = ""] = process.argv.slice(2);
if (!file) throw new Error("usage: profile-summary.ts <file.cpuprofile> [projectRoot]");
const profile = JSON.parse(readFileSync(file, "utf8")) as { nodes: Node[]; samples: number[]; timeDeltas: number[] };
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map<number, number>();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const self = new Map<number, number>();
profile.samples.forEach((sample, index) => self.set(sample, (self.get(sample) ?? 0) + (profile.timeDeltas[index] ?? 0)));
const total = [...self.values()].reduce((sum, value) => sum + value, 0);
const label = (node: Node): string => {
  const path = node.callFrame.url.replace("file://", "");
  const url = projectRoot && path.startsWith(projectRoot) ? `.${path.slice(projectRoot.length)}` : path;
  return `${node.callFrame.functionName || "(anonymous)"} ${url ? `${url}:${node.callFrame.lineNumber + 1}` : ""}`.trim();
};
const pkg = (url: string): string => {
  if (!url) return "(runtime)";
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;
  let last: string | undefined;
  for (const found of url.matchAll(match)) last = found[1];
  if (last) return last;
  if (url.startsWith("node:")) return "node:*";
  return "(project)";
};
const selfByLabel = new Map<string, number>();
const totalByLabel = new Map<string, number>();
const selfByPackage = new Map<string, number>();
for (const [id, micros] of self) {
  const node = nodes.get(id);
  if (!node) continue;
  selfByLabel.set(label(node), (selfByLabel.get(label(node)) ?? 0) + micros);
  selfByPackage.set(pkg(node.callFrame.url), (selfByPackage.get(pkg(node.callFrame.url)) ?? 0) + micros);
  const seen = new Set<string>();
  for (let current: number | undefined = id; current !== undefined; current = parent.get(current)) {
    const ancestor = nodes.get(current);
    if (!ancestor) break;
    const key = label(ancestor);
    if (seen.has(key)) continue;
    seen.add(key);
    totalByLabel.set(key, (totalByLabel.get(key) ?? 0) + micros);
  }
}
const pct = (micros: number): string => `${((micros / total) * 100).toFixed(1)}%`;
const table = (entries: Map<string, number>, limit: number): string[] => [...entries]
  .filter(([key]) => key !== "(root)")
  .sort((left, right) => right[1] - left[1]).slice(0, limit).map(([key, micros]) => `| ${pct(micros)} | \`${key}\` |`);
console.log(`# CPU profile summary\n\nSampled time: ${(total / 1e6).toFixed(2)} s\n`);
console.log("## Self time by package\n\n| Share | Package |\n| ---: | --- |\n" + table(selfByPackage, 15).join("\n") + "\n");
console.log("## Top functions by self time\n\n| Share | Function |\n| ---: | --- |\n" + table(selfByLabel, 30).join("\n") + "\n");
console.log("## Top functions by total time (including callees)\n\n| Share | Function |\n| ---: | --- |\n" + table(totalByLabel, 30).join("\n"));
