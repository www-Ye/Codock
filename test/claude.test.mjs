import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { Chats } from "../lib/chat.mjs";
import { ChatInput } from "../lib/chat-input.mjs";
import { ChatInteraction, parseClaudeQuestion } from "../lib/chat-interaction.mjs";
import { terminalStatus } from "../lib/terminal-status.mjs";
import { createDesk } from "../server.mjs";
const exec = promisify(execFile),
  binding = "200:20:11111111-1111-1111-1111-111111111111";
const ready = "❯ \n  auto mode on (shift+tab to cycle)";
const busy =
  "✻ Waiting for API response · will retry in 4m 36s\n❯ \n auto mode on (shift+tab to cycle) · esc to interrupt";
const screen = (selected) =>
  `Bash command\n  echo hello\nDo you want to proceed?\n${selected === 1 ? "❯" : " "} 1. Yes\n${selected === 2 ? "❯" : " "} 2. No\nEnter to select · Esc to cancel`;

test("Claude reader: exact process binding, paging, public projection and receipts", async () => {
  const result = await exec("python3", ["-B", "test/claude-reader.py"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(result.stderr, /OK/);
});

test("Claude identity never invokes Codex probing, including unverifiable sessions", async () => {
  let available = true,
    probes = 0;
  const chats = new Chats(
    {},
    {
      read: async () => ({ available, provider: "claude", binding }),
      status: {
        probe: async () => {
          probes++;
          throw Error("not allowed");
        },
      },
    },
  );
  assert.equal((await chats.readBound("cc", "identity", {})).available, true);
  available = false;
  assert.equal((await chats.readBound("cc", "identity", {})).available, false);
  assert.equal(probes, 0);
});

test("Claude native composer sends exactly once; permissions and drafts never become messages", async () => {
  let footer = ready,
    keys = [],
    pastes = 0;
  const registry = {
    target: async () => ({ id: "$1" }),
    command: async (args) => {
      if (args[0] === "display-message") return "%1\t100\t30\t0";
      if (args[0] === "capture-pane") return footer;
      if (args[0] === "paste-buffer") pastes++;
      if (args[0] === "send-keys") keys.push(args[3]);
      return "";
    },
  };
  const chats = { registry, read: async () => ({ available: true, provider: "claude", binding }) };
  const input = new ChatInput(chats, { writers: new Map() });
  input.buffer = async () => {};
  const entry = { binding, identity: "identity", text: "继续\n不要另开对话" };
  for (const bad of [screen(1), "❯ 未提交草稿\n auto mode on (shift+tab to cycle)", "shell $"]) {
    footer = bad;
    assert.equal((await input.send("cc", entry)).state, "failed");
  }
  assert.equal(pastes, 0);
  assert.deepEqual(keys, []);
  footer = busy;
  assert.equal((await input.send("cc", entry)).state, "submitted");
  assert.equal(pastes, 1);
  assert.deepEqual(keys, ["Enter"]);
  assert.equal(terminalStatus(busy).state, "running");
  assert.equal(terminalStatus(ready).state, "ready");
  assert.equal(terminalStatus(screen(1), { provider: "claude" }).state, "waiting");
});

test("Claude permission cards require an explicit, rechecked selection; interrupt is separate", async () => {
  let selected = 1,
    enters = 0,
    escapes = 0,
    running = false;
  const registry = {
    target: async () => ({ id: "$1" }),
    command: async (args) => {
      if (args[0] === "display-message") return "%1\t100\t30\t0";
      if (args[0] === "capture-pane") return running ? busy : screen(selected);
      if (args[0] === "send-keys") {
        if (args[3] === "Down") selected++;
        if (args[3] === "Up") selected--;
        if (args[3] === "Enter") enters++;
        if (args[3] === "Escape") escapes++;
      }
      return "";
    },
  };
  const interaction = new ChatInteraction(
    {
      registry,
      page: async () => ({ available: true, provider: "claude", binding, revision: "1" }),
    },
    { writers: new Map() },
  );
  assert.equal(parseClaudeQuestion(screen(1) + "\n❯ "), null);
  assert.equal(
    parseClaudeQuestion(screen(1).replace("Bash command\n", "")),
    null,
    "clipped command cannot become an actionable permission card",
  );
  assert.equal(
    parseClaudeQuestion(screen(1).replace("echo hello", "echo hello …")),
    null,
    "collapsed permission body requires original dialog",
  );
  assert.equal(parseClaudeQuestion(screen(1).replace("Enter to select", "Space to toggle")), null);
  const q = await interaction.page("cc", "identity", binding);
  assert.equal(q.kind, "permission");
  assert.match(q.title, /echo hello/);
  await assert.rejects(
    interaction.answer("cc", { identity: "identity", binding, token: q.token, index: 2 }),
    /参数无效/,
  );
  assert.equal(enters, 0);
  assert.equal(
    (
      await interaction.answer("cc", {
        identity: "identity",
        binding,
        token: q.token,
        index: 2,
        confirm: true,
      })
    ).state,
    "submitted",
  );
  assert.equal(enters, 1);
  assert.equal(selected, 2);
  await assert.rejects(
    interaction.answer("cc", {
      identity: "identity",
      binding,
      token: q.token,
      index: 2,
      confirm: true,
    }),
    /已经提交过/,
  );
  running = true;
  await interaction.interrupt("cc", {
    identity: "identity",
    binding,
    confirm: true,
    requestId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(escapes, 1);
});

test(
  "Claude transport: HTTP to isolated real tmux preserves exact text and one Enter",
  { timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/ct-"),
      socket = dir + "/t.sock",
      record = dir + "/received.json";
    const tmux = (args) =>
      exec("tmux", ["-S", socket, ...args], { env: { ...process.env, TMUX: "" }, timeout: 5000 });
    const fixture = new URL("./terminal-input.py", import.meta.url).pathname;
    await tmux([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "cc",
      "-x",
      "120",
      "-y",
      "30",
      `exec python3 -B '${fixture}' '${record}' --claude`,
    ]);
    t.after(() => tmux(["kill-server"]).catch(() => {}));
    for (let n = 0; n < 30; n++) {
      if ((await tmux(["capture-pane", "-p", "-t", "cc"])).stdout.includes("auto mode")) break;
      await delay(30);
    }
    const desk = await createDesk({
      runtime: dir + "/runtime",
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
      socket,
      allowed: ["cc"],
      secure: false,
      chatDependencies: {
        read: async () => ({
          available: true,
          provider: "claude",
          binding,
          revision: "1",
          messages: [],
          before: null,
        }),
      },
    });
    await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const cookie = desk.auth.cookie(desk.auth.issue({ login: "fixture" })).split(";")[0];
    const identity = (await desk.registry.list())[0].identity;
    const message = {
      identity,
      binding,
      requestId: randomUUID(),
      text: "继续这个上下文\n$(literal) `text`",
      confirm: true,
      transport: "terminal-enter",
    };
    const post = () =>
      fetch(origin + "/api/sessions/cc/chat", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(message),
      }).then((r) => r.json());
    assert.equal((await post()).state, "submitted");
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
  },
);

test(
  "Claude mobile and desktop: history, tool records, send and permission controls",
  { timeout: 40000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/cl-");
    let sends = 0,
      footer = ready;
    const messages = [
      { id: "100", role: "user", text: "在原会话继续", time: 1791871200000, provider: "claude" },
      {
        id: "200",
        role: "activity",
        type: "mcpToolCall",
        title: "调用 Read",
        text: "调用 Read",
        status: "recorded",
        details: [{ label: "参数", text: "demo.html" }],
        time: 1791871201000,
        provider: "claude",
      },
      {
        id: "300",
        sourceId: "11111111-1111-1111-1111-111111111111:0",
        role: "assistant",
        text: "页面已经准备好。",
        time: 1791871202000,
        provider: "claude",
      },
    ];
    const desk = await createDesk({
      runtime: dir + "/runtime",
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
      socket: dir + "/absent",
      allowed: ["cc"],
      secure: false,
      chatDependencies: {
        read: async () => ({
          available: true,
          provider: "claude",
          binding,
          revision: "1",
          messages,
          before: null,
        }),
      },
      chatSendDependencies: {
        deliver: async (name, entry) => {
          assert.equal(name, "cc");
          assert.equal(entry.text, "继续做网页");
          sends++;
          return { state: "submitted" };
        },
      },
    });
    t.after(() => desk.close());
    desk.registry.items.cc = {
      name: "cc",
      label: "cc",
      identity: "identity",
      preview: null,
      revision: 1,
    };
    desk.registry.live = async () => [
      { name: "cc", identity: "identity", id: "$1", windows: 1, attached: 1, cols: 120, rows: 30 },
    ];
    desk.registry.command = async (args) =>
      args[0] === "capture-pane" ? footer : "%1\t100\t30\t0";
    desk.runtimeStatus.snapshot = async () => ({ states: { cc: "ready" }, checkedAt: Date.now() });
    await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const browser = await chromium.launchPersistentContext(dir + "/profile", {
      executablePath: process.env.CHROME_BIN || chromium.executablePath(),
      headless: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: dir },
    });
    t.after(() => browser.close());
    const [name, value] = desk.auth
      .cookie(desk.auth.issue({ login: "fixture" }))
      .split(";")[0]
      .split("=");
    await browser.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/s/cc#chat");
    await page.waitForSelector(".chat-message.assistant");
    assert.match(await page.locator(".chat-message.assistant").textContent(), /Claude Code/);
    assert.equal(await page.locator(".chat-event").count(), 1);
    messages.push({ ...messages[2], id: "400", text: "页面更新完成。" });
    await page.evaluate(() => chatView.load());
    assert.equal(
      await page.locator(".chat-message.assistant").count(),
      1,
      "rewritten UUID does not add a duplicate bubble",
    );
    assert.match(await page.locator(".chat-message.assistant").textContent(), /页面更新完成/);
    await page.evaluate(() => {
      const before = chatView.nodes.size;
      const old = chatView.mergeRecord({
        id: "250",
        sourceId: "11111111-1111-1111-1111-111111111111:0",
        role: "assistant",
        provider: "claude",
        text: "older version",
      });
      if (old.text !== "页面更新完成。" || chatView.nodes.size !== before)
        throw Error("older pagination reverted content");
    });
    await page.fill("#chatDraft", "继续做网页");
    await page.click("#chatSend");
    await page.waitForFunction(() => document.querySelector("#chatDraft").value === "");
    assert.equal(sends, 1);
    footer = screen(1);
    await page.evaluate(() => chatView.load());
    await page.waitForSelector("#chatQuestion:not(.hidden)");
    assert.match(await page.locator("#chatQuestion").textContent(), /Claude Code 请求权限/);
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: dir + "/claude-" + width + ".png" });
    }
    assert.deepEqual(errors, []);
    console.log("Claude synthetic browser:", dir);
  },
);
