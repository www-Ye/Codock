import { renderIndex } from "../lib/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { chromium } from "playwright-core";
import http from "node:http";
import path from "node:path";

test(
  "guardian compact session header, bounded panels and reversible watch removal",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/guardian-ui-");
    const server = http.createServer(async (req, res) => {
      try {
        const name = new URL(req.url, "http://localhost").pathname;
        const file = path.resolve(
          "public",
          name === "/" || name === "/s/eval" ? "index.html" : "." + name,
        );
        if (!file.startsWith(path.resolve("public") + "/")) throw Error();
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html",
        );
        res.end(
          file.endsWith("index.html")
            ? renderIndex(await readFile(file, "utf8"))
            : await readFile(file),
        );
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const browser = await chromium.launchPersistentContext(dir + "/profile", {
      executablePath: process.env.CHROME_BIN || chromium.executablePath(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env },
      viewport: { width: 390, height: 844 },
    });
    t.after(() => browser.close());
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.guardianVibrations = [];
      Object.defineProperty(navigator, "vibrate", {
        configurable: true,
        value: (p) => {
          window.guardianVibrations.push(p);
          return true;
        },
      });
    });
    const task = {
      id: "task",
      session: "build",
      title: "视频转换与发布",
      enabled: true,
      snapshot: { state: "running", done: 12000, total: 21252, percent: 56, updatedAt: Date.now() },
    };
    const state = {
      tasks: [
        task,
        ...Array.from({ length: 12 }, (_, i) => ({
          ...task,
          id: "other-" + i,
          title: "评测批次 " + i,
        })),
        { ...task, id: "done", title: "早前已完成的任务", snapshot: { state: "completed" } },
        { ...task, id: "paused", title: "已经暂停的任务", enabled: false },
      ],
      events: [
        {
          id: "event",
          taskId: "task",
          session: "data",
          text: "模型修正：已完成",
          read: false,
          time: Date.now(),
        },
        ...Array.from({ length: 20 }, (_, i) => ({
          id: "old-" + i,
          session: "eval",
          text: "早前提醒 " + i,
          read: true,
          time: Date.now(),
        })),
      ],
      messages: Array.from({ length: 45 }, (_, i) => ({
        id: "m" + i,
        role: i % 2 ? "assistant" : "user",
        text: "之前的进度 " + i,
        time: Date.now(),
      })),
      busy: false,
    };
    await page.route("**/api/**", async (route) => {
      const req = route.request(),
        p = new URL(req.url()).pathname;
      let value = {};
      if (p === "/api/bootstrap")
        value = { configured: true, authenticated: true, methods: { github: true } };
      else if (p === "/api/sessions")
        value = {
          sessions: [
            { name: "eval", label: "eval", identity: "identity", state: "online", windows: 1 },
          ],
        };
      else if (p === "/api/sessions/eval/chat") value = { available: false, messages: [] };
      else if (p === "/api/guardian") {
        if (req.method() === "PATCH") {
          const b = req.postDataJSON();
          if (b.readAll) state.events.forEach((e) => (e.read = true));
          else if (b.eventId) state.events.find((e) => e.id === b.eventId).read = true;
          else if (b.pauseAll) state.tasks.forEach((t) => (t.enabled = false));
          else {
            const t = state.tasks.find((t) => t.id === b.id);
            Object.assign(t, b);
            if (b.archived) t.enabled = false;
          }
        }
        value = state;
      } else if (p === "/api/guardian/chat") {
        state.messages.push({
          id: "reply",
          role: "assistant",
          text: "build 转换到 56%，发布还没完成。",
          time: Date.now(),
        });
        value = state;
      } else if (p === "/api/accounts") value = { accounts: [] };
      else if (p === "/api/accounts/system")
        value = { label: "一个特别长的系统账号名称", accountId: "fixture" };
      else if (p === "/api/account/quota") value = { available: false, buckets: [] };
      else if (p === "/api/sessions/runtime") value = { states: {}, checkedAt: Date.now() };
      else if (p === "/api/system") value = { available: false };
      await route.fulfill({ json: value });
    });
    state.checkedAt = Date.now();
    await page.goto("http://127.0.0.1:" + server.address().port + "/s/eval");
    await page.locator("#title").getByText("eval", { exact: true }).waitFor();
    await page.evaluate(async () => {
      await guardianDesk.refresh();
      vibrateOnce("build:identity", "small-reply-1");
    });
    assert.equal(
      await page.evaluate(() => window.guardianVibrations.length),
      0,
      "watched sessions do not bypass the guardian through ordinary reply vibrations",
    );
    state.events.push({
      id: "milestone",
      taskId: "task",
      session: "build",
      text: "整批转换并发布完成",
      state: "completed",
      read: false,
      time: Date.now(),
    });
    await page.evaluate(() => guardianDesk.refresh());
    assert.equal(
      await page.evaluate(() => window.guardianVibrations.length),
      1,
      "an approved milestone alerts once",
    );
    await page.evaluate(async () => {
      await guardianDesk.refresh();
      vibrateOnce("build:identity", "small-reply-2");
    });
    assert.equal(
      await page.evaluate(() => window.guardianVibrations.length),
      1,
      "duplicate polling and ordinary replies stay quiet",
    );
    state.events.find((e) => e.id === "milestone").read = true;
    for (const size of [
      { width: 320, height: 640 },
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      const selectors = [
        "#sessionToggle",
        ".workspace-head",
        ".tabs",
        ".guardian-toggle",
        "#deskMenu>summary",
      ];
      let end = 0;
      for (const s of selectors) {
        const r = await page.locator(s).boundingBox();
        assert(
          r && r.x >= end - 1 && r.x + r.width <= size.width,
          "no overlapping header: " + s + " at " + size.width,
        );
        end = r.x + r.width;
      }
      assert.equal(await page.locator(".tabs [data-tab=settings]").count(), 0);
      await page.screenshot({ path: dir + "/header-" + size.width + ".png" });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#deskMenu>summary").click();
    await page.locator("#sessionSettings").click();
    await page.locator("#settingsPanel").waitFor({ state: "visible" });
    await page.locator("#deskMenu>summary").click();
    assert(await page.locator(".desk-menu-items .account-toggle").isVisible());
    await page.locator("#quotaShortcut").click();
    await page.locator(".quota-panel").waitFor({ state: "visible" });
    await page.locator(".guardian-toggle").click();
    assert.equal(
      await page.locator(".guardian-register").count(),
      0,
      "watching tasks needs no path form",
    );
    await page.getByText("之前的进度 44", { exact: true }).waitFor();
    assert.equal(await page.locator(".guardian-message").count(), 30);
    await page.locator("[data-guardian-tab=tasks]").click();
    await page.getByText("已检查", { exact: false }).waitFor();
    await page.getByText("12000 / 21252", { exact: false }).first().waitFor();
    assert(await page.getByText("早前已完成的任务", { exact: true }).isHidden());
    await page.screenshot({ path: dir + "/guardian-tasks-390.png" });
    await page.getByRole("button", { name: "移除关注 视频转换与发布", exact: true }).click();
    await page
      .locator(".guardian-tasks-panel>[class=guardian-tasks] [data-task-id=task]")
      .waitFor({ state: "detached" });
    await page.getByText("已移除 · 1", { exact: true }).click();
    await page.locator("[data-task-id=task]").getByRole("button", { name: "恢复关注" }).click();
    await page
      .locator(".guardian-tasks-panel>[class=guardian-tasks] [data-task-id=task]")
      .waitFor();
    await page.getByRole("button", { name: "暂停全部", exact: true }).click();
    await page.getByText("暂无正在关注的任务，直接在对话里告诉我。").waitFor();
    await page.getByText("已完成与已暂停 · 15", { exact: true }).click();
    await page.locator("[data-task-id=task]").getByRole("button", { name: "继续关注" }).click();
    await page.locator("[data-guardian-tab=events]").click();
    assert.equal(await page.locator(".guardian-event.unread").count(), 1);
    await page.getByRole("button", { name: "全部已读", exact: true }).click();
    await page.getByText("没有新提醒。", { exact: true }).waitFor();
    await page.locator("[data-guardian-tab=chat]").click();
    await page.locator(".guardian-compose textarea").fill("现在怎么样了");
    await page
      .locator(".guardian-compose")
      .getByRole("button", { name: "发送", exact: true })
      .click();
    await page.getByText("build 转换到 56%，发布还没完成。").waitFor();
    for (const size of [
      { width: 320, height: 640 },
      { width: 390, height: 420 },
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      const box = await page.locator(".guardian-dialog").boundingBox();
      assert(
        box.x >= 0 &&
          box.x + box.width <= size.width &&
          box.y >= 0 &&
          box.y + box.height <= size.height,
      );
      const compose = await page.locator(".guardian-compose").boundingBox();
      assert(
        compose.y + compose.height <= size.height,
        "composer remains visible with long history",
      );
      await page.waitForFunction(() => {
        const m = document.querySelector(".guardian-messages");
        return m.scrollHeight - m.scrollTop - m.clientHeight < 2;
      });
      await page.screenshot({ path: dir + "/guardian-" + size.width + "x" + size.height + ".png" });
    }
    assert.deepEqual(errors, []);
    console.log("Guardian previews: " + dir);
  },
);
