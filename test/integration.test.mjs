import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readRun } from "../src/store.mjs";

const cli = fileURLToPath(new URL("../bin/hub.mjs", import.meta.url));
async function command(args, env = {}) {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (v) => stdout += v); child.stderr.on("data", (v) => stderr += v);
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code) throw new Error(`command failed (${code}): ${stderr}`);
  return stdout.trim();
}
async function waitRun(hub, id, statuses = ["completed", "failed", "canceled"], timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const run = await readRun(hub, id); if (statuses.includes(run.status)) return run; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`timed out waiting for ${id}`);
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hub-integration-")); const hub = join(root, "hub"), project = join(root, "project"), marker = join(root, "times.log"), fake = join(root, "fake-runner.sh");
  await mkdir(join(hub, "roles"), { recursive: true }); await mkdir(join(hub, "skill"), { recursive: true }); await mkdir(project);
  await writeFile(join(hub, "roles", "dev.md"), "---\nid: dev\nname: Dev\ndescription: Test developer\nrunner: codex-cli\nworkspace: project\n---\n\n# Dev\n");
  await writeFile(join(hub, "roles", "pm.md"), "---\nid: pm\nname: PM\ndescription: Test PM\nrunner: claude-code\nworkspace: home\n---\n\n# PM\n");
  await writeFile(join(hub, "skill/SKILL.md"), "# Dispatch\n"); await writeFile(join(project, "AGENTS.md"), "# Project\n");
  await writeFile(fake, `#!/bin/sh\nmode=claude\n[ "$1" = "exec" ] && mode=codex\nlast=""\nout=""\nprev=""\nfor arg in "$@"; do\n  [ "$prev" = "--output-last-message" ] && out="$arg"\n  prev="$arg"\n  last="$arg"\ndone\necho "start $$ $(date +%s%N)" >> "$HUB_TEST_MARKER"\ncase "$last" in *long*) sleep 5;; *parallel*) sleep 1;; esac\nif [ "$mode" = "claude" ]; then\n  echo '{"type":"system","session_id":"11111111-1111-1111-1111-111111111111"}'\n  echo '{"type":"result","session_id":"11111111-1111-1111-1111-111111111111","result":"fake claude done"}'\nelse\n  echo '{"type":"thread.started","thread_id":"22222222-2222-2222-2222-222222222222"}'\n  echo '{"type":"item.completed","item":{"type":"agent_message","text":"fake codex done"}}'\n  [ -n "$out" ] && printf 'fake codex done\\n' > "$out"\nfi\necho "end $$ $(date +%s%N)" >> "$HUB_TEST_MARKER"\n`);
  await chmod(fake, 0o755);
  const env = { HUB_CLAUDE_BIN: fake, HUB_CODEX_BIN: fake, HUB_TEST_MARKER: marker };
  return { root, hub, project, marker, env };
}

test("fake runners cover install, run, status, report, resume, cancel, and overlap", async () => {
  const { hub, project, marker, env } = await setup();
  await command(["install", "--hub", hub, "--project", project], env);
  const firstId = await command(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "finish"], env);
  const first = await waitRun(hub, firstId); assert.equal(first.status, "completed"); assert.equal(first.native_session_id, "22222222-2222-2222-2222-222222222222");
  assert.match(await command(["status", "--hub", hub, firstId], env), /completed/); assert.match(await command(["report", "--hub", hub, firstId], env), /fake codex done/);
  const resumedId = await command(["resume", "--hub", hub, firstId, "--task", "follow up"], env);
  const resumed = await waitRun(hub, resumedId); assert.equal(resumed.native_session_id, first.native_session_id); assert.equal(resumed.parent_run_id, firstId);
  const longId = await command(["run", "--hub", hub, "--project", project, "--role", "pm", "--task", "long"], env);
  await waitRun(hub, longId, ["running"]);
  const early = await attempt(["resume", "--hub", hub, longId, "--task", "too soon"], env);
  assert.equal(early.code, 1); assert.match(early.stderr, /is still running; wait until it finishes/);
  await command(["cancel", "--hub", hub, longId], env); assert.equal((await waitRun(hub, longId)).status, "canceled");
  const noSession = await attempt(["resume", "--hub", hub, longId, "--task", "after cancel"], env);
  assert.equal(noSession.code, 1); assert.match(noSession.stderr, /has no native session to resume/);
  const a = await command(["run", "--hub", hub, "--project", project, "--role", "pm", "--task", "parallel A"], env);
  const b = await command(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "parallel B"], env);
  await Promise.all([waitRun(hub, a), waitRun(hub, b)]);
  const lines = (await readFile(marker, "utf8")).trim().split("\n").map((line) => line.split(" "));
  const starts = lines.filter(([kind]) => kind === "start").slice(-2).map(([, pid, time]) => ({ pid, time: BigInt(time) }));
  const ends = new Map(lines.filter(([kind]) => kind === "end").map(([, pid, time]) => [pid, BigInt(time)]));
  assert.ok(starts[0].time < ends.get(starts[1].pid) && starts[1].time < ends.get(starts[0].pid), "run intervals overlap");
});

