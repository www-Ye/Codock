import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDesk } from "../server.mjs";
import { ChatInput } from "../lib/chat-input.mjs";
import { CodexStatus } from "../lib/codex-status.mjs";
const exec = promisify(execFile);
const binding = "123:456:11111111-1111-1111-1111-111111111111";
const entry = () => ({
  binding,
  identity: "test",
  text: "中文 hello\n第二行 $(not a command); `literal`",
});

test("post-paste proof stays within the verified pane, account and Codex process", async () => {
  for (const change of ["pane", "account", "process"]) {
    let pasted = false,
      enters = 0;
    const registry = {
      socket: "fixture",
      target: async () => ({ id: "$1" }),
      command: async (args) => {
        if (args[0] === "display-message")
          return `${pasted && change === "pane" ? "%2" : "%1"}\t123\t30\t0\t${pasted && change === "account" ? "other" : "original"}`;
        if (args[0] === "capture-pane") return pasted ? "› 测试\n tab to queue message" : "› ";
        if (args[0] === "paste-buffer") pasted = true;
        if (args[0] === "send-keys") enters++;
        return "";
      },
    };
    const input = new ChatInput(
      {
        registry,
        readBound: async () => ({ available: true, binding }),
        read: async (request) => {
          assert.equal(request.verifiedThread, binding.split(":")[2]);
          return { available: false, reason: "changed" };
        },
      },
      { writers: new Map() },
    );
    input.buffer = async () => {};
    assert.equal((await input.send("fixture", { ...entry(), text: "测试" })).state, "unknown");
    assert.equal(enters, 0, change);
  }
});

test("transient post-paste identity failure retries reads only and never replays a submitted draft", async () => {
  for (const manuallySubmitted of [false, true]) {
    let reads = 0,
      pastes = 0,
      enters = 0,
      footer = "› Ask Codex to do anything";
    const registry = {
      socket: "fixture",
      target: async () => ({ id: "$1" }),
      command: async (args) => {
        if (args[0] === "display-message") return "%1\t123\t30\t0";
        if (args[0] === "capture-pane") return footer;
        if (args[0] === "paste-buffer") {
          pastes++;
          footer = "› 测试原文";
        }
        if (args[0] === "send-keys") enters++;
        return "";
      },
    };
    const input = new ChatInput(
      {
        registry,
        read: async () => {
          if (++reads === 3) return { available: true, readOnly: true, binding };
          if (reads === 4 && manuallySubmitted) footer = "› Ask Codex to do anything";
          return { available: true, binding };
        },
      },
      { writers: new Map() },
    );
    input.buffer = async () => {};
    const result = await input.send("fixture", { ...entry(), text: "测试原文" });
    assert.equal(pastes, 1);
    assert.equal(enters, manuallySubmitted ? 0 : 1);
    assert.equal(result.state, manuallySubmitted ? "unknown" : "submitted");
  }
});

