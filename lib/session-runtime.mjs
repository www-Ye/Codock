import { observeTerminal } from "./terminal-status.mjs";

// A cached, state-only view. Terminal contents never cross this API boundary.
export class SessionRuntime {
  constructor(
    registry,
    {
      observe = observeTerminal,
      clock = () => Date.now(),
      ttl = 5000,
      workers = 4,
      home = null,
      homeFromMeta = null,
      readTurns = null,
    } = {},
  ) {
    Object.assign(this, { registry, observe, clock, ttl, workers, home, homeFromMeta, readTurns });
    this.cached = null;
    this.expires = 0;
    this.pending = null;
  }
  snapshot() {
    if (this.cached && this.clock() < this.expires) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    this.pending = this.collect()
      .then((result) => {
        this.cached = result;
        this.expires = this.clock() + this.ttl;
        return result;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  async collect() {
    const live = await this.registry.live(),
      eligible = live.filter((s) => this.registry.items[s.name]?.identity === s.identity);
    const states = {},
      panes = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(this.workers, eligible.length) }, async () => {
        while (next < eligible.length) {
          const session = eligible[next++];
          let state = "unknown";
          try {
            const meta = (
              await this.registry.command([
                "display-message",
                "-p",
                "-t",
                session.id,
                "#{pane_id}\t#{pane_pid}\t#{pane_height}\t#{pane_in_mode}\t#{@desk_account}",
              ])
            ).trim();
            state = (await this.observe(this.registry, meta)).state;
            const [pane, pid] = meta.split("\t");
            if (/^%\d+$/.test(pane) && /^\d+$/.test(pid))
              panes.push({
                name: session.name,
                identity: session.identity,
                pane,
                pid: Number(pid),
                ...(this.homeFromMeta ? { home: this.homeFromMeta(meta) } : {}),
              });
          } catch {}
          states[session.name] = ["ready", "running", "waiting"].includes(state)
            ? state
            : "unknown";
        }
      }),
    );
    if (!this.readTurns) return { states, checkedAt: this.clock() };
    const completions = {};
    let timeout;
    try {
      const markers = await Promise.race([
        this.readTurns(
          this.home,
          this.registry.socket,
          panes.map(({ identity, ...pane }) => pane),
        ),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error("completion marker timeout")), 1200);
        }),
      ]);
      for (let i = 0; i < panes.length; i++) {
        const marker = markers?.[i],
          session = panes[i];
        if (
          marker &&
          /^\d+:\d+:[a-f0-9-]{36}$/.test(marker.binding) &&
          /^\d+$/.test(marker.id) &&
          Number.isSafeInteger(marker.time) &&
          marker.time > 0 &&
          this.registry.items[session.name]?.identity === session.identity
        ) {
          completions[session.name] = {
            identity: session.identity,
            binding: marker.binding,
            id: marker.id,
            time: marker.time,
          };
        }
      }
    } catch {
      /* Missing or slow saved records never block the terminal status fallback. */
    } finally {
      clearTimeout(timeout);
    }
    return { states, checkedAt: this.clock(), completions };
  }
}
