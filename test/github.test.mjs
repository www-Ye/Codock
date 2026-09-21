import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { GithubAuth, callbackPath, validateGithubConfig } from "../lib/github-auth.mjs";
import { createDesk } from "../server.mjs";
import { chromium } from "playwright-core";

const githubOwner = { login: "example-owner", id: 123456789 };
const config = { clientId: "test-client-id", clientSecret: "not-a-real-client-secret" };
const json = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
async function fixture(options = {}) {
  const dir = await mkdtemp(process.env.TMPDIR + "/github-");
  await writeFile(dir + "/github.json", JSON.stringify(config), { mode: 0o600 });
  let now = 1800000000000;
  const calls = [],
    reports = [];
  const fetcher = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("access_token"))
      return json({
        access_token: "test-token",
        token_type: "bearer",
        scope: "",
        ...options.token,
      });
    return json({ id: githubOwner.id, login: githubOwner.login, type: "User", ...options.user });
  };
  const github = new GithubAuth(
    dir + "/github.json",
    { origin: "https://terminal.example.test", secure: true, githubOwner },
    { fetcher, clock: () => now, report: (event) => reports.push(event), delay: async () => {} },
  );
  const start = () => github.start({ headers: {} }, "test-ip");
  const callback = (flow) =>
    new URL(
      callbackPath + "?state=" + new URL(flow.url).searchParams.get("state") + "&code=test-code",
      "https://terminal.example.test",
    );
  const request = (flow) => ({ headers: { cookie: flow.cookie.split(";")[0] } });
  return {
    github,
    dir,
    calls,
    reports,
    start,
    callback,
    request,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("GitHub transient profile recovery is bounded; exchange codes are never replayed; diagnostics contain no secrets", async () => {
  for (const kind of ["network", "http"]) {
    const f = await fixture(),
      base = f.github.fetcher;
    let exchanges = 0,
      profiles = 0;
    f.github.fetcher = async (url, options) => {
      if (url.includes("access_token")) exchanges++;
      else if (++profiles === 1) {
        if (kind === "network") throw Error("secret-token-do-not-log");
        return new Response("", { status: 503 });
      }
      return base(url, options);
    };
    const flow = await f.start();
    assert.equal((await f.github.finish(f.request(flow), f.callback(flow))).id, githubOwner.id);
    assert.equal(exchanges, 1);
    assert.equal(profiles, 2);
    assert.deepEqual(f.reports, []);
  }
  for (const status of [401, 403, 429, 503]) {
    const f = await fixture(),
      base = f.github.fetcher;
    let profiles = 0;
    f.github.fetcher = async (url, options) => {
      if (url.includes("access_token")) return base(url, options);
      profiles++;
      return new Response("secret-provider-response", { status });
    };
    const flow = await f.start();
    await assert.rejects(f.github.finish(f.request(flow), f.callback(flow)), {
      oauthCode: "upstream",
      oauthStage: "profile",
    });
    assert.equal(profiles, status === 503 ? 2 : 1);
    assert.equal(f.reports[0].stage, "profile");
    assert.equal(f.reports[0].status, status);
    assert.doesNotMatch(JSON.stringify(f.reports), /secret|test-token|test-code|client/i);
  }
  const f = await fixture();
  let exchanges = 0;
  f.github.fetcher = async () => {
    exchanges++;
    throw Object.assign(Error("secret-token"), { cause: { code: "EAI_AGAIN" } });
  };
  const flow = await f.start();
  await assert.rejects(f.github.finish(f.request(flow), f.callback(flow)), {
    oauthCode: "upstream",
    oauthStage: "exchange",
  });
  assert.equal(exchanges, 1);
  assert.deepEqual(f.reports, [
    { stage: "exchange", reason: "EAI_AGAIN", status: null, elapsedMs: 0 },
  ]);
  await assert.rejects(f.github.finish(f.request(flow), f.callback(flow)), {
    oauthCode: "expired",
  });
  assert.equal(exchanges, 1);
});

test("GitHub flow: exact owner ID, browser-bound state, PKCE, no repository scope", async () => {
  const f = await fixture(),
    flow = await f.start(),
    url = new URL(flow.url);
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.searchParams.get("scope"), "");
  assert.equal(url.searchParams.get("login"), "example-owner");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://terminal.example.test" + callbackPath,
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(flow.cookie, /HttpOnly; SameSite=Lax.*Secure/);
  await assert.rejects(f.github.finish({ headers: {} }, f.callback(flow)), {
    oauthCode: "expired",
  });
  assert.equal(f.calls.length, 0, "bad browser cannot exchange a code");
  const result = await f.github.finish(f.request(flow), f.callback(flow));
  assert.deepEqual(result, { provider: "github", id: 123456789 });
  const exchange = f.calls[0];
  assert.equal(exchange.opts.redirect, "error");
  assert.equal(
    createHash("sha256").update(exchange.opts.body.get("code_verifier")).digest("base64url"),
    url.searchParams.get("code_challenge"),
  );
  assert.equal(f.calls[1].url, "https://api.github.com/user");
  assert(!JSON.stringify(result).includes("test-token"));
  assert(!JSON.stringify([...f.github.pending]).includes("test-token"));
  await assert.rejects(f.github.finish(f.request(flow), f.callback(flow)), {
    oauthCode: "expired",
  });
  assert.equal((await stat(f.dir + "/github.json")).mode & 0o777, 0o600);
});

