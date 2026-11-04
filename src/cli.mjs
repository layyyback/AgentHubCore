import { resolve } from "node:path";
import { buildRoles } from "./roles.mjs";
import { checkInstall, install, planInstall } from "./install.mjs";
import { findHub, initHub } from "./init.mjs";
import { collectBoard, formatBoard } from "./board.mjs";
import { listWorktrees, pruneWorktrees } from "./worktree.mjs";
import { DEFAULT_WAIT_SECONDS, formatWait, waitRuns } from "./wait.mjs";
import { addMemory, listMemory } from "./memory.mjs";
import { cancelRun, createRun, worker } from "./run.mjs";
import { listRuns, readRun } from "./store.mjs";

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "-h") { flags.help = true; continue; }
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const key = value.slice(2);
    if (["create", "force", "json", "worktree", "all", "help", "confirmed"].includes(key)) flags[key] = true;
    else { if (i + 1 >= argv.length) throw new Error(`missing value for --${key}`); flags[key] = argv[++i]; }
  }
  return { positional, flags };
}

const requireFlag = (flags, name) => { if (!flags[name]) throw new Error(`--${name} is required`); return flags[name]; };
// --hub may be left out inside a hub (its root or any directory below it).
async function requireHub(flags) {
  if (flags.hub) return flags.hub;
  const found = await findHub(process.cwd());
  if (!found) throw new Error("--hub is required (no hub found in this directory or its parents)");
  return found;
}
const print = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
const CLAUDE_HINT = "hand-edited CLAUDE.md is no longer generated; Claude skips AGENTS.md beside it, so merge it by hand";
const printPreserved = (items) => { for (const item of items) print(`preserve ${item.rel} (${item.reason})`); };

function usage() {
  return `AgentHub Core\n\nUsage:\n  hub init --hub <hub>\n  hub roles build --hub <hub>\n  hub install --hub <hub> --project <project> [--roles a,b] [--create] [--force]\n  hub check --project <project>\n  hub diff --hub <hub> --project <project> [--roles a,b] [--create]\n  hub run --hub <hub> --project <project> --role <id> (--task <task> | --task-file <path>) [--worktree | --worktree-of <run>]\n  hub status --hub <hub> [run]\n  hub report --hub <hub> <run>\n  hub resume --hub <hub> <run> (--task <task> | --task-file <path>)\n  hub cancel --hub <hub> <run>\n  hub wait --hub <hub> <run> [<run> ...] [--timeout <seconds>] [--json]   (exit 0 all completed, 1 some failed or canceled, 2 still running)\n  hub memory add --hub <hub> --role <role> --text "<one line>" --confirmed [--project <name>] [--from user|<run>]   (add --confirmed only after the user explicitly approved this line in a later reply; exit 3 = refused by privacy rules)\n  hub memory list --hub <hub> --role <role> [--json]\n  hub board --hub <hub> [--hours <n> | --all] [--json]\n  hub worktree list --hub <hub> [--json]\n  hub worktree prune --hub <hub> [--run <id>] [--force]`;
}

function summary(run) {
  return { id: run.id, status: run.status, project: run.project, role: run.role, runner: run.runner, native_session_id: run.native_session_id, created_at: run.created_at, started_at: run.started_at, finished_at: run.finished_at };
}

function formatReport(run) {
  const changes = run.changes || { added: [], modified: [], deleted: [], preexisting_dirty: [], errors: ["change collection has not completed"] };
  const section = (name, values) => `## ${name}\n${values.length ? values.map((item) => `- ${item}`).join("\n") : "- (none)"}`;
  return `# Run ${run.id}\n\n- Status: ${run.status}\n- Project: ${run.project}\n- Role: ${run.role}\n- Runner: ${run.runner}\n- Worktree: ${run.worktree ? `${run.worktree.path} (branch ${run.worktree.branch})` : "(none)"}\n- Native session: ${run.native_session_id || "(not captured)"}\n- Exit code: ${run.exit_code ?? "(running)"}\n- Log: ${run.log}\n\n## Final answer\n${run.final || "(none)"}\n\n${section("Added", changes.added)}\n\n${section("Modified", changes.modified)}\n\n${section("Deleted", changes.deleted)}\n\n${section("Pre-existing dirty, untouched", changes.preexisting_dirty)}\n\n${section("Collection errors", changes.errors)}${run.error ? `\n\n## Runner error\n${run.error}` : ""}`;
}

