import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { CodexDaemon } from "../lib/codex-daemon.mjs";

const id = "11111111-1111-1111-1111-111111111111";
async function fixture(
  t,
  { silent = false, disconnect = false, duplicate = false, wrong = false, changing = false } = {},
) {
  const home = await mkdtemp(process.env.TMPDIR + "/daemon-");
  await mkdir(home + "/app-server-control");
  const server = http.createServer(),
    wss = new WebSocketServer({ server }),
    calls = [];
  let connections = 0,
    lists = 0;
  wss.on("connection", (ws) => {
    connections++;
    ws.on("message", (raw) => {
      const message = JSON.parse(raw);
      calls.push(message);
      if (silent) return;
      if (disconnect) {
        ws.close();
        return;
      }
      let result;
      if (message.method === "initialize") result = {};
      else if (message.method === "account/rateLimits/read")
        result = {
          rateLimits: {
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 },
          },
        };
      else if (message.method === "initialized") return;
      else if (message.method === "thread/loaded/list")
        result = {
          data: ++lists > 1 && changing ? [] : duplicate ? [id, id] : [id],
          nextCursor: null,
        };
      else if (message.method === "thread/read")
        result = {
          thread: {
            id: wrong ? "22222222-2222-2222-2222-222222222222" : id,
            name: "work",
            cwd: "/workspace",
            source: "cli",
            parentThreadId: null,
            turns: [],
            preview: "private message is not returned",
          },
        };
      else throw Error("Unexpected non-read RPC");
      ws.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise((resolve) =>
    server.listen(home + "/app-server-control/app-server-control.sock", resolve),
  );
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    home,
    calls,
    get connections() {
      return connections;
    },
  };
}

test("daemon uses metadata-only official RPC; simultaneous readers coalesce without retaining stale snapshots", async (t) => {
  const f = await fixture(t),
    daemon = new CodexDaemon(f.home);
  const [a, b] = await Promise.all([daemon.snapshot(), daemon.snapshot()]);
  assert.deepEqual(a, [
    { id, name: "work", cwd: "/workspace", source: "cli", parentThreadId: null },
  ]);
  assert.deepEqual(a, b);
  assert.equal(f.connections, 1);
  await daemon.snapshot();
  assert.equal(f.connections, 2, "a new read obtains a new live snapshot");
  assert(
    f.calls.every((c) =>
      ["initialize", "initialized", "thread/loaded/list", "thread/read"].includes(c.method),
    ),
  );
  assert(
    f.calls.filter((c) => c.method === "thread/read").every((c) => c.params.includeTurns === false),
  );
});

test("daemon bounds timeouts and rejects disconnects, duplicate IDs, identity mismatch and changing membership", async (t) => {
  for (const options of [
    { silent: true },
    { disconnect: true },
    { duplicate: true },
    { wrong: true },
    { changing: true },
  ]) {
    const f = await fixture(t, options),
      daemon = new CodexDaemon(f.home, { timeout: 120 });
    await assert.rejects(daemon.snapshot());
    assert.equal(daemon.pending, null);
    assert(
      f.calls.every((c) =>
        ["initialize", "initialized", "thread/loaded/list", "thread/read"].includes(c.method),
      ),
    );
  }
});

test("quota reads never list, resume or send input to a thread", async (t) => {
  const f = await fixture(t),
    daemon = new CodexDaemon(f.home);
  assert.equal((await daemon.rateLimits()).rateLimits.primary.usedPercent, 25);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["initialize", "initialized", "account/rateLimits/read"],
  );
});