test("GitHub rejects lookalike owner, extra permissions, expiry, cancellation, configuration changes and network failures", async (t) => {
  for (const [label, options, expected] of [
    ["same username but wrong ID", { user: { id: 123 } }, "wrong_account"],
    ["organization identity", { user: { type: "Organization" } }, "wrong_account"],
    ["repository scope", { token: { scope: "repo" } }, "unexpected_scope"],
    ["invalid exchange", { token: { error: "bad_verification_code" } }, "exchange_failed"],
  ])
    await t.test(label, async () => {
      const f = await fixture(options),
        flow = await f.start();
      await assert.rejects(f.github.finish(f.request(flow), f.callback(flow)), {
        oauthCode: expected,
      });
    });
  const renamed = await fixture({ user: { login: "renamed-owner" } }),
    a = await renamed.start();
  assert.equal(
    (await renamed.github.finish(renamed.request(a), renamed.callback(a))).id,
    githubOwner.id,
  );
  const expired = await fixture(),
    b = await expired.start();
  expired.advance(300001);
  await assert.rejects(expired.github.finish(expired.request(b), expired.callback(b)), {
    oauthCode: "expired",
  });
  const denied = await fixture(),
    c = await denied.start(),
    cancel = denied.callback(c);
  cancel.searchParams.set("error", "access_denied");
  await assert.rejects(denied.github.finish(denied.request(c), cancel), { oauthCode: "cancelled" });
  const changed = await fixture(),
    d = await changed.start();
  await writeFile(
    changed.dir + "/github.json",
    JSON.stringify({ ...config, clientId: "changed-client" }),
  );
  await assert.rejects(changed.github.finish(changed.request(d), changed.callback(d)), {
    oauthCode: "expired",
  });
  const unavailable = await fixture(),
    e = await unavailable.start();
  unavailable.github.fetcher = async () => {
    throw Error("DO_NOT_LEAK_SECRET");
  };
  await assert.rejects(unavailable.github.finish(unavailable.request(e), unavailable.callback(e)), {
    oauthCode: "upstream",
    message: "upstream",
  });
});

test("GitHub starts are bounded, unconfigured state fails closed", async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) await f.start();
  await assert.rejects(f.start(), { status: 429 });
  assert.throws(() => validateGithubConfig({ clientId: "x", clientSecret: "x" }));
  await writeFile(f.dir + "/github.json", "{}");
  assert.deepEqual(await f.github.status(), { enabled: true, ready: false });
  await assert.rejects(f.github.settings(), { oauthCode: "not_configured" });
});

