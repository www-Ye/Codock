import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { discover, runRoot, runSources } from "./guardian-discovery.mjs";

export function aggregate(rows, now) {
  const known = rows.filter((r) => r.total != null && r.done != null),
    total = known.reduce((n, r) => n + r.total, 0),
    done = known.reduce((n, r) => n + r.done, 0);
  const unknown = known.length !== rows.length,
    failures = rows.reduce((n, r) => n + (r.failures || 0), 0);
  const state =
    !rows.length || unknown
      ? "unavailable"
      : rows.every((r) => r.state === "completed")
        ? "completed"
        : rows.some((r) => ["failed", "attention"].includes(r.state))
          ? "attention"
          : rows.every((r) => r.state === "stalled")
            ? "stalled"
            : "running";
  return {
    state,
    phase: "tracking",
    total: unknown ? null : total,
    done: unknown ? null : done,
    failures,
    percent: !unknown && total > 0 ? Math.floor((done / total) * 100) : null,
    checkedAt: now,
    updatedAt: Math.max(0, ...rows.map((r) => r.updatedAt || 0)),
    parts: rows,
    ...(unknown
      ? { message: "部分进度暂时读不到，保留原任务范围，暂不计算总百分比" }
      : failures
        ? { message: failures + " 项运行异常需留意；其余评测进度继续更新" }
        : {}),
  };
}

export function followCandidate(guardian, result, session) {
  let files = result.candidates.filter(
    (c) => c.session === session && c.kind === "file" && c.snapshot?.total > 0,
  );
  if (!files.length) return null;
  const freshRoots = new Set(
    files.filter((c) => guardian.clock() - c.updatedAt < 7200000).map((c) => c.root),
  );
  if (freshRoots.size) files = files.filter((c) => freshRoots.has(c.root));
  const sources = files.map((c) => ({
    source: c.source,
    root: c.root,
    label: path.relative(c.root, path.dirname(c.source)) || path.basename(c.root),
  }));
  return {
    id: randomUUID(),
    kind: "bundle",
    session,
    title: session + " 当前任务",
    identity: files[0].identity,
    binding: files[0].binding,
    sources,
    snapshot: aggregate(
      files.map((c, i) => ({ ...c.snapshot, label: sources[i].label })),
      guardian.clock(),
    ),
  };
}

export async function readBundle(guardian, task, project) {
  const now = guardian.clock(),
    version = task.revision || 0;
  if (!task.lastDiscoveryAt || now - task.lastDiscoveryAt >= 120000) {
    task.lastDiscoveryAt = now;
    try {
      const found = followCandidate(
        guardian,
        await discover(guardian, task.session, project),
        task.session,
      );
      if (found && task.enabled && !task.archived && (task.revision || 0) === version) {
        const roots = new Set(task.sources.map((s) => s.root || runRoot(s.source)));
        // New generations must stay in the same project output area and be
        // referenced by this named session. Keep unfinished live generations.
        const fresh = found.sources.filter((s) =>
          [...roots].some((r) => path.dirname(r) === path.dirname(s.root)),
        );
        const newRoots = new Set(fresh.filter((s) => !roots.has(s.root)).map((s) => s.root));
        const previous = task.snapshot?.parts || [];
        const finishedOrOld =
          previous.length &&
          previous.every((p) => p.done === p.total || now - (p.updatedAt || now) > 7200000);
        if (newRoots.size && finishedOrOld) {
          task.sourceHistory = [
            ...(task.sourceHistory || []),
            { time: now, sources: task.sources },
          ].slice(-8);
          task.sources = fresh.filter((s) => newRoots.has(s.root));
          task.sourceChangedAt = now;
        }
        // Pick up later stages within each already authorized run directory.
        for (const root of new Set(task.sources.map((s) => s.root || runRoot(s.source)))) {
          for (const source of await runSources(guardian, root))
            if (!task.sources.some((s) => s.source === source) && task.sources.length < 48)
              task.sources.push({
                source,
                root,
                label: path.relative(root, path.dirname(source)) || path.basename(root),
              });
        }
      }
    } catch {
      /* Keep reading the confirmed sources if session discovery is unavailable. */
    }
  }
  const rows = [];
  for (const item of task.sources) {
    try {
      const source = await guardian.source(item.source),
        info = await stat(source);
      rows.push({
        ...project(JSON.parse(await readFile(source, "utf8")), now, info.mtimeMs),
        label: item.label,
      });
    } catch {
      rows.push({
        label: item.label,
        state: "unavailable",
        total: null,
        done: null,
        checkedAt: now,
      });
    }
  }
  return aggregate(rows, now);
}
