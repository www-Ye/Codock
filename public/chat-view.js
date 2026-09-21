/* Browser-owned dictation, explicit opt-in. Never sends a chat or records audio here. */
class DeskDictation {
  constructor(chat) {
    this.chat = chat;
    this.button = document.querySelector("#chatVoice");
    this.panel = document.querySelector("#voicePanel");
    this.status = document.querySelector("#voiceStatus");
    this.startButton = document.querySelector("#voiceStart");
    this.lang = document.querySelector("#voiceLang");
    this.consented = false;
    this.button.onclick = () => {
      if (this.recognition) {
        this.finish();
        return;
      }
      if (!this.panel.classList.contains("hidden")) {
        this.close();
        return;
      }
      this.show();
      if (this.consented) this.start();
    };
    this.startButton.onclick = () => (this.recognition ? this.finish() : this.start());
    document.querySelector("#voiceClose").onclick = () => {
      this.close();
      this.button.focus();
    };
    this.panel.onkeydown = (e) => {
      if (e.key === "Escape") {
        this.close();
        this.button.focus();
      }
    };
  }
  supported() {
    return window.SpeechRecognition || window.webkitSpeechRecognition;
  }
  show() {
    this.panel.classList.remove("hidden");
    this.button.setAttribute("aria-expanded", "true");
    const supported = Boolean(this.supported());
    this.startButton.classList.toggle("hidden", !supported);
    this.lang.classList.toggle("hidden", !supported);
    this.status.textContent = supported
      ? "浏览器可能将语音交给其联网识别服务处理；仅转成草稿，不自动发送。"
      : "此浏览器不支持网页听写。点输入框，使用手机键盘上的麦克风即可。";
  }
  cancel() {
    const recognition = this.recognition;
    this.recognition = null;
    clearTimeout(this.timeout);
    clearTimeout(this.finishTimeout);
    this.timeout = null;
    this.finishTimeout = null;
    if (recognition) {
      try {
        recognition.abort();
      } catch {}
      this.status.textContent = "听写已停止，已有草稿保留。";
    }
    this.button.classList.remove("listening");
    this.button.setAttribute("aria-label", "语音输入");
    this.button.title = "语音输入";
    this.startButton.textContent = "开始听写";
    this.lang.disabled = false;
  }
  close() {
    this.cancel();
    this.panel.classList.add("hidden");
    this.button.setAttribute("aria-expanded", "false");
  }
  finish() {
    if (!this.recognition || this.finishTimeout) return;
    const recognition = this.recognition;
    this.status.textContent = "正在整理听写…";
    try {
      recognition.stop();
    } catch {
      this.cancel();
      return;
    }
    if (this.recognition !== recognition) return;
    this.finishTimeout = setTimeout(() => {
      this.cancel();
      this.status.textContent = "识别没有及时返回，可重试或用键盘语音输入。";
    }, 5000);
  }
  start() {
    const key = this.chat.key(),
      draft = this.chat.draft,
      Recognition = this.supported();
    if (!key || draft.disabled || !Recognition || this.recognition) return;
    this.show();
    this.consented = true;
    const before = draft.value,
      start = draft.selectionStart,
      end = draft.selectionEnd;
    let recognition;
    try {
      recognition = new Recognition();
    } catch {
      this.status.textContent = "浏览器听写不可用，请使用手机键盘的麦克风。";
      return;
    }
    this.recognition = recognition;
    recognition.lang = this.lang.value;
    recognition.continuous = false;
    recognition.interimResults = false;
    const current = () =>
      this.recognition === recognition &&
      this.chat.key() === key &&
      this.chat.active &&
      !document.hidden;
    this.button.classList.add("listening");
    this.button.setAttribute("aria-label", "结束听写");
    this.button.title = "结束听写";
    this.startButton.textContent = "结束听写";
    this.lang.disabled = true;
    this.status.textContent = "正在连接麦克风…";
    recognition.onstart = () => {
      if (current()) this.status.textContent = "正在听写…说完后点「结束听写」。";
    };
    recognition.onresult = (event) => {
      if (!current()) return;
      if (draft.disabled || draft.value !== before) {
        this.cancel();
        return;
      }
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++)
        if (event.results[i].isFinal) text += event.results[i][0].transcript;
      if (!text) return;
      const next = before.slice(0, start) + text + before.slice(end);
      this.cancel();
      if (next.length > 4000 || new TextEncoder().encode(next).length > 12000) {
        this.status.textContent = "听写内容太长，未改动草稿。请分段听写。";
        return;
      }
      draft.value = next;
      draft.setSelectionRange(start + text.length, start + text.length);
      this.chat.drafts.set(key, next);
      this.chat.resizeDraft();
      this.close();
    };
    recognition.onerror = (event) => {
      if (!current()) return;
      this.cancel();
      this.status.textContent =
        {
          "not-allowed": "麦克风权限未获允许，可在浏览器设置中开启，或使用键盘语音输入。",
          "service-not-allowed": "浏览器未开放听写服务，请使用键盘语音输入。",
          "audio-capture": "没有可用的麦克风，请检查设备或使用键盘输入。",
          "no-speech": "没有听清，可以再试一次。",
          network: "语音识别服务暂时连不上，请使用手机键盘的麦克风。",
        }[event.error] || "听写暂时不可用，草稿保留。可使用手机键盘的麦克风。";
    };
    recognition.onend = () => {
      if (current()) {
        this.cancel();
        this.status.textContent = "本次没有识别到文字，可以重试或用键盘语音输入。";
      }
    };
    this.timeout = setTimeout(() => this.finish(), 45000);
    try {
      recognition.start();
    } catch {
      this.cancel();
      this.status.textContent = "浏览器听写未能启动，请使用键盘语音输入。";
    }
  }
}

