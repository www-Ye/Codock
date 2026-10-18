import { CodexDaemon } from "./codex-daemon.mjs";

// Only expose quota fields, never account identity, credentials or raw errors.
export function quotaBuckets(result) {
  const all = result?.rateLimitsByLimitId;
  const entries =
    all && typeof all === "object" && !Array.isArray(all) && Object.keys(all).length
      ? Object.entries(all)
      : [["codex", result?.rateLimits]];
  return entries.slice(0, 20).flatMap(([id, bucket]) => {
    if (!bucket || typeof bucket !== "object") return [];
    const windows = ["primary", "secondary"].flatMap((key) => {
      const w = bucket[key];
      if (
        !w ||
        !Number.isFinite(w.usedPercent) ||
        !Number.isFinite(w.windowDurationMins) ||
        w.windowDurationMins <= 0
      )
        return [];
      return [
        {
          remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - w.usedPercent)) * 10) / 10,
          durationMins: w.windowDurationMins,
          resetsAt: Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt * 1000 : null,
        },
      ];
    });
    return windows.length
      ? [
          {
            id: String(id).slice(0, 80),
            name: String(bucket.limitName || bucket.limitId || id).slice(0, 80),
            windows,
          },
        ]
      : [];
  });
}

export class AccountQuota {
  constructor(home, { read, now = Date.now } = {}) {
    const daemon = new CodexDaemon(home, { timeout: 6000 });
    this.read = read || (() => daemon.rateLimits());
    this.now = now;
    this.nextRead = 0;
    this.value = null;
    this.pending = null;
  }
  snapshot() {
    if (this.pending) return this.pending;
    if (this.value && this.now() < this.nextRead) return Promise.resolve(this.value);
    this.pending = this.collect().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async collect() {
    try {
      const buckets = quotaBuckets(await this.read());
      this.value = { available: buckets.length > 0, stale: false, checkedAt: this.now(), buckets };
      this.nextRead = this.now() + 60000;
    } catch {
      this.value = {
        available: Boolean(this.value?.available),
        stale: true,
        checkedAt: this.value?.checkedAt ?? null,
        buckets: this.value?.buckets ?? [],
      };
      this.nextRead = this.now() + 30000;
    }
    return this.value;
  }
}
