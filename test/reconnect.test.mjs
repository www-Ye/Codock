import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import { Registry } from "../lib/registry.mjs";
import { startControl } from "../lib/control.mjs";

test("explicit owner recovery preserves previews and offline sessions; stale batches make no changes", async (t) => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/reconnect-");
  const registry = new Registry({
    socket: "unused",
    file: runtime + "/sessions.json",
    root: runtime,
    allowed: ["a", "b", "offline"],
  });
  registry.items = {
    a: {
      name: "a",
      label: "A",
      identity: "old-a",
      revision: 4,
      preview: { type: "static", directory: "a-web", entry: "index.html" },
    },
    b: { name: "b", label: "B", identity: "old-b", revision: 2, preview: null },
    offline: {
      name: "offline",
      identity: "old-offline",
      revision: 3,
      preview: { type: "port", port: 43210 },
    },
  };
  let live = [
    { name: "a", identity: "new-a" },
    { name: "b", identity: "new-b" },
  ];
  registry.live = async () => live;
  await registry.save();
  const before = JSON.stringify(registry.items);
  const sessions = ["a", "b"].map((name) => ({
    name,
    previousIdentity: registry.items[name].identity,
    revision: registry.items[name].revision,
    identity: "new-" + name,
  }));
  const control = await startControl({
    registry,
    config: { runtime, origin: "https://example.test" },
  });
  t.after(() => control.close());
  const post = (body, origin) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: control.socketPath,
          path: "/reconnect",
          method: "POST",
          headers: origin ? { Origin: origin } : {},
        },
        (res) => {
          let text = "";
          res.on("data", (b) => (text += b));
          res.on("end", () => resolve({ status: res.statusCode, ...JSON.parse(text) }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  const body = { confirm: true, preservePreviews: true, sessions };
  assert.equal((await post({ ...body, confirm: false })).status, 409);
  assert.equal((await post(body, "https://example.test")).status, 403);
  live = [live[0]];
  assert.equal((await post(body)).status, 409);
  assert.equal(JSON.stringify(registry.items), before);
  live = [
    { name: "a", identity: "new-a" },
    { name: "b", identity: "new-b" },
  ];
  assert.equal((await post({ ...body, sessions: [sessions[0], sessions[0]] })).status, 409);
  assert.equal((await post({ ...body, sessions: [{ ...sessions[0], revision: 0 }] })).status, 409);
  const result = await post(body);
  assert.equal(result.status, 200);
  assert.deepEqual(result.sessions, ["a", "b"]);
  const old = JSON.parse(before),
    saved = JSON.parse(await readFile(registry.file, "utf8"));
  for (const name of ["a", "b"])
    assert.deepEqual(saved[name], {
      ...old[name],
      identity: "new-" + name,
      revision: old[name].revision + 1,
    });
  assert.deepEqual(saved.offline, old.offline);
  assert.equal((await post(body)).status, 409, "cannot replay an old recovery confirmation");
});
