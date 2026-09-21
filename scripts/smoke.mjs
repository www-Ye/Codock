// Exercise the production entrypoint with a disposable tmux, never real sessions.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, writeFile, symlink } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { WebSocket } from "ws";
import { root } from "../lib/config.mjs";
import { credentials, totp } from "../lib/auth.mjs";

if (process.getuid?.() === 0) throw Error("Run smoke as a non-root user in a disposable checkout");
const exec = promisify(execFile);
const base = await mkdtemp(process.env.TMPDIR + "/boot-");
const app = path.join(base, "app"),
  socket = path.join(base, "tmux.sock");
await mkdir(app);
for (const file of ["server.mjs", "lib", "public", "scripts", "package.json"])
  await cp(path.join(root, file), path.join(app, file), { recursive: true });
await symlink(path.join(root, "node_modules"), path.join(app, "node_modules"), "dir");
await mkdir(app + "/runtime", { mode: 0o700 });
await mkdir(base + "/projects/site", { recursive: true });
await writeFile(
  base + "/projects/site/index.html",
  "<!doctype html><title>Smoke preview</title><h1>Preview verified</h1>",
);
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = "https://terminal.example.com";
await writeFile(
  app + "/config.json",
  JSON.stringify({
    origin,
    previewSuffix: "preview.example.com",
    socket,
    projectRoot: base + "/projects",
    allowed: ["smoke"],
    port,
    authMode: "local",
    chatEnabled: false,
  }),
  { mode: 0o600 },
);
const password = "synthetic-only-" + crypto.randomUUID();
const auth = await credentials(password);
await writeFile(app + "/runtime/auth.json", JSON.stringify(auth), { mode: 0o600 });
const env = {
  ...process.env,
  TMUX: "",
  TMUX_PANE: "",
  DESK_CONFIG: app + "/config.json",
  HISTFILE: base + "/shell-history",
};
const tmux = (args) => exec("tmux", ["-S", socket, ...args], { env, timeout: 5000 });
const command = (args) =>
  exec(process.execPath, ["scripts/run.mjs", ...args], { cwd: app, env, timeout: 15000 });
const request = (route, { method = "GET", cookie, body, host = "terminal.example.com" } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        timeout: 3000,
        headers: {
          Host: host,
          Origin: origin,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(Error("HTTP timeout")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, ws;
const waitFor = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await delay(50);
  }
  throw Error("Production smoke timed out");
};
try {
  await tmux([
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "smoke",
    "-c",
    base,
    "bash --noprofile --norc",
  ]);
  await command(["check"]);
  console.log("OK non-root preflight, native dependency and synthetic credentials");
  child = spawn(process.execPath, ["scripts/run.mjs", "start"], { cwd: app, env, stdio: "ignore" });
  let spawnError;
  child.once("error", (e) => {
    spawnError = e;
  });
  await waitFor(async () => {
    if (spawnError || child.exitCode !== null) throw Error("Production entrypoint failed to start");
    return request("/api/bootstrap")
      .then((r) => r.status === 200)
      .catch(() => false);
  });
  assert.equal((await request("/api/sessions")).status, 401);
  assert.equal((await request("/api/bootstrap")).json().authenticated, false);
  assert.equal((await request("/", { host: "untrusted.example.com" })).status, 421);
  const login = await request("/api/login", {
    method: "POST",
    body: { password, code: totp(auth.totp) },
  });
  assert.equal(login.status, 200);
  assert.match(login.headers["set-cookie"][0], /HttpOnly; SameSite=Strict.*Secure/);
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const session = (await request("/api/sessions", { cookie })).json().sessions[0];
  assert.equal(session.name, "smoke");
  const messages = [];
  ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?session=smoke&identity=${encodeURIComponent(session.identity)}`,
    { headers: { Host: "terminal.example.com", Origin: origin, Cookie: cookie } },
  );
  ws.on("error", () => {});
  ws.on("message", (bytes) => messages.push(JSON.parse(bytes)));
  await waitFor(() => messages.some((m) => m.type === "ready"));
  ws.send(JSON.stringify({ type: "write" }));
  await waitFor(() => messages.some((m) => m.type === "mode" && m.write));
  ws.send(
    JSON.stringify({ type: "input", id: "smoke-input", data: "printf 'BOOT_%s\\n' VERIFIED\r" }),
  );
  await waitFor(() => messages.some((m) => m.type === "ack" && m.id === "smoke-input"));
  await waitFor(async () =>
    (await tmux(["capture-pane", "-p", "-t", "smoke"])).stdout.includes("BOOT_VERIFIED"),
  );
  console.log("OK production login, secure-cookie attributes and real tmux PTY input");
  const binding = JSON.parse(
    (await command(["preview", "--session", "smoke", "--directory", base + "/projects/site"]))
      .stdout,
  );
  assert.equal(binding.ok, true);
  const preview = (
    await request("/api/sessions/smoke/preview", { method: "POST", cookie, body: {} })
  ).json();
  const target = new URL(preview.url);
  assert.equal((await request("/", { host: target.hostname })).status, 401);
  const grant = await request(target.pathname + target.search, { host: target.hostname });
  assert.equal(grant.status, 303);
  const previewCookie = grant.headers["set-cookie"][0].split(";")[0];
  const page = await request("/", { host: target.hostname, cookie: previewCookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Preview verified/);
  await request("/api/logout", { method: "POST", cookie, body: {} });
  assert.equal((await request("/", { host: target.hostname, cookie: previewCookie })).status, 401);
  console.log("OK CLI preview binding, isolated grant and logout revocation");
} finally {
  ws?.terminate();
  if (child && child.exitCode === null) {
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(deadline);
  }
  await tmux(["kill-server"]).catch(() => {});
}
console.log(
  "Smoke passed. DNS, TLS termination, real OAuth and device networks require deployment acceptance.",
);
