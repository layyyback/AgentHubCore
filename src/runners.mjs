import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildChildEnv } from "./env.mjs";

export function buildClaudeArgs(run, prompt) {
  return ["-p", ...(run.native_session_id ? ["--resume", run.native_session_id] : []), ...(run.model ? ["--model", run.model] : []), "--output-format", "stream-json", "--verbose", ...(run.extra_writable.length ? ["--add-dir", ...run.extra_writable] : []), "--", prompt];
}

export function buildCodexArgs(run, prompt, outputFile) {
  const shared = ["--json", ...(run.model ? ["--model", run.model] : []), ...(run.extra_writable.length ? ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(run.extra_writable)}`] : []), "--skip-git-repo-check", "--output-last-message", outputFile, prompt];
  return run.native_session_id ? ["exec", "resume", run.native_session_id, ...shared] : ["exec", ...shared];
}

function addRunnerError(result, message) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return;
  result.errors ||= [];
  if (!result.errors.includes(text)) result.errors.push(text);
}

export function parseRunnerEvent(runner, event, result) {
  if (runner === "claude-code") {
    if (typeof event.session_id === "string") result.nativeSessionId ||= event.session_id;
    if (event.type === "result" && event.is_error) addRunnerError(result, (typeof event.result === "string" && event.result) || `${event.subtype || "error"}`);
    else if (event.type === "result" && typeof event.result === "string") result.final = event.result;
  } else {
    if (event.type === "thread.started" && typeof event.thread_id === "string") result.nativeSessionId ||= event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") result.final = event.item.text;
    if (event.type === "error") addRunnerError(result, event.message);
    if (event.type === "turn.failed") addRunnerError(result, event.error?.message);
  }
}

// Runner error events carry the real cause (usage limit, auth, max turns); stderr is often just CLI chatter.
export function describeRunnerError(result) {
  const events = result.errors || [];
  const stderr = (result.stderr || "").trim();
  if (!events.length) return stderr || null;
  return stderr ? `${events.join("\n")}\n\n[stderr]\n${stderr}` : events.join("\n");
}

export async function executeRunner(run, prompt, onSpawn = () => {}) {
  const finalFile = join(dirname(run.log), "final.txt");
  await mkdir(dirname(run.log), { recursive: true });
  const executable = run.runner === "claude-code" ? (process.env.HUB_CLAUDE_BIN || "claude") : (process.env.HUB_CODEX_BIN || "codex");
  const args = run.runner === "claude-code" ? buildClaudeArgs(run, prompt) : buildCodexArgs(run, prompt, finalFile);
  const log = createWriteStream(run.log, { flags: "a" });
  const result = { nativeSessionId: run.native_session_id || null, final: null, stderr: "", exitCode: null };
  const child = spawn(executable, args, { cwd: run.cwd, env: buildChildEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
  // Attach every listener before the first await: a runner that exits while onSpawn is still writing would
  // otherwise have its unread output drained and its close/error events emitted with nobody listening.
  const finished = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  finished.catch(() => {});
  let remainder = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    log.write(chunk);
    const lines = `${remainder}${chunk}`.split(/\r?\n/);
    remainder = lines.pop() || "";
    for (const line of lines) { try { parseRunnerEvent(run.runner, JSON.parse(line), result); } catch {} }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { result.stderr += chunk; log.write(`[stderr] ${chunk}`); });
  try { await onSpawn(child); } catch (error) { child.kill("SIGTERM"); log.end(); throw error; }
  try { result.exitCode = await finished; } finally { log.end(); }
  if (remainder) { try { parseRunnerEvent(run.runner, JSON.parse(remainder), result); } catch {} }
  if (!result.final && run.runner === "codex-cli") { try { result.final = (await readFile(finalFile, "utf8")).trim(); } catch {} }
  if (result.final) await writeFile(finalFile, `${result.final.trim()}\n`);
  return result;
}
