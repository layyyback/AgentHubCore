import { open } from "node:fs/promises";
import { basename } from "node:path";
import { listRuns } from "./store.mjs";

const ACTIVE = new Set(["queued", "running", "canceling"]);
const TAIL_BYTES = 64 * 1024;

// Only event types and tool names are shown, never prompt or answer text.
export function describeEvent(runner, event) {
  if (!event || typeof event !== "object") return null;
  if (runner === "claude-code") {
    if (event.type === "assistant") {
      const tool = (event.message?.content || []).find((item) => item?.type === "tool_use");
      return tool ? `tool_use ${tool.name || "?"}` : "assistant";
    }
    if (event.type === "user") return "tool_result";
    if (event.type === "result") return event.is_error ? `result error ${event.subtype || ""}`.trim() : "result";
    return event.type ? String(event.type) : null;
  }
  if (event.type === "item.completed" || event.type === "item.started") return `${event.type} ${event.item?.type || "?"}`;
  return event.type ? String(event.type) : null;
}

export async function lastAction(run) {
  let handle;
  try { handle = await open(run.log, "r"); } catch { return null; }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      const action = describeEvent(run.runner, event);
      if (action) return action.slice(0, 60);
    }
    return null;
  } finally { await handle.close(); }
}

export function elapsed(run, now = Date.now()) {
  const start = Date.parse(run.started_at || run.created_at);
  if (Number.isNaN(start)) return "-";
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}m` : m ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export async function collectBoard(hub, { hours = 24, all = false, now = Date.now() } = {}) {
  const since = now - hours * 3600 * 1000;
  const latest = (run) => Math.max(...[run.created_at, run.started_at, run.finished_at].map((value) => Date.parse(value || "")).filter((value) => !Number.isNaN(value)));
  const runs = (await listRuns(hub)).filter((run) => all || ACTIVE.has(run.status) || latest(run) >= since);
  const rows = [];
  for (const run of runs) {
    rows.push({
      id: run.id, project: basename(run.project), role: run.role, runner: run.runner, status: run.status,
      elapsed: elapsed(run, now), last_action: await lastAction(run), resumed: Boolean(run.parent_run_id),
      worktree: run.worktree?.branch || null, created_at: run.created_at
    });
  }
  rows.sort((a, b) => a.project.localeCompare(b.project) || b.created_at.localeCompare(a.created_at));
  return rows;
}

export function formatBoard(rows, { hours = 24, all = false } = {}) {
  const active = rows.filter((row) => ACTIVE.has(row.status)).length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const window = all ? "in total" : `in the last ${hours}h`;
  const head = `${active} active, ${rows.length - active} finished ${window}, ${failed ? `${failed} failed: read hub report for the step the user must take` : "nothing failed"}.`;
  if (!rows.length) return `${head}\n(no runs ${window})`;
  const table = [["RUN", "PROJECT", "ROLE", "RUNNER", "STATUS", "ELAPSED", "LAST ACTION", "FROM"]];
  for (const row of rows) table.push([row.id, row.project, row.role, row.runner, row.status, row.elapsed, row.last_action || "-", [row.resumed ? "resume" : "new", row.worktree].filter(Boolean).join(" ")]);
  const widths = table[0].map((_, column) => Math.max(...table.map((line) => line[column].length)));
  return `${head}\n\n${table.map((line) => line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()).join("\n")}`;
}