test("direct input blocks wrong thread, copy mode, approvals and competing writers; partial writes never retry", async () => {
  let commands = [],
    writes = 0,
    mode = "0",
    footer = "• Working (2s • esc to interrupt)\n› ",
    valid = true,
    reads = 0;
  const registry = {
    socket: "unused",
    target: async () => ({ id: "$1" }),
    command: async (args) => {
      commands.push(args);
      return args[0] === "capture-pane"
        ? footer
        : args[0] === "display-message"
          ? "%1\t123\t30\t" + mode
          : "";
    },
  };
  const chats = {
    registry,
    homeFromMeta: (meta) => {
      assert.equal(meta.split("\t")[0], "%1");
      return "/isolated-account";
    },
    read: async (request) => {
      assert.equal(request.home, "/isolated-account");
      reads++;
      return { available: valid, binding };
    },
  };
  const terminals = { writers: new Map() },
    input = new ChatInput(chats, terminals);
  input.buffer = async () => {
    writes++;
  };
  for (const invalid of ["mode", "approval", "unknown", "thread", "writer", "draft"]) {
    mode = invalid === "mode" ? "1" : "0";
    footer =
      invalid === "approval"
        ? "• Working (2s • esc to interrupt)\n› 1. Yes\nenter to confirm"
        : invalid === "unknown"
          ? "shell $"
          : invalid === "draft"
            ? "› /workspace/unfinished.txt"
            : "• Working (2s • esc to interrupt)\n› ";
    valid = invalid !== "thread";
    if (invalid === "writer") terminals.writers.set("sandbox", {});
    assert.equal((await input.send("sandbox", entry())).state, "failed", invalid);
    assert.equal(writes, 0);
    assert(!commands.some((a) => a[0] === "paste-buffer" || a[0] === "send-keys"));
    terminals.writers.clear();
    commands = [];
  }
  chats.read = async () => ({ available: true, readOnly: true, binding });
  assert.equal((await input.send("sandbox", entry())).state, "failed");
  assert.equal(writes, 0);
  assert(!commands.some((a) => a[0] === "paste-buffer" || a[0] === "send-keys"));
  commands = [];
  valid = true;
  footer = "• Working (2s • esc to interrupt)\n› ";
  reads = 0;
  chats.read = async () => ({ available: ++reads < 3, binding });
  assert.equal((await input.send("sandbox", entry())).state, "unknown");
  assert.equal(commands.filter((a) => a[0] === "paste-buffer").length, 1);
  assert.equal(commands.filter((a) => a[0] === "send-keys").length, 0);
  assert.equal(terminals.writers.size, 0);
  commands = [];
  chats.read = async (request) => {
    assert.equal(request.pane, "%1");
    assert.equal(request.socket, "unused");
    return { available: true, binding };
  };
  footer = "⠁ ⢀\n›⠁Ask Codex to do anything\n  ⠈ ⠠";
  assert.equal(
    (await input.send("sandbox", entry())).state,
    "submitted",
    "animated input is not rejected",
  );
  assert.equal(commands.filter((a) => a[0] === "send-keys").length, 1);
  commands = [];
  footer = "› ";
  registry.command = async (args) => {
    commands.push(args);
    if (args[0] === "paste-buffer") footer = "› " + entry().text.split(String.fromCharCode(10))[0];
    return args[0] === "capture-pane"
      ? footer
      : args[0] === "display-message"
        ? ["%1", "123", "30", "0"].join(String.fromCharCode(9))
        : "";
  };
  assert.equal(
    (await input.send("sandbox", entry())).state,
    "submitted",
    "just-pasted text is not a pre-existing draft",
  );
  assert.equal(commands.filter((a) => a[0] === "send-keys").length, 1);
});

test("model menu only opens from idle empty original Codex composer", async () => {
  let footer = "• Working (2s • esc to interrupt)\n› ",
    writes = 0,
    commands = [];
  const registry = {
    socket: "isolated",
    target: async () => ({ id: "$1" }),
    command: async (args) => {
      commands.push(args);
      if (args[0] === "paste-buffer") footer = "› /model";
      return args[0] === "capture-pane"
        ? footer
        : args[0] === "display-message"
          ? "%1\t123\t30\t0"
          : "";
    },
  };
  const input = new ChatInput(
    { registry, read: async () => ({ available: true, binding }) },
    { writers: new Map() },
  );
  input.buffer = async () => {
    writes++;
  };
  const model = { ...entry(), text: "/model", transport: "terminal-model" };
  assert.equal((await input.send("sandbox", model)).state, "failed");
  assert.equal(writes, 0);
  footer = "› unfinished";
  assert.equal((await input.send("sandbox", model)).state, "failed");
  assert.equal(writes, 0);
  footer = "› 1. Approve\nPress enter to confirm";
  assert.equal((await input.send("sandbox", model)).state, "failed");
  assert.equal(writes, 0);
  footer = "› ";
  commands = [];
  assert.equal((await input.send("sandbox", model)).state, "submitted");
  assert.equal(writes, 1);
  assert.equal(commands.filter((args) => args[0] === "send-keys").length, 1);
});

test("long pasted composer hidden above footer submits once only with fresh text-tail proof", async () => {
  const text =
    "\n" +
    Array.from({ length: 59 }, (_, i) => `第 ${i + 1} 行用于验证长消息不会意外变成终端命令`).join(
      "\n",
    ) +
    "\n这是最后一行且内容足够长用于精确核对是否已粘贴成功";
  let footer = "› ",
    enters = 0,
    showTail = true;
  const registry = {
    socket: "isolated",
    target: async () => ({ id: "$1" }),
    command: async (args) => {
      if (args[0] === "display-message") return "%1\t123\t22\t0";
      if (args[0] === "capture-pane") return footer;
      if (args[0] === "paste-buffer") {
        footer = showTail ? text.split("\n").slice(-18).join("\n") : "与这条消息无关的终端画面";
        return "";
      }
      if (args[0] === "send-keys" && args[3] === "Enter") enters++;
      return "";
    },
  };
  const input = new ChatInput(
    { registry, read: async () => ({ available: true, binding }) },
    { writers: new Map() },
  );
  input.buffer = async () => {};
  assert.equal((await input.send("sandbox", { ...entry(), text })).state, "submitted");
  assert.equal(enters, 1);
  footer = "› ";
  showTail = false;
  assert.equal((await input.send("sandbox", { ...entry(), text })).state, "unknown");
  assert.equal(enters, 1, "missing paste evidence must never press Enter");
});

