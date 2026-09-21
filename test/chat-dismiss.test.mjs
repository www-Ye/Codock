import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { createDesk } from "../server.mjs";

test(
  "failed-message remove: authenticated HTTP, mobile UI, cross-page polling and reload",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/db-");
    const binding = "123:456:11111111-1111-1111-1111-111111111111";
    let deliveries = 0;
    const desk = await createDesk({
      runtime: dir + "/runtime",
      socket: dir + "/absent.sock",
      allowed: ["sandbox"],
      secure: false,
      chatDependencies: {
        read: async () => ({
          available: true,
          binding,
          revision: "1",
          messages: [
            { id: "1", role: "assistant", text: "保留的聊天历史", time: Date.now() - 60000 },
          ],
          before: null,
        }),
      },
      chatSendDependencies: {
        deliver: async () => {
          deliveries++;
          return { state: "failed", message: "隔离测试：未发送" };
        },
      },
    });
    desk.registry.items.sandbox = {
      name: "sandbox",
      label: "移除验收",
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
    const cookie = desk.auth.cookie(desk.auth.issue({ login: "isolated-fixture" })).split(";")[0];
    const post = async (text) => {
      const input = {
        requestId: randomUUID(),
        identity: "test",
        binding,
        text,
        confirm: true,
        transport: "terminal-enter",
      };
      const response = await fetch(origin + "/api/sessions/sandbox/chat", {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      assert.equal((await response.json()).state, "failed");
      return input;
    };
    const first = await post("不要的失败消息一"),
      second = await post("不要的失败消息二");
    const endpoint = origin + "/api/sessions/sandbox/chat/receipts/" + first.requestId;
    const body = JSON.stringify({ identity: "test", binding });
    assert.equal(
      (
        await fetch(endpoint, {
          method: "DELETE",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: "DELETE",
          headers: {
            Cookie: cookie,
            Origin: "https://other.invalid",
            "Content-Type": "application/json",
          },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: "DELETE",
          headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ identity: "wrong", binding }),
        })
      ).status,
      404,
    );
    const browser = await chromium.launchPersistentContext(dir + "/profile", {
      executablePath: process.env.DESK_CHROMIUM,
      headless: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: process.env.TMPDIR },
    });
    t.after(() => browser.close());
    const [name, value] = cookie.split("=");
    await browser.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = browser.pages()[0],
      other = await browser.newPage(),
      errors = [];
    for (const p of [page, other]) {
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(origin + "/s/sandbox#chat");
      await p.waitForSelector(".failed-sends");
    }
    await page.bringToFront();
    await page.fill("#chatDraft", "保留我正在编辑的草稿");
    await page.click(".failed-sends>summary");
    await page.screenshot({ path: dir + "/remove-mobile.png" });
    // Hold an old GET snapshot across the removal: it must not resurrect a row.
    let release, seen;
    const ready = new Promise((r) => (seen = r)),
      held = new Promise((r) => (release = r));
    await page.route(
      "**/api/sessions/sandbox/chat?*",
      async (route) => {
        const response = await route.fetch();
        seen();
        await held;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await page.waitForFunction(() => !chatView.busy);
    await page.evaluate(() => {
      void chatView.load();
    });
    await ready;
    await page.locator('[data-receipt="' + first.requestId + '"] .dismiss-failed').click();
    await page.waitForFunction(
      (id) => !document.querySelector('[data-receipt="' + id + '"]'),
      first.requestId,
    );
    release();
    await page.waitForFunction(() => !chatView.busy);
    assert.equal(
      await page.locator('[data-receipt="' + first.requestId + '"]').count(),
      0,
      "late snapshot cannot restore removed row",
    );
    assert.equal(await page.inputValue("#chatDraft"), "保留我正在编辑的草稿");
    assert.match(await page.locator(".failed-sends>summary").textContent(), /1 条未发送/);
    await other.bringToFront();
    await other.waitForFunction(() =>
      document.querySelector(".failed-sends>summary")?.textContent.startsWith("1 条"),
    );
    await other.click(".failed-sends>summary");
    await other.locator(".dismiss-failed").click();
    await other.waitForFunction(() => !document.querySelector(".failed-sends"));
    await page.bringToFront();
    await page.waitForFunction(() => !document.querySelector(".failed-sends"));
    assert.equal(await page.inputValue("#chatDraft"), "保留我正在编辑的草稿");
    await page.reload();
    await page.waitForSelector(".chat-message.assistant");
    assert.equal(await page.locator(".failed-sends").count(), 0);
    assert.match(await page.locator(".chat-message.assistant").textContent(), /保留的聊天历史/);
    for (const input of [first, second]) {
      const receipt = JSON.parse(
        await readFile(dir + "/runtime/chat-receipts/" + input.requestId + ".json", "utf8"),
      );
      assert(receipt.dismissedAt);
      assert.equal(receipt.text, input.text);
    }
    assert.equal(deliveries, 2, "removal never sends text or keys");
    assert.deepEqual(errors, []);
    console.log("Dismiss UI artifacts:", dir);
  },
);