test("report surfaces runner error events instead of stderr noise", async () => {
  const { root, hub, project, env } = await setup(); const failing = join(root, "failing-runner.sh");
  await writeFile(failing, `#!/bin/sh\nif [ "$1" = "exec" ]; then\n  echo 'Reading additional input from stdin...' >&2\n  echo '{"type":"thread.started","thread_id":"33333333-3333-3333-3333-333333333333"}'\n  echo '{"type":"error","message":"You have hit your usage limit."}'\n  echo '{"type":"turn.failed","error":{"message":"You have hit your usage limit."}}'\nelse\n  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"44444444-4444-4444-4444-444444444444","result":"Credit balance is too low"}'\nfi\nexit 1\n`);
  await chmod(failing, 0o755);
  const failEnv = { ...env, HUB_CLAUDE_BIN: failing, HUB_CODEX_BIN: failing };
  await command(["install", "--hub", hub, "--project", project], failEnv);
  const codexId = await command(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "fail"], failEnv);
  assert.equal((await waitRun(hub, codexId)).status, "failed");
  const codexReport = await command(["report", "--hub", hub, codexId], failEnv);
  assert.match(codexReport, /## Runner error\nYou have hit your usage limit\.\n\n\[stderr\]\nReading additional input from stdin\.\.\./);
  const claudeId = await command(["run", "--hub", hub, "--project", project, "--role", "pm", "--task", "fail"], failEnv);
  assert.equal((await waitRun(hub, claudeId)).status, "failed");
  assert.match(await command(["report", "--hub", hub, claudeId], failEnv), /## Runner error\nCredit balance is too low/);
});

async function attempt(args, env = {}) {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (v) => stdout += v); child.stderr.on("data", (v) => stderr += v);
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

test("hub init writes the GM entry block, repeats with zero writes, and keeps text outside the block", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-init-")); const hub = join(root, "hub");
  const first = await command(["init", "--hub", hub]);
  for (const rel of ["AGENTS.md", ".project-root", "roles/gm.md", "skill/SKILL.md", ".gitignore", "agents/gm/AGENTS.md", "agents/dev/AGENTS.md"]) assert.match(first, new RegExp(`create ${rel.replace(/[.*]/g, "\\$&")}`));
  assert.equal(await readFile(join(hub, ".project-root"), "utf8"), "");
  assert.match(await readFile(join(hub, ".gitignore"), "utf8"), /agents\/\*\/memory\.md/);
  assert.match(await readFile(join(hub, "AGENTS.md"), "utf8"), /read `agents\/gm\/AGENTS\.md` first/);
  assert.equal(await command(["init", "--hub", hub]), "already up to date (zero writes)");
  const edited = (await readFile(join(hub, "AGENTS.md"), "utf8")).replace("# Hub\n", "# My hub\n\nOwner notes stay.\n") + "\nTrailing notes stay.\n";
  await writeFile(join(hub, "AGENTS.md"), edited);
  assert.equal(await command(["init", "--hub", hub]), "already up to date (zero writes)");
  assert.equal(await readFile(join(hub, "AGENTS.md"), "utf8"), edited);
  const rejected = await attempt(["run", "--hub", hub, "--project", root, "--role", "gm", "--task", "x"]);
  assert.equal(rejected.code, 1); assert.match(rejected.stderr, /entry roles are not dispatchable/);
});

