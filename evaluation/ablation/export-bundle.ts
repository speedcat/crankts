// Exports the material for the three ablation arms from a finished study run (`run-study.ts`), per workload:
//   P/  the CPU profile and a neutral profiler summary (no CrankTS analysis)
//   E/  P + CrankTS evidence: call-site attribution, caller paths, static effects, observations (no hypotheses)
//   H/  E + CrankTS hypotheses: derived hypotheses with preconditions, advisor recommendations, hoisting candidates
// Each arm directory is self-contained. Annotations are never exported (the study configs of new projects have none).
// Usage: node --import tsx evaluation/ablation/export-bundle.ts <study.ts> <study out dir> <bundle dir>
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeProject } from "../../src/analysis/analyze-project.js";
import { computeCoverage } from "../../src/analysis/coverage.js";
import { derivePhenomena, readProbedCalls, type Phenomenon } from "../../src/analysis/evidence.js";
import { readInputSignatures } from "../../src/analysis/input-signatures.js";
import type { AnalysisResult, FunctionAnalysis } from "../../src/analysis/model.js";
import type { StudyConfig } from "../coverage/run-study.ts";

const [configPath, studyOut, bundleRoot] = process.argv.slice(2);
if (!configPath || !studyOut || !bundleRoot) throw new Error("usage: export-bundle.ts <study.ts> <study out dir> <bundle dir>");
const study = (await import(pathToFileURL(resolve(configPath)).href) as { default: StudyConfig }).default;
const summaryScript = resolve(import.meta.dirname, "profile-summary.ts");

