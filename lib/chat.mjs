import path from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { observeTerminal, terminalStatus } from "./terminal-status.mjs";
const reader = fileURLToPath(new URL("./codex-reader.py", import.meta.url));
const reasons = {
  unavailable: "还不能可靠识别这个终端的 Codex 对话，请在原终端继续。",
  format: "这个会话使用较旧的记录格式，暂时请在原终端查看。",
  changed: "原对话已切换，请重新载入聊天。",
};
export class Chats {
  constructor(registry, { home = path.join(homedir(), ".codex"), read } = {}) {
    this.registry = registry;
    this.home = home;
    this.read = read || this.readProcess;
    this.pending = new Map();
  }
  readProcess(input) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "python3",
        ["-B", reader],
        {
          timeout: 6500,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        },
        (error, stdout) => {
          if (error) {
            reject(
              Object.assign(Error("对话读取暂时超时，请重试；原会话未受影响。"), { status: 503 }),
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(Object.assign(Error("对话记录暂时无法读取"), { status: 503 }));
          }
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input));
    });
  }
  async page(name, query, { lookup } = {}) {
    const identity = query.get("identity");
    const target = await this.registry.target(name, identity);
    const binding = query.get("binding"),
      revision = query.get("revision");
    const raw = query.get("before"),
      before = raw === null ? undefined : Number(raw);
    if (
      (raw !== null && (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(before) || !binding)) ||
      (binding && !/^\d+:\d+:[a-f0-9-]{36}$/.test(binding)) ||
      (revision && !/^\d{1,16}$/.test(revision))
    )
      throw Object.assign(Error("聊天分页参数无效"), { status: 400 });
    const paneFormat = "#{pane_id}\t#{pane_pid}\t#{pane_height}\t#{pane_in_mode}";
    const meta = (
      await this.registry.command(["display-message", "-p", "-t", target.id, paneFormat])
    ).trim();
    const pane = meta.split("\t").slice(0, 2).join("\t");
    const [paneId, pid] = pane.split("\t");
    if (!/^%\d+$/.test(paneId) || !/^\d+$/.test(pid))
      throw Object.assign(Error("终端已变化，请刷新"), { status: 409 });
    const key = JSON.stringify([name, identity, meta, binding, before, revision, lookup]);
    if (!this.pending.has(key)) {
      if (this.pending.size >= 4)
        throw Object.assign(Error("正在读取其他对话，请稍后再试"), { status: 429 });
      this.pending.set(
        key,
        this.read({ pid: Number(pid), home: this.home, binding, before, revision, lookup })
          .then(async (result) => ({
            ...result,
            runtime:
              !lookup && (result.available || result.reason === "format")
                ? await observeTerminal(this.registry, meta)
                : terminalStatus(null),
          }))
          .finally(() => this.pending.delete(key)),
      );
    }
    const result = await this.pending.get(key);
    await this.registry.target(name, identity);
    const latest = (
      await this.registry.command(["display-message", "-p", "-t", target.id, paneFormat])
    ).trim();
    if (pane !== latest.split("\t").slice(0, 2).join("\t"))
      throw Object.assign(Error("终端窗口已切换，请刷新聊天"), { status: 409 });
    return {
      ...result,
      runtime: meta === latest ? result.runtime : terminalStatus(null),
      ...(!result.available ? { message: reasons[result.reason] || reasons.unavailable } : {}),
      readOnly: !result.available,
      sendMode: result.available ? "terminal-enter" : null,
    };
  }
}