test("task files dispatch through the fake runner and report shows the worktree line", async () => {
  const { root, hub, project, env } = await setup();
  await command(["install", "--hub", hub, "--project", project], env);
  const taskFile = join(root, "task.md"); await writeFile(taskFile, "Ship the feature.\nAcceptance: tests pass.\n");
  const id = await command(["run", "--hub", hub, "--project", project, "--role", "dev", "--task-file", taskFile], env);
  const run = await waitRun(hub, id);
  assert.equal(run.status, "completed"); assert.equal(run.task, "Ship the feature.\nAcceptance: tests pass."); assert.equal(run.task_file, taskFile);
  assert.match(await command(["report", "--hub", hub, id], env), /- Worktree: \(none\)/);
  const both = await attempt(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "x", "--task-file", taskFile], env);
  assert.equal(both.code, 1); assert.match(both.stderr, /either --task or --task-file/);
  const resumed = await waitRun(hub, await command(["resume", "--hub", hub, id, "--task-file", taskFile], env));
  assert.equal(resumed.parent_run_id, id); assert.equal(resumed.task_file, taskFile);
});

const git = (cwd, ...args) => promisify(execFile)("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd }).then((out) => out.stdout.trim());
const present = (path) => access(path).then(() => true, () => false);

test("worktree runs isolate changes on hub/<run> and can be resumed and pruned", async () => {
  const { root, hub, project, env } = await setup();
  const writer = join(root, "writer-runner.sh");
  await writeFile(writer, `#!/bin/sh\necho "made in $(pwd)" > made-by-runner.txt\necho '{"type":"thread.started","thread_id":"55555555-5555-5555-5555-555555555555"}'\necho '{"type":"item.completed","item":{"type":"agent_message","text":"wrote file"}}'\n`);
  await chmod(writer, 0o755);
  const wenv = { ...env, HUB_CODEX_BIN: writer };
  const plain = await attempt(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "x", "--worktree"], wenv);
  assert.equal(plain.code, 1); assert.match(plain.stderr, /--worktree requires a git project/);
  await git(project, "init", "-q"); await command(["install", "--hub", hub, "--project", project], wenv);
  await git(project, "add", "AGENTS.md"); await git(project, "commit", "-qm", "only the project file");
  const uncommitted = await attempt(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "early", "--worktree"], wenv);
  assert.equal(uncommitted.code, 0); assert.match(uncommitted.stderr, /warning: agents\/dev\/AGENTS\.md is not committed/);
  await waitRun(hub, uncommitted.stdout.trim());
  await git(project, "add", "-A"); await git(project, "commit", "-qm", "base");
  const committed = await attempt(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "write", "--worktree"], wenv);
  assert.equal(committed.stderr, "", "no warning once the role card is committed");
  const id = committed.stdout.trim();
  const run = await waitRun(hub, id);
  const wt = join(root, "project-wt", id);
  assert.equal(run.status, "completed"); assert.deepEqual(run.worktree, { path: wt, branch: `hub/${id}` }); assert.equal(run.cwd, wt);
  assert.equal(await git(project, "status", "--porcelain"), "", "main working tree stays clean");
  assert.match(await readFile(join(wt, "made-by-runner.txt"), "utf8"), new RegExp(`project-wt/${id}`));
  assert.deepEqual(run.changes.added, ["made-by-runner.txt"]);
  assert.match(await git(project, "branch", "--list", `hub/${id}`), new RegExp(`hub/${id}`));
  assert.match(await command(["report", "--hub", hub, id], wenv), new RegExp(`- Worktree: .*project-wt/${id} \\(branch hub/${id}\\)`));
  const resumed = await waitRun(hub, await command(["resume", "--hub", hub, id, "--task", "again"], wenv));
  assert.deepEqual(resumed.worktree, run.worktree); assert.equal(resumed.cwd, wt);
  assert.match(await command(["worktree", "list", "--hub", hub], wenv), new RegExp(`^present\thub/${id}\t.*\t.*${id}:completed`, "m"));
  const refused = await attempt(["worktree", "prune", "--hub", hub, "--run", id], wenv);
  assert.equal(refused.code, 1); assert.match(refused.stdout, /refused .*uncommitted changes/); assert.equal(await present(wt), true);
  await git(wt, "add", "-A"); await git(wt, "commit", "-qm", "runner work");
  assert.match(await command(["worktree", "prune", "--hub", hub, "--run", id], wenv), /^removed .* \(branch hub\/.* kept\)$/);
  assert.equal(await present(wt), false);
  assert.match(await git(project, "log", "--oneline", `hub/${id}`), /runner work/);
  assert.equal(await git(project, "status", "--porcelain"), "");
  assert.match(await command(["worktree", "list", "--hub", hub], wenv), new RegExp(`^removed\thub/${id}\t`, "m"));
  const gone = await attempt(["resume", "--hub", hub, id, "--task", "more"], wenv);
  assert.equal(gone.code, 1); assert.match(gone.stderr, /parent worktree no longer exists/);
});