function mainProfile(directory: string): string | undefined {
  if (!existsSync(directory)) return undefined;
  const files = readdirSync(directory).filter((entry) => entry.endsWith(".cpuprofile"));
  const mains = files.filter((entry) => /\.\d+\.0\.\d+\.cpuprofile$/.test(entry));
  const main = (mains.length > 0 ? mains : files).sort((a, b) => statSync(join(directory, b)).size - statSync(join(directory, a)).size)[0];
  return main ? join(directory, main) : undefined;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function describe(analysis: AnalysisResult): (id: string) => string {
  const byId = new Map(analysis.functions.map((fn) => [fn.id, fn]));
  return (id) => {
    const fn = byId.get(id);
    return fn ? `${fn.name || "(anonymous)"} (${fn.file}:${fn.line})` : id;
  };
}

function evidenceOf(analysis: AnalysisResult, phenomena: readonly Phenomenon[]): unknown {
  const coverage = computeCoverage(analysis);
  const name = describe(analysis);
  const byId = new Map<string, FunctionAnalysis>(analysis.functions.map((fn) => [fn.id, fn]));
  return {
    tool: "CrankTS evidence (v0.2.6e)",
    note: "Percentages are shares of the profiled runtime. Upper bounds are at-risk shares, not expected gains.",
    runtimeByAttributionTarget: coverage.attribution,
    selfTimeByOrigin: coverage.buckets.slice(0, 15).map((bucket) => ({ origin: bucket.origin, kind: bucket.kind, percent: bucket.percent })),
    callSites: coverage.callSites.map((site) => ({
      function: name(site.functionId),
      attributedPercent: site.attributedPercent,
      ownJavaScriptPercent: site.ownPercent,
      byTarget: site.byTarget,
      largestExternal: site.topExternal,
      dominantCallerPaths: (site.callerPaths ?? []).map((path) => ({ path: path.path.map(name), percentOfSite: path.percentOfSite })),
      staticEffects: byId.get(site.functionId)?.effects ?? [],
    })),
    observations: phenomena.map((phenomenon) => ({
      observation: phenomenon.observation,
      call: phenomenon.call,
      inFunction: name(phenomenon.functionId),
      callee: phenomenon.callee,
      upperBoundPercent: phenomenon.upperBoundPercent,
      evidence: phenomenon.evidence,
    })),
  };
}

function hypothesesOf(analysis: AnalysisResult, phenomena: readonly Phenomenon[]): unknown {
  const name = describe(analysis);
  const coverage = computeCoverage(analysis);
  const siteIds = new Set(coverage.callSites.map((site) => site.functionId));
  const assessments = analysis.acceleration.functions.filter((assessment) => siteIds.has(assessment.functionId));
  return {
    tool: "CrankTS hypotheses (v0.2.6e)",
    note: "Hypotheses are unvalidated. Preconditions are MET, UNVERIFIED, or VIOLATED; estimates assume a simple cost model.",
    hypotheses: phenomena.map((phenomenon) => ({
      call: phenomenon.call,
      inFunction: name(phenomenon.functionId),
      callee: phenomenon.callee,
      observation: phenomenon.observation,
      upperBoundPercent: phenomenon.upperBoundPercent,
      ...(phenomenon.hypothesis ? { hypothesis: phenomenon.hypothesis } : { withheld: phenomenon.withheld }),
    })),
    advisor: assessments.flatMap((assessment) => assessment.recommendations
      .filter((recommendation) => recommendation.action !== "KEEP_TS")
      .map((recommendation) => ({ function: name(assessment.functionId), action: recommendation.action, level: recommendation.level, confidence: recommendation.confidence, explanation: recommendation.explanation, evidence: recommendation.evidence }))),
    hoistingCandidates: analysis.functions.flatMap((fn) => (fn.hoistCandidates ?? []).map((candidate) => ({ function: name(fn.id), ...candidate }))),
  };
}

function markdown(title: string, data: unknown): string {
  return `# ${title}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
}

for (const [index, workload] of study.workloads.entries()) {
  const profile = mainProfile(join(studyOut, `profile-${index}-0`));
  if (!profile) {
    console.error(`${workload.name}: no profile, skipped`);
    continue;
  }
  const signatures = join(studyOut, `signatures-${index}.json`);
  const analysis = analyzeProject(study.analysisRoot, {
    profilePath: profile,
    workloadLabel: workload.name,
    workspaceReferences: study.workspaceReferences === true,
    ...(existsSync(signatures) ? { inputSignaturePaths: [signatures] } : {}),
  });
  const phenomena = existsSync(signatures)
    ? derivePhenomena(readProbedCalls(join(studyOut, `probe-${index}`)), readInputSignatures([signatures]), { totalMicros: analysis.cpuProfile?.totalSampleMicros })
    : [];
  const base = join(bundleRoot, study.name, slug(workload.name));
  const summary = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", summaryScript, profile, study.cwd], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (summary.status !== 0) throw new Error(`profile summary failed: ${summary.stderr}`);
  const workloadText = `# Workload\n\n${workload.name}\n\nCommand (run from \`${study.cwd}\`):\n\n\`\`\`sh\nnode ${workload.args.join(" ")}\n\`\`\`\n${workload.env ? `\nEnvironment: \`${JSON.stringify(workload.env)}\`\n` : ""}`;
  const evidence = evidenceOf(analysis, phenomena);
  const hypotheses = hypothesesOf(analysis, phenomena);
  for (const arm of ["P", "E", "H"] as const) {
    const directory = join(base, arm);
    mkdirSync(directory, { recursive: true });
    copyFileSync(profile, join(directory, "profile.cpuprofile"));
    writeFileSync(join(directory, "profile-summary.md"), summary.stdout);
    writeFileSync(join(directory, "WORKLOAD.md"), workloadText);
    if (arm !== "P") {
      writeFileSync(join(directory, "crankts-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
      writeFileSync(join(directory, "crankts-evidence.md"), markdown("CrankTS evidence", evidence));
    }
    if (arm === "H") {
      writeFileSync(join(directory, "crankts-hypotheses.json"), `${JSON.stringify(hypotheses, null, 2)}\n`);
      writeFileSync(join(directory, "crankts-hypotheses.md"), markdown("CrankTS hypotheses", hypotheses));
    }
  }
  console.error(`${workload.name}: ${base}/{P,E,H} (${phenomena.length} observations)`);
}
