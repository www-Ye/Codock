import { homedir } from "node:os";
import { CodexDaemon } from "./codex-daemon.mjs";
import { captureTerminalFooter } from "./terminal-status.mjs";

const fail = (message) => Object.assign(Error(message), { status: 409 });
const clean = (text) =>
  text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u2800-\u28ff]/g, " ");
const navigationHint = (text, full) =>
  text === full ||
  (typeof text === "string" &&
    text.endsWith("…") &&
    text.length >= 4 &&
    full.startsWith(text.slice(0, -1)));

// Only the contextual footer, not a /status card, title, or quoted output.
// Duplicate/unnamed/truncated threads are ambiguous: never guess from recency.
export function focusedThread(screen, threads) {
  const lines = clean(screen).trimEnd().split(/\r?\n/).slice(-5);
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
      !/^GPT-[\w.-]+(?:\s+(?:minimal|low|medium|high|xhigh|xxhigh|max|ultra|auto))?(?:\s+fast)?$/i.test(
        parts[0],
      )
    )
      continue;
    // Compact TUI layouts put navigation hints on the identity row. They are
    // not an agent role; keep rejecting actual worker/unknown role suffixes.
    // Narrow panes can elide navigation and place a goal badge immediately
    // beside it. Normalize only the tail, never the cwd, name or agent role.
    const tail = parts
      .slice(3)
      .join(" · ")
      .replace(/(?:^|\s+)Goal [^·\r\n]*\(\/goal(?:\s+[^)\r\n]*)?\)$/, "")
      .trim();
    const suffix = tail ? tail.split(" · ") : [];
    if (suffix[0] === "Main [default]") suffix.shift();
    if (navigationHint(suffix[0], "← for agents")) suffix.shift();
    if (navigationHint(suffix[0], "? for shortcuts")) suffix.shift();
    if (suffix.length) continue;
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
    this.home = home;
    this.daemon = daemon;
    this.daemons = new Map();
  }
  async probe(name, identity, { expectedMeta, home = this.home } = {}) {
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
    const capture = () => captureTerminalFooter(this.registry, pane, rows);
    if (home !== this.home && !this.daemons.has(home))
      this.daemons.set(home, new CodexDaemon(home));
    const daemon = home === this.home ? this.daemon : this.daemons.get(home);
    const before = await capture(),
      threads = await daemon.snapshot(),
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
