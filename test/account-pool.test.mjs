import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { AccountPool, isolatedEnvironment } from "../lib/account-pool.mjs";

const thread = "11111111-1111-4111-8111-111111111111",
  next = "22222222-2222-4222-8222-222222222222";
async function fixture(t) {
  const dir = await mkdtemp(path.join(process.env.TMPDIR, "accounts-"));
  const home = path.join(dir, "original");
  await mkdir(home);
  await writeFile(
    path.join(home, "rollout.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: thread, history_mode: "paginated" } }) +
      "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "fixture" } }) +
      "\n",
  );
  let selected = "default",
    state = "ready",
    height = 30,
    candidateReady = true,
    candidateError = null;
  const commands = [],
    calls = [];
  const registry = {
    items: { dev: { identity: "stable", preview: { directory: "keep" } } },
    target: async () => ({ id: "$1" }),
    command: async (args) => {
      commands.push(args);
      if (args[0] === "display-message")
        return `%1\t100\t30\t0\t${selected === "default" ? "" : selected}`;
      if (args[0] === "capture-pane") return "› Ask Codex to do anything";
      if (args[0] === "new-window") return "@2\t%2";
      if (args[0] === "set-option" && args[4] === "@desk_account") selected = args[5];
      return "";
    },
  };
  // The pane's account changes only when the prepared window is selected.
  let tag;
  registry.command = async (args) => {
    commands.push(args);
    if (args[0] === "display-message")
      return selected === "default"
        ? `%1\t100\t${height}\t0\t`
        : `%2\t200\t${height}\t0\t${selected}`;
    if (args[0] === "capture-pane") return "› Ask Codex to do anything";
    if (args[0] === "new-window") return "@2\t%2";
    if (args[0] === "set-option" && args[4] === "@desk_account") tag = args[5];
    if (args[0] === "select-window") selected = tag;
    return "";
  };
  const chats = {
    page: async () => ({
      available: true,
      binding: "100:12:" + thread,
      model: "fixture",
      effort: "high",
      runtime: { state },
    }),
  };
  const options = {
    runtime: dir,
    root: dir + "/homes",
    defaultHome: home,
    registry,
    terminals: { writers: new Map() },
    chats,
    readCandidate: async () => {
      if (candidateError) throw candidateError;
      return {
        available: candidateReady,
        readOnly: false,
        binding: "200:24:" + next,
        runtime: { state: "ready" },
      };
    },
    readContext: async () => ({
      config: { sandbox_mode: "read-only" },
      params: { sandbox: "read-only" },
    }),
    command: async () => ({ stdout: "" }),
    rpcFactory: (home, { notify }) => ({
      close() {},
      async request(method, params) {
        calls.push({ home, method, params });
        if (method === "account/read") return { account: { type: "chatgpt", planType: "pro" } };
        if (method === "thread/read")
          return {
            thread: {
              id: thread,
              path: dir + "/original/rollout.jsonl",
              cwd: dir,
              updatedAt: 1,
              status: { type: "idle" },
            },
          };
        if (method === "thread/fork") return { thread: { id: next } };
      },
    }),
  };
  const pool = new AccountPool(options);
  await pool.init();
  t.after(() => pool.close());
  const item = await pool.add("研究");
  return {
    pool,
    item,
    commands,
    calls,
    registry,
    chats,
    options,
    setState: (value) => (state = value),
    setHeight: (value) => (height = value),
    setCandidate: (value) => (candidateReady = value),
    setCandidateError: (value) => (candidateError = value),
    input: {
      identity: "stable",
      binding: "100:12:" + thread,
      requestId: "33333333-3333-4333-8333-333333333333",
      accountId: item.id,
      confirm: true,
    },
  };
}
async function settle(pool) {
  await Promise.all([...pool.inFlight.values()]);
}
async function tick(pool) {
  await pool.tick();
  await settle(pool);
}
async function restart(f, t) {
  await f.pool.close();
  const pool = new AccountPool(f.options);
  await pool.init();
  t.after(() => pool.close());
  return pool;
}
test("account homes isolate credentials; metadata never contains credential material", async (t) => {
  const f = await fixture(t);
  const env = isolatedEnvironment("/isolated", {
    HOME: "/unchanged",
    OPENAI_API_KEY: "not-a-real-key",
    CODEX_HOME: "/original",
    CODEX_THREAD_ID: "other",
  });
  assert.equal(env.HOME, "/unchanged");
  assert.equal(env.CODEX_HOME, "/isolated");
  assert(!env.OPENAI_API_KEY);
  assert(!env.CODEX_THREAD_ID);
  assert.equal(f.pool.home("default"), f.pool.defaultHome);
  assert.notEqual(f.pool.home(f.item.id), f.pool.defaultHome);
  assert.throws(() => f.pool.home("../outside"));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f.pool.file, "utf8"))[f.item.id]).sort(), [
    "created",
    "id",
    "label",
  ]);
  await assert.rejects(f.pool.login("default"));
});
test("quota recovery refreshes only the requested pool account without switching the system login", async (t) => {
  const f = await fixture(t),
    calls = [];
  let expired = true;
  f.pool.clients.set(f.item.id, {
    close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "account/read") {
        assert.equal(params.refreshToken, true);
        expired = false;
        return { account: { type: "chatgpt" } };
      }
      if (method === "account/rateLimits/read") {
        if (expired) throw Object.assign(Error("expired"), { authExpired: true });
        return {
          rateLimits: {
            primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2000000000 },
          },
        };
      }
      throw Error("Unexpected account mutation");
    },
  });
  const q = await f.pool.quota(f.item.id);
  assert.equal(q.stale, false);
  assert.equal(q.buckets[0].windows[0].remainingPercent, 90);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["account/rateLimits/read", "account/read", "account/rateLimits/read"],
  );
  assert.equal(f.commands.length, 0);
  assert.equal(f.pool.switches.size, 0);
});
test("working turns wait, cancellation sends no keys and starts no replacement", async (t) => {
  const f = await fixture(t);
  f.setState("running");
  await f.pool.switch("dev", f.input);
  await settle(f.pool);
  assert.equal(f.pool.switches.get("dev").state, "waiting");
  assert.equal(f.pool.terminals.writers.size, 0);
  await f.pool.cancel("dev", f.input.requestId);
  assert.equal(f.pool.switches.get("dev").state, "cancelled");
  assert(!f.commands.some((a) => ["new-window", "send-keys", "respawn-pane"].includes(a[0])));
});
test("switch forks full history into isolated account, preserves old windows and preview", async (t) => {
  const f = await fixture(t);
  await f.pool.switch("dev", f.input);
  await settle(f.pool);
  assert.equal(f.pool.switches.get("dev").state, "starting");
  assert(!f.commands.some((a) => a[0] === "select-window"), "creating a window is not readiness");
  await tick(f.pool);
  assert.equal(f.pool.switches.get("dev").state, "complete", f.pool.switches.get("dev").message);
  assert(
    f.calls.some(
      (c) =>
        c.home === f.pool.home(f.item.id) &&
        c.method === "thread/fork" &&
        c.params.path &&
        c.params.deferGoalContinuation,
    ),
  );
  assert(f.commands.some((a) => a[0] === "new-window" && a.includes("-d")));
  assert(!f.commands.some((a) => /kill|respawn|send-keys/.test(a[0])));
  assert.deepEqual(f.registry.items.dev.preview, { directory: "keep" });
  await f.pool.switch("dev", f.input);
  assert.equal(f.commands.filter((a) => a[0] === "new-window").length, 1);
});

