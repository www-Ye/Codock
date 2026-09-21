const $ = (s) => document.querySelector(s),
  all = (s) => [...document.querySelectorAll(s)];
let chatEnabled = true;
let sessions = [],
  current = null,
  terminal = null,
  socket = null,
  write = false,
  generation = 0,
  retryTimer,
  toastTimer;
let connectionReady = false,
  operationBusy = false,
  writeWaiter = null,
  fontSize = 13,
  followOutput = true;
window.addEventListener("codock-theme", () => {
  if (terminal) terminal.options.theme = window.CodockTheme.terminal();
});
const inputConsent = new Set();
let terminalScriptPromise = null,
  terminalLoading = false;
function ensureTerminal() {
  if (window.Terminal) return Promise.resolve();
  if (terminalScriptPromise) return terminalScriptPromise;
  terminalScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/xterm.js";
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) {
        script.remove();
        terminalScriptPromise = null;
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(
      () => finish(Error("终端组件加载超时，点击重连可重试；预览仍可使用。")),
      12000,
    );
    script.onload = () => finish(window.Terminal ? null : Error("终端组件没有载入，请重连重试。"));
    script.onerror = () => finish(Error("终端组件未能下载，点击重连可重试。"));
    document.head.append(script);
  });
  return terminalScriptPromise;
}
let composing = false,
  lastActivity = 0,
  historyPending = null,
  historyPage = null,
  historyTimer,
  historyVisible = false;
let historyTouching = false,
  historyBuffered = null,
  historyInitialOffset = 0,
  historyLoadFailed = false;

function sessionKey() {
  return current ? current.name + ":" + current.identity : null;
}
function note(text) {
  $("#terminalNote").textContent = text;
}
function updateControls() {
  const connected = connectionReady && socket?.readyState === 1;
  $("#focusTerminal").disabled = !connected || operationBusy;
  $("#showHistory").disabled = !connected;
  $("#focusTerminal").classList.toggle(
    "active",
    Boolean(write && terminal?.textarea === document.activeElement),
  );
  all("[data-key]").forEach((b) => (b.disabled = !connected || operationBusy || historyVisible));
  $("#showHistory").classList.toggle("active", historyVisible);
  $("#writeMode").disabled = !connected || operationBusy;
  $("#chatStopTurn").disabled = !connected || operationBusy || historyVisible;
}
function rejectWrite(message) {
  if (writeWaiter) {
    const waiter = writeWaiter;
    writeWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(Error(message));
  }
}
async function ensureWrite() {
  if (!connectionReady || socket?.readyState !== 1) throw Error("终端尚未连接，请连接后输入。");
  if (write) return;
  const key = sessionKey(),
    ws = socket;
  if (!inputConsent.has(key)) {
    if (!confirm("允许向 " + current.label + " 的原始终端输入？操作沿用服务器权限，不会新建会话。"))
      throw Error("已取消，内容未发送。");
    inputConsent.add(key);
  }
  note("正在连接输入…");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (writeWaiter?.timer === timer) writeWaiter = null;
      reject(Error("切换输入超时，请重连后检查。"));
    }, 7000);
    writeWaiter = { resolve, reject, timer };
    ws.send(JSON.stringify({ type: "write" }));
  });
  if (ws !== socket || key !== sessionKey() || !write) throw Error("会话已切换，内容未发送。");
}
async function performInput(action) {
  if (operationBusy) return;
  operationBusy = true;
  updateControls();
  const key = sessionKey(),
    ws = socket;
  try {
    await ensureWrite();
    if (key !== sessionKey() || ws !== socket) throw Error("会话已切换，内容未发送。");
    action();
  } catch (e) {
    note(e.message);
    toast(e.message);
  } finally {
    operationBusy = false;
    updateControls();
  }
}
function jumpLatest() {
  if (historyVisible) closeHistory();
  followOutput = true;
  terminal?.scrollToBottom();
  const view = $("#terminalScroll");
  view.scrollTop = view.scrollHeight;
  $("#latest").classList.remove("unread");
}
function receivedOutput() {
  if (historyVisible) {
    $("#latest").classList.add("unread");
    return;
  }
  if (followOutput) jumpLatest();
  else $("#latest").classList.add("unread");
}
function controlSequence(name) {
  if (name === "shift-left") return "\x1b[1;2D";
  const arrows = { up: "A", down: "B", right: "C", left: "D" };
  if (arrows[name])
    return "\x1b" + (terminal?.modes.applicationCursorKeysMode ? "O" : "[") + arrows[name];
  return {
    escape: "\x1b",
    tab: "\t",
    "shift-tab": "\x1b[Z",
    enter: "\r",
    backspace: "\x7f",
    home: "\x1b[H",
    end: "\x1b[F",
    delete: "\x1b[3~",
    "page-up": "\x1b[5~",
    "page-down": "\x1b[6~",
    "ctrl-c": "\x03",
    "ctrl-a": "\x01",
    "ctrl-e": "\x05",
    "ctrl-l": "\x0c",
    "ctrl-b": "\x02",
  }[name];
}
function sendKey(name) {
  if (historyVisible) return;
  if (composing) {
    toast("请先在输入法中确认候选文字，再按终端快捷键。");
    return;
  }
  if (name === "ctrl-c" && !confirm("发送 Ctrl+C，可能中断当前任务。继续吗？")) return;
  const data = controlSequence(name);
  if (!data) return;
  void performInput(() => {
    socket.send(JSON.stringify({ type: "input", data }));
    note("按键已送入终端。");
  });
}
function scheduleReconnect(g, delay = 3000) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    if (g !== generation || $("#app").classList.contains("hidden")) return;
    try {
      await refresh();
      if (g !== generation) return;
      if (current?.state === "online") {
        connect();
        return;
      }
    } catch {}
    if (g === generation) scheduleReconnect(g, Math.min(15000, delay * 1.5));
  }, delay);
}
function updateViewport() {
  const v = window.visualViewport;
  document.documentElement.style.setProperty("--desk-height", (v?.height || innerHeight) + "px");
  document.documentElement.style.setProperty("--desk-top", (v?.offsetTop || 0) + "px");
}
window.visualViewport?.addEventListener("resize", updateViewport);
window.visualViewport?.addEventListener("scroll", updateViewport);
window.addEventListener("resize", updateViewport);
updateViewport();