test(
  "authenticated HTTP → exact user text and one Enter, no queue or session prefix",
  { timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/di-"),
      socket = dir + "/t.sock",
      record = dir + "/received.json";
    const fixture = fileURLToPath(new URL("./terminal-input.py", import.meta.url));
    const tmux = (args) =>
      exec("tmux", ["-S", socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: "" } });
    await tmux([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "sandbox",
      "-x",
      "120",
      "-y",
      "30",
      `exec python3 -B '${fixture}' '${record}' --animated`,
    ]);
    t.after(() => tmux(["kill-server"]).catch(() => {}));
    for (let n = 0; n < 30; n++) {
      if ((await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout.includes("Ask Codex")) break;
      await delay(30);
    }
    let statusProofs = 0;
    const desk = await createDesk({
      runtime: dir + "/runtime",
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
      socket,
      projectRoot: dir,
      allowed: ["sandbox"],
      secure: false,
      chatDependencies: {
        read: async (input) => ({
          available: true,
          readOnly: !input.verifiedThread,
          binding,
          revision: "1",
          messages: [],
          before: null,
        }),
        status: {
          probe: async (_name, _identity, { expectedMeta }) => {
            statusProofs++;
            const [pane, pid] = expectedMeta.split("\t");
            return { thread: binding.split(":")[2], pane, pid: Number(pid), meta: expectedMeta };
          },
        },
      },
    });
    await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const cookie = desk.auth.cookie(desk.auth.issue({ login: "isolated-fixture" })).split(";")[0];
    const identity = (await desk.registry.list())[0].identity;
    const message = {
      ...entry(),
      identity,
      requestId: randomUUID(),
      confirm: true,
      transport: "terminal-enter",
    };
    const post = () =>
      fetch(origin + "/api/sessions/sandbox/chat", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(message),
      }).then((r) => r.json());
    assert.equal((await post()).state, "submitted");
    let records;
    for (let n = 0; n < 30; n++) {
      try {
        records = JSON.parse(await readFile(record, "utf8"));
        break;
      } catch {
        await delay(30);
      }
    }
    assert.deepEqual(records, [{ text: message.text, submitted: true }]);
    assert(statusProofs >= 2, "page and send each establish a current-thread proof");
    assert.equal((await post()).state, "submitted");
    await delay(50);
    assert.equal(JSON.parse(await readFile(record, "utf8")).length, 1);
    const model = {
      ...message,
      requestId: randomUUID(),
      text: "/model",
      transport: "terminal-model",
    };
    const postModel = () =>
      fetch(origin + "/api/sessions/sandbox/chat", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(model),
      }).then((r) => r.json());
    assert.equal((await postModel()).state, "submitted");
    assert.equal((await postModel()).state, "submitted");
    for (let n = 0; n < 30; n++) {
      records = JSON.parse(await readFile(record, "utf8"));
      if (records.length === 2) break;
      await delay(30);
    }
    assert.deepEqual(records, [
      { text: message.text, submitted: true },
      { text: "/model", submitted: true },
    ]);
    const native = { ...message, requestId: randomUUID(), text: "/status" };
    const nativeResult = await fetch(origin + "/api/sessions/sandbox/chat", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(native),
    }).then((r) => r.json());
    assert.equal(nativeResult.state, "submitted");
    for (let n = 0; n < 30; n++) {
      records = JSON.parse(await readFile(record, "utf8"));
      if (records.length === 3) break;
      await delay(30);
    }
    assert.equal(records[2].text, "/status", "a hand-typed native command stays intact");
    const view = await (
      await fetch(origin + "/api/sessions/sandbox/chat?identity=" + encodeURIComponent(identity), {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(view.sendMode, "terminal-enter");
    assert.equal(view.outbox.length, 2);
    assert.equal(view.outbox[0].text, message.text);
    assert.equal(view.outbox[0].state, "submitted");
    assert.equal(
      (await tmux(["list-buffers"])).stdout.trim(),
      "",
      "temporary paste buffer removed",
    );
    assert.equal(
      (
        await tmux(["display-message", "-p", "-t", "sandbox", "#{window_width}x#{window_height}"])
      ).stdout.trim(),
      "120x30",
    );
  },
);

test(
  "HTTP → native footer verification survives typing and history hints, exactly one Enter",
  { timeout: 20000 },
  async (t) => {
    for (const history of [false, true, "hidden"])
      await t.test(
        history === "hidden"
          ? "typing hides identity"
          : history
            ? "history browsing"
            : "empty composer",
        async (t) => {
          const dir = await mkdtemp(process.env.TMPDIR + "/footer-"),
            socket = dir + "/t.sock",
            record = dir + "/received.json";
          const fixture = fileURLToPath(new URL("./terminal-input.py", import.meta.url));
          const tmux = (args) =>
            exec("tmux", ["-S", socket, ...args], {
              timeout: 5000,
              env: { ...process.env, TMUX: "" },
            });
          await tmux([
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            "sandbox",
            "-x",
            "120",
            "-y",
            "30",
            `exec python3 -B '${fixture}' '${record}' --context${history === "hidden" ? " --hidden-footer" : history ? " --history" : ""}`,
          ]);
          t.after(() => tmux(["kill-server"]).catch(() => {}));
          for (let n = 0; n < 30; n++) {
            if (
              (await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout.includes("GPT-6.1-Sol")
            )
              break;
            await delay(30);
          }
          let native;
          const desk = await createDesk({
            runtime: dir + "/runtime",
            codexHome: dir + "/runtime" + "/codex",
            claudeHome: dir + "/runtime" + "/claude",
            socket,
            projectRoot: dir,
            allowed: ["sandbox"],
            secure: false,
            chatDependencies: {
              read: async (input) => ({
                available: true,
                readOnly: !input.verifiedThread,
                binding,
                revision: "1",
                messages: [],
                before: null,
              }),
              status: { probe: (...args) => native.probe(...args) },
            },
          });
          native = new CodexStatus(desk.registry, null, {
            home: desk.config.codexHome,
            daemon: {
              snapshot: async () => [
                {
                  id: binding.split(":")[2],
                  name: "sandbox",
                  cwd: "/workspace",
                  source: "cli",
                  parentThreadId: null,
                },
              ],
            },
          });
          const captures = [],
            keys = [],
            command = desk.registry.command.bind(desk.registry);
          desk.registry.command = async (args, ...rest) => {
            if (args[0] === "send-keys") keys.push(args);
            const result = await command(args, ...rest);
            if (args[0] === "capture-pane") captures.push(result);
            return result;
          };
          await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
          t.after(() => desk.close());
          const origin = "http://127.0.0.1:" + desk.server.address().port;
          desk.config.origin = origin;
          const cookie = desk.auth
            .cookie(desk.auth.issue({ login: "isolated-fixture" }))
            .split(";")[0];
          const identity = (await desk.registry.list())[0].identity;
          const message = {
            ...entry(),
            identity,
            requestId: randomUUID(),
            confirm: true,
            transport: "terminal-enter",
          };
          const post = () =>
            fetch(origin + "/api/sessions/sandbox/chat", {
              method: "POST",
              headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
              body: JSON.stringify(message),
            }).then((r) => r.json());
          const result = await post();
          assert.equal(result.state, "submitted", JSON.stringify(result));
          let records;
          for (let n = 0; n < 30; n++) {
            try {
              records = JSON.parse(await readFile(record, "utf8"));
              break;
            } catch {
              await delay(30);
            }
          }
          assert.deepEqual(records, [{ text: message.text, submitted: true }]);
          assert(
            captures.some(
              (screen) =>
                screen.includes(message.text.split("\n")[1]) &&
                screen.includes(history === "hidden" ? "tab to queue message" : "GPT-6.1-Sol") &&
                !screen.includes("? for shortcuts"),
            ),
            "verify the actual pasted composer without shortcuts",
          );
          assert.deepEqual(
            keys.map((args) => args.slice(3)),
            [["Enter"]],
            "no /status, no extra Enter",
          );
          assert.equal((await post()).state, "submitted");
          await delay(50);
          assert.equal(
            JSON.parse(await readFile(record, "utf8")).length,
            1,
            "repeating HTTP request does not repeat input",
          );
          assert.equal(keys.length, 1);
        },
      );
  },
);
