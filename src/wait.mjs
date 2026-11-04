import { elapsed } from "./board.mjs";
import { readRun } from "./store.mjs";

export const TERMINAL = new Set(["completed", "failed", "canceled"]);
// Short enough that one call returns inside the command timeouts of Claude Code and Codex; call again on exit 2.
export const DEFAULT_WAIT_SECONDS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitRuns(hub, ids, { timeout = DEFAULT_WAIT_SECONDS, interval = 1000 } = {}) {
  if (!ids.length) throw new Error("hub wait needs at least one run id");
  const unique = [...new Set(ids)];
  let runs = await Promise.all(unique.map((id) => readRun(hub, id)));
  const deadline = Date.now() + timeout * 1000;
  while (runs.some((run) => !TERMINAL.has(run.status)) && Date.now() < deadline) {
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    runs = await Promise.all(unique.map((id) => readRun(hub, id)));
  }
  const count = (status) => runs.filter((run) => run.status === status).length;
  const summary = { completed: count("completed"), failed: count("failed"), canceled: count("canceled"), running: runs.filter((run) => !TERMINAL.has(run.status)).length };
  const exitCode = summary.running ? 2 : summary.failed || summary.canceled ? 1 : 0;
  const rows = runs.map((run) => ({ id: run.id, status: run.status, exit_code: run.exit_code ?? null, elapsed: elapsed(run), role: run.role, branch: run.worktree?.branch || null }));
  return { rows, summary, exitCode };
}

export function formatWait({ rows, summary }) {
  const lines = rows.map((row) => [row.id, row.status, row.exit_code ?? "-", row.elapsed, row.role, row.branch || "-"].join("\t"));
  lines.push(`${summary.completed} completed, ${summary.failed} failed, ${summary.canceled} canceled, ${summary.running} still running`);
  return lines.join("\n");
}
