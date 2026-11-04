import { loadConfig, renderIndex } from "./lib/config.mjs";
import { checkCredentials } from "./lib/preflight.mjs";
import { homedir } from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { Auth } from "./lib/auth.mjs";
import { Registry, names } from "./lib/registry.mjs";
import { Terminals } from "./lib/terminal.mjs";
import { Previews } from "./lib/preview.mjs";
import { GithubAuth, callbackPath } from "./lib/github-auth.mjs";
import { startControl } from "./lib/control.mjs";
import { Chats } from "./lib/chat.mjs";
import { ChatSender } from "./lib/chat-send.mjs";
import { ChatInteraction } from "./lib/chat-interaction.mjs";
import { SessionUsage } from "./lib/session-usage.mjs";
import { SessionRuntime } from "./lib/session-runtime.mjs";
import { VoiceAsr } from "./lib/voice-asr.mjs";
import { SystemStatus } from "./lib/system-status.mjs";
import { AccountQuota } from "./lib/account-quota.mjs";
import { AccountPool } from "./lib/account-pool.mjs";
import { SystemAccount } from "./lib/system-account.mjs";
import { Guardian } from "./lib/guardian.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
export async function createDesk(options = {}) {
  const config = {
    runtime: path.join(root, "runtime"),
    socket: path.join(root, "runtime/tmux.sock"),
    projectRoot: path.join(root, "projects"),
    origin: "https://terminal.example.com",
    previewSuffix: "preview.example.com",
    previewPort: "",
    secure: true,
    trustProxy: false,
    allowed: names,
    authMode: "local",
    chatEnabled: true,
    ...options,
  };
  for (const d of [
    config.runtime,
    config.runtime + "/tmp",
    config.runtime + "/cache",
    config.runtime + "/config",
  ])
    await mkdir(d, { recursive: true, mode: 0o700 });
  const auth = new Auth(path.join(config.runtime, "auth.json"), { secure: config.secure });
  const github = new GithubAuth(
    path.join(config.runtime, "github.json"),
    config,
    options.githubDependencies,
  );
  const registry = new Registry({
    socket: config.socket,
    file: path.join(config.runtime, "sessions.json"),
    root: config.projectRoot,
    allowed: config.allowed,
    previewPorts: config.previewPorts,
  });
  await registry.init();
  const terminals = new Terminals(registry, auth, config.runtime),
    previews = new Previews(registry, auth, config);
  registry.systemAccountApplying = () => terminals.systemAccountApplying;
  const chats = new Chats(registry, {
    home: config.codexHome || path.join(homedir(), ".codex"),
    claudeHome: config.claudeHome || path.join(homedir(), ".claude"),
    writers: terminals.writers,
    ...options.chatDependencies,
  });
  const accounts = new AccountPool({
    runtime: config.runtime,
    root: config.accountsRoot || path.join(config.runtime, "accounts"),
    defaultHome: chats.home,
    registry,
    terminals,
    chats,
    ...options.accountDependencies,
  });
  await accounts.init();
  clearInterval(accounts.timer);
  const systemAccount = new SystemAccount(accounts, options.systemAccountDependencies);
  await systemAccount.init();
  chats.homeFromMeta = (meta) => accounts.homeFromMeta(meta);
  const chatSender = new ChatSender(chats, config.runtime, {
    terminals,
    ...options.chatSendDependencies,
  });
  terminals.accountDeliveryPending = () => chatSender.running.size > 0;
  void chatSender.indexReceipts().catch(() => {});
  const chatInteraction = new ChatInteraction(chats, terminals);
  const usage = new SessionUsage(path.join(config.runtime, "session-usage.json"));
  await usage.init();
  const runtimeStatus = new SessionRuntime(registry, {
    home: chats.home,
    homeFromMeta: (meta) => accounts.homeFromMeta(meta),
    readTurns:
      options.runtimeDependencies?.readTurns ??
      (async (home, socket, panes) =>
        chats
          .readProcess({
            home,
            claudeHome: chats.claudeHome,
            runtimeBatch: panes.map((pane) => ({ ...pane, socket })),
          })
          .then((result) => result.completions)),
  });
  const voiceAsr = new VoiceAsr(config.runtime, options.voiceDependencies);
  await voiceAsr.init();
  const systemStatus = new SystemStatus(options.systemDependencies);
  await systemStatus.init();
  const guardianChats = new Chats(registry, {
    home: chats.home,
    claudeHome: chats.claudeHome,
    read: options.chatDependencies?.read,
    status: chats.status,
  });
  guardianChats.homeFromMeta = (meta) => accounts.homeFromMeta(meta);
  const guardian = new Guardian({
    runtime: config.runtime,
    workspace: config.projectRoot,
    model: config.guardianModel,
    registry,
    chats: guardianChats,
    home: chats.home,
    ...options.guardianDependencies,
  });
  await guardian.init();
  let accountQuota = new AccountQuota(chats.home, options.quotaDependencies);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 20000, perMessageDeflate: false });
  const assets = {
    "/theme.js": ["public/theme.js", "text/javascript"],
    "/brand.css": ["public/brand.css", "text/css"],
    "/workbench.svg": ["public/workbench.svg", "image/svg+xml"],
    ...Object.fromEntries(
      ["nailong.webp", "duck.svg", "cat.svg", "robot.svg"].map((n) => [
        "/mascots/" + n,
        ["public/mascots/" + n, n.endsWith(".svg") ? "image/svg+xml" : "image/webp"],
      ]),
    ),
    "/session-list.js": ["public/session-list.js", "text/javascript"],
    "/chat-view.js": ["public/chat-view.js", "text/javascript"],
    "/chat-markdown.js": ["public/chat-markdown.js", "text/javascript"],
    "/preview-view.js": ["public/preview-view.js", "text/javascript"],
    "/app.js": ["public/app.js", "text/javascript"],
    "/style.css": ["public/style.css", "text/css"],
    "/vendor/xterm.js": ["node_modules/@xterm/xterm/lib/xterm.js", "text/javascript"],
    "/vendor/xterm.css": ["node_modules/@xterm/xterm/css/xterm.css", "text/css"],
  };
  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify(data));
  };
  assets["/accounts.js"] = ["public/accounts.js", "text/javascript"];
  assets["/accounts.css"] = ["public/accounts.css", "text/css"];
  assets["/guardian.js"] = ["public/guardian.js", "text/javascript"];
  assets["/guardian.css"] = ["public/guardian.css", "text/css"];
  async function body(req, limit = 20000) {
    let result = "";
    if (Number(req.headers["content-length"]) > limit)
      throw Object.assign(Error("请求过大"), { status: 413 });
    for await (const b of req) {
      result += b;
      if (Buffer.byteLength(result) > limit)
        throw Object.assign(Error("请求过大"), { status: 413 });
    }
    try {
      return JSON.parse(result || "{}");
    } catch {
      throw Object.assign(Error("请求格式错误"), { status: 400 });
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (previews.name(req)) {
        try {
          await previews.handle(req, res);
        } catch (e) {
          previews.error(req, res, e);
        }
        return;
      }
      if (req.headers.host !== new URL(config.origin).host) {
        res.writeHead(421);
        res.end();
        return;
      }
      const url = new URL(req.url, config.origin),
        route = url.pathname;
      const headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src ${config.secure ? "https" : "http"}://*.${config.previewSuffix}${config.previewPort ? ":" + config.previewPort : ""}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      };
      if (config.secure) headers["Strict-Transport-Security"] = "max-age=31536000";
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
        req.headers.origin !== config.origin
      )
        throw Object.assign(Error("请求来源无效"), { status: 403 });
      if (req.method === "GET" && route === "/api/bootstrap") {
        const g = config.authMode === "github" ? await github.status() : { ready: false },
          local = config.authMode === "local" && (await auth.ready());
        json(res, 200, {
          configured: g.ready || local,
          authenticated: Boolean(auth.get(req)),
          methods: { github: g.ready, local },
          githubOwner: config.githubOwner?.login || "",
          chatEnabled: config.chatEnabled,
        });
        return;
      }
      if (req.method === "POST" && route === "/api/auth/github/start") {
        if (config.authMode !== "github")
          throw Object.assign(Error("GitHub 登录未启用"), { status: 403 });
        const ip = config.trustProxy
          ? String(req.headers["x-real-ip"] || req.socket.remoteAddress)
          : req.socket.remoteAddress;
        try {
          const flow = await github.start(req, ip);
          json(res, 200, { url: flow.url }, { "Set-Cookie": flow.cookie });
        } catch (e) {
          json(res, e.status || 503, {
            error:
              e.oauthCode === "rate_limited" ? "操作太频繁，请稍后再试" : "GitHub 登录尚未配置完成",
          });
        }
        return;
      }
      if (req.method === "GET" && route === callbackPath) {
        if (config.authMode !== "github")
          throw Object.assign(Error("GitHub 登录未启用"), { status: 403 });
        try {
          const identity = await github.finish(req, url),
            token = auth.issue(identity),
            old = auth.get(req);
          if (old) auth.sessions.delete(old);
          res.writeHead(303, {
            Location: "/",
            "Set-Cookie": [auth.cookie(token), github.cookie("", 0)],
          });
          res.end();
        } catch (e) {
          const reason =
            e.oauthCode === "upstream" && ["exchange", "profile"].includes(e.oauthStage)
              ? "upstream_" + e.oauthStage
              : e.oauthCode || (e.status === 429 ? "too_many_devices" : "upstream");
          res.writeHead(303, {
            Location: "/?login_error=" + encodeURIComponent(reason),
            "Set-Cookie": github.cookie("", 0),
          });
          res.end();
        }
        return;
      }
      if (req.method === "POST" && route === "/api/login") {
        if (config.authMode !== "local") {
          json(res, 403, { error: "请使用已绑定的 GitHub 账号登录" });
          return;
        }
        const b = await body(req);
        const ip = config.trustProxy
          ? String(req.headers["x-real-ip"] || req.socket.remoteAddress)
          : req.socket.remoteAddress;
        const token = await auth.login(b.password, b.code, ip);
        json(res, 200, { ok: true }, { "Set-Cookie": auth.cookie(token) });
        return;
      }
      if (
        req.method === "GET" &&
        (route === "/" || /^\/s\/[a-z0-9_-]+$/.test(route) || assets[route])
      ) {
        const [file, type] = assets[route] || ["public/index.html", "text/html; charset=utf-8"];
        res.writeHead(200, { "Content-Type": type });
        if (file === "public/index.html")
          res.end(renderIndex(await readFile(path.join(root, file), "utf8"), config.brand));
        else if (file === "public/brand.css")
          res.end(
            (await readFile(path.join(root, file), "utf8")) +
              (/^#[0-9a-f]{6}$/i.test(config.brand?.accent || "")
                ? "\n:root[data-theme]{--accent:" +
                  config.brand.accent +
                  ";--yellow:" +
                  config.brand.accent +
                  "}"
                : ""),
          );
        else res.end(await readFile(path.join(root, file)));
        return;
      }
      const token = auth.get(req);
      if (!token) throw Object.assign(Error("请先登录终端台"), { status: 401 });
      auth.valid(token, !(route.endsWith("/chat") && url.searchParams.has("revision")));
      if (req.method === "POST" && route === "/api/activity") {
        json(res, 200, { ok: true });
        return;
      }
      if (route === "/api/guardian" && req.method === "GET") {
        json(res, 200, guardian.view());
        return;
      }
      if (route === "/api/guardian" && req.method === "PATCH") {
        json(res, 200, await guardian.update(await body(req)));
        return;
      }
      if (route === "/api/guardian/tasks" && req.method === "POST") {
        json(res, 201, await guardian.register(await body(req)));
        return;
      }
      if (route === "/api/guardian/chat" && req.method === "POST") {
        json(res, 202, await guardian.ask(await body(req)));
        return;
      }
      if (route === "/api/guardian/chat" && req.method === "DELETE") {
        await body(req);
        json(res, 200, await guardian.cancel());
        return;
      }
      if (req.method === "POST" && route === "/api/logout") {
        auth.sessions.delete(token);
        for (const c of terminals.clients) if (c.token === token) c.ws.close(1008, "已退出登录");
        json(res, 200, { ok: true }, { "Set-Cookie": auth.cookie("", 0) });
        return;
      }
      if (req.method === "GET" && route === "/api/sessions") {
        json(res, 200, { sessions: usage.list(await registry.list()) });
        return;
      }
      if (req.method === "GET" && route === "/api/sessions/runtime") {
        json(res, 200, await runtimeStatus.snapshot());
        return;
      }
      if (req.method === "GET" && route === "/api/voice/status") {
        json(res, 200, voiceAsr.status());
        return;
      }
      if (req.method === "POST" && route === "/api/voice/prepare") {
        json(res, 200, await voiceAsr.prepare(await body(req)));
        return;
      }
      if (req.method === "POST" && route === "/api/voice/transcribe") {
        json(res, 200, await voiceAsr.transcribe(await body(req, 1400000)));
        return;
      }
      if (req.method === "GET" && route === "/api/system") {
        json(res, 200, await systemStatus.snapshot());
        return;
      }
      if (req.method === "GET" && route === "/api/account/quota") {
        const name = url.searchParams.get("session"),
          id = name
            ? (await accounts.current(name)).account
            : url.searchParams.get("account") || "default";
        if (id === "default" && accountQuota.systemSelection !== systemAccount.data.selected) {
          accountQuota = new AccountQuota(chats.home, options.quotaDependencies);
          accountQuota.systemSelection = systemAccount.data.selected;
        }
        json(
          res,
          200,
          id === "default"
            ? {
                ...(await accountQuota.snapshot()),
                accountId: id,
                label: systemAccount.data.selected
                  ? accounts.item(systemAccount.data.selected).label
                  : "系统账号",
              }
            : await accounts.quota(id),
        );
        return;
      }
      if (route === "/api/accounts/system") {
        if (req.method === "GET") {
          json(res, 200, await systemAccount.status());
          return;
        }
        if (req.method === "POST") {
          json(res, 202, await systemAccount.request(await body(req)));
          return;
        }
        if (req.method === "DELETE") {
          json(res, 200, await systemAccount.cancel((await body(req)).requestId));
          return;
        }
      }
      if (route === "/api/accounts") {
        if (req.method === "GET") {
          json(res, 200, await accounts.list());
          return;
        }
        if (req.method === "POST") {
          json(res, 201, await accounts.add((await body(req)).label));
          return;
        }
      }
      const accountMatch = route.match(
        /^\/api\/accounts\/(default|a_[a-f0-9]{12})(?:\/(login|cancel))?$/,
      );
      if (accountMatch) {
        const [, id, action] = accountMatch;
        if (req.method === "PATCH" && !action) {
          json(res, 200, await accounts.rename(id, (await body(req)).label));
          return;
        }
        if (req.method === "POST" && action) {
          await body(req);
          json(
            res,
            200,
            action === "login" ? await accounts.login(id) : await accounts.cancelLogin(id),
          );
          return;
        }
      }
      const switchMatch = route.match(/^\/api\/sessions\/([a-z0-9_-]+)\/account$/);
      if (switchMatch && registry.allowed.includes(switchMatch[1])) {
        const name = switchMatch[1];
        if (req.method === "GET") {
          json(res, 200, await accounts.session(name, url.searchParams.get("identity")));
          return;
        }
        if (req.method === "POST") {
          await body(req);
          throw Object.assign(Error("账号已改为系统统一切换，请刷新页面后使用「系统账号」"), {
            status: 409,
          });
        }
        if (req.method === "DELETE") {
          json(res, 200, await accounts.cancel(name, (await body(req)).requestId));
          return;
        }
      }
      const visitMatch = route.match(/^\/api\/sessions\/([a-z0-9_-]+)\/visit$/);
      if (req.method === "POST" && visitMatch && registry.allowed.includes(visitMatch[1])) {
        await body(req);
        json(res, 200, { lastOpenedAt: await usage.visit(visitMatch[1]) });
        return;
      }
      if (!config.chatEnabled && /^\/api\/sessions\/[^/]+\/(chat|interaction)/.test(route))
        throw Object.assign(Error("聊天未启用"), { status: 403 });
      const chatMatch = route.match(/^\/api\/sessions\/([a-z0-9_-]+)\/chat$/);
      const interactionMatch = route.match(/^\/api\/sessions\/([a-z0-9_-]+)\/interaction$/);
      if (interactionMatch && registry.allowed.includes(interactionMatch[1])) {
        const name = interactionMatch[1];
        if (req.method === "GET") {
          json(
            res,
            200,
            await chatInteraction.page(
              name,
              url.searchParams.get("identity"),
              url.searchParams.get("binding"),
            ),
          );
          return;
        }
        if (req.method === "POST") {
          json(res, 200, await chatInteraction.answer(name, await body(req)));
          return;
        }
      }
      const interruptMatch = route.match(
        /^\/api\/sessions\/([a-z0-9_-]+)\/interaction\/interrupt$/,
      );
      if (req.method === "POST" && interruptMatch && registry.allowed.includes(interruptMatch[1])) {
        json(res, 200, await chatInteraction.interrupt(interruptMatch[1], await body(req)));
        return;
      }
      if (req.method === "GET" && chatMatch) {
        const view = await chats.page(chatMatch[1], url.searchParams),
          extra = {};
        if (view.available) {
          extra.outbox = await chatSender.recent(
            chatMatch[1],
            url.searchParams.get("identity"),
            view.binding,
            view.messages,
          );
          if (url.searchParams.has("receipt")) {
            try {
              extra.receipt = await chatSender.status(
                chatMatch[1],
                url.searchParams.get("receipt"),
                { identity: url.searchParams.get("identity"), binding: view.binding },
              );
            } catch (e) {
              if (e.status !== 404) throw e;
              extra.receiptMissing = true;
            }
          }
        }
        json(res, 200, { ...view, ...extra });
        return;
      }
      if (req.method === "POST" && chatMatch && registry.allowed.includes(chatMatch[1])) {
        json(res, 200, await chatSender.send(chatMatch[1], await body(req)));
        return;
      }
      const receiptMatch = route.match(
        /^\/api\/sessions\/([a-z0-9_-]+)\/chat\/receipts\/([a-f0-9-]+)$/,
      );
      if (req.method === "GET" && receiptMatch && registry.allowed.includes(receiptMatch[1])) {
        json(res, 200, await chatSender.status(receiptMatch[1], receiptMatch[2]));
        return;
      }
      if (req.method === "POST" && receiptMatch && registry.allowed.includes(receiptMatch[1])) {
        json(res, 200, await chatSender.recover(receiptMatch[1], receiptMatch[2], await body(req)));
        return;
      }
      if (req.method === "PATCH" && receiptMatch && registry.allowed.includes(receiptMatch[1])) {
        json(res, 200, await chatSender.release(receiptMatch[1], receiptMatch[2], await body(req)));
        return;
      }
      if (req.method === "DELETE" && receiptMatch && registry.allowed.includes(receiptMatch[1])) {
        json(res, 200, await chatSender.dismiss(receiptMatch[1], receiptMatch[2], await body(req)));
        return;
      }
      const match = route.match(/^\/api\/sessions\/([a-z0-9_-]+)(?:\/(bind|preview))?$/);
      if (match && registry.allowed.includes(match[1])) {
        const name = match[1];
        if (req.method === "PATCH" && !match[2]) {
          json(res, 200, { session: await registry.update(name, await body(req)) });
          return;
        }
        if (req.method === "POST" && match[2] === "bind") {
          const b = await body(req);
          if (b.confirm !== true) throw Object.assign(Error("需要明确确认"), { status: 409 });
          await registry.bind(name, b.identity);
          json(res, 200, { ok: true });
          return;
        }
        if (req.method === "POST" && match[2] === "preview") {
          json(res, 200, { url: previews.issue(name, token) });
          return;
        }
      }
      throw Object.assign(Error("未找到"), { status: 404 });
    } catch (e) {
      const status = e.status || (e.code === "ENOENT" ? 404 : 500);
      if (!res.headersSent)
        json(res, status, { error: status === 500 ? "服务暂时不可用，请稍后重试" : e.message });
      else res.destroy();
      if (status === 500) console.error("request failed", e.code || e.name);
    }
  });
  server.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => {});
    if (previews.name(req)) {
      previews.upgrade(req, socket, head);
      return;
    }
    try {
      if (req.headers.host !== new URL(config.origin).host || req.headers.origin !== config.origin)
        throw Error("origin");
      const token = auth.get(req);
      if (!token) throw Error("auth");
      const url = new URL(req.url, config.origin);
      if (url.pathname !== "/ws") throw Error("route");
      const name = url.searchParams.get("session"),
        identity = url.searchParams.get("identity");
      await registry.target(name, identity);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", (e) => {
          console.error("websocket error", e.code || e.name);
          ws.close();
        });
        void terminals.attach(ws, token, name, identity).catch((e) => {
          console.error("terminal attach failed", e.message);
          ws.close(1008, "会话无法连接，请刷新检查");
        });
      });
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });
  return {
    server,
    config,
    auth,
    github,
    registry,
    runtimeStatus,
    systemStatus,
    terminals,
    previews,
    accounts,
    systemAccount,
    guardian,
    close: async () => {
      await guardian.close();
      await systemAccount.close();
      await accounts.close();
      voiceAsr.close();
      terminals.close();
      previews.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  if (process.getuid?.() === 0) throw Error("Run as a dedicated non-root user, never as root");
  await checkCredentials(config);
  const desk = await createDesk(config);
  const control = await startControl(desk);
  desk.server.listen(config.port, "127.0.0.1", () =>
    console.log("Terminal desk listening on loopback; credentials configured separately"),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(
      signal,
      () => void Promise.all([control.close(), desk.close()]).then(() => process.exit(0)),
    );
}