function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.add("hidden"), 6500);
}
async function api(route, options = {}) {
  try {
    const r = await fetch(route, {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: options.signal || AbortSignal.timeout(12000),
    });
    let body;
    try {
      body = await r.json();
    } catch {
      throw Object.assign(Error("连接返回异常，请稍后重试"), {
        status: r.status,
      });
    }
    if (!r.ok) {
      if (r.status === 401 && route !== "/api/login") showLogin();
      throw Object.assign(Error(body.error || "请求失败"), {
        status: r.status,
      });
    }
    return body;
  } catch (e) {
    if (e.name === "TimeoutError") throw Error("连接超时，请稍后重试");
    if (e.name === "TypeError") throw Error("网络暂时没有连通，请稍后重试");
    throw e;
  }
}
function post(route, body = {}) {
  return api(route, { method: "POST", body: JSON.stringify(body) });
}
const previewView = new DeskPreview({
  request: (item, signal) =>
    api("/api/sessions/" + item.name + "/preview", {
      method: "POST",
      body: "{}",
      ...(signal ? { signal } : {}),
    }),
  notify: toast,
});
const chatView = new DeskChat({
  request: (item, query, signal) =>
    api("/api/sessions/" + item.name + "/chat?" + query, { signal }),
  send: (item, body) =>
    api("/api/sessions/" + item.name + "/chat", {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    }),
  receipt: (item, id) => api("/api/sessions/" + item.name + "/chat/receipts/" + id),
  dismiss: (item, id, body) =>
    api("/api/sessions/" + item.name + "/chat/receipts/" + id, {
      method: "DELETE",
      body: JSON.stringify(body),
    }),
  onRuntime: (item, value) => sessionView.setRuntime(item, value),
});
const sessionView = new DeskSessions();
function stopTerminal() {
  dismissChatControls();
  terminalLoading = false;
  closeHistory();
  composing = false;
  generation++;
  clearTimeout(retryTimer);
  rejectWrite("连接已变化，内容未发送。");
  connectionReady = false;
  socket?.close();
  socket = null;
  terminal?.dispose();
  terminal = null;
  setWrite(false);
}
function showLogin() {
  stopTerminal();
  chatView.reset();
  document.body.classList.remove("terminal-mode", "chat-mode", "workspace-mode");
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  previewView.reset();
}
function setWrite(value) {
  write = value;
  $("#writeMode").textContent = value ? "切回只读" : "允许输入";
  $("#writeMode").classList.toggle("active", value);
  if (terminal) terminal.options.disableStdin = !value || historyVisible;
  note(
    value
      ? "直接在终端输入 · Enter 的作用由当前程序决定"
      : "点「键盘」输入 · Shift＋←、方向键直接点按",
  );
  updateControls();
  if (value && writeWaiter) {
    const waiter = writeWaiter;
    writeWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}
async function refresh() {
  const data = await api("/api/sessions");
  sessions = data.sessions;
  renderCards();
  if (current) {
    current = sessions.find((s) => s.name === current.name);
    renderWorkspace();
  }
  sessionView.update(sessions, current);
}
function renderCards() {
  const filter = $("#search").value.trim().toLowerCase();
  $("#cards").replaceChildren();
  for (const s of sessions.filter((s) => (s.name + " " + s.label).toLowerCase().includes(filter))) {
    const card = document.createElement("a");
    card.className = "session-card";
    card.href = "/s/" + s.name;
    const symbol = document.createElement("span");
    symbol.className = "symbol";
    symbol.textContent = ">_";
    const title = document.createElement("h2");
    title.textContent = s.label;
    const note = document.createElement("p"),
      dot = document.createElement("span");
    dot.className = "dot " + (s.state === "online" ? "online" : s.state === "rebind" ? "warn" : "");
    note.append(
      dot,
      document.createTextNode(
        s.state === "offline"
          ? "未运行"
          : s.state === "rebind"
            ? "需要重新确认绑定"
            : s.attached
              ? "已有终端连接"
              : "随时继续",
      ),
    );
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "↗";
    card.append(symbol, title, note, arrow);
    $("#cards").append(card);
  }
}
function renderWorkspace() {
  if (!current) return;
  $("#title").textContent = current.label;
  $("#title").title = current.label;
  $("#sessionInfo").textContent =
    `${current.name} · ${current.windows} 个窗口 · ${current.state === "online" ? "会话在线" : current.state === "rebind" ? "原会话已变化，须明确重新绑定" : "会话已离线"}`;
  $("#rebind").classList.toggle("hidden", current.state !== "rebind");
  $("#label").value = current.label;
  $("#previewType").value = current.preview?.type || "none";
  $("#directory").value = current.preview?.directory || "";
  $("#entry").value = current.preview?.entry || "index.html";
  $("#port").value = current.preview?.port || "";
  settingsFields();
}
function settingsFields() {
  const t = $("#previewType").value;
  $("#staticFields").classList.toggle("hidden", t !== "static");
  $("#portFields").classList.toggle("hidden", t !== "port");
}
async function route() {
  deskMenu.open = false;
  stopTerminal();
  chatView.clear();
  previewView.reset();
  const name = location.pathname.match(/^\/s\/([a-z0-9_-]+)$/)?.[1];
  current = sessions.find((s) => s.name === name) || null;
  sessionView.select(current);
  sessionView.navigated();
  document.body.classList.remove("terminal-mode", "chat-mode", "workspace-mode");
  $("#home").classList.toggle("hidden", Boolean(current));
  $("#workspace").classList.toggle("hidden", !current);
  if (name && !current) toast("没有这个会话，已回到会话列表");
  if (current) {
    renderWorkspace();
    tab(
      ["#preview", "#terminal", "#settings"].includes(location.hash)
        ? location.hash.slice(1)
        : "chat",
    );
    const opened = current;
    void post("/api/sessions/" + opened.name + "/visit")
      .then((result) => {
        for (const item of sessions)
          if (item.name === opened.name)
            item.lastOpenedAt = Math.max(item.lastOpenedAt || 0, result.lastOpenedAt);
      })
      .catch(() => {
        /* Ranking must never block a conversation or resend input. */
      });
  } else renderCards();
}
function tab(name) {
  if (name === "chat" && !chatEnabled) name = "terminal";
  if ($("#chatControls").open) stopTerminal();
  document.body.classList.toggle("workspace-mode", Boolean(current));
  document.body.classList.toggle("terminal-mode", name === "terminal" && Boolean(current));
  document.body.classList.toggle("chat-mode", name === "chat" && Boolean(current));
  if (current) history.replaceState({}, "", location.pathname + "#" + name);
  $("#moreKeys").open = false;
  updateViewport();
  all("[data-tab]").forEach((b) => b.classList.toggle("selected", b.dataset.tab === name));
  for (const t of ["chat", "terminal", "preview", "settings"])
    $("#" + t + "Panel").classList.toggle("hidden", t !== name);
  $("#workspace").classList.toggle("preview-active", name === "preview");
  if (name !== "chat") chatView.stop();
  else chatView.open(current);
  if (name !== "terminal") stopTerminal();
  if (name === "preview") void preview();
  if (name === "terminal" && current && !terminal && !terminalLoading) void connect();
  if (name === "terminal" && terminal) setTimeout(() => terminal.refresh(0, terminal.rows - 1), 30);
}
async function connect() {
  closeHistory();
  composing = false;
  if (!current || current.state !== "online") {
    $("#connection").textContent = "会话不可连接，请刷新或确认绑定";
    return;
  }
  connectionReady = false;
  rejectWrite("连接已重建，内容未发送。");
  const g = ++generation;
  clearTimeout(retryTimer);
  socket?.close();
  terminal?.dispose();
  setWrite(false);
  $("#writeMode").disabled = true;
  $("#terminal").replaceChildren();
  terminalLoading = true;
  $("#connection").textContent = "正在加载终端…";
  try {
    await ensureTerminal();
  } catch (e) {
    if (g === generation) {
      terminalLoading = false;
      $("#connection").textContent = e.message;
    }
    return;
  }
  if (g !== generation) return;
  terminalLoading = false;
  terminal = new Terminal({
    cols: 120,
    rows: 30,
    scrollback: 20000,
    fontSize,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    cursorBlink: true,
    disableStdin: true,
    allowProposedApi: false,
    theme: window.CodockTheme.terminal(),
  });
  terminal.open($("#terminal"));
  bindTerminalInput();
  followOutput = true;
  terminal.onScroll(() => {
    if (terminal) followOutput = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  });
  terminal.onData((data) => {
    if (write && !historyVisible && socket?.readyState === 1)
      socket.send(JSON.stringify({ type: "input", data }));
  });
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", current.name);
  url.searchParams.set("identity", current.identity);
  const ws = new WebSocket(url);
  socket = ws;
  $("#connection").textContent = "正在连接原会话…";
  $("#connectionDot").className = "dot";
  ws.onmessage = (e) => {
    if (g !== generation) return;
    const m = JSON.parse(e.data);
    if (m.type === "output")
      terminal.write(m.data, () => {
        if (g === generation) receivedOutput();
      });
    if (m.type === "ready") {
      connectionReady = true;
      terminal.resize(m.cols, m.rows);
      $("#connection").textContent = "已连接 · 默认只读";
      $("#connectionDot").className = "dot online";
      updateControls();
    }
    if (m.type === "mode") {
      setWrite(m.write);
      if (!m.write && m.reason === "idle") {
        terminal?.blur();
        toast("两分钟未输入，已切回只读。点终端或「键盘」即可继续。");
      }
      $("#connection").textContent = m.write ? "已连接 · 可输入" : "已连接 · 只读";
    }
    if (m.type === "error") {
      rejectWrite(m.message);
      toast(m.message);
      note(m.message);
      if (historyPending === m.id) historyError(m.message);
    }
    if (m.type === "history") receiveHistory(m);
    if (m.type === "ended") toast(m.message);
  };
  ws.onclose = () => {
    if (g !== generation) return;
    connectionReady = false;
    closeHistory();
    rejectWrite("连接已断开，请恢复后检查终端。");
    setWrite(false);
    note("连接中断，输入不会自动重发；恢复后请检查终端。");
    $("#connection").textContent = "正在重连 · 原会话继续运行";
    $("#connectionDot").className = "dot warn";
    scheduleReconnect(g);
  };
  ws.onerror = () => {};
}
function preview(newWindow = false) {
  return previewView.open(current, { newWindow });
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (
    a &&
    a.origin === location.origin &&
    /^\/(?:s\/[a-z0-9_-]+)?$/.test(a.pathname) &&
    !a.target &&
    !a.hasAttribute("download") &&
    !e.ctrlKey &&
    !e.metaKey
  ) {
    e.preventDefault();
    history.pushState({}, "", a.pathname + a.hash);
    void route();
  }
});
window.onpopstate = () => void route();
// One live terminal surface, temporarily displayed over the conversation.
// Opening/closing never sends keys; no pending key is replayed on connection.
const terminalHome = document.createComment("terminal-home");
$("#terminalPanel").before(terminalHome);
function dismissChatControls() {
  const dialog = $("#chatControls");
  if (!dialog.open) return;
  dialog.close();
  terminalHome.after($("#terminalPanel"));
  $("#terminalPanel").classList.add("hidden");
  $("#chatTerminal").setAttribute("aria-expanded", "false");
}
function openChatControls(interrupt = false) {
  if (!current || $("#chatPanel").classList.contains("hidden")) return;
  chatView.voice.close();
  const dialog = $("#chatControls");
  $("#chatControlsTitle").textContent = current.label + " · 现场操作";
  $("#chatControlHint").textContent = interrupt
    ? "先确认下方现场，再点「中断本轮」。只发送一次 Esc，不强制结束进程。"
    : "这里是原终端的实时画面。按题目提示选择或输入，回答后点「回到聊天」。";
  if (!dialog.open) {
    $("#chatControlHost").append($("#terminalPanel"));
    $("#terminalPanel").classList.remove("hidden");
    dialog.showModal();
    $("#chatTerminal").setAttribute("aria-expanded", "true");
    void connect();
  }
  $("#chatControlsClose").focus();
}
$("#chatTerminal").onclick = () => openChatControls();
$("#chatInterrupt").onclick = () => openChatControls(true);
$("#chatAttention").onclick = () => openChatControls();
$("#chatControlsClose").onclick = () => {
  stopTerminal();
  $("#chatTerminal").focus();
};
$("#chatControls").addEventListener("cancel", (e) => {
  e.preventDefault();
  // Esc typed into xterm belongs to the original program, not the dialog.
  if (document.activeElement !== terminal?.textarea) {
    stopTerminal();
    $("#chatTerminal").focus();
  }
});
$("#chatStopTurn").onclick = () => {
  if (!connectionReady || operationBusy || historyVisible || composing) return;
  if (
    !confirm(
      "向当前现场发送一次 Esc？Codex 运行中用于中断本轮；若正在显示菜单则会取消菜单。不会强制结束进程。",
    )
  )
    return;
  void performInput(() => {
    socket.send(JSON.stringify({ type: "input", data: "\x1b" }));
    note("已发送 Esc，请查看现场是否停止；不会自动重复发送。");
  });
};
$("#chatPreview").onclick = () => tab("preview");
const deskMenu = $("#deskMenu");
deskMenu.addEventListener("click", (event) => {
  if (event.target.closest(".desk-menu-items a,.desk-menu-items button")) deskMenu.open = false;
});
document.addEventListener("pointerdown", (event) => {
  if (deskMenu.open && !deskMenu.contains(event.target)) deskMenu.open = false;
});
deskMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    deskMenu.open = false;
    deskMenu.querySelector("summary").focus();
  }
});
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#loginButton").disabled = true;
  $("#loginMessage").textContent = "正在验证…";
  try {
    await post("/api/login", {
      password: $("#password").value,
      code: $("#code").value,
    });
    $("#password").value = "";
    $("#code").value = "";
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await refresh();
    await route();
  } catch (e) {
    $("#loginMessage").textContent = e.message;
  } finally {
    $("#loginButton").disabled = false;
  }
};
$("#logout").onclick = async () => {
  try {
    await post("/api/logout");
  } finally {
    showLogin();
    inputConsent.clear();
  }
};
$("#refresh").onclick = () => void refresh().catch((e) => toast(e.message));
$("#search").oninput = renderCards;
$("#searchToggle").onclick = () => {
  const show = $("#search").classList.contains("hidden");
  $("#search").classList.toggle("hidden", !show);
  $("#searchToggle").setAttribute("aria-expanded", String(show));
  if (show) $("#search").focus();
  else {
    $("#search").value = "";
    renderCards();
  }
};
$("#search").onkeydown = (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    $("#searchToggle").click();
    $("#searchToggle").focus();
  }
};
all("[data-tab]").forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
$("#previewType").onchange = settingsFields;
$("#configurePreview").onclick = () => tab("settings");
$("#reloadPreview").onclick = () => void previewView.open(current, { force: true });
$("#openPreview").onclick = () => void preview(true);
$("#reconnect").onclick = async () => {
  try {
    await refresh();
    connect();
  } catch (e) {
    toast(e.message);
  }
};
$("#writeMode").onclick = () => {
  if (!connectionReady || operationBusy) return;
  if (write) {
    inputConsent.delete(sessionKey());
    socket.send(JSON.stringify({ type: "readonly" }));
    setWrite(false);
  } else void performInput(() => terminal?.focus());
};
$("#focusTerminal").onclick = () => {
  if (historyVisible) jumpLatest();
  if (write) {
    terminal?.focus();
    return;
  }
  void performInput(() => terminal?.focus());
};
all("[data-key]").forEach((b) => {
  b.onclick = () => sendKey(b.dataset.key);
  b.addEventListener("pointerdown", (e) => {
    if (terminal?.textarea && document.activeElement === terminal.textarea) e.preventDefault();
  });
});

