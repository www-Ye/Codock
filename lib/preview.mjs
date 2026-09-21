import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { cookies } from "./auth.mjs";
import { streamPreview, acceptsGzip, previewError } from "./preview-response.mjs";
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};
export class Previews {
  constructor(registry, auth, config) {
    Object.assign(this, { registry, auth, config });
    this.sockets = new Set();
    this.tickets = new Map();
    this.grants = new Map();
    this.cookieName = config.secure ? "__Host-workbench_preview" : "workbench_preview_dev";
  }
  origin(name) {
    return `${this.config.secure ? "https" : "http"}://${name}.${this.config.previewSuffix}${this.config.previewPort ? ":" + this.config.previewPort : ""}`;
  }
  sweep() {
    const now = Date.now();
    for (const [k, t] of this.tickets) if (t.expires < now) this.tickets.delete(k);
    for (const [k, t] of this.grants)
      if (t.expires < now || !this.auth.valid(t.owner)) this.grants.delete(k);
  }
  issue(name, owner) {
    this.sweep();
    const item = this.registry.items[name];
    if (!item?.preview) throw Object.assign(Error("请先在设置中绑定预览"), { status: 409 });
    if (this.tickets.size > 100 || this.grants.size > 200) throw Error("预览请求过多");
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { name, owner, revision: item.revision, expires: Date.now() + 60000 });
    return this.origin(name) + "/__grant?ticket=" + ticket;
  }
  name(req) {
    const host = String(req.headers.host || "").split(":")[0];
    return this.registry.allowed.find((name) => host === `${name}.${this.config.previewSuffix}`);
  }
  grant(req, name) {
    this.sweep();
    const g = this.grants.get(cookies(req)[this.cookieName]),
      item = this.registry.items[name];
    return g && g.name === name && item?.revision === g.revision && this.auth.valid(g.owner)
      ? g
      : null;
  }
  headers() {
    return {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors ${this.config.origin}; sandbox allow-scripts allow-same-origin allow-forms allow-downloads`,
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    };
  }
  error(req, res, error) {
    const status = error.status || (error.code === "ENOENT" ? 404 : 500);
    previewError(
      req,
      res,
      this.config.origin,
      status,
      status === 500
        ? "预览服务暂时不可用"
        : status === 404
          ? "找不到这个网页或资源，可能已移动或删除"
          : error.message,
    );
  }
  async handle(req, res) {
    const name = this.name(req);
    if (!name) {
      res.writeHead(404);
      res.end();
      return;
    }
    Object.entries(this.headers()).forEach(([k, v]) => res.setHeader(k, v));
    const url = new URL(req.url, this.origin(name));
    if (url.pathname === "/__grant" && req.method === "GET") {
      const ticket = url.searchParams.get("ticket"),
        g = this.tickets.get(ticket);
      this.tickets.delete(ticket);
      if (
        !g ||
        g.name !== name ||
        g.expires < Date.now() ||
        !this.auth.valid(g.owner) ||
        g.revision !== this.registry.items[name]?.revision
      )
        throw Object.assign(Error("预览链接已失效，请回到终端台重新打开"), { status: 401 });
      const token = randomBytes(32).toString("base64url");
      this.grants.set(token, { ...g, expires: Date.now() + 3600000 });
      const entry = this.registry.items[name].preview;
      res.writeHead(303, {
        "Set-Cookie": `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${this.config.secure ? "; Secure" : ""}`,
        Location: entry.type === "static" ? "/" + entry.entry : "/",
      });
      res.end();
      return;
    }
    if (!this.grant(req, name))
      throw Object.assign(Error("请先登录终端台，再从对应会话打开预览"), { status: 401 });
    if (!["GET", "HEAD"].includes(req.method))
      throw Object.assign(Error("预览仅允许读取网页"), { status: 405 });
    const item = this.registry.items[name].preview;
    if (
      item.type === "port" &&
      this.registry.previewPorts &&
      !this.registry.previewPorts.includes(item.port)
    )
      throw Object.assign(Error("该预览端口已被管理员禁用"), { status: 403 });
    if (item.type === "port") {
      this.proxy(req, res, item.port);
      return;
    }
    let relative;
    try {
      relative = decodeURIComponent(url.pathname).replace(/^\//, "");
    } catch {
      throw Object.assign(Error("路径无效"), { status: 400 });
    }
    if (!relative) relative = item.entry;
    if (
      relative.includes("\\") ||
      relative.includes("\0") ||
      relative.split("/").some((p) => p === ".." || p.startsWith(".")) ||
      /(^|\/)(auth\.json|password[^/]*|credentials[^/]*|access-token)$/i.test(relative)
    )
      throw Object.assign(Error("禁止访问此路径"), { status: 403 });
    const root = await realpath(path.join(this.registry.root, item.directory));
    if (!root.startsWith(this.registry.root + path.sep))
      throw Object.assign(Error("预览目录已改变"), { status: 403 });
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw Object.assign(Error("路径越界"), { status: 403 });
    const ext = path.extname(file).toLowerCase();
    if (!types[ext]) throw Object.assign(Error("不提供此类文件"), { status: 403 });
    const resolved = await realpath(file);
    if (!resolved.startsWith(root + path.sep))
      throw Object.assign(Error("禁止符号链接越界"), { status: 403 });
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let streaming = false;
    try {
      const opened = await realpath("/proc/self/fd/" + handle.fd);
      if (!opened.startsWith(root + path.sep))
        throw Object.assign(Error("文件路径已改变"), { status: 403 });
      const info = await handle.stat();
      if (!info.isFile()) throw Object.assign(Error("不是普通文件"), { status: 403 });
      const html = ext === ".html",
        etag = `W/"${html ? "preview2" : "preview1"}-${this.registry.items[name].revision}-${info.ino}-${info.size}-${info.mtimeMs}-${info.ctimeMs}"`;
      // Always authenticate and resolve the file BEFORE validating a private cache.
      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", info.mtime.toUTCString());
      res.setHeader("Vary", "Accept-Encoding");
      if (
        !req.headers.range &&
        String(req.headers["if-none-match"] || "")
          .split(/\s*,\s*/)
          .some((tag) => tag === etag || tag === "*")
      ) {
        res.writeHead(304);
        res.end();
        return;
      }
      let start = 0,
        end = info.size - 1,
        status = 200;
      // HTML is a transformed representation. Media retains byte-range seeking.
      if (req.headers.range && !html && !req.headers["if-range"]) {
        const m = String(req.headers.range).match(/^bytes=(\d*)-(\d*)$/);
        if (!m || (!m[1] && !m[2])) throw Object.assign(Error("不支持此范围"), { status: 416 });
        start = m[1] ? Number(m[1]) : Math.max(0, info.size - Number(m[2]));
        end = m[1] && m[2] ? Math.min(Number(m[2]), end) : end;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= info.size
        )
          throw Object.assign(Error("范围超出文件"), { status: 416 });
        status = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
      }
      const gzip =
        status === 200 &&
        acceptsGzip(req) &&
        /^(text\/|application\/json|image\/svg)/.test(types[ext]);
      res.setHeader("Content-Type", types[ext]);
      res.setHeader("Accept-Ranges", html ? "none" : "bytes");
      if (gzip) res.setHeader("Content-Encoding", "gzip");
      if (!html && !gzip) res.setHeader("Content-Length", Math.max(0, end - start + 1));
      res.writeHead(status);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      const stream = handle.createReadStream(
        info.size ? { start, end, autoClose: true } : { autoClose: true },
      );
      streaming = true;
      streamPreview(stream, res, { html, origin: this.config.origin, gzip });
    } finally {
      if (!streaming) await handle.close();
    }
  }
  proxy(req, res, port) {
    const headers = {
      Host: `127.0.0.1:${port}`,
      Accept: String(req.headers.accept || "*/*"),
      "Accept-Encoding": "identity",
    };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = http.request(
      { hostname: "127.0.0.1", port, method: req.method, path: req.url, headers, timeout: 15000 },
      (response) => {
        const status = response.statusCode || 502;
        const html =
          status !== 206 &&
          /text\/html/i.test(response.headers["content-type"] || "") &&
          !response.headers["content-encoding"];
        for (const key of [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
          "etag",
          "last-modified",
          "content-encoding",
        ])
          if (response.headers[key]) res.setHeader(key, response.headers[key]);
        if (html) {
          res.removeHeader("Content-Length");
          res.removeHeader("ETag");
          res.removeHeader("Accept-Ranges");
        }
        if (response.headers.location) {
          try {
            const target = new URL(response.headers.location, `http://127.0.0.1:${port}`);
            if (
              target.hostname !== "127.0.0.1" ||
              Number(target.port) !== port ||
              target.protocol !== "http:"
            )
              throw Error();
            res.setHeader("Location", target.pathname + target.search);
          } catch {
            response.destroy();
            this.error(req, res, { status: 502, message: "预览服务跳转到了未授权地址" });
            return;
          }
        }
        res.writeHead(status);
        streamPreview(response, res, {
          html: html && req.method !== "HEAD",
          origin: this.config.origin,
          error: status >= 400 ? "本地网页返回错误（" + status + "），请检查网页服务" : null,
        });
      },
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () =>
      this.error(req, res, { status: 502, message: "本地预览服务尚未启动或连接失败" }),
    );
    res.on("close", () => upstream.destroy());
    upstream.end();
  }
  close() {
    for (const socket of this.sockets) socket.destroy();
  }
  upgrade(req, socket, head) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    const name = this.name(req),
      p = this.registry.items[name]?.preview;
    if (
      !name ||
      !this.grant(req, name) ||
      req.headers.origin !== this.origin(name) ||
      p?.type !== "port" ||
      (this.registry.previewPorts && !this.registry.previewPorts.includes(p.port))
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = http.request({
      hostname: "127.0.0.1",
      port: p.port,
      path: req.url,
      headers: {
        host: `127.0.0.1:${p.port}`,
        origin: `http://127.0.0.1:${p.port}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": req.headers["sec-websocket-key"],
        "sec-websocket-version": "13",
        ...(req.headers["sec-websocket-protocol"]
          ? { "sec-websocket-protocol": req.headers["sec-websocket-protocol"] }
          : {}),
      },
      timeout: 10000,
    });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      const headers = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${response.headers["sec-websocket-accept"]}`,
      ];
      if (response.headers["sec-websocket-protocol"])
        headers.push(`Sec-WebSocket-Protocol: ${response.headers["sec-websocket-protocol"]}`);
      socket.write(headers.join("\r\n") + "\r\n\r\n");
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket).pipe(remote);
      const timer = setInterval(() => {
        if (!this.grant(req, name)) {
          remote.destroy();
          socket.destroy();
        }
      }, 15000);
      timer.unref();
      socket.on("close", () => {
        clearInterval(timer);
        remote.destroy();
      });
      remote.on("error", () => socket.destroy());
    });
    upstream.on("response", () => socket.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.on("timeout", () => upstream.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.end();
  }
}
