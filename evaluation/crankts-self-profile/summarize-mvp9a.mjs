#!/usr/bin/env node
// Builds evaluation/crankts-mvp9a-self-profile.json from the raw output of run-mvp9a.mjs.
// Usage: node evaluation/crankts-self-profile/summarize-mvp9a.mjs [--out /tmp/crankts-self]
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const outDir = resolve(outIndex >= 0 ? argv[outIndex + 1] : "/tmp/crankts-self");
const raw = readJson(join(outDir, "mvp9a-raw.json"));
const target = join(repoRoot, "evaluation", "crankts-mvp9a-self-profile.json");

// Stage groups for the decision point. Top-level stages only, so nothing is counted twice.
const STAGE_GROUPS = {
  typescriptCompilerBound: ["program", "functions", "callGraph", "direct", "scoring"],
  graphPasses: ["propagation.eligibility", "propagation.effects", "callClosure", "islands"],
  islands: ["islands"],
  propagation: ["propagation.eligibility", "propagation.effects"],
  assessment: ["assessment"],
  report: ["report"],
  startup: ["startup"],
};
const KERNEL_GATE_PERCENT = 15;

const workloads = Object.fromEntries(Object.entries(raw).map(([key, workload]) => [key, summarizeWorkload(key, workload)]));
const w1 = workloads.w1;
const decision = decide(w1);

const output = {
  schemaVersion: 1,
  project: "CrankTS",
  comparisonType: "mvp9a-crankts-self-profile",
  capturedAt: new Date().toISOString().slice(0, 10),
  environment: {
    node: process.version.slice(1),
    typescript: readJson(join(outDir, "w1-report.json")).project.typescript.version,
    host: `${process.platform}-${process.arch}`,
    crankts: readJson(join(outDir, "w1-report.json")).tool.version,
    build: "dist/ (tsc), no tsx",
  },
  protocol: {
    warmupRuns: 1,
    measuredRuns: raw.w1.runs.plain.length,
    modes: {
      plain: "wall + peak RSS (/usr/bin/time -l) + --timings",
      cpu: "--cpu-prof --cpu-prof-interval 1000",
      heap: "--heap-prof (default sampling interval)",
    },
    selfAnalysis: "crankts analyze src/ --profile <median cpu run> --heap-profile <median heap run>",
    stageGroups: STAGE_GROUPS,
  },
  workloads,
  decision,
};
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
console.error(`wrote ${target}`);

