import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { Previews as UpdatedPreviews } from "../lib/preview.mjs";

test(
  "media preview: touch close, Escape, browser back, playback cleanup and page state",
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/pv-");
    await mkdir(dir + "/site");
    await promisify(execFile)(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=1200x2400:d=0.1",
        "-frames:v",
        "1",
        "-threads",
        "1",
        dir + "/site/picture.png",
      ],
      { timeout: 15000, env: process.env },
    );
    await promisify(execFile)(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=yellow:s=160x120:d=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        dir + "/site/video.mp4",
      ],
      { timeout: 15000, env: process.env },
    );
    await writeFile(
      dir + "/site/index.html",
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Media fixture</title>
    <style>body{margin:12px}a,button,input{display:block;margin:12px;padding:10px}dialog{display:none!important}button{position:static!important}</style>
    <h1>Report</h1><input id="draft"><div style="height:500px"></div>
    <a id="image" href="picture.png">打开图片</a><a id="video" href="video.mp4">打开视频</a>
    <a id="missing" href="missing.png">Missing</a><a id="slow" href="slow.png">Slow</a>
    <a id="download" download href="picture.png">Download</a>
    <a id="custom" href="picture.png" onclick="event.preventDefault();this.textContent='custom handled'">Custom viewer</a>
    <button id="raw" onclick="location.href='picture.png'">Script navigation</button><a id="next" href="next.html">Next page</a>
    <div style="height:1000px"></div>`,
    );
    await writeFile(
      dir + "/site/next.html",
      '<!doctype html><h1>Next</h1><a href="picture.png">打开图片</a>',
    );
    const baseline = process.env.DESK_MEDIA_BASELINE;
    const Previews = baseline
      ? (await import(baseline + "/lib/preview.mjs")).Previews
      : UpdatedPreviews;
    const view = await readFile(
      baseline
        ? baseline + "/public/preview-view.js"
        : new URL("../public/preview-view.js", import.meta.url),
      "utf8",
    );
    const registry = {
      root: dir,
      allowed: ["sandbox"],
      items: {
        sandbox: {
          revision: 1,
          preview: { type: "static", directory: "site", entry: "index.html" },
        },
      },
    };
    const config = { secure: false, previewSuffix: "preview.terminal.localhost" };
    const previews = new Previews(registry, { valid: () => true }, config);
    previews.grants.set("fixture", {
      name: "sandbox",
      owner: "fixture",
      revision: 1,
      expires: Date.now() + 60000,
    });
    let origin, previewOrigin;
    const server = http.createServer((req, res) => {
      if (req.headers.host.startsWith("sandbox.")) {
        void previews.handle(req, res).catch((e) => previews.error(req, res, e));
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{width:100%;height:calc(100dvh - 65px);border:0}.hidden{display:none}button{min-height:44px}</style>
      <section id="previewPanel"><button id="reloadPreview">刷新预览</button><span id="previewInfo"></span><p id="previewStatus"></p><div id="previewEmpty"></div><iframe id="previewFrame" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"></iframe></section>
      <script>${view}</script><script>const item={name:'sandbox',revision:1,preview:{type:'static',entry:'index.html'}};const previewView=new DeskPreview({request:async()=>({url:${JSON.stringify(previewOrigin + "/index.html")}}),notify:()=>{}});document.querySelector('#reloadPreview').onclick=()=>previewView.open(item,{force:true});previewView.open(item);</script>`);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    origin = "http://terminal.localhost:" + port;
    previewOrigin = "http://sandbox.preview.terminal.localhost:" + port;
    config.origin = origin;
    t.after(() => {
      server.closeAllConnections();
      server.close();
      previews.close();
    });
    const browser = await chromium.launchPersistentContext(dir + "/profile", {
      executablePath: process.env.DESK_CHROMIUM,
      headless: true,
      hasTouch: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: process.env.TMPDIR },
    });
    t.after(() => browser.close());
    await browser.addCookies([
      { name: "workbench_preview_dev", value: "fixture", url: previewOrigin },
    ]);
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(8000);
    t.after(async () => {
      console.log("Preview fixture:", dir, "errors:", errors);
    });
    await page.goto(origin);
    await page.waitForFunction(() => previewView.state === "ready");
    const frame = () => page.frameLocator("#previewFrame");
    if (baseline) {
      await frame().locator("#image").tap();
      await page.frames()[1].waitForURL(previewOrigin + "/picture.png");
      assert.equal(page.frames()[1].url(), previewOrigin + "/picture.png");
      assert.equal(
        await frame().locator("button,dialog").count(),
        0,
        "raw image replaces report with no close control",
      );
      console.log(
        "Baseline reproduced: raw image replaced report with no close control. Parent state:",
        await page.evaluate(() => previewView.state),
      );
      return;
    }
    const closed = async () => {
      await frame().locator("workbench-media-viewer dialog").waitFor({ state: "hidden" });
      await page.waitForFunction(() => !history.state?.__workbenchPreviewMedia);
      await page.frames()[1].waitForFunction(() => !history.state?.__workbenchPreviewMedia);
    };
    for (const size of [
      { width: 320, height: 640 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await frame().locator("#draft").fill("keep my draft");
      await frame().locator("#image").scrollIntoViewIfNeeded();
      await page.frames()[1].evaluate(() => {
        // Touch actionability may scroll nested frames after a viewport change.
        // Capture the user's position at the click, before the viewer opens.
        document.querySelector("#image").addEventListener(
          "click",
          () => {
            window.fixtureOpenScroll = scrollY;
          },
          { once: true, capture: true },
        );
      });
      await frame().locator("#image").tap();
      const before = await page.frames()[1].evaluate(() => fixtureOpenScroll);
      const button = frame().getByRole("button", { name: "关闭预览" });
      await button.waitFor();
      const box = await button.boundingBox();
      assert(
        box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= size.width &&
          box.y + box.height <= size.height,
        "close button visible at " + JSON.stringify(size),
      );
      assert(box.height >= 44);
      await frame()
        .locator("workbench-media-viewer img")
        .evaluate((img) => img.decode());
      assert.equal(page.frames()[1].url(), previewOrigin + "/index.html");
      await page.screenshot({ path: dir + "/media-" + size.width + ".png" });
      await button.tap();
      await closed();
      assert.equal(await frame().locator("#draft").inputValue(), "keep my draft");
      assert.equal(
        await page.frames()[1].evaluate(() => scrollY),
        before,
        "closing preserves report scroll",
      );
    }
    await frame().locator("#image").tap();
    await frame().getByRole("button", { name: "关闭预览" }).waitFor();
    await page.evaluate(() => history.back());
    await closed();
    assert.equal(page.url(), origin + "/");
    await frame().locator("#image").tap();
    await frame().getByRole("button", { name: "关闭预览" }).waitFor();
    const frameBox = await page.locator("#previewFrame").boundingBox();
    await page.touchscreen.tap(frameBox.x + 2, frameBox.y + 2);
    await closed();
    await frame().locator("#video").tap();
    await frame().locator("workbench-media-viewer video").waitFor();
    await frame()
      .locator("workbench-media-viewer video")
      .evaluate(async (video) => {
        window.fixtureVideo = video;
        await video.play();
      });
    await page.keyboard.press("Escape");
    await closed();
    assert(
      await page
        .frames()[1]
        .evaluate(
          () =>
            fixtureVideo.paused && !fixtureVideo.isConnected && !fixtureVideo.getAttribute("src"),
        ),
      "close stops playback and releases media",
    );
    await frame().locator("#missing").tap();
    await frame().locator("workbench-media-viewer p").waitFor();
    await frame().getByRole("button", { name: "关闭预览" }).tap();
    await closed();
    let release;
    const gate = new Promise((r) => (release = r));
    await page.route("**/slow.png", async (route) => {
      await gate;
      await route.abort().catch(() => {});
    });
    await frame().locator("#slow").tap();
    await frame().getByRole("button", { name: "关闭预览" }).tap();
    await closed();
    release();
    await page.unroute("**/slow.png");
    await frame().locator("#custom").tap();
    assert.equal(await frame().locator("#custom").textContent(), "custom handled");
    assert(await frame().locator("workbench-media-viewer dialog").isHidden());
    const download = page.waitForEvent("download");
    await frame().locator("#download").tap();
    await (await download).cancel();
    assert(await frame().locator("workbench-media-viewer dialog").isHidden());
    // Script-controlled/raw navigation bypasses link handling but retains escape.
    await frame().locator("#raw").tap();
    await page.waitForFunction(() => previewView.leftEntry && previewView.state === "ready");
    assert.equal(await page.locator("#reloadPreview").textContent(), "返回网页");
    await page.click("#reloadPreview");
    await frame().locator("h1").waitFor();
    await page.waitForFunction(() => previewView.state === "ready");
    await frame().locator("#next").tap();
    await frame().locator("h1").filter({ hasText: "Next" }).waitFor();
    await frame().locator("a").tap();
    await frame().getByRole("button", { name: "关闭预览" }).tap();
    await closed();
    assert.equal(await frame().locator("h1").textContent(), "Next");
    // Standalone preview uses the same viewer, without a parent toolbar.
    await page.goto(previewOrigin + "/index.html");
    await page.locator("#image").tap();
    await page.getByRole("button", { name: "关闭预览" }).tap();
    await page.locator("workbench-media-viewer dialog").waitFor({ state: "hidden" });
    assert.equal(page.url(), previewOrigin + "/index.html");
    assert.deepEqual(errors, []);
    console.log("Media preview browser artifacts:", dir);
  },
);
