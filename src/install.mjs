import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { buildRoles } from "./roles.mjs";

export const BEGIN = "<!-- BEGIN AGENTHUB CORE -->";
export const END = "<!-- END AGENTHUB CORE -->";
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function read(path) { try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function readJson(path) { const value = await read(path); return value ? JSON.parse(value) : null; }

export const SKELETON = "# Project instructions\n\n- Start work by reading `docs/`.\n- Write new project decisions back into this project's `docs/`; do not leave them only in chat history.\n- Change product code only in this project or in its isolated working copy.\n";
export const RETIRE_HINT = "Claude does not read AGENTS.md in a directory that has CLAUDE.md; merge it into AGENTS.md by hand";

function projectBlock(hubRoot) {
  return `${BEGIN}\n## AgentHub Core collaboration\n\n- Hub: \`${hubRoot}\`\n- Project roles: \`agents/<role>/AGENTS.md\`; this project's requirements for a role go in \`agents/<role>/PROJECT.md\` (project-owned, optional).\n- Dispatch: \`hub run --hub "${hubRoot}" --project . --role <role> --task "..."\` (or \`--task-file <path>\`)\n- Follow up with \`hub status\`, \`hub report <run>\`, \`hub resume <run> --task "..."\`, or \`hub cancel <run>\`.\n- Before acting as a dispatched role, read its project role card. Role identity comes from that card; this file contains shared project facts.\n- For GM-level coordination across roles, start a session in the hub root; it works under the GM card.\n${END}`;
}

export function mergeBlock(original, block, { begin, end, base, label }) {
  const text = original ?? base;
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if ((start >= 0) !== (finish >= 0) || (start >= 0 && finish < start)) throw new Error(`${label} has a malformed AgentHub block`);
  if (start < 0) return `${text.trimEnd()}\n\n${block}\n`;
  return `${text.slice(0, start)}${block}${text.slice(finish + end.length)}`;
}

export function mergeAgentBlock(original, block, create = false) {
  if (original == null && !create) throw new Error("AGENTS.md is missing; pass --create to create a project skeleton");
  return mergeBlock(original, block, { begin: BEGIN, end: END, base: SKELETON, label: "AGENTS.md" });
}

function blockHash(content) {
  const start = content?.indexOf(BEGIN) ?? -1;
  const finish = content?.indexOf(END) ?? -1;
  return start >= 0 && finish >= start ? sha(content.slice(start, finish + END.length)) : null;
}

function desiredEntries({ hubRoot, projectRoot, roles, skill }) {
  const entries = new Map();
  entries.set(".agenthub/project.json", `${JSON.stringify({ schema: 1, project: projectRoot, hub: hubRoot }, null, 2)}\n`);
  for (const role of roles) entries.set(`agents/${role.id}/AGENTS.md`, role.rendered);
  entries.set(".agents/skills/agenthub/SKILL.md", skill);
  return entries;
}

export function selectRoles(all, wanted) {
  const dispatchable = all.filter((role) => role.kind !== "entry");
  if (!wanted) return dispatchable;
  const ids = (Array.isArray(wanted) ? wanted : String(wanted).split(",")).map((id) => id.trim()).filter(Boolean);
  if (!ids.length) throw new Error("--roles needs at least one role id");
  return ids.map((id) => {
    const role = all.find((item) => item.id === id);
    if (!role) throw new Error(`unknown role: ${id}; available: ${dispatchable.map((item) => item.id).join(", ")}`);
    if (role.kind === "entry") throw new Error(`${id} is an entry role and is not installed into projects`);
    return role;
  });
}

export async function planInstall({ hub, project, create = false, force = false, roles: wanted = null }) {
  const hubRoot = resolve(hub);
  const projectRoot = resolve(project);
  const roles = selectRoles((await buildRoles(hubRoot, { write: false })).roles, wanted);
  const skillPath = join(hubRoot, "skill", "SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  const lockPath = join(projectRoot, ".agenthub", "install.lock.json");
  const oldLock = await readJson(lockPath) || { files: {} };
  const operations = [];
  const conflicts = [];
  const preserved = [];
  const desired = desiredEntries({ hubRoot, projectRoot, roles, skill });

  const agentsPath = join(projectRoot, "AGENTS.md");
  const oldAgents = await read(agentsPath);
  const agents = mergeAgentBlock(oldAgents, projectBlock(hubRoot), create);
  desired.set("AGENTS.md", agents);

  // Files this installer used to write but no longer plans: untouched ones are removed, edited ones are left and untracked.
  for (const [rel, prior] of Object.entries(oldLock.files || {})) {
    if (desired.has(rel) || prior.mode !== "file") continue;
    const path = join(projectRoot, rel);
    const old = await read(path);
    if (old == null) continue;
    if (sha(old) === prior.sha256) operations.push({ type: "delete", rel, path });
    else preserved.push({ rel, reason: "edited since install; no longer tracked" });
  }
  const claudePath = join(projectRoot, "CLAUDE.md");
  const oldClaude = await read(claudePath);
  if (oldClaude != null && !operations.some((item) => item.rel === "CLAUDE.md")) {
    if (oldClaude.trim() === "@AGENTS.md") operations.push({ type: "delete", rel: "CLAUDE.md", path: claudePath });
    else if (!preserved.some((item) => item.rel === "CLAUDE.md")) preserved.push({ rel: "CLAUDE.md", reason: RETIRE_HINT });
  }

  for (const [rel, content] of desired) {
    const path = join(projectRoot, rel);
    const old = rel === "AGENTS.md" ? oldAgents : await read(path);
    const prior = oldLock.files?.[rel];
    const actualHash = rel === "AGENTS.md" ? blockHash(old) : old == null ? null : sha(old);
    if (prior && actualHash !== prior.sha256 && old !== content) conflicts.push(rel);
    if (old !== content) operations.push({ type: old == null ? "create" : "update", rel, path, content });
  }

  const linkRel = ".claude/skills/agenthub";
  const linkPath = join(projectRoot, linkRel);
  const linkTarget = relative(dirname(linkPath), join(projectRoot, ".agents/skills/agenthub"));
  let oldLink = null;
  try { oldLink = (await lstat(linkPath)).isSymbolicLink() ? await readlink(linkPath) : "<not-a-symlink>"; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const priorLink = oldLock.files?.[linkRel];
  if (oldLink != null && oldLink !== linkTarget && (!priorLink || oldLink !== priorLink.target)) conflicts.push(linkRel);
  if (oldLink !== linkTarget) operations.push({ type: oldLink == null ? "symlink" : "update-symlink", rel: linkRel, path: linkPath, target: linkTarget });

  const files = {};
  for (const [rel, content] of desired) files[rel] = { sha256: rel === "AGENTS.md" ? blockHash(content) : sha(content), mode: rel === "AGENTS.md" ? "block" : "file" };
  files[linkRel] = { sha256: sha(linkTarget), mode: "symlink", target: linkTarget };
  const lock = `${JSON.stringify({ schema: 1, hub: hubRoot, project: projectRoot, files }, null, 2)}\n`;
  const oldLockText = await read(lockPath);
  if (oldLockText !== lock) operations.push({ type: oldLockText == null ? "create" : "update", rel: ".agenthub/install.lock.json", path: lockPath, content: lock, lock: true });
  if (conflicts.length && !force) throw new Error(`generated files were modified: ${[...new Set(conflicts)].join(", ")}; inspect with hub diff or use --force`);
  return { hubRoot, projectRoot, roles, operations, preserved };
}

export async function install(options) {
  await buildRoles(resolve(options.hub));
  const plan = await planInstall(options);
  for (const operation of plan.operations) {
    if (operation.type !== "delete") await mkdir(dirname(operation.path), { recursive: true });
    if (operation.type === "delete") {
      await rm(operation.path, { force: true });
      if (operation.rel.startsWith("agents/")) { try { await rmdir(dirname(operation.path)); } catch {} }
      continue;
    }
    if (operation.target) {
      try { await rename(operation.path, `${operation.path}.agenthub-replaced-${Date.now()}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await symlink(operation.target, operation.path);
    } else {
      const temporary = `${operation.path}.tmp-${process.pid}`;
      await writeFile(temporary, operation.content);
      await rename(temporary, operation.path);
    }
  }
  return plan;
}

export async function checkInstall({ project }) {
  const root = resolve(project);
  const lock = await readJson(join(root, ".agenthub/install.lock.json"));
  if (!lock) throw new Error("project is not installed: missing .agenthub/install.lock.json");
  const rows = [];
  for (const [rel, expected] of Object.entries(lock.files)) {
    const path = join(root, rel);
    if (expected.mode === "symlink") {
      try { rows.push({ path: rel, status: (await readlink(path)) === expected.target ? "ok" : "modified" }); }
      catch { rows.push({ path: rel, status: "missing" }); }
      continue;
    }
    const content = await read(path);
    const actual = expected.mode === "block" ? blockHash(content) : content == null ? null : sha(content);
    rows.push({ path: rel, status: content == null ? "missing" : actual === expected.sha256 ? "ok" : "modified" });
  }
  return rows;
}
