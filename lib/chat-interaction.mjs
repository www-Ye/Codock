import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { terminalStatus } from "./terminal-status.mjs";

const fail = (message, status = 409) => Object.assign(Error(message), { status });

// Only a visible Codex questionnaire is eligible. Ordinary output, queued
// follow-up text, approvals and a ready composer are never actionable here.
export function parseQuestion(screen, pane) {
  if (typeof screen !== "string" || screen.length > 32768) return null;
  const lines = screen
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u2800-\u28ff]/g, " ")
    .split(/\r?\n/);
  const at = lines.findLastIndex((line) =>
    /^\s*Question\s+[1-9]\d*\/[1-9]\d*(?:\s*\(\d+\s+unanswered\))?(?:\s*[·•].*)?\s*$/i.test(line),
  );
  if (
    at < 0 ||
    lines.slice(at + 1).some((line) => /^\s*[›❯»]\s*Ask Codex to do anything/i.test(line))
  )
    return null;
  const question = [],
    choices = [];
  for (const line of lines.slice(at + 1)) {
    const option = line.match(/^\s*([›❯»])?\s*([1-9]\d?)[.)]\s+(.{1,180}?)\s*$/);
    if (option) {
      choices.push({
        index: Number(option[2]),
        label: option[3].trim(),
        selected: Boolean(option[1]),
      });
      continue;
    }
    if (!choices.length && line.trim() && !/^(?:enter|esc|shift\s*\+)/i.test(line.trim()))
      question.push(line.trim());
  }
  if (
    choices.length < 2 ||
    choices.length > 10 ||
    choices.filter((c) => c.selected).length !== 1 ||
    new Set(choices.map((c) => c.index)).size !== choices.length ||
    !question.length
  )
    return null;
  const title = question.join(" ").slice(0, 500);
  const token = createHash("sha256")
    .update(JSON.stringify([pane, lines[at].trim(), title, choices.map((c) => [c.index, c.label])]))
    .digest("hex")
    .slice(0, 24);
  return { title, choices, token };
}

// Only single-choice native dialogs with an explicit submit hint. Multi-select,
// free-text, wrapped options or a clipped command stay in the embedded terminal.
export function parseClaudeQuestion(screen) {
  if (typeof screen !== "string" || screen.length > 16000) return null;
  const lines = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  if (
    !/enter to (?:confirm|submit|select)/i.test(screen) ||
    /space to (?:select|toggle)|\[[ x]\]/i.test(screen) ||
    lines.some((line) => /^\s*❯(?!\s*\d+[.)])/.test(line))
  )
    return null;
  const choices = [],
    context = [];
  let choosing = false;
  for (const line of lines) {
    const option = line.match(/^\s*(❯)?\s*([1-9]\d?)[.)]\s+(.{1,180}?)\s*$/);
    if (option) {
      choosing = true;
      choices.push({ index: Number(option[2]), label: option[3], selected: Boolean(option[1]) });
    } else if (!choosing) context.push(line.trim());
    else if (line.trim() && !/enter to|esc to|^[-─━\s]+$/i.test(line)) return null;
  }
  if (
    choices.length < 2 ||
    choices.length > 10 ||
    choices.filter((c) => c.selected).length !== 1 ||
    choices.some((c, i) => c.index !== i + 1)
  )
    return null;
  const title = context.filter((line) => line && !/^[-─━]+$/.test(line)).join("\n");
  if (!title || title.length > 8000) return null;
  const permission =
    /do you want to (?:proceed|allow|make|create|edit)|allow Claude|permission|Bash command|Edit file|Create file/i.test(
      title,
    );
  // A visible question alone is insufficient: a long command may have scrolled
  // off the capture. Require the operation header, and no collapsed body.
  if (
    permission &&
    (!/^(?:Bash command|Edit file|Create file)(?:\s|$)/.test(title) ||
      /\(\+\d+ lines|ctrl\+o to expand|…|\.\.\./i.test(title))
  )
    return null;
  if (!permission && !/\?|？/.test(title)) return null;
  return {
    title,
    choices,
    kind: permission ? "permission" : "question",
    fingerprint: JSON.stringify([title, choices.map((c) => [c.index, c.label])]),
  };
}

