import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SKIP = new Set([".git", "node_modules", ".agenthub", ".DS_Store"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function parsePorcelainZ(value) {
  const parts = Buffer.from(value || "").toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i];
    if (raw.length < 4) continue;
    const entry = { status: raw.slice(0, 2), path: raw.slice(3), origPath: null };
    if (/[RC]/.test(entry.status)) entry.origPath = parts[++i] || null;
    out.push(entry);
  }
  return out;
}

async function fingerprint(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return { hash: `link:${sha(await readlink(path))}`, size: info.size };
  if (!info.isFile()) return { hash: null, size: info.size };
  return { hash: sha(await readFile(path)), size: info.size };
}

async function gitRoot(root) {
  try { return (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim(); }
  catch { return null; }
}

export async function captureSnapshot(inputRoot, { forcePlain = false } = {}) {
  const errors = [];
  let root = resolve(inputRoot);
  try { root = await realpath(root); } catch (error) { return { kind: "missing", root, entries: {}, errors: [String(error.message)] }; }
  const top = forcePlain ? null : await gitRoot(root);
  const entries = {};
  if (top) {
    let stdout;
    try { ({ stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", root], { cwd: root, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 })); }
    catch (error) { return { kind: "git", root, entries, errors: [error.message] }; }
    for (const item of parsePorcelainZ(stdout)) {
      const path = relative(root, resolve(top, item.path));
      const entry = { status: item.status, path, origPath: item.origPath ? relative(root, resolve(top, item.origPath)) : null, hash: null, size: null };
      if (!item.status.includes("D")) {
        try { Object.assign(entry, await fingerprint(resolve(top, item.path))); } catch (error) { errors.push(`${path}: ${error.message}`); }
      }
      entries[path] = entry;
    }
    return { kind: "git", root, entries, errors };
  }
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch (error) { errors.push(`${relative(root, dir) || "."}: ${error.message}`); continue; }
    for (const item of items) {
      if (SKIP.has(item.name) || item.name === ".env" || item.name.startsWith(".env.")) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) stack.push(path);
      else {
        try { entries[relative(root, path)] = { path: relative(root, path), status: null, ...(await fingerprint(path)) }; }
        catch (error) { errors.push(`${relative(root, path)}: ${error.message}`); }
      }
    }
  }
  return { kind: "plain", root, entries, errors };
}

const same = (a, b) => a && b && a.status === b.status && a.hash === b.hash && a.size === b.size;

export function diffSnapshots(before, after) {
  const result = { kind: after.kind, added: [], modified: [], deleted: [], preexisting_dirty: [], errors: [...before.errors.map((error) => `before: ${error}`), ...after.errors.map((error) => `after: ${error}`)] };
  for (const [path, current] of Object.entries(after.entries)) {
    const previous = before.entries[path];
    if (same(previous, current)) { if (after.kind === "git") result.preexisting_dirty.push(path); continue; }
    if (current.status?.includes("D")) result.deleted.push(path);
    else if (!previous && (after.kind === "plain" || current.status === "??" || current.status?.[0] === "A")) result.added.push(path);
    else result.modified.push(path);
  }
  for (const [path, previous] of Object.entries(before.entries)) {
    if (after.entries[path]) continue;
    if (before.kind === "plain" || previous.status === "??" || previous.status?.[0] === "A") result.deleted.push(path);
    else result.modified.push(path);
  }
  return result;
}
