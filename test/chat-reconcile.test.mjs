import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createDesk } from "../server.mjs";

test(
  "manual Enter recovery unblocks chat automatically, including unchanged history and stale browser storage",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/rc-");
    const binding = "123:456:11111111-1111-1111-1111-111111111111",
      text = "手动回车的中文原文\n第二行";
    let accepted = false,
      sends = 0,
      firstId;
    const desk = await createDesk({
      runtime: dir + "/runtime",
      socket: dir + "/absent.sock",
      allowed: ["sandbox"],
      secure: false,
      chatDependencies: {
        read: async (request) => {
          if (request.lookup)
            return {
              available: true,
              binding,
              matches: accepted ? [{ id: "77", role: "user", time: Date.now(), text }] : [],
            };
          return request.revision === "1"
            ? { available: true, binding, revision: "1", unchanged: true }
            : {
                available: true,
                binding,
                revision: "1",
                messages: [
                  {
                    id: "100",
                    role: "assistant",
                    text: "更晚的对话，原用户消息不在首屏",
                    time: Date.now(),
                  },
                ],
                before: 100,
              };
        },
      },
      chatSendDependencies: {
        deliver: async (name, entry) => {
          sends++;
          if (sends === 1) {
            firstId = entry.requestId;
            return { state: "unknown", message: "文字已粘贴但回车未确认" };
          }
          return { state: "submitted" };
        },
      },
    });
    desk.registry.items.sandbox = {
      name: "sandbox",
      label: "回执恢复",
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
    const [name, value] = desk.auth
      .cookie(desk.auth.issue({ login: "isolated-fixture" }))
      .split(";")[0]
      .split("=");
    await browser.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/s/sandbox#chat");
    await page.waitForFunction(() => !document.querySelector("#chatSend").disabled);
    await page.fill("#chatDraft", text);
    await page.click("#chatSend");
    await page.waitForFunction(() =>
      document.querySelector("#chatSendStatus").textContent.includes("回车未确认"),
    );
    assert(await page.locator("#chatDraft").isDisabled());
    // Represents the original Codex committing the user's manual Enter.
    accepted = true;
    await page.waitForFunction(() => !document.querySelector("#chatSend").disabled);
    assert.equal(await page.inputValue("#chatDraft"), "");
    assert.equal(await page.locator('[data-receipt="' + firstId + '"]').count(), 0);
    assert.equal(sends, 1, "reconciliation never resends or presses Enter");
    const persisted = JSON.parse(
      await readFile(dir + "/runtime/chat-receipts/" + firstId + ".json", "utf8"),
    );
    assert.equal(persisted.state, "submitted");
    assert.equal(persisted.observed, "77");
    await page.fill("#chatDraft", "新的指令");
    await page.click("#chatSend");
    await page.waitForFunction(
      () =>
        !document.querySelector("#chatSend").disabled &&
        document.querySelector("#chatDraft").value === "",
    );
    assert.equal(sends, 2, "a genuinely new message can now be sent");
    // Another/stale page may still hold the old unknown ID after reconciliation.
    await page.evaluate(
      (id) =>
        sessionStorage.setItem(
          "workbench.chat.receipt.sandbox:test:123:456:11111111-1111-1111-1111-111111111111",
          id,
        ),
      firstId,
    );
    await page.reload();
    await page.waitForSelector(".chat-message.assistant");
    await page.waitForFunction(() => !document.querySelector("#chatSend").disabled);
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem(
          "workbench.chat.receipt.sandbox:test:123:456:11111111-1111-1111-1111-111111111111",
        ),
      ),
      null,
    );
    assert.equal(sends, 2);
    assert.deepEqual(errors, []);
    console.log("Receipt reconciliation browser:", dir);
  },
);
