// Personal-data rules shared by `npm run scan` and `hub memory add`. Callers report rule names only,
// never the matched text.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const EXAMPLE_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|invalid|local|test|example)$/i;
const FILE_SUFFIX = /\.(md|mjs|js|json|sh|ya?ml|txt)$/i;
// Built from parts so the rule sources below do not match themselves.
export const LOCAL_DIR = "." + "local/";
export const PRIVATE_LIST = `${LOCAL_DIR}scan-patterns.txt`;

export const GENERIC_RULES = [
  { name: "home-dir", regex: /\/(?:Users|home)\/[A-Za-z0-9._-]+/g },
  { name: "email", regex: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g, allow: (match) => EXAMPLE_EMAIL_DOMAIN.test(match[1]) || FILE_SUFFIX.test(match[0]) },
  { name: "session-id", regex: /sess_[0-9a-f]{8,}/g },
  { name: "ipv4", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, allow: (match) => /^(127\.|0\.0\.0\.0$)/.test(match[0]) },
  { name: "credential", regex: /\b(?:token|secret|password)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{8,}/gi },
  // The private word list lives in the local dir; any other path there is a local runtime file and stays out.
  { name: "local-dir", regex: new RegExp(`${LOCAL_DIR.replace(".", "\\.")}(?!scan-patterns\\.txt)\\S*`, "g"), allow: (match, file, line) => file === ".gitignore" && line.trim() === LOCAL_DIR }
];

export function parsePrivatePatterns(text) {
  return String(text || "").split(/\r?\n|,/).map((item) => item.trim()).filter((item) => item && !item.startsWith("#"));
}

export async function loadPrivatePatterns(root, env = process.env) {
  if (env.HUB_SCAN_PATTERNS && env.HUB_SCAN_PATTERNS.trim()) return { source: "HUB_SCAN_PATTERNS", patterns: parsePrivatePatterns(env.HUB_SCAN_PATTERNS) };
  try { return { source: PRIVATE_LIST, patterns: parsePrivatePatterns(await readFile(join(root, PRIVATE_LIST), "utf8")) }; }
  catch (error) { if (error.code === "ENOENT") return { source: null, patterns: [] }; throw error; }
}

export function rulesFor(privatePatterns = []) {
  return [...GENERIC_RULES, ...privatePatterns.map((source, index) => ({ name: `private#${index + 1}`, regex: new RegExp(source, "gi") }))];
}

// Names of the rules that match one line of text (each rule reported once).
export function matchingRules(line, { file = "", rules = GENERIC_RULES } = {}) {
  const names = [];
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    for (const match of String(line).matchAll(rule.regex)) {
      if (rule.allow?.(match, file, line)) continue;
      names.push(rule.name);
      break;
    }
  }
  return names;
}
