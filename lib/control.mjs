import http from "node:http";
import net from "node:net";
import path from "node:path";
import { lstat, realpath, chmod, unlink } from "node:fs/promises";

const fail = (message, status = 400) => Object.assign(Error(message), { status });
export async function bindPreview(registry, origin, body) {
  const { session, directory, entry = "index.html" } = body;
  if (typeof session !== "string" || !registry.allowed.includes(session))
    throw fail("会话不在终端台允许列表", 404);
  const item = registry.items[session];
  await registry.target(session, item?.identity);
  if (typeof directory !== "string" || !directory) throw fail("请提供网页目录");
  const absolute = await realpath(path.resolve(registry.root, directory));
  if (!absolute.startsWith(registry.root + path.sep))
    throw fail("网页目录必须位于代码目录的专用子目录内", 403);
  if (!(await lstat(absolute)).isDirectory()) throw fail("网页目录不是文件夹");
  if (
    typeof entry !== "string" ||
    path.isAbsolute(entry) ||
    entry.split(/[\\/]/).some((p) => !p || p === ".." || p.startsWith(".")) ||
    !entry.endsWith(".html")
  )
    throw fail("入口必须是目录内的 HTML 文件");
  const page = await realpath(path.join(absolute, entry));
  if ((await lstat(path.join(absolute, entry))).isSymbolicLink())
    throw fail("HTML 入口必须是实际文件，不能是符号链接", 403);
  if (!page.startsWith(absolute + path.sep)) throw fail("HTML 入口不能跳出网页目录", 403);
  if (!(await lstat(page)).isFile()) throw fail("HTML 入口不是文件");
  const preview = { type: "static", directory: path.relative(registry.root, absolute), entry };
  const same = JSON.stringify(item.preview) === JSON.stringify(preview);
  if (item.preview && !same)
    throw fail("该会话已绑定其他网页。保留现有绑定；请先征得用户同意，再通过网页设置更换。", 409);
  // Registry.update performs optimistic revision checks against browser edits.
  if (!same)
    await registry.update(session, { label: item.label, revision: item.revision, preview });
  else if (registry.items[session] !== item) throw fail("绑定已被修改，请重试", 409);
  return { ok: true, changed: !same, session, preview, url: origin + "/s/" + session + "#preview" };
}

// Filesystem owner only. Never mounted on the public HTTP server, and does not
// issue login cookies, OAuth tokens or preview tickets.
export async function startControl({ registry, config }) {
  const socketPath = path.join(config.runtime, "control.sock");
  const dir = await lstat(config.runtime);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== process.getuid() ||
    dir.mode & 0o077
  )
    throw Error("Control runtime must be owner-only (0700)");
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket() || existing.uid !== process.getuid())
      throw Error("Unsafe control socket path");
    const active = await new Promise((resolve, reject) => {
      const client = net.connect(socketPath);
      client.once("connect", () => {
        client.destroy();
        resolve(true);
      });
      client.once("error", (e) => {
        if (["ECONNREFUSED", "ENOENT"].includes(e.code)) resolve(false);
        else reject(e);
      });
      client.setTimeout(1000, () => {
        client.destroy();
        reject(Error("Control socket probe timed out"));
      });
    });
    if (active) throw Error("Control socket already in use");
    await unlink(socketPath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.headers.origin || req.method !== "POST" || req.url !== "/preview")
        throw fail("Unsupported local control request", 403);
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 8192) throw fail("请求过大", 413);
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw fail("请求格式错误");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("请求格式错误");
      reply(200, await bindPreview(registry, config.origin, body));
    } catch (e) {
      reply(e.status || (e.code === "ENOENT" ? 404 : 500), {
        error:
          e.code === "ENOENT"
            ? "网页目录或 HTML 入口不存在"
            : e.status
              ? e.message
              : "本地绑定失败，请检查服务状态",
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