test("waiting survives restart and resizing without stopping the source task", async (t) => {
  const f = await fixture(t);
  f.setState("running");
  await f.pool.switch("dev", f.input);
  await settle(f.pool);
  const pool = await restart(f, t);
  f.setHeight(50);
  await tick(pool);
  assert.equal(pool.switches.get("dev").state, "waiting");
  assert(!f.commands.some((a) => a[0] === "new-window"));
  f.setState("ready");
  await tick(pool);
  assert.equal(pool.switches.get("dev").state, "starting");
  f.setHeight(20);
  await tick(pool);
  assert.equal(pool.switches.get("dev").state, "complete");
});

test("startup survives restart, remains cancellable and never duplicates a window", async (t) => {
  const f = await fixture(t);
  f.setCandidate(false);
  await f.pool.switch("dev", f.input);
  await settle(f.pool);
  const pool = await restart(f, t);
  await tick(pool);
  assert.equal(pool.switches.get("dev").state, "starting");
  assert.equal(pool.terminals.writers.size, 0);
  assert(!f.commands.some((a) => a[0] === "select-window"));
  f.setCandidate(true);
  await tick(pool);
  assert.equal(pool.switches.get("dev").state, "complete");
  assert.equal(f.commands.filter((a) => a[0] === "new-window").length, 1);
});

