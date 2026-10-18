import { realpath } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = () => Object.assign(Error("Codex 本地会话接口暂时无法读取。"), { status: 503 });

// Metadata only. Never resume/subscribe to threads, start turns, or answer requests.
export class CodexDaemon {
  constructor(home, { timeout = 2000 } = {}) {
    this.home = home;
    this.timeout = timeout;
    this.pending = null;
  }
  snapshot() {
    if (!this.pending)
      this.pending = this.collect().finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  rateLimits() {
    return this.collect({ quota: true });
  }
  async collect({ quota = false } = {}) {
    const socket = await realpath(
      path.join(this.home, "app-server-control", "app-server-control.sock"),
    );
    if (socket.includes(":")) throw fail();
    const ws = new WebSocket("ws+unix:" + socket + ":/", { maxPayload: 1024 * 1024 });
    let sequence = 0,
      closed = false,
      openResolve,
      openReject;
    const pending = new Map(),
      opened = new Promise((resolve, reject) => {
        openResolve = resolve;
        openReject = reject;
      });
    const stop = () => {
      if (closed) return;
      closed = true;
      openReject(fail());
      for (const entry of pending.values()) entry.reject(fail());
      pending.clear();
    };
    const timer = setTimeout(() => {
      stop();
      ws.terminate();
    }, this.timeout);
    ws.on("open", openResolve);
    ws.on("error", stop);
    ws.on("close", stop);
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        stop();
        ws.terminate();
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error || !Object.hasOwn(message, "result")) entry.reject(fail());
      else entry.resolve(message.result);
    });
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(fail());
          return;
        }
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) {
            stop();
            ws.terminate();
          }
        });
      });
    try {
      await opened;
      await request("initialize", {
        clientInfo: { name: "terminal_desk_metadata", version: "1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      ws.send(JSON.stringify({ method: "initialized", params: {} }));
      if (quota) return await request("account/rateLimits/read", {});
      const ids = new Set();
      let cursor;
      for (let page = 0; page < 8; page++) {
        const result = await request("thread/loaded/list", {
          limit: 64,
          ...(cursor ? { cursor } : {}),
        });
        if (
          !Array.isArray(result.data) ||
          result.data.some((id) => typeof id !== "string" || !uuid.test(id) || ids.has(id))
        )
          throw fail();
        for (const id of result.data) ids.add(id);
        if (ids.size > 256) throw fail();
        const next = result.nextCursor;
        if (next == null) {
          cursor = null;
          break;
        }
        if (typeof next !== "string" || !next || next === cursor) throw fail();
        cursor = next;
      }
      if (cursor) throw fail();
      const threads = await Promise.all(
        [...ids].map(async (id) => {
          const result = await request("thread/read", { threadId: id, includeTurns: false }),
            thread = result.thread;
          if (
            !thread ||
            thread.id !== id ||
            typeof thread.cwd !== "string" ||
            !path.isAbsolute(thread.cwd) ||
            !(thread.name === null || typeof thread.name === "string")
          )
            throw fail();
          return {
            id,
            name: thread.name,
            cwd: thread.cwd,
            source: thread.source,
            parentThreadId: thread.parentThreadId ?? null,
          };
        }),
      );
      const latest = await request("thread/loaded/list", { limit: 256 });
      if (
        latest.nextCursor != null ||
        !Array.isArray(latest.data) ||
        latest.data.length !== ids.size ||
        new Set(latest.data).size !== ids.size ||
        latest.data.some((id) => !ids.has(id))
      )
        throw fail();
      return threads;
    } finally {
      clearTimeout(timer);
      stop();
      ws.close();
    }
  }
}
