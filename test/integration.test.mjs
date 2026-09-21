import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createDesk } from "../server.mjs";
import { credentials, totp } from "../lib/auth.mjs";
import { Previews } from "../lib/preview.mjs";
const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("port preview streams HTML readiness, preserves media ranges and reports upstream errors", async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === "/jump") {
      res.writeHead(302, { Location: "https://example.invalid/" });
      res.end();
      return;
    }
    if (req.url === "/video") {
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Range": "bytes 2-5/10",
        "Content-Length": 4,
      });
      res.end("2345");
      return;
    }
    const body = "<!doctype html><title>Live app</title><h1>Ready</h1>";
    res.writeHead(req.url === "/error" ? 500 : 200, {
      "Content-Type": "text/html",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const registry = {
    allowed: ["sandbox"],
    items: { sandbox: { revision: 1, preview: { type: "port", port: upstream.address().port } } },
  };
  const previews = new Previews(
    registry,
    { valid: () => true },
    { secure: false, origin: "http://terminal.localhost", previewSuffix: "preview.localhost" },
  );
  previews.grants.set("test", {
    name: "sandbox",
    revision: 1,
    owner: "test",
    expires: Date.now() + 60000,
  });
  const server = http.createServer(
    (req, res) => void previews.handle(req, res).catch((e) => previews.error(req, res, e)),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    previews.close();
  });
  const req = (path, extra = {}) =>
    request(server.address().port, "sandbox.preview.localhost", path, {
      cookie: "workbench_preview_dev=test",
      ...extra,
    });
  const html = await req("/");
  assert.match(html.text, /^<!doctype html>/);
  assert.match(html.text, /workbench-preview-ready/);
  assert.equal(html.headers["content-length"], undefined);
  assert.equal(html.headers["cache-control"], "no-store");
  const error = await req("/error");
  assert.equal(error.status, 500);
  assert.match(error.text, /workbench-preview-error/);
  const video = await req("/video", { headers: { Range: "bytes=2-5" } });
  assert.equal(video.text, "2345");
  assert.equal(video.status, 206);
  assert.equal(video.headers["content-length"], "4");
  assert.equal((await req("/", { method: "HEAD" })).text, "");
  const jump = await req("/jump");
  assert.equal(jump.status, 502);
  assert.match(jump.text, /workbench-preview-error/);
  assert.equal(jump.headers.location, undefined);
  await new Promise((r) => upstream.close(r));
  const down = await req("/");
  assert.equal(down.status, 502);
  assert.match(down.text, /workbench-preview-error/);
});
function request(port, host, path, { method = "GET", cookie, body, origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          Host: host,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(origin ? { Origin: origin } : {}),
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks),
            text = bytes.toString();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            bytes,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
function client(port, origin, cookie, identity) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?session=sandbox&identity=${encodeURIComponent(identity)}`,
    { headers: { Host: new URL(origin).host, Origin: origin, Cookie: cookie } },
  );
  const messages = [];
  ws.on("message", (b) => messages.push(JSON.parse(b)));
  ws.on("error", (e) => messages.push({ type: "socket-error", message: e.message }));
  ws.on("close", (code, reason) => messages.push({ type: "closed", code, reason: String(reason) }));
  return {
    ws,
    messages,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: async (predicate) => {
      for (let i = 0; i < 150; i++) {
        const m = messages.find(predicate);
        if (m) return m;
        await sleep(30);
      }
      throw Error("WebSocket message timeout " + JSON.stringify(messages).slice(-1000));
    },
  };
}

test(
  "isolated real tmux: auth, read-only, write lease, reconnect, preview isolation",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/desk-"),
      socket = dir + "/tmux.sock";
    const tmux = (args) =>
      exec("tmux", ["-S", socket, ...args], {
        env: { ...process.env, TMUX: "", HISTFILE: dir + "/shell-history" },
        timeout: 5000,
      });
    await tmux([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "sandbox",
      "-x",
      "120",
      "-y",
      "30",
      "bash --noprofile --norc",
    ]);
    t.after(async () => {
      await tmux(["kill-server"]).catch(() => {});
    });
    await tmux(["send-keys", "-t", "sandbox", "printf 'HISTORY_%s\\n' {1..1200}", "Enter"]);
    await sleep(200);
    await mkdir(dir + "/project/site", { recursive: true });
    await writeFile(dir + "/project/site/index.html", "<h1>isolated preview</h1>");
    await writeFile(dir + "/project/site/test.mp4", Buffer.from("0123456789"));
    await writeFile(dir + "/project/secret.txt", "DO NOT SERVE");
    await symlink(dir + "/project/secret.txt", dir + "/project/site/leak.txt");
    const desk = await createDesk({
      runtime: dir + "/runtime",
      socket,
      projectRoot: dir + "/project",
      allowed: ["sandbox"],
      secure: false,
      previewSuffix: "preview.localhost",
    });
    await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
    t.after(() => desk.close());
    const port = desk.server.address().port,
      host = "terminal.localhost:" + port,
      origin = "http://" + host;
    desk.config.origin = origin;
    desk.config.previewPort = String(port);
    const req = (path, opts) => request(port, host, path, opts);
    assert.equal((await req("/api/sessions")).status, 401);
    assert.equal(
      (
        await req("/preview", {
          method: "POST",
          origin,
          body: { session: "sandbox", directory: "site" },
        })
      ).status,
      401,
      "local control is not exposed over public HTTP",
    );
    assert.equal((await req("/api/login", { method: "POST", body: {} })).status, 403);
    const auth = await credentials("test-only-long-password");
    await writeFile(dir + "/runtime/auth.json", JSON.stringify(auth), { mode: 0o600 });
    const login = await req("/api/login", {
      method: "POST",
      origin,
      body: { password: "test-only-long-password", code: totp(auth.totp) },
    });
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const s = (await req("/api/sessions", { cookie })).json().sessions[0];
    assert.equal(s.state, "online");
    const c = client(port, origin, cookie, s.identity);
    await c.wait((m) => m.type === "ready");
    const flags = (await tmux(["list-clients", "-F", "#{client_flags}"])).stdout;
    assert.match(flags, /read-only/);
    assert.match(flags, /ignore-size/);
    assert.equal(
      (await desk.registry.list())[0].state,
      "online",
      "attachment must not invalidate identity",
    );
    c.send({ type: "history", id: "history-latest" });
    const history = await c.wait((m) => m.type === "history" && m.id === "history-latest");
    assert.match(history.text, /HISTORY_1200/);
    assert(history.total > 1200);
    assert(history.start > 0);
    assert.equal(
      (await tmux(["display-message", "-p", "-t", "sandbox", "#{pane_in_mode}"])).stdout.trim(),
      "0",
      "history does not put shared tmux into copy-mode",
    );
    assert.match((await tmux(["list-clients", "-F", "#{client_flags}"])).stdout, /read-only/);
    c.send({ type: "history", id: "history-negative", before: -1, snapshot: history.snapshot });
    await c.wait((m) => m.type === "error" && m.id === "history-negative");
    c.send({ type: "history", id: "history-forged", before: history.start, snapshot: "wrong" });
    await c.wait((m) => m.type === "error" && m.id === "history-forged");
    c.send({
      type: "history",
      id: "history-older",
      before: history.start,
      snapshot: history.snapshot,
    });
    const older = await c.wait((m) => m.type === "history" && m.id === "history-older");
    assert.equal(older.end, history.start);
    c.send({
      type: "history",
      id: "history-oldest",
      before: older.start,
      snapshot: history.snapshot,
    });
    const oldest = await c.wait((m) => m.type === "history" && m.id === "history-oldest");
    assert.match(oldest.text, /HISTORY_1\n/);
    assert.equal(oldest.start, 0);
    c.send({ type: "history-close" });
    c.send({
      type: "history",
      id: "history-closed",
      before: history.start,
      snapshot: history.snapshot,
    });
    await c.wait((m) => m.type === "error" && m.id === "history-closed");
    c.send({ type: "input", data: "echo UNSAFE\r", id: "deny" });
    await c.wait((m) => m.type === "error" && m.id === "deny");
    c.send({ type: "write" });
    await c.wait((m) => m.type === "mode" && m.write);
    assert.doesNotMatch(
      (await tmux(["list-clients", "-F", "#{client_flags}"])).stdout,
      /read-only/,
    );
    assert.equal((await desk.registry.list())[0].state, "online");
    const c2 = client(port, origin, cookie, s.identity);
    await c2.wait((m) => m.type === "ready");
    c2.send({ type: "write" });
    await c2.wait((m) => m.type === "error");
    c.send({ type: "input", data: "printf 'DESK_%s\\n' VERIFIED\r", id: "once" });
    await c.wait((m) => m.type === "ack" && m.id === "once");
    await sleep(500);
    assert.match((await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout, /DESK_VERIFIED/);
    c.send({ type: "resize", cols: 42, rows: 14 });
    await sleep(100);
    assert.equal(
      (
        await tmux(["display-message", "-p", "-t", "sandbox", "#{window_width}x#{window_height}"])
      ).stdout.trim(),
      "120x30",
    );
    c.ws.close();
    c2.ws.close();
    await sleep(150);
    await tmux(["has-session", "-t", "sandbox"]);
    assert.equal((await tmux(["list-clients"])).stdout.trim(), "");
    // tmux history-limit changes apply to new panes, not existing grids.
    await tmux(["set-option", "-t", "sandbox", "history-limit", "20000"]);
    assert.equal(
      (await tmux(["display-message", "-p", "-t", "sandbox", "#{history_limit}"])).stdout.trim(),
      "2000",
    );
    await tmux([
      "new-window",
      "-d",
      "-t",
      "sandbox",
      "-n",
      "capacity-test",
      "bash --noprofile --norc",
    ]);
    assert.equal(
      (
        await tmux(["display-message", "-p", "-t", "sandbox:capacity-test", "#{history_limit}"])
      ).stdout.trim(),
      "20000",
    );
    const edit = await req("/api/sessions/sandbox", {
      method: "PATCH",
      origin,
      cookie,
      body: {
        revision: s.revision,
        preview: { type: "static", directory: "site", entry: "index.html" },
      },
    });
    assert.equal(edit.status, 200);
    const ticket = (
      await req("/api/sessions/sandbox/preview", { method: "POST", origin, cookie })
    ).json().url;
    const u = new URL(ticket),
      grant = await request(port, u.host, u.pathname + u.search);
    assert.equal(grant.status, 303);
    const pc = grant.headers["set-cookie"][0].split(";")[0];
    assert(!grant.headers["set-cookie"][0].includes("Domain="));
    assert.equal((await request(port, u.host, "/index.html")).status, 401);
    assert.equal((await request(port, u.host, "/index.html", { cookie })).status, 401);
    const page = await request(port, u.host, "/index.html", { cookie: pc });
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /sandbox/);
    assert.match(page.text, /workbench-preview-ready/);
    assert.match(page.headers["cache-control"], /private, no-cache/);
    const conditional = { headers: { "If-None-Match": page.headers.etag } };
    assert.equal(
      (await request(port, u.host, "/index.html", { cookie: pc, ...conditional })).status,
      304,
    );
    assert.equal(
      (await request(port, u.host, "/index.html", conditional)).status,
      401,
      "cache validation cannot bypass authentication",
    );
    const compressed = await request(port, u.host, "/index.html", {
      cookie: pc,
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(compressed.bytes).toString(), page.text);
    const raw = await request(port, u.host, "/index.html", {
      cookie: pc,
      headers: { "Accept-Encoding": "gzip;q=0" },
    });
    assert.equal(raw.headers["content-encoding"], undefined);
    await writeFile(dir + "/project/site/index.html", "<h1>updated preview content</h1>");
    const updated = await request(port, u.host, "/index.html", { cookie: pc, ...conditional });
    assert.equal(updated.status, 200);
    assert.notEqual(updated.headers.etag, page.headers.etag);
    const media = await request(port, u.host, "/test.mp4", {
      cookie: pc,
      headers: { Range: "bytes=2-5", "Accept-Encoding": "gzip" },
    });
    assert.equal(media.status, 206);
    assert.equal(media.text, "2345");
    assert.equal(media.headers["content-range"], "bytes 2-5/10");
    assert.equal(media.headers["content-encoding"], undefined);
    assert.equal(
      (await request(port, u.host, "/test.mp4", { cookie: pc, headers: { Range: "bytes=-3" } }))
        .text,
      "789",
    );
    const missing = await request(port, u.host, "/missing.html", { cookie: pc });
    assert.equal(missing.status, 404);
    assert.match(missing.text, /workbench-preview-error/);
    assert.equal(missing.headers["cache-control"], "no-store");
    assert.equal((await request(port, u.host, "/leak.txt", { cookie: pc })).status, 403);
    assert.equal((await request(port, u.host, "/.env", { cookie: pc })).status, 403);
    assert.equal((await request(port, u.host, u.pathname + u.search)).status, 401);
    assert.equal(
      (
        await req("/api/sessions/sandbox", {
          method: "PATCH",
          origin,
          cookie,
          body: { revision: 2, preview: { type: "port", port: 8790 } },
        })
      ).status,
      400,
    );
    await req("/api/logout", { method: "POST", origin, cookie });
    assert.equal(
      (await request(port, u.host, "/index.html", { cookie: pc, ...conditional })).status,
      401,
    );
  },
);
