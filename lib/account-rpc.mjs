import { realpath } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const failure = () => Object.assign(Error("账号后台暂时未连接，请稍后重试。"), { status: 503 });
export function accountRpcError(raw) {
  const error = failure(),
    message = typeof raw?.message === "string" ? raw.message : "";
  // Preserve only a recovery hint; raw upstream errors may contain credentials.
  error.authExpired = /\b401\b|\bunauthorized\b|\btoken[_ ]expired\b/i.test(message);
  if (raw?.code === -32600 && /^no rollout found for thread id [a-f0-9-]+$/.test(message))
    error.missingThread = true;
  return error;
}
// One connection per isolated account. Never expose raw RPC errors or tokens.
export class AccountRpc {
  constructor(home, { notify = () => {}, onRequest } = {}) {
    this.home = home;
    this.notify = notify;
    this.onRequest = onRequest;
    this.pending = new Map();
    this.sequence = 0;
    this.ready = null;
  }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const socket = await realpath(
        path.join(this.home, "app-server-control/app-server-control.sock"),
      );
      if (socket.includes(":")) throw failure();
      const ws = (this.ws = new WebSocket("ws+unix:" + socket + ":/", {
        maxPayload: 2 * 1024 * 1024,
      }));
      ws.on("message", (raw) => {
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (m.method) {
          if (m.id !== undefined) {
            Promise.resolve()
              .then(() => {
                if (!this.onRequest || m.method !== "account/chatgptAuthTokens/refresh")
                  throw Error("unsupported");
                return this.onRequest(m);
              })
              .then(
                (result) => {
                  if (ws.readyState === WebSocket.OPEN)
                    ws.send(JSON.stringify({ id: m.id, result }));
                },
                () => {
                  if (ws.readyState === WebSocket.OPEN)
                    ws.send(
                      JSON.stringify({
                        id: m.id,
                        error: { code: -32601, message: "Request not handled by account manager" },
                      }),
                    );
                },
              );
          } else this.notify(m);
          return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(accountRpcError(m.error));
        else p.resolve(m.result);
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        if (this.ws !== ws) return;
        this.ready = null;
        this.ws = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(failure());
        }
        this.pending.clear();
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.terminate();
          reject(failure());
        }, 5000);
        ws.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", () => {
          clearTimeout(timer);
          reject(failure());
        });
      });
      await this.send("initialize", {
        clientInfo: { name: "terminal_desk_accounts", version: "1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      ws.send(JSON.stringify({ method: "initialized", params: {} }));
    })().catch((e) => {
      this.ws?.terminate();
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
  send(method, params, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(failure());
        return;
      }
      const id = ++this.sequence,
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(failure());
        }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(failure());
        }
      });
    });
  }
  async request(method, params = {}, timeout) {
    await this.connect();
    return this.send(method, params, timeout);
  }
  close() {
    this.ws?.close();
  }
}
