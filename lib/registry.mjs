import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, lstat, realpath } from "node:fs/promises";
import path from "node:path";
const exec = promisify(execFile);
export const names = ["dev", "research", "build"];
export class Registry {
  constructor({ socket, file, root, allowed = names, previewPorts = null }) {
    Object.assign(this, { socket, file, root, allowed, previewPorts });
    this.items = {};
    this.queue = Promise.resolve();
  }
  async command(args, maxBuffer = 1024 * 1024) {
    return (
      await exec("tmux", ["-S", this.socket, ...args], {
        timeout: 5000,
        maxBuffer,
        env: { ...process.env, TMUX: "" },
      })
    ).stdout;
  }
  async live() {
    try {
      const sock = await lstat(this.socket);
      const text = await this.command([
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_id}\t#{session_created}\t#{pid}\t#{session_windows}\t#{session_attached}\t#{window_width}\t#{window_height}\t#{status}",
      ]);
      return text
        .trim()
        .split("\n")
        .map((line) => {
          const [name, id, created, pid, windows, attached, cols, rows, status] = line.split("\t");
          return {
            name,
            id,
            identity: `${sock.ino}:${pid}:${id}:${created}`,
            windows: Number(windows),
            attached: Number(attached),
            cols: Number(cols) || 120,
            rows: Number(rows) || 36,
            status:
              status === "off"
                ? 0
                : status === "on"
                  ? 1
                  : Math.max(0, Math.min(5, Number(status) || 1)),
          };
        })
        .filter((s) => this.allowed.includes(s.name));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === 1) return [];
      throw error;
    }
  }
  async init() {
    try {
      this.items = JSON.parse(await readFile(this.file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      for (const s of await this.live())
        this.items[s.name] = {
          name: s.name,
          label: s.name,
          identity: s.identity,
          preview: null,
          revision: 1,
        };
      await this.save();
    }
  }
  async save() {
    const data = JSON.stringify(this.items, null, 2);
    this.queue = this.queue.then(async () => {
      await writeFile(this.file + ".next", data, { mode: 0o600 });
      await rename(this.file + ".next", this.file);
    });
    return this.queue;
  }
  async list() {
    const live = await this.live();
    return this.allowed.map((name) => {
      const item = this.items[name] || {
          name,
          label: name,
          identity: null,
          preview: null,
          revision: 0,
        },
        s = live.find((s) => s.name === name);
      return {
        ...item,
        liveIdentity: s?.identity || null,
        state: !s ? "offline" : s.identity !== item.identity ? "rebind" : "online",
        windows: s?.windows || 0,
        attached: s?.attached || 0,
      };
    });
  }
  async target(name, identity) {
    if (!this.allowed.includes(name))
      throw Object.assign(Error("会话不在允许列表"), { status: 404 });
    const item = this.items[name],
      s = (await this.live()).find((s) => s.name === name);
    if (!s) throw Object.assign(Error("会话已离线；没有自动创建新会话"), { status: 409 });
    if (!item || item.identity !== s.identity || identity !== s.identity)
      throw Object.assign(Error("会话已变化，请重新确认绑定"), { status: 409 });
    return s;
  }
  async bind(name, identity) {
    const s = (await this.live()).find((s) => s.name === name);
    if (!s || s.identity !== identity)
      throw Object.assign(Error("会话已变化，请刷新后确认"), { status: 409 });
    this.items[name] = {
      ...(this.items[name] || {}),
      name,
      label: this.items[name]?.label || name,
      identity,
      preview: null,
      revision: (this.items[name]?.revision || 0) + 1,
    };
    await this.save();
  }
  async update(name, body) {
    const item = this.items[name];
    if (!item) throw Object.assign(Error("请先绑定会话"), { status: 409 });
    if (body.revision !== item.revision)
      throw Object.assign(Error("设置已被修改，请刷新后重试"), { status: 409 });
    const label = String(body.label || name)
      .trim()
      .slice(0, 50);
    let preview = null;
    if (body.preview?.type === "static") {
      const input = String(body.preview.directory || "");
      if (
        !input ||
        path.isAbsolute(input) ||
        input.split(/[\\/]/).some((x) => !x || x === ".." || x.startsWith("."))
      )
        throw Object.assign(Error("请填写代码目录内的相对文件夹路径"), { status: 400 });
      const absolute = await realpath(path.join(this.root, input));
      if (!absolute.startsWith(this.root + path.sep))
        throw Object.assign(Error("预览目录超出允许范围"), { status: 403 });
      if (!(await lstat(absolute)).isDirectory())
        throw Object.assign(Error("预览路径不是文件夹"), { status: 400 });
      const entry = String(body.preview.entry || "index.html");
      if (
        path.isAbsolute(entry) ||
        entry.split(/[\\/]/).some((x) => !x || x === ".." || x.startsWith(".")) ||
        !entry.endsWith(".html")
      )
        throw Object.assign(Error("入口必须是目录内的 HTML 文件"), { status: 400 });
      preview = { type: "static", directory: input, entry };
    } else if (body.preview?.type === "port") {
      const port = Number(body.preview.port);
      if (
        !Number.isInteger(port) ||
        port < 1024 ||
        port > 65535 ||
        (this.previewPorts && !this.previewPorts.includes(port)) ||
        [8000, 8787, 8790, 8791, 18787, 18788, 18790, 18791, 2019].includes(port)
      )
        throw Object.assign(Error("该端口不能用于网页预览"), { status: 400 });
      preview = { type: "port", port };
    } else if (body.preview?.type && body.preview.type !== "none")
      throw Object.assign(Error("未知预览类型"), { status: 400 });
    if (this.items[name] !== item)
      throw Object.assign(Error("设置已被修改，请刷新后重试"), { status: 409 });
    this.items[name] = { ...item, label, preview, revision: item.revision + 1 };
    await this.save();
    return this.items[name];
  }
}
