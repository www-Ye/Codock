import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createDesk } from "../server.mjs";

async function fixture(t, browserTest = false) {
  const dir = await mkdtemp(process.env.TMPDIR + "/pa-");
  const desk = await createDesk({
    runtime: dir + "/runtime",
    codexHome: dir + "/runtime" + "/codex",
    claudeHome: dir + "/runtime" + "/claude",
    socket: dir + "/absent.sock",
    projectRoot: process.cwd(),
    allowed: ["demo"],
    secure: false,
    previewSuffix: "preview.terminal.localhost",
  });
  desk.registry.items.demo = {
    name: "demo",
    label: "demo",
    identity: "fixture",
    revision: 1,
    preview: { type: "static", directory: "examples/workbench-page", entry: "index.html" },
  };
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  t.after(() => desk.close());
  const port = desk.server.address().port,
    origin = "http://terminal.localhost:" + port;
  desk.config.origin = origin;
  desk.config.previewPort = String(port);
  let now = Date.now();
  desk.auth.clock = () => now;
  const token = desk.auth.issue({ provider: "synthetic" }),
    start = now;
  const result = {
    desk,
    origin,
    token,
    advance: (minutes) => {
      now += minutes * 60000;
    },
    setTime: (minutes) => {
      now = start + minutes * 60000;
    },
  };
  if (!browserTest) return result;
  const browser = await chromium.launchPersistentContext(dir + "/profile", {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    env: { ...process.env, TMPDIR: process.env.TMPDIR },
  });
  t.after(() => browser.close());
  await browser.addCookies([
    { name: desk.auth.name, value: token, url: origin, httpOnly: true, sameSite: "Strict" },
  ]);
  const page = browser.pages()[0];
  await page.clock.install();
  await page.goto(origin + "/s/demo#preview");
  await page.waitForFunction(() => previewView.state === "ready");
  return { ...result, browser, page };
}

test(
  "foreground preview survives idle threshold, grant renewal, but not logout or absolute expiry",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, true),
      { desk, page, token, origin } = f;
    assert(await page.evaluate(() => document.hasFocus()));
    for (let i = 0; i < 3; i++) {
      f.advance(20);
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/activity", {
        timeout: 2500,
      });
      await page.clock.fastForward(61000);
      assert.equal((await response).status(), 200);
      await page.click("#reloadPreview");
      await page.waitForFunction(() => previewView.state === "ready");
      assert(await page.locator("#login").isHidden());
    }
    desk.previews.grants.clear();
    await page.click("#reloadPreview");
    await page.clock.runFor(1200);
    await page.waitForFunction(() => previewView.state === "ready");
    assert(
      await page.locator("#login").isHidden(),
      "preview grant renewal does not log out the owner",
    );

    let beats = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/activity") beats++;
    });
    await page.route("**/api/activity", (r) => r.abort());
    await page.clock.fastForward(61000);
    await page.waitForTimeout(30);
    assert(
      await page.locator("#login").isHidden(),
      "transport failure is not authentication failure",
    );
    await page.unroute("**/api/activity");
    await page.locator("#deskMenu > summary").click();
    await page.click('[data-tab="settings"]');
    const before = beats;
    await page.clock.fastForward(120000);
    assert.equal(beats, before, "other tabs do not keep preview alive");
    await page.click('[data-tab="preview"]');
    f.setTime(481);
    await page.clock.fastForward(61000);
    await page.locator("#login").waitFor({ state: "visible" });
    assert.equal(desk.auth.valid(token), false, "absolute expiry cannot be renewed");

    // Fresh synthetic session: a real logout revokes both owner and preview grant.
    const fresh = desk.auth.issue({ provider: "synthetic" });
    await f.browser.addCookies([
      { name: desk.auth.name, value: fresh, url: origin, httpOnly: true, sameSite: "Strict" },
    ]);
    await page.reload();
    await page.waitForFunction(() => previewView.state === "ready");
    const previewUrl = await page
      .frameLocator("#previewFrame")
      .locator("h1")
      .evaluate(() => location.href);
    await page.click("#deskMenu summary");
    await page.click("#logout");
    await page.locator("#login").waitFor({ state: "visible" });
    assert.equal((await page.request.get(previewUrl)).status(), 401);
    const afterLogout = beats;
    await page.clock.fastForward(120000);
    assert.equal(beats, afterLogout);
  },
);

test(
  "background preview stops keepalive and expired owner cannot be revived",
  { timeout: 15000 },
  async (t) => {
    const { desk, page, token, advance } = await fixture(t, true);
    // Browser lifecycle signal, not a production mock: emulate hidden document.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    let beats = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/activity") beats++;
    });
    advance(31);
    await page.clock.fastForward(120000);
    assert.equal(beats, 0);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.locator("#login").waitFor({ state: "visible", timeout: 3000 });
    assert.equal(desk.auth.valid(token), false);
  },
);

test(
  "activity endpoint requires owner cookie and same-origin POST",
  { timeout: 10000 },
  async (t) => {
    const { desk, origin, token, advance } = await fixture(t);
    // Chromium request context resolves *.localhost, avoiding Node18 Host rewrites.
    const { request } = await import("playwright-core");
    const api = await request.newContext();
    t.after(() => api.dispose());
    const cookie = desk.auth.cookie(token).split(";")[0];
    assert.equal(
      (await api.post(origin + "/api/activity", { headers: { Origin: origin } })).status(),
      401,
    );
    assert.equal(
      (
        await api.post(origin + "/api/activity", {
          headers: { Origin: "https://other.invalid", Cookie: cookie },
        })
      ).status(),
      403,
    );
    advance(20);
    assert.equal(
      (
        await api.post(origin + "/api/activity", { headers: { Origin: origin, Cookie: cookie } })
      ).status(),
      200,
    );
    advance(20);
    assert(desk.auth.valid(token));
    advance(31);
    assert.equal(
      (
        await api.post(origin + "/api/activity", { headers: { Origin: origin, Cookie: cookie } })
      ).status(),
      401,
    );
  },
);
