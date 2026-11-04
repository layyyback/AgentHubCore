#!/usr/bin/env node
// Personal-data scan over git-tracked files. Hits print as file:line:rule only; matched text is never echoed,
// so the scan cannot leak what it finds into a terminal or CI log.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPrivatePatterns, matchingRules, rulesFor } from "../src/private-rules.mjs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export { GENERIC_RULES, loadPrivatePatterns, parsePrivatePatterns } from "../src/private-rules.mjs";

// The public repository address may appear only in package.json and the two READMEs; it is read from
// package.json so this script never spells out the account name.
export async function loadAllowedAddress(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    const match = String(url || "").match(/https:\/\/github\.com\/[^/\s]+\/[^/\s.]+/);
    return match ? match[0] : null;
  } catch { return null; }
}
const ADDRESS_FILES = new Set(["package.json", "README.md", "README.zh-CN.md"]);

export function scanText({ file, text, privatePatterns = [], allowedAddress = null }) {
  const rules = rulesFor(privatePatterns);
  const hits = [];
  const check = (line, number) => {
    const visible = allowedAddress && ADDRESS_FILES.has(file) ? line.split(allowedAddress).join("<repository>") : line;
    for (const rule of matchingRules(visible, { file, rules })) hits.push({ file, line: number, rule });
  };
  check(file, 0);
  String(text).split(/\r?\n/).forEach((line, index) => check(line, index + 1));
  return hits;
}

export async function scanRepository(root, env = process.env) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const files = stdout.split("\0").filter(Boolean);
  const { source, patterns } = await loadPrivatePatterns(root, env);
  const allowedAddress = await loadAllowedAddress(root);
  const hits = [];
  for (const file of files) {
    let buffer;
    try { buffer = await readFile(join(root, file)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const text = buffer.includes(0) ? "" : buffer.toString("utf8");
    hits.push(...scanText({ file, text, privatePatterns: patterns, allowedAddress }));
  }
  return { files: files.length, source, patternCount: patterns.length, hits };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const root = resolve(process.argv[2] || ".");
  scanRepository(root).then((result) => {
    for (const hit of result.hits) console.log(`${hit.file}:${hit.line}:${hit.rule}`);
    const list = result.source ? `${result.patternCount} private patterns from ${result.source}` : "no private word list (HUB_SCAN_PATTERNS unset, .local/scan-patterns.txt missing): generic rules only";
    console.log(`scan: ${result.files} tracked files, ${result.hits.length} hits; ${list}`);
    if (result.hits.length) process.exitCode = 1;
  }, (error) => { console.error(`scan: ${error.message}`); process.exitCode = 2; });
}
