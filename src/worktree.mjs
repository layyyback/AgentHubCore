import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { listRuns } from "./store.mjs";

const execFileAsync = promisify(execFile);
const ACTIVE = new Set(["queued", "running", "canceling"]);
const git = (cwd, args) => execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
const exists = (path) => access(path).then(() => true, () => false);

// Same layout as the private hub: <project-parent>/<project-name>-wt/<run-id> on branch hub/<run-id>.
export function worktreeLocation(projectRoot, runId) {
  return { path: join(dirname(projectRoot), `${basename(projectRoot)}-wt`, runId), branch: `hub/${runId}` };
}

export async function createWorktree(projectRoot, runId) {
  let top;
  try { top = (await git(projectRoot, ["rev-parse", "--show-toplevel"])).stdout.trim(); }
  catch { throw new Error("--worktree requires a git project"); }
  if ((await realpath(top)) !== (await realpath(projectRoot))) throw new Error("--worktree requires --project to be the git repository root");
  try { await git(projectRoot, ["rev-parse", "--verify", "HEAD"]); }
  catch { throw new Error("--worktree requires a git project with at least one commit"); }
  const location = worktreeLocation(projectRoot, runId);
  await git(projectRoot, ["worktree", "add", "-q", "-b", location.branch, location.path, "HEAD"]);
  return location;
}

// A worktree is checked out from HEAD, so a role card that is missing from HEAD or differs from it is not what the run will read.
export async function roleCardCommitted(projectRoot, roleId) {
  const rel = `agents/${roleId}/AGENTS.md`;
  try {
    await git(projectRoot, ["cat-file", "-e", `HEAD:${rel}`]);
    await git(projectRoot, ["diff", "--quiet", "HEAD", "--", rel]);
    return true;
  } catch { return false; }
}

export async function assertWorktreeExists(worktree) {
  if (!(await exists(worktree.path))) throw new Error(`parent worktree no longer exists (pruned?): ${worktree.path}`);
}

// One entry per worktree path; resumed runs share their parent's worktree.
export async function listWorktrees(hub) {
  const groups = new Map();
  for (const run of (await listRuns(hub)).slice().reverse()) {
    if (!run.worktree?.path) continue;
    const entry = groups.get(run.worktree.path) || { path: run.worktree.path, branch: run.worktree.branch, project: run.project, runs: [] };
    entry.runs.push({ id: run.id, status: run.status });
    groups.set(run.worktree.path, entry);
  }
  const rows = [];
  for (const entry of groups.values()) rows.push({ ...entry, exists: await exists(entry.path), active: entry.runs.some((run) => ACTIVE.has(run.status)) });
  return rows;
}

export async function pruneWorktrees(hub, { run: runId = null, force = false } = {}) {
  let rows = (await listWorktrees(hub)).filter((row) => row.exists);
  if (runId) {
    rows = rows.filter((row) => row.runs.some((run) => run.id === runId));
    if (!rows.length) throw new Error(`run ${runId} has no existing worktree`);
  }
  const results = [];
  for (const row of rows) {
    if (row.active) { results.push({ path: row.path, branch: row.branch, outcome: "skipped", reason: "a run is still active" }); continue; }
    try {
      await git(row.project, ["worktree", "remove", ...(force ? ["--force"] : []), row.path]);
      results.push({ path: row.path, branch: row.branch, outcome: "removed" });
    } catch (error) {
      const reason = /modified or untracked|is dirty|contains modified/i.test(String(error.stderr)) ? "has uncommitted changes; commit them or use --force" : String(error.stderr || error.message).trim();
      results.push({ path: row.path, branch: row.branch, outcome: "refused", reason });
    }
  }
  return results;
}
