import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const scanner = fileURLToPath(new URL("../scripts/check-source.mjs", import.meta.url));
test("publish check sees untracked and staged secrets, rejects forced config and never echoes tokens", async () => {
  const cwd = await mkdtemp(process.env.TMPDIR + "/scan-");
  await exec("git", ["init", "-q"], { cwd });
  const secret = "gh" + "p_" + "x".repeat(30);
  await writeFile(cwd + "/notes.md", secret);
  const scan = () => exec(process.execPath, [scanner], { cwd, env: process.env });
  await assert.rejects(
    scan,
    (e) => e.code === 1 && e.stderr.includes("credential token") && !e.stderr.includes(secret),
  );
  await exec("git", ["add", "notes.md"], { cwd });
  await writeFile(cwd + "/notes.md", "Safe working copy");
  await assert.rejects(scan, (e) => e.stderr.includes("[index]") && !e.stderr.includes(secret));
  await exec("git", ["add", "notes.md"], { cwd });
  assert.match((await scan()).stdout, /Checked 1 publish candidates/);
  await writeFile(cwd + "/.gitignore", "config.json\n");
  await writeFile(cwd + "/config.json", "{}");
  await exec("git", ["add", "-f", "config.json"], { cwd });
  await assert.rejects(scan, (e) => e.stderr.includes("excluded runtime/config/archive file"));
});
test("publish check rejects symlinks and broken local documentation links", async () => {
  const cwd = await mkdtemp(process.env.TMPDIR + "/scan-");
  await exec("git", ["init", "-q"], { cwd });
  await writeFile(cwd + "/README.md", "[Missing](missing.md)");
  await symlink("README.md", cwd + "/alias.md");
  await assert.rejects(
    () => exec(process.execPath, [scanner], { cwd, env: process.env }),
    (e) => e.stderr.includes("symlink") && e.stderr.includes("missing local link"),
  );
});
