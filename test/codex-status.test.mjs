import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CodexStatus, focusedThread } from "../lib/codex-status.mjs";
import { Chats } from "../lib/chat.mjs";
import { ChatSender } from "../lib/chat-send.mjs";
import { ChatInput } from "../lib/chat-input.mjs";
import { observeTerminal } from "../lib/terminal-status.mjs";

const thread = "11111111-1111-1111-1111-111111111111";
const metadata = {
  id: thread,
  name: "work",
  cwd: "/workspace",
  source: "cli",
  parentThreadId: null,
};
const footer = (name = "work", draft = "") =>
  `› ${draft || "Ask Codex to do anything"}\n\n  GPT-6.1-Sol xhigh · /workspace · ${name}\n  ← for agents · ? for shortcuts`;

test("chat reads the account from its pane snapshot and rejects an account change mid-read", async () => {
  let account = "a_first",
    change = false,
    reads = 0;
  const registry = {
    target: async () => ({ id: "$1" }),
    command: async (args) => (args[0] === "display-message" ? `%1\t123\t30\t0\t${account}` : "› "),
  };
  const chats = new Chats(registry, {
    read: async (input) => {
      reads++;
      assert.equal(input.home, "/accounts/a_first");
      if (change) account = "a_second";
      return { available: true, binding: "123:456:" + thread, messages: [] };
    },
  });
  chats.homeFromMeta = (meta) => "/accounts/" + meta.split("\t")[4];
  assert.equal(
    (await chats.page("work", new URLSearchParams({ identity: "stable" }))).available,
    true,
  );
  assert.equal(reads, 1);
  change = true;
  await assert.rejects(chats.page("work", new URLSearchParams({ identity: "stable" })), {
    status: 409,
  });
});
function fixture({ draft = "", mode = "0", threads = [metadata], switchTo = null } = {}) {
  let captures = 0;
  const calls = [];
  const registry = {
    target: async () => ({ id: "$1" }),
    command: async (args) => {
      calls.push(args);
      if (args[0] === "display-message") return `%1\t123\t30\t${mode}`;
      if (args[0] === "capture-pane")
        return footer(++captures > 1 && switchTo ? switchTo : "work", draft);
      throw Error("An identity reader must never mutate tmux");
    },
  };
  return { registry, calls, daemon: { snapshot: async () => threads } };
}

test("passive identity reads current daemon metadata and footer without keys or input leases", async () => {
  for (const draft of ["", "unfinished text", "/status", "a\nvery long\nmultiline draft"]) {
    const f = fixture({ draft }),
      writers = new Map([["work", { chat: true }]]),
      lease = writers.get("work");
    const result = await new CodexStatus(f.registry, writers, { daemon: f.daemon }).probe(
      "work",
      "identity",
    );
    assert.equal(result.thread, thread);
    assert.equal(result.pane, "%1");
    assert(f.calls.every((args) => ["display-message", "capture-pane"].includes(args[0])));
    assert.equal(writers.get("work"), lease, "passive reads cannot compete with a chat paste");
  }
});

test("passive identity refuses copy mode, duplicate names, missing threads and foreground changes", async () => {
  for (const options of [
    { mode: "1" },
    { threads: [] },
    { threads: [metadata, { ...metadata, id: "22222222-2222-2222-2222-222222222222" }] },
    {
      switchTo: "other",
      threads: [
        metadata,
        { ...metadata, name: "other", id: "22222222-2222-2222-2222-222222222222" },
      ],
    },
  ]) {
    const f = fixture(options),
      writers = new Map(),
      status = new CodexStatus(f.registry, writers, { daemon: f.daemon });
    await assert.rejects(() => status.probe("work", "identity"), { status: 409 });
    assert.equal(writers.size, 0);
    assert(f.calls.every((args) => ["display-message", "capture-pane"].includes(args[0])));
  }
});

