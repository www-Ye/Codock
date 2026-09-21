import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDemo } from "../test/fixtures/demo.mjs";

// Actual signed-in chat: idle movement and clicks, not a login-only animation.
async function captureCompanions(browser, demo, output) {
  const frames = demo.directory + "/companion-frames";
  await mkdir(frames);
  const page = await browser.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let frame = 0;
  try {
    await page.goto(demo.origin + "/s/demo#chat");
    for (const character of ["nailong", "duck", "cat", "robot"]) {
      await page.evaluate((value) => {
        localStorage.setItem("codock.character", value);
        localStorage.setItem("codock.theme", "midnight");
        localStorage.setItem("codock.petSize", "large");
      }, character);
      await page.reload();
      await page.waitForSelector(".chat-message");
      await page.locator("#chatScroll").evaluate((node) => {
        node.scrollTop = 0;
      });
      const pet = page.locator(".status-pet");
      await pet.waitFor({ state: "visible" });
      await pet.locator("img").evaluate((img) => img.decode());
      assert.notEqual(
        await pet.locator("img").evaluate((img) => getComputedStyle(img).animationName),
        "none",
      );
      const clip = { x: 0, y: 0, width: 390, height: 360 };
      const started = Date.now();
      for (let i = 0; i < 28; i++) {
        if (i === 8) {
          await pet.click();
          assert(await page.locator(".pet-bubble").isVisible());
          const bubble = await page.locator(".pet-bubble").boundingBox();
          assert(bubble.y >= clip.y && bubble.y + bubble.height <= clip.y + clip.height);
        }
        await page.screenshot({
          path: frames + `/frame-${String(frame++).padStart(3, "0")}.png`,
          clip,
        });
        await page.waitForTimeout(Math.max(0, started + (i + 1) * 125 - Date.now()));
      }
    }
  } finally {
    await page.close();
  }
  const exec = promisify(execFile);
  await exec(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      "8",
      "-i",
      frames + "/frame-%03d.png",
      "-filter_complex",
      "[0:v]split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
      "-loop",
      "0",
      output + "/companions.gif",
    ],
    { timeout: 30000 },
  );
  // Keep the H.264 original recording in ignored artifacts, not another README asset.
  await exec(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      "8",
      "-i",
      frames + "/frame-%03d.png",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      demo.directory + "/companions.mp4",
    ],
    { timeout: 30000 },
  );
}

async function exercisePreview(page, demo, output, publish) {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.click('[data-tab="settings"]');
  await page.click('[data-preset="midnight"]');
  await page.click('[data-tab="chat"]');
  await page.waitForSelector(".chat-message");
  const frames = demo.directory + "/preview-frames";
  await mkdir(frames);
  let n = 0;
  const shot = () => page.screenshot({ path: frames + `/frame-${n++}.png` });
  await shot();
  await page.click('[data-tab="preview"]');
  await page.waitForFunction(() => previewView.state === "ready");
  const frame = page.frameLocator("#previewFrame");
  assert.notEqual(
    new URL(page.frames()[1].url()).origin,
    demo.origin,
    "preview keeps its own origin",
  );
  assert.equal(await frame.locator('[data-plan="a"]').getAttribute("aria-pressed"), "true");
  await shot();
  await frame.locator('[data-plan="b"]').click();
  assert.equal(await frame.locator("#chart strong").first().textContent(), "91%");
  await shot();
  await frame.locator("summary").click();
  assert(await frame.locator("details p").isVisible());
  await shot();
  await page.screenshot({ path: output + "/preview-desktop.png" });
  await page.click('[data-tab="chat"]');
  await page.click('[data-tab="preview"]');
  assert.equal(
    await frame.locator('[data-plan="b"]').getAttribute("aria-pressed"),
    "true",
    "switching tabs preserves the interactive page",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.locator('[data-plan="a"]').tap();
  assert.equal(await frame.locator("#chart strong").first().textContent(), "72%");
  await page.frames()[1].evaluate(() => scrollTo(0, 0));
  assert(await page.frames()[1].evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: output + "/preview-mobile.png" });
  await page.click("#reloadPreview");
  await page.waitForFunction(() => previewView.state === "ready");
  assert.equal(await frame.locator('[data-plan="a"]').getAttribute("aria-pressed"), "true");
  if (publish)
    await promisify(execFile)(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-framerate",
        "1/2",
        "-i",
        frames + "/frame-%d.png",
        "-filter_complex",
        "[0:v]scale=960:-1,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
        "-loop",
        "0",
        output + "/preview.gif",
      ],
      { timeout: 30000 },
    );
  await page.click('[data-tab="chat"]');
}

