import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRoles } from "./roles.mjs";
import { mergeBlock } from "./install.mjs";

export const ENTRY_BEGIN = "<!-- BEGIN AGENTHUB CORE ENTRY -->";
export const ENTRY_END = "<!-- END AGENTHUB CORE ENTRY -->";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const GITIGNORE_LINES = [".agenthub/", "agents/*/memory.md"];

export function entryBlock() {
  return `${ENTRY_BEGIN}\n## Hub entry\n\n- A session started exactly in this directory with no bound role is the **GM**: read \`agents/gm/AGENTS.md\` first and work under that card. Read \`agents/gm/memory.md\` if present.\n- Sessions started in \`agents/<role>/\` or inside a project are not the GM; their identity comes from the nearest role card, their rules from the project's AGENTS.md.\n- Shared rules live in \`roles/*.md\`; run \`hub roles build\` after editing. Never hand-edit \`agents/*/AGENTS.md\`.\n${ENTRY_END}`;
}

async function read(path) { try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function list(dir) { try { return await readdir(dir); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }

// Plans every write before touching disk so a second run reports zero writes.
export async function planInit({ hub }) {
  const root = resolve(hub);
  const writes = [];
  const agents = await read(join(root, "AGENTS.md"));
  const merged = mergeBlock(agents, entryBlock(), { begin: ENTRY_BEGIN, end: ENTRY_END, base: "# Hub\n", label: "hub AGENTS.md" });
  if (merged !== agents) writes.push({ rel: "AGENTS.md", path: join(root, "AGENTS.md"), content: merged, type: agents == null ? "create" : "update" });
  if ((await read(join(root, ".project-root"))) == null) writes.push({ rel: ".project-root", path: join(root, ".project-root"), content: "", type: "create" });

  // Seed roles and the skill only when the hub has none, so deliberate removals stay removed.
  if (!(await list(join(root, "roles"))).some((name) => name.endsWith(".md"))) {
    for (const name of (await list(join(packageRoot, "roles"))).filter((item) => item.endsWith(".md")).sort()) {
      writes.push({ rel: `roles/${name}`, path: join(root, "roles", name), content: await readFile(join(packageRoot, "roles", name), "utf8"), type: "create" });
    }
  }
  if ((await read(join(root, "skill", "SKILL.md"))) == null) {
    writes.push({ rel: "skill/SKILL.md", path: join(root, "skill", "SKILL.md"), content: await readFile(join(packageRoot, "skill", "SKILL.md"), "utf8"), type: "create" });
  }

  const ignore = await read(join(root, ".gitignore"));
  const present = new Set((ignore || "").split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length) writes.push({ rel: ".gitignore", path: join(root, ".gitignore"), content: `${ignore ? `${ignore.trimEnd()}\n` : ""}${missing.join("\n")}\n`, type: ignore == null ? "create" : "update" });
  return { root, writes };
}

export async function initHub({ hub }) {
  const plan = await planInit({ hub });
  for (const write of plan.writes) {
    await mkdir(dirname(write.path), { recursive: true });
    await writeFile(write.path, write.content);
  }
  const built = await buildRoles(plan.root);
  const operations = [
    ...plan.writes.map((item) => ({ type: item.type, rel: item.rel })),
    ...built.changes.map((item) => ({ type: item.type, rel: item.path.slice(plan.root.length + 1) }))
  ];
  return { root: plan.root, operations, preserved: built.preserved };
}

// The hub marker is the entry block `hub init` writes into the hub root's AGENTS.md. Walk up from `start`
// so a session opened in the hub root or any directory below it finds its hub without --hub.
export async function findHub(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    const agents = await read(join(dir, "AGENTS.md"));
    if (agents?.includes(ENTRY_BEGIN) && agents.includes(ENTRY_END)) return dir;
    if (dir === parsePath(dir).root) return null;
    dir = dirname(dir);
  }
}
