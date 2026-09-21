import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { createDesk } from "../server.mjs";
import { credentials, totp } from "../lib/auth.mjs";
const exec = promisify(execFile);
test(
  "mobile and desktop browser: login, cards, input, preview, reconnect",
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/browser-"),
      socket = dir + "/tmux.sock";
    const tmux = (args) =>
      exec("tmux", ["-S", socket, ...args], {
        env: { ...process.env, TMUX: "", HISTFILE: dir + "/history" },
        timeout: 5000,
      });
    await tmux([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "sandbox",
      "-x",
      "100",
      "-y",
      "28",
      "bash --noprofile --norc",
    ]);
    t.after(() => tmux(["kill-server"]).catch(() => {}));
    await tmux([
      "new-session",
      "-d",
      "-s",
      "other",
      "-x",
      "100",
      "-y",
      "28",
      "bash --noprofile --norc",
    ]);
    await tmux(["send-keys", "-t", "sandbox", "printf 'HISTORY_%s\\n' {1..1200}", "Enter"]);
    await new Promise((r) => setTimeout(r, 200));
    await mkdir(dir + "/project/site", { recursive: true });
    await writeFile(
      dir + "/project/site/index.html",
      await readFile(new URL("../examples/workbench-page/index.html", import.meta.url)),
    );
    const desk = await createDesk({
      runtime: dir + "/runtime",
      socket,
      projectRoot: dir + "/project",
      allowed: ["sandbox", "other"],
      secure: false,
      previewSuffix: "preview.terminal.localhost",
    });
    await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
    t.after(() => desk.close());
    const port = desk.server.address().port,
      origin = "http://terminal.localhost:" + port;
    desk.config.origin = origin;
    desk.config.previewPort = String(port);
    const auth = await credentials("browser-test-password-only");
    await writeFile(dir + "/runtime/auth.json", JSON.stringify(auth), { mode: 0o600 });
    const browser = await chromium.launchPersistentContext(dir + "/profile", {
      executablePath: process.env.DESK_CHROMIUM,
      headless: true,
      hasTouch: true,
      viewport: { width: 390, height: 844 },
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      env: { ...process.env, TMPDIR: process.env.TMPDIR },
    });
    t.after(() => browser.close());
    const page = browser.pages()[0],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    const sent = [];
    page.on("websocket", (ws) =>
      ws.on("framesent", (frame) => {
        try {
          sent.push(JSON.parse(String(frame.payload)));
        } catch {}
      }),
    );
    t.after(async () => {
      if (!page.isClosed()) await page.screenshot({ path: dir + "/last.png", fullPage: true });
    });
    page.on("console", (m) => {
      if (m.type() === "error")
        console.log("Browser console:", m.text().replace(/ticket=[^\s]+/g, "ticket=REDACTED"));
    });
    await page.goto(origin);
    await page.fill("#password", "browser-test-password-only");
    await page.fill("#code", totp(auth.totp));
    await page.click("#loginButton");
    await page.waitForSelector(".session-card");
    assert.equal(await page.locator(".session-card").count(), 2);
    await page.click('.session-card[href="/s/sandbox"]');
    // Chat controls reuse the actual terminal without changing tabs or submitting.
    await page.click("#chatTerminal");
    await page.waitForFunction(() => !document.querySelector("#writeMode").disabled);
    assert(await page.locator("#chatControls").isVisible());
    assert.equal(new URL(page.url()).hash, "#chat");
    assert.equal(sent.filter((m) => m.type === "input").length, 0);
    await tmux([
      "send-keys",
      "-t",
      "sandbox",
      "printf 'QUESTION: choose with Shift+Left\\n'",
      "Enter",
    ]);
    await page.waitForFunction(() =>
      Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(),
      )
        .join("\n")
        .includes("QUESTION: choose with Shift+Left"),
    );
    await page.tap('[data-key="shift-left"]');
    await page.waitForTimeout(100);
    assert.equal(sent.filter((m) => m.type === "input" && m.data === "\x1b[1;2D").length, 1);
    const beforeStop = sent.filter((m) => m.type === "input").length;
    page.removeAllListeners("dialog");
    page.once("dialog", (d) => d.dismiss());
    await page.tap("#chatStopTurn");
    await page.waitForTimeout(50);
    assert.equal(
      sent.filter((m) => m.type === "input").length,
      beforeStop,
      "cancel never interrupts",
    );
    page.on("dialog", (d) => d.accept());
    await page.tap("#chatStopTurn");
    await page.waitForTimeout(100);
    assert.equal(
      sent.filter((m) => m.type === "input" && m.data === "\x1b").length,
      1,
      "confirmed stop sends exactly one Esc",
    );
    for (const size of [
      { width: 390, height: 844 },
      { width: 320, height: 640 },
      { width: 390, height: 420 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(60);
      for (const selector of [
        "#chatControlsClose",
        "#chatStopTurn",
        '[data-key="shift-left"]',
        '[data-key="enter"]',
      ]) {
        const box = await page.locator(selector).boundingBox();
        assert(
          box &&
            box.x >= 0 &&
            box.x + box.width <= size.width &&
            box.y >= 0 &&
            box.y + box.height <= size.height,
          selector + " clipped in chat controls",
        );
      }
      const surface = await page.locator(".terminal-view").boundingBox();
      assert(surface.height > 80, "live question remains visible");
      await page.screenshot({ path: dir + "/controls-" + size.width + "x" + size.height + ".png" });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const beforeClose = sent.filter((m) => m.type === "input").length;
    await page.click("#chatControlsClose");
    assert(await page.locator("#chatControls").isHidden());
    assert.equal(
      sent.filter((m) => m.type === "input").length,
      beforeClose,
      "closing never submits or interrupts",
    );
    await page.click("#chatInterrupt");
    await page.waitForFunction(() => !document.querySelector("#chatStopTurn").disabled);
    assert.match(await page.locator("#chatControlHint").textContent(), /中断/);
    assert.equal(
      sent.filter((m) => m.type === "input").length,
      beforeClose,
      "interrupt entry only opens live confirmation",
    );
    await page.click("#chatControlsClose");
    // Exercise navigation while the sheet is open: no orphan socket or panel.
    await page.click("#chatTerminal");
    await page.waitForFunction(() => !document.querySelector("#writeMode").disabled);
    await page.evaluate(() => tab("terminal"));
    assert(await page.locator("#chatControls").isHidden());
    assert(await page.locator("#terminalPanel").isVisible());
    await page.waitForFunction(() => !document.querySelector("#writeMode").disabled);
    // Bash has no Codex Esc/Shift-Left bindings. Reset only this fixture's line
    // before the independent terminal editing tests.
    await tmux(["send-keys", "-t", "sandbox", "C-c"]);
    await page.waitForTimeout(100);
    sent.length = 0;
    assert.equal(
      sent.filter((m) => m.type === "input").length,
      0,
      "opening keyboard controls never sends a key or approval",
    );
    assert.equal(await page.locator("#writeMode").textContent(), "允许输入");
    // Pull down at the top of the original terminal: history appears inline.
    await page.locator("#terminalScroll").evaluate((e) => (e.scrollTop = 0));
    const surface = await page.locator("#terminalScroll").boundingBox();
    const gesture = await page.context().newCDPSession(page);
    const touch = { x: surface.x + 100, y: surface.y + 60 };
    await gesture.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
    await gesture.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...touch, y: touch.y + 85 }],
    });
    await gesture.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await gesture.detach();
    await page.waitForFunction(() =>
      document.querySelector("#historyText").textContent.includes("HISTORY_1200"),
    );
    assert(await page.locator(".keyboard").isHidden(), "history uses keypad space for reading");
    // Native touch scrolling must move content in both directions, not just open history.
    const swipe = async (dy) => {
      const rect = await page.locator("#historyText").boundingBox(),
        cdp = await page.context().newCDPSession(page);
      const point = { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.5 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ ...point, y: point.y + (dy * i) / 8 }],
        });
        await page.waitForTimeout(25);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
      await page.waitForTimeout(250);
    };
    await page.locator("#historyText").evaluate((e) => (e.scrollTop = e.scrollHeight / 2));
    await page.waitForTimeout(50);
    const position = await page.locator("#historyText").evaluate((e) => e.scrollTop);
    await swipe(150);
    const olderPosition = await page.locator("#historyText").evaluate((e) => e.scrollTop);
    assert(olderPosition < position - 60, "finger-down scroll reveals older lines");
    await swipe(-150);
    assert(
      (await page.locator("#historyText").evaluate((e) => e.scrollTop)) > olderPosition + 60,
      "finger-up scroll reveals newer lines",
    );
    await page.evaluate(() => {
      window.savedHistoryChunk = document.querySelector("#historyText").lastChild;
    });
    // Hold a response until a finger is down. The reader must defer prepending
    // until release and preserve the exact location of the existing text.
    let releasePage, requestSeen;
    const waiting = new Promise((r) => (requestSeen = r)),
      readHistory = desk.terminals.history.read.bind(desk.terminals.history);
    let delayOnce = true;
    desk.terminals.history.read = async (c, m) => {
      const result = await readHistory(c, m);
      if (m.before !== undefined && delayOnce) {
        delayOnce = false;
        requestSeen();
        await new Promise((r) => (releasePage = r));
      }
      return result;
    };
    await page.locator("#historyText").evaluate((e) => (e.scrollTop = 120));
    await waiting;
    const hold = await page.context().newCDPSession(page),
      reader = await page.locator("#historyText").boundingBox();
    await hold.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: reader.x + 100, y: reader.y + 100 }],
    });
    const anchor = await page.evaluate(
      () =>
        window.savedHistoryChunk.getBoundingClientRect().top -
        document.querySelector("#historyText").getBoundingClientRect().top,
    );
    releasePage();
    await page.waitForTimeout(120);
    assert.equal(
      await page.locator(".history-chunk").count(),
      1,
      "response does not move text under an active finger",
    );
    await hold.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await hold.detach();
    await page.waitForFunction(() =>
      document.querySelector("#historyText").textContent.includes("HISTORY_400\n"),
    );
    const anchored = await page.evaluate(
      () =>
        window.savedHistoryChunk.getBoundingClientRect().top -
        document.querySelector("#historyText").getBoundingClientRect().top,
    );
    assert(Math.abs(anchored - anchor) < 2, "prepended history preserves reading position");
    assert(
      await page.evaluate(() =>
        document.querySelector("#historyText").contains(window.savedHistoryChunk),
      ),
      "loading older pages preserves existing DOM",
    );
    await page.locator("#historyText").hover();
    await page.mouse.wheel(0, -20000);
    await page.waitForFunction(() =>
      document.querySelector("#historyText").textContent.includes("HISTORY_1\n"),
    );
    assert.equal(await page.locator("#writeMode").textContent(), "允许输入");
    await tmux(["send-keys", "-t", "sandbox", "printf 'LIVE_UPDATE\\n'", "Enter"]);
    await page.waitForTimeout(150);
    assert(
      await page.locator("#historyDialog").isVisible(),
      "new output must not eject history reader",
    );
    await page.screenshot({ path: dir + "/history-mobile.png" });
    // Flinging to a boundary must never close the reader or discard loaded history.
    await page.locator("#historyText").evaluate((e) => (e.scrollTop = e.scrollHeight));
    await page.mouse.wheel(0, 250);
    await swipe(-120);
    assert(
      await page.locator("#historyDialog").isVisible(),
      "bottom overscroll remains in history",
    );
    assert(
      await page.locator("#historyText").evaluate((e) => e.scrollWidth <= e.clientWidth),
      "history defaults to a single vertical scrolling axis",
    );
    await page.tap("#historyWrap");
    assert(
      await page.locator("#historyText").evaluate((e) => e.classList.contains("original-width")),
    );
    await page.tap("#historyWrap");
    await page.tap("#historyClose");
    assert(await page.locator("#historyDialog").isHidden());
    assert(await page.locator(".keyboard").isVisible());
    assert.equal(await page.locator("#input,#send,#insert").count(), 0);
    assert.equal(await page.evaluate(() => controlSequence("shift-left")), "\x1b[1;2D");
    await page.tap("#focusTerminal");
    await page.waitForFunction(() =>
      document.querySelector("#writeMode").classList.contains("active"),
    );
    assert(
      await page.locator('[data-key="shift-left"]').isVisible(),
      "Shift+Left is always visible without opening More",
    );
    await page.tap('[data-key="shift-left"]');
    await page.waitForTimeout(100);
    assert(
      sent.some((m) => m.type === "input" && m.data === "\x1b[1;2D"),
      "mobile Shift+Left reaches original terminal protocol",
    );
    await page.tap("#focusTerminal");
    // The isolated bash fixture has no Shift+Left binding; clear its input before
    // exercising unrelated typing. The exact CSI sequence was asserted above.
    await page.keyboard.press("Control+u");
    assert(
      await page.locator(".xterm-helper-textarea").evaluate((e) => document.activeElement === e),
      "keyboard button focuses native terminal",
    );
    await page.tap("#fontLarger");
    await page.tap("#fontSmaller");
    await page.tap("#latest");
    assert(
      await page.locator(".xterm-helper-textarea").evaluate((e) => document.activeElement === e),
      "display tools preserve native terminal focus",
    );
    await page.keyboard.type("printf 'BROWSER_%s\\n' VERIFIED");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    assert.match(
      (await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout,
      /^BROWSER_VERIFIED$/m,
    );
    // Direct typing does not submit until Enter. Touch keys keep terminal focus.
    await page.keyboard.type("printf 'KEY_%s\\n' OXD");
    assert.doesNotMatch((await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout, /^KEY_OXD$/m);
    await page.tap('[data-key="left"]');
    await page.tap('[data-key="backspace"]');
    assert(
      await page.locator(".xterm-helper-textarea").evaluate((e) => document.activeElement === e),
      "touch keys keep terminal focus",
    );
    await page.keyboard.type("L");
    await page.tap('[data-key="enter"]');
    await page.waitForTimeout(200);
    assert.match((await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout, /^KEY_OLD$/m);
    await page.tap('[data-key="up"]');
    await page.tap('[data-key="enter"]');
    await page.waitForTimeout(150);
    assert.equal(
      (await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout.match(/^KEY_OLD$/gm)?.length,
      2,
    );
    // Native text input (the IME commit path) delivers Chinese without an extra composer.
    await page.keyboard.type("printf 'TEXT_%s\\n' ");
    await page.keyboard.insertText("手机中文");
    await page.tap('[data-key="enter"]');
    await page.waitForTimeout(150);
    assert.match((await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout, /^TEXT_手机中文$/m);
    // Real Chromium composition events, not only insertText: a shortcut cannot
    // submit the shell while the IME still owns uncommitted candidate text.
    await page.keyboard.type("printf 'IME_%s\\n' ");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "中文候选",
      selectionStart: 4,
      selectionEnd: 4,
    });
    await page.tap('[data-key="enter"]');
    assert.match(await page.locator("#toast").textContent(), /候选文字/);
    assert.doesNotMatch(
      (await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout,
      /^IME_中文候选$/m,
    );
    await cdp.send("Input.insertText", { text: "中文候选" });
    await page.waitForTimeout(80);
    await page.tap('[data-key="enter"]');
    await page.waitForTimeout(150);
    assert.equal(
      (await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout.match(/^IME_中文候选$/gm)
        ?.length,
      1,
    );
    await cdp.detach();
    // Reproduce the idle read-only transition, then resume with a tap on the terminal.
    const writer = [...desk.terminals.clients].find((c) => c.write);
    assert(writer);
    await desk.terminals.readOnly(writer, "idle");
    await page.waitForFunction(
      () => document.querySelector("#writeMode").textContent === "允许输入",
    );
    assert.match(await page.locator("#toast").textContent(), /两分钟/);
    await page.locator("#terminal").tap({ position: { x: 15, y: 20 } });
    await page.waitForFunction(() =>
      document.querySelector("#writeMode").classList.contains("active"),
    );
    await page.tap("#focusTerminal");
    // Unsubmitted text belongs to tmux, not browser drafts; reconnect never replays it.
    await page.keyboard.type("printf 'HELD_%s\\n' ONCE");
    await page.click("#sessionToggle");
    await page.click('#sessionList a[href="/s/other#chat"]');
    await page.click('[data-tab="terminal"]');
    await page.waitForFunction(() => !document.querySelector("#focusTerminal").disabled);
    assert.equal(await page.locator("#writeMode").textContent(), "允许输入");
    assert.doesNotMatch((await tmux(["capture-pane", "-p", "-t", "other"])).stdout, /HELD_/);
    await page.click("#sessionToggle");
    await page.click('#sessionList a[href="/s/sandbox#chat"]');
    await page.click('[data-tab="terminal"]');
    await page.waitForFunction(() => !document.querySelector("#focusTerminal").disabled);
    await page.click("#reconnect");
    await page.waitForFunction(() => !document.querySelector("#focusTerminal").disabled);
    assert.equal(await page.locator("#writeMode").textContent(), "允许输入");
    assert.doesNotMatch(
      (await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout,
      /^HELD_ONCE$/m,
    );
    await page.tap('[data-key="enter"]');
    await page.waitForTimeout(200);
    assert.equal(
      (await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout.match(/^HELD_ONCE$/gm)?.length,
      1,
    );
    // Explicit read-only prevents typing and drops focus until permission is granted again.
    await page.click("#writeMode");
    await page.waitForTimeout(100);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("SHOULD_NOT_ARRIVE");
    assert.doesNotMatch(
      (await tmux(["capture-pane", "-p", "-t", "sandbox"])).stdout,
      /SHOULD_NOT_ARRIVE/,
    );
    // Full phone, narrow phone and keyboard-reduced viewport keep controls on-screen.
    for (const size of [
      { width: 390, height: 844 },
      { width: 320, height: 640 },
      { width: 390, height: 420 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(100);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      for (const selector of [
        "#focusTerminal",
        '[data-key="left"]',
        '[data-key="enter"]',
        '[data-key="shift-left"]',
      ]) {
        const box = await page.locator(selector).boundingBox();
        assert(
          box && box.y >= 0 && box.y + box.height <= size.height,
          `${selector} clipped at ${size.width}x${size.height}`,
        );
      }
      const view = await page.locator(".terminal-view").boundingBox();
      assert(view.height > 80, "terminal remains visible");
      await page.screenshot({ path: dir + `/terminal-${size.width}x${size.height}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: dir + "/terminal-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('[data-tab="settings"]');
    await page.selectOption("#previewType", "static");
    await page.fill("#directory", "site");
    await page.click("#settingsForm button");
    await page.waitForFunction(() =>
      document.querySelector("#settingsMessage").textContent.includes("已保存"),
    );
    await page.click('[data-tab="preview"]');
    const demo = page.frameLocator("#previewFrame");
    await demo.locator("h1").waitFor();
    assert.equal(await demo.locator("h1").textContent(), "不止看回复，把成果直接打开。");
    await demo.locator('[data-plan="b"]').click();
    assert.equal(await demo.locator("#chart strong").first().textContent(), "91%");
    await demo.locator("summary").click();
    assert(await demo.locator("details p").isVisible());
    await page.waitForTimeout(350);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: dir + "/mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: dir + "/desktop.png", fullPage: true });
    // All four tabs share one shell; switching must not resize or move navigation.
    for (const size of [
      { width: 390, height: 844 },
      { width: 320, height: 640 },
      { width: 390, height: 420 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(size);
      let baseline;
      for (const name of ["chat", "preview", "terminal", "settings"]) {
        await page.click(`[data-tab="${name}"]`);
        await page.locator("#" + name + "Panel").waitFor({ state: "visible" });
        if (name === "terminal")
          await page.waitForFunction(() => !document.querySelector("#writeMode").disabled);
        const layout = await page.evaluate((name) => {
          const rect = (e) => {
            const r = e.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
          };
          return {
            tabs: [...document.querySelectorAll("[data-tab]")].map(rect),
            panelTop: rect(document.querySelector("#" + name + "Panel"))[1],
          };
        }, name);
        if (!baseline) baseline = layout;
        else
          assert.deepEqual(
            layout,
            baseline,
            "shared shell geometry for " + name + " at " + size.width + "x" + size.height,
          );
        assert(layout.panelTop <= 56, "single compact header leaves content near the top");
        for (const selector of [
          "#sessionToggle",
          "#deskMenu summary",
          '[data-tab="chat"]',
          '[data-tab="preview"]',
          '[data-tab="terminal"]',
          '[data-tab="settings"]',
        ]) {
          const box = await page.locator(selector).boundingBox();
          assert(
            box &&
              box.x >= 0 &&
              box.y >= 0 &&
              box.x + box.width <= size.width &&
              box.y + box.height <= 56,
            "top control remains reachable: " + selector,
          );
          if (size.width <= 850)
            assert(
              box.height >= 40 && box.width >= 40,
              "phone touch target is not squeezed: " + selector,
            );
        }
        await page.click("#deskMenu summary");
        assert(await page.locator("#logout").isVisible());
        await page.keyboard.press("Escape");
        assert(await page.locator("#logout").isHidden());
        await page.click("#deskMenu summary");
        await page.click('[data-tab="' + name + '"]');
        assert(await page.locator("#logout").isHidden(), "clicking outside closes utility menu");
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const panel = await page.locator("#" + name + "Panel").boundingBox();
        assert(panel.y + panel.height <= size.height + 1);
        if (name === "preview") {
          const frame = await page.locator("#previewFrame").boundingBox();
          assert(frame.height > 150, "preview uses remaining viewport");
        }
        await page.screenshot({ path: dir + `/shell-${name}-${size.width}x${size.height}.png` });
      }
    }
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => {
      current.label = "这是一个很长很长的会话名称 long session name";
      renderWorkspace();
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(
      await page.locator("#title").getAttribute("title"),
      "这是一个很长很长的会话名称 long session name",
    );
    await page.click("#sessionToggle");
    assert(await page.locator("#sessionSidebar").isVisible());
    await page.click("#sessionClose");
    await page.click('[data-tab="preview"]');
    await page.reload();
    await page.click('[data-tab="terminal"]');
    try {
      await page.waitForFunction(() => !document.querySelector("#writeMode").disabled);
    } catch (error) {
      console.log(
        "Fixture reconnect state:",
        await page.evaluate(() => ({
          hash: location.hash,
          tab: document.querySelector("[data-tab].selected")?.dataset.tab,
          connection: document.querySelector("#connection").textContent,
          loading: terminalLoading,
          ready: connectionReady,
          socket: socket?.readyState,
          session: current?.state,
        })),
      );
      throw error;
    }
    assert.equal(await page.locator("#writeMode").textContent(), "允许输入");
    assert.deepEqual(errors, []);
    await page.goto(origin + "/s/sandbox#preview");
    await page.frameLocator("#previewFrame").locator('[data-plan="b"]').waitFor();
    assert(
      await page.locator("#previewPanel").isVisible(),
      "preview deep link opens preview directly",
    );
    await page.waitForFunction(() => previewView.state === "ready");
    assert(
      await page.locator("#previewStatus").isHidden(),
      "DOM-ready handshake clears loading indicator",
    );
    assert(
      await page.locator("#terminalPanel").isHidden(),
      "desktop preview does not secretly stream a terminal",
    );
    await page.waitForFunction(() => socket === null && terminal === null);
    let renewals = 0;
    const renewalListener = (req) => {
      if (new URL(req.url()).pathname === "/api/sessions/sandbox/preview") renewals++;
    };
    page.on("request", renewalListener);
    await page.click("#reloadPreview");
    await page.waitForFunction(() => previewView.state === "ready");
    assert.equal(
      renewals,
      0,
      "successful refresh goes straight to HTML, without ticket API and redirect",
    );
    desk.previews.grants.clear();
    await page.click("#reloadPreview");
    await page.waitForFunction(() => previewView.state === "ready");
    assert.equal(
      renewals,
      1,
      "expired preview cookie renews once through the normal authenticated flow",
    );
    page.off("request", renewalListener);
    // A hanging media resource must not leave the whole HTML in a loading state.
    let releaseMedia;
    const mediaGate = new Promise((resolve) => (releaseMedia = resolve));
    await page.route("**/slow-image.png", async (route) => {
      await mediaGate;
      await route.abort().catch(() => {});
    });
    await writeFile(
      dir + "/project/site/index.html",
      '<!doctype html><title>Slow media</title><h1>Content is ready</h1><img src="slow-image.png">',
    );
    await page.click("#reloadPreview");
    await page.waitForFunction(() => previewView.state === "ready");
    assert.equal(
      await page.frameLocator("#previewFrame").locator("h1").textContent(),
      "Content is ready",
    );
    releaseMedia();
    await page.unroute("**/slow-image.png");
    await writeFile(
      dir + "/project/site/index.html",
      await readFile(new URL("../examples/workbench-page/index.html", import.meta.url)),
    );
    // Abort the first grant; exactly one retry recovers. Repeated tab taps dedupe.
    let attempts = 0;
    const grantRoute = "**/api/sessions/sandbox/preview";
    await page.route(grantRoute, async (route) => {
      attempts++;
      if (attempts === 1) await route.abort();
      else await route.continue();
    });
    await page.evaluate(() => {
      previewView.reset();
      previewView.retryDelay = 20;
      void previewView.open(current, { force: true });
      void preview();
      void preview();
    });
    await page.waitForFunction(() => previewView.state === "ready");
    assert.equal(attempts, 2);
    await page.unroute(grantRoute);
    // A deterministic document error is visible and does not trigger a reload loop.
    desk.registry.items.sandbox.preview.entry = "missing.html";
    await page.evaluate(() => previewView.reset());
    await page.click("#reloadPreview");
    await page.waitForFunction(() => previewView.state === "error");
    assert.match(await page.locator("#previewStatus").textContent(), /找不到这个网页/);
    desk.registry.items.sandbox.preview.entry = "index.html";
    // Grant timeout is bounded: two attempts, then a readable error; manual retry works.
    attempts = 0;
    let releaseGrant;
    const grantGate = new Promise((resolve) => (releaseGrant = resolve));
    await page.route(grantRoute, async (route) => {
      attempts++;
      await grantGate;
      await route.abort().catch(() => {});
    });
    await page.evaluate(() => {
      previewView.reset();
      previewView.timeout = 200;
      void previewView.open(current, { force: true });
    });
    await page.waitForFunction(() => previewView.state === "error");
    assert.equal(attempts, 2);
    assert.match(await page.locator("#previewStatus").textContent(), /超时/);
    releaseGrant();
    await page.unroute(grantRoute);
    await page.evaluate(() => (previewView.timeout = 20000));
    await page.click("#reloadPreview");
    await page.waitForFunction(() => previewView.state === "ready");
    // Offline opens recover on online; already-loaded pages retain user changes.
    await browser.setOffline(true);
    await page.click("#reloadPreview");
    await page.waitForFunction(() => previewView.state === "offline");
    await browser.setOffline(false);
    await page.waitForFunction(() => previewView.state === "ready");
    await page.frameLocator("#previewFrame").locator('[data-plan="b"]').click();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    assert.equal(
      await page.frameLocator("#previewFrame").locator("#chart strong").first().textContent(),
      "91%",
    );
    // A late request from the old session cannot replace the next session's frame.
    let releaseOld;
    const oldGate = new Promise((resolve) => (releaseOld = resolve));
    await page.route(grantRoute, async (route) => {
      await oldGate;
      await route.abort().catch(() => {});
    });
    await page.evaluate(() => {
      previewView.reset();
      void previewView.open(current, { force: true });
      history.pushState({}, "", "/s/other");
      void route();
    });
    await page.waitForFunction(() => current?.name === "other");
    releaseOld();
    await page.unroute(grantRoute);
    assert(await page.locator("#previewFrame").isHidden());
    assert.deepEqual(errors, []);
    console.log("Browser artifacts:", dir);
  },
);
