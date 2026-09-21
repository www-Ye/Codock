import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ChatSender } from "../lib/chat-send.mjs";

const binding = "123:456:11111111-1111-1111-1111-111111111111";
const message = () => ({
  requestId: randomUUID(),
  identity: "session-identity",
  binding,
  text: "请继续原来的任务\n第二行",
  confirm: true,
  transport: "terminal-enter",
});

test("original terminal bridge: only verified thread, exact text, durable dedupe and restart ambiguity", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/sender-");
  let called = 0;
  const chats = {
    page: async (name, q) => {
      assert.equal(name, "sandbox");
      assert.equal(q.get("binding"), binding);
      return { available: true, binding };
    },
  };
  const sender = new ChatSender(chats, runtime, {
    deliver: async (name, entry) => {
      const { text } = entry;
      called++;
      assert.equal(name, "sandbox");
      assert.equal(entry.binding, binding);
      assert.equal(text, "请继续原来的任务\n第二行");
      return { state: "submitted" };
    },
  });
  const input = message(),
    one = await sender.send("sandbox", input);
  assert.equal(one.state, "submitted");
  assert.equal(called, 1);
  assert.equal((await sender.send("sandbox", input)).state, "submitted");
  assert.equal(called, 1);
  await assert.rejects(() => sender.send("sandbox", { ...input, text: "另一条消息" }), {
    status: 409,
  });
  const restarted = new ChatSender(chats, runtime, {
    deliver: () => {
      throw Error("must not resend");
    },
  });
  assert.equal((await restarted.send("sandbox", input)).state, "submitted");
  assert.equal((await restarted.status("sandbox", input.requestId)).state, "submitted");
  await assert.rejects(() => restarted.status("other", input.requestId), { status: 404 });
  assert.equal((await stat(sender.file(input.requestId))).mode & 0o777, 0o600);
  assert(!("text" in one), "receipt never echoes a prompt");
  assert.equal((await sender.recent("sandbox", input.identity, binding))[0].text, input.text);
  assert.deepEqual(await sender.recent("other", input.identity, binding), []);
  assert.deepEqual(await sender.recent("sandbox", "wrong-identity", binding), []);
  const saved = [{ id: "100", role: "user", text: input.text, time: one.created + 10 }];
  assert.deepEqual(await sender.recent("sandbox", input.identity, binding, saved), []);
  assert.deepEqual(
    await restarted.recent("sandbox", input.identity, binding),
    [],
    "observed message never reappears after refresh or restart",
  );
  const pending = message();
  let release;
  sender.deliver = () => new Promise((r) => (release = r));
  const waiting = sender.send("sandbox", pending);
  for (let n = 0; !release && n < 50; n++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await sender.status("sandbox", pending.requestId)).state, "sending");
  await assert.rejects(
    () => sender.dismiss("sandbox", pending.requestId, { identity: pending.identity, binding }),
    { status: 409 },
  );
  assert.equal((await restarted.status("sandbox", pending.requestId)).state, "unknown");
  assert.equal((await restarted.send("sandbox", pending)).state, "unknown");
  release({ state: "submitted" });
  await waiting;
});

test("terminal sender rejects unsupported identity, missing confirmation, controls, oversized input; errors never retry", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/sender-");
  let calls = 0;
  const sender = new ChatSender({ page: async () => ({ available: false }) }, runtime, {
    deliver: async () => {
      calls++;
    },
  });
  await assert.rejects(() => sender.send("sandbox", message()), { status: 409 });
  assert.equal(calls, 0);
  await assert.rejects(() => sender.send("sandbox", { ...message(), transport: undefined }), {
    status: 409,
  });
  for (const change of [
    { confirm: false },
    { text: "\x1bexit\r" },
    { text: "x".repeat(12001) },
    { requestId: "../outside" },
  ])
    await assert.rejects(() => sender.send("sandbox", { ...message(), ...change }), {
      status: 400,
    });
  sender.chats.page = async () => ({ available: true, binding });
  sender.deliver = async () => {
    calls++;
    throw Error("uncertain native result");
  };
  const input = message();
  assert.equal((await sender.send("sandbox", input)).state, "unknown");
  assert.equal((await sender.send("sandbox", input)).state, "unknown");
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(sender.file(input.requestId), "utf8")).state, "unknown");
});

test("dismiss failed receipts only: scoped, durable, recoverable and still deduplicated", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/dismiss-unit-");
  let calls = 0;
  const chats = { page: async () => ({ available: true, binding }) };
  const sender = new ChatSender(chats, runtime, {
    deliver: async () => {
      calls++;
      return { state: "failed", message: "fixture refusal" };
    },
  });
  const input = message(),
    scope = { identity: input.identity, binding };
  await sender.send("sandbox", input);
  for (const [name, change] of [
    ["other", {}],
    ["sandbox", { identity: "wrong" }],
    ["sandbox", { binding: "wrong" }],
  ]) {
    await assert.rejects(() => sender.dismiss(name, input.requestId, { ...scope, ...change }), {
      status: 404,
    });
  }
  assert.equal((await sender.dismiss("sandbox", input.requestId, scope)).dismissed, true);
  assert.deepEqual(await sender.recent("sandbox", input.identity, binding), []);
  const kept = JSON.parse(await readFile(sender.file(input.requestId), "utf8"));
  assert.equal(kept.text, input.text);
  assert(kept.dismissedAt);
  assert.equal(kept.state, "failed");
  assert.equal((await stat(sender.file(input.requestId))).mode & 0o777, 0o600);
  const restarted = new ChatSender(chats, runtime, {
    deliver: () => {
      throw Error("Must never redeliver dismissed ID");
    },
  });
  assert.deepEqual(await restarted.recent("sandbox", input.identity, binding), []);
  assert.equal((await restarted.dismiss("sandbox", input.requestId, scope)).dismissed, true);
  assert.equal((await restarted.send("sandbox", input)).state, "failed");
  assert.equal(calls, 1);
  for (const state of ["submitted", "unknown", "queued"]) {
    sender.deliver = async () => ({ state });
    const other = message();
    await sender.send("sandbox", other);
    await assert.rejects(() => sender.dismiss("sandbox", other.requestId, scope), { status: 409 });
  }
});

test("unknown receipt reconciles from exact same-thread history without resending", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/rc-unit-");
  let accepted = false,
    calls = 0,
    input;
  const chats = {
    page: async (name, q, options) => {
      assert.equal(name, "sandbox");
      assert.equal(q.get("binding"), binding);
      if (options?.lookup) {
        assert.equal(options.lookup.text, input.text);
        return {
          available: true,
          binding,
          matches: accepted ? [{ id: "77", role: "user", time: Date.now(), text: input.text }] : [],
        };
      }
      return { available: true, binding };
    },
  };
  const sender = new ChatSender(chats, runtime, {
    deliver: async () => {
      calls++;
      return { state: "unknown", message: "回车未确认" };
    },
  });
  input = message();
  assert.equal((await sender.send("sandbox", input)).state, "unknown");
  assert.equal((await sender.status("sandbox", input.requestId)).state, "unknown");
  accepted = true;
  const result = await sender.status("sandbox", input.requestId);
  assert.equal(result.state, "submitted");
  assert.equal(result.observed, "77");
  assert.equal((await sender.send("sandbox", input)).state, "submitted");
  assert.equal(calls, 1);
  assert.deepEqual(await sender.recent("sandbox", input.identity, binding), []);
  assert.equal(
    JSON.parse(await readFile(sender.file(input.requestId), "utf8")).reconciledFrom,
    "unknown",
  );
});
