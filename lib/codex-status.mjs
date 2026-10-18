import { homedir } from "node:os";
import { CodexDaemon } from "./codex-daemon.mjs";

const fail = (message) => Object.assign(Error(message), { status: 409 });
const clean = (text) =>
  text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u2800-\u28ff]/g, " ");

// Only the contextual footer, not a /status card, title, or quoted output.
// Duplicate/unnamed/truncated threads are ambiguous: never guess from recency.
export function focusedThread(screen, threads) {
  const lines = clean(screen).split(/\r?\n/).slice(-5);
  const candidates = threads.filter(
    (thread) =>
      ["cli", "vscode"].includes(thread.source) &&
      !thread.parentThreadId &&
      typeof thread.name === "string" &&
      thread.name &&
      thread.name.length <= 240,
  );
  const matches = new Set();
  const composer = lines.findLastIndex((line) => /^\s*[›❯»]/.test(line));
  for (let index = composer + 1; index < lines.length; index++) {
    const line = lines[index];
    const footer = line.trim().split(/\s{3,}/)[0],
      parts = footer.split(" · ");
    if (
      parts.length < 3 ||
      !/^GPT-[\w.-]+(?:\s+(?:minimal|low|medium|high|xhigh|xxhigh|max|ultra|auto))?$/i.test(
        parts[0],
      )
    )
      continue;
    if (parts.length > 3 && (parts.length !== 4 || parts[3] !== "Main [default]")) continue;
    for (const thread of candidates)
      if (parts[1] === thread.cwd && parts[2] === thread.name) matches.add(thread.id);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

// Passive foreground verification: never send keys, clear drafts, or lease input.
export class CodexStatus {
  constructor(
    registry,
    _writers,
    { home = homedir() + "/.codex", daemon = new CodexDaemon(home) } = {},
  ) {
    this.registry = registry;
    this.daemon = daemon;
  }
  async probe(name, identity, { expectedMeta } = {}) {
    const target = await this.registry.target(name, identity);
    const format = "#{pane_id}\t#{pane_pid}\t#{pane_height}\t#{pane_in_mode}";
    const meta = (
      await this.registry.command(["display-message", "-p", "-t", target.id, format])
    ).trim();
    if (expectedMeta && meta !== expectedMeta) throw fail("终端窗口已切换，请刷新聊天。");
    const [pane, pid, height, mode] = meta.split("\t"),
      rows = Number(height);
    if (
      !/^%\d+$/.test(pane) ||
      !/^\d+$/.test(pid) ||
      !Number.isInteger(rows) ||
      rows < 1 ||
      rows > 1000 ||
      mode !== "0"
    )
      throw fail("原终端当前不能核对会话。");
    const capture = () =>
      this.registry.command(
        [
          "capture-pane",
          "-p",
          "-t",
          pane,
          "-S",
          String(Math.max(0, rows - 16)),
          "-E",
          String(rows - 1),
        ],
        32768,
      );
    const before = await capture(),
      threads = await this.daemon.snapshot(),
      thread = focusedThread(before, threads);
    if (!thread || focusedThread(await capture(), threads) !== thread)
      throw fail("当前 Codex 会话身份不明确，请稍后刷新。");
    await this.registry.target(name, identity);
    if (
      (await this.registry.command(["display-message", "-p", "-t", target.id, format])).trim() !==
      meta
    )
      throw fail("终端窗口已切换，请刷新聊天。");
    return { thread, pane, pid: Number(pid), meta };
  }
}
