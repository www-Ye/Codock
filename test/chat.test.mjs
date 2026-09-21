import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createDesk } from "../server.mjs";
import { Chats } from "../lib/chat.mjs";
import { terminalStatus, observeTerminal } from "../lib/terminal-status.mjs";
const exec = promisify(execFile);
const binding = "123:456:11111111-1111-1111-1111-111111111111";

test("live indicator observes TUI cues, never process liveness or stale history", async () => {
  const state = (text) => terminalStatus(text, { checkedAt: 100 }).state;
  assert.equal(state("• Working (1m 12s • esc to interrupt)\n\n› "), "running");
  assert.equal(state("• Checking files (12s •\n esc to interrupt)\n› "), "running");
  assert.equal(
    state("› 1. Yes, proceed (y)\n  2. No\nPress enter to confirm or esc to cancel"),
    "waiting",
  );
  assert.equal(state("› "), "ready");
  assert.equal(
    state("⠁  ⠈  ⡀\n›⠁Ask Codex to do anything ⡀\n⠈   ⠂"),
    "ready",
    "animated composer remains an input prompt",
  );
  assert.equal(
    state("⠁⡀\n›⠁1. Yes\nenter to confirm"),
    "waiting",
    "particles must not bypass an approval",
  );
  assert.equal(
    state("The code uses select and confirm.\n› 我的下一条指令"),
    "ready",
    "ordinary answer words and an unfinished draft are not execution signals",
  );
  assert.equal(state("quoted esc to interrupt in an output\n› "), "unknown");
  assert.equal(state("• Working (partial render\n› "), "unknown");
  assert.equal(state("SHELL_OUTPUT"), "unknown");
  assert.equal(
    terminalStatus("• Working (1s • esc to interrupt)", { inMode: true }).state,
    "unknown",
  );
  let commands = 0;
  const registry = {
    command: async (args, limit) => {
      commands++;
      assert.equal(args[0], "capture-pane");
      assert.equal(limit, 32768);
      return "• Working (3s • esc to interrupt)\n› ";
    },
  };
  const observed = await observeTerminal(registry, "%1\t123\t24\t0");
  assert.equal(observed.state, "running");
  assert(!JSON.stringify(observed).includes("Working"), "captured text never leaves the observer");
  assert.equal((await observeTerminal(registry, "%1\t123\t24\t1")).state, "unknown");
  assert.equal(commands, 1, "copy-mode does not read old terminal content as live state");
});

