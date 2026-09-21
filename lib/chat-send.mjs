import { mkdir, readFile, writeFile, rename, open, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ChatInput } from "./chat-input.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (message, status = 400) => Object.assign(Error(message), { status });

// Direct original-terminal submission. Durable intent precedes any input.
// An ambiguous/crashed
// request is never automatically submitted again, including after restart.
export class ChatSender {
  constructor(chats, runtime, { deliver, terminals } = {}) {
    this.chats = chats;
    this.runtime = runtime;
    this.directory = path.join(runtime, "chat-receipts");
    const input = new ChatInput(chats, terminals);
    this.deliver = deliver || input.send.bind(input);
    this.running = new Map();
  }
  file(id) {
    if (!uuid.test(String(id))) throw fail("发送编号无效");
    return path.join(this.directory, id + ".json");
  }
  public(entry) {
    const state =
      entry.state === "sending" && !this.running.has(entry.requestId) ? "unknown" : entry.state;
    const notes = {
      sending: "正在发送到原终端。",
      submitted: "已送到原终端",
      queued: "旧版排队回执，请在原终端核对。",
      unknown: "送达状态尚未确认。请检查原终端，不要重新发送同一句话。",
      failed: "消息没有发出。",
    };
    return {
      requestId: entry.requestId,
      state,
      message: entry.message || notes[state],
      created: entry.created,
      ...(entry.observed ? { observed: entry.observed } : {}),
      ...(entry.dismissedAt ? { dismissed: true } : {}),
    };
  }
  async recent(name, identity, binding, messages = []) {
    let files;
    try {
      files = await readdir(this.directory);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const entries = [];
    for (const file of files) {
      if (!uuid.test(file.replace(/\.json$/, "")) || !file.endsWith(".json")) continue;
      let entry;
      try {
        entry = JSON.parse(await readFile(path.join(this.directory, file), "utf8"));
      } catch {
        continue;
      }
      if (
        entry.transport === "terminal-enter" &&
        entry.name === name &&
        entry.identity === identity &&
        entry.binding === binding &&
        entry.created > Date.now() - 86400000
      )
        entries.push(entry);
    }
    const used = new Set(entries.filter((e) => e.observed).map((e) => e.observed));
    for (const entry of entries.sort((a, b) => a.created - b.created)) {
      if (
        entry.observed ||
        entry.dismissedAt ||
        this.running.has(entry.requestId) ||
        !["submitted", "unknown", "sending"].includes(entry.state)
      )
        continue;
      const saved = messages.find(
        (m) =>
          m.role === "user" && !used.has(m.id) && m.time >= entry.created && m.text === entry.text,
      );
      if (saved) {
        used.add(saved.id);
        entry.observed = saved.id;
        entry.reconciledFrom = entry.state;
        entry.state = "submitted";
        entry.message = "已在原对话中确认";
        entry.confirmedAt = Date.now();
        // Only finalized receipts are amended; no concurrent submit can replace them.
        const file = this.file(entry.requestId),
          next = file + ".seen-" + randomUUID();
        await writeFile(next, JSON.stringify(entry), { mode: 0o600 });
        await rename(next, file);
      }
    }
    return entries
      .filter((e) => !e.observed && !e.dismissedAt)
      .slice(-20)
      .map((entry) => ({ ...this.public(entry), text: entry.text }));
  }
  async dismiss(name, id, input) {
    if (!input || typeof input.identity !== "string" || typeof input.binding !== "string")
      throw fail("请先载入原对话");
    const { identity, binding } = input;
    const file = this.file(id);
    let entry;
    try {
      entry = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") throw fail("这条记录已不存在", 404);
      throw e;
    }
    if (entry.name !== name || entry.identity !== identity || entry.binding !== binding)
      throw fail("记录不属于当前对话", 404);
    if (entry.state !== "failed" || entry.transport !== "terminal-enter" || this.running.has(id))
      throw fail("只能移除明确未发送的记录；已发送或待核对的记录不能清除", 409);
    if (!entry.dismissedAt) {
      // Keep the receipt and request ID for recovery and duplicate protection.
      entry.dismissedAt = Date.now();
      const next = file + ".dismiss-" + randomUUID(),
        handle = await open(next, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(entry));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(next, file);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return this.public(entry);
  }
  async status(name, id, scope) {
    let entry;
    try {
      entry = JSON.parse(await readFile(this.file(id), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") throw fail("未找到这次发送记录", 404);
      throw e;
    }
    if (entry.name !== name) throw fail("发送记录不属于这个会话", 404);
    if (scope && (entry.identity !== scope.identity || entry.binding !== scope.binding))
      throw fail("发送记录不属于当前对话", 404);
    if (!this.running.has(id) && !entry.observed && ["unknown", "sending"].includes(entry.state)) {
      const view = await this.chats.page(
        name,
        new URLSearchParams({ identity: entry.identity, binding: entry.binding }),
        { lookup: { text: entry.text, since: entry.created } },
      );
      if (view.available && view.binding === entry.binding) {
        await this.recent(name, entry.identity, entry.binding, view.matches || view.messages || []);
        entry = JSON.parse(await readFile(this.file(id), "utf8"));
      }
    }
    return this.public(entry);
  }
  async send(name, input) {
    const { requestId, identity, binding, text, confirm } = input;
    const file = this.file(requestId);
    if (
      confirm !== true ||
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 12000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
    )
      throw fail("请确认发送权限，输入不超过 12 KB 的文字；不支持控制字符");
    if (typeof identity !== "string" || typeof binding !== "string") throw fail("请先载入原对话");
    // Retries first consult their durable receipt. Do not revalidate a now-dead
    // pane and then accidentally treat an accepted message as a new request.
    try {
      const prior = JSON.parse(await readFile(file, "utf8"));
      if (
        prior.name !== name ||
        prior.binding !== binding ||
        prior.identity !== identity ||
        prior.text !== text
      )
        throw fail("发送编号已用于另一条消息，请检查原发送记录", 409);
      return this.public(prior);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (input.transport !== "terminal-enter")
      throw fail("发送方式已更新，请刷新网页后再发；这条文字尚未发送。", 409);
    if (this.running.size >= 4 || [...this.running.values()].includes(name))
      throw fail("正在提交消息，请稍后再发下一条", 429);
    // Register before the first await, so rapid duplicate clicks cannot race.
    this.running.set(requestId, name);
    let entry;
    try {
      const view = await this.chats.page(name, new URLSearchParams({ identity, binding }));
      if (!view.available || view.binding !== binding)
        throw fail("原对话已变化或无法确认，消息未发送。请刷新聊天。", 409);
      const thread = view.binding.split(":")[2];
      if (!uuid.test(thread)) throw fail("无法识别原对话", 409);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      entry = {
        requestId,
        name,
        identity,
        binding,
        text,
        created: Date.now(),
        state: "sending",
        transport: "terminal-enter",
      };
      try {
        const handle = await open(file, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(entry));
          await handle.sync();
        } finally {
          await handle.close();
        }
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (e) {
        if (e.code === "EEXIST") return this.status(name, requestId);
        throw e;
      }
      let result;
      try {
        result = await this.deliver(name, entry);
      } catch {
        result = { state: "unknown" };
      }
      entry = { ...entry, ...result };
      await writeFile(file + ".next", JSON.stringify(entry), { mode: 0o600 });
      await rename(file + ".next", file);
      return this.public(entry);
    } finally {
      this.running.delete(requestId);
    }
  }
}
