import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { Auth, base32, totp, credentials } from "../lib/auth.mjs";
import { SessionUsage } from "../lib/session-usage.mjs";
import { createDesk } from "../server.mjs";

test("TOTP RFC vector, password strength, login, replay and idle expiry", async () => {
  assert.equal(totp(base32(Buffer.from("12345678901234567890")), 59000), "287082");
  await assert.rejects(credentials("short"));
  const dir = await mkdtemp(process.env.TMPDIR + "/auth-");
  const c = await credentials("test-only-long-password");
  await writeFile(dir + "/auth.json", JSON.stringify(c), { mode: 0o600 });
  let now = 1800000000000;
  const auth = new Auth(dir + "/auth.json", { clock: () => now });
  await assert.rejects(auth.login("wrong", totp(c.totp, now), "test"), { status: 401 });
  const token = await auth.login("test-only-long-password", totp(c.totp, now), "test");
  assert(auth.valid(token));
  assert.match(auth.cookie(token), /HttpOnly; SameSite=Strict.*Secure/);
  await assert.rejects(auth.login("test-only-long-password", totp(c.totp, now), "test"), {
    status: 401,
  });
  now += 31 * 60000;
  assert.equal(auth.valid(token), false);
});

test("recent sessions persist across devices/restarts; passive reads never alter usage", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/usage-");
  const usage = new SessionUsage(dir + "/usage.json", { clock: () => 1000 });
  await usage.init();
  const input = [{ name: "a" }, { name: "b" }, { name: "c" }];
  assert.deepEqual(
    usage.list(input).map((s) => s.name),
    ["a", "b", "c"],
  );
  await Promise.all([usage.visit("a"), usage.visit("b")]);
  assert.deepEqual(
    usage.list(input).map((s) => s.name),
    ["b", "a", "c"],
  );
  const reopened = new SessionUsage(dir + "/usage.json");
  await reopened.init();
  assert.deepEqual(reopened.list(input), usage.list(input));
  assert.equal(usage.list(input).find((s) => s.name === "a").lastOpenedAt, 1000);

  const desk = await createDesk({
    runtime: dir + "/desk",
    socket: dir + "/absent.sock",
    allowed: ["a", "b"],
    secure: false,
  });
  desk.registry.live = async () => [];
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  t.after(() => desk.close());
  const origin = "http://127.0.0.1:" + desk.server.address().port;
  desk.config.origin = origin;
  const cookie = desk.auth.cookie(desk.auth.issue({ login: "fixture" })).split(";")[0];
  const headers = { Origin: origin, Cookie: cookie, "Content-Type": "application/json" };
  assert.equal(
    (
      await fetch(origin + "/api/sessions/a/visit", {
        method: "POST",
        headers: { Origin: origin },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(origin + "/api/sessions/a/visit", {
        method: "POST",
        headers: { ...headers, Origin: "https://bad.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(origin + "/api/sessions/unknown/visit", { method: "POST", headers, body: "{}" }))
      .status,
    404,
  );
  const first = await (
    await fetch(origin + "/api/sessions/b/visit", { method: "POST", headers, body: "{}" })
  ).json();
  assert(first.lastOpenedAt > 0);
  for (let i = 0; i < 3; i++) {
    const data = await (
      await fetch(origin + "/api/sessions", { headers: { Cookie: cookie } })
    ).json();
    assert.equal(data.sessions[0].name, "b");
    assert.equal(data.sessions[0].lastOpenedAt, first.lastOpenedAt);
  }
});
