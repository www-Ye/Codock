// One lifecycle per preview, independent of terminal connections and project HTML.
class DeskPreview {
  constructor({ request, notify, transcribe, timeout = 20000, retryDelay = 800 }) {
    Object.assign(this, {
      request,
      notify,
      transcribe,
      timeout,
      retryDelay,
      serial: 0,
      state: "idle",
      item: null,
    });
    this.status = document.querySelector("#previewStatus");
    this.voiceButton = document.querySelector("#previewVoice");
    this.voiceStatus = document.querySelector("#previewVoiceStatus");
    this.voiceButton.onclick = () => this.toggleVoice();
    window.addEventListener("message", (event) => this.message(event));
    window.addEventListener("pagehide", () => this.cancelVoice());
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
    this.cancelVoice();
    this.serial++;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.controller?.abort();
    this.controller = null;
  }
  reset() {
    this.cancel();
    this.feedbackVoice = false;
    this.voiceButton.hidden = true;
    this.voiceStatus.hidden = true;
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
    this.voiceButton.hidden = !this.voiceEnabled();
    this.voiceButton.textContent = this.voiceLabel();
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
        if (later) this.cancelVoice();
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
    {
      if (type === "codock-preview-voice-ready") {
        this.feedbackVoice = Boolean(event.data.enabled);
        this.voiceButton.hidden = !this.voiceEnabled();
        this.voiceButton.textContent = this.voiceLabel();
        return;
      }
      if (
        type === "codock-preview-voice-toggle" &&
        this.voiceEnabled() &&
        navigator.userActivation?.isActive &&
        typeof event.data.id === "string" &&
        event.data.id.length <= 100
      ) {
        if (!this.voice || this.voice.id === event.data.id) this.toggleVoice(event.data.id);
        return;
      }
      if (type === "codock-preview-voice-cancel" && this.voice?.id === event.data.id) {
        this.cancelVoice();
        return;
      }
    }
    if (type === "duck-preview-ready") {
      if (!["loading", "navigating", "ready", "error", "offline"].includes(this.state)) return;
      this.frame().bridgeReady = true;
      clearTimeout(this.timer);
      this.label("ready", "");
    } else if (type === "duck-preview-error") {
      this.fail(
        this.serial,
        String(event.data.message || "网页暂时无法打开").slice(0, 200),
        this.direct,
      );
    } else if (type === "duck-preview-navigation" && this.state === "ready") {
      this.cancelVoice();
      this.leftEntry = true;
      this.label("navigating", "正在打开链接…");
      // Never automatically replay navigation: the page may contain user input.
      this.timer = setTimeout(
        () => this.fail(this.serial, "链接加载较慢，已保留页面，请稍后查看或手动刷新。"),
        this.timeout,
      );
    }
  }
  voiceEnabled() {
    return Boolean(this.feedbackVoice && this.transcribe);
  }
  voiceLabel() {
    return "语音输入";
  }
  voicePrefix() {
    return "codock-preview-voice";
  }
  toggleVoice(requestId = null) {
    if (this.voice) {
      if (this.voice.recorder?.state === "recording") this.finishVoice();
      else {
        this.voice.send("cancelled", "已取消语音输入。");
        this.cancelVoice();
      }
      return;
    }
    if (!this.voiceEnabled() || !this.expectedOrigin) {
      this.notify("请先打开支持语音输入的预览。");
      return;
    }
    const id = requestId || crypto.randomUUID?.() || "voice-" + Date.now(),
      source = this.frame().contentWindow,
      origin = this.expectedOrigin;
    // Start only from a toolbar click or the bound preview button.
    // Keep capture in the workbench; no microphone permission in previews.
    source.postMessage(
      { type: this.voicePrefix() + "-begin", id, requested: Boolean(requestId) },
      origin,
    );
    void this.startVoice({ source, origin }, id);
  }
  cancelVoice() {
    const voice = this.voice;
    this.voice = null;
    if (!voice) return;
    this.voiceButton.textContent = this.voiceLabel();
    this.voiceButton.setAttribute("aria-pressed", "false");
    clearTimeout(voice.timer);
    voice.controller?.abort();
    if (voice.recorder?.state === "recording") voice.recorder.stop();
    voice.stream?.getTracks().forEach((track) => track.stop());
  }
  finishVoice() {
    const voice = this.voice;
    if (!voice) return;
    clearTimeout(voice.timer);
    if (voice.recorder?.state === "recording") {
      voice.send("processing", "正在识别…");
      voice.recorder.stop();
    }
  }
  async startVoice(event, id) {
    if (this.voice) {
      event.source.postMessage(
        {
          type: this.voicePrefix() + "-result",
          id,
          phase: "error",
          message: "上一段语音仍在处理中，请取消后重试。",
        },
        event.origin,
      );
      return;
    }
    const voice = {
      id,
      source: event.source,
      origin: event.origin,
      serial: this.serial,
      prefix: this.voicePrefix(),
    };
    this.voice = voice;
    const current = () =>
      this.voice === voice &&
      this.serial === voice.serial &&
      this.frame().contentWindow === voice.source &&
      this.expectedOrigin === voice.origin;
    voice.send = (phase, message, text) => {
      if (!current()) return;
      this.voiceButton.textContent =
        { opening: "取消麦克风授权", recording: "结束录音", processing: "取消语音识别" }[phase] ||
        this.voiceLabel();
      this.voiceButton.setAttribute("aria-pressed", String(phase === "recording"));
      this.voiceStatus.hidden = false;
      this.voiceStatus.textContent =
        phase === "done" ? "识别结果：" + text + "（仅填入草稿，尚未提交）" : message;
      voice.source.postMessage(
        { type: voice.prefix + "-result", id, phase, message, text },
        voice.origin,
      );
    };
    voice.send("opening", "正在打开麦克风…");
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !this.transcribe)
        throw Error("浏览器不支持录音，可用键盘麦克风输入。");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      voice.stream = stream;
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((value) =>
        MediaRecorder.isTypeSupported(value),
      );
      if (!mime) throw Error("浏览器录音格式不受支持。");
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 }),
        chunks = [];
      voice.recorder = recorder;
      let bytes = 0;
      recorder.ondataavailable = (e) => {
        if (e.data?.size) {
          chunks.push(e.data);
          bytes += e.data.size;
          if (bytes > 1000000) this.finishVoice();
        }
      };
      recorder.onerror = () => {
        voice.send("error", "录音失败，请重试。");
        if (current()) this.cancelVoice();
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (!current()) return;
        voice.send("processing", "正在识别…");
        try {
          const blob = new Blob(chunks, { type: mime });
          if (!blob.size || blob.size > 1000000) throw Error("录音为空或过长，请缩短后重试。");
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(Error("无法读取录音"));
            reader.readAsDataURL(blob);
          });
          if (!current()) return;
          voice.controller = new AbortController();
          const result = await this.transcribe(
            { data, mime, language: "auto", mode: "accurate" },
            voice.controller.signal,
          );
          if (!result.text?.trim()) throw Error("没有听清，请重试。");
          voice.send("done", "识别完成，尚未提交。", result.text.trim());
        } catch (error) {
          voice.send("error", error.message || "语音识别失败。");
        } finally {
          if (current()) this.cancelVoice();
        }
      };
      recorder.start(1000);
      voice.timer = setTimeout(() => this.finishVoice(), 25000);
      voice.send("recording", "正在录音，再点一次结束（最多 25 秒）。");
    } catch (error) {
      voice.send(
        "error",
        error.name === "NotAllowedError" ? "请允许工作台使用麦克风，再试一次。" : error.message,
      );
      if (current()) this.cancelVoice();
    }
  }
}
window.DeskPreview = DeskPreview;