test("footer match is exact and never selects a status card, substring, child agent or duplicate", () => {
  const rows = [metadata];
  assert.equal(focusedThread(footer(), rows), thread);
  assert.equal(focusedThread(footer() + "\n", rows), thread);
  assert.equal(
    focusedThread(footer() + "\n   \n".repeat(40), rows),
    thread,
    "blank terminal padding must not hide the footer",
  );
  assert.equal(
    focusedThread(footer() + "\n› another input\n" + "\n".repeat(40), rows),
    null,
    "padding removal cannot select an identity above a newer composer",
  );
  assert.equal(focusedThread(footer("work · Main [default]"), rows), thread);
  for (const name of [
    "work · ← for agents",
    "work · ← for agents · ? for shortcuts",
    "work · Main [default] · ← for agents",
  ])
    assert.equal(
      focusedThread(footer(name), rows),
      thread,
      "compact footer navigation must not lock chat input",
    );
  for (const name of [
    "work · Main [default] · ← for… Goal hit usage limits (/goal resume)",
    "work · Main [default] · ← for…",
    "work · ← for agents · ? for short… Goal paused (/goal resume)",
  ])
    assert.equal(
      focusedThread(footer(name), rows),
      thread,
      "elided navigation and adjacent goal badges do not change the foreground thread",
    );
  for (const name of [
    "work… · Main [default] · ← for…",
    "work · Worker · ← for… Goal hit usage limits (/goal resume)",
    "work · Main [def… · ← for…",
    "work · Unknown… Goal paused (/goal resume)",
  ])
    assert.equal(
      focusedThread(footer(name), rows),
      null,
      "only known navigation may be elided; identity and role remain exact",
    );
  assert.equal(focusedThread(footer("work · Worker · ← for agents"), rows), null);
  assert.equal(
    focusedThread(
      footer("work · Main [default]").replace("GPT-6.1-Sol xhigh", "GPT-6-Astra xhigh fast"),
      rows,
    ),
    thread,
    "fast service tier must not make a verified foreground thread readonly",
  );
  assert.equal(
    focusedThread(
      footer("work").replace("work\n", "work       Goal paused (/goal resume)\n"),
      rows,
    ),
    thread,
  );
  for (const screen of [
    `│ Session: ${thread} │\n› Ask Codex to do anything`,
    footer("work…"),
    footer("work · Worker"),
    footer().replace("/workspace", "/other"),
  ])
    assert.equal(focusedThread(screen, rows), null);
  assert.equal(
    focusedThread("  GPT-6.1-Sol xhigh · /workspace · work\n› Ask Codex to do anything\n", rows),
    null,
    "quoted output above composer is not identity",
  );
  assert.equal(
    focusedThread(
      "long pasted tail\n  GPT-6.1-Sol xhigh · /workspace · work\n  ← for agents · ? for shortcuts",
      rows,
    ),
    thread,
    "long pasted composer may have its chevron above the capture",
  );
  assert.equal(
    focusedThread(
      "› 继续\n\n  GPT-6.1-Sol xhigh · /workspace · work\n      ⚠ 2 warnings · f2 to view\n",
      rows,
    ),
    thread,
    "typing hides shortcuts, not thread identity",
  );
  assert.equal(
    focusedThread(
      "› Ask Codex to do anything\n\n  GPT-6.1-Sol xhigh · /workspace · work\n  New activity · Earlier messages available. enter/esc latest · ? shortcuts\n",
      rows,
    ),
    thread,
    "native history browsing changes shortcuts, not identity",
  );
  assert.equal(focusedThread(footer(), [{ ...metadata, parentThreadId: thread }]), null);
  assert.equal(
    focusedThread(footer(), [
      metadata,
      { ...metadata, id: "22222222-2222-2222-2222-222222222222" },
    ]),
    null,
  );
});