test(
  "HTTP and mobile browser: GitHub sign-in, only owner, local bypass disabled, clean callback",
  { timeout: 40000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/gh-");
    let allowed = true,
      providerFailure = false;
    const fetcher = async (url, options) =>
      providerFailure
        ? new Response("", { status: 502 })
        : url.includes("access_token")
          ? json({
              access_token: "test-token",
              token_type: "bearer",
              scope: "",
              expires_in: 28800,
              refresh_token: "unused-test-refresh",
            })
          : json({ id: allowed ? githubOwner.id : 123, login: "example-owner", type: "User" });
    const desk = await createDesk({
      runtime: dir + "/runtime",
      socket: dir + "/absent.sock",
      allowed: [],
      secure: false,
      authMode: "github",
      githubOwner,
      githubDependencies: { fetcher },
    });
    await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const request = (path, options = {}) =>
      fetch(origin + path, { redirect: "manual", ...options });
    assert.equal(
      (await request("/api/auth/github/start", { method: "POST", headers: { Origin: origin } }))
        .status,
      503,
    );
    await writeFile(dir + "/runtime/github.json", JSON.stringify(config), { mode: 0o600 });
    const bootstrap = await (await request("/api/bootstrap")).json();
    assert.deepEqual(bootstrap.methods, { github: true, local: false });
    assert(!JSON.stringify(bootstrap).includes(config.clientId));
    assert.equal(
      (
        await request("/api/auth/github/start", {
          method: "POST",
          headers: { Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/api/login", { method: "POST", headers: { Origin: origin } })).status,
      403,
    );
    const browser = await chromium.launchPersistentContext(dir + "/profile", {
      executablePath: process.env.DESK_CHROMIUM,
      headless: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: process.env.TMPDIR },
    });
    t.after(() => browser.close());
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Only the provider redirect is simulated. Real HTTP callback, cookies and UI execute unchanged.
    await page.route("https://github.com/login/oauth/authorize?**", (route) => {
      const state = new URL(route.request().url()).searchParams.get("state");
      return route.fulfill({
        status: 302,
        headers: {
          Location: origin + callbackPath + "?state=" + state + "&code=simulated-provider-code",
        },
        body: "",
      });
    });
    let terminalDownloads = 0;
    await page.route("**/vendor/xterm.js", (route) => {
      terminalDownloads++;
      return route.abort();
    });
    // Login remains usable even if the 489 KB terminal library cannot be reached.
    await page.goto(origin);
    await page.waitForFunction(() => !document.querySelector("#githubLogin").disabled);
    assert.equal(terminalDownloads, 0);
    assert(await page.locator("#loginForm").isHidden());
    await page.click("#githubLogin");
    await page.locator("#app").waitFor();
    assert.equal(page.url(), origin + "/");
    assert.deepEqual(errors, []);
    const owner = [...desk.auth.sessions.values()][0];
    assert.deepEqual(owner.identity, { provider: "github", id: githubOwner.id });
    await page.screenshot({ path: dir + "/github-owner-mobile.png", fullPage: true });
    await page.click("#deskMenu summary");
    await page.click("#logout");
    allowed = false;
    await page.click("#githubLogin");
    await page.waitForFunction(() =>
      document.querySelector("#loginMessage").textContent.includes("没有访问权限"),
    );
    assert.equal((await page.request.get(origin + "/api/sessions")).status(), 401);
    assert.equal(desk.auth.sessions.size, 0);
    assert.equal(page.url(), origin + "/");
    await page.screenshot({ path: dir + "/github-rejected-mobile.png", fullPage: true });
    providerFailure = true;
    await page.click("#githubLogin");
    await page.waitForFunction(() =>
      document.querySelector("#loginMessage").textContent.includes("交换登录确认"),
    );
    assert.equal((await page.request.get(origin + "/api/sessions")).status(), 401);
    assert.equal(terminalDownloads, 0);
    // An unavailable bootstrap stops after two attempts and offers a working retry.
    let bootstrapAttempts = 0;
    await page.route("**/api/bootstrap", (route) => {
      bootstrapAttempts++;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"测试连接暂时不可用"}',
      });
    });
    await page.reload();
    await page.locator("#retryConnection").waitFor({ state: "visible" });
    assert.equal(bootstrapAttempts, 2);
    await page.unroute("**/api/bootstrap");
    await page.click("#retryConnection");
    await page.waitForFunction(() => !document.querySelector("#githubLogin").disabled);
    assert(await page.locator("#retryConnection").isHidden());
    assert.deepEqual(errors, []);
    console.log("GitHub browser fixtures:", dir);
  },
);