test("source updates during startup prevent activating a stale copy", async (t) => {
  const f = await fixture(t);
  await f.pool.switch("dev", f.input);
  await settle(f.pool);
  f.setState("running");
  await tick(f.pool);
  assert.equal(f.pool.switches.get("dev").state, "failed");
  assert(!f.commands.some((a) => a[0] === "select-window"));
  assert.equal(f.pool.terminals.writers.size, 0);
});

test("failed or unready new Codex never reports a completed switch", async (t) => {
  for (const dead of [true, false]) {
    const f = await fixture(t);
    await f.pool.switch("dev", f.input);
    await settle(f.pool);
    if (dead) f.setCandidateError(Object.assign(Error("fixture dead pane"), { status: 409 }));
    else f.setCandidate(false);
    await tick(f.pool);
    assert.equal(f.pool.switches.get("dev").state, dead ? "failed" : "starting");
    assert(!f.commands.some((a) => a[0] === "select-window"));
  }
});

test("cancel during an in-flight readiness check cannot later activate the window", async (t) => {
  const f = await fixture(t);
  await f.pool.switch("dev", f.input);
  await settle(f.pool);
  let resolve;
  f.pool.readCandidate = () => new Promise((r) => (resolve = r));
  f.pool.run("dev", f.pool.switches.get("dev"));
  await f.pool.cancel("dev", f.input.requestId);
  resolve({ available: true, binding: "200:24:" + next, runtime: { state: "ready" } });
  await settle(f.pool);
  assert.equal(f.pool.switches.get("dev").state, "cancelled");
  assert(!f.commands.some((a) => a[0] === "select-window"));
  const pool = await restart(f, t);
  await tick(pool);
  assert.equal(pool.switches.get("dev").state, "cancelled");
});

test("concurrent switch requests create at most one job and cannot reuse an ID for another target", async (t) => {
  const f = await fixture(t);
  f.setState("running");
  const results = await Promise.allSettled([
    f.pool.switch("dev", f.input),
    f.pool.switch("dev", { ...f.input, requestId: "44444444-4444-4444-8444-444444444444" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await settle(f.pool);
  await assert.rejects(f.pool.switch("dev", { ...f.input, binding: "100:13:" + thread }));
});

test("restart during fork preparation records interruption instead of replaying side effects", async (t) => {
  const f = await fixture(t);
  f.setState("running");
  await f.pool.switch("dev", f.input);
  await settle(f.pool);
  await f.pool.transition(f.pool.switches.get("dev"), "switching", "fixture preparation");
  const pool = await restart(f, t);
  await tick(pool);
  assert.equal(pool.switches.get("dev").state, "failed");
  assert(!f.calls.some((c) => c.method === "thread/fork"));
  assert(!f.commands.some((a) => a[0] === "new-window"));
});