/* Saved history + literal text and Enter in the original terminal. */
class DeskChat {
  constructor({ request, send, receipt, dismiss, onRuntime = () => {} }) {
    this.request = request;
    this.send = send;
    this.receipt = receipt;
    this.dismiss = dismiss;
    this.nodes = new Map();
    this.serial = 0;
    this.active = false;
    this.dismissed = new Set();
    this.drafts = new Map();
    this.outgoing = new Map();
    this.groups = new Map();
    this.sent = new Map();
    this.failedExpanded = new Set();
    this.onRuntime = onRuntime;
    this.runBadge = document.querySelector("#chatRunStatus");
    this.runLabel = document.querySelector("#chatRunLabel");
    this.runBadge.onclick = () => {
      if (this.runBadge.dataset.state === "waiting")
        document.querySelector("#chatTerminal").click();
    };
    this.scroll = document.querySelector("#chatScroll");
    this.messages = document.querySelector("#chatMessages");
    this.status = document.querySelector("#chatStatus");
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
    document.querySelector("#chatRefresh").onclick = () => this.open(this.item);
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
    this.runBadge.dataset.state = state;
    window.CodockTheme?.status(state);
    if (this.runLabel.textContent !== labels[state]) this.runLabel.textContent = labels[state];
    this.runBadge.title =
      state === "unknown"
        ? "当前状态未能确认，可打开原终端查看。"
        : "根据原终端当前界面提示判断，约每 4 秒更新；不是消息发送回执。";
    this.runBadge.setAttribute("aria-label", labels[state]);
    document.querySelector("#chatAttention").classList.toggle("hidden", state !== "waiting");
    if (this.item) this.onRuntime(this.item, { state, source: "terminal-hint" });
    if (state !== "unknown") this.runExpiry = setTimeout(() => this.runtime(null), 15000);
  }
  key() {
    return this.item && this.binding
      ? this.item.name + ":" + this.item.identity + ":" + this.binding
      : null;
  }
  remember(key, out) {
    try {
      if (["submitted", "queued", "failed"].includes(out.state))
        sessionStorage.removeItem("workbench.chat.receipt." + key);
      else sessionStorage.setItem("workbench.chat.receipt." + key, out.requestId);
    } catch {}
  }
  acceptReceipt(key, value) {
    for (const out of new Set([this.outgoing.get(key), this.sent.get(key)?.get(value.requestId)])) {
      if (!out || out.requestId !== value.requestId || (out.observed && !value.observed)) continue;
      Object.assign(out, value, { onServer: true });
    }
  }
  reset() {
    this.clear();
    this.drafts.clear();
    this.outgoing.clear();
    this.sent.clear();
    this.voice.consented = false;
  }
  resizeDraft() {
    this.draft.style.height = "auto";
    this.draft.style.height = Math.min(120, this.draft.scrollHeight) + "px";
  }
  composer() {
    const key = this.key(),
      out = this.outgoing.get(key),
      blocked = out && ["sending", "unknown"].includes(out.state);
    this.draft.disabled = !key || Boolean(blocked);
    this.sendButton.disabled = !key || Boolean(blocked);
    this.sendButton.textContent = out?.state === "sending" ? "发送中…" : "发送 ↑";
    this.sendStatus.textContent = ["failed", "unknown"].includes(out?.state)
      ? out.message || "发送未完成，请检查回执。"
      : "";
    this.receiptButton.classList.toggle("hidden", out?.state !== "unknown");
    this.voice.button.disabled = this.draft.disabled;
    this.voice.startButton.disabled = this.draft.disabled;
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
      if (["submitted", "queued"].includes(out.state)) this.drafts.set(key, "");
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
      out = this.outgoing.get(key);
    if (!out || !this.item) return;
    this.receiptButton.disabled = true;
    try {
      this.acceptReceipt(key, await this.receipt(this.item, out.requestId));
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
      this.receiptButton.disabled = false;
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
  }
  clear() {
    this.stop();
    this.item = null;
    this.binding = null;
    this.layoutKey = null;
    this.nodes.clear();
    this.groups.clear();
    this.messages.replaceChildren();
    this.draft.value = "";
    this.composer();
  }
  open(item) {
    this.clear();
    if (!item) return;
    this.item = item;
    this.active = true;
    this.binding = null;
    this.revision = null;
    this.before = null;
    this.status.textContent = "正在读取原会话的对话…";
    this.older.classList.add("hidden");
    document.querySelector("#chatMeta").textContent = "原来的对话，换一种看法";
    document.querySelector("#chatPreview").classList.toggle("hidden", !item.preview);
    void this.load();
  }
  bottom() {
    this.scroll.scrollTop = this.scroll.scrollHeight;
    document.querySelector("#chatLatest").textContent = "↓ 最新";
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
      message.role === "user" ? "你" : message.phase === "commentary" ? "Codex · 进展" : "Codex";
    const avatar = document.createElement("span");
    avatar.className = "chat-avatar";
    avatar.textContent = message.role === "user" ? "你" : "C";
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
      note.textContent = "这条消息较长，此处显示前 32,000 字符；完整内容请在原终端查看。";
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
          failed: "未发送",
          queued: "旧版排队消息",
        }[out.state] || "送达待核对";
      node.querySelector(".chat-message-head").append(status);
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
      } else fragment.append(node);
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
        this.status.textContent = result.message;
        this.active = false;
        this.binding = null;
        this.composer();
        this.sendStatus.textContent = "原会话暂时无法确认，请刷新聊天或打开原终端。";
        return;
      }
      const hadBinding = this.binding;
      this.binding = result.binding;
      const receipts = this.sent.get(this.key()) || new Map();
      const visible = new Set((result.outbox || []).map((o) => o.requestId));
      // Reconcile removals made on another device, but not a new failure that
      // happened while this read was in flight.
      for (const id of failedBefore)
        if (!visible.has(id) && receipts.get(id)?.state === "failed") {
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
            const requestId = sessionStorage.getItem("workbench.chat.receipt." + key);
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
          !result.messages.some((m) => this.nodes.has(m.id))
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
        for (const message of result.messages) {
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
      this.layout();
    } catch (error) {
      if (serial === this.serial) {
        this.runtime(null);
        this.status.textContent = controller.signal.aborted
          ? "连接有些慢，稍后重试；当前状态暂时无法确认。"
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
