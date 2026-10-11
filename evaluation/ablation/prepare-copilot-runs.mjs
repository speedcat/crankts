#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const repoRoot = resolve(import.meta.dirname, "../..");
const subjectsRoot = resolve(repoRoot, "../crankts-eval");
const defaultCampaign = "copilot-2026-10-11";
const allSubjects = ["pdf-lib", "rxdb", "typeorm", "codegraphchat-v2"];
const allArms = ["P", "E", "H"];
const vscodeCli = process.env.VSCODE_CLI ?? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const armMaterials = {
  P: "a CPU profile and neutral profiler summary for every workload",
  E: "a CPU profile, neutral profiler summary, and CrankTS evidence for every workload",
  H: "a CPU profile, neutral profiler summary, CrankTS evidence, and unvalidated CrankTS hypotheses for every workload",
};
const armFiles = {
  P: ["WORKLOAD.md", "profile.cpuprofile", "profile-summary.md"],
  E: ["WORKLOAD.md", "profile.cpuprofile", "profile-summary.md", "crankts-evidence.json", "crankts-evidence.md"],
  H: ["WORKLOAD.md", "profile.cpuprofile", "profile-summary.md", "crankts-evidence.json", "crankts-evidence.md", "crankts-hypotheses.json", "crankts-hypotheses.md"],
};
const strippedDirectories = new Set([".github", ".vscode", ".claude", ".codex", ".cursor", ".specstory", ".iw", ".cg", "runtime"]);
const strippedFiles = new Set([".mcp.json", "mcp.json", ".npmrc", ".netrc", ".pypirc", "optimization-log.md"]);

