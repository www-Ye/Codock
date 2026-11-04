import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const unavailable = () =>
  Object.assign(Error("本地识别暂时不可用，请重试或用键盘麦克风"), { status: 503 });

export class LocalAsrWorker {
  constructor({ runtime, python, modelDir, idleMs = 20000, kind = "sensevoice" }) {
    if (!["sensevoice", "qwen3"].includes(kind)) throw Error("unsupported ASR worker kind");
    this.runtime = runtime;
    this.python = python;
    this.modelDir = modelDir;
    this.idleMs = idleMs;
    this.kind = kind;
    this.child = null;
    this.language = null;
    this.waiter = null;
    this.starting = null;
    this.output = "";
    this.idle = null;
  }
  running() {
    return Boolean(this.child);
  }
  stop(error = unavailable()) {
    clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    this.child = null;
    this.language = null;
    this.output = "";
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    if (child) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    }
  }
  receive(child, timeoutMs) {
    if (this.waiter) throw unavailable();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(unavailable()), timeoutMs);
      this.waiter = { resolve, reject, timer, child };
    });
  }
  outputFrom(child, chunk) {
    if (child !== this.child) return;
    this.output += chunk.toString("utf8");
    if (this.output.length > 16000) {
      this.stop();
      return;
    }
    const end = this.output.indexOf("\n");
    if (end < 0) return;
    const line = this.output.slice(0, end);
    this.output = this.output.slice(end + 1);
    const waiter = this.waiter;
    if (!waiter || waiter.child !== child || this.output) {
      this.stop();
      return;
    }
    this.waiter = null;
    clearTimeout(waiter.timer);
    try {
      waiter.resolve(JSON.parse(line));
    } catch {
      waiter.reject(unavailable());
      this.stop();
    }
  }
  armIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.idleMs);
    this.idle.unref();
  }
  async ensure(language) {
    if (!["auto", "zh", "en"].includes(language)) throw unavailable();
    if (this.starting) await this.starting;
    if (this.child && this.language === language) {
      this.armIdle();
      return;
    }
    this.stop();
    const child = spawn(
      this.python,
      ["-B", path.join(root, "scripts/local-asr.py"), this.kind, this.modelDir, language],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CUDA_VISIBLE_DEVICES: "",
          OMP_NUM_THREADS: "2",
          OPENBLAS_NUM_THREADS: "2",
          MKL_NUM_THREADS: "2",
          PYTHONDONTWRITEBYTECODE: "1",
          TMPDIR: path.join(this.runtime, "tmp"),
          XDG_CACHE_HOME: path.join(this.runtime, "cache"),
        },
      },
    );
    this.child = child;
    this.language = language;
    child.stdout.on("data", (data) => this.outputFrom(child, data));
    child.stderr.resume();
    child.stdin.on("error", () => this.stop());
    child.on("error", () => this.stop());
    child.on("close", () => {
      if (this.child === child) this.stop();
    });
    const starting = this.receive(child, 10000);
    this.starting = starting;
    try {
      const reply = await starting;
      if (reply?.ready !== true) throw unavailable();
      this.armIdle();
    } catch (error) {
      this.stop(error);
      throw error;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }
  async warm(language) {
    await this.ensure(language);
  }
  async recognize(wav, language, { vocabulary = [] } = {}) {
    await this.ensure(language);
    clearTimeout(this.idle);
    this.idle = null;
    const child = this.child,
      reply = this.receive(child, this.kind === "qwen3" ? 26000 : 12000);
    try {
      child.stdin.write(
        JSON.stringify({
          wav: wav.toString("base64"),
          ...(this.kind === "qwen3" ? { vocabulary } : {}),
        }) + "\n",
      );
    } catch {
      this.stop();
      return reply;
    }
    try {
      const result = await reply;
      if (typeof result?.text !== "string" || result.text.length > 4000) throw unavailable();
      this.armIdle();
      return result.text;
    } catch (error) {
      this.stop(error);
      throw error;
    }
  }
}
