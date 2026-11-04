import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRole, buildRoles } from "./roles.mjs";
import { captureSnapshot, diffSnapshots } from "./snapshot.mjs";
import { addRun, listRuns, readRun, writeRun } from "./store.mjs";
import { assertWorktreeExists, createWorktree, roleCardCommitted } from "./worktree.mjs";
import { describeRunnerError, executeRunner } from "./runners.mjs";

const cliPath = fileURLToPath(new URL("../bin/hub.mjs", import.meta.url));
const now = () => new Date().toISOString();

export const DISCIPLINE = [
  "Working discipline:",
  "- Take real exit codes: redirect output to a file and read the command's own exit status; never read `$?` after piping into `tail` or another command.",
  "- Each time you finish a piece of work, write its evidence into a file right away; do not save it all for the end.",
  "- If you could not do something, say plainly that it was not done; never describe it as handled."
].join("\n");

// Where the role does its work: the run's worktree when it has one, otherwise the project itself.
export const workRoot = (run) => run.worktree?.path || run.project;

const ACTIVE = ["queued", "running", "canceling"];
// Runs created before 0.3.0 have no hub field; their log lives at <hub>/.agenthub/runs/<id>/runner.log.
export const hubOf = (run) => run.hub || resolve(dirname(run.log), "..", "..", "..");

export function buildPrompt(run) {
  const root = workRoot(run);
  const hubMemory = join(hubOf(run), "agents", run.role, "memory.md");
  const local = (name) => run.workspace === "home" ? join(root, "agents", run.role, name) : `agents/${run.role}/${name}`;
  const card = run.workspace === "home" ? "AGENTS.md in your working directory" : `agents/${run.role}/AGENTS.md`;
  const reading = [
    `Read and obey your role card at ${card}.`,
    `Read ${hubMemory} if it exists: these are rules the user confirmed for your role across projects; follow them, and the role card wins on conflict.`,
    `If ${local("PROJECT.md")} exists, read it next: it holds this project's requirements for your role and overrides nothing in the role card except where it narrows scope.`,
    `If ${local("memory.md")} exists, read it too: project-level rules for your role.`
  ].join("\n");
  const where = run.worktree ? `Project: ${root}\n(This is an isolated git worktree of ${run.project} on branch ${run.worktree.branch}; work only here, the user merges the branch.)` : `Project: ${root}`;
  const memory = "If you learn something that should hold next time, end your final answer with a section \"## Memory proposals\" listing one rule per line. Do not edit any memory.md yourself.";
  return `${reading}\n\n${where}\nTask:\n${run.task}\n\n${memory}\n\n${DISCIPLINE}`;
}

export async function resolveTask({ task, taskFile }) {
  if (task && taskFile) throw new Error("use either --task or --task-file, not both");
  if (taskFile) {
    const path = resolve(taskFile);
    const text = (await readFile(path, "utf8")).trim();
    if (!text) throw new Error(`task file is empty: ${path}`);
    return { task: text, taskFile: path };
  }
  if (!task) throw new Error("--task or --task-file is required");
  return { task, taskFile: null };
}

