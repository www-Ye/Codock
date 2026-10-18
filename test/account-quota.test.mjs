import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { AccountQuota, quotaBuckets } from "../lib/account-quota.mjs";
import { createDesk } from "../server.mjs";
import { chromium } from "playwright-core";

const result = {
  rateLimitsByLimitId: {
    codex: {
      limitName: null,
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 },
      secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 2000000100 },
    },
    other: { limitName: "Other", primary: { usedPercent: 10, windowDurationMins: 60 } },
  },
  email: "must-not-leak",
  token: "must-not-leak",
};
test("quota windows, privacy, coalescing, TTL and stale recovery", async () => {
  let now = 1,
    calls = 0,
    fail = false;
  const quota = new AccountQuota("/unused", {
    now: () => now,
    read: async () => {
      calls++;
      if (fail) throw Error("secret");
      return result;
    },
  });
  const [a, b] = await Promise.all([quota.snapshot(), quota.snapshot()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(a.buckets[0].windows[0].remainingPercent, 75);
  assert.equal(a.buckets[0].windows[1].durationMins, 10080);
  assert.equal(a.buckets.length, 2);
  assert.doesNotMatch(JSON.stringify(a), /must-not-leak/);
  await quota.snapshot();
  assert.equal(calls, 1);
  now += 60001;
  fail = true;
  const stale = await quota.snapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.checkedAt, 1);
  await quota.snapshot();
  assert.equal(calls, 2);
  now += 30001;
  fail = false;
  assert.equal((await quota.snapshot()).stale, false);
  assert.deepEqual(
    quotaBuckets({ rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } }),
    [],
  );
  assert.equal(
    quotaBuckets({ rateLimits: { primary: { usedPercent: 120, windowDurationMins: 15 } } })[0]
      .windows[0].remainingPercent,
    0,
  );
});

test("authenticated quota and compact phone/desktop display", { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/quota-");
  const desk = await createDesk({
    runtime: dir + "/runtime",
    socket: dir + "/absent.sock",
    allowed: [],
    secure: false,
    quotaDependencies: { read: async () => result },
  });
  await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
  t.after(() => desk.close());
  const origin = "http://127.0.0.1:" + desk.server.address().port;
  desk.config.origin = origin;
  assert.equal((await fetch(origin + "/api/account/quota")).status, 401);
  const cookie = desk.auth
    .cookie(desk.auth.issue({ login: "fixture" }))
    .split(";")[0]
    .split("=");
  const browser = await chromium.launchPersistentContext(dir + "/browser", {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    env: { ...process.env, TMPDIR: process.env.TMPDIR },
  });
  t.after(() => browser.close());
  await browser.addCookies([
    { name: cookie[0], value: cookie[1], url: origin, httpOnly: true, sameSite: "Strict" },
  ]);
  const page = browser.pages()[0],
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(
    () => document.querySelector("#quotaMenu summary")?.textContent === "75%",
  );
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => {
      document.body.classList.add("workspace-mode");
      document.querySelector("#title").textContent = "movie1";
      document.querySelector("#quotaMenu").open = true;
    });
    assert.match(await page.locator(".quota-panel").textContent(), /5 小时.*75%.*7 天.*58%/);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const box = await page.locator(".quota-panel").boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width);
  }
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#quotaMenu").evaluate((el) => el.open), false);
  assert.deepEqual(errors, []);
});
