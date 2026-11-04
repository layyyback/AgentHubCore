#!/usr/bin/env node
// Measures how many runs this machine can carry at once: N `hub run --worktree` back to back, one `hub wait`,
// then numbers from the run records. Fake runner by default (no model calls); --real uses your local CLIs.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readRun } from "../src/store.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/hub.mjs", import.meta.url));
const NOTE = "Peak concurrency depends on this machine and your model quota; hub itself sets no limit.";

function parseArgs(argv) {
  const options = { n: 10, real: false, yes: false, role: "dev", json: false, keep: false, sleep: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--n") options.n = Number(argv[++i]);
    else if (arg === "--role") options.role = argv[++i];
    else if (arg === "--sleep") options.sleep = Number(argv[++i]);
    else if (arg === "--real") options.real = true;
    else if (arg === "--fake") options.real = false;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.n) || options.n < 1) throw new Error("--n must be a positive integer");
  if (!(options.sleep >= 0)) throw new Error("--sleep must be a number of seconds");
  return options;
}

// The fake runner works for --sleep seconds; make it longer than the dispatch time to keep all N alive at once.
const fakeRunner = (sleep) => `#!/bin/sh
mode=claude
[ "$1" = "exec" ] && mode=codex
sleep ${sleep}
mkdir -p notes && date > "notes/$(basename "$PWD").md"
if [ "$mode" = "claude" ]; then
  echo '{"type":"system","session_id":"00000000-0000-0000-0000-00000000c0de"}'
  echo '{"type":"result","session_id":"00000000-0000-0000-0000-00000000c0de","result":"note written"}'
else
  echo '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-00000000c0de"}'
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"note written"}}'
fi
`;

async function hub(args, env) {
  try { return { code: 0, stdout: (await run(process.execPath, [cli, ...args], { env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim() }; }
  catch (error) { return { code: typeof error.code === "number" ? error.code : 1, stdout: String(error.stdout || "").trim(), stderr: String(error.stderr || "").trim() }; }
}
const git = (cwd, ...args) => run("git", ["-c", "user.name=parallel-check", "-c", "user.email=parallel-check@example.invalid", ...args], { cwd });

function peak(intervals) {
  const events = intervals.flatMap(([start, end]) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0, best = 0;
  for (const [, delta] of events) { current += delta; best = Math.max(best, current); }
  return best;
}
const seconds = (ms) => Math.round(ms / 100) / 10;

export async function parallelCheck(options) {
  const root = await mkdtemp(join(tmpdir(), "hub-parallel-check-"));
  const hubDir = join(root, "hub"), project = join(root, "project");
  const env = { ...process.env };
  if (!options.real) {
    const fake = join(root, "fake-runner.sh");
    await writeFile(fake, fakeRunner(options.sleep)); await chmod(fake, 0o755);
    env.HUB_CLAUDE_BIN = fake; env.HUB_CODEX_BIN = fake;
  }
  try {
    for (const step of [["init", "--hub", hubDir]]) { const result = await hub(step, env); if (result.code) throw new Error(result.stderr); }
    await mkdir(project); await writeFile(join(project, "AGENTS.md"), "# parallel-check project\n");
    await git(project, "init", "-q");
    const installed = await hub(["install", "--hub", hubDir, "--project", project, "--roles", options.role], env);
    if (installed.code) throw new Error(installed.stderr);
    await git(project, "add", "-A"); await git(project, "commit", "-qm", "parallel-check base");

    const ids = [];
    const dispatchStart = Date.now();
    for (let i = 1; i <= options.n; i += 1) {
      const result = await hub(["run", "--hub", hubDir, "--project", project, "--role", options.role, "--worktree", "--task", `Write one line with the current time into notes/<this worktree's directory name>.md. Run ${i} of ${options.n}.`], env);
      if (result.code) throw new Error(`hub run ${i} failed: ${result.stderr}`);
      ids.push(result.stdout);
    }
    const dispatchSeconds = seconds(Date.now() - dispatchStart);
    const waitStart = Date.now();
    let waited;
    do { waited = await hub(["wait", "--hub", hubDir, ...ids, "--timeout", "100"], env); } while (waited.code === 2);
    const waitSeconds = seconds(Date.now() - waitStart);

    const runs = await Promise.all(ids.map((id) => readRun(hubDir, id)));
    const timed = runs.filter((item) => item.started_at && item.finished_at).map((item) => [Date.parse(item.started_at), Date.parse(item.finished_at)]);
    const durations = timed.map(([start, end]) => (end - start) / 1000).sort((a, b) => a - b);
    const worktreesCreated = runs.filter((item) => item.worktree && existsSync(item.worktree.path)).length;
    if (!options.keep) await hub(["worktree", "prune", "--hub", hubDir, "--force"], env);
    const worktreesRemaining = runs.filter((item) => item.worktree && existsSync(item.worktree.path)).length;
    return {
      runner: options.real ? "real" : `fake (${options.sleep} s per run)`, role: options.role, n: options.n,
      dispatch_seconds: dispatchSeconds, wait_seconds: waitSeconds, peak_concurrency: peak(timed),
      elapsed_min: durations.length ? seconds(durations[0] * 1000) : null,
      elapsed_median: durations.length ? seconds(durations[Math.floor(durations.length / 2)] * 1000) : null,
      elapsed_max: durations.length ? seconds(durations.at(-1) * 1000) : null,
      completed: runs.filter((item) => item.status === "completed").length,
      failed: runs.filter((item) => item.status !== "completed").length,
      failures: runs.filter((item) => item.status !== "completed").map((item) => ({ run: item.id, status: item.status, error: String(item.error || "").split("\n")[0].slice(0, 200) })),
      worktrees_created: worktreesCreated, worktrees_remaining: worktreesRemaining, note: NOTE
    };
  } finally {
    if (!options.keep) await rm(root, { recursive: true, force: true });
  }
}

function format(result) {
  const lines = [
    `runner: ${result.runner} (role ${result.role})`,
    `runs: ${result.n}`,
    `dispatched all in: ${result.dispatch_seconds} s`,
    `waited for all in: ${result.wait_seconds} s`,
    `peak concurrency: ${result.peak_concurrency}`,
    `run time min / median / max: ${result.elapsed_min} / ${result.elapsed_median} / ${result.elapsed_max} s`,
    `completed: ${result.completed}, failed: ${result.failed}`,
    `worktrees created: ${result.worktrees_created}, left after cleanup: ${result.worktrees_remaining}`,
    ...result.failures.map((item) => `  ${item.run} ${item.status}: ${item.error}`),
    result.note
  ];
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`parallel-check: ${error.message}`); process.exit(1); }
  if (options.help) {
    console.log("npm run parallel-check -- [--n <N>] [--fake [--sleep <s>] | --real --yes] [--role <id>] [--json] [--keep]\nDefault: --fake --n 10 --sleep 2 (no model calls).");
  } else if (options.real && !options.yes) {
    console.error(`parallel-check: --real starts ${options.n} runs on your local Claude Code / Codex CLI: ${options.n} model calls that may cost money and hit rate limits. Add --yes to go ahead.`);
    process.exitCode = 1;
  } else {
    parallelCheck(options).then((result) => {
      console.log(options.json ? JSON.stringify(result, null, 2) : format(result));
      if (result.failed) process.exitCode = 1;
    }, (error) => { console.error(`parallel-check: ${error.message}`); process.exitCode = 1; });
  }
}