test("a second run in the same project without --worktree warns but still starts", async () => {
  const { hub, project, env } = await setup();
  await command(["install", "--hub", hub, "--project", project], env);
  const longId = await command(["run", "--hub", hub, "--project", project, "--role", "pm", "--task", "long"], env);
  await waitRun(hub, longId, ["running"]);
  const second = await attempt(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "quick"], env);
  assert.equal(second.code, 0); assert.match(second.stderr, new RegExp(`warning: run ${longId} is still active`));
  const board = await command(["board", "--hub", hub], env);
  assert.match(board, /^[12] active, /); assert.match(board, /LAST ACTION/); assert.doesNotMatch(board, /%/);
  await command(["cancel", "--hub", hub, longId], env); await waitRun(hub, longId); await waitRun(hub, second.stdout.trim());
});

test("runs keep the parent's GIT_CONFIG_* group so git works inside a worktree run", async () => {
  const { root, hub, project, env } = await setup();
  const gitRunner = join(root, "git-runner.sh");
  await writeFile(gitRunner, `#!/bin/sh\ngit log --oneline -1 > git-log.out 2> git-log.err\nrc=$?\necho '{"type":"thread.started","thread_id":"88888888-8888-8888-8888-888888888888"}'\necho "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"git-rc=$rc\\"}}"\n`);
  await chmod(gitRunner, 0o755);
  const genv = { ...env, HUB_CODEX_BIN: gitRunner, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.quotepath", GIT_CONFIG_VALUE_0: "false" };
  await git(project, "init", "-q"); await command(["install", "--hub", hub, "--project", project], genv);
  await git(project, "add", "-A"); await git(project, "commit", "-qm", "base");
  const id = await command(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "inspect history", "--worktree"], genv);
  const run = await waitRun(hub, id);
  assert.equal(run.status, "completed");
  assert.equal(run.final, "git-rc=0", `git inside the run failed: ${await readFile(join(run.cwd, "git-log.err"), "utf8").catch(() => "")}`);
  assert.match(await readFile(join(run.cwd, "git-log.out"), "utf8"), /base/);
});