function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      campaign: { type: "string", default: defaultCampaign },
      subjects: { type: "string", default: allSubjects.join(",") },
      arms: { type: "string", default: allArms.join(",") },
      replicates: { type: "string", default: "2" },
      out: { type: "string" },
      bundles: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (positionals.length !== 0) throw new Error("Positional arguments are not supported.");
  if (values.help) {
    console.log("Usage: node evaluation/ablation/prepare-copilot-runs.mjs [--campaign NAME] [--subjects LIST] [--arms LIST] [--replicates N] [--out PATH] [--bundles PATH] [--dry-run]");
    process.exit(0);
  }

  const subjects = values.subjects.split(",").filter(Boolean);
  const arms = values.arms.split(",").filter(Boolean);
  const replicates = Number(values.replicates);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(values.campaign)) throw new Error("Campaign must use only letters, numbers, and hyphens.");
  if (subjects.length === 0 || subjects.some((subject) => !allSubjects.includes(subject)) || new Set(subjects).size !== subjects.length) {
    throw new Error(`Subjects must be unique values from: ${allSubjects.join(", ")}`);
  }
  if (arms.length === 0 || arms.some((arm) => !allArms.includes(arm)) || new Set(arms).size !== arms.length) {
    throw new Error(`Arms must be unique values from: ${allArms.join(", ")}`);
  }
  if (!Number.isInteger(replicates) || replicates < 1) throw new Error("Replicates must be a positive integer.");

  return {
    campaign: values.campaign,
    subjects,
    arms,
    replicates,
    dryRun: values["dry-run"],
    outputRoot: resolve(repoRoot, values.out ?? `../ablation-runs/${values.campaign}`),
    bundleRoot: resolve(repoRoot, values.bundles ?? `../ablation-bundles/ablation-inputs-2026-10-11`),
  };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "ignore", ...options });
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function isWithin(parent, candidate) {
  const path = relativePath(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertOutputSafe(outputRoot, subjects, bundleRoot) {
  const protectedRoots = [repoRoot, subjectsRoot, bundleRoot, ...subjects.map((subject) => join(subjectsRoot, subject))];
  for (const protectedRoot of protectedRoots) {
    if (isWithin(protectedRoot, outputRoot) || isWithin(outputRoot, protectedRoot)) {
      throw new Error(`Output overlaps protected input or source: ${protectedRoot}`);
    }
  }
  if (existsSync(outputRoot)) throw new Error(`Output already exists; refusing to overwrite: ${outputRoot}`);
  mkdirSync(dirname(outputRoot), { recursive: true });
  const outputDevice = statSync(dirname(outputRoot)).dev;
  for (const subject of subjects) {
    if (statSync(join(subjectsRoot, subject)).dev !== outputDevice) {
      throw new Error("Output and subject sources must be on the same APFS volume for copy-on-write cloning.");
    }
  }
}

function loadSubject(subjectName, bundleRoot) {
  const source = join(subjectsRoot, subjectName);
  const manifest = JSON.parse(readFileSync(join(repoRoot, "evaluation/ablation", subjectName, "dataset-manifest.json"), "utf8"));
  const actualCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actualCommit !== manifest.commit) throw new Error(`${subjectName} is at ${actualCommit}, not pinned ${manifest.commit}`);
  const workloadDefinitions = JSON.parse(readFileSync(join(source, "crankts-workloads/workloads.json"), "utf8"));
  const workloads = Object.keys(workloadDefinitions).map((name) => {
    const bundle = join(bundleRoot, subjectName, slug(name));
    for (const arm of allArms) {
      const armPath = join(bundle, arm);
      if (!existsSync(armPath)) throw new Error(`Missing ${subjectName}/${name}/${arm} bundle.`);
      const actual = readdirSync(armPath).sort();
      const expected = [...armFiles[arm]].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unexpected files in ${subjectName}/${name}/${arm}.`);
      if (readFileSync(join(armPath, "WORKLOAD.md"), "utf8").includes("crankts-eval/")) {
        throw new Error(`Bundle instructions still point to the canonical checkout: ${subjectName}/${name}/${arm}`);
      }
    }
    const degraded = readFileSync(join(bundle, "P/WORKLOAD.md"), "utf8").includes("Status: degraded");
    return { name, slug: slug(name), bundle, degraded };
  });
  return { name: subjectName, source, commit: actualCommit, degraded: workloads.some((workload) => workload.degraded), workloads };
}

function makeSchedule(subjects, arms, replicates) {
  const roundArms = [];
  for (let replicate = 1; replicate <= replicates; replicate += 1) {
    const order = replicate % 2 === 1 ? ["P", "E", "H"] : ["H", "E", "P"];
    for (const arm of order) if (arms.includes(arm)) roundArms.push({ arm, replicate });
  }
  const schedule = [];
  for (let round = 0; round < roundArms.length; round += 1) {
    const offset = round % subjects.length;
    const interleavedSubjects = [...subjects.slice(offset), ...subjects.slice(0, offset)];
    for (const subject of interleavedSubjects) {
      schedule.push({
        sequence: schedule.length + 1,
        runId: randomUUID(),
        subject: subject.name,
        arm: roundArms[round].arm,
        replicate: roundArms[round].replicate,
      });
    }
  }
  return schedule;
}

function copyClone(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  run("cp", ["-cR", source, destination]);
}

function copyTreeContentsClone(source, destination) {
  mkdirSync(destination, { recursive: true });
  run("cp", ["-cR", `${source}/.`, destination]);
}

function collectNodeModules(root) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const pathFromRoot = relativePath(root, path);
      if ([".git", ".specstory", ".iw", ".cg"].includes(entry.name)) continue;
      if (entry.name === "node_modules") {
        if (!pathFromRoot.startsWith(`crankts-workloads${sep}`)) paths.push(path);
      } else if (!strippedDirectories.has(entry.name)) {
        visit(path);
      }
    }
  };
  visit(root);
  return paths;
}

function sanitizeSubject(root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        if (strippedDirectories.has(entry.name) || [".aws", ".azure", ".kube", ".ssh", ".copilot"].includes(lowerName)) {
          rmSync(path, { recursive: true, force: true });
        } else {
          visit(path);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const isInstruction = /^(agents(?:\.override)?|claude(?:\.local)?|gemini|copilot-instructions)\.md$/i.test(entry.name)
        || lowerName.endsWith(".instructions.md");
      const isSecret = /^\.env(?:\.|$)/i.test(entry.name)
        || /^(?:id_rsa|id_ed25519)(?:\.pub)?$/i.test(entry.name);
      if (strippedFiles.has(lowerName) || isInstruction || isSecret) rmSync(path, { force: true });
    }
  };
  visit(root);
}

function makeWorkspaceSettings({ run, workspacePath, controlPath, sourceRoots, siblingWorkspacePaths }) {
  const home = homedir();
  const deniedPaths = [
    controlPath,
    ...sourceRoots,
    ...siblingWorkspacePaths,
    join(home, ".copilot"),
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".vscode"),
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".azure"),
    join(home, ".kube"),
    join(home, ".config/gh"),
    join(home, ".gitconfig"),
    join(home, ".git-credentials"),
    join(home, ".npmrc"),
    join(home, ".netrc"),
    join(home, "Library/Application Support/Code/User"),
  ];
  return {
    "github.copilot.chat.codeGeneration.useInstructionFiles": false,
    "github.copilot.chat.organizationInstructions.enabled": false,
    "chat.useAgentsMdFile": false,
    "chat.useNestedAgentsMdFiles": false,
    "chat.useClaudeMdFile": false,
    "chat.useCustomizationsInParentRepositories": false,
    "chat.includeApplyingInstructions": false,
    "chat.includeReferencedInstructions": false,
    "chat.mcp.autostart": "never",
    "chat.agent.sandbox.enabled": "on",
    "chat.agent.sandbox.network.allowNetwork": false,
    "chat.agent.sandbox.network.allowLocalNetwork": false,
    "chat.agent.sandbox.allowUnsandboxedCommands": false,
    "chat.agent.sandbox.credentials.authenticategit": false,
    "chat.agent.sandbox.credentials.authenticategh": false,
    "chat.agent.sandbox.mcpServers": true,
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "chat.agent.sandbox.fileSystem.userConfiguredPaths": { deniedPaths },
  };
}

function writePrompt(material) {
  return `You are a performance engineer. Goal: make every workload in this run faster without changing results.\n\nMaterial: each workload's perf-input/ contains ${material}.\n\nThis workspace contains an independent clean subject copy for each workload at workloads/<workload-name>/subject/. Its perf-input/ and crankts-workloads/measure.sh are inside that copy. Work on one workload at a time. Do not transfer patches or conclusions between sibling copies.\n\nRules:\n- Read that workload's perf-input/WORKLOAD.md before editing it.\n- Run all commands from that workload's subject directory.\n- Validate every finding alone with crankts-workloads/measure.sh <workload-name> before and after. Confirm the checksum is unchanged and the subject tests pass.\n- Report only findings with a measured median gain of at least 2% of that workload's wall time.\n- Keep each finding as a separate patch; record the patch file in that workload's FINDINGS.md.\n- Include location, diagnosis, change, before/after medians, checksum, test result, material attribution, and investigated-but-rejected findings.\n- Stop after 90 minutes.\n`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function freshGitBaseline(root) {
  run("git", ["init", "--quiet", "--initial-branch=ablation"], { cwd: root });
  run("git", ["config", "user.name", "Ablation Baseline"], { cwd: root });
  run("git", ["config", "user.email", "ablation-baseline@invalid"], { cwd: root });
  run("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeFileSync(join(root, ".git/info/exclude"), [
    "perf-input/",
    "/node_modules/",
    "**/node_modules/",
    "crankts-workloads/fixtures/",
    "",
  ].join("\n"));
  run("git", ["add", "-A"], { cwd: root });
  const typeormConfig = join(root, "packages/typeorm/ormconfig.json");
  if (existsSync(typeormConfig)) run("git", ["add", "-f", "packages/typeorm/ormconfig.json"], { cwd: root });
  run("git", ["commit", "--quiet", "-m", "Ablation baseline"], { cwd: root });
}

function copySubjectForWorkload(subject, workload, destination) {
  mkdirSync(destination, { recursive: true });
  const archive = join(dirname(destination), `.archive-${randomUUID()}.tar`);
  try {
    run("git", ["-C", subject.source, "archive", "--format=tar", `--output=${archive}`, subject.commit]);
    run("tar", ["-xf", archive, "-C", destination]);
  } finally {
    rmSync(archive, { force: true });
  }

  for (const nodeModules of collectNodeModules(subject.source)) {
    copyClone(nodeModules, join(destination, relative(subject.source, nodeModules)));
  }
  copyTreeContentsClone(join(subject.source, "crankts-workloads"), join(destination, "crankts-workloads"));
  rmSync(join(destination, "crankts-workloads/analyzer-project"), { recursive: true, force: true });
  if (subject.name === "codegraphchat-v2") rmSync(join(destination, "crankts-workloads/prepare-fixtures.mjs"), { force: true });
  if (subject.name === "typeorm") {
    cpSync(join(subject.source, "packages/typeorm/ormconfig.json"), join(destination, "packages/typeorm/ormconfig.json"));
  }
  sanitizeSubject(destination);
  freshGitBaseline(destination);
  copyTreeContentsClone(workload.bundle && join(workload.bundle, subject.arm), join(destination, "perf-input"));
}

function validateBundle(subjectName, workload, bundleRoot) {
  const bundle = join(bundleRoot, subjectName, workload.slug);
  for (const arm of allArms) {
    const armRoot = join(bundle, arm);
    if (!existsSync(armRoot)) throw new Error(`Missing ${arm} material for ${subjectName}/${workload.name}`);
    const files = readdirSync(armRoot).sort();
    if (JSON.stringify(files) !== JSON.stringify([...armFiles[arm]].sort())) {
      throw new Error(`Unexpected files in ${subjectName}/${workload.name}/${arm}: ${files.join(", ")}`);
    }
    if (readFileSync(join(armRoot, "WORKLOAD.md"), "utf8").includes("crankts-eval/")) {
      throw new Error(`Non-portable workload path in ${subjectName}/${workload.name}/${arm}`);
    }
  }
  return { ...workload, bundle };
}

function makeSettings({ controlRoot, sourceRoots, siblingRoots }) {
  const home = homedir();
  const campaignRoot = dirname(controlRoot);
  const campaignsRoot = dirname(campaignRoot);
  const workspaceParent = dirname(subjectsRoot);
  const siblingCampaignRoots = readdirSync(campaignsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && join(campaignsRoot, entry.name) !== campaignRoot)
    .map((entry) => join(campaignsRoot, entry.name));
  const siblingWorkspaceRoots = readdirSync(workspaceParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && join(workspaceParent, entry.name) !== campaignsRoot)
    .map((entry) => join(workspaceParent, entry.name));
  const deniedPaths = [
    controlRoot,
    ...siblingCampaignRoots,
    ...siblingWorkspaceRoots,
    ...sourceRoots,
    ...siblingRoots,
    join(home, ".copilot"),
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".azure"),
    join(home, ".kube"),
    join(home, ".config/gh"),
    join(home, ".gitconfig"),
    join(home, ".git-credentials"),
    join(home, ".npmrc"),
    join(home, ".netrc"),
    join(home, "Library/Application Support/Code/User/prompts"),
    join(home, "Library/Application Support/Code/User/workspaceStorage"),
  ];
  return {
    "github.copilot.chat.codeGeneration.useInstructionFiles": false,
    "github.copilot.chat.organizationInstructions.enabled": false,
    "chat.useAgentsMdFile": false,
    "chat.useNestedAgentsMdFiles": false,
    "chat.useClaudeMdFile": false,
    "chat.useCustomizationsInParentRepositories": false,
    "chat.includeApplyingInstructions": false,
    "chat.includeReferencedInstructions": false,
    "chat.mcp.autostart": "never",
    "chat.agent.sandbox.enabled": "on",
    "chat.agent.sandbox.network.allowNetwork": false,
    "chat.agent.sandbox.network.allowLocalNetwork": false,
    "chat.agent.sandbox.allowUnsandboxedCommands": false,
    "chat.agent.sandbox.credentials.authenticategit": false,
    "chat.agent.sandbox.credentials.authenticategh": false,
    "chat.agent.sandbox.mcpServers": true,
    "chat.agent.sandbox.fileSystem.allowDevToolAccess": false,
    "chat.agent.sandbox.fileSystem.userConfiguredPaths": {
      readonlyPaths: [...new Set([
        dirname(process.execPath),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        dirname(vscodeCli),
      ])],
      deniedPaths,
    },
  };
}

function runPrompt(material) {
  return `You are a performance engineer. Goal: improve every workload in this run without changing results.\n\nMaterial: each workload's perf-input/ contains ${material}.\n\nThis workspace has one independent clean subject copy per workload at workloads/<workload-name>/subject/. Its perf-input/ and crankts-workloads/measure.sh are inside that copy. Work on one workload at a time. Do not transfer patches or conclusions between sibling copies.\n\nRules:\n- Read each workload's perf-input/WORKLOAD.md first.\n- Run commands from that workload's subject directory.\n- Validate every finding alone with crankts-workloads/measure.sh <workload-name> before and after. Confirm checksum unchanged and subject tests pass.\n- Report only findings with a measured median gain of at least 2% of that workload's wall time.\n- Keep each finding as a separate patch and record its patch file in that workload's FINDINGS.md. Include location, diagnosis, change, before/after medians, checksum, test result, which material pointed to it, and investigated-but-rejected findings.\n- Stop after 90 minutes.\n`;
}

function copySubject(subject, workload, destination) {
  mkdirSync(destination, { recursive: true });
  const archive = join(dirname(destination), `.archive-${randomUUID()}.tar`);
  try {
    run("git", ["-C", subject.source, "archive", "--format=tar", `--output=${archive}`, subject.commit]);
    run("tar", ["-xf", archive, "-C", destination]);
  } finally {
    rmSync(archive, { force: true });
  }
  for (const modules of collectNodeModules(subject.source)) copyClone(modules, join(destination, relativePath(subject.source, modules)));
  copyTreeContentsClone(join(subject.source, "crankts-workloads"), join(destination, "crankts-workloads"));
  rmSync(join(destination, "crankts-workloads/analyzer-project"), { recursive: true, force: true });
  if (subject.name === "codegraphchat-v2") rmSync(join(destination, "crankts-workloads/prepare-fixtures.mjs"), { force: true });
  if (subject.name === "typeorm") cpSync(join(subject.source, "packages/typeorm/ormconfig.json"), join(destination, "packages/typeorm/ormconfig.json"));
  sanitizeSubject(destination);
  freshGitBaseline(destination);
  copyTreeContentsClone(join(workload.bundle, workload.arm), join(destination, "perf-input"));
}

const options = parseOptions(process.argv.slice(2));
if (process.platform !== "darwin") throw new Error("This packager uses APFS copy-on-write clones and currently supports macOS only.");
const outRoot = options.outputRoot;
const bundleRoot = options.bundleRoot;
const controlPath = join(outRoot, "control");
const workspacesPath = join(outRoot, "workspaces");
const selectedSubjects = options.subjects.map((name) => loadSubject(name, bundleRoot));
const schedule = makeSchedule(selectedSubjects, options.arms, options.replicates);

if (options.dryRun) {
  console.log(JSON.stringify({ output: outRoot, bundles: bundleRoot, sessions: schedule.length, degradedSubjects: selectedSubjects.filter((subject) => subject.degraded).map((subject) => subject.name), schedule }, null, 2));
  process.exit(0);
}

assertOutputSafe(outRoot, options.subjects, bundleRoot);
mkdirSync(dirname(outRoot), { recursive: true });
const stagingRoot = `${outRoot}.preparing-${randomUUID()}`;
const stagingControl = join(stagingRoot, "control");
const stagingWorkspaces = join(stagingRoot, "workspaces");
mkdirSync(stagingControl, { recursive: true });
mkdirSync(join(stagingControl, "prompts"), { recursive: true });
mkdirSync(join(stagingControl, "launch"), { recursive: true });
mkdirSync(join(stagingControl, "copilot-home"), { recursive: true });
mkdirSync(join(stagingControl, "user-data"), { recursive: true });
mkdirSync(join(stagingControl, "extensions"), { recursive: true });

const runMap = ["sequence,run_id,subject,arm,replicate,degraded,workspace,user_data_dir,prompt,launcher,model,effort,copilot_chat_version,start_time_utc,end_time_utc,wall_minutes,tokens,first_validated_finding_utc"];
const launchCommands = [];
try {
  for (const run of schedule) {
    const subject = selectedSubjects.find((entry) => entry.name === run.subject);
    const workspace = join(stagingWorkspaces, run.runId);
    const siblingWorkspaces = schedule.filter((entry) => entry.runId !== run.runId).map((entry) => join(outRoot, "workspaces", entry.runId));
    mkdirSync(join(workspace, "workloads"), { recursive: true });
    const sourceRoots = [repoRoot, subjectsRoot, bundleRoot, ...selectedSubjects.map((entry) => entry.source)];
    const finalWorkspace = join(workspacesPath, run.runId);
    const finalControl = controlPath;
    const finalUserData = join(finalControl, "user-data", run.runId);
    const userSettingsDir = join(stagingControl, "user-data", run.runId, "User");
    mkdirSync(userSettingsDir, { recursive: true });
    writeFileSync(join(userSettingsDir, "settings.json"), `${JSON.stringify(makeSettings({ controlRoot: finalControl, sourceRoots, siblingRoots: siblingWorkspaces }), null, 2)}\n`);

    for (const workload of subject.workloads) {
      const subjectCopy = join(workspace, "workloads", workload.slug, "subject");
      copySubject(subject, { ...workload, arm: run.arm }, subjectCopy);
    }

    const promptPath = join(stagingControl, "prompts", `${run.runId}.md`);
    writeFileSync(promptPath, runPrompt(armMaterials[run.arm]));
    const launcherPath = join(stagingControl, "launch", `${run.runId}.command`);
    const launcher = [
      "#!/bin/sh",
      "set -eu",
      `export COPILOT_HOME=${shellQuote(join(finalControl, "copilot-home", run.runId))}`,
      "export GIT_CONFIG_GLOBAL=/dev/null",
      "export GIT_CONFIG_NOSYSTEM=1",
      "unset OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GH_TOKEN GITHUB_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN COPILOT_GITHUB_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN GOOGLE_APPLICATION_CREDENTIALS AZURE_CLIENT_SECRET NPM_TOKEN NODE_AUTH_TOKEN",
      `exec ${shellQuote(vscodeCli)} --user-data-dir ${shellQuote(finalUserData)} --extensions-dir ${shellQuote(join(finalControl, "extensions"))} --new-window ${shellQuote(finalWorkspace)}`,
      "",
    ].join("\n");
    writeFileSync(launcherPath, launcher);
    chmodSync(launcherPath, 0o755);
    runMap.push([
      run.sequence,
      run.runId,
      run.subject,
      run.arm,
      run.replicate,
      subject.degraded ? "yes" : "no",
      finalWorkspace,
      finalUserData,
      join(finalControl, "prompts", `${run.runId}.md`),
      join(finalControl, "launch", `${run.runId}.command`),
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ].map(csvCell).join(","));
    launchCommands.push(`${run.sequence}. ${run.runId} (${subject.degraded ? "DEGRADED: " : ""}${run.subject} ${run.arm} replicate ${run.replicate})`);
  }

  writeFileSync(join(stagingControl, "run-map.csv"), `${runMap.join("\n")}\n`);
  writeFileSync(join(stagingControl, "COPILOT-SETUP.md"), `# Isolated Copilot Runs\n\n${schedule.length} sessions are ready. Open only the workspace folder listed in run-map.csv. The CSV, prompts, Copilot homes, and VS Code user-data directories are outside the workspace and denied to the agent sandbox.\n\n## One-time extension setup\n\nInstall Copilot Chat into the campaign's shared extension directory once, before starting any runs:\n\n\`\`\`sh\n${shellQuote(vscodeCli)} --user-data-dir ${shellQuote(join(controlPath, "extension-setup-data"))} --extensions-dir ${shellQuote(join(controlPath, "extensions"))} --install-extension GitHub.copilot-chat\n\`\`\`\n\nDo not use this bootstrap user-data directory for a scored session. Do not install prompt files, instruction files, MCP servers, skills, or unrelated agent extensions.\n\n## Run Protocol\n\n1. For each row in \`run-map.csv\`, run its launcher. It opens a new VS Code process with a unique \`--user-data-dir\`, a unique \`COPILOT_HOME\`, and the shared extension directory. Sign in to the same Copilot account for each run. Do not reuse or fork a session.\n2. Start a new independent Copilot Agent Host session. Select the same model and effort in every run. Paste the row's prompt file; the three arm prompts differ only in their Material line.\n3. In the Chat view, disable web, browser, MCP, external-repository, and unrelated tools. Only workspace and terminal tools are needed.\n4. Before the first scored run, inspect **Developer: Show Chat Debug View**. Confirm no prior conversation, unexpected context, or external tool definitions are present. Check **/sandbox policy**; do not proceed if sandboxing is inactive or organization-managed instructions appear.\n5. Interleave runs in \`run-map.csv\` order. Use the same time/token budget for every session. Fill start/end time, wall minutes, tokens, and first validated finding time in the CSV.\n\n## Isolation Checks\n\n- Every run has an opaque workspace folder and clean subject copy per workload, with a fresh baseline Git commit and no source history.\n- Only the selected arm's bundle files are copied into each \`perf-input/\`.\n- Repository instructions, project MCP config, secrets, prior runtime/index state, and CrankTS files are not copied.\n- Each workspace sandbox denies the control directory, canonical repositories, bundle source, sibling run workspaces, and common credential/config directories. Network and unsandboxed fallback are disabled.\n- \`codegraphchat-v2\` is marked degraded because its prepared workload is not the protocol's repository-index/query workload and is under five seconds. Exclude it from a product-gate score.\n\n## Run Order\n\n${launchCommands.join("\n")}\n`);
  renameSync(stagingRoot, outRoot);
} catch (error) {
  rmSync(stagingRoot, { recursive: true, force: true });
  throw error;
}

console.log(`Prepared ${schedule.length} isolated sessions at ${outRoot}`);
console.log(`Run mapping and prompts are outside the workspaces: ${controlPath}`);
console.log(`Codegraph degraded status: ${selectedSubjects.some((subject) => subject.name === "codegraphchat-v2" && subject.degraded) ? "included and marked; exclude from gate score" : "not selected"}`);