#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const subjectsRoot = resolve(repoRoot, "../crankts-eval");
const bundleRoot = resolve(repoRoot, "../ablation-bundles/ablation-inputs-2026-10-11");
const outputRoot = resolve(process.argv[2] ?? "../ablation-runs/copilot-2026-10-11");
const controlRoot = join(outputRoot, "control");
const workspaceRoot = join(outputRoot, "workspaces");
const vscodeCli = process.env.VSCODE_CLI ?? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

function parseCsvLine(line) {
  const fields = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '"') throw new Error("Expected quoted CSV cell.");
    index += 1;
    let value = "";
    while (index < line.length) {
      if (line[index] === '"' && line[index + 1] === '"') {
        value += '"';
        index += 2;
      } else if (line[index] === '"') {
        index += 1;
        break;
      } else {
        value += line[index];
        index += 1;
      }
    }
    fields.push(value);
    if (line[index] === ",") index += 1;
    else if (index < line.length) throw new Error("Unexpected text after CSV cell.");
  }
  return fields;
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function makeSettings(siblingRoots) {
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
  const sourceRoots = [
    repoRoot,
    subjectsRoot,
    bundleRoot,
    ...new Set(["pdf-lib", "rxdb", "typeorm", "codegraphchat-v2"].map((name) => join(subjectsRoot, name))),
  ];
  const deniedPaths = [
    controlRoot,
    ...siblingCampaignRoots,
    ...siblingWorkspaceRoots,
    ...sourceRoots,
    ...siblingRoots,
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

const mapPath = join(controlRoot, "run-map.csv");
if (!existsSync(mapPath)) throw new Error(`Missing run map: ${mapPath}`);
if (!existsSync(vscodeCli)) throw new Error(`VS Code CLI not found: ${vscodeCli}; set VSCODE_CLI to override.`);

const lines = readFileSync(mapPath, "utf8").trimEnd().split("\n");
const oldHeader = parseCsvLine(lines[0]);
const indexes = new Map(oldHeader.map((name, index) => [name, index]));
const requiredColumns = ["sequence", "run_id", "subject", "arm", "replicate", "degraded", "workspace", "prompt", "launcher"];
for (const column of requiredColumns) if (!indexes.has(column)) throw new Error(`Run map lacks ${column}.`);
const runs = lines.slice(1).map((line) => {
  const cells = parseCsvLine(line);
  const read = (name) => cells[indexes.get(name)] ?? "";
  return {
    sequence: read("sequence"),
    runId: read("run_id"),
    subject: read("subject"),
    arm: read("arm"),
    replicate: read("replicate"),
    degraded: read("degraded"),
    workspace: read("workspace"),
    prompt: read("prompt"),
    launcher: read("launcher"),
    model: read("model"),
    effort: read("effort"),
    copilotChatVersion: read("copilot_chat_version"),
    start: read("start_time_utc"),
    end: read("end_time_utc"),
    wall: read("wall_minutes"),
    tokens: read("tokens"),
    firstFinding: read("first_validated_finding_utc"),
  };
});
if (runs.length !== 24) throw new Error(`Expected 24 run rows; found ${runs.length}.`);

const extensionsRoot = join(controlRoot, "extensions");
mkdirSync(extensionsRoot, { recursive: true });
mkdirSync(join(controlRoot, "user-data"), { recursive: true });
mkdirSync(join(controlRoot, "copilot-home"), { recursive: true });
rmSync(join(controlRoot, "gitconfig"), { force: true });

const runDirectories = runs.map((run) => run.workspace);
for (const run of runs) {
  const workspace = run.workspace;
  if (!existsSync(join(workspace, "workloads"))) throw new Error(`Missing run workspace: ${workspace}`);
  const userData = join(controlRoot, "user-data", run.runId);
  const copilotHome = join(controlRoot, "copilot-home", run.runId);
  mkdirSync(userData, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });
  const workspaceSettings = join(workspace, ".vscode/settings.json");
  if (existsSync(workspaceSettings)) rmSync(workspaceSettings, { force: true });
  const settingsPath = join(userData, "User/settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const siblings = runDirectories.filter((path) => path !== workspace);
  writeFileSync(settingsPath, `${JSON.stringify(makeSettings(siblings), null, 2)}\n`);

  for (const workloadRoot of readdirSync(join(workspace, "workloads"), { withFileTypes: true })) {
    if (!workloadRoot.isDirectory()) continue;
    const subjectCopy = join(workspace, "workloads", workloadRoot.name, "subject");
    rmSync(join(subjectCopy, ".vscode"), { recursive: true, force: true });
    if (!existsSync(join(subjectCopy, ".git"))) throw new Error(`Missing baseline Git repo for ${run.runId}/${workloadRoot.name}`);
  }

  const launcher = [
    "#!/bin/sh",
    "set -eu",
    `export COPILOT_HOME=${shellQuote(copilotHome)}`,
    "export GIT_CONFIG_GLOBAL=/dev/null",
    "export GIT_CONFIG_NOSYSTEM=1",
    "unset OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GH_TOKEN GITHUB_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN COPILOT_GITHUB_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN GOOGLE_APPLICATION_CREDENTIALS AZURE_CLIENT_SECRET NPM_TOKEN NODE_AUTH_TOKEN",
    `exec ${shellQuote(vscodeCli)} --user-data-dir ${shellQuote(userData)} --extensions-dir ${shellQuote(extensionsRoot)} --new-window ${shellQuote(workspace)}`,
    "",
  ].join("\n");
  writeFileSync(run.launcher, launcher);
  chmodSync(run.launcher, 0o755);
  run.userData = userData;
}

const header = ["sequence", "run_id", "subject", "arm", "replicate", "degraded", "workspace", "user_data_dir", "prompt", "launcher", "model", "effort", "copilot_chat_version", "start_time_utc", "end_time_utc", "wall_minutes", "tokens", "first_validated_finding_utc"];
const output = [header.map(csvCell).join(",")];
for (const run of runs) {
  output.push([
    run.sequence,
    run.runId,
    run.subject,
    run.arm,
    run.replicate,
    run.degraded,
    run.workspace,
    run.userData,
    run.prompt,
    run.launcher,
    run.model,
    run.effort,
    run.copilotChatVersion,
    run.start,
    run.end,
    run.wall,
    run.tokens,
    run.firstFinding,
  ].map(csvCell).join(","));
}
writeFileSync(mapPath, `${output.join("\n")}\n`);

const setup = `# Isolated Copilot Runs\n\n${runs.length} sessions are prepared. Each launcher uses a unique VS Code user-data directory and Copilot home; only the Copilot extension files are shared read-only. The run map and prompts are outside all workspaces and denied to the sandbox.\n\n## One-Time Extension Setup\n\nInstall Copilot Chat into the campaign extension directory before the runs:\n\n\`\`\`sh\n${shellQuote(vscodeCli)} --user-data-dir ${shellQuote(join(controlRoot, "extension-setup-data"))} --extensions-dir ${shellQuote(extensionsRoot)} --install-extension GitHub.copilot-chat\n\`\`\`\n\nDo not use that setup user-data directory for a scored session. Each run starts a separate VS Code instance and may require a separate Copilot sign-in.\n\n## Run Procedure\n\n1. Follow \`run-map.csv\` in sequence. Run the row's launcher; it opens only that run's workspace with its private user-data directory.\n2. Start a new independent Copilot Agent Host session. Never fork, create a peer/side chat, or attach another workspace. Choose the same model and effort for every run.\n3. Paste the run's prompt file. The P/E/H prompts use the same skeleton and differ only in the material description.\n4. Disable web, browser, MCP, external-repository, and unrelated tools. Check **/sandbox policy**; do not proceed if sandboxing is inactive or can fall back to unsandboxed commands.\n5. Before the first scored run, inspect **Developer: Show Chat Debug View** and confirm no unexpected conversation, context, or tools appear.\n6. Use the same budget for each run. Record start/end UTC, wall time, token usage, and first validated finding time in the run map.\n\n## Isolation\n\n- Every run has a fresh pinned source copy per workload, no subject Git history, and one initial baseline commit.\n- Each copy receives only the selected P, E, or H bundle under \`perf-input/\`.\n- Repository instructions, MCP settings, prior run state, credentials, and CrankTS source are excluded or sandbox-denied.\n- \`codegraphchat-v2\` is marked degraded; its current workload is not repository indexing/query and is below five seconds. Exclude it from the gate score.\n`;
const setupWithRecordedConfiguration = setup
  .replace(
    "Each run starts a separate VS Code instance and may require a separate Copilot sign-in.",
    "Each run starts a separate VS Code instance and may require a separate Copilot sign-in. Extension auto-updates are disabled; record the Copilot Chat version in the run map.",
  )
  .replace(
    "Choose the same model and effort for every run.",
    "Choose the same model and effort for every run and record both in the run map.",
  );
writeFileSync(join(controlRoot, "COPILOT-SETUP.md"), setupWithRecordedConfiguration);

console.log(`Refreshed ${runs.length} run launchers, workspace sandbox settings, and run-map.csv.`);