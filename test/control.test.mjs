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
  await mkdir(root + "/page", { recursive: true });
  await mkdir(root + "/other");
  await writeFile(root + "/page/index.html", "<h1>local demo</h1>");
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
