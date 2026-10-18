import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { observeTerminal, terminalStatus } from "./terminal-status.mjs";
import { CodexStatus } from "./codex-status.mjs";
const reader = fileURLToPath(new URL("./agent-reader.py", import.meta.url));
const reasons = {
  unavailable: "还不能可靠识别这个终端的对话，请在原终端继续。",
  unverified_claude: "暂时无法核对当前 Claude Code 会话，请稍后刷新。",
  unverified_codex: "暂时无法核对当前 Codex 会话，请稍后刷新。",
  format: "这个会话使用较旧的记录格式，暂时请在原终端查看。",
  changed: "原对话已切换，请重新载入聊天。",
};
export class Chats {
  constructor(
    registry,
    {
      home = homedir() + "/.codex",
      claudeHome = homedir() + "/.claude",
      read,
      writers,
      status,
    } = {},
  ) {
    this.registry = registry;
    this.home = home;
    this.claudeHome = claudeHome;
    this.read = read || this.readProcess;
    this.pending = new Map();
    this.status = status || (writers && new CodexStatus(registry, writers, { home }));
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
  async readBound(name, identity, input, { expectedMeta } = {}) {
    input = { ...input, claudeHome: this.claudeHome };
    if (!this.status) return this.read(input);
    // Identify first without parsing a possibly enormous, outdated launch history.
    const raw = await this.read({ ...input, identityOnly: true });
    // Never probe a Claude pane with a Codex-specific identity command.
    if (raw.provider === "claude") return raw.available ? this.read(input) : raw;
    if (raw.available && !raw.readOnly) return this.read(input);
    try {
      const current = await this.status.probe(name, identity, { expectedMeta });
      if (current.pane !== input.pane || current.pid !== input.pid)
        return { available: false, reason: "changed" };
      return this.read({ ...input, verifiedThread: current.thread });
    } catch {
      return raw.available ? this.read(input) : raw;
    }
  }
  async verifyCurrent(name, identity, binding) {
    if (!this.status) return;
    const target = await this.registry.target(name, identity);
    const meta = (
      await this.registry.command([
        "display-message",
        "-p",
        "-t",
        target.id,
        "#{pane_id}\t#{pane_pid}\t#{pane_height}\t#{pane_in_mode}",
      ])
    ).trim();
    const [pane, pid] = meta.split("\t");
    const result = await this.readBound(
      name,
      identity,
      {
        pid: Number(pid),
        pane,
        socket: this.registry.socket,
        home: this.home,
        claudeHome: this.claudeHome,
        binding,
      },
      { expectedMeta: meta },
    );
    if (!result.available || result.readOnly || result.binding !== binding)
      throw Object.assign(Error("无法再次确认原对话，消息没有发出。"), { status: 409 });
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
        this.readBound(
          name,
          identity,
          {
            pid: Number(pid),
            pane: paneId,
            socket: this.registry.socket,
            home: this.home,
            claudeHome: this.claudeHome,
            binding,
            before,
            revision,
            lookup,
          },
          { expectedMeta: meta },
        )
          .then(async (result) => ({
            ...result,
            runtime: !lookup
              ? await observeTerminal(this.registry, meta, { provider: result.provider })
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
      readOnly: !result.available || Boolean(result.readOnly),
      sendMode: result.available && !result.readOnly ? "terminal-enter" : null,
      ...(result.readOnly
        ? {
            identityNotice:
              "当前对话暂时无法核对，暂时只能查看。请先处理原终端中的输入或选项，再刷新聊天。",
          }
        : {}),
    };
  }
}