// This is the real frontend behind an isolated fixture API, not a drawn mockup.
export async function exerciseAppearance({ publish = false } = {}) {
  const demo = await createDemo();
  let browser;
  try {
    browser = await chromium.launchPersistentContext(demo.directory + "/browser", {
      executablePath: process.env.DESK_CHROMIUM,
      headless: true,
      hasTouch: true,
      viewport: { width: 1360, height: 900 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: process.env.TMPDIR },
    });
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cookie = demo.desk.auth
      .cookie(demo.desk.auth.issue({ login: "demo-fixture" }))
      .split(";")[0]
      .split("=");
    await browser.addCookies([
      { name: cookie[0], value: cookie[1], url: demo.origin, httpOnly: true, sameSite: "Strict" },
    ]);
    const output = publish ? path.resolve("docs/assets") : demo.directory + "/screenshots";
    await mkdir(output, { recursive: true });
    await page.goto(demo.origin + "/s/demo#chat");
    await page.waitForSelector(".chat-message");
    let writes = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/chat")) writes++;
    });
    for (const preset of ["graphite", "midnight", "paper"]) {
      await page.click('[data-tab="settings"]');
      await page.click('[data-preset="' + preset + '"]');
      const character = { graphite: "nailong", midnight: "duck", paper: "cat" }[preset];
      await page.click('[data-pet="' + character + '"]');
      assert.equal(
        await page.getAttribute("html", "data-theme"),
        preset,
        "character must not change palette",
      );
      assert.equal(await page.getAttribute("html", "data-theme"), preset);
      await page.click('[data-tab="chat"]');
      await page.waitForSelector(".chat-message");
      await page.locator("#chatLatest").click();
      const colors = await page.evaluate(() =>
        Object.fromEntries(
          ["--bg", "--surface", "--text", "--muted", "--yellow", "--ink"].map((k) => [
            k,
            getComputedStyle(document.documentElement).getPropertyValue(k).trim(),
          ]),
        ),
      );
      const lum = (hex) =>
        hex
          .slice(1)
          .match(/../g)
          .map((v) => parseInt(v, 16) / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const contrast = (a, b) =>
        (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      assert(contrast(colors["--text"], colors["--surface"]) >= 7);
      assert(contrast(colors["--muted"], colors["--surface"]) >= 4.5);
      assert(contrast(colors["--ink"], colors["--yellow"]) >= 4.5);
      for (const size of [
        { width: 1360, height: 900 },
        { width: 390, height: 844 },
        { width: 320, height: 640 },
      ]) {
        await page.setViewportSize(size);
        await page.waitForTimeout(80);
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          "page overflow",
        );
        const area = await page.locator("#chatScroll").boundingBox();
        assert(area.height > size.height * 0.56, "chat remains the focus");
        const send = await page.locator("#chatSend").boundingBox();
        assert(send.y + send.height <= size.height, "composer visible");
        await page.locator(".status-pet img").evaluate((img) => img.decode());
        if (size.width === 390 || (size.width === 1360 && preset === "midnight"))
          await page.screenshot({
            path: output + "/" + preset + (size.width === 390 ? "-mobile" : "-desktop") + ".png",
          });
      }
      await page.reload();
      await page.waitForSelector(".chat-message");
      assert.equal(await page.getAttribute("html", "data-theme"), preset);
      assert.equal(await page.getAttribute("html", "data-character"), character);
      await page.setViewportSize({ width: 1360, height: 900 });
    }
    for (const state of ["running", "waiting", "ready", "unknown"]) {
      demo.setStatus(state);
      await page.evaluate(() => chatView.load());
      assert.equal(await page.getAttribute("html", "data-activity"), state);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    demo.setStatus("running");
    await page.evaluate(() => chatView.load());
    assert.equal(
      await page
        .locator(".status-pet .pet-image")
        .evaluate((n) => getComputedStyle(n).animationName),
      "none",
    );
    await page.click('[data-tab="settings"]');
    await page.uncheck("#mascotToggle");
    await page.reload();
    await page.waitForSelector("#mascotToggle");
    assert.equal(await page.getAttribute("html", "data-mascot"), "off");
    assert(await page.locator(".pet-sizes").isHidden());
    assert(await page.locator(".brand .pet-image").isHidden());
    await page.click('[data-tab="chat"]');
    assert(await page.locator(".status-pet").isHidden());
    await page.click('[data-tab="settings"]');
    await page.check("#mascotToggle");
    assert(await page.locator(".pet-sizes").isVisible());
    await page.setViewportSize({ width: 320, height: 640 });
    for (const [size, width] of [
      ["small", 32],
      ["medium", 40],
      ["large", 56],
    ]) {
      await page.click(`button[data-pet-size="${size}"]`);
      await page.reload();
      await page.waitForSelector("#mascotToggle");
      assert.equal(await page.getAttribute("html", "data-pet-size"), size);
      await page.click('[data-tab="chat"]');
      assert.equal((await page.locator(".status-pet").boundingBox()).width, width);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.click('[data-tab="settings"]');
    }
    await page.click('button[data-pet-size="medium"]');
    await page.click('[data-preset="midnight"]');
    await page.click('[data-pet="robot"]');
    await page.reload();
    await page.waitForSelector("#mascotToggle");
    assert.equal(await page.getAttribute("html", "data-character"), "robot");
    await page
      .locator(".character-presets img")
      .evaluateAll((imgs) => Promise.all(imgs.map((img) => img.decode())));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: output + "/appearance-mobile.png" });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.click('[data-pet="nailong"]');
    await page.click('[data-tab="chat"]');
    await page.waitForSelector(".chat-message");
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.click(".sidebar-foot .pet-play");
    assert.equal(await page.getAttribute("html", "data-pet-play"), "yes");
    assert(await page.locator(".pet-bubble").isVisible());
    await page.keyboard.press("Escape");
    assert(await page.locator(".pet-bubble").isHidden());
    await page.setViewportSize({ width: 320, height: 640 });
    for (const [state, expected] of [
      ["waiting", "确认"],
      ["running", "还在忙"],
      ["ready", "陪你"],
    ]) {
      demo.setStatus(state);
      await page.evaluate(() => chatView.load());
      await page.locator(".status-pet").click();
      assert.match(await page.locator(".pet-bubble").textContent(), new RegExp(expected));
      const box = await page.locator(".pet-bubble").boundingBox();
      assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 320 && box.y + box.height <= 640);
      assert.equal(
        await page.locator(".status-pet img").evaluate((n) => getComputedStyle(n).animationName),
        "none",
      );
    }
    await page.locator(".status-pet").focus();
    await page.keyboard.press("Enter");
    assert(await page.locator(".pet-bubble").isVisible());
    await page.waitForTimeout(3700);
    assert(await page.locator(".pet-bubble").isHidden());
    await page.setViewportSize({ width: 390, height: 844 });
    demo.setStatus("ready");
    await page.evaluate(() => chatView.load());
    await page.locator("#chatScroll").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.locator(".status-pet").click();
    assert(await page.locator(".pet-bubble").isVisible());
    await page.screenshot({ path: output + "/companion-mobile.png" });
    assert.equal(writes, 0, "appearance must not send chat input");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1360, height: 900 });
    for (const [character, expected] of [
      ["nailong", "pet-breathe"],
      ["duck", "pet-sway"],
      ["cat", "pet-breathe"],
      ["robot", "pet-float"],
    ]) {
      await page.click('[data-tab="settings"]');
      await page.click('[data-pet="' + character + '"]');
      await page.waitForFunction(() => !document.documentElement.dataset.petPlay);
      const pet = page.locator(".sidebar-foot .pet-image");
      assert.equal(await pet.evaluate((img) => getComputedStyle(img).animationName), expected);
      const before = await pet.evaluate((img) => getComputedStyle(img).transform);
      await page.waitForTimeout(170);
      assert.notEqual(
        await pet.evaluate((img) => getComputedStyle(img).transform),
        before,
        "idle mascot actually moves",
      );
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await pet.evaluate((img) => getComputedStyle(img).animationName), "none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
    await exercisePreview(page, demo, output, publish);
    if (publish) await captureCompanions(browser, demo, output);
    // Storage denial cannot break boot or theme switching.
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw Error("disabled");
      };
      Storage.prototype.setItem = () => {
        throw Error("disabled");
      };
    });
    await page.reload();
    await page.click('[data-tab="settings"]');
    await page.waitForSelector("#mascotToggle");
    await page.click('[data-preset="paper"]');
    assert.equal(await page.getAttribute("html", "data-theme"), "paper");
    assert.deepEqual(errors, []);
    await browser.clearCookies();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(demo.origin);
    await page.waitForSelector("#login:not(.hidden)");
    await page.locator(".login .pet-image").evaluate((img) => img.decode());
    await page.screenshot({ path: demo.directory + "/login-mobile.png" });
    return output;
  } finally {
    await browser?.close();
    await demo.desk.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log("Synthetic UI screenshots:", await exerciseAppearance({ publish: true }));
