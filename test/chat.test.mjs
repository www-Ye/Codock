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
import { ChatInteraction, parseQuestion } from "../lib/chat-interaction.mjs";
const exec = promisify(execFile);
const binding = "123:456:11111111-1111-1111-1111-111111111111";

test(
  "history branch replacement discards stale bubbles, preserves drafts and paginates the new branch",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/branch-chat-");
    let branch = "old";
    const desk = await createDesk({
      runtime: dir + "/runtime",
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
      socket: dir + "/absent.sock",
      allowed: ["sandbox"],
      secure: false,
      chatDependencies: {
        read: async (input) => {
          const reset = input.historyVersion !== branch;
          const end = reset ? 60 : (input.before ?? 60);
          const messages = Array.from({ length: Math.min(20, end - 1) }, (_, i) => ({
            id: String(end - 20 + i),
            role: "assistant",
            phase: "final_answer",
            text: branch + " " + (end - 20 + i),
            time: 1700000000000 + (end - 20 + i) * 1000,
          }));
          return {
            available: true,
            binding,
            historyVersion: branch,
            historyReset: reset,
            revision: "60",
            messages,
            before: end > 40 ? end - 20 : null,
          };
        },
      },
    });
    desk.registry.items.sandbox = {
      name: "sandbox",
      label: "branch",
      identity: "fixture",
      preview: null,
      revision: 1,
    };
    desk.registry.live = async () => [
      { name: "sandbox", identity: "fixture", id: "$1", windows: 1, attached: 0 },
    ];
    desk.registry.command = async (args) => (args[0] === "capture-pane" ? "› " : "%1\t123\t30\t0");
    await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const browser = await chromium.launchPersistentContext(dir + "/profile", {
      executablePath: process.env.CHROME_BIN || chromium.executablePath(),
      headless: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env },
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
    await page.goto(origin + "/s/sandbox");
    await page.getByText("old 59", { exact: true }).waitFor();
    await page.fill("#chatDraft", "保留我的草稿");
    branch = "new";
    await page.getByText("new 59", { exact: true }).waitFor();
    assert.equal(await page.getByText("old 59", { exact: true }).count(), 0);
    assert.equal(await page.inputValue("#chatDraft"), "保留我的草稿");
    assert.equal(await page.locator(".chat-message").count(), 20);
    await page.click("#chatOlder");
    await page.getByText("new 20", { exact: true }).waitFor();
    assert.equal(await page.locator(".chat-message").count(), 40);
    assert.equal(await page.getByText("old 40", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  },
);

test("live indicator observes TUI cues, never process liveness or stale history", async () => {
  const state = (text) => terminalStatus(text, { checkedAt: 100 }).state;
  assert.equal(state("• Working (1m 12s • esc to interrupt)\n\n› "), "running");
  assert.equal(state("• Checking files (12s •\n esc to interrupt)\n› "), "running");
  assert.equal(
    state("› 1. Yes, proceed (y)\n  2. No\nPress enter to confirm or esc to cancel"),
    "waiting",
  );
  assert.equal(
    state("Question 1/2 (2 unanswered)\nWhich result should I keep?\n› 1. Keep A"),
    "waiting",
    "Codex questionnaire is an active question",
  );
  assert.equal(
    state("• Working (5s • esc to interrupt)\nShift+Left to answer questions\n› "),
    "waiting",
    "pending async question outranks running hint",
  );
  assert.equal(
    state(
      "• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer\n\n› Ask Codex to do anything",
    ),
    "running",
    "queued follow-ups are not human approval prompts",
  );
  assert.equal(
    state("A file describes shift+← to answer\n› "),
    "ready",
    "ordinary output must not become a question alert",
  );
  assert.equal(
    state("Output: Question 1/2 describes a fraction\n› "),
    "ready",
    "ordinary output must not create a question alert",
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
      assert.equal(limit, 1024 * 1024);
      return "• Working (3s • esc to interrupt)\n› ";
    },
  };
  const observed = await observeTerminal(registry, "%1\t123\t24\t0");
  assert.equal(observed.state, "running");
  assert(!JSON.stringify(observed).includes("Working"), "captured text never leaves the observer");
  assert.equal((await observeTerminal(registry, "%1\t123\t24\t1")).state, "unknown");
  assert.equal(commands, 1, "copy-mode does not read old terminal content as live state");
});

test("chat question card accepts only a current numbered Codex questionnaire", async () => {
  const pane = "%99",
    id = "123:456:11111111-1111-1111-1111-111111111111";
  const screen = (selected) =>
    `Question 1/1 (1 unanswered)\nWhich layout should be used?\n${selected === 1 ? "›" : " "} 1. Compact\n${selected === 2 ? "›" : " "} 2. Spacious\nPress enter to confirm`;
  assert.equal(
    parseQuestion(
      "• Queued follow-up inputs\n? 1 question\nshift+← to answer\n› Ask Codex to do anything",
      pane,
    ),
    null,
  );
  assert.equal(
    parseQuestion(screen(1) + "\n› Ask Codex to do anything", pane),
    null,
    "stale output is not actionable",
  );
  let selected = 1,
    entered = 0,
    escaped = 0,
    running = false;
  const registry = {
    target: async () => ({ id: "$99" }),
    command: async (args) => {
      if (args[0] === "display-message") return `${pane}\t123\t30\t0`;
      if (args[0] === "capture-pane")
        return running ? "• Working (5s • esc to interrupt)\n› " : screen(selected);
      if (args[0] === "send-keys") {
        if (args[3] === "Down") selected++;
        else if (args[3] === "Up") selected--;
        else if (args[3] === "Enter") entered++;
        else if (args[3] === "Escape") escaped++;
        return "";
      }
      throw Error("unexpected command");
    },
  };
  const chats = {
    registry,
    page: async (_name, query) => ({ available: true, binding: query.get("binding") }),
  };
  const terminals = { writers: new Map() },
    interaction = new ChatInteraction(chats, terminals);
  const question = await interaction.page("qa", "identity", id);
  assert.equal(question.available, true);
  assert.equal(question.title, "Which layout should be used?");
  assert.equal(question.choices.length, 2);
  await assert.rejects(
    interaction.answer("qa", {
      identity: "identity",
      binding: id,
      token: "0".repeat(24),
      index: 2,
      confirm: true,
    }),
    /问题已经变化/,
  );
  assert.equal(entered, 0);
  terminals.writers.set("qa", {});
  await assert.rejects(
    interaction.answer("qa", {
      identity: "identity",
      binding: id,
      token: question.token,
      index: 2,
      confirm: true,
    }),
    /另一个网页正在输入/,
  );
  terminals.writers.clear();
  const result = await interaction.answer("qa", {
    identity: "identity",
    binding: id,
    token: question.token,
    index: 2,
    confirm: true,
  });
  assert.equal(result.state, "submitted");
  assert.equal(selected, 2);
  assert.equal(entered, 1);
  await assert.rejects(
    interaction.answer("qa", {
      identity: "identity",
      binding: id,
      token: question.token,
      index: 2,
      confirm: true,
    }),
    /已经提交过/,
  );
  assert.equal(entered, 1, "an ambiguous repeat cannot press Enter again");
  assert.equal(terminals.writers.size, 0);
  const requestId = "11111111-1111-4111-8111-111111111111";
  await assert.rejects(
    interaction.interrupt("qa", { identity: "identity", binding: id, requestId, confirm: true }),
    /没有可确认的运行中任务/,
  );
  running = true;
  assert.equal(
    (
      await interaction.interrupt("qa", {
        identity: "identity",
        binding: id,
        requestId,
        confirm: true,
      })
    ).state,
    "submitted",
  );
  assert.equal(escaped, 1);
  await assert.rejects(
    interaction.interrupt("qa", { identity: "identity", binding: id, requestId, confirm: true }),
    /刚刚收到一次中断/,
  );
  assert.equal(escaped, 1, "duplicate or ambiguous interruption cannot press Esc twice");
  const unverified = new ChatInteraction(
    { ...chats, page: async () => ({ available: true, readOnly: true, binding: id }) },
    terminals,
  );
  await assert.rejects(unverified.page("qa", "identity", id), /尚未核实/);
  await assert.rejects(
    unverified.interrupt("qa", { identity: "identity", binding: id, requestId, confirm: true }),
    /尚未核实/,
  );
  assert.equal(escaped, 1, "unverified history never sends terminal keys");
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
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
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
      executablePath: process.env.CHROME_BIN || chromium.executablePath(),
      headless: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env },
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
    socket: "/workspace/tmux.sock",
    target: async (name, identity) => {
      assert.equal(name, "sandbox");
      if (identity !== "test") throw Object.assign(Error("changed"), { status: 409 });
      return { id: "$1" };
    },
    command: async () => pane,
  };
  const chats = new Chats(registry, {
    read: async (input) => {
      assert.equal(input.pane, "%1");
      assert.equal(input.socket, "/workspace/tmux.sock");
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
  pane = "%1\t123";
  const d = chats.page("sandbox", q);
  await new Promise((r) => setImmediate(r));
  finish({ available: true, readOnly: true, binding, messages: [] });
  const unverified = await d;
  assert.equal(unverified.available, true);
  assert.equal(unverified.readOnly, true);
  assert.equal(unverified.sendMode, null);
  assert.match(unverified.identityNotice, /暂时只能查看/);
  const unavailableRegistry = {
    socket: "/workspace/tmux.sock",
    target: async () => ({ id: "$1" }),
    command: async (args) =>
      args[0] === "capture-pane" ? "• Working (5s • esc to interrupt)\n› " : "%1\t123\t30\t0",
  };
  const unavailable = new Chats(unavailableRegistry, {
    read: async () => ({ available: false, reason: "unavailable" }),
  });
  const unreadable = await unavailable.page("sandbox", q);
  assert.equal(unreadable.available, false);
  assert.equal(
    unreadable.runtime.state,
    "running",
    "a temporarily unreadable history does not erase the independent terminal hint",
  );
});

test(
  "mobile chat: real API authorization, Markdown, older pages, updates, routes and logout",
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/chat-");
    let revision = "40",
      requests = 0,
      delay = 0,
      sends = 0,
      modelCommands = 0,
      footer = "› ",
      captureFailed = false,
      choiceSelected = 1,
      questionEnters = 0,
      escapes = 0,
      readOnly = false,
      unreadable = false,
      runtimeUnavailable = false,
      completionMarker = null;
    const questionScreen = () =>
      `Question 1/2 (2 unanswered)\nWhich version should I keep?\n${choiceSelected === 1 ? "›" : " "} 1. Version A\n${choiceSelected === 2 ? "›" : " "} 2. Version B\nPress enter to confirm`;
    const messages = Array.from({ length: 40 }, (_, n) => ({
      id: String(n + 1),
      role: n % 2 ? "assistant" : "user",
      phase: n % 2 ? "final_answer" : null,
      text:
        n % 2
          ? '已经整理好了。\n\n**结论**：手机也能轻松阅读原来的对话。\n\n```python\nprint("hello duck")\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 原会话 | 保留 |\n| 网页预览 | 可用 |'
          : "把原来的 Codex 对话带到手机上，不要新开一段聊天。",
      time: 1789900000000 + n * 60000,
    }));
    messages[38].text = '<img src=x onerror="window.pwned=1">\n[jump](javascript:alert(1))';
    const read = async (input) => {
      requests++;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (unreadable) return { available: false, reason: "unavailable" };
      if (input.revision === revision && !input.before)
        return { available: true, readOnly, binding, revision, unchanged: true };
      const list = messages.filter((m) => !input.before || Number(m.id) < input.before).slice(-20);
      return {
        available: true,
        readOnly,
        binding,
        revision,
        messages: list,
        before: Number(list[0].id) > 1 ? Number(list[0].id) : null,
      };
    };
    const desk = await createDesk({
      runtime: dir + "/runtime",
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
      socket: dir + "/absent.sock",
      allowed: ["sandbox", "notes"],
      secure: false,
      chatDependencies: { read },
      chatSendDependencies: {
        deliver: async (name, entry) => {
          const { text } = entry;
          assert.equal(name, "sandbox");
          assert.equal(entry.binding, binding);
          if (entry.transport === "terminal-model") {
            assert.equal(text, "/model");
            modelCommands++;
            return { state: "submitted" };
          }
          assert(text.includes("\n"));
          sends++;
          return { state: "submitted" };
        },
      },
      voiceDependencies: {
        available: async () => true,
        convert: async () => Buffer.alloc(128),
        recognize: async () => "可爱的小鸭",
      },
    });
    desk.registry.items.sandbox = {
      name: "sandbox",
      label: "示例会话",
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
      { name: "sandbox", identity: "test", id: "$1", windows: 1, attached: 1, cols: 120, rows: 30 },
      {
        name: "notes",
        identity: "notes-test",
        id: "$2",
        windows: 1,
        attached: 0,
        cols: 120,
        rows: 30,
      },
    ];
    desk.registry.command = async (args) => {
      if (args[0] === "capture-pane") {
        if (captureFailed) throw Error("fixture capture unavailable");
        return footer === "QUESTION" ? questionScreen() : footer;
      }
      if (args[0] === "send-keys") {
        if (args[3] === "Down") choiceSelected = 2;
        if (args[3] === "Up") choiceSelected = 1;
        if (args[3] === "Enter") {
          questionEnters++;
          footer = "› ";
        }
        if (args[3] === "Escape") {
          escapes++;
          footer = "› ";
        }
        return "";
      }
      return "%1\t123\t30\t0";
    };
    desk.runtimeStatus.snapshot = async () => {
      if (runtimeUnavailable) throw Error("temporary runtime failure");
      return {
        states: { sandbox: "ready", notes: "running" },
        checkedAt: Date.now(),
        completions: completionMarker ? { notes: completionMarker } : {},
      };
    };
    await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    assert.equal((await fetch(origin + "/api/sessions/sandbox/chat?identity=test")).status, 401);
    assert.equal((await fetch(origin + "/api/sessions/runtime")).status, 401);
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
      executablePath: process.env.CHROME_BIN || chromium.executablePath(),
      headless: true,
      hasTouch: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env },
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
      window.recorders = [];
      window.voiceTracks = [];
      window.vibrations = [];
      Object.defineProperty(navigator, "vibrate", {
        configurable: true,
        value: (pattern) => {
          window.vibrations.push(pattern);
          return true;
        },
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({
            getTracks: () => {
              const track = {
                stopped: false,
                stop() {
                  this.stopped = true;
                },
              };
              window.voiceTracks.push(track);
              return [track];
            },
          }),
        },
      });
      window.MediaRecorder = class {
        static isTypeSupported(type) {
          return type === "audio/webm;codecs=opus";
        }
        constructor(stream, options) {
          this.mimeType = options.mimeType;
          this.state = "inactive";
          window.recorders.push(this);
        }
        start() {
          this.state = "recording";
        }
        emit() {
          const bytes = new Uint8Array(68);
          bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
          this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
        }
        stop() {
          this.state = "inactive";
          queueMicrotask(() => {
            this.emit();
            this.onstop?.();
          });
        }
      };
    });
    await page.goto(origin + "/s/sandbox#chat");
    await page.waitForSelector(".chat-message");
    await page.waitForFunction(() => !chatView.busy);
    const olderReceipt = "11111111-1111-4111-8111-111111111112";
    await page.evaluate((id) => {
      const key = chatView.key(),
        sent = chatView.sent.get(key) || new Map();
      sent.set(id, {
        requestId: id,
        text: "较早送达的消息",
        created: 1789900000000 + 19 * 60000,
        state: "submitted",
        onServer: true,
      });
      chatView.sent.set(key, sent);
      chatView.layout();
    }, olderReceipt);
    assert.equal(
      await page.locator("#chatMessages").evaluate((e) => e.firstElementChild.dataset.receipt),
      olderReceipt,
      "older receipt is inserted before later history, not appended at the bottom",
    );
    await page.evaluate(() => chatView.load());
    assert.equal(
      await page.locator('[data-receipt="' + olderReceipt + '"]').count(),
      0,
      "server-confirmed absence removes an already observed receipt",
    );
    await page.click("#sessionToggle");
    await page.waitForFunction(
      () =>
        document.querySelector('.session-row[data-name="notes"] .session-runtime')?.textContent ===
          "运行中" && !runtimePending,
    );
    runtimeUnavailable = true;
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.locator('.session-row[data-name="notes"] .session-runtime').textContent(),
      "运行中",
      "one status request failure preserves a recent observation",
    );
    await page.evaluate(() => {
      runtimeLastGoodAt = Date.now() - 16000;
    });
    await page.evaluate(() => refreshRuntime());
    assert(
      await page.locator('.session-row[data-name="notes"] .session-runtime').isHidden(),
      "expired all-session observation cannot claim a task is still running",
    );
    runtimeUnavailable = false;
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.locator('.session-row[data-name="notes"] .session-runtime').textContent(),
      "运行中",
      "a fresh snapshot restores the badge",
    );
    await page.click("#sessionClose");
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
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.locator(".session-row.active .session-runtime").textContent(),
      "运行中",
      "a batched ready snapshot must not overwrite a newer active-chat running observation",
    );
    runtimeUnavailable = true;
    await page.evaluate(() => {
      runtimeLastGoodAt = Date.now() - 16000;
    });
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.locator(".session-row.active .session-runtime").textContent(),
      "运行中",
      "a failed batch must not erase a healthy active-chat observation",
    );
    assert(
      await page.locator('.session-row[data-name="notes"] .session-runtime').isHidden(),
      "expired batch state still clears inactive rows",
    );
    runtimeUnavailable = false;
    await page.evaluate(() => {
      chatView.runtimeObservedAt = Date.now() - 9000;
    });
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.locator("#chatRunLabel").textContent(),
      "待命",
      "a newer batch observation takes over when chat polling has stalled",
    );
    assert.equal(
      await page.locator(".session-row.active .session-runtime").textContent(),
      "待命",
      "the active row agrees with the recovered chat label",
    );
    await page.evaluate(() => chatView.load());
    assert.equal(await page.locator("#chatRunLabel").textContent(), "正在运行");
    await page.evaluate(() =>
      chatView.runtime({
        state: "ready",
        source: "terminal-hint",
        checkedAt: chatView.runtimeCheckedAt - 1,
      }),
    );
    assert.equal(
      await page.locator("#chatRunLabel").textContent(),
      "正在运行",
      "an older arriving chat capture cannot reverse the latest status",
    );
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      0,
      "observing a running task does not notify",
    );
    await page.route("**/api/sessions/sandbox/chat?**", (route) => route.abort("failed"), {
      times: 1,
    });
    await page.evaluate(() => chatView.load());
    assert.equal(
      await page.locator("#chatRunLabel").textContent(),
      "正在运行",
      "one failed history request retains the recent terminal state",
    );
    page.removeAllListeners("dialog");
    page.once("dialog", (d) => void d.accept());
    await page.click("#chatInterrupt");
    await page.waitForFunction(
      () => document.querySelector("#chatRunLabel").textContent === "待命",
    );
    assert.equal(escapes, 1, "chat sends one guarded Esc without opening terminal");
    assert.equal(await page.locator("#chatControls").evaluate((e) => e.open), false);
    await page.waitForFunction(() => completionStates.get("sandbox:test")?.state === "ready");
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      0,
      "interrupt to ready without a new final reply is not completion",
    );
    page.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    footer = "› 1. Yes, proceed (y)\nPress enter to confirm or esc to cancel";
    await page.evaluate(() => chatView.load());
    assert.equal(await page.locator("#chatRunLabel").textContent(), "等待操作 ↗");
    footer = "QUESTION";
    await page.evaluate(() => chatView.load());
    await page.locator("#chatQuestion").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#chatQuestion").textContent(),
      /Which version should I keep\?/,
    );
    await page.locator("#chatQuestion .choices button").nth(1).click();
    await page.waitForFunction(() =>
      document.querySelector("#chatQuestion").classList.contains("hidden"),
    );
    assert.equal(questionEnters, 1, "chat answer confirms the current question exactly once");
    assert.equal(
      await page.locator("#chatControls").evaluate((e) => e.open),
      false,
      "question answer never opens terminal controls",
    );
    await page.waitForFunction(() => !chatView.busy);
    footer = "› ";
    await page.evaluate(() => chatView.load());
    assert.equal(await page.locator("#chatRunLabel").textContent(), "待命");
    assert(await page.locator("#chatAttention").isHidden());
    captureFailed = true;
    await page.evaluate(() => chatView.load());
    assert.equal(await page.locator("#chatRunLabel").textContent(), "状态待确认");
    runtimeUnavailable = true;
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.locator("#chatRunLabel").textContent(),
      "状态待确认",
      "two failed observers never invent a ready or running state",
    );
    runtimeUnavailable = false;
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.locator("#chatRunLabel").textContent(),
      "待命",
      "a valid batch hint recovers an unknown chat state",
    );
    assert.equal(
      await page.locator(".session-row.active .session-runtime").textContent(),
      "待命",
      "recovered state is consistent in both places",
    );
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
    await page.click("#chatModel");
    assert(await page.locator("#chatControls").isVisible());
    await page.waitForFunction(() =>
      document.querySelector("#chatControlHint").textContent.includes("模型菜单已打开"),
    );
    assert.equal(modelCommands, 1);
    assert.equal(sends, 0);
    assert.equal(
      await page.locator("#chatPreview,#chatTerminal").count(),
      0,
      "redundant footer buttons are removed",
    );
    await page.click("#chatControlsClose");
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
      const button = await page.locator("#chatModel").boundingBox();
      assert(
        button.y + button.height <= size.height,
        `model action stays visible at ${size.width}x${size.height}: ${button.y + button.height}`,
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
    await page.click('[aria-label="置顶 示例会话"]');
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
    await page.locator("#deskMenu > summary").click();
    await page.click('[data-tab="settings"]');
    await page.waitForTimeout(150);
    assert(await page.locator("#chatPanel").isHidden());
    const count = requests;
    await page.waitForTimeout(200);
    assert.equal(requests, count);
    delay = 500;
    await page.click('[data-tab="chat"]');
    assert.equal(
      await page.locator(".chat-message:last-child").getAttribute("data-id"),
      "61",
      "revisiting renders the last verified page immediately",
    );
    await page.waitForFunction(() => {
      const e = document.querySelector("#chatScroll");
      return e.scrollHeight - e.scrollTop - e.clientHeight < 5;
    });
    assert(
      (await page
        .locator("#chatScroll")
        .evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight)) < 5,
      "re-entering chat starts at latest, not the top",
    );
    assert.equal(
      await page.locator("#chatSend").isDisabled(),
      true,
      "cached history is read-only until the original thread is revalidated",
    );
    await page.waitForFunction(() => !document.querySelector("#chatSend").disabled);
    const cacheCoverage = await page.evaluate(() => {
      const original = {
        item: chatView.item,
        binding: chatView.binding,
        nodes: chatView.nodes,
        revision: chatView.revision,
        before: chatView.before,
      };
      for (let i = 0; i < 6; i++) {
        chatView.item = { name: "cache-" + i, identity: "identity-" + i };
        chatView.binding = "1:1:00000000-0000-0000-0000-000000000001";
        chatView.nodes = new Map([
          [
            "1",
            { record: { id: "1", role: "assistant", text: "snapshot " + i, time: Date.now() } },
          ],
        ]);
        chatView.saveView();
      }
      Object.assign(chatView, original);
      return [chatView.views.has("cache-0:identity-0"), chatView.views.has("cache-5:identity-5")];
    });
    assert.deepEqual(
      cacheCoverage,
      [true, true],
      "switching beyond four sessions retains the first recent conversation",
    );
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
    await page.locator(".event-state[data-state=failed]").waitFor();
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
    footer = "• Working (5s • esc to interrupt)\n› ";
    await page.evaluate(() => chatView.load());
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      0,
      "old final replies do not notify a newly running task",
    );
    messages.push({
      id: "69",
      role: "assistant",
      phase: "final_answer",
      text: "这轮任务已完成。",
      time: Date.now(),
    });
    revision = "70";
    footer = "› ";
    await page.evaluate(() => chatView.load());
    await page.waitForFunction(() => window.vibrations.length === 1);
    await page.evaluate(() => chatView.load());
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      1,
      "repeated ready polls notify only once",
    );
    footer = "• Working (5s • esc to interrupt)\n› ";
    await page.evaluate(() => chatView.load());
    const runningSince = await page.evaluate(() => completionStates.get("sandbox:test").since);
    assert(Number.isFinite(runningSince));
    messages.push({
      id: "70",
      role: "assistant",
      phase: "final_answer",
      text: "已经完成第二轮。",
      time: runningSince - 5000,
    });
    revision = "71";
    footer = "› ";
    await page.evaluate(() => chatView.load());
    await page.waitForFunction(() => window.vibrations.length === 2);
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      2,
      "a new final saved before the terminal redraw still notifies",
    );
    footer = "• Working (5s • esc to interrupt)\n› ";
    await page.evaluate(() => chatView.load());
    footer = "› ";
    await page.evaluate(() => chatView.load());
    await page.waitForTimeout(2600);
    messages.push({
      id: "71",
      role: "assistant",
      phase: "final_answer",
      text: "稍后保存的最终回复。",
      time: Date.now(),
    });
    revision = "72";
    await page.waitForFunction(() => window.vibrations.length === 3);
    await page.evaluate(() => chatView.load());
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      3,
      "late final notifies once after ready, not on every poll",
    );
    messages.push({
      id: "72",
      role: "assistant",
      phase: "final_answer",
      text: "很短的一轮已经完成。",
      time: Date.now(),
    });
    revision = "73";
    await page.evaluate(() => chatView.load());
    await page.waitForFunction(() => window.vibrations.length === 4);
    await page.evaluate(() => chatView.load());
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      4,
      "a final reply alerts once even when both runtime samples are ready",
    );
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
    // One tap starts recording without a popup; final text edits only this draft, never auto-sends.
    const voiceModes = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/voice/transcribe"))
        voiceModes.push(request.postDataJSON().mode);
    });
    await page.fill("#chatDraft", "原草稿：");
    const composerHeight = await page
      .locator(".chat-bottom")
      .evaluate((e) => e.getBoundingClientRect().height);
    await page.click("#chatVoice");
    await page.waitForFunction(() => recorders.length === 1);
    assert.equal(await page.locator("#voicePanel").count(), 0, "the old popup is removed");
    assert.match(await page.locator("#voiceStatus").textContent(), /正在录音/);
    assert.equal(await page.locator("#chatVoice").getAttribute("data-voice"), "listening");
    assert(
      Math.abs(
        (await page.locator(".chat-bottom").evaluate((e) => e.getBoundingClientRect().height)) -
          composerHeight,
      ) < 1,
      "normal recording never expands the composer",
    );
    assert.equal(await page.evaluate(() => recorders.at(-1).mimeType), "audio/webm;codecs=opus");
    await page.click("#chatVoice");
    await page.waitForFunction(
      () => document.querySelector("#chatDraft").value === "原草稿：可爱的小鸭",
    );
    assert.equal(await page.inputValue("#chatDraft"), "原草稿：可爱的小鸭");
    assert.equal(sends, 2);
    assert(voiceModes.includes("accurate"), "tap-to-dictate sends final audio to the quality path");
    assert(await page.locator("#voiceStatus").isHidden());
    assert(
      Math.abs(
        (await page.locator(".chat-bottom").evaluate((e) => e.getBoundingClientRect().height)) -
          composerHeight,
      ) < 1,
      "final recognition restores the same composer height",
    );
    await page.click("#chatVoice");
    await page.waitForFunction(() => recorders.length === 2);
    await page.fill("#chatDraft", "手动改字");
    assert(await page.evaluate(() => recorders.at(-1).state === "inactive"));
    assert.equal(await page.inputValue("#chatDraft"), "手动改字");
    await page.click("#chatVoice");
    await page.waitForFunction(() => recorders.length === 3);
    await page.evaluate(() => chatView.voice.close());
    assert(await page.locator("#voiceStatus").isHidden());
    assert(await page.evaluate(() => voiceTracks.at(-1).stopped));
    await page.fill("#chatDraft", "");
    await page.evaluate(() =>
      document.querySelector("#chatVoice").dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 7,
          pointerType: "touch",
          button: 0,
        }),
      ),
    );
    await page.waitForFunction(() => recorders.length === 4);
    await page.evaluate(() => {
      chatView.voice.startedAt = Date.now() - 3200;
      recorders.at(-1).emit();
    });
    await page.waitForFunction(() =>
      document.querySelector("#voiceStatus").textContent.includes("边说边识别"),
    );
    assert(voiceModes.includes("fast"), "provisional text stays on the fast path");
    assert.equal(
      await page.inputValue("#chatDraft"),
      "",
      "provisional words never enter the draft",
    );
    assert.equal(sends, 2);
    assert.equal(
      await page.locator("#chatDraft").getAttribute("placeholder"),
      "可爱的小鸭",
      "provisional words use the existing input without adding a row",
    );
    assert(
      Math.abs(
        (await page.locator(".chat-bottom").evaluate((e) => e.getBoundingClientRect().height)) -
          composerHeight,
      ) < 1,
    );
    await page.evaluate(() =>
      document.querySelector("#chatVoice").dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 7,
          pointerType: "touch",
          button: 0,
        }),
      ),
    );
    await page.waitForFunction(() => document.querySelector("#chatDraft").value === "可爱的小鸭");
    await page.evaluate(() =>
      document
        .querySelector("#chatVoice")
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })),
    );
    assert(await page.locator("#voiceStatus").isHidden());
    assert.equal(sends, 2, "release inserts final text but never sends");
    assert.equal(await page.locator("#chatDraft").getAttribute("placeholder"), "继续这段对话…");
    await page.fill("#chatDraft", "手动改字");
    await page.evaluate(() => {
      window.originalGetUserMedia = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = () =>
        new Promise((resolve) => {
          window.grantVoice = () => {
            const track = {
              stopped: false,
              stop() {
                this.stopped = true;
              },
            };
            window.voiceTracks.push(track);
            resolve({ getTracks: () => [track] });
          };
        });
    });
    await page.evaluate(() =>
      document.querySelector("#chatVoice").dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 8,
          pointerType: "touch",
          button: 0,
        }),
      ),
    );
    await page.waitForFunction(() =>
      document.querySelector("#voiceStatus").textContent.includes("正在打开麦克风"),
    );
    await page.evaluate(() => {
      const button = document.querySelector("#chatVoice");
      button.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 8,
          pointerType: "touch",
          button: 0,
        }),
      );
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      window.grantVoice();
    });
    await page.waitForFunction(() => voiceTracks.at(-1).stopped);
    assert.equal(
      await page.evaluate(() => recorders.length),
      4,
      "release before permission never starts recording",
    );
    assert.equal(await page.inputValue("#chatDraft"), "手动改字");
    assert.equal(sends, 2);
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = window.originalGetUserMedia;
    });
    await page.click("#chatVoice");
    await page.waitForFunction(() => recorders.length === 5);
    await page.click('#sessionList a[href="/s/notes#chat"]');
    await page.waitForFunction(
      () => location.pathname === "/s/notes" && !document.querySelector("#chatDraft").disabled,
    );
    assert.equal(await page.inputValue("#chatDraft"), "");
    await page.click("#chatVoice");
    await page.waitForFunction(() => recorders.length === 6);
    await page.click('#sessionList a[href="/s/sandbox#chat"]');
    await page.waitForFunction(
      () => location.pathname === "/s/sandbox" && !document.querySelector("#chatDraft").disabled,
    );
    assert.equal(await page.inputValue("#chatDraft"), "手动改字");
    assert.equal(sends, 2);
    // Session selection is navigation, not a tmux mutation; draft stays in its chat.
    const sessionOrderBeforeVisits = await page.evaluate(() =>
      sessionView.items.map((item) => item.name),
    );
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
    await page.click('[aria-label="取消置顶 示例会话"]');
    assert.deepEqual(
      await page.locator(".session-row").evaluateAll((rows) => rows.map((row) => row.dataset.name)),
      sessionOrderBeforeVisits,
      "recording a visit does not move rows after removing the pin",
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
    const beforeOutage = await page.locator(".chat-message").count();
    footer = "• Working (5s • esc to interrupt)\n› ";
    unreadable = true;
    await page.evaluate(() => {
      chatView.active = true;
      return chatView.load();
    });
    assert.equal(
      await page.locator(".chat-message").count(),
      beforeOutage,
      "a transient reader failure keeps the last confirmed history visible",
    );
    assert.equal(
      await page.locator("#chatRunLabel").textContent(),
      "正在运行",
      "conversation read failure still shows observed terminal activity",
    );
    assert(await page.locator("#chatDraft").isDisabled());
    assert.equal(await page.inputValue("#chatDraft"), "待取回的原文 0");
    assert.equal(
      await page.evaluate(() => chatView.active),
      true,
      "transient failure keeps the retry loop alive",
    );
    unreadable = false;
    footer = "› ";
    await page.evaluate(() => chatView.load());
    assert.equal(await page.evaluate(() => chatView.active), true);
    assert(await page.locator("#chatDraft").isEnabled());
    assert.equal(await page.inputValue("#chatDraft"), "待取回的原文 0");
    readOnly = true;
    await page.evaluate(() => {
      chatView.active = true;
      return chatView.load();
    });
    await page.waitForFunction(
      () => document.querySelector("#chatSend").textContent === "只读记录",
    );
    assert((await page.locator(".chat-message").count()) > 0);
    assert(await page.locator("#chatDraft").isDisabled());
    assert.match(await page.locator("#chatStatus").textContent(), /暂时只能查看/);
    assert.equal(sends, 2);
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      0,
      "opening an existing conversation does not notify for old history",
    );
    await page.locator("#deskMenu > summary").click();
    await page.click('[data-tab="settings"]');
    await page.click("#testVibration");
    assert.match(await page.locator("#vibrationStatus").textContent(), /已请求|不支持|未允许/);
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      1,
      "manual diagnostic calls the same browser vibration API once",
    );
    const markerBinding = "123:456:22222222-2222-2222-2222-222222222222";
    completionMarker = { identity: "wrong", binding: markerBinding, id: "10", time: Date.now() };
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      1,
      "a marker from the wrong session identity cannot notify",
    );
    completionMarker = {
      identity: "notes-test",
      binding: markerBinding,
      id: "10",
      time: Date.now() - 3600000,
    };
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      1,
      "the first old completed turn is only a baseline",
    );
    completionMarker = {
      identity: "notes-test",
      binding: markerBinding,
      id: "11",
      time: Date.now(),
    };
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      2,
      "an inactive short turn notifies even when both sampled states are running",
    );
    await page.evaluate(() => refreshRuntime());
    assert.equal(
      await page.evaluate(() => window.vibrations.length),
      2,
      "the same saved completion never notifies twice",
    );
    await page.click("#deskMenu summary");
    await page.click("#logout");
    await page.waitForSelector("#login", { state: "visible" });
    assert.equal(await page.locator(".chat-message").count(), 0);
    assert.equal((await fetch(origin + "/api/sessions/sandbox/chat?identity=test")).status, 401);
    assert.deepEqual(errors, []);
    console.log("Chat screenshots:", dir);
  },
);
