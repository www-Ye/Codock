import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { terminalStatus } from "./terminal-status.mjs";

const fail = (message) => Object.assign(Error(message), { status: 409 });
// Only the user's exact text, bracketed paste, then Enter in the original pane.
// Session identity belongs to routing, never to the user's Codex input.
// No queue command, resume, Escape, draft clearing or approval keystrokes.
export class ChatInput {
  constructor(chats, terminals) {
    this.chats = chats;
    this.registry = chats.registry;
    this.terminals = terminals;
  }
  async target(name, entry, { afterPaste = false, priorFooter = "" } = {}) {
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
    const request = {
      pid: Number(pid),
      pane,
      socket: this.registry.socket,
      home: this.chats.home,
      binding: entry.binding,
    };
    const view = this.chats.readBound
      ? await this.chats.readBound(name, entry.identity, request, { expectedMeta: meta })
      : await this.chats.read(request);
    if (!view.available || view.readOnly || view.binding !== entry.binding)
      throw fail("原对话尚未核实，消息未发送。请刷新聊天。");
    const capture = () =>
      this.registry.command(
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
    let footer = await capture();
    if (
      /enter to (?:confirm|submit|select)/i.test(footer) ||
      /^\s*[›❯»]\s*\d+[.)]\s+\S/m.test(footer)
    )
      throw fail(
        "原会话正在等待选择；可先在聊天中的问题卡片回答，无法识别时再打开现场。不会自动确认审批。",
      );
    const lines = footer
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u2800-\u28ff]/g, " ")
      .split(/\r?\n/);
    const composer = [...lines].reverse().find((line) => /^\s*[›❯»]/.test(line));
    if (composer && !afterPaste) {
      const draft = composer.replace(/^\s*[›❯»]/, "").trim();
      if (draft && !/^Ask Codex to do anything[.…]*$/i.test(draft))
        throw fail("原终端已有未发送的输入，请先在原终端处理；网页消息没有发出。");
    }
    let state = terminalStatus(footer, { provider: view.provider }).state;
    // A long pasted composer can push its chevron above the last 18 rows.
    // In that one case require fresh, exact visible tail evidence; do not
    // infer submission from paste-buffer succeeding or send Enter blindly.
    if (afterPaste && state === "unknown") {
      const compact = (value) =>
        value
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .replace(/[\u2800-\u28ff]/g, "")
          .replace(/\s+/g, "");
      const tail = compact(entry.text).slice(-24);
      const appeared = () =>
        tail.length === 24 &&
        !compact(priorFooter).includes(tail) &&
        compact(footer).includes(tail);
      for (let attempt = 0; attempt < 3 && !appeared(); attempt++) {
        await delay(120);
        footer = await capture();
        state = terminalStatus(footer, { provider: view.provider }).state;
        if (state !== "unknown") break;
      }
      if (state === "unknown" && appeared()) state = "pasted";
    }
    if (entry.transport === "terminal-model" && state !== "ready")
      throw fail("原会话尚未空闲，模型菜单没有打开。请稍后再试。");
    if (!["ready", "running", "pasted"].includes(state))
      throw fail("暂时无法确认原终端的输入状态，文字未发送；请打开「终端」页查看。");
    await this.registry.target(name, entry.identity);
    if (
      (await this.registry.command(["display-message", "-p", "-t", session.id, format])).trim() !==
      meta
    )
      throw fail("终端窗口已变化，消息未发送。");
    return { pane, meta, footer };
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
    const buffer = "duck-chat-" + randomUUID();
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
      const after = await this.target(name, entry, {
        afterPaste: true,
        priorFooter: before.footer,
      });
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
            ? "文字已粘贴，但尚未按回车。请在「终端」页核对；提交后网页会自动核对回执。"
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
