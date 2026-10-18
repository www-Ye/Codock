import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRuntime } from "../lib/session-runtime.mjs";

test("runtime snapshot is bounded, cached, identity scoped and state-only", async () => {
  let now = 1000,
    liveCalls = 0,
    active = 0,
    peak = 0,
    observed = 0;
  const registry = {
    items: { a: { identity: "a1" }, b: { identity: "b1" }, changed: { identity: "old" } },
    live: async () => {
      liveCalls++;
      return [
        { name: "a", identity: "a1", id: "$1" },
        { name: "b", identity: "b1", id: "$2" },
        { name: "changed", identity: "new", id: "$3" },
      ];
    },
    command: async (args) => {
      assert.equal(args[0], "display-message");
      assert.notEqual(args[3], "$3");
      return "%1\t123\t30\t0";
    },
  };
  const status = new SessionRuntime(registry, {
    clock: () => now,
    ttl: 100,
    workers: 1,
    observe: async () => {
      active++;
      peak = Math.max(active, peak);
      observed++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return {
        state: observed === 1 ? "running" : "waiting",
        attention: { summary: "SECRET TERMINAL TEXT" },
      };
    },
  });
  const first = status.snapshot();
  assert.equal(first, status.snapshot(), "same pending promise is shared");
  const value = await first;
  assert.deepEqual(value, { states: { a: "running", b: "waiting" }, checkedAt: 1000 });
  assert.equal(JSON.stringify(value).includes("SECRET"), false);
  assert.equal(peak, 1);
  assert.equal(liveCalls, 1);
  assert.equal(await status.snapshot(), value);
  assert.equal(liveCalls, 1);
  now = 1100;
  await status.snapshot();
  assert.equal(liveCalls, 2);
});

test("default runtime snapshot expires after five seconds", async () => {
  let now = 1000,
    calls = 0;
  const registry = {
    items: {},
    live: async () => {
      calls++;
      return [];
    },
  };
  const status = new SessionRuntime(registry, { clock: () => now });
  await status.snapshot();
  now = 5999;
  await status.snapshot();
  assert.equal(calls, 1);
  now = 6000;
  await status.snapshot();
  assert.equal(calls, 2);
});

test("completion markers are scoped to verified live identities and contain no transcript", async () => {
  const registry = {
    socket: "/workspace/tmux.sock",
    items: { a: { identity: "a1" }, changed: { identity: "old" } },
    live: async () => [
      { name: "a", identity: "a1", id: "$1" },
      { name: "changed", identity: "new", id: "$2" },
    ],
    command: async () => "%1\t123\t30\t0",
  };
  let calls = 0;
  const status = new SessionRuntime(registry, {
    home: "/saved-codex",
    observe: async () => ({ state: "ready" }),
    readTurns: async (home, socket, panes) => {
      calls++;
      assert.equal(home, "/saved-codex");
      assert.equal(socket, registry.socket);
      assert.deepEqual(panes, [{ pid: 123, pane: "%1" }]);
      return [
        {
          binding: "456:789:11111111-1111-1111-1111-111111111111",
          id: "44",
          time: 1790532000000,
          privateText: "NEVER RETURN THIS",
        },
      ];
    },
  });
  const value = await status.snapshot();
  assert.equal(calls, 1);
  assert.deepEqual(value.completions, {
    a: {
      identity: "a1",
      binding: "456:789:11111111-1111-1111-1111-111111111111",
      id: "44",
      time: 1790532000000,
    },
  });
  assert.equal(JSON.stringify(value).includes("NEVER RETURN THIS"), false);
  assert.equal(value.completions.changed, undefined);
});

test("a stalled completion reader does not stall already collected terminal states", async () => {
  const registry = {
    socket: "/workspace/tmux.sock",
    items: { a: { identity: "a1" } },
    live: async () => [{ name: "a", identity: "a1", id: "$1" }],
    command: async () => "%1\t123\t30\t0",
  };
  const status = new SessionRuntime(registry, {
    home: "/saved-codex",
    observe: async () => ({ state: "running" }),
    readTurns: async () => new Promise(() => {}),
  });
  const started = Date.now();
  const value = await Promise.race([
    status.snapshot(),
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("marker reader delayed live status")), 1900),
    ),
  ]);
  assert.equal(value.states.a, "running");
  assert.deepEqual(value.completions, {});
  assert(Date.now() - started < 1700, "optional marker lookup has a short response bound");
});
