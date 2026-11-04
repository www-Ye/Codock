/* Account selection is separate from site login and from model selection. */
window.DeskAccounts = class {
  constructor({ api, current, binding, onSwitch }) {
    Object.assign(this, { api, current, binding, onSwitch });
    this.items = [];
    this.scope = null;
    this.pending = false;
    this.sessionPending = false;
    this.completed = new Set();
    this.quotas = new Map();
    this.quotaNodes = new Map();
    this.quotaEpoch = 0;
    const el = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    };
    this.el = el;
    this.button = el("button", "系统账号", "quiet account-toggle");
    this.button.type = "button";
    this.button.title = "统一切换系统共享 Codex 账号";
    document.querySelector(".desk-menu-items").prepend(this.button);
    this.dialog = el("dialog", null, "accounts-dialog");
    this.dialog.setAttribute("aria-labelledby", "accountsTitle");
    const head = el("div", null, "accounts-heading"),
      title = el("h2", "系统 Codex 账号");
    title.id = "accountsTitle";
    const close = el("button", "×", "quiet");
    close.type = "button";
    close.setAttribute("aria-label", "关闭账号管理");
    close.onclick = () => this.dialog.close();
    head.append(title, close);
    this.note = el(
      "p",
      "一次选择，统一切换使用系统共享登录的 Codex 终端。保留原对话，不创建新窗口。",
      "micro",
    );
    this.status = el("p", null, "account-status");
    this.status.setAttribute("role", "status");
    this.cancel = el("button", "取消等待", "quiet");
    this.cancel.hidden = true;
    this.cancel.onclick = () => void this.cancelSwitch();
    this.list = el("div", null, "accounts-list");
    const quotaTools = el("div", null, "accounts-quota-tools");
    quotaTools.append(el("span", "自动更新 · 时间按此设备显示", "micro"));
    this.quotaRefresh = el("button", "刷新额度", "quiet");
    this.quotaRefresh.type = "button";
    this.quotaRefresh.onclick = () => void this.refreshQuotas(true);
    quotaTools.append(this.quotaRefresh);
    const form = el("form", null, "accounts-add");
    this.input = el("input");
    this.input.placeholder = "账号昵称，例如：主账号、研究";
    this.input.maxLength = 40;
    this.input.required = true;
    this.input.setAttribute("aria-label", "新账号昵称");
    this.add = el("button", "添加账号", "primary");
    this.add.type = "submit";
    form.append(this.input, this.add);
    form.onsubmit = async (e) => {
      e.preventDefault();
      this.add.disabled = true;
      try {
        const row = await api("/api/accounts", {
          method: "POST",
          body: JSON.stringify({ label: this.input.value }),
        });
        this.input.value = "";
        await this.refresh();
        await this.login(row.id);
      } catch (e) {
        this.status.textContent = e.message;
      } finally {
        this.add.disabled = false;
      }
    };
    const foot = el(
      "p",
      "等待正在运行的任务结束后切换，不强制停止。登录凭据仅保存在本机；独立 CODEX_HOME、API Key 和 Claude Code 不属于系统共享登录。",
      "micro",
    );
    this.dialog.append(
      head,
      this.note,
      this.status,
      this.cancel,
      quotaTools,
      this.list,
      form,
      foot,
    );
    document.body.append(this.dialog);
    this.button.onclick = () => {
      document.querySelector("#quotaMenu").open = false;
      document.querySelector("#deskMenu").open = false;
      this.dialog.showModal();
      void this.refresh();
      void this.refreshSession();
    };
    this.timer = setInterval(() => {
      if (document.hidden || document.querySelector("#app").classList.contains("hidden")) return;
      if (this.dialog.open) {
        void this.refresh();
        this.updateCountdowns();
      }
      if (
        this.waiting ||
        this.dialog.open ||
        (this.current() && Date.now() - (this.sessionChecked || 0) > 30000)
      )
        void this.refreshSession();
    }, 4000);
  }
  async refresh() {
    if (this.pending) return;
    this.pending = true;
    const epoch = this.quotaEpoch;
    try {
      const result = await this.api("/api/accounts", { signal: AbortSignal.timeout(20000) });
      if (epoch !== this.quotaEpoch) return;
      this.items = result.accounts.filter((row) => !row.builtin);
      this.render();
      void this.refreshQuotas();
    } catch (e) {
      if (epoch === this.quotaEpoch) this.status.textContent = e.message;
    } finally {
      this.pending = false;
    }
  }
  async refreshSession() {
    if (this.sessionPending) return;
    this.sessionPending = true;
    try {
      const value = await this.api("/api/accounts/system");
      this.sessionChecked = Date.now();
      this.scope = value;
      this.button.textContent = value.accountId ? value.label : "系统账号";
      this.button.title =
        "系统 Codex 账号：" + value.label + (value.emailHint ? " · " + value.emailHint : "");
      this.waiting = value.switch && ["waiting", "applying"].includes(value.switch.state);
      this.cancel.hidden = value.switch?.state !== "waiting";
      this.status.textContent =
        value.switch?.message || (value.emailHint ? "当前共享登录：" + value.emailHint : "");
      this.render();
      if (value.switch?.state === "complete" && !this.completed.has(value.switch.id)) {
        this.completed.add(value.switch.id);
        this.onSwitch(this.current());
      }
    } catch (e) {
      this.status.textContent = e.message;
    } finally {
      this.sessionPending = false;
    }
  }
  render() {
    if (!this.dialog.open) return;
    const renderKey = JSON.stringify([
      this.items,
      this.scope?.accountId,
      this.waiting,
      this.current()?.name,
    ]);
    if (this.renderKey === renderKey) return;
    this.renderKey = renderKey;
    this.list.replaceChildren();
    this.quotaNodes.clear();
    const labels = {
      ready: "已登录",
      signed_out: "未登录",
      unavailable: "后台暂未连接",
      unsupported: "不是 ChatGPT 登录",
    };
    for (const row of this.items) {
      const card = this.el("article", null, "account-card"),
        info = this.el("div"),
        name = this.el("strong", row.label),
        description = this.el("p", labels[row.state] + (row.plan ? " · " + row.plan : ""), "micro"),
        actions = this.el("div", null, "account-actions");
      info.append(name, description);
      card.append(info, actions);
      if (this.scope?.accountId === row.id)
        actions.append(this.el("span", "系统当前", "account-current"));
      else if (row.state === "ready" && !row.builtin) {
        const use = this.el("button", "系统使用", "quiet");
        use.disabled = Boolean(this.waiting);
        use.onclick = () => void this.use(row);
        actions.append(use);
      }
      if (row.builtin) description.textContent += " · 保留原登录；加入池中需另行添加";
      if (row.emailHint) description.textContent += " · " + row.emailHint;
      if (!row.builtin) {
        const rename = this.el("button", "改名", "quiet");
        rename.onclick = async () => {
          const label = prompt("账号昵称", row.label);
          if (label === null) return;
          try {
            await this.api("/api/accounts/" + row.id, {
              method: "PATCH",
              body: JSON.stringify({ label }),
            });
            await this.refresh();
            await this.refreshSession();
          } catch (e) {
            this.status.textContent = e.message;
          }
        };
        actions.append(rename);
        if (row.state === "signed_out" || row.login?.state === "failed") {
          const login = this.el("button", "登录", "quiet");
          login.onclick = () => void this.login(row.id);
          actions.append(login);
        }
      }
      if (row.login?.state === "pending") {
        const auth = this.el("div", null, "account-login");
        const link = this.el("a", "打开 OpenAI 授权 ↗");
        link.href = row.login.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const code = this.el("code", row.login.userCode),
          copy = this.el("button", "复制验证码", "quiet");
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(row.login.userCode);
            copy.textContent = "已复制";
          } catch {
            this.status.textContent = "请长按验证码复制";
          }
        };
        const cancel = this.el("button", "取消登录", "quiet");
        cancel.onclick = async () => {
          try {
            await this.api("/api/accounts/" + row.id + "/cancel", { method: "POST", body: "{}" });
            await this.refresh();
          } catch (e) {
            this.status.textContent = e.message;
          }
        };
        auth.append(link, code, copy, cancel);
        card.append(auth);
      }
      if (row.state === "ready") {
        const quota = this.el("section", null, "account-quota");
        quota.setAttribute("aria-label", row.label + " 额度与重置");
        this.quotaNodes.set(row.id, quota);
        card.append(quota);
        this.renderQuota(row.id);
      }
      this.list.append(card);
    }
  }
  async refreshQuotas(force = false) {
    if (this.quotaLoading || !this.dialog.open || document.hidden) return;
    const queue = this.items.filter(
      (row) =>
        row.state === "ready" && (force || Date.now() >= (this.quotas.get(row.id)?.nextRead || 0)),
    );
    if (!queue.length) return;
    this.quotaLoading = true;
    this.quotaRefresh.disabled = true;
    const epoch = this.quotaEpoch;
    try {
      await Promise.all(
        [0, 1].map(async () => {
          while (queue.length && epoch === this.quotaEpoch && this.dialog.open) {
            const row = queue.shift(),
              previous = this.quotas.get(row.id);
            try {
              const value = await this.api(
                "/api/account/quota?" + new URLSearchParams({ account: row.id }),
                { signal: AbortSignal.timeout(20000) },
              );
              if (epoch !== this.quotaEpoch) return;
              this.quotas.set(row.id, {
                value,
                nextRead: Date.now() + (value.stale ? 30000 : 60000),
              });
            } catch {
              if (epoch !== this.quotaEpoch) return;
              this.quotas.set(row.id, {
                value: previous?.value ? { ...previous.value, stale: true } : null,
                error: true,
                nextRead: Date.now() + 30000,
              });
            }
            this.renderQuota(row.id);
          }
        }),
      );
    } finally {
      this.quotaLoading = false;
      this.quotaRefresh.disabled = false;
    }
  }
  renderQuota(id) {
    const host = this.quotaNodes.get(id);
    if (!host) return;
    host.replaceChildren();
    const cached = this.quotas.get(id),
      q = cached?.value;
    if (!q?.buckets?.length) {
      host.append(
        this.el(
          "p",
          cached?.error || q?.stale
            ? "额度暂时读不到，稍后自动重试"
            : q
              ? "该账号尚未返回额度"
              : "正在读取额度…",
          "micro",
        ),
      );
      return;
    }
    const buckets = q.buckets
      .slice()
      .sort((a, b) => Number(b.id === "codex") - Number(a.id === "codex"));
    let extra;
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      let target = host;
      if (i > 0) {
        if (!extra) {
          extra = this.el("details", null, "account-quota-extra");
          extra.append(this.el("summary", "其他额度"));
          host.append(extra);
        }
        target = extra;
      }
      if (bucket.id !== "codex") target.append(this.el("p", bucket.name || bucket.id, "micro"));
      for (const w of bucket.windows) {
        const row = this.el("div", null, "account-quota-window"),
          top = this.el("div", null, "account-quota-line");
        const period =
          w.durationMins % 1440 === 0
            ? w.durationMins / 1440 + " 天"
            : w.durationMins % 60 === 0
              ? w.durationMins / 60 + " 小时"
              : w.durationMins + " 分钟";
        const remaining = this.el("strong", "剩余 " + w.remainingPercent + "%");
        remaining.classList.toggle("quota-empty", w.remainingPercent === 0);
        top.append(this.el("span", period + "额度"), remaining);
        row.append(top);
        const when = this.el("span", null, "account-quota-countdown micro");
        if (Number.isFinite(w.resetsAt) && w.resetsAt > 0)
          when.dataset.resetAt = String(w.resetsAt);
        this.updateCountdown(when);
        row.append(when);
        target.append(row);
      }
    }
    if (q.stale) {
      host.append(
        this.el(
          "p",
          "上次数据" +
            (q.checkedAt
              ? " · " +
                new Date(q.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : "") +
            "，正在等待更新",
          "micro account-quota-stale",
        ),
      );
    }
  }
  updateCountdown(node) {
    const reset = Number(node.dataset.resetAt);
    if (!Number.isFinite(reset) || reset <= 0) {
      node.textContent = "未提供重置时间";
      return;
    }
    const minutes = Math.ceil((reset - Date.now()) / 60000),
      days = Math.floor(minutes / 1440),
      hours = Math.floor((minutes % 1440) / 60),
      mins = minutes % 60;
    const absolute = new Date(reset).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    node.textContent =
      (minutes <= 0
        ? "重置时间已到，等待额度更新"
        : (days ? days + "天 " : "") +
          (hours ? hours + "小时 " : "") +
          (mins ? mins + "分钟" : "") +
          "后重置") +
      " · " +
      absolute;
  }
  updateCountdowns() {
    for (const node of this.list.querySelectorAll(".account-quota-countdown"))
      this.updateCountdown(node);
  }
  reset() {
    this.quotaEpoch++;
    this.dialog.close();
    this.quotas.clear();
    this.quotaNodes.clear();
    this.items = [];
    this.list.replaceChildren();
    this.renderKey = null;
  }
  async login(id) {
    this.status.textContent = "正在获取 OpenAI 登录验证码…";
    try {
      await this.api("/api/accounts/" + id + "/login", {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(30000),
      });
      this.status.textContent = "打开授权页面，输入下方验证码；完成后这里会自动更新。";
      await this.refresh();
    } catch (e) {
      this.status.textContent = e.message;
    }
  }
  async use(row) {
    if (
      !confirm(
        `将系统共享 Codex 账号统一切换到「${row.label}」？\n影响共用系统登录的终端和 IDE。等待当前任务结束，不复制对话、不创建窗口、不强制停止任务。`,
      )
    )
      return;
    try {
      await this.api("/api/accounts/system", {
        method: "POST",
        body: JSON.stringify({
          scope: "system",
          accountId: row.id,
          requestId: crypto.randomUUID(),
          confirm: true,
        }),
      });
      this.waiting = true;
      await this.refreshSession();
    } catch (e) {
      this.status.textContent = e.message;
    }
  }
  async cancelSwitch() {
    if (!this.scope?.switch) return;
    try {
      await this.api("/api/accounts/system", {
        method: "DELETE",
        body: JSON.stringify({ requestId: this.scope.switch.id }),
      });
      await this.refreshSession();
    } catch (e) {
      this.status.textContent = e.message;
    }
  }
};
