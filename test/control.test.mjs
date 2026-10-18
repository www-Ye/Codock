import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink } from "node:fs/promises";
import { Registry } from "../lib/registry.mjs";
import { startControl } from "../lib/control.mjs";
import { requestBinding, main } from "../scripts/preview.mjs";

test("local preview binding: owner-only socket, immediate registry update, idempotence, no replacement or escapes", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/ctl-"),
    runtime = dir + "/run",
    root = dir + "/code";
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(root + "/page/nested", { recursive: true });
  await mkdir(root + "/other");
  await writeFile(root + "/page/index.html", "<h1>local demo</h1>");
  await writeFile(root + "/page/nested/index.html", "<h1>nested</h1>");
  await writeFile(root + "/other/index.html", "<h1>other</h1>");
  await writeFile(dir + "/outside.html", "private");
  await symlink(dir + "/outside.html", root + "/page/escape.html");
  const registry = new Registry({
    socket: dir + "/unused.sock",
    file: runtime + "/sessions.json",
    root,
    allowed: ["sandbox", "other"],
  });
  const sessions = [
    { name: "sandbox", identity: "fixture-1", id: "$0" },
    { name: "other", identity: "fixture-2", id: "$1" },
  ];
  registry.live = async () => sessions;
  await registry.init();
  const config = { runtime, origin: "https://terminal.example.test" },
    control = await startControl({ registry, config });
  t.after(() => control.close());
  assert.equal((await lstat(control.socketPath)).mode & 0o777, 0o600);
  await assert.rejects(startControl({ registry, config }), /already in use/);
  const args = ["--session", "sandbox", "--directory", root + "/page"];
  const result = await main(args, { socketPath: control.socketPath });
  assert.equal(result.url, "https://terminal.example.test/s/sandbox#preview");
  assert.equal(result.changed, true);
  assert.equal(registry.items.sandbox.preview.directory, "page");
  assert.equal(registry.items.sandbox.revision, 2);
  const saved = JSON.parse(await readFile(runtime + "/sessions.json", "utf8"));
  assert.deepEqual(saved.sandbox.preview, result.preview);
  assert.equal(saved.other.preview, null, "unrelated session unchanged");
  const again = await main(args, { socketPath: control.socketPath });
  assert.equal(again.changed, false);
  assert.equal(registry.items.sandbox.revision, 2);
  await assert.rejects(
    main(["--directory", root + "/page"], { socketPath: control.socketPath }),
    /必须明确指定 --session/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, { session: "other", directory: "page" }),
    /预览重叠/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, { session: "other", directory: "page/nested" }),
    /预览重叠/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, { session: "sandbox", directory: "other" }),
    /已绑定其他网页/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, { session: "stranger", directory: "page" }),
    /允许列表/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, { session: "other", directory: dir }),
    /专用子目录/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, { session: "other", directory: root }),
    /专用子目录/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, {
      session: "other",
      directory: "page",
      entry: "missing.html",
    }),
    /不存在/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, {
      session: "other",
      directory: "page",
      entry: "../other/index.html",
    }),
    /入口/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, {
      session: "other",
      directory: "page",
      entry: "escape.html",
    }),
    /符号链接|跳出/,
  );
  await assert.rejects(
    main(["--session", "sandbox", "--directory", "page", "--replace", "yes"], {
      socketPath: control.socketPath,
    }),
    /用法/,
  );
  const moved = await main(
    ["--session", "sandbox", "--directory", root + "/other", "--replace-existing", "yes"],
    { socketPath: control.socketPath },
  );
  assert.equal(moved.changed, true);
  assert.equal(registry.items.sandbox.preview.directory, "other");
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: control.socketPath,
        path: "/preview",
        method: "POST",
        headers: { Origin: "https://terminal.example.test" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(status, 403, "browser-style requests rejected even on local socket");
  sessions[1].identity = "recreated";
  await assert.rejects(
    requestBinding(control.socketPath, { session: "other", directory: "other" }),
    /重新确认/,
  );
  assert.equal(registry.items.other.preview, null);
});

test("different sessions cannot share a proxied preview port", async () => {
  const dir = await mkdtemp(process.env.TMPDIR + "/preview-port-"),
    root = dir + "/code";
  await mkdir(root);
  const registry = new Registry({
    socket: dir + "/unused.sock",
    file: dir + "/sessions.json",
    root,
    allowed: ["a", "b"],
    previewPorts: [54321],
  });
  registry.live = async () => [
    { name: "a", identity: "a" },
    { name: "b", identity: "b" },
  ];
  await registry.init();
  await registry.update("a", { revision: 1, preview: { type: "port", port: 54321 } });
  await assert.rejects(
    registry.update("b", { revision: 1, preview: { type: "port", port: 54321 } }),
    /端口已绑定到 a/,
  );
  assert.equal(registry.items.b.preview, null);
});

test("local CLI binds a live port with explicit replacement and keeps other sessions intact", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/ctl-port-"),
    runtime = dir + "/run",
    root = dir + "/code";
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(root + "/page", { recursive: true });
  await writeFile(root + "/page/index.html", "review");
  const registry = new Registry({
    socket: dir + "/unused.sock",
    file: runtime + "/sessions.json",
    root,
    allowed: ["a", "b"],
    previewPorts: [8886, 8887],
  });
  registry.live = async () => [
    { name: "a", identity: "a" },
    { name: "b", identity: "b" },
  ];
  await registry.init();
  const control = await startControl({
    registry,
    config: { runtime, origin: "https://terminal.example.test" },
  });
  t.after(() => control.close());
  const options = { socketPath: control.socketPath };
  await main(["--session", "a", "--directory", root + "/page"], options);
  await assert.rejects(main(["--session", "a", "--port", "8886"], options), /已绑定其他网页/);
  const result = await main(
    ["--session", "a", "--port", "8886", "--replace-existing", "yes"],
    options,
  );
  assert.deepEqual(result.preview, { type: "port", port: 8886 });
  assert.equal(result.changed, true);
  assert.equal((await main(["--session", "a", "--port", "8886"], options)).changed, false);
  await assert.rejects(main(["--session", "b", "--port", "8886"], options), /端口已绑定/);
  await assert.rejects(main(["--session", "b", "--port", "8790"], options), /不能用于/);
  await assert.rejects(main(["--session", "b", "--port", "65536"], options), /无效/);
  await assert.rejects(
    main(["--session", "b", "--port", "8886", "--directory", "page"], options),
    /只能提供/,
  );
  await assert.rejects(
    main(["--session", "b", "--port", "8886", "--entry", "index.html"], options),
    /不能同时/,
  );
  await assert.rejects(
    requestBinding(control.socketPath, { session: "b", directory: "page", port: 9999 }),
    /不能同时/,
  );
  assert.equal(registry.items.b.preview, null);
  assert.deepEqual(JSON.parse(await readFile(runtime + "/sessions.json", "utf8")).a.preview, {
    type: "port",
    port: 8886,
  });
});
