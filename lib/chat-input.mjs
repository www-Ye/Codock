import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { terminalStatus } from "./terminal-status.mjs";

const fail = (message) => Object.assign(Error(message), { status: 409 });
// Only the user's exact text, bracketed paste, then Enter in the original pane.
// No queue command, resume, Escape, draft clearing or approval keystrokes.
export class ChatInput {
  constructor(chats, terminals) {
    this.chats = chats;
    this.registry = chats.registry;
    this.terminals = terminals;
  }
  async target(name, entry) {
    const session = await this.registry.target(name, entry.identity);
    const format = "#{pane_id}\t#{pane_pid}\t#{pane_height}\t#{pane_in_mode}";
    const meta = (
      await this.registry.command(["display-message", "-p", "-t", session.id, format])
    ).trim();
    const [pane, pid, height, mode] = meta.split("\t");
    if (
      !/^%\d+$/.test(pane) ||
      !/^\d+$/.test(pid) ||
      !/^\d+$/.test(height) ||
      Number(height) < 1 ||
      Number(height) > 1000 ||
      mode !== "0"
    )
      throw fail("原终端正在查看历史或已变化，请先回到输入界面。");
    const view = await this.chats.read({
      pid: Number(pid),
      home: this.chats.home,
      binding: entry.binding,
    });
    if (!view.available || view.binding !== entry.binding)
      throw fail("原 Codex 已变化，消息未发送。请刷新聊天。");
    const footer = await this.registry.command(
      [
        "capture-pane",
        "-p",
        "-t",
        pane,
        "-S",
        String(Math.max(0, Number(height) - 18)),
        "-E",
        String(Number(height) - 1),
      ],
      32768,
    );
    if (
      /enter to (?:confirm|submit|select)/i.test(footer) ||
      /^\s*[›❯]\s*\d+[.)]\s+\S/m.test(footer)
    )
      throw fail("原终端正在等待选择，请在终端处理；不会自动确认审批。");
    const state = terminalStatus(footer).state;
    if (!["ready", "running"].includes(state))
      throw fail("暂时无法确认原终端的输入状态，文字未发送；可打开「现场 / 按键」查看。");
    await this.registry.target(name, entry.identity);
    if (
      (await this.registry.command(["display-message", "-p", "-t", session.id, format])).trim() !==
      meta
    )
      throw fail("终端窗口已变化，消息未发送。");
    return { pane, meta };
  }
  buffer(name, text) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "tmux",
        ["-S", this.registry.socket, "load-buffer", "-b", name, "-"],
        { timeout: 5000, maxBuffer: 32768, env: { ...process.env, TMUX: "" } },
        (error) => (error ? reject(Error("无法准备终端输入")) : resolve()),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    });
  }
  async send(name, entry) {
    const writers = this.terminals.writers;
    if (writers.has(name))
      return { state: "failed", message: "另一个网页正在输入，请先在那里切回只读。" };
    const lease = { chat: true };
    writers.set(name, lease);
    const buffer = "workbench-chat-" + randomUUID();
    let touched = false,
      stage = "validate";
    try {
      const before = await this.target(name, entry);
      await this.buffer(buffer, entry.text);
      const checked = await this.target(name, entry);
      if (checked.meta !== before.meta) throw fail("终端窗口已变化，消息未发送。");
      touched = true;
      stage = "paste";
      await this.registry.command([
        "paste-buffer",
        "-p",
        "-r",
        "-d",
        "-b",
        buffer,
        "-t",
        before.pane,
      ]);
      stage = "verify-before-enter";
      // Let Codex finish processing bracketed paste before the submit key.
      await delay(120);
      const after = await this.target(name, entry);
      if (after.meta !== before.meta) throw fail("终端窗口已变化");
      stage = "enter";
      await this.registry.command(["send-keys", "-t", before.pane, "Enter"]);
      return { state: "submitted" };
    } catch (error) {
      return {
        state: touched ? "unknown" : "failed",
        deliveryStage: stage,
        reason: error.status === 409 ? error.message : "终端操作未确认",
        message: touched
          ? stage === "verify-before-enter"
            ? "文字已粘贴，但尚未按回车。请在「现场 / 按键」核对；提交后网页会自动核对回执。"
            : "文字可能已写入原终端，但回车未确认。请查看原终端，不要重复发送。"
          : error.status === 409
            ? error.message
            : "终端暂时无法连接，消息未发送。",
      };
    } finally {
      await this.registry.command(["delete-buffer", "-b", buffer]).catch(() => {});
      if (writers.get(name) === lease) writers.delete(name);
    }
  }
}
