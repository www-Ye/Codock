import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { validateConfig, renderIndex } from "../lib/config.mjs";
import { createDesk } from "../server.mjs";
import { Registry } from "../lib/registry.mjs";
const good = {
  origin: "https://terminal.example.com",
  previewSuffix: "preview.example.com",
  socket: "/srv/user/tmux.sock",
  projectRoot: "/srv/user/projects",
  allowed: ["dev"],
  authMode: "github",
  githubOwner: { login: "test-user", id: 987654 },
};
test("deployment config fails closed and brand strings are escaped", () => {
  assert.equal(validateConfig(good).secure, true);
  for (const change of [
    { origin: "http://terminal.example.com" },
    { origin: "https://terminal.example.com/path" },
    { previewSuffix: "example.com" },
    { socket: "relative" },
    { projectRoot: "/" },
    { allowed: ["dev", "dev"] },
    { allowed: ["../bad"] },
    { githubOwner: { login: "someone", id: 0 } },
    { authMode: "automatic" },
    { port: 22 },
    { previewPorts: [8790] },
    { brand: { accent: "red;display:none" } },
    { unknown: 1 },
  ])
    assert.throws(() => validateConfig({ ...good, ...change }));
  assert.equal(
    validateConfig({ ...good, authMode: "local", githubOwner: undefined }).authMode,
    "local",
  );
  assert.equal(
    renderIndex("{{BRAND_NAME}}", { name: '<img onerror="bad">' }),
    "&lt;img onerror=&quot;bad&quot;&gt;",
  );
});
test("GitHub mode never falls back to password when GitHub config is absent; chat can be disabled", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/conf-");
  const desk = await createDesk({
    runtime: dir,
    allowed: [],
    secure: false,
    authMode: "github",
    githubOwner: good.githubOwner,
    chatEnabled: false,
    brand: { name: "Example <Studio>" },
  });
  await writeFile(
    dir + "/auth.json",
    JSON.stringify({ salt: "fixture", password: "fixture", totp: "fixture" }),
  );
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  t.after(() => desk.close());
  const origin = "http://127.0.0.1:" + desk.server.address().port;
  desk.config.origin = origin;
  const bootstrap = await (await fetch(origin + "/api/bootstrap")).json();
  assert.deepEqual(bootstrap.methods, { github: false, local: false });
  assert.equal(
    (
      await fetch(origin + "/api/login", {
        method: "POST",
        headers: { Origin: origin },
        body: "{}",
      })
    ).status,
    403,
  );
  const html = await (await fetch(origin)).text();
  assert(html.includes("Example &lt;Studio&gt;"));
  assert(!html.includes("{{BRAND_NAME}}"));
  const cookie = desk.auth.cookie(desk.auth.issue({ provider: "fixture" })).split(";")[0];
  assert.equal(
    (await fetch(origin + "/api/sessions/dev/chat", { headers: { Cookie: cookie } })).status,
    403,
  );
});
test("deployment port preview is default deny; explicit trusted port may be bound", async () => {
  const dir = await mkdtemp(process.env.TMPDIR + "/ports-");
  await mkdir(dir + "/projects");
  const registry = new Registry({
    root: dir + "/projects",
    file: dir + "/sessions.json",
    allowed: ["dev"],
    previewPorts: [],
  });
  registry.items.dev = { name: "dev", revision: 1 };
  await assert.rejects(
    registry.update("dev", { revision: 1, preview: { type: "port", port: 3000 } }),
    { status: 400 },
  );
  registry.previewPorts = [3000];
  const item = await registry.update("dev", { revision: 1, preview: { type: "port", port: 3000 } });
  assert.equal(item.preview.port, 3000);
});