export async function main(argv) {
  const { positional, flags } = parse(argv);
  const [command, subcommand] = positional;
  if (!command || command === "help" || flags.help) { print(usage()); return; }
  if (command === "init") {
    const result = await initHub({ hub: requireFlag(flags, "hub") });
    print(result.operations.length ? result.operations.map((item) => `${item.type} ${item.rel}`).join("\n") : "already up to date (zero writes)");
    printPreserved(result.preserved.map((path) => ({ rel: path, reason: CLAUDE_HINT }))); return;
  }
  if (command === "roles" && subcommand === "build") {
    const result = await buildRoles(await requireHub(flags));
    print(result.changes.length ? result.changes.map((item) => `${item.type} ${item.path}`).join("\n") : "roles already up to date");
    printPreserved(result.preserved.map((path) => ({ rel: path, reason: CLAUDE_HINT }))); return;
  }
  if (command === "install") {
    const result = await install({ hub: await requireHub(flags), project: requireFlag(flags, "project"), roles: flags.roles, create: flags.create, force: flags.force });
    print(result.operations.length ? result.operations.map((item) => `${item.type} ${item.rel}`).join("\n") : "already up to date (zero writes)");
    printPreserved(result.preserved);
    print("note: role memory lives in the hub (agents/<role>/memory.md, not in git). If this project keeps its own agents/<role>/memory.md, decide whether it belongs in git."); return;
  }
  if (command === "diff") {
    const result = await planInstall({ hub: await requireHub(flags), project: requireFlag(flags, "project"), roles: flags.roles, create: flags.create, force: flags.force });
    print(result.operations.length ? result.operations.map((item) => `${item.type} ${item.rel}`).join("\n") : "no changes");
    printPreserved(result.preserved); return;
  }
  if (command === "check") {
    const rows = await checkInstall({ project: requireFlag(flags, "project") });
    for (const row of rows) print(`${row.status.padEnd(8)} ${row.path}`);
    if (rows.some((row) => row.status !== "ok")) process.exitCode = 1;
    return;
  }
  if (command === "run") {
    const run = await createRun({ hub: await requireHub(flags), project: requireFlag(flags, "project"), role: requireFlag(flags, "role"), task: flags.task, taskFile: flags["task-file"], worktree: flags.worktree, worktreeOf: flags["worktree-of"] });
    for (const warning of run.warnings) console.error(`hub: warning: ${warning}`);
    print(run.id); return;
  }
  if (command === "resume") {
    const id = subcommand || requireFlag(flags, "run");
    const hub = await requireHub(flags);
    const old = await readRun(hub, id);
    const run = await createRun({ hub, project: old.project, role: old.role, task: flags.task, taskFile: flags["task-file"], resume: id });
    for (const warning of run.warnings) console.error(`hub: warning: ${warning}`);
    print(run.id); return;
  }
  if (command === "status") {
    const hub = await requireHub(flags);
    const value = subcommand ? [await readRun(hub, subcommand)] : await listRuns(hub);
    print(flags.json ? value.map(summary) : value.map((run) => `${run.id}\t${run.status}\t${run.role}\t${run.runner}\t${run.native_session_id || "-"}`).join("\n")); return;
  }
  if (command === "report") { print(formatReport(await readRun(await requireHub(flags), subcommand || requireFlag(flags, "run")))); return; }
  if (command === "cancel") {
    const result = await cancelRun(await requireHub(flags), subcommand || requireFlag(flags, "run"));
    print(result.signaled ? "cancel signal sent" : `run is ${result.run.status}`); return;
  }
  if (command === "memory" && subcommand === "add") {
    const result = await addMemory({ hub: await requireHub(flags), role: requireFlag(flags, "role"), text: flags.text, project: flags.project ?? null, from: flags.from || "user", confirmed: Boolean(flags.confirmed) });
    for (const note of result.notes) console.error(`hub: ${note}`);
    if (result.status === "refused") { console.error(`hub: memory entry refused by privacy rules: ${result.rules.join(", ")}; reword it without that information`); process.exitCode = 3; return; }
    print(result.status === "already" ? `already recorded in ${result.path}` : `recorded in ${result.path} (not in git)`); return;
  }
  if (command === "memory" && subcommand === "list") {
    const result = await listMemory({ hub: await requireHub(flags), role: requireFlag(flags, "role") });
    print(flags.json ? result.entries : result.text.trimEnd() || `no memory yet for this role (${result.path})`); return;
  }
  if (command === "wait") {
    const timeout = flags.timeout == null ? DEFAULT_WAIT_SECONDS : Number(flags.timeout);
    if (!(timeout >= 0)) throw new Error("--timeout must be a number of seconds");
    const result = await waitRuns(await requireHub(flags), positional.slice(1), { timeout });
    print(flags.json ? { runs: result.rows, summary: result.summary } : formatWait(result));
    process.exitCode = result.exitCode; return;
  }
  if (command === "board") {
    const hours = flags.hours == null ? 24 : Number(flags.hours);
    if (!(hours > 0)) throw new Error("--hours must be a positive number");
    const rows = await collectBoard(await requireHub(flags), { hours, all: flags.all });
    print(flags.json ? rows : formatBoard(rows, { hours, all: flags.all })); return;
  }
  if (command === "worktree" && subcommand === "list") {
    const rows = await listWorktrees(await requireHub(flags));
    print(flags.json ? rows : rows.length ? rows.map((row) => `${row.exists ? "present" : "removed"}\t${row.branch}\t${row.path}\t${row.runs.map((run) => `${run.id}:${run.status}`).join(",")}`).join("\n") : "no worktrees recorded"); return;
  }
  if (command === "worktree" && subcommand === "prune") {
    const results = await pruneWorktrees(await requireHub(flags), { run: flags.run, force: flags.force });
    print(results.length ? results.map((item) => `${item.outcome} ${item.path}${item.reason ? ` (${item.reason})` : ` (branch ${item.branch} kept)`}`).join("\n") : "nothing to prune");
    if (results.some((item) => item.outcome !== "removed")) process.exitCode = 1;
    return;
  }
  if (command === "__worker") { await worker(requireFlag(flags, "hub"), requireFlag(flags, "run")); return; }
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}