test("resized pane padding does not lock identity, runtime state or the input target", async () => {
  const screen = ("earlier output\n".repeat(15) + footer() + "\n".repeat(60)).split("\n");
  const meta = `%1\t123\t${screen.length}\t0`,
    binding = `456:789:${thread}`,
    calls = [];
  const registry = {
    socket: "isolated",
    target: async () => ({ id: "$1" }),
    command: async (args) => {
      calls.push(args);
      if (args[0] === "display-message") return meta;
      if (args[0] === "capture-pane")
        return screen
          .slice(Number(args[args.indexOf("-S") + 1]), Number(args[args.indexOf("-E") + 1]) + 1)
          .join("\n");
      throw Error("This check must not type into the terminal");
    },
  };
  const writers = new Map(),
    status = new CodexStatus(registry, writers, { daemon: { snapshot: async () => [metadata] } });
  const read = async (input) => ({
    available: true,
    binding,
    readOnly: !input.verifiedThread,
    messages: [],
  });
  const chats = new Chats(registry, { read, status });
  assert.equal(
    (await chats.page("work", new URLSearchParams({ identity: "identity" }))).readOnly,
    false,
  );
  assert.equal((await observeTerminal(registry, meta)).state, "ready");
  const target = await new ChatInput(chats, { writers }).target("work", {
    identity: "identity",
    binding,
  });
  assert.equal(target.pane, "%1");
  assert(calls.every((args) => ["display-message", "capture-pane"].includes(args[0])));
});

test("daemon errors leave saved history readonly and cannot inject a fallback command", async () => {
  const f = fixture(),
    binding = `456:789:${thread}`;
  f.daemon.snapshot = async () => {
    throw Error("offline");
  };
  const read = async (input) => ({
    available: true,
    binding,
    readOnly: !input.verifiedThread,
    messages: [],
  });
  const chats = new Chats(f.registry, {
    read,
    status: new CodexStatus(f.registry, new Map(), { daemon: f.daemon }),
  });
  const view = await chats.page("work", new URLSearchParams({ identity: "identity" }));
  assert.equal(view.readOnly, true);
  assert(f.calls.every((args) => ["display-message", "capture-pane"].includes(args[0])));
});

test("passive CLI history is writable; fresh reads and sends recheck thread without cached proofs", async () => {
  const meta = "%1\t123\t30\t0",
    binding = `456:789:${thread}`,
    identity = "session-identity";
  let focused = thread,
    probes = 0,
    deliveries = 0;
  const registry = {
    socket: "isolated",
    target: async () => ({ id: "$1" }),
    command: async (args) => (args[0] === "display-message" ? meta : "› "),
  };
  const status = {
    probe: async () => {
      probes++;
      return { thread: focused, pane: "%1", pid: 123, meta };
    },
  };
  const read = async (input) => {
    const current = `456:789:${input.verifiedThread || thread}`;
    return input.binding && input.binding !== current
      ? { available: false, reason: "changed" }
      : {
          available: true,
          binding: current,
          readOnly: !input.verifiedThread,
          revision: "1",
          messages: [],
          before: null,
        };
  };
  const chats = new Chats(registry, { read, status });
  const page = await chats.page("work", new URLSearchParams({ identity }));
  assert.equal(page.readOnly, false);
  assert.equal(page.sendMode, "terminal-enter");
  assert.equal(probes, 1);
  const runtime = await mkdtemp(process.env.TMPDIR + "/status-send-");
  const sender = new ChatSender(chats, runtime, {
    deliver: async () => {
      deliveries++;
      return { state: "submitted" };
    },
  });
  const make = () => ({
    requestId: randomUUID(),
    identity,
    binding,
    text: "请继续",
    confirm: true,
    transport: "terminal-enter",
  });
  assert.equal((await sender.send("work", make())).state, "submitted");
  assert(probes >= 3);
  assert.equal(deliveries, 1);
  const before = probes;
  await chats.page("work", new URLSearchParams({ identity, binding, before: "1" }));
  assert(probes > before, "pagination also observes the current thread, not a stale proof");
  focused = "22222222-2222-2222-2222-222222222222";
  const wrong = make();
  await assert.rejects(() => sender.send("work", wrong), { status: 409 });
  assert.equal(deliveries, 1);
  await assert.rejects(() => stat(sender.file(wrong.requestId)), { code: "ENOENT" });
});
