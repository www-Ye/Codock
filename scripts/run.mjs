import { spawn } from "node:child_process";
import { mkdir, chmod, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.join(root, "runtime");
const env = {
  ...process.env,
  TMPDIR: path.join(runtime, "tmp"),
  XDG_CACHE_HOME: path.join(runtime, "cache"),
  XDG_CONFIG_HOME: path.join(runtime, "config"),
  npm_config_cache: path.join(runtime, "npm"),
};
for (const dir of [runtime, env.TMPDIR, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME])
  await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(runtime, 0o700);
const routes = {
  start: ["server.mjs"],
  setup: ["scripts/setup.mjs"],
  "setup-github": ["scripts/setup-github.mjs"],
  preview: ["scripts/preview.mjs"],
  check: ["scripts/check-config.mjs"],
  smoke: ["scripts/smoke.mjs"],
  screenshots: ["scripts/screenshots.mjs"],
  lint: ["scripts/check-source.mjs"],
  test: ["--test", "--test-concurrency=1"],
};
if (process.argv[2] === "test")
  routes.test.push(
    ...(await readdir(path.join(root, "test")))
      .filter((name) => name.endsWith(".test.mjs"))
      .sort()
      .map((name) => "test/" + name),
  );
const args = routes[process.argv[2]];
if (!args) throw Error("Use " + Object.keys(routes).join(", "));
const child = spawn(process.execPath, [...args, ...process.argv.slice(3)], {
  cwd: root,
  env,
  stdio: "inherit",
});
child.on("error", () => {
  console.error("Unable to start the command; check the Node executable and file permissions.");
  process.exitCode = 1;
});
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => child.kill(s));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
