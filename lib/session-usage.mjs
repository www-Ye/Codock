import { readFile, writeFile, rename } from "node:fs/promises";

// Only last-opened timestamps; no chat bodies, keystrokes or browsing history.
export class SessionUsage {
  constructor(file, { clock = Date.now } = {}) {
    this.file = file;
    this.clock = clock;
    this.items = {};
    this.queue = Promise.resolve();
  }
  async init() {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      if (!saved || Array.isArray(saved) || typeof saved !== "object")
        throw Error("Invalid session usage");
      this.items = Object.fromEntries(
        Object.entries(saved).filter(
          ([name, time]) => /^[a-z0-9_-]+$/.test(name) && Number.isSafeInteger(time) && time > 0,
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  visit(name) {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const time = Math.max(this.clock(), ...Object.values(this.items).map((t) => t + 1));
        const next = { ...this.items, [name]: time };
        await writeFile(this.file + ".next", JSON.stringify(next), { mode: 0o600 });
        await rename(this.file + ".next", this.file);
        this.items = next;
        return time;
      });
    this.queue = task;
    return task;
  }
  list(sessions) {
    return sessions
      .map((s) => ({ ...s, lastOpenedAt: this.items[s.name] || 0 }))
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }
}
