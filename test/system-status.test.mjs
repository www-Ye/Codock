import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { SystemStatus } from "../lib/system-status.mjs";
import { createDesk } from "../server.mjs";
import { chromium } from "playwright-core";

test("system snapshot is bounded, coalesced and exposes only aggregate metrics", async () => {
  let stat = 100,
    runs = 0,
    now = 1000;
  const deps = {
    clock: () => now,
    read: async (file) =>
      file === "/proc/stat"
        ? `cpu  ${stat++} 0 0 100 0 0 0 0\n`
        : "MemTotal:  8192000 kB\nMemAvailable:  4096000 kB\n",
    run: async (command, args, options) => {
      runs++;
      assert.equal(command, "nvidia-smi");
      assert.equal(options.timeout, 2500);
      assert(args.includes("--format=csv,noheader,nounits"));
      return {
        stdout: "0, 72, 2048, 8192, 54, NVIDIA Test GPU\n1, 0, 0, 8192, 36, NVIDIA Test GPU\n",
      };
    },
  };
  const status = new SystemStatus(deps);
  await status.init();
  const [a, b] = await Promise.all([status.snapshot(), status.snapshot()]);
  assert.deepEqual(a, b);
  assert.equal(runs, 1);
  assert.equal(a.cpuPercent, 100);
  assert.equal(a.memory.percent, 50);
  assert.equal(a.gpus[0].memoryPercent, 25);
  assert.equal(a.gpus[0].utilization, 72);
  assert(!JSON.stringify(a).includes("process"));
  assert(!JSON.stringify(a).includes("hostname"));
  await status.snapshot();
  assert.equal(runs, 1);
  now += 6000;
  await status.snapshot();
  assert.equal(runs, 2);
});

test("system endpoint needs login and GPU failure never blocks CPU/memory", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/system-");
  const desk = await createDesk({
    runtime: dir + "/runtime",
    socket: dir + "/absent.sock",
    allowed: [],
    secure: false,
    systemDependencies: {
      read: async (file) =>
        file === "/proc/stat"
          ? "cpu  100 0 0 100 0 0 0 0\n"
          : "MemTotal:  2048000 kB\nMemAvailable:  1024000 kB\n",
      run: async () => {
        throw Error("GPU unavailable");
      },
    },
  });
  await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
  t.after(() => desk.close());
  const origin = "http://127.0.0.1:" + desk.server.address().port;
  desk.config.origin = origin;
  assert.equal((await fetch(origin + "/api/system")).status, 401);
  const cookie = desk.auth.cookie(desk.auth.issue({ login: "fixture" })).split(";")[0];
  const response = await fetch(origin + "/api/system", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.memory.percent, 50);
  assert.equal(data.gpuAvailable, false);
  assert.deepEqual(data.gpus, []);
});

test(
  "machine overview fits phone and desktop without exposing unauthenticated metrics",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/su-");
    const desk = await createDesk({
      runtime: dir + "/runtime",
      socket: dir + "/absent.sock",
      allowed: [],
      secure: false,
      systemDependencies: {
        read: async (file) =>
          file === "/proc/stat"
            ? "cpu  100 0 0 100 0 0 0 0\n"
            : "MemTotal:  2048000 kB\nMemAvailable:  1024000 kB\n",
        run: async () => ({
          stdout: "0, 75, 1024, 8192, 46, NVIDIA GPU\n1, 20, 2048, 8192, 37, NVIDIA GPU\n",
        }),
      },
    });
    await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const browser = await chromium.launchPersistentContext(dir + "/p", {
      executablePath: process.env.CHROME_BIN || chromium.executablePath(),
      headless: true,
      viewport: { width: 320, height: 640 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: dir },
    });
    t.after(() => browser.close());
    const cookie = desk.auth
      .cookie(desk.auth.issue({ login: "fixture" }))
      .split(";")[0]
      .split("=");
    await browser.addCookies([
      { name: cookie[0], value: cookie[1], url: origin, httpOnly: true, sameSite: "Strict" },
    ]);
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/#system");
    await page.waitForFunction(
      () => document.querySelectorAll("#systemGpus .system-meter").length === 2,
    );
    assert.match(await page.locator("#systemMemory").textContent(), /50%/);
    assert.match(await page.locator("#systemGpus").textContent(), /GPU 0/);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
  },
);
