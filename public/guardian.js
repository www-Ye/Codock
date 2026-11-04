window.DeskGuardian = class {
  constructor({ api, notify = () => {} }) {
    Object.assign(this, {
      api,
      notify,
      seen: new Set(),
      loaded: false,
      epoch: 0,
      limit: 30,
      follow: true,
    });
    const el = (this.el = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    });
    this.button = el("button", "管家", "quiet guardian-toggle");
    this.button.type = "button";
    this.button.title = "后台任务与提醒";
    document.querySelector("#quotaMenu").before(this.button);
    this.dialog = el("dialog", null, "guardian-dialog");
    this.dialog.setAttribute("aria-label", "Codock 管家");
    const head = el("header", null, "guardian-head"),
      close = el("button", "×", "quiet");
    close.setAttribute("aria-label", "关闭管家");
    close.onclick = () => this.dialog.close();
    head.append(el("h2", "Codock 管家"), close);
    this.tabs = el("nav", null, "guardian-tabs");
    this.tabs.setAttribute("aria-label", "管家页面");
    this.panels = {};
    this.tabButtons = {};
    for (const [key, label] of [
      ["chat", "对话"],
      ["tasks", "关注"],
      ["events", "提醒"],
    ]) {
      const button = (this.tabButtons[key] = el("button", label, "quiet"));
      button.type = "button";
      button.dataset.guardianTab = key;
      button.onclick = () => this.select(key);
      this.tabs.append(button);
      const panel = (this.panels[key] = el(
        "section",
        null,
        "guardian-panel guardian-" + key + "-panel",
      ));
      panel.id = "guardian-" + key;
      button.setAttribute("aria-controls", panel.id);
      panel.setAttribute("aria-label", label);
    }
    this.status = el("p", null, "guardian-status micro");
    this.status.setAttribute("role", "status");
    this.messages = el("div", null, "guardian-messages");
    this.messages.addEventListener("scroll", () => {
      if (!this.panels.chat.hidden)
        this.follow =
          this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 70;
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.follow && !this.panels.chat.hidden)
        this.messages.scrollTop = this.messages.scrollHeight;
    });
    this.resizeObserver.observe(this.messages);
    this.compose = el("form", null, "guardian-compose");
    this.draft = el("textarea");
    this.draft.rows = 1;
    this.draft.maxLength = 4000;
    this.draft.placeholder = "对管家说…";
    this.draft.setAttribute("aria-label", "给管家的消息");
    this.send = el("button", "发送", "primary");
    this.stop = el("button", "停止回复", "quiet");
    this.stop.type = "button";
    this.stop.hidden = true;
    this.stop.onclick = () => void this.action("/api/guardian/chat", {}, "DELETE");
    this.compose.append(this.draft, this.send, this.stop);
    this.panels.chat.append(this.messages, this.compose);
    this.compose.onsubmit = async (e) => {
      e.preventDefault();
      const text = this.draft.value.trim();
      if (!text || this.sending || this.value?.busy) return;
      this.sending = true;
      this.send.disabled = true;
      try {
        if (await this.action("/api/guardian/chat", { text, requestId: crypto.randomUUID() }))
          this.draft.value = "";
      } finally {
        this.sending = false;
        this.send.disabled = Boolean(this.value?.busy);
      }
    };
    const taskTools = el("div", null, "guardian-tools");
    this.monitorStatus = el("span", "正在读取监控状态…", "micro");
    taskTools.append(this.monitorStatus);
    this.pauseAll = el("button", "暂停全部", "quiet");
    this.pauseAll.onclick = () => void this.action("/api/guardian", { pauseAll: true }, "PATCH");
    taskTools.append(this.pauseAll);
    this.tasks = el("div", null, "guardian-tasks");
    const fold = (label, cls) => {
      const details = el("details", null, "guardian-fold"),
        summary = el("summary", label),
        list = el("div", null, cls);
      details.append(summary, list);
      return { details, summary, list };
    };
    this.inactive = fold("已完成与已暂停", "guardian-tasks");
    this.archived = fold("已移除", "guardian-tasks");
    this.panels.tasks.append(taskTools, this.tasks, this.inactive.details, this.archived.details);
    const eventTools = el("div", null, "guardian-tools");
    eventTools.append(el("span", "重要成果与待处理事项", "micro"));
    this.read = el("button", "全部已读", "quiet");
    this.read.onclick = () => void this.action("/api/guardian", { readAll: true }, "PATCH");
    eventTools.append(this.read);
    this.events = el("div", null, "guardian-events");
    this.pastEvents = fold("较早提醒", "guardian-events");
    this.panels.events.append(eventTools, this.events, this.pastEvents.details);
    this.dialog.append(head, this.tabs, this.status, ...Object.values(this.panels));
    document.body.append(this.dialog);
    this.select("chat");
    this.button.onclick = () => {
      document.querySelector("#deskMenu").open = false;
      document.querySelector("#quotaMenu").open = false;
      this.dialog.showModal();
      if (this.value) this.render(this.value);
      void this.refresh();
    };
    this.timer = setInterval(() => {
      if (!document.hidden && !document.querySelector("#app").classList.contains("hidden"))
        void this.refresh();
    }, 5000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !document.querySelector("#app").classList.contains("hidden"))
        void this.refresh();
    });
  }
  select(key) {
    for (const [name, panel] of Object.entries(this.panels)) {
      panel.hidden = name !== key;
      this.tabButtons[name].setAttribute("aria-pressed", String(name === key));
    }
    if (key === "chat") {
      this.follow = true;
      requestAnimationFrame(() => {
        this.messages.scrollTop = this.messages.scrollHeight;
      });
    }
  }
  async action(url, body, method = "POST") {
    try {
      const value = await this.api(url, { method, body: JSON.stringify(body) });
      this.epoch++;
      this.render(value);
      return true;
    } catch (e) {
      this.status.textContent = e.message;
      return false;
    }
  }
  async refresh() {
    if (this.pending) return;
    this.pending = true;
    const epoch = this.epoch;
    if (location.hash === "#guardian" && !this.autoOpened) {
      this.autoOpened = true;
      this.button.click();
    }
    try {
      const value = await this.api("/api/guardian");
      if (epoch === this.epoch) this.render(value);
    } catch (e) {
      this.status.textContent = "暂时连接不上：" + e.message;
    } finally {
      this.pending = false;
    }
  }
  taskCard(t) {
    const el = this.el,
      card = el("article", null, "guardian-task"),
      top = el("div", null, "guardian-task-head"),
      link = el("a", t.title);
    card.dataset.taskId = t.id;
    link.href = "/s/" + encodeURIComponent(t.session);
    link.title = t.title;
    top.append(link);
    card.append(top);
    if (t.archived) {
      const restore = el("button", "恢复关注", "quiet");
      restore.onclick = () =>
        void this.action("/api/guardian", { id: t.id, archived: false, enabled: true }, "PATCH");
      top.append(restore);
      return card;
    }
    const labels = {
        running: "进行中",
        completed: "已完成",
        failed: "失败",
        attention: "需留意",
        stalled: "来源未更新",
        unavailable: "暂时读不到",
        waiting: "等待前序",
        observing: "关注动态",
      },
      s = t.snapshot;
    const remove = el("button", "×", "quiet guardian-remove");
    remove.setAttribute("aria-label", "移除关注 " + t.title);
    remove.title = "移除关注，不停止原任务";
    remove.onclick = () => void this.action("/api/guardian", { id: t.id, archived: true }, "PATCH");
    top.append(remove);
    const meta = el("div", null, "guardian-task-meta");
    meta.append(
      el(
        "span",
        t.session + " · " + (t.enabled ? labels[s?.state] || "读取中" : "已暂停"),
        "micro",
      ),
    );
    if (s?.done != null && s.total != null)
      meta.append(el("span", s.done + " / " + s.total, "micro"));
    card.append(meta);
    if (s?.percent != null) {
      const bar = el("progress");
      bar.max = 100;
      bar.value = s.percent;
      bar.setAttribute("aria-label", "任务进度 " + s.percent + "%");
      card.append(bar);
    }
    const bottom = el("div", null, "guardian-task-bottom"),
      detail = el("details", null, "guardian-task-detail");
    detail.append(el("summary", "详情"));
    if (s?.message) detail.append(el("p", s.message, "micro"));
    if (s?.remainingHours != null)
      detail.append(el("p", "预计剩余 " + s.remainingHours.toFixed(1) + " 小时", "micro"));
    if (s?.parts?.length) {
      const parts = el("div", null, "guardian-parts");
      for (const p of s.parts) {
        const row = el("p", null, "micro");
        row.append(
          el("span", p.label),
          el(
            "span",
            p.done != null && p.total != null
              ? p.done + " / " + p.total + (p.failures ? " · " + p.failures + " 异常" : "")
              : "暂时读不到",
          ),
        );
        parts.append(row);
      }
      detail.append(parts);
    }
    detail.append(
      el(
        "p",
        s?.updatedAt ? "来源更新于 " + new Date(s.updatedAt).toLocaleString() : "等待进度来源",
        "micro",
      ),
    );
    const toggle = el("button", t.enabled ? "暂停关注" : "继续关注", "quiet");
    toggle.onclick = () =>
      void this.action("/api/guardian", { id: t.id, enabled: !t.enabled }, "PATCH");
    bottom.append(detail, toggle);
    card.append(bottom);
    return card;
  }
  eventCard(e) {
    const card = this.el("article", null, "guardian-event" + (e.read ? "" : " unread"));
    card.append(this.el("p", e.text), this.el("small", new Date(e.time).toLocaleString(), "micro"));
    const link = this.el("a", "查看 " + e.session);
    link.href = "/s/" + encodeURIComponent(e.session);
    card.append(link);
    if (!e.read) {
      const read = this.el("button", "已读", "quiet");
      read.onclick = () => void this.action("/api/guardian", { eventId: e.id }, "PATCH");
      card.append(read);
    }
    return card;
  }
  handlesNotifications(session) {
    return (
      this.value?.tasks.some((t) => t.session === session && t.enabled && !t.archived) === true
    );
  }
  render(v) {
    this.value = v;
    const unread = v.events.filter((e) => !e.read),
      fresh = unread.filter((e) => !this.seen.has(e.id));
    for (const e of v.events) this.seen.add(e.id);
    this.button.classList.toggle("has-unread", unread.length > 0);
    this.button.setAttribute(
      "aria-label",
      "管家" + (unread.length ? "，" + unread.length + " 条未读提醒" : ""),
    );
    if (this.loaded && fresh.length && !document.hidden) {
      this.notify(fresh.length === 1 ? fresh[0].text : "管家收到 " + fresh.length + " 条提醒");
      try {
        navigator.vibrate?.([180, 80, 180]);
      } catch {}
    }
    this.loaded = true;
    if (!this.dialog.open) return;
    this.monitorStatus.textContent = v.checkedAt
      ? "已检查 " + new Date(v.checkedAt).toLocaleTimeString() + " · 每 30 秒更新"
      : "正在读取监控状态…";
    this.status.textContent = v.busy ? "管家正在回复…" : "";
    this.send.disabled = v.busy || this.sending;
    this.send.hidden = v.busy;
    this.stop.hidden = !v.busy;
    const active = v.tasks.filter(
      (t) => !t.archived && t.enabled && !["completed", "failed"].includes(t.snapshot?.state),
    );
    const inactive = v.tasks.filter((t) => !t.archived && !active.includes(t)),
      archived = v.tasks.filter((t) => t.archived);
    this.tabButtons.tasks.textContent = "关注" + (active.length ? " · " + active.length : "");
    this.tabButtons.events.textContent = "提醒" + (unread.length ? " · " + unread.length : "");
    this.pauseAll.disabled = !v.tasks.some((t) => !t.archived && t.enabled);
    this.read.disabled = !unread.length;
    const taskKey = JSON.stringify(v.tasks, (k, val) => (k === "checkedAt" ? undefined : val));
    if (this.taskKey !== taskKey) {
      this.taskKey = taskKey;
      const opened = new Set(
        [...this.panels.tasks.querySelectorAll(".guardian-task-detail[open]")].map(
          (el) => el.closest("[data-task-id]").dataset.taskId,
        ),
      );
      this.tasks.replaceChildren(...active.map((t) => this.taskCard(t)));
      if (!active.length)
        this.tasks.append(
          this.el("p", "暂无正在关注的任务，直接在对话里告诉我。", "guardian-empty micro"),
        );
      for (const [fold, rows, label] of [
        [this.inactive, inactive, "已完成与已暂停"],
        [this.archived, archived, "已移除"],
      ]) {
        fold.details.hidden = !rows.length;
        fold.summary.textContent = label + " · " + rows.length;
        fold.list.replaceChildren(...rows.map((t) => this.taskCard(t)));
      }
      for (const detail of this.panels.tasks.querySelectorAll(".guardian-task-detail"))
        if (opened.has(detail.closest("[data-task-id]").dataset.taskId)) detail.open = true;
    }
    const eventKey = JSON.stringify(v.events);
    if (this.eventKey !== eventKey) {
      this.eventKey = eventKey;
      this.events.replaceChildren(
        ...unread
          .slice()
          .reverse()
          .map((e) => this.eventCard(e)),
      );
      if (!unread.length) this.events.append(this.el("p", "没有新提醒。", "guardian-empty micro"));
      const older = v.events.filter((e) => e.read);
      this.pastEvents.details.hidden = !older.length;
      this.pastEvents.summary.textContent = "较早提醒 · " + older.length;
      this.pastEvents.list.replaceChildren(
        ...older
          .slice(-20)
          .reverse()
          .map((e) => this.eventCard(e)),
      );
    }
    this.renderMessages(v.messages);
  }
  renderMessages(messages) {
    const key = JSON.stringify([messages, this.limit]);
    if (this.messageKey === key) return;
    const bottom =
      !this.messageKey ||
      this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 70;
    this.messageKey = key;
    this.messages.replaceChildren();
    if (messages.length > this.limit) {
      const older = this.el("button", "更早对话", "quiet");
      older.onclick = () => {
        const h = this.messages.scrollHeight,
          y = this.messages.scrollTop;
        this.limit += 30;
        this.renderMessages(messages);
        this.messages.scrollTop = y + this.messages.scrollHeight - h;
      };
      this.messages.append(older);
    }
    if (!messages.length)
      this.messages.append(
        this.el(
          "p",
          "告诉我要关注什么，例如“盯一下 eval 的评测”。也可以直接说暂停或取消关注。",
          "guardian-empty micro",
        ),
      );
    for (const m of messages.slice(-this.limit)) {
      const article = this.el("article", null, "guardian-message " + m.role),
        content = this.el("div");
      if (m.role === "assistant") renderMarkdown(content, m.text);
      else content.textContent = m.text;
      article.append(
        this.el(
          "small",
          m.role === "user" ? "你" : m.role === "assistant" ? "Codock 管家" : "动态",
          "micro",
        ),
        content,
      );
      this.messages.append(article);
    }
    if (bottom) this.messages.scrollTop = this.messages.scrollHeight;
  }
  reset() {
    this.epoch++;
    this.dialog.close();
    this.seen.clear();
    this.loaded = false;
    this.value = null;
    this.taskKey = this.eventKey = this.messageKey = null;
    this.limit = 30;
    for (const list of [
      this.tasks,
      this.inactive.list,
      this.archived.list,
      this.events,
      this.pastEvents.list,
      this.messages,
    ])
      list.replaceChildren();
    this.draft.value = "";
    this.button.classList.remove("has-unread");
  }
};