function summarizeWorkload(key, workload) {
  const report = readJson(join(outDir, `${key}-report.json`));
  const self = readJson(workload.selfAnalysis.report);
  const plain = workload.runs.plain;
  const medianTotalMs = median(plain.map((run) => run.timings.totalMs));

  const stageNames = plain[0].timings.stages.map((stage) => stage.name);
  const stages = stageNames.map((name) => {
    const samples = plain.map((run) => run.timings.stages.find((stage) => stage.name === name));
    const durations = samples.map((stage) => stage.durationMs);
    const rssDeltas = samples.flatMap((stage) => (stage.rssDelta === undefined ? [] : [stage.rssDelta]));
    return {
      name,
      kind: samples[0].kind,
      calls: samples[0].calls,
      medianMs: round(median(durations)),
      minMs: round(Math.min(...durations)),
      maxMs: round(Math.max(...durations)),
      percentOfTotal: percent(median(durations), medianTotalMs),
      ...(rssDeltas.length > 0 ? { medianRssDeltaBytes: median(rssDeltas) } : {}),
    };
  });
  const stageGroups = Object.fromEntries(Object.entries(STAGE_GROUPS).map(([group, names]) => {
    const groupMs = names.reduce((sum, name) => sum + (stages.find((stage) => stage.name === name)?.medianMs ?? 0), 0);
    return [group, { medianMs: round(groupMs), percentOfTotal: percent(groupMs, medianTotalMs) }];
  }));

  const profiledFunctions = self.functions.filter((fn) => fn.observedCpu);
  const assessmentById = new Map(self.acceleration.functions.map((assessment) => [assessment.functionId, assessment]));
  const actionsFor = (id) => (assessmentById.get(id)?.recommendations ?? []).map((rec) => `${rec.action}:${rec.level}`);
  const hotspot = (fn) => ({
    name: fn.name,
    file: fn.file,
    line: fn.line,
    eligibility: fn.eligibility.kind,
    selfCpuMs: round(fn.observedCpu.selfCpuMicros / 1000),
    inclusiveCpuMs: round(fn.observedCpu.totalCpuMicros / 1000),
    selfPercent: fn.observedCpu.samplePercent,
    inclusivePercent: percent(fn.observedCpu.totalCpuMicros, self.cpuProfile.totalSampleMicros),
    actions: actionsFor(fn.id),
  });
  const actionCounts = {};
  for (const assessment of self.acceleration.functions) {
    for (const recommendation of assessment.recommendations) {
      const actionKey = `${recommendation.action}:${recommendation.level}`;
      actionCounts[actionKey] = (actionCounts[actionKey] ?? 0) + 1;
    }
  }
  const graphKernelFiles = new Set(["src/analysis/islands.ts", "src/analysis/effects.ts", "src/analysis/eligibility.ts"]);
  const graphKernelNames = new Set([
    "findCandidateIslands", "findWeaklyConnectedComponents", "findArticulationPoints",
    "propagateEffects", "propagateEligibility",
  ]);

  return {
    label: workload.label,
    command: `node dist/cli.js analyze ${workload.args.join(" ")} --format json`,
    analysis: {
      functions: report.summary.functions.total,
      candidateIslands: report.summary.candidateIslands.total,
      ...(report.workspace ? { projectConfigsLoaded: report.workspace.projectConfigsLoaded } : {}),
      deterministicReport: workload.deterministicReport,
      reportSha256: workload.reportSha256[0],
    },
    wallSeconds: Object.fromEntries(Object.entries(workload.runs).map(([mode, runs]) => [mode, spread(runs.map((run) => run.wallSeconds))])),
    peakRssMegabytes: Object.fromEntries(Object.entries(workload.runs).map(([mode, runs]) => [
      mode,
      spread(runs.map((run) => run.peakRssBytes / 1_000_000)),
    ])),
    timings: { medianTotalMs: round(medianTotalMs), stageGroups, stages },
    cpuProfile: {
      profile: basename(workload.selfAnalysis.cpuProfile),
      totalSampleMs: round(self.cpuProfile.totalSampleMicros / 1000),
      sampleCount: self.cpuProfile.sampleCount,
      matchedSamplePercent: self.cpuProfile.matchedSamplePercent,
      confidence: self.cpuProfile.confidence,
      origins: self.cpuProfile.origins,
      note: "matchedSamplePercent counts stacks containing any CrankTS function; TypeScript compiler frames called from CrankTS are therefore 'matched'. origins[].selfPercent attributes leaf time instead.",
    },
    allocationProfile: {
      profile: basename(workload.selfAnalysis.heapProfile),
      totalSampledMegabytes: round(self.allocationProfile.totalSampledBytes / 1_000_000),
      sampleCount: self.allocationProfile.sampleCount,
      matchedSampledPercent: self.allocationProfile.matchedSampledPercent,
      confidence: self.allocationProfile.confidence,
    },
    hotspots: {
      bySelfCpu: [...profiledFunctions]
        .sort((left, right) => right.observedCpu.selfCpuMicros - left.observedCpu.selfCpuMicros)
        .slice(0, 10)
        .map(hotspot),
      byInclusiveCpu: [...profiledFunctions]
        .sort((left, right) => right.observedCpu.totalCpuMicros - left.observedCpu.totalCpuMicros)
        .slice(0, 10)
        .map(hotspot),
      graphKernels: profiledFunctions
        .filter((fn) => graphKernelFiles.has(fn.file) && graphKernelNames.has(fn.name))
        .map(hotspot),
    },
    allocationSites: self.functions
      .filter((fn) => fn.observedAllocation && fn.observedAllocation.sampledBytesSelf > 0)
      .sort((left, right) => right.observedAllocation.sampledBytesSelf - left.observedAllocation.sampledBytesSelf)
      .slice(0, 10)
      .map((fn) => ({
        name: fn.name,
        file: fn.file,
        line: fn.line,
        sampledMegabytesSelf: round(fn.observedAllocation.sampledBytesSelf / 1_000_000),
        selfPercent: fn.observedAllocation.sampledBytesSelfPercent,
        inclusivePercent: fn.observedAllocation.sampledBytesTotalPercent,
      })),
    selfAssessment: {
      functionsAssessed: self.acceleration.functions.length,
      actionCounts,
      nonKeepTs: self.acceleration.functions.flatMap((assessment) => assessment.recommendations
        .filter((recommendation) => recommendation.action !== "KEEP_TS")
        .map((recommendation) => ({
          name: assessment.name,
          functionId: assessment.functionId,
          action: recommendation.action,
          level: recommendation.level,
          confidence: recommendation.confidence,
          eligibility: assessment.feasibility.eligibility,
          explanation: recommendation.explanation,
        }))),
    },
  };
}

function decide(workload) {
  const groups = workload.timings.stageGroups;
  const islandsHot = groups.islands.percentOfTotal >= KERNEL_GATE_PERCENT;
  const propagationHot = groups.propagation.percentOfTotal >= KERNEL_GATE_PERCENT;
  const outcome = islandsHot
    ? "MVP-9b with Tarjan/WCC"
    : propagationHot
      ? "MVP-9b with propagation as GRAPH_BATCH kernel"
      : "KEEP_TS control case; scale graph kernel to W3 and check the kernel gate in isolation; wall gate not reachable on W1";
  return {
    workload: "w1",
    kernelGatePercent: KERNEL_GATE_PERCENT,
    islandsPercent: groups.islands.percentOfTotal,
    propagationPercent: groups.propagation.percentOfTotal,
    graphPassesPercent: groups.graphPasses.percentOfTotal,
    typescriptCompilerBoundPercent: groups.typescriptCompilerBound.percentOfTotal,
    typescriptPackageSelfCpuPercent: workload.cpuProfile.origins.find((origin) => origin.origin === "typescript")?.selfPercent ?? 0,
    maxWallGainFromGraphKernelPercent: groups.graphPasses.percentOfTotal,
    outcome,
  };
}

function spread(values) {
  return { median: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)) };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percent(part, total) {
  return total === 0 ? 0 : Math.round((part / total) * 10_000) / 100;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
