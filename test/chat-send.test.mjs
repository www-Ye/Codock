import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
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

test("stale history branch cannot send to the current branch", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/branch-send-");
  let calls = 0;
  const sender = new ChatSender(
    { page: async () => ({ available: true, binding, historyVersion: "new" }) },
    runtime,
    {
      deliver: async (_name, entry) => {
        calls++;
        assert.equal(entry.historyVersion, "new");
        return { state: "submitted" };
      },
    },
  );
  await assert.rejects(sender.send("sandbox", { ...message(), historyVersion: "old" }), {
    status: 409,
  });
  assert.equal(calls, 0);
  await sender.send("sandbox", { ...message(), historyVersion: "new" });
  assert.equal(calls, 1);
});

test("receipt ownership index keeps states fresh and discovers new files without leaking other sessions", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/receipt-index-");
  const sender = new ChatSender({}, runtime, {
    deliver: async () => {
      throw Error("must not send");
    },
  });
  await mkdir(sender.directory);
  const entry = { ...message(), name: "sandbox", created: Date.now(), state: "failed" };
  const other = { ...entry, requestId: randomUUID(), name: "other" };
  await writeFile(sender.file(entry.requestId), JSON.stringify(entry));
  await writeFile(sender.file(other.requestId), JSON.stringify(other));
  assert.deepEqual(
    (await sender.recent("sandbox", entry.identity, binding)).map((e) => e.requestId),
    [entry.requestId],
  );
  // Another instance can amend a receipt; the index must not cache its payload.
  await writeFile(
    sender.file(entry.requestId),
    JSON.stringify({ ...entry, dismissedAt: Date.now() }),
  );
  const newer = { ...entry, requestId: randomUUID(), created: entry.created + 1 };
  await writeFile(sender.file(newer.requestId), JSON.stringify(newer));
  assert.deepEqual(
    (await sender.recent("sandbox", entry.identity, binding)).map((e) => e.requestId),
    [newer.requestId],
  );
  assert.deepEqual(await sender.recent("sandbox", "different-identity", binding), []);
});

test("missing receipt recovery durably blocks a late original request, including restart", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/recover-");
  let calls = 0;
  const chats = { page: async () => ({ available: true, binding }) },
    input = message();
  const sender = new ChatSender(chats, runtime, {
    deliver: async () => {
      calls++;
      return { state: "submitted" };
    },
  });
  assert.equal(typeof sender.recover, "function", "missing receipts need explicit safe recovery");
  assert.equal((await sender.recover("sandbox", input.requestId, input)).state, "failed");
  assert.equal((await sender.send("sandbox", input)).state, "failed");
  const restarted = new ChatSender(chats, runtime, {
    deliver: async () => {
      calls++;
    },
  });
  assert.equal((await restarted.send("sandbox", input)).state, "failed");
  assert.equal(calls, 0);
  assert.deepEqual(await sender.recent("sandbox", input.identity, binding), []);
  await assert.rejects(
    () => sender.recover("sandbox", input.requestId, { ...input, identity: "wrong" }),
    { status: 404 },
  );
});

