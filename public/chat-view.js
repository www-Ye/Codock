/* Tap or hold to dictate; provisional text is inline, final text only edits an unchanged draft. */
class DeskDictation {
  constructor(chat) {
    this.chat = chat;
    this.button = document.querySelector("#chatVoice");
    this.status = document.querySelector("#voiceStatus");
    this.draftPlaceholder = chat.draft.placeholder;
    this.serial = 0;
    this.holding = false;
    this.longPress = false;
    this.button.onpointerdown = (e) => {
      if (e.button !== 0 || this.button.disabled) return;
      this.holding = true;
      this.longPress = false;
      clearTimeout(this.holdTimer);
      try {
        this.button.setPointerCapture(e.pointerId);
      } catch {}
      this.holdTimer = setTimeout(() => {
        if (this.holding) {
          this.longPress = true;
          void this.startHeld();
        }
      }, 180);
    };
    this.button.onpointerup = () => {
      if (!this.holding) return;
      this.holding = false;
      clearTimeout(this.holdTimer);
      this.suppressClick = true;
      clearTimeout(this.clickTimer);
      this.clickTimer = setTimeout(() => {
        this.suppressClick = false;
      }, 500);
      if (!this.longPress) {
        this.toggle();
        return;
      }
      if (this.recorder?.state === "recording") this.finish();
      else if (!this.pending) {
        this.cancel();
        this.say("录音还没开始；允许麦克风后，请再试一次。", "error");
      }
    };
    this.button.onpointercancel = () => {
      this.holding = false;
      clearTimeout(this.holdTimer);
      this.cancel();
    };
    this.button.onclick = (e) => {
      if (e.detail && this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.toggle();
    };
  }
  say(message, phase) {
    this.status.textContent = message;
    this.status.classList.toggle("hidden", !message);
    this.status.classList.toggle("voice-error", phase === "error");
    if (phase) this.button.dataset.voice = phase;
    const preview = "边说边识别（临时）：";
    this.chat.draft.placeholder =
      message.startsWith(preview) && !this.chat.draft.value
        ? message.slice(preview.length)
        : this.draftPlaceholder;
  }
  toggle() {
    if (this.recorder) {
      this.finish();
      return;
    }
    if (this.pending) return;
    void this.start();
  }
  async startHeld() {
    if (this.holding) await this.start(true);
  }
  cancel() {
    this.serial++;
    clearTimeout(this.timeout);
    clearTimeout(this.holdTimer);
    this.timeout = null;
    this.holding = false;
    this.controller?.abort();
    this.controller = null;
    this.previewController?.abort();
    this.previewController = null;
    this.warmController?.abort();
    this.warmController = null;
    const recorder = this.recorder;
    this.recorder = null;
    this.pending = false;
    if (recorder && recorder.state === "recording") {
      try {
        recorder.stop();
      } catch {}
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.finishing = false;
    this.button.classList.remove("listening");
    this.button.setAttribute("aria-label", "轻点开始听写，或按住说话");
    this.button.title = "语音输入";
    this.say("", "idle");
  }
  close() {
    this.cancel();
  }
  finish() {
    if (!this.recorder || this.recorder.state !== "recording") return;
    clearTimeout(this.timeout);
    this.finishing = true;
    this.say("正在识别完整录音，文字只会进入草稿…", "processing");
    try {
      this.recorder.stop();
    } catch {
      this.cancel();
      this.say("录音停止失败，请重试。", "error");
    }
  }
  async blobData(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(Error("录音读取失败"));
      reader.readAsDataURL(blob);
    });
  }
  preview(chunks, mime, language, serial) {
    if (
      this.previewTask ||
      this.finishing ||
      !this.recorder ||
      Date.now() - this.startedAt < 2500 ||
      Date.now() - this.previewAt < 3000
    )
      return;
    const blob = new Blob(chunks, { type: mime });
    if (blob.size < 32 || blob.size > 1000000) return;
    this.previewAt = Date.now();
    const controller = new AbortController();
    this.previewController = controller;
    const task = (async () => {
      const data = await this.blobData(blob);
      if (serial !== this.serial || this.finishing) return;
      const result = await this.chat.transcribe(
        { mime, language, data, mode: "fast" },
        controller.signal,
        true,
      );
      if (
        serial === this.serial &&
        this.recorder?.state === "recording" &&
        !this.finishing &&
        result.text?.trim()
      )
        this.say("边说边识别（临时）：" + result.text.trim());
    })()
      .catch(() => {
        if (serial === this.serial && this.recorder?.state === "recording" && !this.finishing)
          this.say("正在录音…松开后会用完整录音识别。");
      })
      .finally(() => {
        if (this.previewController === controller) this.previewController = null;
        if (this.previewTask === task) this.previewTask = null;
      });
    this.previewTask = task;
  }
  async start(held = false) {
    const key = this.chat.key(),
      draft = this.chat.draft;
    if (!key || draft.disabled || this.recorder || this.pending || (held && !this.holding)) return;
    const before = draft.value,
      start = document.activeElement === draft ? draft.selectionStart : before.length,
      end = document.activeElement === draft ? draft.selectionEnd : before.length;
    const serial = ++this.serial,
      language = "auto";
    this.say("正在打开麦克风…", "opening");
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      this.say("此浏览器不支持录音，请用手机键盘上的麦克风。", "error");
      return;
    }
    this.warmController = new AbortController();
    void this.chat.prepareVoice(language, this.warmController.signal).catch(() => {});
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      if (serial === this.serial) this.say("麦克风未获允许或不可用，请用键盘麦克风。", "error");
      return;
    }
    if (
      serial !== this.serial ||
      this.chat.key() !== key ||
      document.hidden ||
      (held && !this.holding)
    ) {
      stream.getTracks().forEach((track) => track.stop());
      if (serial === this.serial) this.say("", "idle");
      return;
    }
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((value) =>
      MediaRecorder.isTypeSupported(value),
    );
    if (!mime) {
      stream.getTracks().forEach((track) => track.stop());
      this.say("浏览器录音格式不受支持，请用键盘麦克风。", "error");
      return;
    }
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      this.say("录音启动失败，请用键盘麦克风。", "error");
      return;
    }
    this.stream = stream;
    this.recorder = recorder;
    this.finishing = false;
    this.previewAt = 0;
    this.startedAt = Date.now();
    const chunks = [];
    this.button.classList.add("listening");
    this.button.setAttribute("aria-label", "结束听写");
    this.button.title = "结束听写";
    this.say(held ? "正在录音…松开即识别。" : "正在录音…再点麦克风结束，最多 25 秒。", "listening");
    recorder.ondataavailable = (event) => {
      if (event.data?.size) {
        chunks.push(event.data);
        this.preview(chunks, mime, language, serial);
      }
    };
    recorder.onerror = () => {
      if (serial === this.serial) {
        this.cancel();
        this.say("录音失败，请用键盘麦克风。", "error");
      }
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      if (serial !== this.serial) return;
      this.recorder = null;
      this.stream = null;
      this.pending = true;
      this.button.classList.remove("listening");
      try {
        const blob = new Blob(chunks, { type: mime });
        if (!blob.size || blob.size > 1000000) throw Error("录音过大或为空，请缩短语音重试。");
        await this.previewTask;
        const data = await this.blobData(blob);
        if (serial !== this.serial) return;
        this.controller = new AbortController();
        const result = await this.chat.transcribe(
          { mime, language, data, mode: "accurate" },
          this.controller.signal,
        );
        if (
          serial !== this.serial ||
          this.chat.key() !== key ||
          !this.chat.active ||
          document.hidden
        )
          return;
        if (draft.disabled || draft.value !== before) {
          this.say("草稿已改动，本次识别未覆盖你的文字。", "error");
          return;
        }
        const text = result.text?.trim();
        if (!text) {
          this.say("没有听清，可以重录一次。", "error");
          return;
        }
        const next = before.slice(0, start) + text + before.slice(end);
        if (next.length > 4000 || new TextEncoder().encode(next).length > 12000) {
          this.say("识别内容太长，未改动草稿。", "error");
          return;
        }
        draft.value = next;
        draft.setSelectionRange(start + text.length, start + text.length);
        this.chat.drafts.set(key, next);
        this.chat.resizeDraft();
        this.close();
        draft.focus();
      } catch (e) {
        if (serial === this.serial) this.say(e.message || "识别失败，请用键盘麦克风。", "error");
      } finally {
        if (serial === this.serial) {
          this.pending = false;
          this.controller = null;
        }
      }
    };
    this.timeout = setTimeout(() => this.finish(), 25000);
    try {
      recorder.start(1000);
    } catch {
      this.cancel();
      this.say("录音启动失败，请用键盘麦克风。", "error");
    }
  }
}

