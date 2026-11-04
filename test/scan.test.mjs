import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { scanText } from "../scripts/scan-private.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/scan-private.mjs", import.meta.url));
// Fixture strings are assembled at runtime so this test file itself stays clean for the repository scan.
const home = ["", "Us" + "ers", "alice", "work"].join("/");
const mail = "alice" + "@" + "mail-provider.com";
const session = "se" + "ss_" + "0123456789abcdef";
const fake = "example-" + "secret-word";
const ip = ["10", "1", "2", "3"].join(".");
const localDir = "." + "local/";

async function repo(files) {
  const root = await mkdtemp(join(tmpdir(), "scan-"));
  await run("git", ["init", "-q"], { cwd: root });
  for (const [rel, content] of Object.entries(files)) { await mkdir(join(root, rel, ".."), { recursive: true }); await writeFile(join(root, rel), content); }
  await run("git", ["add", "-A"], { cwd: root });
  return root;
}
async function scan(root, env = {}) {
  try { const { stdout } = await run(process.execPath, [script, root], { env: { PATH: process.env.PATH, ...env } }); return { code: 0, stdout }; }
  catch (error) { return { code: error.code, stdout: error.stdout }; }
}

test("scan flags generic personal data and the private word list without echoing matches", async () => {
  const root = await repo({
    "notes.md": `ok line\nsee ${home}/x\nmail ${mail}\nid ${session}\nhost ${ip}\npassword = hunter2hunter2\npath ${localDir}runtime.env\n`,
    [`docs/${fake}.md`]: "named after a private word\n",
    "clean.md": `uses ${fake.toUpperCase()} in caps\n`
  });
  const result = await scan(root, { HUB_SCAN_PATTERNS: `${fake}, unused-word` });
  assert.equal(result.code, 1);
  const lines = result.stdout.trim().split("\n");
  assert.deepEqual(lines.slice(0, -1).sort(), [
    "clean.md:1:private#1", `docs/${fake}.md:0:private#1`,
    "notes.md:2:home-dir", "notes.md:3:email", "notes.md:4:session-id", "notes.md:5:ipv4", "notes.md:6:credential", "notes.md:7:local-dir"
  ].sort());
  assert.match(lines.at(-1), /^scan: 3 tracked files, 8 hits; 2 private patterns from HUB_SCAN_PATTERNS$/);
  for (const secret of ["alice", "hunter2", ip, "runtime.env", "0123456789abcdef"]) assert.equal(result.stdout.includes(secret), false, `output must not echo ${secret}`);
});

test("scan passes a clean repository and allows only the declared repository address", async () => {
  const address = "https://github.com/" + "someone/Example";
  const root = await repo({
    "package.json": JSON.stringify({ repository: { type: "git", url: `${address}.git` }, bugs: { url: `${address}/issues` } }),
    "README.md": `git clone ${address}.git\nmail dev@agenthub.local or test@example.invalid; loopback 127.0.0.1; see @AGENTS.md\n`,
    ".gitignore": `${localDir}\n`, "AGENTS.md": `word list: ${localDir}scan-patterns.txt\n`
  });
  const clean = await scan(root, { HUB_SCAN_PATTERNS: "someone" });
  assert.equal(clean.code, 0, clean.stdout); assert.match(clean.stdout, /0 hits/);
  await writeFile(join(root, "docs.md"), `mirror: ${address}\n`); await run("git", ["add", "-A"], { cwd: root });
  assert.match((await scan(root, { HUB_SCAN_PATTERNS: "someone" })).stdout, /^docs\.md:1:private#1$/m, "the address is only allowed in package.json and the READMEs");
  const generic = await scan(root);
  assert.equal(generic.code, 0); assert.match(generic.stdout, /generic rules only/);
  assert.deepEqual(scanText({ file: "a.md", text: "plain text" }), []);
});
