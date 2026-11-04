import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { terminalStatus, captureTerminalFooter } from "./terminal-status.mjs";

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
  async target(name, entry, { afterPaste = false, priorFooter = "", proof } = {}) {
    const session = await this.registry.target(name, entry.identity);
    const format = "#{pane_id}\t#{pane_pid}\t#{pane_height}\t#{pane_in_mode}\t#{@desk_account}";
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
      home: this.chats.homeFromMeta ? this.chats.homeFromMeta(meta) : this.chats.home,
      claudeHome: this.chats.claudeHome,
      binding: entry.binding,
    };
    // Typing replaces Codex's identity footer with "tab to queue message".
    // Only this in-flight paste may carry its just-verified identity forward.
    // The reader still checks the actual Codex PID/start time and history;
    // never reuse this proof for another send or after changing panes/accounts.
    if (
      proof &&
      (!afterPaste ||
        proof.meta !== meta ||
        proof.binding !== entry.binding ||
        Date.now() - proof.checkedAt > 5000)
    )
      throw fail("终端窗口或发送核对已变化，未自动提交。");
    const view = proof
      ? await this.chats.read({ ...request, verifiedThread: proof.binding.split(":")[2] })
      : this.chats.readBound
        ? await this.chats.readBound(name, entry.identity, request, {
            expectedMeta: meta.split("\t").slice(0, 4).join("\t"),
          })
        : await this.chats.read(request);
    if (!view.available || view.readOnly || view.binding !== entry.binding) {
      const error = fail("原对话尚未核实，消息未发送。请刷新聊天。");
      error.retryIdentity =
        view.reason !== "changed" && (!view.binding || view.binding === entry.binding);
      throw error;
    }
    if (entry.historyVersion && entry.historyVersion !== view.historyVersion)
      throw fail("原对话历史已切换，请核对当前聊天；没有自动提交。");
    const capture = () => captureTerminalFooter(this.registry, pane, Number(height), 18);
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
    return { pane, meta, footer, binding: view.binding, checkedAt: Date.now() };
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
      let after,
        rechecked = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          after = await this.target(name, entry, {
            afterPaste: true,
            priorFooter: before.footer,
            proof: this.chats.readBound ? checked : undefined,
          });
          break;
        } catch (error) {
          if (!error.retryIdentity || attempt === 2) throw error;
          rechecked = true;
          await delay(200);
        }
      }
      if (after.meta !== before.meta) throw fail("终端窗口已变化");
      if (rechecked) {
        // Retry only the read, never the paste. If the user submitted or edited
        // during the wait, do not append another Enter to the new composer.
        const lines = after.footer
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          .replace(/[\u2800-\u28ff]/g, " ")
          .split(/\r?\n/);
        const composer = [...lines].reverse().find((line) => /^\s*[›❯»]/.test(line));
        const draft = composer?.replace(/^\s*[›❯»]\s?/, "").trim(),
          first = entry.text.split(/\r?\n/)[0].trim();
        if (!first || !draft || draft !== first)
          throw fail("核对期间输入已变化，未再次按回车；请查看原终端");
      }
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
