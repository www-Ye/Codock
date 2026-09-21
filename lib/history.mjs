import { randomUUID } from "node:crypto";
// Read-only snapshots: never enter shared copy-mode or replay output into a PTY.
const PAGE = 500,
  LIMIT = 20000,
  TTL = 5 * 60 * 1000;
export class History {
  constructor(registry) {
    this.registry = registry;
  }
  async pane(c) {
    const target = await this.registry.target(c.name, c.identity);
    const rows = await this.registry.command([
      "list-clients",
      "-t",
      target.id,
      "-F",
      "#{client_pid}|#{pane_id}|#{session_id}",
    ]);
    const row = rows
      .trim()
      .split("\n")
      .map((s) => s.split("|"))
      .find((r) => Number(r[0]) === c.process?.pid && r[2] === target.id);
    if (!row || !/^%\d+$/.test(row[1])) throw Error("终端页面已变化，请重新打开历史");
    return row[1];
  }
  async read(c, m) {
    if (m.before !== undefined && (!Number.isSafeInteger(m.before) || m.before < 0))
      throw Error("历史页码无效");
    if (m.before === undefined) {
      if (Date.now() - (c.historyRequested || 0) < 1500) throw Error("请稍后刷新历史");
      c.historyRequested = Date.now();
      const pane = await this.pane(c);
      const metadata = (
        await this.registry.command([
          "display-message",
          "-p",
          "-t",
          pane,
          "#{history_size}|#{history_limit}|#{alternate_on}",
        ])
      )
        .trim()
        .split("|");
      const output = await this.registry.command(
        ["capture-pane", "-p", "-t", pane, "-S", String(-LIMIT)],
        4 * 1024 * 1024,
      );
      if (c.closed || pane !== (await this.pane(c))) throw Error("终端窗口已切换，请刷新历史");
      c.history = {
        id: randomUUID(),
        pane,
        lines: output.replace(/\n$/, "").split("\n"),
        created: Date.now(),
        limit: Number(metadata[1]),
        truncated: Number(metadata[0]) > LIMIT,
        alternate: metadata[2] === "1",
      };
    }
    const h = c.history;
    if (!h || Date.now() - h.created > TTL) {
      c.history = null;
      throw Error("历史快照已过期，请刷新");
    }
    await this.registry.target(c.name, c.identity);
    if (m.before !== undefined && (m.snapshot !== h.id || m.before > h.lines.length))
      throw Error("历史快照已变化，请刷新");
    const end = m.before ?? h.lines.length,
      start = Math.max(0, end - PAGE);
    return {
      snapshot: h.id,
      pane: h.pane,
      text: h.lines.slice(start, end).join("\n"),
      start,
      end,
      total: h.lines.length,
      limit: h.limit,
      truncated: h.truncated,
      alternate: h.alternate,
    };
  }
}