$("#latest").onclick = jumpLatest;
$("#terminalScroll").addEventListener("scroll", () => {
  const v = $("#terminalScroll");
  followOutput = v.scrollHeight - v.scrollTop - v.clientHeight < 24;
});
$("#fontSmaller").onclick = () => {
  fontSize = Math.max(9, fontSize - 1);
  if (terminal) terminal.options.fontSize = fontSize;
};
$("#fontLarger").onclick = () => {
  fontSize = Math.min(22, fontSize + 1);
  if (terminal) terminal.options.fontSize = fontSize;
};
$("#copySelection").onclick = async () => {
  const text = historyVisible ? window.getSelection()?.toString() : terminal?.getSelection();
  if (!text) {
    toast("先在终端中选择要复制的文字");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制选中文字");
  } catch {
    toast("浏览器未允许复制，请使用系统复制菜单");
  }
};

function bindTerminalInput() {
  const t = terminal,
    box = t.textarea;
  box.setAttribute("autocapitalize", "off");
  box.setAttribute("autocorrect", "off");
  box.spellcheck = false;
  const activity = () => {
    if (write && socket?.readyState === 1 && Date.now() - lastActivity > 5000) {
      lastActivity = Date.now();
      socket.send(JSON.stringify({ type: "activity" }));
    }
  };
  box.addEventListener("compositionstart", () => {
    composing = true;
    activity();
  });
  box.addEventListener("compositionupdate", activity);
  box.addEventListener("compositionend", () =>
    setTimeout(() => {
      if (t === terminal) composing = false;
    }, 0),
  );
  box.addEventListener("focus", () => {
    updateControls();
    if (write) note("正在终端中输入 · Enter 确认，方向键选择");
  });
  box.addEventListener("blur", () => {
    updateControls();
    if (write && !historyVisible) note("点黑色终端或「键盘」继续输入");
  });
}
// Small taps on the terminal can re-enable input; scrolling/selecting must not.
let terminalTouch = null;
$("#terminal").addEventListener("pointerdown", (e) => {
  terminalTouch = { x: e.clientX, y: e.clientY, time: Date.now() };
});
$("#terminal").addEventListener("pointerup", (e) => {
  const p = terminalTouch;
  terminalTouch = null;
  if (
    !p ||
    Date.now() - p.time > 500 ||
    Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8 ||
    terminal?.hasSelection()
  )
    return;
  if (!write && connectionReady && !operationBusy) void performInput(() => terminal?.focus());
});
$("#terminal").addEventListener("pointercancel", () => {
  terminalTouch = null;
});
// Display controls must not steal keyboard focus or cancel mobile composition.
all("#fontSmaller,#fontLarger,#latest,#copySelection,#moreKeys summary").forEach((b) =>
  b.addEventListener("pointerdown", (e) => {
    if (terminal?.textarea === document.activeElement) e.preventDefault();
  }),
);
function historyError(message) {
  clearTimeout(historyTimer);
  historyPending = null;
  historyBuffered = null;
  historyLoadFailed = true;
  $("#historyStatus").textContent = message;
  $("#historyRefresh").disabled = false;
  $("#historyOlder").disabled = !historyPage?.start;
}
function closeHistory() {
  const hadHistory = Boolean(historyPending || historyPage || historyVisible);
  clearTimeout(historyTimer);
  historyPending = null;
  historyPage = null;
  historyBuffered = null;
  historyTouching = false;
  historyLoadFailed = false;
  historyVisible = false;
  $("#historyDialog").classList.add("hidden");
  $("#terminalPanel").classList.remove("history-reading");
  if (terminal) terminal.options.disableStdin = !write;
  updateControls();
  $("#historyText").textContent = "";
  $("#historyStatus").textContent = "";
  if (hadHistory && socket?.readyState === 1)
    socket.send(JSON.stringify({ type: "history-close" }));
}
function requestHistory(older = false) {
  if (historyPending || !connectionReady || socket?.readyState !== 1) return;
  if (older && (!historyPage?.start || historyLoadFailed)) return;
  if (!older) historyLoadFailed = false;
  historyPending = crypto.randomUUID();
  $("#historyOlder").disabled = true;
  $("#historyRefresh").disabled = true;
  $("#historyStatus").textContent = "正在读取 tmux 历史…";
  socket.send(
    JSON.stringify({
      type: "history",
      id: historyPending,
      ...(older ? { before: historyPage.start, snapshot: historyPage.snapshot } : {}),
    }),
  );
  historyTimer = setTimeout(() => historyError("历史读取超时，请刷新重试"), 10000);
}
function receiveHistory(m) {
  if (m.id !== historyPending || !historyVisible) return;
  clearTimeout(historyTimer);
  // Do not rebuild or move the scroller underneath an active finger.
  if (historyTouching) {
    historyBuffered = m;
    return;
  }
  historyPending = null;
  historyBuffered = null;
  const box = $("#historyText"),
    older = historyPage?.snapshot === m.snapshot;
  const height = box.scrollHeight,
    top = box.scrollTop;
  const chunk = document.createElement("pre");
  chunk.className = "history-chunk";
  chunk.dataset.start = String(m.start);
  chunk.textContent = m.text;
  if (older) box.prepend(chunk);
  else box.replaceChildren(chunk);
  historyPage = m;
  box.scrollTop = older
    ? top + box.scrollHeight - height
    : Math.max(0, box.scrollHeight - box.clientHeight - historyInitialOffset);
  $("#historyStatus").textContent =
    "已载入 " +
    (m.total - m.start) +
    " / " +
    m.total +
    " 行" +
    (m.start === 0 ? " · 已到最早" : "") +
    (m.truncated ? " · 最近 20,000 行" : "") +
    (m.alternate ? " · 全屏程序内部记录可能另存" : "");
  $("#historyOlder").disabled = m.start === 0;
  $("#historyRefresh").disabled = false;
}
function openHistory(offset = 0) {
  if (!connectionReady || historyVisible || composing) return;
  terminalTouch = null;
  historyVisible = true;
  followOutput = false;
  historyInitialOffset = offset;
  terminal?.blur();
  if (terminal) terminal.options.disableStdin = true;
  $("#terminalPanel").classList.add("history-reading");
  $("#historyDialog").classList.remove("hidden");
  historyPage = null;
  updateControls();
  requestHistory();
}
$("#showHistory").onclick = () => (historyVisible ? jumpLatest() : openHistory());
$("#historyOlder").onclick = () => requestHistory(true);
$("#historyRefresh").onclick = () => requestHistory();
$("#historyClose").onclick = jumpLatest;
$("#historyWrap").onclick = () => {
  const box = $("#historyText"),
    raw = box.classList.toggle("original-width");
  $("#historyWrap").textContent = raw ? "自动换行" : "原始行宽";
  $("#historyWrap").setAttribute("aria-pressed", String(raw));
};

