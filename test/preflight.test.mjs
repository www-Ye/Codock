import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink } from "node:fs/promises";
import { credentials, validateCredentials, Auth } from "../lib/auth.mjs";
import { checkCredentials } from "../lib/preflight.mjs";

test("preflight rejects malformed, exposed and symlinked credentials without leaking content", async () => {
  const runtime = await mkdtemp(process.env.TMPDIR + "/preflight-");
  const config = { runtime, authMode: "local" };
  const record = await credentials("synthetic-test-password-only");
  assert.equal(validateCredentials(record), record);
  for (const change of [{ salt: "bad" }, { password: "bad" }, { totp: "bad" }])
    assert.throws(() => validateCredentials({ ...record, ...change }));
  await writeFile(runtime + "/auth.json", JSON.stringify(record), { mode: 0o600 });
  await checkCredentials(config);
  await chmod(runtime + "/auth.json", 0o644);
  await assert.rejects(checkCredentials(config), /owner-only/);
  await chmod(runtime + "/auth.json", 0o600);
  await writeFile(runtime + "/auth.json", '{"password":"DO_NOT_ECHO_THIS"');
  await assert.rejects(
    checkCredentials(config),
    (e) => !e.message.includes("DO_NOT_ECHO_THIS") && /Invalid credentials/.test(e.message),
  );
  assert.equal(await new Auth(runtime + "/auth.json").ready(), false);
  await assert.rejects(new Auth(runtime + "/auth.json").login("x", "000000", "local"), {
    status: 503,
  });
  await symlink(runtime + "/auth.json", runtime + "/github.json");
  await assert.rejects(checkCredentials({ ...config, authMode: "github" }), /owner-only/);
});
