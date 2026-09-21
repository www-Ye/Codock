import pty from "node-pty";
import { History } from "./history.mjs";

// tmux 3.4 deliberately cannot remove a client's read-only flag. Switch only
// our attach client, never restart or detach the underlying session.
export class Terminals {
  constructor(registry, auth, runtime) {
    Object.assign(this, { registry, auth, runtime });
    this.clients = new Set();
    this.writers = new Map();
    this.history = new History(registry);
    this.timer = setInterval(() => {
      for (const c of this.clients) {
        if (c.history && Date.now() - c.history.created > 300000) c.history = null;
        if (!auth.valid(c.token) || Date.now() - c.alive > 60000)
          c.ws.close(1008, "登录或连接已过期");
        else if (c.ws.readyState === 1) c.ws.ping();
        if (c.write && Date.now() - c.lastInput > 120000 && !c.idlePending) {
          c.idlePending = true;
          c.queue = c.queue
            .then(async () => {
              // Recheck after earlier input/IME events have drained; don't revoke
              // the lease in the middle of an input event already in the queue.
              if (c.write && Date.now() - c.lastInput > 120000) await this.readOnly(c, "idle");
            })
            .catch(() => c.ws.close())
            .finally(() => {
              c.idlePending = false;
            });
        }
      }
    }, 15000);
    this.timer.unref();
  }

  async spawnClient(c, write) {
    const target = await this.registry.target(c.name, c.identity);
    if (c.closed || c.ws.readyState !== 1) return;
    const old = c.process;
    c.ready = false;
    c.process = null;
    if (old)
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        old.onExit(() => {
          clearTimeout(timer);
          resolve();
        });
        try {
          old.kill();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    if (c.closed || c.ws.readyState !== 1) return;
    const terminal = pty.spawn(
      "tmux",
      [
        "-S",
        this.registry.socket,
        "attach-session",
        "-E",
        "-f",
        (write ? "" : "read-only,") + "ignore-size,active-pane",
        "-t",
        target.id,
      ],
      {
        name: "xterm-256color",
        cols: target.cols,
        rows: target.rows + target.status,
        cwd: this.runtime,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TERM: "xterm-256color",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          TMPDIR: this.runtime + "/tmp",
          XDG_CACHE_HOME: this.runtime + "/cache",
          XDG_CONFIG_HOME: this.runtime + "/config",
        },
      },
    );
    c.process = terminal;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("终端连接超时")), 5000);
      terminal.onData((data) => {
        if (c.process !== terminal || c.closed) return;
        if (!c.ready) {
          clearTimeout(timeout);
          c.ready = true;
          c.write = write;
          c.lastInput = Date.now();
          c.send({ type: "ready", write, cols: target.cols, rows: target.rows + target.status });
          c.send({ type: "mode", write, reason: c.modeReason });
          resolve();
        }
        if (c.ws.bufferedAmount > 1024 * 1024) {
          c.ws.close(1013, "输出过快，请重新连接");
          return;
        }
        c.send({ type: "output", data });
      });
      terminal.onExit(() => {
        clearTimeout(timeout);
        reject(Error("终端连接结束"));
        if (c.process === terminal && !c.closed) {
          c.send({ type: "ended", message: "终端连接已结束" });
          c.ws.close();
        }
      });
    }).catch((error) => {
      if (c.process === terminal) {
        try {
          terminal.kill();
        } catch {}
      }
      throw error;
    });
  }

  async attach(ws, token, name, identity) {
    await this.registry.target(name, identity);
    if (ws.readyState !== 1) return;
    if (this.clients.size >= 16) throw Error("网页终端连接过多");
    const c = {
      ws,
      token,
      name,
      identity,
      process: null,
      write: false,
      ready: false,
      alive: Date.now(),
      lastInput: 0,
      queue: Promise.resolve(),
      queued: 0,
      closed: false,
    };
    c.send = (data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(data));
    };
    this.clients.add(c);
    ws.on("close", () => {
      c.closed = true;
      this.clients.delete(c);
      c.history = null;
      if (this.writers.get(name) === c) this.writers.delete(name);
      try {
        c.process?.kill();
      } catch {}
    });
    ws.on("pong", () => {
      c.alive = Date.now();
    });
    ws.on("message", (bytes) => {
      if (++c.queued > 200) {
        ws.close(1008, "输入过快");
        return;
      }
      let m;
      c.queue = c.queue
        .then(async () => {
          if (c.closed || ws.readyState !== 1) return;
          if (!this.auth.valid(token, true)) throw Error("登录已失效");
          if (!c.ready) throw Error("终端仍在连接，请稍后重试");
          c.alive = Date.now();
          m = JSON.parse(bytes.toString());
          if (m.type === "history") {
            const page = await this.history.read(c, m);
            c.send({ type: "history", id: m.id, ...page });
          } else if (m.type === "history-close") {
            c.history = null;
          } else if (m.type === "activity") {
            // IME composition activity keeps its existing lease, never grants one.
            if (c.write && this.writers.get(name) === c) c.lastInput = Date.now();
          } else if (m.type === "write") {
            c.modeReason = null;
            await this.registry.target(name, identity);
            if (c.closed) return;
            if (this.writers.has(name) && this.writers.get(name) !== c)
              throw Error("另一个网页正在输入，请先在那里切回只读");
            this.writers.set(name, c);
            try {
              if (!c.write) await this.spawnClient(c, true);
            } catch (error) {
              if (this.writers.get(name) === c) this.writers.delete(name);
              throw error;
            }
          } else if (m.type === "readonly") await this.readOnly(c);
          else if (m.type === "input") {
            if (!c.write || this.writers.get(name) !== c) throw Error("请先点击允许输入");
            if (typeof m.data !== "string" || Buffer.byteLength(m.data) > 16384)
              throw Error("输入过长");
            c.lastInput = Date.now();
            c.process.write(m.data);
            c.send({ type: "ack", id: m.id });
          } else if (m.type === "resize") {
            // Browser scrolls the existing terminal. Never resize a shared window.
            return;
          } else throw Error("未知终端消息");
        })
        .catch((e) => c.send({ type: "error", message: e.message, id: m?.id }))
        .finally(() => {
          c.queued--;
        });
    });
    await this.spawnClient(c, false);
  }

  async readOnly(c, reason = "manual") {
    c.write = false;
    c.modeReason = reason;
    // Gate input immediately. Destroy the writable client before releasing lease.
    try {
      await this.spawnClient(c, false);
    } catch {
      c.ws.close();
    }
    if (this.writers.get(c.name) === c) this.writers.delete(c.name);
  }
  close() {
    clearInterval(this.timer);
    for (const c of this.clients) c.ws.close(1001, "服务重启，请重新连接");
  }
}
