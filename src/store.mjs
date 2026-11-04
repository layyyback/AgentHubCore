import { mkdir, readFile, rename, writeFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function stateRoot(hub) { return join(resolve(hub), ".agenthub", "runs"); }
export function runPath(hub, id) { return join(stateRoot(hub), `${id}.json`); }

export async function readRun(hub, id) {
  try { return JSON.parse(await readFile(runPath(hub, id), "utf8")); }
  catch (error) { if (error.code === "ENOENT") throw new Error(`run not found: ${id}`); throw error; }
}

export async function writeRun(hub, run) {
  const path = runPath(hub, run.id);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`);
  await rename(temporary, path);
  await syncIndex(hub);
}

export async function addRun(hub, run) {
  await writeRun(hub, run);
}

async function syncIndex(hub) {
  const root = stateRoot(hub);
  const lock = join(root, ".index.lock");
  for (let attempt = 0; ; attempt += 1) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST" || attempt > 500) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    const names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
    const records = [];
    for (const name of names) {
      const run = JSON.parse(await readFile(join(root, name), "utf8"));
      records.push({ id: run.id, project: run.project, role: run.role, runner: run.runner, native_session_id: run.native_session_id, status: run.status, created_at: run.created_at, started_at: run.started_at, finished_at: run.finished_at, log: run.log });
    }
    const path = join(root, "runs.jsonl");
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, records.map((item) => JSON.stringify(item)).join("\n") + (records.length ? "\n" : ""));
    await rename(temporary, path);
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function listRuns(hub) {
  let names = [];
  try { names = await readdir(stateRoot(hub)); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const runs = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readRun(hub, name.slice(0, -5))));
  return runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
