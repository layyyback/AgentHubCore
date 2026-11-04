import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRoles } from "../src/roles.mjs";
import { install } from "../src/install.mjs";
import { createRun } from "../src/run.mjs";
import { readRun } from "../src/store.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function wait(hub, id, timeout = 10 * 60 * 1000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const run = await readRun(hub, id);
    if (["completed", "failed", "canceled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`timeout: ${id}`);
}
async function smoke(role, filename) {
  const temp = await mkdtemp(join(tmpdir(), `agenthub-smoke-${role}-`));
  const hub = join(temp, "hub"), project = join(temp, "project");
  await mkdir(hub); await mkdir(project);
  await cp(join(root, "roles"), join(hub, "roles"), { recursive: true });
  await cp(join(root, "skill"), join(hub, "skill"), { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "# Smoke project\n");
  await buildRoles(hub); await install({ hub, project });
  const started = Date.now();
  const first = await wait(hub, (await createRun({ hub, project, role, task: `Create ${filename} in the project with exactly one line: smoke ok` })).id);
  if (first.status !== "completed" || !first.native_session_id) throw new Error(`${role} first run ${first.status}: ${first.error || "no native session"}`);
  const resumed = await wait(hub, (await createRun({ hub, project, role, task: `Read ${filename} and reply with its exact content. Do not edit files.`, resume: first.id })).id);
  return { role, runner: first.runner, first_exit: first.exit_code, resume_exit: resumed.exit_code, elapsed_ms: Date.now() - started, first_session: first.native_session_id.slice(0, 8), resumed_session: resumed.native_session_id?.slice(0, 8), same_session: first.native_session_id === resumed.native_session_id, project };
}

const results = [];
for (const [role, filename] of [["pm", "pm-smoke.md"], ["dev", "dev-smoke.md"]]) {
  try { results.push(await smoke(role, filename)); }
  catch (error) { results.push({ role, error: error.message }); }
}
console.log(JSON.stringify(results, null, 2));
if (results.some((item) => item.error || !item.same_session || item.first_exit !== 0 || item.resume_exit !== 0)) process.exitCode = 1;
