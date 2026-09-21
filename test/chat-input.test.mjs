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
const exec = promisify(execFile);
const binding = "123:456:11111111-1111-1111-1111-111111111111";
const entry = () => ({
  binding,
  identity: "test",
  text: "中文 hello\n第二行 $(not a command); `literal`",
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
    read: async () => {
      reads++;
      return { available: valid, binding };
    },
  };
  const terminals = { writers: new Map() },
    input = new ChatInput(chats, terminals);
  input.buffer = async () => {
    writes++;
  };
  for (const invalid of ["mode", "approval", "unknown", "thread", "writer"]) {
    mode = invalid === "mode" ? "1" : "0";
    footer =
      invalid === "approval"
        ? "• Working (2s • esc to interrupt)\n› 1. Yes\nenter to confirm"
        : invalid === "unknown"
          ? "shell $"
          : "• Working (2s • esc to interrupt)\n› ";
    valid = invalid !== "thread";
    if (invalid === "writer") terminals.writers.set("sandbox", {});
    assert.equal((await input.send("sandbox", entry())).state, "failed", invalid);
    assert.equal(writes, 0);
    assert(!commands.some((a) => a[0] === "paste-buffer" || a[0] === "send-keys"));
    terminals.writers.clear();
    commands = [];
  }
  valid = true;
  footer = "• Working (2s • esc to interrupt)\n› ";
  reads = 0;
  chats.read = async () => ({ available: ++reads < 3, binding });
  assert.equal((await input.send("sandbox", entry())).state, "unknown");
  assert.equal(commands.filter((a) => a[0] === "paste-buffer").length, 1);
  assert.equal(commands.filter((a) => a[0] === "send-keys").length, 0);
  assert.equal(terminals.writers.size, 0);
  commands = [];
  chats.read = async () => ({ available: true, binding });
  footer = "⠁ ⢀\n›⠁Ask Codex to do anything\n  ⠈ ⠠";
  assert.equal(
    (await input.send("sandbox", entry())).state,
    "submitted",
    "animated input is not rejected",
  );
  assert.equal(commands.filter((a) => a[0] === "send-keys").length, 1);
});

test(
  "authenticated HTTP → original tmux PTY → exact Chinese multiline text and one Enter, no queue",
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
    const desk = await createDesk({
      runtime: dir + "/runtime",
      socket,
      projectRoot: dir,
      allowed: ["sandbox"],
      secure: false,
      chatDependencies: {
        read: async () => ({ available: true, binding, revision: "1", messages: [], before: null }),
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
    assert.equal((await post()).state, "submitted");
    await delay(50);
    assert.equal(JSON.parse(await readFile(record, "utf8")).length, 1);
    const view = await (
      await fetch(origin + "/api/sessions/sandbox/chat?identity=" + encodeURIComponent(identity), {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(view.sendMode, "terminal-enter");
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