// Scroll gestures read history locally; never forward these gestures as terminal keys.
function atLiveTop() {
  return $("#terminalScroll").scrollTop <= 2 && (terminal?.buffer.active.viewportY || 0) === 0;
}
const liveView = $("#terminalScroll");
liveView.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (e.deltaY < 0 && atLiveTop() && !composing) {
      e.preventDefault();
      e.stopPropagation();
      openHistory();
    }
  },
  { capture: true, passive: false },
);
let liveTouch = null;
liveView.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length === 1) {
      const p = e.touches[0];
      liveTouch = { x: p.clientX, y: p.clientY, older: 0 };
    } else liveTouch = null;
  },
  { passive: true },
);
liveView.addEventListener(
  "touchmove",
  (e) => {
    if (!liveTouch || e.touches.length !== 1 || composing) return;
    const p = e.touches[0],
      dy = p.clientY - liveTouch.y,
      dx = p.clientX - liveTouch.x;
    if (dy > 24 && dy > Math.abs(dx) * 1.5) {
      // Finish the entry gesture before swapping layers, avoiding a lost touch
      // target mid-drag. No need to fight both outer and xterm scroll positions.
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      liveTouch.older = dy;
      terminalTouch = null;
    }
  },
  { capture: true, passive: false },
);
liveView.addEventListener(
  "touchend",
  () => {
    const offset = liveTouch?.older || 0;
    liveTouch = null;
    if (offset) openHistory(Math.min(offset, 400));
  },
  { passive: true },
);
liveView.addEventListener(
  "touchcancel",
  () => {
    liveTouch = null;
  },
  { passive: true },
);
const historyBox = $("#historyText");
function prefetchHistory() {
  if (
    historyVisible &&
    historyBox.scrollTop < Math.max(240, historyBox.clientHeight) &&
    historyPage?.start &&
    !historyPending &&
    !historyLoadFailed
  )
    requestHistory(true);
}
historyBox.addEventListener("scroll", prefetchHistory, { passive: true });
// All history gestures are native browser scrolling. Reaching the bottom never
// exits the reader or discards the snapshot; use the explicit live button.
historyBox.addEventListener(
  "touchstart",
  () => {
    historyTouching = true;
  },
  { passive: true },
);
function endHistoryTouch() {
  historyTouching = false;
  if (historyBuffered) receiveHistory(historyBuffered);
  prefetchHistory();
}
historyBox.addEventListener("touchend", endHistoryTouch, { passive: true });
historyBox.addEventListener("touchcancel", endHistoryTouch, { passive: true });
historyBox.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    jumpLatest();
  }
});