export class ChatInteraction {
  constructor(chats, terminals) {
    this.chats = chats;
    this.registry = chats.registry;
    this.terminals = terminals;
    this.answered = new Map();
    this.interrupted = new Map();
    this.questionTokens = new Map();
  }
  async inspect(name, identity, binding) {
    if (typeof identity !== "string" || typeof binding !== "string") throw fail("请先载入原对话");
    const view = await this.chats.page(name, new URLSearchParams({ identity, binding }));
    if (!view.available || view.readOnly || view.binding !== binding)
      throw fail("原对话尚未核实，请在「终端」继续");
    const target = await this.registry.target(name, identity);
    const format = "#{pane_id}\t#{pane_pid}\t#{pane_height}\t#{pane_in_mode}";
    const meta = (
      await this.registry.command(["display-message", "-p", "-t", target.id, format])
    ).trim();
    const [pane, , height, mode] = meta.split("\t");
    if (
      !/^%\d+$/.test(pane) ||
      !Number.isInteger(Number(height)) ||
      Number(height) < 1 ||
      Number(height) > 1000 ||
      mode !== "0"
    )
      throw fail("终端界面暂时无法确认");
    const screen = await this.registry.command(
      [
        "capture-pane",
        "-p",
        "-t",
        pane,
        "-S",
        String(Math.max(0, Number(height) - 24)),
        "-E",
        String(Number(height) - 1),
      ],
      32768,
    );
    const question =
      view.provider === "claude" ? parseClaudeQuestion(screen) : parseQuestion(screen, pane);
    if (question && view.provider === "claude") {
      const proof = JSON.stringify([identity, binding, meta, view.revision, question.fingerprint]);
      if (this.questionTokens.get(name)?.proof !== proof)
        this.questionTokens.set(name, { proof, token: randomBytes(12).toString("hex") });
      question.token = this.questionTokens.get(name).token;
      delete question.fingerprint;
    } else if (question)
      question.token = createHash("sha256")
        .update(question.token + ":" + (view.revision || ""))
        .digest("hex")
        .slice(0, 24);
    else this.questionTokens.delete(name);
    const busy =
      view.provider === "claude"
        ? terminalStatus(screen, { provider: "claude" }).state === "running"
        : /(?:^|\n)\s*[•●◦][^\n]{0,240}\(\s*\d+\s*[smhd][^\n]{0,100}(?:\n[^\n]{0,100})?esc to interrupt/i.test(
            screen,
          );
    return { meta, pane, question, busy };
  }
  async page(name, identity, binding) {
    const current = await this.inspect(name, identity, binding);
    return current.question ? { available: true, ...current.question } : { available: false };
  }
  async answer(name, input) {
    const { identity, binding, token, index, confirm } = input || {};
    if (
      confirm !== true ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > 10 ||
      typeof token !== "string" ||
      !/^[a-f0-9]{24}$/.test(token)
    )
      throw fail("回答参数无效", 400);
    if (this.terminals.writers.has(name)) throw fail("另一个网页正在输入，请先在那里切回只读");
    const lease = { question: true };
    this.terminals.writers.set(name, lease);
    try {
      const first = await this.inspect(name, identity, binding);
      if (!first.question || first.question.token !== token) throw fail("问题已经变化，请刷新聊天");
      const options = first.question.choices,
        chosen = options.find((c) => c.index === index),
        selected = options.find((c) => c.selected);
      if (!chosen) throw fail("选项已经变化，请刷新聊天");
      const from = options.indexOf(selected),
        to = options.indexOf(chosen);
      for (let step = 0; step < Math.abs(to - from); step++)
        await this.registry.command(["send-keys", "-t", first.pane, to > from ? "Down" : "Up"]);
      if (to !== from) await delay(80);
      const checked = await this.inspect(name, identity, binding);
      if (
        checked.meta !== first.meta ||
        checked.question?.token !== token ||
        checked.question.choices.find((c) => c.selected)?.index !== index
      )
        throw fail("选项未能核对，尚未确认；请刷新聊天");
      const key = JSON.stringify([name, identity, binding, checked.pane, token]),
        now = Date.now();
      if (this.answered.has(key)) throw fail("这道题已经提交过，请等待原对话继续，不会重复按回车");
      this.answered.set(key, now);
      for (const [old, when] of this.answered)
        if (now - when > 600000 || this.answered.size > 256) this.answered.delete(old);
      await this.registry.command(["send-keys", "-t", first.pane, "Enter"]);
      return { state: "submitted", message: "选择已交给原会话，等待对话继续。" };
    } finally {
      if (this.terminals.writers.get(name) === lease) this.terminals.writers.delete(name);
    }
  }
  async interrupt(name, input) {
    const { identity, binding, requestId, confirm } = input || {};
    if (
      confirm !== true ||
      typeof requestId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId)
    )
      throw fail("中断参数无效", 400);
    if (this.terminals.writers.has(name)) throw fail("另一个网页正在输入，请先在那里切回只读");
    const lease = { interrupt: true };
    this.terminals.writers.set(name, lease);
    try {
      const key = JSON.stringify([name, identity, binding]),
        now = Date.now();
      if (now - (this.interrupted.get(key)?.when || 0) < 10000)
        throw fail("这段对话刚刚收到一次中断，不会重复发送 Esc");
      const first = await this.inspect(name, identity, binding);
      if (!first.busy || first.question) throw fail("当前没有可确认的运行中任务；未发送中断");
      const checked = await this.inspect(name, identity, binding);
      if (
        checked.meta !== first.meta ||
        checked.pane !== first.pane ||
        !checked.busy ||
        checked.question
      )
        throw fail("运行状态已经变化；未发送中断");
      this.interrupted.set(key, { when: now, requestId });
      for (const [old, value] of this.interrupted)
        if (now - value.when > 600000 || this.interrupted.size > 256) this.interrupted.delete(old);
      await this.registry.command(["send-keys", "-t", first.pane, "Escape"]);
      return { state: "submitted", message: "已向当前会话发送一次中断；稍后查看聊天结果。" };
    } finally {
      if (this.terminals.writers.get(name) === lease) this.terminals.writers.delete(name);
    }
  }
}
