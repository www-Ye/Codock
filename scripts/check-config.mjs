import { lstat, realpath, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../lib/config.mjs";
import { checkCredentials } from "../lib/preflight.mjs";
const exec = promisify(execFile);
const c = await loadConfig();
let failed = false;
const check = async (label, fn) => {
  try {
    await fn();
    console.log("OK " + label);
  } catch (e) {
    failed = true;
    console.error("FAIL " + label + ": " + e.message);
  }
};
await check("Node >= 22", () => {
  if (+process.versions.node.split(".")[0] < 22) throw Error("upgrade Node to 22 or newer");
});
await check("non-root service user", () => {
  if (process.getuid?.() === 0) throw Error("use the tmux owner, not root");
});
await check("tmux >= 3.4", async () => {
  const version = (await exec("tmux", ["-V"], { timeout: 5000 })).stdout.match(/tmux (\d+)\.(\d+)/);
  if (!version || +version[1] < 3 || (+version[1] === 3 && +version[2] < 4))
    throw Error("tmux 3.4 or newer required");
});
await check("Python 3", () => exec("python3", ["--version"], { timeout: 5000 }));
await check("native terminal dependency", async () => {
  await import("node-pty");
});
await check("project directory canonical", async () => {
  if (
    !(await lstat(c.projectRoot)).isDirectory() ||
    (await realpath(c.projectRoot)) !== c.projectRoot
  )
    throw Error("use an existing real directory, not a symlink");
  await access(c.projectRoot, constants.R_OK | constants.X_OK);
});
await check("tmux socket owner", async () => {
  const info = await lstat(c.socket);
  if (!info.isSocket() || info.uid !== process.getuid())
    throw Error("socket must belong to this Linux user");
  const { stdout } = await exec(
    "tmux",
    ["-S", c.socket, "list-sessions", "-F", "#{session_name}"],
    { timeout: 5000, env: { ...process.env, TMUX: "" } },
  );
  if (
    !stdout
      .trim()
      .split("\n")
      .some((name) => c.allowed.includes(name))
  )
    throw Error("create at least one session listed in allowed, or correct the socket");
});
if (c.chatEnabled)
  await check("Codex history directory", async () => {
    if (!(await lstat(c.codexHome)).isDirectory()) throw Error("codexHome must be a directory");
    await access(c.codexHome, constants.R_OK | constants.X_OK);
  });
await check("authentication permissions and contents", () => checkCredentials(c));
console.log("DNS, HTTPS and real mobile connectivity must be verified after deployment.");
process.exitCode = failed ? 1 : 0;
