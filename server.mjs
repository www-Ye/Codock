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
import { SessionUsage } from "./lib/session-usage.mjs";
import { loadConfig, renderIndex } from "./lib/config.mjs";
import { checkCredentials } from "./lib/preflight.mjs";
import { homedir } from "node:os";
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
  const auth = new Auth(path.join(config.runtime, "auth.json"), {
    secure: config.secure,
  });
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
  const chats = new Chats(registry, {
    home: config.codexHome || path.join(homedir(), ".codex"),
    ...options.chatDependencies,
  });
  const chatSender = new ChatSender(chats, config.runtime, {
    terminals,
    ...options.chatSendDependencies,
  });
  const usage = new SessionUsage(path.join(config.runtime, "session-usage.json"));
  await usage.init();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 20000,
    perMessageDeflate: false,
  });
  const assets = {
    "/theme.js": ["public/theme.js", "text/javascript"],
    "/mascots/nailong.webp": ["public/mascots/nailong.webp", "image/webp"],
    "/mascots/duck.svg": ["public/mascots/duck.svg", "image/svg+xml"],
    "/mascots/cat.svg": ["public/mascots/cat.svg", "image/svg+xml"],
    "/mascots/robot.svg": ["public/mascots/robot.svg", "image/svg+xml"],
    "/session-list.js": ["public/session-list.js", "text/javascript"],
    "/chat-view.js": ["public/chat-view.js", "text/javascript"],
    "/chat-markdown.js": ["public/chat-markdown.js", "text/javascript"],
    "/preview-view.js": ["public/preview-view.js", "text/javascript"],
    "/workbench.svg": ["public/workbench.svg", "image/svg+xml"],
    "/app.js": ["public/app.js", "text/javascript"],
    "/style.css": ["public/style.css", "text/css"],
    "/brand.css": ["public/brand.css", "text/css"],
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
  async function body(req) {
    let result = "";
    for await (const b of req) {
      result += b;
      if (Buffer.byteLength(result) > 20000)
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
          throw Object.assign(Error("此登录方式未启用"), { status: 403 });
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
          throw Object.assign(Error("此登录方式未启用"), { status: 403 });
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
                ? `\n:root[data-theme]{--accent:${config.brand.accent};--yellow:${config.brand.accent}}`
                : ""),
          );
        else res.end(await readFile(path.join(root, file)));
        return;
      }
      const token = auth.get(req);
      if (!token) throw Object.assign(Error("请先登录终端台"), { status: 401 });
      auth.valid(token, !(route.endsWith("/chat") && url.searchParams.has("revision")));
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
      const visitMatch = route.match(/^\/api\/sessions\/([a-z0-9_-]+)\/visit$/);
      if (req.method === "POST" && visitMatch && registry.allowed.includes(visitMatch[1])) {
        await body(req);
        json(res, 200, { lastOpenedAt: await usage.visit(visitMatch[1]) });
        return;
      }
      if (!config.chatEnabled && /^\/api\/sessions\/[^/]+\/chat/.test(route))
        throw Object.assign(Error("聊天适配器未启用，请使用原终端"), {
          status: 403,
        });
      const chatMatch = route.match(/^\/api\/sessions\/([a-z0-9_-]+)\/chat$/);
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
                {
                  identity: url.searchParams.get("identity"),
                  binding: view.binding,
                },
              );
            } catch (e) {
              if (e.status !== 404) throw e;
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
      if (req.method === "DELETE" && receiptMatch && registry.allowed.includes(receiptMatch[1])) {
        json(res, 200, await chatSender.dismiss(receiptMatch[1], receiptMatch[2], await body(req)));
        return;
      }
      const match = route.match(/^\/api\/sessions\/([a-z0-9_-]+)(?:\/(bind|preview))?$/);
      if (match && registry.allowed.includes(match[1])) {
        const name = match[1];
        if (req.method === "PATCH" && !match[2]) {
          json(res, 200, {
            session: await registry.update(name, await body(req)),
          });
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
        json(res, status, {
          error: status === 500 ? "服务暂时不可用，请稍后重试" : e.message,
        });
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
    terminals,
    previews,
    close: async () => {
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