test("recovery cannot cancel an active preflight or an already touched terminal", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/race-");
  let release,
    calls = 0;
  const chats = { page: () => new Promise((r) => (release = r)) },
    input = message();
  const sender = new ChatSender(chats, runtime, {
    deliver: async () => {
      calls++;
      return { state: "unknown" };
    },
  });
  assert.equal(typeof sender.recover, "function");
  const sending = sender.send("sandbox", input);
  while (!release) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(() => sender.recover("sandbox", input.requestId, input), { status: 409 });
  release({ available: true, binding });
  await sending;
  chats.page = async () => ({ available: true, binding, messages: [] });
  assert.equal((await sender.recover("sandbox", input.requestId, input)).state, "unknown");
  assert.equal(calls, 1);
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
  sender.chats.page = async () => ({ available: true, readOnly: true, binding });
  const unverified = message();
  await assert.rejects(() => sender.send("sandbox", unverified), { status: 409 });
  await assert.rejects(() => stat(sender.file(unverified.requestId)), { code: "ENOENT" });
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

test("submitted receipt outside the current page reconciles exact saved history once", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/older-receipt-");
  let lookups = 0,
    accepted = false;
  const chats = {
    page: async (_name, _query, options) =>
      options?.lookup
        ? (lookups++,
          {
            available: true,
            binding,
            matches: accepted
              ? [{ id: "36659", role: "user", text: options.lookup.text, time: Date.now() - 45000 }]
              : [],
          })
        : { available: true, binding },
  };
  const sender = new ChatSender(chats, runtime, { deliver: async () => ({ state: "submitted" }) });
  const input = message();
  await sender.send("sandbox", input);
  const file = sender.file(input.requestId),
    entry = JSON.parse(await readFile(file, "utf8"));
  entry.created = Date.now() - 60000;
  await writeFile(file, JSON.stringify(entry));
  const later = [{ id: "37541", role: "user", text: "后来一条", time: Date.now() - 5000 }];
  assert.equal(
    (await sender.recent("sandbox", input.identity, binding, later)).length,
    1,
    "no match remains visible",
  );
  assert.equal((await sender.recent("sandbox", input.identity, binding, later)).length, 1);
  assert.equal(lookups, 1, "negative lookup is bounded during active polling");
  sender.lookupMiss.clear();
  accepted = true;
  assert.deepEqual(await sender.recent("sandbox", input.identity, binding, later), []);
  assert.equal((await readFile(file, "utf8")).includes('"observed":"36659"'), true);
  assert.deepEqual(
    await sender.recent("sandbox", input.identity, binding, later),
    [],
    "confirmed older receipt never reappears",
  );
});

test("owner-confirmed unresolved receipt release persists without resending or hiding its text", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/release-");
  let calls = 0;
  const chats = { page: async () => ({ available: true, binding, messages: [] }) };
  const sender = new ChatSender(chats, runtime, {
    deliver: async () => {
      calls++;
      return { state: "unknown", deliveryStage: "verify-before-enter" };
    },
  });
  const input = message(),
    scope = { identity: input.identity, binding, confirmRelease: true };
  assert.equal((await sender.send("sandbox", input)).state, "unknown");
  await assert.rejects(
    () => sender.release("sandbox", input.requestId, { ...scope, confirmRelease: false }),
    { status: 409 },
  );
  await assert.rejects(
    () => sender.release("sandbox", input.requestId, { ...scope, identity: "wrong" }),
    { status: 404 },
  );
  assert.equal((await sender.release("sandbox", input.requestId, scope)).state, "released");
  assert.equal((await sender.status("sandbox", input.requestId, scope)).state, "released");
  const visible = await sender.recent("sandbox", input.identity, binding);
  assert.equal(visible[0].text, input.text);
  assert.equal(visible[0].state, "released");
  const restarted = new ChatSender(chats, runtime, {
    deliver: () => {
      throw Error("must not resend");
    },
  });
  assert.equal((await restarted.send("sandbox", input)).state, "released");
  assert.equal(calls, 1);
  assert.equal((await restarted.release("sandbox", input.requestId, scope)).state, "released");
});

test("model menu permits only exact /model, durable once and never appears as a chat bubble", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/model-");
  let calls = 0;
  const chats = { page: async () => ({ available: true, binding, messages: [] }) };
  const sender = new ChatSender(chats, runtime, {
    deliver: async (name, entry) => {
      assert.equal(name, "sandbox");
      assert.equal(entry.transport, "terminal-model");
      assert.equal(entry.text, "/model");
      calls++;
      return { state: "submitted" };
    },
  });
  const model = { ...message(), text: "/model", transport: "terminal-model" };
  await assert.rejects(() => sender.send("sandbox", { ...model, text: "/permissions" }), {
    status: 400,
  });
  assert.equal((await sender.send("sandbox", model)).state, "submitted");
  assert.equal((await sender.send("sandbox", model)).state, "submitted");
  assert.equal(calls, 1);
  await assert.rejects(() => sender.send("sandbox", { ...model, transport: "terminal-enter" }), {
    status: 409,
  });
  assert.deepEqual(await sender.recent("sandbox", model.identity, binding), []);
  const restarted = new ChatSender(chats, runtime, {
    deliver: () => {
      throw Error("must not repeat /model");
    },
  });
  assert.equal((await restarted.send("sandbox", model)).state, "submitted");
});
