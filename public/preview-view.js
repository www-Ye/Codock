// One lifecycle per preview, independent of terminal connections and project HTML.
class DeskPreview {
  constructor({ request, notify, timeout = 20000, retryDelay = 800 }) {
    Object.assign(this, {
      request,
      notify,
      timeout,
      retryDelay,
      serial: 0,
      state: "idle",
      item: null,
    });
    this.status = document.querySelector("#previewStatus");
    window.addEventListener("message", (event) => this.message(event));
    window.addEventListener("online", () => {
      if (
        this.state === "offline" &&
        !document.querySelector("#previewPanel").classList.contains("hidden")
      )
        void this.open(this.item, { force: true });
    });
  }
  frame() {
    return document.querySelector("#previewFrame");
  }
  clearFrame() {
    const old = this.frame(),
      frame = old.cloneNode(false);
    frame.removeAttribute("src");
    frame.classList.add("hidden");
    old.replaceWith(frame);
    this.expectedOrigin = null;
  }
  label(state, text) {
    this.state = state;
    this.status.textContent = text;
    this.status.dataset.state = state;
    this.status.classList.toggle("hidden", !text);
    document.querySelector("#previewPanel").setAttribute("aria-busy", String(state === "loading"));
    document.querySelector("#reloadPreview").textContent = this.leftEntry ? "返回网页" : "刷新预览";
  }
  cancel() {
    this.serial++;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.controller?.abort();
    this.controller = null;
  }
  reset() {
    this.cancel();
    this.item = null;
    this.key = null;
    this.entryUrl = null;
    this.direct = false;
    this.attempt = 0;
    this.leftEntry = false;
    this.label("idle", "");
    this.clearFrame();
  }
  async open(item, { force = false, newWindow = false } = {}) {
    if (newWindow) {
      if (!item?.preview) return;
      const win = window.open("about:blank", "_blank");
      if (!win) {
        this.notify("请允许浏览器打开新窗口");
        return;
      }
      win.opener = null;
      try {
        const data = await this.request(item);
        win.location = data.url;
      } catch (e) {
        win.close();
        this.notify(e.message);
      }
      return;
    }
    const key = item?.name + ":" + item?.revision;
    if (!force && this.key === key && ["loading", "ready", "navigating"].includes(this.state))
      return;
    // Reuse only a previously successful binding. The preview host still checks
    // its HttpOnly cookie on EVERY request; no bearer ticket is saved/replayed.
    const entryUrl = this.key === key && this.state === "ready" ? this.entryUrl : null;
    this.reset();
    this.item = item;
    this.key = key;
    this.entryUrl = entryUrl;
    this.direct = Boolean(entryUrl);
    document.querySelector("#previewEmpty").classList.toggle("hidden", Boolean(item?.preview));
    if (!item?.preview) return;
    document.querySelector("#previewInfo").textContent =
      item.preview.type === "port"
        ? "本地网页 · " + item.preview.port
        : "HTML · " + item.preview.entry;
    await this.start(this.serial);
  }
  async start(serial) {
    if (serial !== this.serial) return;
    if (!navigator.onLine) {
      this.label("offline", "网络已断开，恢复连接后会重新打开。");
      return;
    }
    this.attempt++;
    this.label("loading", this.attempt === 1 ? "正在打开网页…" : "连接有些慢，正在重试一次…");
    this.controller = new AbortController();
    this.timer = setTimeout(
      () => this.fail(serial, "网页加载超时，请刷新预览重试。", true),
      this.timeout,
    );
    try {
      const data = this.direct
        ? { url: this.entryUrl }
        : await this.request(this.item, this.controller.signal);
      if (serial !== this.serial) return;
      this.expectedOrigin = new URL(data.url).origin;
      if (!this.direct)
        this.entryUrl = new URL(
          this.item.preview.type === "static" ? "/" + this.item.preview.entry : "/",
          this.expectedOrigin,
        ).href;
      // Replace the browsing context: late messages/load events from an old page
      // cannot mark a newer page as ready, including after rapid session switches.
      const old = this.frame(),
        frame = old.cloneNode(false);
      frame.removeAttribute("src");
      frame.classList.remove("hidden");
      old.replaceWith(frame);
      frame.addEventListener("error", () => this.fail(serial, "网页连接中断，请刷新预览。", true));
      frame.addEventListener("load", () => {
        if (serial !== this.serial) return;
        const later = Boolean(frame.didLoad),
          bridged = Boolean(frame.bridgeReady);
        frame.didLoad = true;
        frame.bridgeReady = false;
        if (later) {
          this.leftEntry = true;
          this.label(this.state, this.status.textContent);
        }
        if (bridged || !["loading", "navigating", "ready"].includes(this.state)) return;
        // load fires even for HTTP error pages. Never call it a confirmed success.
        // Documents without our bridge (PDFs/encoded upstream HTML) stay usable.
        if (later || this.state === "navigating" || this.item.preview.type === "port") {
          clearTimeout(this.timer);
          this.label(
            "ready",
            this.leftEntry
              ? "已打开链接，可点「返回网页」回到预览首页。"
              : "页面载入结束；如未显示，请刷新预览。",
          );
        }
      });
      frame.src = data.url;
    } catch (e) {
      if (serial === this.serial) this.fail(serial, e.message, !e.status || e.status >= 500);
    }
  }
  fail(serial, message, retry = false) {
    if (serial !== this.serial) return;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
    // Revoke this attempt before asynchronous fetch rejection or frame events.
    const next = ++this.serial;
    const canRetry = retry && this.attempt < 2 && this.state === "loading";
    if (canRetry) {
      this.direct = false; // one renewal on an expired cookie/failed direct refresh
      this.clearFrame();
      this.label("loading", "连接有些慢，正在重试一次…");
      this.retryTimer = setTimeout(() => void this.start(next), this.retryDelay);
    } else
      this.label(
        navigator.onLine ? "error" : "offline",
        navigator.onLine
          ? message + " 可点「刷新预览」或「新窗口打开」。"
          : "网络已断开，恢复连接后会重新打开。",
      );
  }
  message(event) {
    if (
      event.source !== this.frame().contentWindow ||
      event.origin !== this.expectedOrigin ||
      !this.item
    )
      return;
    const type = event.data?.type;
    if (type === "workbench-preview-ready") {
      if (!["loading", "navigating", "ready", "error", "offline"].includes(this.state)) return;
      this.frame().bridgeReady = true;
      clearTimeout(this.timer);
      this.label("ready", "");
    } else if (type === "workbench-preview-error") {
      this.fail(
        this.serial,
        String(event.data.message || "网页暂时无法打开").slice(0, 200),
        this.direct,
      );
    } else if (type === "workbench-preview-navigation" && this.state === "ready") {
      this.leftEntry = true;
      this.label("navigating", "正在打开链接…");
      // Never automatically replay navigation: the page may contain user input.
      this.timer = setTimeout(
        () => this.fail(this.serial, "链接加载较慢，已保留页面，请稍后查看或手动刷新。"),
        this.timeout,
      );
    }
  }
}
window.DeskPreview = DeskPreview;