$("#settingsForm").onsubmit = async (e) => {
  e.preventDefault();
  const type = $("#previewType").value,
    body = {
      revision: current.revision,
      label: $("#label").value,
      preview:
        type === "static"
          ? { type, directory: $("#directory").value, entry: $("#entry").value }
          : type === "port"
            ? { type, port: Number($("#port").value) }
            : null,
    };
  try {
    const result = await api("/api/sessions/" + current.name, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    current = { ...current, ...result.session };
    sessions = sessions.map((s) => (s.name === current.name ? current : s));
    renderCards();
    renderWorkspace();
    sessionView.update(sessions, current);
    previewView.reset();
    $("#settingsMessage").textContent = "已保存，下次打开仍会记住。";
  } catch (e) {
    $("#settingsMessage").textContent = e.message;
  }
};
$("#rebind").onclick = async () => {
  if (!confirm("原会话已变化。确认把此工作页重新绑定到当前同名会话？原预览绑定会清空。")) return;
  try {
    await post("/api/sessions/" + current.name + "/bind", {
      identity: current.liveIdentity,
      confirm: true,
    });
    await refresh();
    connect();
  } catch (e) {
    toast(e.message);
  }
};
document.addEventListener("visibilitychange", () => {
  if (
    !document.hidden &&
    current &&
    $("#terminalPanel").classList.contains("hidden") === false &&
    socket?.readyState !== 1 &&
    !$("#app").classList.contains("hidden")
  )
    void refresh()
      .then(connect)
      .catch(() => {});
});
const githubErrors = {
  wrong_account: "这个 GitHub 账号没有访问权限，请使用管理员授权的账号登录。",
  expired: "登录确认已过期，请重新点击 GitHub 登录。",
  cancelled: "你取消了 GitHub 授权，可以重新尝试。",
  upstream: "服务器暂时未能完成 GitHub 登录，请重新点击登录。",
  upstream_exchange: "服务器与 GitHub 交换登录确认时连接失败，请重新点击 GitHub 登录。",
  upstream_profile: "服务器读取 GitHub 账号信息失败，自动重试后仍未成功。请稍后重新登录。",
  exchange_failed: "GitHub 登录确认失败，请重新尝试。",
  unexpected_scope: "该应用授权范围过大，请使用专门创建的身份登录应用。",
  not_configured: "GitHub 登录尚未配置完成。",
  too_many_devices: "登录设备过多，请退出其他设备后再试。",
};
$("#githubLogin").onclick = async () => {
  const button = $("#githubLogin");
  button.disabled = true;
  $("#loginMessage").textContent = "正在前往 GitHub…";
  try {
    const { url } = await post("/api/auth/github/start");
    const target = new URL(url);
    if (target.origin !== "https://github.com" || target.pathname !== "/login/oauth/authorize")
      throw Error("登录跳转地址无效");
    location.assign(target.href);
  } catch (e) {
    $("#loginMessage").textContent = e.message;
    button.disabled = false;
  }
};
const loginError = new URLSearchParams(location.search).get("login_error");
if (loginError) history.replaceState({}, "", location.pathname);
let initializing = false,
  bootstrapFailed = false;
async function initialize() {
  if (initializing) return;
  initializing = true;
  bootstrapFailed = false;
  $("#retryConnection").classList.add("hidden");
  $("#githubLogin").disabled = true;
  $("#loginMessage").textContent = "正在连接工作台…";
  try {
    let b;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        b = await api("/api/bootstrap");
        break;
      } catch (e) {
        if (attempt || (e.status && e.status < 500)) throw e;
        $("#loginMessage").textContent = "连接有些慢，正在重试…";
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    $("#githubLogin").disabled = !b.methods.github;
    $("#githubLogin").classList.toggle("hidden", Boolean(b.methods.local));
    chatEnabled = b.chatEnabled !== false;
    document.querySelector('[data-tab="chat"]').classList.toggle("hidden", !chatEnabled);
    $("#githubNote").classList.toggle("hidden", Boolean(b.methods.local));
    $("#githubNote").textContent = "仅限管理员授权的 GitHub 账号";
    $("#loginForm").classList.toggle("hidden", !b.methods.local);
    $("#loginButton").disabled = !b.methods.local;
    if (!b.authenticated) {
      showLogin();
      $("#loginMessage").textContent = loginError
        ? githubErrors[loginError] || "登录未完成，请重新尝试。"
        : !b.configured
          ? "GitHub 登录即将就绪，等待管理员完成应用配置。"
          : "";
      return;
    }
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await refresh();
    await route();
  } catch (e) {
    showLogin();
    bootstrapFailed = true;
    $("#loginMessage").textContent = e.message;
    $("#retryConnection").classList.remove("hidden");
  } finally {
    initializing = false;
  }
}
$("#retryConnection").onclick = () => void initialize();
window.addEventListener("online", () => {
  if (bootstrapFailed) void initialize();
});
// A browser Back from GitHub can restore the disabled button from bfcache.
window.addEventListener("pageshow", (event) => {
  if (event.persisted && !$("#login").classList.contains("hidden")) void initialize();
});
void initialize();