test("--help and -h print usage and exit 0 for hub and for every command", async () => {
  for (const args of [["--help"], ["-h"], ["help"], ["run", "--help"], ["run", "-h"], ["worktree", "prune", "--help"], ["status", "--hub", "/nowhere", "--help"]]) {
    const result = await attempt(args);
    assert.equal(result.code, 0, `hub ${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /^AgentHub Core\n\nUsage:\n  hub init --hub <hub>/, `hub ${args.join(" ")}`);
  }
  const literal = await attempt(["run", "--task", "-h"]);
  assert.equal(literal.code, 1, "a flag value of -h is a value, not a help request"); assert.match(literal.stderr, /--hub is required/);
});

// One fake runner for the batch tests; the task text in the prompt selects the behaviour.
async function batchSetup() {
  const base = await setup();
  const runner = join(base.root, "batch-runner.sh");
  await writeFile(runner, `#!/bin/sh
mode=claude
[ "$1" = "exec" ] && mode=codex
last=""; out=""; prev=""
for arg in "$@"; do [ "$prev" = "--output-last-message" ] && out="$arg"; prev="$arg"; last="$arg"; done
answer="done"
case "$last" in
  *FANOUT*) echo "start $$ $(date +%s%N)" >> "$HUB_TEST_MARKER"; sleep 1; echo "made in $(basename "$PWD")" > "fanout-$(basename "$PWD").txt"; echo "end $$ $(date +%s%N)" >> "$HUB_TEST_MARKER";;
  *DEV-COMMIT*) echo "feature from dev" > feature.txt; git add feature.txt; git -c user.name=Test -c user.email=test@example.invalid commit -qm feature;;
  *QA-READ*) answer="qa saw: $(cat feature.txt)";;
  *LONG-TASK*) sleep 5;;
  *FAIL-ME*) echo '{"type":"thread.started","thread_id":"fail-0000"}'; echo '{"type":"error","message":"simulated failure"}'; exit 1;;
  *MEMORY-ECHO*) mem=$(printf '%s\\n' "$last" | sed -n 's/^Read \\(\\/.*\\/memory\\.md\\) if it exists.*/\\1/p' | head -1); if [ -f "$mem" ]; then answer=$(tr '\\n"\\\\' '|  ' < "$mem"); else answer="NO-MEMORY"; fi;;
esac
if [ "$mode" = "claude" ]; then
  echo '{"type":"system","session_id":"cccccccc-0000-0000-0000-000000000000"}'
  echo "{\\"type\\":\\"result\\",\\"session_id\\":\\"cccccccc-0000-0000-0000-000000000000\\",\\"result\\":\\"$answer\\"}"
else
  echo '{"type":"thread.started","thread_id":"dddddddd-0000-0000-0000-000000000000"}'
  echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"$answer\\"}}"
