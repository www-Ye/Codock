import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AccountPool } from "../lib/account-pool.mjs";
import { SystemAccount, credential } from "../lib/system-account.mjs";

const auth = (name) => {
  const jwt = [
    "fixture",
    Buffer.from(
      JSON.stringify({
        sub: name,
        email: name + "@example.invalid",
        exp: 4102444800,
        "https://api.openai.com/auth": { chatgpt_account_id: name, chatgpt_plan_type: "plus" },
      }),
    ).toString("base64url"),
    "fixture",
  ].join(".");
  return {
    tokens: {
      access_token: jwt,
      id_token: jwt,
      refresh_token: "PRIVATE_FIXTURE_" + name,
      account_id: name,
    },
    last_refresh: new Date().toISOString(),
  };
};
async function fixture(t) {
  const root = await mkdtemp(process.env.TMPDIR + "/system-account-"),
    home = root + "/shared";
  await mkdir(home);
  await writeFile(home + "/auth.json", JSON.stringify(auth("original")), { mode: 0o600 });
  const pool = new AccountPool({
    runtime: root,
    root: root + "/profiles",
    defaultHome: home,
    registry: {},
    terminals: { writers: new Map() },
    chats: {},
  });
  await pool.init();
  clearInterval(pool.timer);
  const target = await pool.add("目标");
  await writeFile(pool.home(target.id) + "/auth.json", JSON.stringify(auth("target")), {
    mode: 0o600,
  });
  let email = "original@example.invalid",
    state = "idle",
    failLogin = false,
    hold;
  const calls = [],
    rpc = {
      ws: {},
      close() {},
      async connect() {},
      async request(method, params) {
        calls.push(method);
        if (method === "account/read") return { account: { type: "chatgpt", email } };
        if (method === "thread/loaded/list") {
          if (hold) await hold;
          return { data: ["thread1"], nextCursor: null };
        }
        if (method === "thread/read") return { thread: { id: "thread1", status: { type: state } } };
        if (method === "account/login/start") {
          if (failLogin && params.chatgptAccountId === "target") throw Error("native unavailable");
          email = params.chatgptAccountId + "@example.invalid";
          return { type: "chatgptAuthTokens" };
        }
        throw Error("unexpected RPC");
      },
    };
  const manager = new SystemAccount(pool, { rpc });
  await manager.init();
  t.after(async () => {
    await manager.close();
    await pool.close();
  });
  const input = { scope: "system", accountId: target.id, confirm: true, requestId: randomUUID() };
  return {
    root,
    home,
    pool,
    target,
    manager,
    rpc,
    calls,
    input,
    setWorking: (value) => (state = value ? "active" : "idle"),
    setState: (value) => (state = value),
    setFailure: (value) => (failLogin = value),
    setHold: (value) => (hold = value),
  };
}
async function settle(manager) {
  const end = Date.now() + 3000;
  while (manager.busy) {
    if (Date.now() > end) throw Error("fixture stalled");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("system switch waits for all loaded work, then changes auth without fork or terminal mutation", async (t) => {
  const f = await fixture(t);
  f.setWorking(true);
  await f.manager.request(f.input);
  await settle(f.manager);
  assert.equal(f.manager.data.job.state, "waiting");
  assert.equal(
    credential(JSON.parse(await readFile(f.home + "/auth.json", "utf8"))).accountId,
    "original",
  );
  f.setWorking(false);
  await f.manager.tick();
  assert.equal(f.manager.data.job.state, "complete");
  assert.equal(
    credential(JSON.parse(await readFile(f.home + "/auth.json", "utf8"))).accountId,
    "target",
  );
  assert.equal((await f.manager.status()).accountId, f.target.id);
  assert.equal(f.pool.terminals.systemAccountApplying, false);
  assert.equal((await stat(f.home + "/auth.json")).mode & 0o777, 0o600);
  assert(
    f.calls.every((m) =>
      ["thread/loaded/list", "thread/read", "account/read", "account/login/start"].includes(m),
    ),
  );
  const saved = Object.values(f.pool.items).find((i) => i.id !== f.target.id);
  assert(saved);
  assert.equal(
    credential(JSON.parse(await readFile(f.pool.home(saved.id) + "/auth.json", "utf8"))).accountId,
    "original",
  );
  const metadata = await readFile(f.manager.file, "utf8");
  assert(!metadata.includes("PRIVATE_FIXTURE"));
  assert(!metadata.includes("access_token"));
  const before = f.calls.filter((m) => m === "account/login/start").length;
  await f.manager.request(f.input);
  await settle(f.manager);
  assert.equal(f.calls.filter((m) => m === "account/login/start").length, before);
});

test("cancelled global request cannot apply after a slow task check finishes", async (t) => {
  const f = await fixture(t);
  let release;
  f.setHold(new Promise((r) => (release = r)));
  await f.manager.request(f.input);
  await f.manager.cancel(f.input.requestId);
  release();
  await settle(f.manager);
  assert.equal(f.manager.data.job.state, "cancelled");
  assert(!f.calls.includes("account/login/start"));
  assert.equal(
    credential(JSON.parse(await readFile(f.home + "/auth.json", "utf8"))).accountId,
    "original",
  );
});

test("native rejection restores shared login and preserves original account", async (t) => {
  const f = await fixture(t);
  f.setFailure(true);
  await f.manager.request(f.input);
  await settle(f.manager);
  assert.equal(f.manager.data.job.state, "failed");
  assert.equal(
    credential(JSON.parse(await readFile(f.home + "/auth.json", "utf8"))).accountId,
    "original",
  );
  assert.equal((await f.manager.status()).state, "ready");
  assert.equal(f.pool.terminals.systemAccountApplying, false);
});

test("waiting request survives restart; interrupted commit never blindly replays", async (t) => {
  const f = await fixture(t);
  f.setWorking(true);
  await f.manager.request(f.input);
  await settle(f.manager);
  await f.manager.close();
  const next = new SystemAccount(f.pool, { rpc: f.rpc });
  await next.init();
  t.after(() => next.close());
  assert.equal(next.data.job.state, "waiting");
  f.setWorking(false);
  await next.tick();
  assert.equal(next.data.job.state, "complete");
  await next.close();
  next.data.job.state = "applying";
  await next.save();
  const last = new SystemAccount(f.pool, { rpc: f.rpc });
  await last.init();
  t.after(() => last.close());
  const count = f.calls.length;
  await last.tick();
  assert.equal(last.data.job.state, "uncertain");
  assert.equal(f.calls.length, count);
});

test("global mode retires stuck legacy switches without touching their windows", async (t) => {
  const f = await fixture(t);
  await f.manager.close();
  f.pool.switches.set("dev", {
    id: randomUUID(),
    state: "starting",
    pane: "%71",
    window: "@71",
  });
  const next = new SystemAccount(f.pool, { rpc: f.rpc });
  await next.init();
  t.after(() => next.close());
  assert.equal(f.pool.switches.get("dev").state, "cancelled");
  assert.equal(f.pool.switches.get("dev").pane, "%71");
});

test("refresh callback uses selected profile and refuses another accounts request", async (t) => {
  const f = await fixture(t);
  await f.manager.request(f.input);
  await settle(f.manager);
  f.pool.client = async (id) => {
    assert.equal(id, f.target.id);
    return {
      request: async (method) => {
        assert.equal(method, "account/read");
        return {};
      },
    };
  };
  await assert.rejects(f.manager.refreshTokens({ params: { previousAccountId: "other" } }));
  const reply = await f.manager.refreshTokens({ params: { previousAccountId: "target" } });
  assert.equal(reply.chatgptAccountId, "target");
  assert(!("refreshToken" in reply));
  const publicValue = JSON.stringify(await f.manager.status());
  assert(!publicValue.includes("PRIVATE_FIXTURE"));
  assert(!publicValue.includes("accessToken"));
});

test("open keyboard does not stall switching, but an in-flight message finishes first", async (t) => {
  const f = await fixture(t);
  f.pool.terminals.writers.set("fixture", {});
  f.setState("systemError");
  f.pool.terminals.accountDeliveryPending = () => true;
  await f.manager.request(f.input);
  await settle(f.manager);
  assert.equal(f.manager.data.job.state, "waiting");
  assert(!f.calls.includes("account/login/start"));
  f.pool.terminals.accountDeliveryPending = () => false;
  await f.manager.tick();
  assert.equal(f.manager.data.job.state, "complete");
});

test("late token refresh cannot overwrite a newly selected account", async (t) => {
  const f = await fixture(t);
  await f.manager.request(f.input);
  await settle(f.manager);
  let release;
  f.pool.client = async () => ({ request: () => new Promise((r) => (release = r)) });
  const refreshing = f.manager.refreshTokens({ params: { previousAccountId: "target" } });
  while (!release) await new Promise((r) => setTimeout(r, 1));
  f.manager.data.selected = null;
  release();
  await assert.rejects(refreshing);
  assert.equal(
    credential(JSON.parse(await readFile(f.home + "/auth.json", "utf8"))).accountId,
    "target",
  );
});