/* Saved history + literal text and Enter in the original terminal. */
class DeskChat {
  constructor({
    request,
    send,
    receipt,
    recover,
    release,
    dismiss,
    readQuestion,
    submitQuestion,
    voiceStatus,
    prepareVoice,
    transcribe,
    onRuntime = () => {},
  }) {
    this.request = request;
    this.send = send;
    this.receipt = receipt;
    this.recover = recover;
    this.release = release;
    this.dismiss = dismiss;
    this.readQuestion = readQuestion;
    this.submitQuestion = submitQuestion;
    this.voiceStatus = voiceStatus;
    this.prepareVoice = prepareVoice;
    this.transcribe = transcribe;
    this.nodes = new Map();
    this.serial = 0;
    this.active = false;
    this.checking = new Set();
    this.dismissed = new Set();
    this.drafts = new Map();
    this.outgoing = new Map();
    this.groups = new Map();
    this.sent = new Map();
    this.failedExpanded = new Set();
    this.views = new Map();
    this.verified = false;
    this.readOnly = false;
    this.questionPending = false;
    this.questionToken = null;
    this.onRuntime = onRuntime;
    this.runtimeObservedAt = 0;
    this.runtimeCheckedAt = 0;
    this.runBadge = document.querySelector("#chatRunStatus");
    this.runLabel = document.querySelector("#chatRunLabel");
    this.runBadge.onclick = () => {
      if (this.runBadge.dataset.state === "waiting")
        document.querySelector("#chatAttention").click();
    };
    this.scroll = document.querySelector("#chatScroll");
    this.messages = document.querySelector("#chatMessages");
    this.status = document.querySelector("#chatStatus");
    this.questionCard = document.querySelector("#chatQuestion");
    this.older = document.querySelector("#chatOlder");
    this.draft = document.querySelector("#chatDraft");
    this.sendButton = document.querySelector("#chatSend");
    this.sendStatus = document.querySelector("#chatSendStatus");
    this.receiptButton = document.querySelector("#chatReceipt");
    document.querySelector("#chatForm").onsubmit = (e) => {
      e.preventDefault();
      void this.submit();
    };
    this.voice = new DeskDictation(this);
    this.draft.oninput = () => {
      this.voice.cancel();
      if (this.key()) this.drafts.set(this.key(), this.draft.value);
      this.resizeDraft();
    };
    this.receiptButton.onclick = () => void this.checkReceipt();
    document.querySelector("#chatRefresh").onclick = () => this.open(this.item, { fresh: true });
    document.querySelector("#chatLatest").onclick = () => {
      this.bottom();
    };
    this.older.onclick = () => this.load(true);
    document.querySelector("#chatActivityToggle").onclick = (e) => {
      const hide = this.messages.classList.toggle("hide-activities");
      e.currentTarget.setAttribute("aria-pressed", String(hide));
      e.currentTarget.textContent = hide ? "显示执行记录" : "仅看对话";
    };
    document.addEventListener("visibilitychange", () => {
      clearTimeout(this.timer);
      this.runtime(null);
      if (document.hidden) this.voice.close();
      else if (this.active) void this.load();
    });
    window.addEventListener("pagehide", () => this.voice.close());
    window.addEventListener("online", () => {
      if (this.active) void this.load();
    });
    window.addEventListener("offline", () => this.runtime(null));
  }
  runtime(value) {
    const checkedAt = Number.isFinite(value?.checkedAt) ? value.checkedAt : 0;
    if (checkedAt && checkedAt < this.runtimeCheckedAt) return;
    clearTimeout(this.runExpiry);
    const labels = {
      running: "正在运行",
      waiting: "等待操作 ↗",
      ready: "待命",
      unknown: "状态待确认",
    };
    const state =
      value?.source === "terminal-hint" && Object.hasOwn(labels, value.state)
        ? value.state
        : "unknown";
    if (state === "unknown") this.runtimeObservedAt = 0;
    else {
      this.runtimeObservedAt = Date.now();
      if (checkedAt) this.runtimeCheckedAt = checkedAt;
    }
    this.runBadge.dataset.state = state;
    if (this.runLabel.textContent !== labels[state]) this.runLabel.textContent = labels[state];
    this.runBadge.title =
      state === "unknown"
        ? "当前状态未能确认，可打开原终端查看。"
        : "根据原终端当前界面提示判断，约每 4 秒更新；不是消息发送回执。";
    this.runBadge.setAttribute("aria-label", labels[state]);
    const attention = document.querySelector("#chatAttention");
    attention.classList.toggle(
      "hidden",
      state !== "waiting" || !this.questionCard.classList.contains("hidden"),
    );
    const question = value?.attention?.kind === "question";
    const summary =
      question && typeof value.attention.summary === "string" ? value.attention.summary.trim() : "";
    window.CodockTheme?.status(state);
    attention.textContent =
      state === "waiting"
        ? summary
          ? "助手在问：" + summary + " · 打开现场回答 →"
          : question
            ? "助手有问题等你回答 · 打开现场 →"
            : "原终端需要你确认 · 打开现场 →"
        : "有问题等你回答 · 查看现场 →";
    if (this.item)
      this.onRuntime(this.item, { state, source: "terminal-hint", checkedAt: value?.checkedAt });
    if (state !== "waiting") {
      this.questionToken = null;
      this.questionCard.classList.add("hidden");
    } else if (this.active && this.key()) void this.loadQuestion();
    if (state !== "unknown") this.runExpiry = setTimeout(() => this.runtime(null), 15000);
  }
  key() {
    return this.item && this.binding
      ? this.item.name + ":" + this.item.identity + ":" + this.binding
      : null;
  }
  remember(key, out) {
    try {
      if (["submitted", "queued", "failed", "released"].includes(out.state))
        sessionStorage.removeItem("codock.chat.receipt." + key);
      else sessionStorage.setItem("codock.chat.receipt." + key, out.requestId);
    } catch {}
  }
  acceptReceipt(key, value) {
    for (const out of new Set([this.outgoing.get(key), this.sent.get(key)?.get(value.requestId)])) {
      if (!out || out.requestId !== value.requestId || (out.observed && !value.observed)) continue;
      Object.assign(out, value, { onServer: true });
    }
  }
  cacheKey(item) {
    return item?.identity ? item.name + ":" + item.identity : null;
  }
  saveView() {
    const key = this.cacheKey(this.item);
    if (!key || !this.binding || !this.nodes.size || this.nodes.size > 120) return;
    this.views.delete(key);
    this.views.set(key, {
      binding: this.binding,
      revision: this.revision,
      before: this.before,
      messages: [...this.nodes].map(([id, node]) => ({ id, record: node.record })),
    });
    if (this.views.size > 24) this.views.delete(this.views.keys().next().value);
  }
  async loadQuestion() {
    if (
      !this.readQuestion ||
      this.questionPending ||
      !this.active ||
      !this.verified ||
      !this.key() ||
      this.runBadge.dataset.state !== "waiting"
    )
      return;
    this.questionPending = true;
    const serial = this.serial,
      item = this.item,
      binding = this.binding;
    try {
      const result = await this.readQuestion(item, binding);
      if (
        serial !== this.serial ||
        !this.active ||
        this.binding !== binding ||
        this.runBadge.dataset.state !== "waiting"
      )
        return;
      if (!result.available) {
        this.questionToken = null;
        this.questionCard.classList.add("hidden");
        return;
      }
      if (this.questionToken !== result.token) {
        this.questionToken = result.token;
        const title = document.createElement("h3");
        title.textContent = result.title;
        title.style.whiteSpace = "pre-wrap";
        this.questionKind = result.kind;
        const hint = document.createElement("p");
        hint.textContent =
          result.kind === "permission"
            ? "Claude Code 请求权限 · 核对操作后再选择"
            : "有问题等你回答 · 点一个选项直接回答";
        const choices = document.createElement("div");
        choices.className = "choices";
        for (const choice of result.choices) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = choice.label;
          button.onclick = () => void this.chooseQuestion(choice.index);
          choices.append(button);
        }
        const status = document.createElement("p");
        status.className = "question-status";
        status.setAttribute("role", "status");
        this.questionCard.replaceChildren(title, hint, choices, status);
      }
      this.questionCard.classList.remove("hidden");
      document.querySelector("#chatAttention").classList.add("hidden");
    } catch {
      if (serial === this.serial) {
        this.questionToken = null;
        this.questionCard.classList.add("hidden");
      }
    } finally {
      if (serial === this.serial) this.questionPending = false;
    }
  }
  async chooseQuestion(index) {
    if (!this.submitQuestion || !this.questionToken || !this.active || !this.verified) return;
    if (
      this.questionKind === "permission" &&
      !confirm(
        "确认向原 Claude Code 提交这个权限选项？\n" +
          this.questionCard.querySelectorAll(".choices button")[index - 1]?.textContent,
      )
    )
      return;
    const serial = this.serial,
      item = this.item,
      binding = this.binding,
      token = this.questionToken;
    const buttons = [...this.questionCard.querySelectorAll(".choices button")],
      status = this.questionCard.querySelector(".question-status");
    buttons.forEach((button) => (button.disabled = true));
    status.textContent = "正在核对并提交选择…";
    try {
      await this.submitQuestion(item, binding, token, index);
      if (serial !== this.serial) return;
      status.textContent = "已提交，正在等待助手继续…";
      this.questionToken = null;
      this.questionCard.classList.add("hidden");
      if (this.active) void this.load();
    } catch (error) {
      if (serial !== this.serial) return;
      status.textContent = error.message || "选择没有提交，请刷新后重试。";
      buttons.forEach((button) => (button.disabled = false));
      if (error.status === 409) {
        this.questionToken = null;
        void this.loadQuestion();
      }
    }
  }
  reset() {
    this.clear();
    this.drafts.clear();
    this.outgoing.clear();
    this.sent.clear();
    this.views.clear();
  }
  resizeDraft() {
    this.draft.style.height = "auto";
    this.draft.style.height = Math.min(120, this.draft.scrollHeight) + "px";
  }
  composer() {
    const key = this.key(),
      out = this.outgoing.get(key),
      blocked = out && ["sending", "unknown"].includes(out.state);
    this.draft.disabled = !key || this.readOnly;
    this.sendButton.disabled = !key || !this.verified || Boolean(blocked);
    this.sendButton.textContent =
      out?.state === "sending"
        ? "发送中…"
        : this.readOnly
          ? "只读记录"
          : key && !this.verified
            ? "确认会话中…"
            : "发送 ↑";
    this.sendStatus.textContent = ["failed", "unknown"].includes(out?.state)
      ? out.message || "发送未完成，请检查回执。"
      : "";
    this.receiptButton.classList.toggle("hidden", out?.state !== "unknown");
    this.voice.button.disabled = this.draft.disabled;
    document.querySelector("#chatModel").disabled = this.draft.disabled || !this.verified;
    if (this.draft.disabled) this.voice.close();
    this.resizeDraft();
  }
  async submit() {
    const key = this.key(),
      item = this.item,
      binding = this.binding,
      text = this.draft.value;
    if (!key || this.sendButton.disabled || !text.trim()) return;
    if (new TextEncoder().encode(text).length > 12000) {
      this.sendStatus.textContent = "消息较长，请分段发送（每条最多 12 KB）。";
      return;
    }
    this.voice.close();
    const out = {
      requestId: crypto.randomUUID(),
      text,
      state: "sending",
      created: Date.now(),
      message: "正在发送到原终端…",
    };
    this.drafts.set(key, text);
    this.outgoing.set(key, out);
    this.composer();
    if (!this.sent.has(key)) this.sent.set(key, new Map());
    this.sent.get(key).set(out.requestId, out);
    this.layout();
    this.bottom();
    this.remember(key, out);
    try {
      const result = await this.send(item, {
        identity: item.identity,
        binding,
        text,
        requestId: out.requestId,
        confirm: true,
        transport: "terminal-enter",
      });
      this.acceptReceipt(key, result);
      if (["submitted", "queued"].includes(out.state) && this.drafts.get(key) === text)
        this.drafts.set(key, "");
    } catch (error) {
      const definitelyRejected = [400, 403, 409, 429].includes(error.status);
      if (!out.observed)
        Object.assign(out, {
          state: definitelyRejected ? "failed" : "unknown",
          message: definitelyRejected
            ? error.message
            : "连接中断，尚未确认是否送达。请检查回执，不要重复发送。",
        });
    }
    this.remember(key, out);
    if (this.key() === key) {
      this.draft.value = this.drafts.get(key) || "";
      this.composer();
      this.layout();
      if (this.active) void this.load();
    }
  }
  async checkReceipt() {
    const key = this.key(),
      out = this.outgoing.get(key),
      item = this.item,
      binding = this.binding;
    if (!out || !item || this.checking.has(out.requestId)) return;
    this.checking.add(out.requestId);
    this.receiptButton.disabled = true;
    try {
      let result;
      try {
        result = await this.receipt(item, out.requestId);
      } catch (e) {
        if (e.status !== 404 || !this.recover) throw e;
        result = await this.recover(item, out.requestId, { identity: item.identity, binding });
      }
      this.acceptReceipt(key, result);
      this.remember(key, out);
      if (["submitted", "queued"].includes(out.state) && this.drafts.get(key) === out.text)
        this.drafts.set(key, "");
      if (this.key() === key) {
        this.draft.value = this.drafts.get(key) || "";
        this.composer();
        this.layout();
      }
    } catch {
      if (this.key() === key)
        this.sendStatus.textContent = "回执暂时无法确认，草稿仍保留。请检查原终端，勿重复发送。";
    } finally {
      this.checking.delete(out.requestId);
      this.receiptButton.disabled = false;
    }
  }
  async releaseUnknown(out, button) {
    if (out.state !== "unknown" || button.disabled || !this.release) return;
    if (
      !confirm(
        "这条消息可能已经送达。请先检查原终端。结束核对只会解除发送锁定，不会按回车、重发或删除这条记录。继续吗？",
      )
    )
      return;
    const key = this.key(),
      item = this.item,
      binding = this.binding;
    button.disabled = true;
    try {
      const result = await this.release(item, out.requestId, {
        identity: item.identity,
        binding,
        confirmRelease: true,
      });
      this.acceptReceipt(key, result);
      this.remember(key, out);
      if (this.key() === key) {
        this.composer();
        this.layout();
      }
    } catch (e) {
      button.disabled = false;
      if (this.key() === key) this.sendStatus.textContent = "结束核对没有完成：" + e.message;
    }
  }
  async dismissFailed(out, button) {
    if (out.state !== "failed" || button.disabled) return;
    const key = this.key(),
      item = this.item,
      binding = this.binding,
      id = out.requestId;
    button.disabled = true;
    try {
      try {
        await this.dismiss(item, id, { identity: item.identity, binding });
      } catch (e) {
        if (e.status !== 404 || e.message !== "这条记录已不存在") throw e;
      } // No receipt, not an absent endpoint or wrong thread.
      this.dismissed.add(id);
      this.sent.get(key)?.delete(id);
      if (this.outgoing.get(key)?.requestId === id) this.outgoing.delete(key);
      this.remember(key, out);
      if (this.key() === key) {
        this.composer();
        this.layout();
      }
    } catch (e) {
      button.disabled = false;
      if (this.key() === key) this.sendStatus.textContent = "移除没有完成：" + e.message;
    }
  }
  stop() {
    this.voice.close();
    this.active = false;
    this.serial++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.busy = false;
    this.runtime(null);
    this.runtimeCheckedAt = 0;
  }
  clear() {
    this.saveView();
    this.stop();
    this.item = null;
    this.binding = null;
    this.verified = false;
    this.readOnly = false;
    this.questionToken = null;
    this.questionPending = false;
    this.questionCard.classList.add("hidden");
    this.layoutKey = null;
    this.nodes.clear();
    this.groups.clear();
    this.messages.replaceChildren();
    this.draft.value = "";
    this.composer();
  }
  open(item, { fresh = false } = {}) {
    this.clear();
    if (!item) return;
    if (fresh) this.views.delete(this.cacheKey(item));
    this.item = item;
    this.active = true;
    this.binding = null;
    this.revision = null;
    this.before = null;
    const cached = this.views.get(this.cacheKey(item));
    if (cached) {
      this.binding = cached.binding;
      this.revision = cached.revision;
      this.before = cached.before;
      for (const { id, record } of cached.messages) {
        const node = document.createElement("article");
        node.dataset.id = id;
        this.nodes.set(id, node);
        this.render(record, node);
      }
      this.draft.value = this.drafts.get(this.key()) || "";
      this.layout();
      this.bottom();
      const serial = this.serial;
      requestAnimationFrame(() => {
        if (serial === this.serial && this.active) this.bottom();
      });
      this.status.textContent = "上次阅读内容 · 正在核对原会话…";
      this.older.classList.toggle("hidden", this.before === null);
    } else {
      this.status.textContent = "正在读取原会话的对话…";
      this.older.classList.add("hidden");
    }
    this.composer();
    document.querySelector("#chatMeta").textContent = "原来的对话，换一种看法";
    void this.load();
  }
  bottom() {
    this.scroll.scrollTop = this.scroll.scrollHeight;
    document.querySelector("#chatLatest").textContent = "↓ 最新";
  }
  mergeRecord(message) {
    if (message.provider !== "claude" || !message.sourceId) return message;
    const existing = [...this.nodes.values()].find(
      (node) => node.record?.sourceId === message.sourceId,
    )?.record;
    if (!existing) return { ...message, sourceOrder: message.id };
    // Rewritten Claude UUIDs replace their original bubble, even across pages.
    // Keep its displayed position; loading older pages must not revert new text.
    const latest =
      Number(message.id) > Number(existing.sourceOrder || existing.id)
        ? { ...message, sourceOrder: message.id }
        : existing;
    return { ...latest, id: existing.id };
  }
  render(message, node) {
    const fingerprint = JSON.stringify(message);
    if (node.source === fingerprint) return false;
    const expanded = node.querySelector("details")?.open;
    node.source = fingerprint;
    node.replaceChildren();
    node.record = message;
    node.className = message.role === "activity" ? "chat-event" : "chat-message " + message.role;
    const time = document.createElement("time"),
      date = new Date(message.time);
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (message.role === "activity") {
      const details = document.createElement("details");
      details.open = Boolean(expanded);
      const summary = document.createElement("summary"),
        title = document.createElement("span"),
        badge = document.createElement("span");
      title.textContent = message.title;
      const status =
        {
          completed: "已完成",
          inProgress: "进行中",
          failed: "失败",
          declined: "未批准",
          cancelled: "已取消",
          interrupted: "已中断",
        }[message.status] || "已记录";
      badge.className = "event-state";
      badge.dataset.state = message.status;
      badge.textContent = status;
      summary.append(title, badge, time);
      details.append(summary);
      // Large command/output blocks are mounted only on expansion.
      const fill = () => {
        if (details.childElementCount > 1 || !details.open) return;
        const content = document.createElement("div");
        content.className = "event-content";
        for (const part of message.details || []) {
          const label = document.createElement("h4"),
            pre = document.createElement("pre");
          label.textContent = part.label;
          pre.textContent = part.text;
          content.append(label, pre);
        }
        if (!content.childElementCount) {
          const p = document.createElement("p");
          p.textContent = "此动作没有额外详情。";
          content.append(p);
        }
        if (message.truncated) {
          const p = document.createElement("p");
          p.className = "micro";
          p.textContent = "详情经过长度限制或敏感字段隐藏，完整内容请在原终端核对。";
          content.append(p);
        }
        details.append(content);
      };
      details.ontoggle = fill;
      node.append(details);
      fill();
      return true;
    }
    const header = document.createElement("div");
    header.className = "chat-message-head";
    const author = document.createElement("span");
    author.textContent =
      message.role === "user"
        ? "你"
        : message.provider === "claude"
          ? "Claude Code"
          : message.phase === "commentary"
            ? "Codex · 进展"
            : "Codex";
    const avatar = document.createElement("span");
    avatar.className = "chat-avatar";
    avatar.textContent = message.role === "user" ? "你" : "鸭";
    const copy = document.createElement("button");
    copy.className = "quiet";
    copy.textContent = "复制";
    copy.setAttribute("aria-label", "复制这条消息");
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(message.text);
        copy.textContent = "已复制";
      } catch {
        copy.textContent = "请长按选择";
      }
    };
    header.append(avatar, author, time, copy);
    const body = document.createElement("div");
    body.className = "chat-message-body";
    if (message.role === "user") body.textContent = message.text;
    else renderMarkdown(body, message.text);
    node.append(header, body);
    if (message.truncated) {
      const note = document.createElement("p");
      note.className = "micro";
      note.textContent = "这条消息较长，此处只显示部分内容；完整内容请在原终端查看。";
      node.append(note);
    }
    return true;
  }
  layout() {
    const versions = [...this.nodes.values()].map((n) => n.source);
    const pending = JSON.stringify([...(this.sent.get(this.key())?.values() || [])]);
    if (
      this.layoutKey === this.key() &&
      this.layoutPending === pending &&
      this.layoutVersions?.length === versions.length &&
      versions.every((v, i) => v === this.layoutVersions[i])
    )
      return;
    this.layoutKey = this.key();
    this.layoutPending = pending;
    this.layoutVersions = versions;
    const ordered = [...this.nodes.values()].sort(
      (a, b) => Number(a.dataset.id) - Number(b.dataset.id),
    );
    const fragment = document.createDocumentFragment();
    let group = null,
      events = [];
    const finish = () => {
      if (!group) return;
      const counts = new Map();
      for (const n of events) counts.set(n.record.title, (counts.get(n.record.title) || 0) + 1);
      const running = events.some((n) => n.record.status === "inProgress"),
        failed = events.some((n) => ["failed", "declined"].includes(n.record.status));
      group.querySelector("summary").textContent =
        `${running ? "◌" : failed ? "!" : "↳"} ${events.length} 条执行记录 · ${[...counts]
          .slice(0, 3)
          .map(([name, count]) => name + (count > 1 ? " ×" + count : ""))
          .join("、")}`;
      group.classList.toggle("has-failure", failed);
      group = null;
      events = [];
    };
    for (const node of ordered) {
      if (node.record.role !== "activity") {
        finish();
        fragment.append(node);
        continue;
      }
      if (!group) {
        group = this.groups.get(node.dataset.id);
        if (!group) {
          group = document.createElement("details");
          group.className = "activity-group";
          group.dataset.id = node.dataset.id;
          group.append(document.createElement("summary"));
          this.groups.set(node.dataset.id, group);
        }
        for (const child of [...group.children].slice(1)) child.remove();
        fragment.append(group);
      }
      group.append(node);
      events.push(node);
    }
    finish();
    const failed = [...(this.sent.get(this.key())?.values() || [])].filter(
      (out) => out.state === "failed",
    );
    let failedGroup;
    if (failed.length) {
      const key = this.key();
      failedGroup = document.createElement("details");
      failedGroup.className = "failed-sends";
      failedGroup.open = this.failedExpanded.has(key);
      const summary = document.createElement("summary");
      summary.textContent = failed.length + " 条未发送 · 展开查看或取回文字";
      failedGroup.append(summary);
      fragment.append(failedGroup);
      failedGroup.ontoggle = () => {
        if (failedGroup.open) this.failedExpanded.add(key);
        else this.failedExpanded.delete(key);
      };
    }
    // Keep sent text visible until its exact saved user message arrives.
    // A terminal receipt is not a claim that the model has processed it.
    const saved = ordered.filter((n) => n.record.role === "user").map((n) => n.record),
      used = new Set(
        [...(this.sent.get(this.key())?.values() || [])]
          .filter((o) => o.observed)
          .map((o) => o.observed),
      );
    for (const out of [...(this.sent.get(this.key())?.values() || [])].sort(
      (a, b) => a.created - b.created,
    )) {
      if (out.observed) continue;
      const match =
        out.state === "submitted" &&
        saved.find((m) => !used.has(m.id) && m.time >= out.created - 1000 && m.text === out.text);
      if (match) {
        used.add(match.id);
        out.observed = match.id;
        continue;
      }
      const node = document.createElement("article");
      this.render({ role: "user", text: out.text, time: out.created }, node);
      node.dataset.receipt = out.requestId;
      const status = document.createElement("span");
      status.className = "micro";
      status.textContent =
        {
          sending: "发送中…",
          submitted: "已送到终端",
          unknown: "送达待核对",
          released: "未确认 · 已解锁",
          failed: "未发送",
          queued: "旧版排队消息",
        }[out.state] || "送达待核对";
      node.querySelector(".chat-message-head").append(status);
      if (out.state === "unknown") {
        const release = document.createElement("button");
        release.className = "quiet release-unknown";
        release.textContent = "结束核对";
        release.title = "核对原终端后解除发送锁定；保留这条记录，不自动重发";
        release.onclick = () => void this.releaseUnknown(out, release);
        node.append(release);
      }
      if (out.state === "failed") {
        const reason = document.createElement("p");
        reason.className = "micro";
        reason.textContent = out.message || "没有发送到终端。";
        const restore = document.createElement("button");
        restore.className = "quiet";
        restore.textContent = "放回输入框";
        restore.onclick = () => {
          if (this.draft.disabled) return;
          if (
            this.draft.value.trim() &&
            this.draft.value !== out.text &&
            !confirm("用这条未发送的文字替换当前草稿？")
          )
            return;
          this.draft.value = out.text;
          this.drafts.set(this.key(), out.text);
          this.resizeDraft();
          this.draft.focus();
        };
        const remove = document.createElement("button");
        remove.className = "quiet danger dismiss-failed";
        remove.textContent = "移除";
        remove.title = "只移除失败记录，不删除聊天或当前草稿";
        remove.onclick = () => void this.dismissFailed(out, remove);
        node.append(reason, restore, remove);
        failedGroup.append(node);
      } else {
        // Unconfirmed receipts belong at their send time, not below later
        // saved messages. The server may still be checking an older page.
        const later = ordered.find((item) => item.record.time > out.created);
        const parent = later?.parentNode;
        const reference =
          parent === fragment ? later : parent?.parentNode === fragment ? parent : null;
        fragment.insertBefore(node, reference || failedGroup || null);
      }
    }
    this.messages.replaceChildren(fragment);
    const retained = new Set(
      [...this.messages.querySelectorAll(".activity-group")].map((g) => g.dataset.id),
    );
    for (const key of this.groups.keys()) if (!retained.has(key)) this.groups.delete(key);
  }
  async load(older = false) {
    if (!this.active || this.busy || document.hidden || (older && this.before === null)) return;
    clearTimeout(this.timer);
    this.busy = true;
    this.older.disabled = true;
    const serial = this.serial,
      controller = new AbortController();
    this.controller = controller;
    const failedBefore = new Set(
      [...(this.sent.get(this.key())?.values() || [])]
        .filter((o) => o.state === "failed" && o.onServer)
        .map((o) => o.requestId),
    );
    const submittedBefore = new Set(
      [...(this.sent.get(this.key())?.values() || [])]
        .filter((o) => o.state === "submitted" && o.onServer)
        .map((o) => o.requestId),
    );
    const timeout = setTimeout(() => controller.abort(), 11000);
    const query = new URLSearchParams({ identity: this.item.identity });
    if (this.binding) query.set("binding", this.binding);
    const pending = this.outgoing.get(this.key());
    if (pending && !pending.observed && pending.state !== "failed")
      query.set("receipt", pending.requestId);
    if (older) query.set("before", this.before);
    else if (this.revision) query.set("revision", this.revision);
    try {
      const result = await this.request(this.item, query, controller.signal);
      if (serial !== this.serial) return;
      this.runtime(result.runtime);
      if (!result.available) {
        if (["changed", "format"].includes(result.reason)) {
          this.views.delete(this.cacheKey(this.item));
          this.nodes.clear();
          this.groups.clear();
          this.messages.replaceChildren();
          this.status.textContent = result.message;
          this.active = false;
          this.binding = null;
          this.verified = false;
          this.composer();
          return;
        }
        // A temporary reader/daemon failure is not proof that the conversation
        // disappeared. Keep its last verified history, block input, then retry.
        this.readOnly = true;
        this.verified = false;
        this.questionToken = null;
        this.questionCard.classList.add("hidden");
        this.composer();
        this.status.textContent = result.message || "原对话暂时无法读取，正在重试。";
        this.sendStatus.textContent = "当前记录尚未核实，暂时不能发送；会自动重试。";
        return;
      }
      const hadBinding = this.binding;
      if (hadBinding && result.binding !== hadBinding) {
        this.views.delete(this.cacheKey(this.item));
        this.nodes.clear();
        this.messages.replaceChildren();
        this.status.textContent = "原对话已切换，请刷新聊天。";
        this.active = false;
        this.verified = false;
        this.composer();
        return;
      }
      this.binding = result.binding;
      this.readOnly = Boolean(result.readOnly);
      this.verified = !this.readOnly;
      const receipts = this.sent.get(this.key()) || new Map();
      const visible = new Set((result.outbox || []).map((o) => o.requestId));
      // Reconcile removals made on another device, but not a new failure that
      // happened while this read was in flight.
      for (const id of failedBefore)
        if (!visible.has(id) && receipts.get(id)?.state === "failed") {
          receipts.delete(id);
          if (this.outgoing.get(this.key())?.requestId === id) this.outgoing.delete(this.key());
        }
      for (const id of submittedBefore)
        if (!visible.has(id) && receipts.get(id)?.state === "submitted") {
          receipts.delete(id);
          if (this.outgoing.get(this.key())?.requestId === id) this.outgoing.delete(this.key());
        }
      for (const out of result.outbox || []) {
        if (this.dismissed.has(out.requestId)) continue; // An older in-flight poll cannot resurrect it.
        const existing = receipts.get(out.requestId);
        if (existing && existing.state === "sending" && out.state === "unknown") continue;
        if (existing) {
          if (!existing.observed || out.observed) Object.assign(existing, out, { onServer: true });
        } else receipts.set(out.requestId, { ...out, onServer: true });
      }
      this.sent.set(this.key(), receipts);
      if (!hadBinding) {
        const key = this.key();
        this.draft.value = this.drafts.get(key) || "";
        if (!this.outgoing.has(key))
          try {
            const requestId = sessionStorage.getItem("codock.chat.receipt." + key);
            if (requestId)
              this.outgoing.set(
                key,
                receipts.get(requestId) || {
                  requestId,
                  state: "unknown",
                  message: "上次发送的回执尚未确认，请先检查回执，避免重复发送。",
                },
              );
          } catch {}
      }
      if (result.receipt) this.acceptReceipt(this.key(), result.receipt);
      const last = this.outgoing.get(this.key());
      if (last?.state === "unknown" && (!hadBinding || result.receiptMissing))
        void this.checkReceipt();
      if (last && ["submitted", "queued"].includes(last.state)) {
        if (this.draft.value === last.text) {
          this.draft.value = "";
          this.drafts.set(this.key(), "");
        }
        this.remember(this.key(), last);
      }
      this.composer();
      if (!older) this.revision = result.revision;
      if (!result.unchanged) {
        const wasEmpty = !this.nodes.size,
          follow =
            this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 100;
        // After a long absence, don't silently join two non-overlapping pages
        // and make an incomplete conversation look continuous.
        if (
          !older &&
          !wasEmpty &&
          result.messages.length &&
          !result.messages.some(
            (m) =>
              this.nodes.has(m.id) ||
              (m.provider === "claude" &&
                m.sourceId &&
                [...this.nodes.values()].some((n) => n.record?.sourceId === m.sourceId)),
          )
        ) {
          this.status.textContent = "期间有较多新消息，点上方「刷新」载入；当前阅读内容暂时保留。";
          this.active = false;
          this.runtime(null);
          return;
        }
        const anchor = [...this.messages.children].find(
          (n) => n.getBoundingClientRect().bottom > this.scroll.getBoundingClientRect().top,
        );
        const anchorTop = anchor?.getBoundingClientRect().top;
        const height = this.scroll.scrollHeight,
          top = this.scroll.scrollTop;
        let changed = false;
        for (const rawMessage of result.messages) {
          const message = this.mergeRecord(rawMessage);
          let node = this.nodes.get(message.id);
          if (!node) {
            node = document.createElement("article");
            node.dataset.id = message.id;
            this.nodes.set(message.id, node);
          }
          changed = this.render(message, node) || changed;
        }
        if (changed) this.layout();
        if (older || wasEmpty) this.before = result.before;
        this.older.classList.toggle("hidden", this.before === null);
        this.status.textContent =
          result.notice || (this.nodes.size ? "" : "暂时没有已保存的可显示消息，原终端仍可使用。");
        const last = this.messages.lastElementChild;
        if (last) {
          document.querySelector("#chatMeta").textContent =
            "最近保存 " + last.querySelector("time").textContent;
        }
        if (older) this.scroll.scrollTop = top + this.scroll.scrollHeight - height;
        else if (wasEmpty || follow) this.bottom();
        else if (changed) {
          if (anchor?.isConnected)
            this.scroll.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
          document.querySelector("#chatLatest").textContent = "↓ 有新内容";
        }
      } else if (this.nodes.size) this.status.textContent = "";
      if (this.readOnly) {
        this.questionToken = null;
        this.questionCard.classList.add("hidden");
        this.status.textContent = result.identityNotice || "当前对话尚未核实，暂时只能查看。";
      }
      this.layout();
      if (this.runBadge.dataset.state === "waiting") void this.loadQuestion();
    } catch (error) {
      if (serial === this.serial) {
        this.status.textContent = controller.signal.aborted
          ? "连接有些慢，稍后重试；状态会自动更新。"
          : error.message;
      }
    } finally {
      clearTimeout(timeout);
      if (serial === this.serial) {
        this.busy = false;
        this.older.disabled = false;
        if (this.active && !document.hidden) this.timer = setTimeout(() => this.load(), 4000);
      }
    }
  }
}