fi
`);
  await chmod(runner, 0o755);
  await writeFile(join(base.hub, "roles", "qa.md"), "---\nid: qa\nname: QA\ndescription: Test QA\nrunner: claude-code\nworkspace: project\n---\n\n# QA\n");
  const env = { ...base.env, HUB_CLAUDE_BIN: runner, HUB_CODEX_BIN: runner };
  return { ...base, env };
}
async function gitProject(project, hub, env) {
  await git(project, "init", "-q"); await command(["install", "--hub", hub, "--project", project], env);
  await git(project, "add", "-A"); await git(project, "commit", "-qm", "base");
}

test("fan-out: 8 worktree runs start back to back, really overlap, and are all collected by one hub wait", async () => {
  const { root, hub, project, marker, env } = await batchSetup();
  await gitProject(project, hub, env);
  const ids = [];
  for (let i = 0; i < 8; i += 1) ids.push(await command(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", `FANOUT ${i}`, "--worktree"], env));
  const waited = await attempt(["wait", "--hub", hub, ...ids, "--timeout", "60"], env);
  assert.equal(waited.code, 0, waited.stderr);
  const lines = waited.stdout.trim().split("\n");
  assert.equal(lines.filter((line) => line.split("\t")[1] === "completed").length, 8); assert.equal(lines.at(-1), "8 completed, 0 failed, 0 canceled, 0 still running");
  // Overlap evidence that holds on a loaded machine: at least two runner processes were alive at once, and the
  // eight together spanned less time than running them one after another (the sum of their own durations).
  const events = (await readFile(marker, "utf8")).trim().split("\n").map((line) => line.split(" "));
  const intervals = new Map();
  for (const [kind, pid, time] of events) intervals.set(pid, { ...intervals.get(pid), [kind]: Number(BigInt(time) / 1000000n) });
  const spans = [...intervals.values()];
  assert.equal(spans.length, 8); assert.ok(spans.every((item) => item.start != null && item.end != null));
  const points = spans.flatMap(({ start, end }) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let alive = 0, peak = 0; for (const [, delta] of points) { alive += delta; peak = Math.max(peak, alive); }
  assert.ok(peak >= 2, `at least two runners were alive at once (peak ${peak})`);
  const span = Math.max(...spans.map((item) => item.end)) - Math.min(...spans.map((item) => item.start));
  const serial = spans.reduce((sum, item) => sum + item.end - item.start, 0);
  assert.ok(span < serial, `the 8 runs spanned ${span} ms, less than the ${serial} ms they would need one after another`);
  assert.equal(await git(project, "status", "--porcelain"), "", "the main working tree stays clean");
  for (const id of ids) assert.match(await readFile(join(root, "project-wt", id, `fanout-${id}.txt`), "utf8"), new RegExp(id));
  assert.equal((await command(["worktree", "list", "--hub", hub], env)).split("\n").filter((line) => line.startsWith("present\t")).length, 8);
  assert.equal((await command(["worktree", "prune", "--hub", hub, "--force"], env)).split("\n").filter((line) => line.startsWith("removed ")).length, 8);
  for (const id of ids) assert.match(await git(project, "branch", "--list", `hub/${id}`), new RegExp(`hub/${id}`), "branches are kept");
});

test("relay: QA continues on the Dev run's worktree and branch with --worktree-of", async () => {
  const { hub, project, env } = await batchSetup();
  await gitProject(project, hub, env);
  const longDev = await command(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "LONG-TASK", "--worktree"], env);
  await waitRun(hub, longDev, ["running"]);
  const tooEarly = await attempt(["run", "--hub", hub, "--project", project, "--role", "qa", "--task", "QA-READ", "--worktree-of", longDev], env);
  assert.equal(tooEarly.code, 1); assert.match(tooEarly.stderr, new RegExp(`run ${longDev} is still running; runs sharing a worktree are serial`));
  await command(["cancel", "--hub", hub, longDev], env); await waitRun(hub, longDev);
  const dev = await command(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", "DEV-COMMIT", "--worktree"], env);
  assert.equal((await attempt(["wait", "--hub", hub, dev], env)).code, 0);
  const qaId = await command(["run", "--hub", hub, "--project", project, "--role", "qa", "--task", "QA-READ", "--worktree-of", dev], env);
  assert.equal((await attempt(["wait", "--hub", hub, qaId], env)).code, 0);
  const [devRun, qaRun] = [await readRun(hub, dev), await readRun(hub, qaId)];
  assert.deepEqual(qaRun.worktree, devRun.worktree); assert.equal(qaRun.worktree_from, dev); assert.equal(qaRun.cwd, devRun.cwd);
  assert.match(await command(["report", "--hub", hub, qaId], env), /qa saw: feature from dev/);
  assert.match(await command(["worktree", "list", "--hub", hub], env), new RegExp(`present\\thub/${dev}\\t[^\\n]*${dev}:completed,${qaId}:completed`));
  assert.match(await git(project, "log", "--oneline", `hub/${dev}`), /feature/);
});

test("mixed batch: hub wait exits 1 with a failed run, 2 on timeout, 1 after cancel", async () => {
  const { hub, project, env } = await batchSetup();
  await command(["install", "--hub", hub, "--project", project], env);
  const ids = [];
  for (const task of ["ok one", "ok two", "FAIL-ME"]) ids.push(await command(["run", "--hub", hub, "--project", project, "--role", "dev", "--task", task], env));
  const mixed = await attempt(["wait", "--hub", hub, ...ids, "--timeout", "30"], env);
  assert.equal(mixed.code, 1);
  assert.equal(mixed.stdout.split("\n").filter((line) => line.split("\t")[1] === "completed").length, 2);
  assert.match(mixed.stdout, new RegExp(`^${ids[2]}\\tfailed\\t1\\t`, "m")); assert.match(mixed.stdout, /2 completed, 1 failed, 0 canceled, 0 still running/);
  assert.match(await command(["report", "--hub", hub, ids[2]], env), /## Runner error\nsimulated failure/);
  const long = await command(["run", "--hub", hub, "--project", project, "--role", "pm", "--task", "LONG-TASK"], env);
  const pending = await attempt(["wait", "--hub", hub, long, "--timeout", "1"], env);
  assert.equal(pending.code, 2); assert.match(pending.stdout, new RegExp(`^${long}\\t(queued|running)\\t`, "m")); assert.match(pending.stdout, /0 completed, 0 failed, 0 canceled, 1 still running/);
  await command(["cancel", "--hub", hub, long], env);
  const canceled = await attempt(["wait", "--hub", hub, long, "--timeout", "10"], env);
  assert.equal(canceled.code, 1); assert.match(canceled.stdout, /0 completed, 0 failed, 1 canceled, 0 still running/);
});

test("memory recorded once in the hub reaches the same role in another project, in place and in a worktree", async () => {
  const { root, hub, project: projectA, env } = await batchSetup();
  const projectB = join(root, "project-b"); await mkdir(projectB); await writeFile(join(projectB, "AGENTS.md"), "# B\n");
  await gitProject(projectA, hub, env); await gitProject(projectB, hub, env);
  const ask = async (role, extra = []) => {
    const id = await command(["run", "--hub", hub, "--project", projectB, "--role", role, "--task", "MEMORY-ECHO", ...extra], env);
    assert.equal((await attempt(["wait", "--hub", hub, id, "--timeout", "30"], env)).code, 0);
    return (await readRun(hub, id)).final;
  };
  assert.equal(await ask("dev"), "NO-MEMORY");
  const rule = `RULE-${Date.now().toString(36)}`;
  assert.match(await command(["memory", "add", "--confirmed", "--hub", hub, "--role", "dev", "--text", rule, "--project", "a"], env), /recorded in .*agents\/dev\/memory\.md \(not in git\)/);
  assert.match(await ask("dev"), new RegExp(`project a: ${rule}`));
  assert.match(await ask("dev", ["--worktree"]), new RegExp(rule), "a worktree run reads hub memory by absolute path");
  const pmRule = `PM-RULE-${Date.now().toString(36)}`;
  await command(["memory", "add", "--confirmed", "--hub", hub, "--role", "pm", "--text", pmRule], env);
  const pmAnswer = await ask("pm");
  assert.match(pmAnswer, new RegExp(`all projects: ${pmRule}`)); assert.doesNotMatch(pmAnswer, new RegExp(rule), "each role reads its own memory");
  assert.equal(await git(projectB, "status", "--porcelain"), "", "memory never lands in the project");
  assert.match(await readFile(join(hub, ".gitignore"), "utf8"), /^agents\/\*\/memory\.md$/m);
});

test("hub memory CLI: exit 3 names the rule without echoing the text; list prints entries", async () => {
  const { hub, env } = await batchSetup();
  const address = "someone" + "@" + "mail-provider.com";
  const refused = await attempt(["memory", "add", "--confirmed", "--hub", hub, "--role", "dev", "--text", `write to ${address}`], env);
  assert.equal(refused.code, 3); assert.match(refused.stderr, /refused by privacy rules: email/); assert.equal(refused.stderr.includes(address), false);
  assert.match(await command(["memory", "list", "--hub", hub, "--role", "dev"], env), /^no memory yet for this role/);
  await command(["memory", "add", "--confirmed", "--hub", hub, "--role", "pm", "--text", "Show me the plan before dispatching."], env);
  assert.equal(JSON.parse(await command(["memory", "list", "--hub", hub, "--role", "pm", "--json"], env))[0].text, "Show me the plan before dispatching.");
  assert.equal((await attempt(["memory", "add", "--confirmed", "--hub", hub, "--role", "dev"], env)).code, 1);
});

test("npm run parallel-check --fake --n 4 reports 4 completed, real overlap, and cleans up", async () => {
  const script = fileURLToPath(new URL("../scripts/parallel-check.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "--fake", "--n", "4", "--sleep", "2", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (v) => stdout += v); child.stderr.on("data", (v) => stderr += v);
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.n, 4); assert.equal(result.completed, 4); assert.equal(result.failed, 0);
  assert.ok(result.peak_concurrency >= 2, `peak ${result.peak_concurrency}`);
  assert.equal(result.worktrees_created, 4); assert.equal(result.worktrees_remaining, 0);
  assert.match(result.note, /hub itself sets no limit/);
  const refused = spawn(process.execPath, [script, "--real", "--n", "2"], { stdio: ["ignore", "pipe", "pipe"] });
  let refusal = ""; refused.stderr.on("data", (v) => refusal += v);
  assert.equal(await new Promise((resolve) => refused.on("close", resolve)), 1); assert.match(refusal, /Add --yes to go ahead/);
});

test("hub memory add without --confirmed exits 1 and writes nothing", async () => {
  const { hub, env } = await batchSetup();
  const result = await attempt(["memory", "add", "--hub", hub, "--role", "dev", "--text", "Proposed but not approved."], env);
  assert.equal(result.code, 1); assert.match(result.stderr, /needs --confirmed/);
  assert.match(await command(["memory", "list", "--hub", hub, "--role", "dev"], env), /^no memory yet for this role/);
});

test("inside a hub, --hub can be left out of every hub command; outside, it is still required", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-auto-")); const hub = join(root, "hub"), project = join(root, "project");
  await command(["init", "--hub", hub]);
  await mkdir(project); await writeFile(join(project, "AGENTS.md"), "# P\n");
  const fake = join(root, "fake.sh");
  await writeFile(fake, `#!/bin/sh\necho '{"type":"thread.started","thread_id":"eeeeeeee-0000-0000-0000-000000000000"}'\necho '{"type":"item.completed","item":{"type":"agent_message","text":"auto done"}}'\necho '{"type":"system","session_id":"eeeeeeee-0000-0000-0000-000000000000"}'\necho '{"type":"result","session_id":"eeeeeeee-0000-0000-0000-000000000000","result":"auto done"}'\n`);
  await chmod(fake, 0o755);
  const env = { HUB_CLAUDE_BIN: fake, HUB_CODEX_BIN: fake };
  const inHub = (args, cwd = hub) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (v) => stdout += v); child.stderr.on("data", (v) => stderr += v);
    child.on("close", (code) => resolveRun({ code, stdout: stdout.trim(), stderr }));
  });
  assert.equal((await inHub(["install", "--project", project])).code, 0);
  const memory = await inHub(["memory", "add", "--confirmed", "--role", "dev", "--text", "Found the hub by itself."], join(hub, "agents", "dev"));
  assert.equal(memory.code, 0, memory.stderr); assert.match(memory.stdout, /recorded in .*agents\/dev\/memory\.md/);
  const run = await inHub(["run", "--project", project, "--role", "dev", "--task", "auto"]);
  assert.equal(run.code, 0, run.stderr);
  const waited = await inHub(["wait", run.stdout, "--timeout", "30"]);
  assert.equal(waited.code, 0, waited.stderr);
  for (const args of [["status", run.stdout], ["report", run.stdout], ["board"], ["worktree", "list"], ["memory", "list", "--role", "dev"]]) {
    const result = await inHub(args);
    assert.equal(result.code, 0, `hub ${args.join(" ")}: ${result.stderr}`);
  }
  assert.match((await inHub(["report", run.stdout])).stdout, /auto done/);
  const outside = await inHub(["board"], root);
  assert.equal(outside.code, 1); assert.match(outside.stderr, /--hub is required \(no hub found in this directory or its parents\)/);
});
