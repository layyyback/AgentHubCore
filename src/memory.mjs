import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getRole } from "./roles.mjs";
import { loadPrivatePatterns, matchingRules, rulesFor } from "./private-rules.mjs";

// Role memory lives in the hub, so it follows the role into every project and never into a project's git.
export const MEMORY_IGNORE = "agents/*/memory.md";
const ENTRY = /^- (\d{4}-\d{2}-\d{2}) · from (\S+) · (?:project (.+?)|all projects): (.*)$/;

export const memoryPath = (hub, role) => join(resolve(hub), "agents", role, "memory.md");

async function read(path) { try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }

function today(now) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function parseMemory(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.match(ENTRY)).filter(Boolean)
    .map(([, date, from, project, text]) => ({ date, from, project: project ?? null, text }));
}

// Returns { status: "recorded" | "already" | "refused", path, rules?, notes }.
export const CONFIRM_HINT = "pass --confirmed only after the user has explicitly approved this exact line in a later reply; never in the same turn you proposed it";

// A project given as a path is recorded by its directory name only, so no absolute path ever enters memory.
export function projectId(project) {
  if (project == null) return null;
  const value = String(project).trim();
  return /[\\/]/.test(value) ? value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : value;
}

export async function addMemory({ hub, role: roleId, text, project: projectArg = null, from = "user", confirmed = false, now = new Date(), env = process.env }) {
  const root = resolve(hub);
  const role = await getRole(root, roleId);
  const entry = String(text ?? "").trim();
  if (!entry) throw new Error("--text is required");
  if (/[\r\n]/.test(entry)) throw new Error("--text must be one line");
  const project = projectId(projectArg);
  if (project != null && (!project || /[\r\n:]/.test(project))) throw new Error("--project must be a short id without newlines or colons");
  // A speed bump, not a lock: the flag makes recording a separate, deliberate step after the user's approval.
  if (!confirmed) throw new Error(`hub memory add needs --confirmed: ${CONFIRM_HINT}`);
  const source = from === "user" ? "user" : String(from).slice(0, 8);
  const line = `- ${today(now)} · from ${source} · ${project ? `project ${project}` : "all projects"}: ${entry}`;

  const { patterns } = await loadPrivatePatterns(root, env);
  const refused = [...new Set(matchingRules(line, { rules: rulesFor(patterns) }))];
  const path = memoryPath(root, role.id);
  if (refused.length) return { status: "refused", path, rules: refused, notes: [] };

  const notes = [];
  const ignorePath = join(root, ".gitignore");
  const ignore = await read(ignorePath);
  if (!(ignore || "").split(/\r?\n/).some((item) => item.trim() === MEMORY_IGNORE)) {
    await writeFile(ignorePath, `${ignore ? `${ignore.trimEnd()}\n` : ""}${MEMORY_IGNORE}\n`);
    notes.push(`added ${MEMORY_IGNORE} to ${ignorePath} so memory stays out of git`);
  }
  const existing = await read(path);
  if (parseMemory(existing).some((item) => item.text === entry)) return { status: "already", path, notes };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`);
  return { status: "recorded", path, notes };
}

export async function listMemory({ hub, role: roleId }) {
  const role = await getRole(resolve(hub), roleId);
  const path = memoryPath(hub, role.id);
  const text = await read(path);
  return { path, text: text || "", entries: parseMemory(text) };
}
