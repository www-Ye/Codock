import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createDemo } from "./fixtures/demo.mjs";

test(
  "session positions survive fast and delayed visit receipts; refresh applies recency",
  { timeout: 20000 },
  async (t) => {
    const demo = await createDemo();
    t.after(() => demo.desk.close());
    const browser = await chromium.launchPersistentContext(demo.directory + "/navigation", {
      executablePath: process.env.DESK_CHROMIUM,
      headless: true,
      viewport: { width: 1360, height: 900 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    t.after(() => browser.close());
    const [name, value] = demo.desk.auth
      .cookie(demo.desk.auth.issue({ login: "fixture" }))
      .split(";")[0]
      .split("=");
    await browser.addCookies([{ name, value, url: demo.origin }]);
    const page = browser.pages()[0];
    await page.goto(demo.origin + "/s/demo#chat");
    await page.waitForFunction(() => sessions.find((s) => s.name === "demo")?.lastOpenedAt > 0);
    const order = () =>
      page.locator(".session-row").evaluateAll((rows) => rows.map((row) => row.dataset.name));
    for (const delayed of [false, true]) {
      await page.evaluate(() => {
        sessions.forEach((s, i) => {
          s.lastOpenedAt = i + 1;
        });
        sessionView.update(sessions, current);
      });
      const before = await order();
      const pending = [];
      await page.route("**/visit", async (route) => {
        const response = await route.fetch();
        if (delayed) await new Promise((resolve) => pending.push(resolve));
        await route.fulfill({ response });
      });
      for (const [i, target] of ["design", "demo"].entries()) {
        await page.click(`#sessionList a[href="/s/${target}#chat"]`);
        await page.waitForFunction(
          (name) => current?.name === name && !document.querySelector("#chatDraft").disabled,
          target,
        );
        if (delayed) {
          // Observe the held response, not a timing-based sleep.
          const deadline = Date.now() + 5000;
          while (pending.length <= i && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(pending.length, i + 1);
        } else {
          await page.waitForFunction(
            (name) => sessions.find((s) => s.name === name).lastOpenedAt > 3,
            target,
          );
        }
        assert.deepEqual(await order(), before);
      }
      for (const release of pending.reverse()) release();
      await page.waitForFunction(() =>
        ["demo", "design"].every((name) => sessions.find((s) => s.name === name).lastOpenedAt > 3),
      );
      assert.deepEqual(await order(), before, "late receipts cannot reshuffle visible rows");
      await page.unroute("**/visit");
      await page.evaluate(() => refresh());
      assert.equal((await order())[0], "demo", "explicit refresh applies the newest visit");
    }
  },
);
