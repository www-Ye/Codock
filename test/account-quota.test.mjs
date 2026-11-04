import { renderIndex } from "../lib/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { AccountQuota, quotaBuckets } from "../lib/account-quota.mjs";
import { accountRpcError } from "../lib/account-rpc.mjs";
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

test("expired quota authentication refreshes once, coalesces callers and retains old data if recovery fails", async () => {
  let reads = 0,
    refreshes = 0,
    expired = true,
    network = false,
    now = 1;
  const quota = new AccountQuota("/unused", {
    now: () => now,
    read: async () => {
      reads++;
      if (network) throw accountRpcError({ message: "HTTP 503 network failure: must-not-leak" });
      if (expired)
        throw accountRpcError({ message: "HTTP status 401: token_expired; must-not-leak" });
      return result;
    },
    refresh: async () => {
      refreshes++;
      expired = false;
    },
  });
  const [a, b] = await Promise.all([quota.snapshot(), quota.snapshot()]);
  assert.deepEqual(a, b);
  assert.equal(a.stale, false);
  assert.equal(reads, 2);
  assert.equal(refreshes, 1);
  now += 60001;
  expired = true;
  quota.refresh = async () => {
    refreshes++;
  };
  const failed = await quota.snapshot();
  assert.equal(failed.stale, true);
  assert.deepEqual(failed.buckets, a.buckets);
  assert.equal(refreshes, 2, "a failed retry never loops");
  assert.equal(reads, 4);
  await quota.snapshot();
  assert.equal(reads, 4, "cached failures do not repeatedly refresh tokens");
  now += 30001;
  network = true;
  await quota.snapshot();
  assert.equal(refreshes, 2, "network errors do not refresh credentials");
  assert(!JSON.stringify(failed).includes("must-not-leak"));
  assert(!accountRpcError({ message: "HTTP 403 forbidden" }).authExpired);
  assert(!accountRpcError({ message: "HTTP 429 rate limited" }).authExpired);
});

test("authenticated quota and compact phone/desktop display", { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/quota-");
  const desk = await createDesk({
    runtime: dir + "/runtime",
    codexHome: dir + "/runtime" + "/codex",
    claudeHome: dir + "/runtime" + "/claude",
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
      document.querySelector("#title").textContent = "dev";
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

test(
  "account pool automatically shows individual reset times without switching accounts",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/account-resets-");
    const server = http.createServer(async (req, res) => {
      try {
        const name = new URL(req.url, "http://localhost").pathname;
        const file = path.resolve("public", name === "/" ? "index.html" : "." + name);
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
    const browser = await chromium.launchPersistentContext(dir + "/browser", {
      executablePath: process.env.CHROME_BIN || chromium.executablePath(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: dir },
      viewport: { width: 390, height: 844 },
    });
    t.after(() => browser.close());
    const page = browser.pages()[0],
      errors = [],
      requests = [],
      accounts = Array.from({ length: 6 }, (_, i) => ({
        id: "fixture" + i,
        label: "账号 " + (i + 1),
        state: "ready",
        plan: "pro",
      }));
    let failFirst = false;
    const now = Date.now();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/**", async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        p = url.pathname;
      let value = {};
      assert.equal(req.method(), "GET", "reading quotas does not switch accounts or send messages");
      if (p === "/api/bootstrap")
        value = { configured: true, authenticated: true, methods: { github: true } };
      else if (p === "/api/sessions") value = { sessions: [] };
      else if (p === "/api/sessions/runtime") value = { states: {}, checkedAt: now };
      else if (p === "/api/accounts") value = { accounts };
      else if (p === "/api/accounts/system") value = { accountId: "fixture0", label: "账号 1" };
      else if (p === "/api/system") value = { available: false };
      else if (p === "/api/guardian") value = { tasks: [], events: [], messages: [], busy: false };
      else if (p === "/api/account/quota") {
        const id = url.searchParams.get("account");
        if (!id) value = { available: false, buckets: [] };
        else {
          requests.push(id);
          const i = accounts.findIndex((a) => a.id === id);
          if (i === 3 || (i === 0 && failFirst)) {
            await route.fulfill({ status: 503, json: { error: "暂时连接不上" } });
            return;
          }
          value = {
            available: true,
            stale: i === 4,
            checkedAt: now,
            buckets: [
              {
                id: "codex",
                windows: [
                  {
                    durationMins: 10080,
                    remainingPercent: i === 1 ? 0 : 80 - i,
                    resetsAt: i === 2 ? null : i === 1 ? now - 60000 : now + (i + 1) * 86400000,
                  },
                ],
              },
            ],
          };
          if (i === 0)
            value.buckets[0].windows.unshift({
              durationMins: 300,
              remainingPercent: 75,
              resetsAt: now + 3600000,
            });
        }
      }
      await route.fulfill({ json: value });
    });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.locator("#deskMenu>summary").click();
    await page.locator(".account-toggle").click();
    await page.getByText("未提供重置时间", { exact: true }).waitFor();
    await page.getByText("额度暂时读不到，稍后自动重试", { exact: true }).waitFor();
    await page.locator(".accounts-quota-tools button:not([disabled])").waitFor();
    assert.equal(await page.locator(".account-quota-countdown").count(), 6);
    assert.equal(await page.getByRole("button", { name: "查看额度", exact: true }).count(), 0);
    assert.match(
      await page.getByRole("region", { name: "账号 1 额度与重置" }).textContent(),
      /5 小时额度剩余 75%.*后重置.*7 天额度剩余 80%/,
    );
    assert.match(
      await page.getByRole("region", { name: "账号 2 额度与重置" }).textContent(),
      /剩余 0%.*重置时间已到，等待额度更新/,
    );
    assert.match(
      await page.getByRole("region", { name: "账号 5 额度与重置" }).textContent(),
      /上次数据/,
    );
    assert.equal(requests.length, 6);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const box = await page.locator(".accounts-dialog").boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width);
      assert(
        await page.locator(".accounts-dialog").evaluate((n) => n.scrollWidth <= n.clientWidth),
      );
      await page.screenshot({ path: dir + "/accounts-" + width + ".png" });
    }
    await page.getByRole("button", { name: "关闭账号管理" }).click();
    await page.locator("#deskMenu>summary").click();
    await page.locator(".account-toggle").click();
    assert.equal(requests.length, 6, "reopening uses cached quota");
    failFirst = true;
    await page.getByRole("button", { name: "刷新额度", exact: true }).click();
    await page
      .getByRole("region", { name: "账号 1 额度与重置" })
      .getByText("上次数据", { exact: false })
      .waitFor();
    assert.match(
      await page.getByRole("region", { name: "账号 1 额度与重置" }).textContent(),
      /剩余 75%/,
      "an unavailable refresh retains the prior observation",
    );
    assert.deepEqual(errors, []);
    console.log("Account reset previews: " + dir);
  },
);