test("readonly history adapter: pagination, message allowlist, process binding and update", async () => {
  const result = await exec("python3", ["-B", "test/chat-reader.py"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(result.stderr, /OK/);
});

test("legacy JSONL adapter: bounded reverse pagination, public allowlist and same binding", async () => {
  const result = await exec("python3", ["-B", "test/chat-legacy.py"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(result.stderr, /OK/);
});

test(
  "legacy browser: real JSONL reader, earlier pages and same-thread send",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/lw-");
    const run = (args) =>
      exec("python3", ["-B", "test/chat-legacy.py", ...args], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
    await run(["--fixture", dir + "/history"]);
    let sends = 0;
    const desk = await createDesk({
      runtime: dir + "/runtime",
      socket: dir + "/absent.sock",
      allowed: ["sandbox"],
      secure: false,
      chatDependencies: {
        home: dir + "/history",
        read: async (input) => JSON.parse((await run(["--read", JSON.stringify(input)])).stdout),
      },
      chatSendDependencies: {
        deliver: async (name, entry) => {
          const { text } = entry;
          assert.equal(name, "sandbox");
          assert.equal(entry.binding.split(":")[2], binding.split(":")[2]);
          assert.equal(text, "继续原会话");
          sends++;
          return { state: "submitted" };
        },
      },
    });
    desk.registry.items.sandbox = {
      name: "sandbox",
      label: "旧格式验收",
      identity: "test",
      preview: null,
      revision: 1,
    };
    desk.registry.live = async () => [
      { name: "sandbox", identity: "test", id: "$1", windows: 1, attached: 1 },
    ];
    desk.registry.command = async (args) => (args[0] === "capture-pane" ? "› " : "%1\t123\t30\t0");
    await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const browser = await chromium.launchPersistentContext(dir + "/profile", {
      executablePath: process.env.DESK_CHROMIUM,
      headless: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: process.env.TMPDIR },
    });
    t.after(() => browser.close());
    const cookie = desk.auth
      .cookie(desk.auth.issue({ login: "isolated-fixture" }))
      .split(";")[0]
      .split("=");
    await browser.addCookies([
      { name: cookie[0], value: cookie[1], url: origin, httpOnly: true, sameSite: "Strict" },
    ]);
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/s/sandbox#chat");
    await page.waitForSelector(".chat-message");
    assert.equal(await page.locator(".chat-message").count(), 20);
    assert.equal(await page.locator("#chatDraft").isEnabled(), true);
    await page.click("#chatOlder");
    await page.waitForFunction(() => document.querySelectorAll(".chat-message").length === 40);
    await page.click("#chatOlder");
    await page.waitForFunction(() => document.querySelectorAll(".chat-message").length === 60);
    assert(await page.locator("#chatOlder").isHidden());
    assert.equal(await page.locator("#chatStatus").textContent(), "");
    assert.equal(
      await page
        .locator(".chat-message")
        .evaluateAll((nodes) => new Set(nodes.map((n) => n.dataset.id)).size),
      60,
    );
    await page.fill("#chatDraft", "继续原会话");
    await page.click("#chatSend");
    await page.waitForFunction(
      () =>
        document.querySelector("#chatDraft").value === "" &&
        !document.querySelector("#chatSend").disabled,
    );
    assert.equal(sends, 1);
    assert.deepEqual(errors, []);
    await page.click("#chatLatest");
    await page.screenshot({ path: dir + "/legacy-mobile.png" });
    console.log("Legacy synthetic browser:", dir);
  },
);

test("chat endpoint checks identity, cursor, pane race and coalesces concurrent reads", async () => {
  let calls = 0,
    pane = "%1\t123",
    finish;
  const registry = {
    target: async (name, identity) => {
      assert.equal(name, "sandbox");
      if (identity !== "test") throw Object.assign(Error("changed"), { status: 409 });
      return { id: "$1" };
    },
    command: async () => pane,
  };
  const chats = new Chats(registry, {
    read: async () => {
      calls++;
      return new Promise((r) => (finish = r));
    },
  });
  const q = new URLSearchParams({ identity: "test" });
  const a = chats.page("sandbox", q),
    b = chats.page("sandbox", q);
  await new Promise((r) => setImmediate(r));
  finish({ available: true, messages: [] });
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  await assert.rejects(() => chats.page("sandbox", new URLSearchParams({ identity: "wrong" })), {
    status: 409,
  });
  await assert.rejects(
    () => chats.page("sandbox", new URLSearchParams({ identity: "test", before: "1" })),
    { status: 400 },
  );
  const c = chats.page("sandbox", q);
  await new Promise((r) => setImmediate(r));
  pane = "%2\t234";
  finish({ available: true, messages: [] });
  await assert.rejects(() => c, { status: 409 });
});

test(
  "mobile chat: real API authorization, Markdown, older pages, updates, routes and logout",
  { timeout: 45000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/chat-");
    let revision = "40",
      requests = 0,
      delay = 0,
      sends = 0,
      footer = "› ",
      captureFailed = false;
    const messages = Array.from({ length: 40 }, (_, n) => ({
      id: String(n + 1),
      role: n % 2 ? "assistant" : "user",
      phase: n % 2 ? "final_answer" : null,
      text:
        n % 2
          ? '已经整理好了。\n\n**结论**：手机也能轻松阅读原来的对话。\n\n```python\nprint("hello workbench")\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 原会话 | 保留 |\n| 网页预览 | 可用 |'
          : "把原来的 Codex 对话带到手机上，不要新开一段聊天。",
      time: 1789900000000 + n * 60000,
    }));
    messages[38].text = '<img src=x onerror="window.pwned=1">\n[jump](javascript:alert(1))';
    const read = async (input) => {
      requests++;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (input.revision === revision && !input.before)
        return { available: true, binding, revision, unchanged: true };
      const list = messages.filter((m) => !input.before || Number(m.id) < input.before).slice(-20);
      return {
        available: true,
        binding,
        revision,
        messages: list,
        before: Number(list[0].id) > 1 ? Number(list[0].id) : null,
      };
    };
    const desk = await createDesk({
      runtime: dir + "/runtime",
      socket: dir + "/absent.sock",
      allowed: ["sandbox", "notes"],
      secure: false,
      chatDependencies: { read },
      chatSendDependencies: {
        deliver: async (name, entry) => {
          const { text } = entry;
          assert.equal(name, "sandbox");
          assert.equal(entry.binding, binding);
          assert(text.includes("\n"));
          sends++;
          return { state: "submitted" };
        },
      },
    });
    desk.registry.items.sandbox = {
      name: "sandbox",
      label: "工作台",
      identity: "test",
      preview: null,
      revision: 1,
    };
    desk.registry.items.notes = {
      name: "notes",
      label: "研究笔记",
      identity: "notes-test",
      preview: null,
      revision: 1,
    };
    desk.registry.live = async () => [
      { name: "sandbox", identity: "test", id: "$1", windows: 1, attached: 1 },
      { name: "notes", identity: "notes-test", id: "$2", windows: 1, attached: 0 },
    ];
    desk.registry.command = async (args) => {
      if (args[0] === "capture-pane") {
        if (captureFailed) throw Error("fixture capture unavailable");
        return footer;
      }
      return "%1\t123\t30\t0";
    };
    await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    assert.equal((await fetch(origin + "/api/sessions/sandbox/chat?identity=test")).status, 401);
    assert.equal(
      (
        await fetch(origin + "/api/sessions/sandbox/chat", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    const browser = await chromium.launchPersistentContext(dir + "/profile", {
      executablePath: process.env.DESK_CHROMIUM,
      headless: true,
      hasTouch: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: process.env.TMPDIR },
    });
    t.after(() => browser.close());
    const cookie = desk.auth
      .cookie(desk.auth.issue({ login: "isolated-fixture" }))
      .split(";")[0]
      .split("=");
    await browser.addCookies([
      { name: cookie[0], value: cookie[1], url: origin, httpOnly: true, sameSite: "Strict" },
    ]);
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let dialogs = 0;
    page.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    await page.addInitScript(() => {
      window.recognizers = [];
      window.SpeechRecognition = class {
        constructor() {
          window.recognizers.push(this);
        }
        start() {
          this.onstart?.();
        }
        stop() {
          this.stopped = true;
        }
        abort() {
          this.aborted = true;
        }
        result(text) {
          this.onresult?.({
            resultIndex: 0,
            results: [Object.assign([{ transcript: text }], { isFinal: true })],
          });
        }
      };
    });
    await page.goto(origin + "/s/sandbox#chat");
    await page.waitForSelector(".chat-message");
    assert.deepEqual(
      await page.locator("[data-tab]").evaluateAll((nodes) => nodes.map((n) => n.dataset.tab)),
      ["chat", "preview", "terminal", "settings"],
    );
    assert(await page.locator("#sessionSearch").isHidden());
    assert(await page.locator("#search").isHidden());
    assert.equal(await page.locator("#chatRunLabel").textContent(), "待命");
    footer = "• Working (5s • esc to interrupt)\n› ";
    await page.evaluate(() => chatView.load());
    assert.equal(await page.locator("#chatRunLabel").textContent(), "正在运行");
    assert.equal(
      await page.locator(".session-row.active .session-runtime").textContent(),
      "运行中",
    );
    footer = "› 1. Yes, proceed (y)\nPress enter to confirm or esc to cancel";
    await page.evaluate(() => chatView.load());
    assert.equal(await page.locator("#chatRunLabel").textContent(), "等待操作 ↗");
    footer = "› ";
    await page.evaluate(() => chatView.load());
    assert.equal(await page.locator("#chatRunLabel").textContent(), "待命");
    captureFailed = true;
    await page.evaluate(() => chatView.load());
    assert.equal(await page.locator("#chatRunLabel").textContent(), "状态待确认");
    captureFailed = false;
    await page.evaluate(() => chatView.load());
    const theme = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return Object.fromEntries(
        ["--bg", "--surface", "--text", "--muted", "--yellow", "--ink"].map((k) => [
          k,
          s.getPropertyValue(k).trim(),
        ]),
      );
    });
    const luminance = (hex) =>
      hex
        .slice(1)
        .match(/../g)
        .map((x) => parseInt(x, 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = (a, b) => {
      const x = luminance(a),
        y = luminance(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    assert(luminance(theme["--bg"]) < 0.04, "dark default backdrop");
    assert(contrast(theme["--text"], theme["--surface"]) >= 7, "main text stays legible");
    assert(
      contrast(theme["--muted"], theme["--surface"]) >= 4.5,
      "secondary text is not dimmed into unreadability",
    );
    assert(contrast(theme["--ink"], theme["--yellow"]) >= 4.5, "send button label stays legible");
    assert(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector("#toast")).color ===
          getComputedStyle(document.documentElement).color,
      ),
      "notifications use readable text on their dark surface",
    );
    assert.equal(await page.locator(".chat-message").count(), 20);
    assert.equal(
      await page.evaluate(() => typeof window.Terminal),
      "undefined",
      "chat does not load xterm",
    );
    assert.equal(await page.locator(".chat-message-body table").count(), 10);
    assert.equal(
      await page
        .locator(
          '.chat-message-body img,.chat-message-body script,.chat-message-body a[href^="javascript:"]',
        )
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    for (const size of [
      { width: 390, height: 844 },
      { width: 320, height: 640 },
      { width: 390, height: 420 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(50);
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        "no horizontal page overflow",
      );
      const button = await page.locator("#chatTerminal").boundingBox();
      assert(
        button.y + button.height <= size.height,
        `continue action stays visible at ${size.width}x${size.height}: ${button.y + button.height}`,
      );
      const area = await page.locator("#chatScroll").boundingBox();
      assert(area.height > size.height * 0.56, "chat keeps the majority of the viewport");
      console.log(
        "Chat viewport",
        size.width,
        size.height,
        "reading area",
        Math.round(area.height),
      );
      await page.screenshot({ path: dir + `/chat-${size.width}-${size.height}.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click("#sessionToggle");
    assert(await page.locator("#sessionSidebar").isVisible());
    assert(await page.locator("#deskContent").evaluate((e) => e.inert));
    assert.notEqual(
      await page.evaluate(() => document.activeElement?.tagName),
      "INPUT",
      "opening sidebar does not pop phone keyboard",
    );
    await page.click("#sessionSearchToggle");
    await page.fill("#sessionSearch", "研究");
    assert.equal(await page.locator(".session-row").count(), 1);
    await page.fill("#sessionSearch", "");
    await page.click('[aria-label="置顶 工作台"]');
    assert.equal(await page.locator(".session-section").first().textContent(), "常用");
    await page.press("#sessionSearch", "Escape");
    assert(await page.locator("#sessionSearch").isHidden());
    assert(await page.locator("#sessionSidebar").isVisible());
    await page.press("#sessionSearchToggle", "Escape");
    assert(await page.locator("#sessionSidebar").isHidden());
    assert(!(await page.locator("#deskContent").evaluate((e) => e.inert)));
    await page.locator("#chatScroll").evaluate((e) => (e.scrollTop = 0));
    await page.click("#chatOlder");
    await page.waitForFunction(() => document.querySelectorAll(".chat-message").length === 40);
    assert.equal(await page.locator(".chat-message").first().getAttribute("data-id"), "1");
    assert(await page.locator("#chatOlder").isHidden());
    // Update an existing saved reply, without duplicating bubbles or jumping a reader.
    await page.locator("#chatScroll").evaluate((e) => (e.scrollTop = 350));
    const top = await page.locator("#chatScroll").evaluate((e) => e.scrollTop);
    messages[39].text = "新的已保存回复";
    revision = "41";
    await page.evaluate(() => chatView.load());
    await page.waitForFunction(() =>
      document.querySelector(".chat-message:last-child").textContent.includes("新的已保存回复"),
    );
    assert.equal(await page.locator(".chat-message").count(), 40);
    assert(Math.abs((await page.locator("#chatScroll").evaluate((e) => e.scrollTop)) - top) < 2);
    // More than one unseen page must be explicit, never an invisible history gap.
    messages.push(
      ...Array.from({ length: 21 }, (_, n) => ({
        id: String(41 + n),
        role: "assistant",
        phase: "final_answer",
        text: "新记录 " + n,
        time: 1789905000000 + n * 60000,
      })),
    );
    revision = "62";
    await page.evaluate(() => chatView.load());
    assert.match(await page.locator("#chatStatus").textContent(), /较多新消息/);
    assert.equal(await page.locator(".chat-message").count(), 40);
    await page.click("#chatRefresh");
    await page.waitForFunction(
      () => document.querySelector(".chat-message:last-child")?.dataset.id === "61",
    );
    assert.equal(await page.locator(".chat-message").count(), 20);
    // Leaving the tab cancels an in-flight response; no stale content is inserted.
    delay = 100;
    revision = "42";
    await page.evaluate(() => void chatView.load());
    await page.click('[data-tab="settings"]');
    await page.waitForTimeout(150);
    assert(await page.locator("#chatPanel").isHidden());
    const count = requests;
    await page.waitForTimeout(200);
    assert.equal(requests, count);
    await page.click('[data-tab="chat"]');
    await page.waitForSelector(".chat-message");
    await page.fill("#chatDraft", "手机发送验收\nEnter 保留换行");
    await page.press("#chatDraft", "Enter");
    assert.equal(sends, 0, "Enter adds a line, never submits");
    await page.click("#chatSend");
    await page.waitForFunction(
      () =>
        document.querySelector("#chatDraft").value === "" &&
        !document.querySelector("#chatSend").disabled,
    );
    assert.equal(await page.locator("#chatSendStatus").textContent(), "");
    assert.equal(dialogs, 0, "normal chat send never prompts");
    assert.equal(sends, 1);
    assert.equal(await page.inputValue("#chatDraft"), "");
    // Drop the response AFTER the server accepted it. Only GET the receipt;
    // never send the prompt a second time to recover from a network failure.
    await page.route("**/api/sessions/sandbox/chat", async (route) => {
      if (route.request().method() === "POST") {
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page.fill("#chatDraft", "回执断线验收\n不要重复执行");
    await page.click("#chatSend");
    await page.waitForFunction(
      () =>
        document.querySelector("#chatDraft").value === "" &&
        !document.querySelector("#chatSend").disabled,
    );
    assert.equal(sends, 2);
    await page.reload();
    await page.waitForSelector("[data-receipt]");
    assert(
      await page.locator("#chatSend").isEnabled(),
      "read-only receipt recovery confirms delivery without another POST",
    );
    assert.equal(sends, 2);
    assert(
      !(await page.evaluate(() => JSON.stringify(sessionStorage).includes("回执断线验收"))),
      "browser persists only receipt IDs, never message text",
    );
    assert.equal(
      await page.locator("[data-receipt]").count(),
      2,
      "both sent messages survive refresh before Codex saves history",
    );
    assert.equal(await page.locator("#chatSendStatus").textContent(), "");
    assert.equal(dialogs, 0);
    assert.equal(sends, 2);
    assert.equal(await page.inputValue("#chatDraft"), "");
    // Structured activity, progressive detail rendering, stable status updates.
    messages.push({
      id: "62",
      role: "user",
      text: "帮我把研究结论整理成手机可以看的网页。",
      time: 1789909000000,
    });
    messages.push({
      id: "63",
      role: "assistant",
      phase: "commentary",
      text: "我会先核对资料，再整理页面并检查手机布局。",
      time: 1789909010000,
    });
    const events = [
      ["commandExecution", "执行命令", "completed", "命令", "node --test\n# 12 checks passed"],
      ["webSearch", "网页搜索", "completed", "检索", "OpenAI Codex 官方文档"],
      [
        "fileChange",
        "修改文件",
        "completed",
        "变更",
        "index.html\n-旧布局\n+支持手机和电脑的新版布局",
      ],
      ["mcpToolCall", "调用工具", "inProgress", "结果", "正在核对网页资源…"],
    ];
    for (const [n, [type, title, status, label, text]] of events.entries())
      messages.push({
        id: String(64 + n),
        role: "activity",
        type,
        title,
        text: title,
        status,
        details: [{ label, text }],
        time: 1789909020000 + n * 1000,
      });
    messages.push({
      id: "68",
      role: "assistant",
      phase: "final_answer",
      text: "页面已经整理好了。\n\n- 结论放在最前面\n- 过程记录可以展开查看\n- 手机上也能清楚阅读\n\n可以继续告诉我想调整的地方。",
      time: 1789909090000,
    });
    revision = "68";
    await page.evaluate(() => chatView.load());
    await page.waitForSelector(".activity-group");
    assert.equal(await page.locator(".chat-event").count(), 4);
    assert.equal(await page.locator(".event-content").count(), 0, "details are lazy");
    await page.click(".activity-group>summary");
    await page.click(".chat-event:first-of-type summary");
    assert.match(await page.locator(".event-content").textContent(), /12 checks passed/);
    assert(
      await page
        .locator(".chat-event details")
        .first()
        .evaluate((e) => e.open),
    );
    messages.find((m) => m.id === "67").status = "failed";
    revision = "69";
    await page.evaluate(() => chatView.load());
    assert.equal(await page.locator(".event-state[data-state=failed]").count(), 1);
    assert(
      await page.locator(".activity-group").evaluate((e) => e.open),
      "outer group stays expanded across updates",
    );
    assert(
      await page
        .locator(".chat-event details")
        .first()
        .evaluate((e) => e.open),
      "detail stays expanded across updates",
    );
    assert.match(await page.locator(".activity-group>summary").textContent(), /4 条执行记录/);
    await page.click("#chatActivityToggle");
    assert(await page.locator(".activity-group").isHidden());
    await page.click("#chatActivityToggle");
    assert(await page.locator(".activity-group").isVisible());
    await page
      .locator(".chat-event details")
      .first()
      .evaluate((e) => (e.open = false));
    for (const size of [
      { width: 390, height: 844 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(size);
      await page.click("#chatLatest");
      await page.waitForTimeout(50);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: dir + `/workspace-${size.width}.png` });
    }
    // Dictation changes only the draft; synthetic recognition, no real microphone or auto-send.
    await page.fill("#chatDraft", "原草稿：");
    await page.click("#chatVoice");
    assert.equal(await page.evaluate(() => recognizers.length), 0, "disclosure before recording");
    assert.match(await page.locator("#voiceStatus").textContent(), /联网识别/);
    await page.click("#voiceStart");
    assert.equal(await page.evaluate(() => recognizers.at(-1).lang), "zh-CN");
    await page.evaluate(() => recognizers.at(-1).result("可爱的工作台"));
    assert.equal(await page.inputValue("#chatDraft"), "原草稿：可爱的工作台");
    assert.equal(sends, 2);
    assert(await page.locator("#voicePanel").isHidden());
    await page.click("#chatVoice");
    await page.click("#chatVoice");
    assert(await page.evaluate(() => recognizers.at(-1).stopped));
    await page.evaluate(() => recognizers.at(-1).result("继续听写"));
    assert.equal(await page.inputValue("#chatDraft"), "原草稿：可爱的工作台继续听写");
    await page.click("#chatVoice");
    await page.click("#chatVoice");
    assert(
      await page.evaluate(() => recognizers.at(-1).stopped),
      "each new listening session can be stopped",
    );
    await page.evaluate(() => recognizers.at(-1).onend());
    await page.click("#voiceClose");
    await page.click("#chatVoice");
    await page.fill("#chatDraft", "手动改字");
    assert(await page.evaluate(() => recognizers.at(-1).aborted));
    await page.evaluate(() => recognizers.at(-1).result("迟到结果"));
    assert.equal(await page.inputValue("#chatDraft"), "手动改字");
    await page.click("#voiceStart");
    await page.evaluate(() => recognizers.at(-1).onerror({ error: "not-allowed" }));
    assert.match(await page.locator("#voiceStatus").textContent(), /权限/);
    assert.equal(await page.inputValue("#chatDraft"), "手动改字");
    await page.selectOption("#voiceLang", "en-US");
    await page.click("#voiceStart");
    assert.equal(await page.evaluate(() => recognizers.at(-1).lang), "en-US");
    await page.evaluate(() => recognizers.at(-1).onerror({ error: "network" }));
    assert.match(await page.locator("#voiceStatus").textContent(), /连不上/);
    await page.click("#voiceStart");
    await page.evaluate(() => recognizers.at(-1).result("鸭".repeat(4001)));
    assert.equal(await page.inputValue("#chatDraft"), "手动改字");
    assert.match(await page.locator("#voiceStatus").textContent(), /太长/);
    await page.click("#voiceClose");
    await page.click("#chatVoice");
    await page.click('#sessionList a[href="/s/notes#chat"]');
    await page.waitForFunction(
      () => location.pathname === "/s/notes" && !document.querySelector("#chatDraft").disabled,
    );
    assert(await page.evaluate(() => recognizers.at(-1).aborted));
    await page.click("#chatVoice");
    await page.evaluate(() => recognizers.at(-2).result("不要串会话"));
    assert(
      !(await page.evaluate(() => recognizers.at(-1).aborted)),
      "late previous-session result cannot cancel new dictation",
    );
    assert.equal(await page.inputValue("#chatDraft"), "");
    await page.click("#voiceClose");
    await page.evaluate(() => {
      window.SpeechRecognition = undefined;
      window.webkitSpeechRecognition = undefined;
    });
    await page.click("#chatVoice");
    assert.match(await page.locator("#voiceStatus").textContent(), /键盘上的麦克风/);
    assert(await page.locator("#voiceStart").isHidden());
    await page.click("#voiceClose");
    await page.click('#sessionList a[href="/s/sandbox#chat"]');
    await page.waitForFunction(
      () => location.pathname === "/s/sandbox" && !document.querySelector("#chatDraft").disabled,
    );
    assert.equal(await page.inputValue("#chatDraft"), "手动改字");
    assert.equal(sends, 2);
    // Session selection is navigation, not a tmux mutation; draft stays in its chat.
    const visibleOrder = await page.evaluate(() => sessionView.items.map((s) => s.name));
    await page.fill("#chatDraft", "保留这个会话的草稿");
    await page.click('#sessionList a[href="/s/notes#chat"]');
    await page.waitForFunction(
      () => location.pathname === "/s/notes" && !document.querySelector("#chatDraft").disabled,
    );
    assert.equal(await page.inputValue("#chatDraft"), "");
    await page.click('#sessionList a[href="/s/sandbox#chat"]');
    await page.waitForFunction(
      () => document.querySelector("#chatDraft").value === "保留这个会话的草稿",
    );
    assert.equal(sends, 2);
    await page.waitForFunction(
      () =>
        sessions.find((s) => s.name === "sandbox").lastOpenedAt >
        sessions.find((s) => s.name === "notes").lastOpenedAt,
    );
    await page.click('[aria-label="取消置顶 工作台"]');
    assert.deepEqual(
      await page
        .locator("#sessionList a")
        .evaluateAll((links) => links.map((a) => a.getAttribute("href"))),
      visibleOrder.map((name) => "/s/" + name + "#chat"),
      "navigation and visit receipts preserve the displayed order until refresh",
    );
    await page.click("#deskMenu summary");
    await page.click("#refresh");
    await page.waitForFunction(
      () => document.querySelector("#sessionList a")?.getAttribute("href") === "/s/sandbox#chat",
    );
    const beforeRead = await page.evaluate(
      () => sessions.find((s) => s.name === "sandbox").lastOpenedAt,
    );
    await page.evaluate(() => chatView.load());
    await page.click("#deskMenu summary");
    await page.click("#refresh");
    assert.equal(
      await page.evaluate(() => sessions.find((s) => s.name === "sandbox").lastOpenedAt),
      beforeRead,
      "history polling does not count as use",
    );
    await page.reload();
    await page.waitForSelector(".chat-message");
    assert.equal(
      await page.locator("#sessionList a").first().getAttribute("href"),
      "/s/sandbox#chat",
    );
    await page.click("#deskMenu summary");
    await page.click('.desk-menu-items a[href="/"]');
    await page.waitForSelector("#home", { state: "visible" });
    assert(await page.locator("#search").isHidden());
    await page.click("#searchToggle");
    await page.fill("#search", "研究");
    assert.equal(await page.locator(".session-card").count(), 1);
    await page.press("#search", "Escape");
    assert(await page.locator("#search").isHidden());
    assert.equal(await page.locator(".session-card").count(), 2);
    await page.click('#sessionList a[href="/s/sandbox#chat"]');
    await page.waitForSelector(".chat-message");
    await page.evaluate(() => {
      chatView.stop();
    });
    await page.clock.install();
    await page.evaluate(() => chatView.runtime({ state: "running", source: "terminal-hint" }));
    await page.clock.fastForward(15001);
    assert.equal(
      await page.locator("#chatRunLabel").textContent(),
      "状态待确认",
      "stale observations cannot spin forever",
    );
    assert(await page.locator(".session-row.active .session-runtime").isHidden());
    // Definitively failed submissions stay recoverable without full bubbles at
    // the bottom. Expanding/restoring must never send to a terminal.
    await page.evaluate(() => {
      const key = chatView.key(),
        receipts = chatView.sent.get(key) || new Map();
      for (let n = 0; n < 3; n++)
        receipts.set("failure-" + n, {
          requestId: "failure-" + n,
          state: "failed",
          text: "待取回的原文 " + n,
          created: Date.now() + n,
          message: "测试：输入界面暂时无法确认",
        });
      chatView.sent.set(key, receipts);
      chatView.layout();
    });
    assert.equal(await page.locator(".failed-sends").count(), 1);
    assert.equal(await page.locator(".failed-sends").getAttribute("open"), null);
    assert(await page.locator('[data-receipt="failure-0"]').isHidden());
    await page.click(".failed-sends>summary");
    assert(await page.locator('[data-receipt="failure-0"]').isVisible());
    await page.fill("#chatDraft", "");
    await page
      .locator('[data-receipt="failure-0"] button')
      .filter({ hasText: "放回输入框" })
      .click();
    assert.equal(await page.inputValue("#chatDraft"), "待取回的原文 0");
    assert.equal(sends, 2);
    await page.click("#deskMenu summary");
    await page.click("#logout");
    await page.waitForSelector("#login", { state: "visible" });
    assert.equal(await page.locator(".chat-message").count(), 0);
    assert.equal((await fetch(origin + "/api/sessions/sandbox/chat?identity=test")).status, 401);
    assert.deepEqual(errors, []);
    console.log("Chat screenshots:", dir);
  },
);