export async function createRun({ hub, project, role: roleId, task: inlineTask, taskFile: taskPath = null, resume = null, worktree: wantWorktree = false, worktreeOf = null }) {
  if (!project) throw new Error("--project is required");
  const { task, taskFile } = await resolveTask({ task: inlineTask, taskFile: taskPath });
  const hubRoot = resolve(hub);
  const projectRoot = resolve(project);
  await buildRoles(hubRoot);
  const role = await getRole(hubRoot, roleId);
  if (role.kind === "entry") throw new Error(`${role.id}: entry roles are not dispatchable; open a session in the hub root instead`);
  const parent = resume ? await readRun(hubRoot, resume) : null;
  if (parent && (parent.role !== role.id || parent.runner !== role.runner)) throw new Error("resume must use the original role and runner");
  // Resuming before the parent has finished (or without a captured session) would silently start a new conversation.
  if (parent && ACTIVE.includes(parent.status)) throw new Error(`run ${parent.id} is still ${parent.status}; wait until it finishes before resuming`);
  if (parent && !parent.native_session_id) throw new Error(`run ${parent.id} has no native session to resume; start a new run instead`);
  if (wantWorktree && worktreeOf) throw new Error("use either --worktree or --worktree-of, not both");
  const source = worktreeOf ? await readRun(hubRoot, worktreeOf) : null;
  if (source) {
    if (!source.worktree) throw new Error(`run ${source.id} has no worktree`);
    if (source.project !== projectRoot) throw new Error(`run ${source.id} belongs to another project: ${source.project}`);
    // Runs that share a worktree are serial: no other run may still be working in it.
    const busy = (await listRuns(hubRoot)).find((item) => item.worktree?.path === source.worktree.path && ACTIVE.includes(item.status));
    if (busy) throw new Error(`run ${busy.id} is still ${busy.status}; runs sharing a worktree are serial`);
    await assertWorktreeExists(source.worktree);
  }
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const runDir = join(hubRoot, ".agenthub", "runs", id);
  const warnings = [];
  let worktree = null;
  if (parent?.worktree) { await assertWorktreeExists(parent.worktree); worktree = parent.worktree; }
  else if (source) {
    worktree = source.worktree;
    if (role.workspace === "project" && !(await roleCardCommitted(worktree.path, role.id))) warnings.push(`agents/${role.id}/AGENTS.md is not committed on ${worktree.branch}; commit the installed role card on the main branch before creating worktrees`);
  }
  else if (wantWorktree && !parent) {
    worktree = await createWorktree(projectRoot, id);
    if (role.workspace === "project" && !(await roleCardCommitted(projectRoot, role.id))) warnings.push(`agents/${role.id}/AGENTS.md is not committed (or differs from HEAD); the worktree has only committed files, so commit the installed role card first`);
  }
  if (!worktree) {
    const busy = (await listRuns(hubRoot)).filter((item) => item.project === projectRoot && !item.worktree && ACTIVE.includes(item.status));
    if (busy.length) warnings.push(`run ${busy.map((item) => item.id).join(", ")} is still active in this project without --worktree; both runs may overwrite each other's files`);
  }
  const root = worktree?.path || projectRoot;
  const cwd = role.workspace === "home" ? join(hubRoot, "agents", role.id) : root;
  const extraWritable = role.workspace === "home" ? [root] : [join(root, "agents", role.id)];
  const run = {
    schema: 1, id, parent_run_id: parent?.id || null, hub: hubRoot, project: projectRoot, role: role.id,
    runner: role.runner, model: role.model || null, workspace: role.workspace, cwd,
    extra_writable: extraWritable, native_session_id: parent?.native_session_id || null,
    worktree, worktree_from: source?.id || null, task, task_file: taskFile, status: "queued", created_at: now(), started_at: null, finished_at: null,
    pid: null, worker_pid: null, exit_code: null, error: null, final: null, changes: null,
    log: join(runDir, "runner.log")
  };
  await mkdir(runDir, { recursive: true });
  await addRun(hubRoot, run);
  const child = spawn(process.execPath, [cliPath, "__worker", "--hub", hubRoot, "--run", id], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  run.worker_pid = child.pid;
  await writeRun(hubRoot, run);
  return { ...run, warnings };
}

export async function worker(hub, id) {
  let run = await readRun(hub, id);
  try {
    run.status = "running"; run.started_at = now(); await writeRun(hub, run);
    const before = await captureSnapshot(workRoot(run));
    const prompt = buildPrompt(run);
    const result = await executeRunner(run, prompt, async (child) => { run.pid = child.pid; await writeRun(hub, run); });
    const after = await captureSnapshot(workRoot(run));
    run = await readRun(hub, id);
    run.native_session_id = result.nativeSessionId;
    run.exit_code = result.exitCode;
    run.final = result.final;
    run.error = describeRunnerError(result);
    run.changes = diffSnapshots(before, after);
    run.status = result.exitCode === 0 ? "completed" : run.status === "canceling" ? "canceled" : "failed";
  } catch (error) {
    run = await readRun(hub, id);
    run.status = run.status === "canceling" ? "canceled" : "failed";
    run.error = error.stack || error.message;
  }
  run.finished_at = now();
  await writeRun(hub, run);
}

export async function cancelRun(hub, id) {
  const run = await readRun(hub, id);
  if (!["queued", "running", "canceling"].includes(run.status)) return { run, signaled: false };
  run.status = "canceling";
  await writeRun(hub, run);
  let signaled = false;
  const target = run.pid || run.worker_pid;
  if (target) {
    try { process.kill(target, "SIGTERM"); signaled = true; } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  if (run.worker_pid && !run.pid) { run.status = "canceled"; run.finished_at = now(); await writeRun(hub, run); }
  return { run, signaled };
}
