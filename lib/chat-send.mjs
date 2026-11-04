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
    this.lookupMiss = new Map();
    this.receiptIndex = new Map();
    this.indexPending = null;
  }
  file(id) {
    if (!uuid.test(String(id))) throw fail("发送编号无效");
    return path.join(this.directory, id + ".json");
  }
  public(entry) {
    const state = entry.observed
      ? entry.state
      : entry.releasedAt
        ? "released"
        : entry.state === "sending" && !this.running.has(entry.requestId)
          ? "unknown"
          : entry.state;
    const notes = {
      sending: "正在发送到原终端。",
      submitted: "已送到原终端",
      queued: "旧版排队回执，请在原终端核对。",
      unknown: "送达状态尚未确认。请检查原终端，不要重新发送同一句话。",
      released: "送达仍未确认；你已结束核对，可继续发送新消息。",
      failed: "消息没有发出。",
    };
    return {
      requestId: entry.requestId,
      state,
      message: entry.releasedAt && !entry.observed ? notes.released : entry.message || notes[state],
      created: entry.created,
      ...(entry.observed ? { observed: entry.observed } : {}),
      ...(entry.dismissedAt ? { dismissed: true } : {}),
      ...(entry.releasedAt ? { released: true } : {}),
    };
  }
  indexEntry(entry) {
    const { requestId, name, identity, binding, created } = entry;
    this.receiptIndex.set(
      requestId + ".json",
      !entry.cancelledBeforeSend &&
        entry.transport === "terminal-enter" &&
        created > Date.now() - 86400000
        ? { name, identity, binding, created }
        : null,
    );
  }
  indexReceipts() {
    if (this.indexPending) return this.indexPending;
    // Scan immutable ownership once, not thousands of historical payloads on
    // every chat poll. New files are discovered; active receipts stay disk-fresh.
    this.indexPending = (async () => {
      let files;
      try {
        files = await readdir(this.directory);
      } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
      }
      files = files.filter(
        (file) =>
          file.endsWith(".json") && uuid.test(file.slice(0, -5)) && !this.receiptIndex.has(file),
      );
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(16, files.length) }, async () => {
          while (next < files.length) {
            const file = files[next++];
            try {
              const entry = JSON.parse(await readFile(path.join(this.directory, file), "utf8"));
              if (entry.requestId + ".json" === file) this.indexEntry(entry);
            } catch {
              /* A concurrent atomic write can be discovered on the next read. */
            }
          }
        }),
      );
    })().finally(() => {
      this.indexPending = null;
    });
    return this.indexPending;
  }
  async recent(name, identity, binding, messages = []) {
    await this.indexReceipts();
    const files = [...this.receiptIndex]
      .filter(
        ([, entry]) =>
          entry &&
          entry.name === name &&
          entry.identity === identity &&
          entry.binding === binding &&
          entry.created > Date.now() - 86400000,
      )
      .map(([file]) => file);
    const entries = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, files.length) }, async () => {
        while (next < files.length) {
          const file = files[next++];
          let entry;
          try {
            entry = JSON.parse(await readFile(path.join(this.directory, file), "utf8"));
          } catch {
            continue;
          }
          if (
            !entry.cancelledBeforeSend &&
            entry.transport === "terminal-enter" &&
            entry.name === name &&
            entry.identity === identity &&
            entry.binding === binding &&
            entry.created > Date.now() - 86400000
          )
            entries.push(entry);
        }
      }),
    );
    const used = new Set(entries.filter((e) => e.observed).map((e) => e.observed));
    const now = Date.now(),
      oldestVisible = messages.length ? Math.min(...messages.map((m) => m.time)) : Infinity;
    let olderLookups = 0;
    for (const entry of entries.sort((a, b) => a.created - b.created)) {
      if (
        entry.observed ||
        entry.dismissedAt ||
        this.running.has(entry.requestId) ||
        !["submitted", "unknown", "sending"].includes(entry.state)
      )
        continue;
      let saved = messages.find(
        (m) =>
          m.role === "user" && !used.has(m.id) && m.time >= entry.created && m.text === entry.text,
      );
      // A submitted message can leave the current page before its receipt is
      // observed. Reuse the same read-only exact-history lookup, with a small
      // per-request budget; never infer delivery from a terminal keystroke.
      if (
        !saved &&
        entry.state === "submitted" &&
        now - entry.created > 30000 &&
        entry.created < oldestVisible &&
        olderLookups < 2 &&
        (this.lookupMiss.get(entry.requestId) || 0) < now
      ) {
        olderLookups++;
        try {
          const view = await this.chats.page(name, new URLSearchParams({ identity, binding }), {
            lookup: { text: entry.text, since: entry.created },
          });
          if (view.available && view.binding === binding)
            saved = (view.matches || [])
              .filter(
                (m) =>
                  m.role === "user" &&
                  !used.has(m.id) &&
                  m.time >= entry.created &&
                  m.text === entry.text,
              )
              .sort((a, b) => a.time - b.time)[0];
        } catch {
          /* A lookup failure must not hide or resend an ambiguous message. */
        }
        if (!saved) this.lookupMiss.set(entry.requestId, now + 20000);
      }
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
    if (this.lookupMiss.size > 256)
      for (const [id, until] of this.lookupMiss)
        if (until < now || this.lookupMiss.size > 256) this.lookupMiss.delete(id);
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
  async release(name, id, input) {
    if (!input || typeof input.identity !== "string" || typeof input.binding !== "string")
      throw fail("请先载入原对话");
    const file = this.file(id);
    let entry;
    try {
      entry = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") throw fail("这条记录已不存在", 404);
      throw e;
    }
    if (entry.name !== name || entry.identity !== input.identity || entry.binding !== input.binding)
      throw fail("记录不属于当前对话", 404);
    if (
      input.confirmRelease !== true ||
      this.running.has(id) ||
      (!entry.releasedAt && !["unknown", "sending"].includes(entry.state))
    )
      throw fail("只能由你确认结束未完成的核对；正在发送的消息不能解除", 409);
    if (!entry.releasedAt) {
      entry.releasedAt = Date.now();
      const next = file + ".release-" + randomUUID(),
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
  async recover(name, id, scope) {
    const file = this.file(id);
    if (!scope || typeof scope.identity !== "string" || typeof scope.binding !== "string")
      throw fail("请先载入原对话");
    try {
      return await this.status(name, id, scope);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    // Missing is not proof of rejection: the original request may be delayed.
    // Reserve its ID durably before permitting a new send. The same exclusive
    // creation in send() makes a late original request lose without touching tmux.
    if (this.running.has(id)) throw fail("原请求仍在检查中，请稍后检查回执", 409);
    const view = await this.chats.page(
      name,
      new URLSearchParams({ identity: scope.identity, binding: scope.binding }),
    );
    if (!view.available || view.binding !== scope.binding)
      throw fail("原对话已变化，请刷新聊天", 409);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.running.has(id)) throw fail("原请求仍在检查中，请稍后检查回执", 409);
    const entry = {
      requestId: id,
      name,
      identity: scope.identity,
      binding: scope.binding,
      created: Date.now(),
      state: "failed",
      transport: "terminal-enter",
      cancelledBeforeSend: true,
      message: "已确认没有发出，草稿保留，可以发送。",
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
      if (e.code === "EEXIST") return this.status(name, id, scope);
      throw e;
    }
    this.indexEntry(entry);
    return this.public(entry);
  }
  async send(name, input) {
    if (this.chats.registry?.systemAccountApplying?.())
      throw fail("系统账号正在提交切换，请稍后发送；消息尚未发出", 429);
    const { requestId, identity, binding, text, confirm, transport } = input;
    const file = this.file(requestId);
    if (
      confirm !== true ||
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 12000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
    )
      throw fail("请确认发送权限，输入不超过 12 KB 的文字；不支持控制字符");
    if (transport === "terminal-model" && text !== "/model") throw fail("模型菜单只允许 /model");
    if (!["terminal-enter", "terminal-model"].includes(transport))
      throw fail("发送方式已更新，请刷新网页后再发；这条文字尚未发送。", 409);
    if (typeof identity !== "string" || typeof binding !== "string") throw fail("请先载入原对话");
    // Retries first consult their durable receipt. Do not revalidate a now-dead
    // pane and then accidentally treat an accepted message as a new request.
    try {
      const prior = JSON.parse(await readFile(file, "utf8"));
      if (
        prior.name !== name ||
        prior.binding !== binding ||
        prior.identity !== identity ||
        prior.transport !== transport ||
        (!prior.cancelledBeforeSend && prior.text !== text)
      )
        throw fail("发送编号已用于另一条消息，请检查原发送记录", 409);
      return this.public(prior);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (this.chats.registry?.systemAccountApplying?.())
      throw fail("系统账号正在提交切换，请稍后发送；消息尚未发出", 429);
    if (this.running.size >= 4 || [...this.running.values()].includes(name))
      throw fail("正在提交消息，请稍后再发下一条", 429);
    // Register before the first await, so rapid duplicate clicks cannot race.
    this.running.set(requestId, name);
    let entry;
    try {
      const view = await this.chats.page(name, new URLSearchParams({ identity, binding }));
      if (!view.available || view.readOnly || view.binding !== binding)
        throw fail("当前终端的对话尚未核实，消息未发送。请在「终端」继续。", 409);
      if (input.historyVersion && input.historyVersion !== view.historyVersion)
        throw fail("聊天历史已切换，消息未发送；请等当前记录更新后再发。", 409);
      if (this.chats.verifyCurrent) await this.chats.verifyCurrent(name, identity, binding);
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
        transport,
        ...(view.historyVersion ? { historyVersion: view.historyVersion } : {}),
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
        if (e.code === "EEXIST") return this.status(name, requestId, { identity, binding });
        throw e;
      }
      this.indexEntry(entry);
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
