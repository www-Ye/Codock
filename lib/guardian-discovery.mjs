import path from "node:path";
import { readFile, stat, readdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const progressNames = ["progress.json", "status.json"];
const number = (value) => Number.isFinite(value) && value >= 0;
export function runRoot(source) {
  const parts = source.split(path.sep),
    index = parts.findIndex((p) => ["outputs", "output", "runs", "results"].includes(p));
  return index >= 0 && parts[index + 1]
    ? parts.slice(0, index + 2).join(path.sep)
    : path.dirname(source);
}
// Only descend inside a run directory mentioned by this session. Stop at a
// batch's progress file; individual attempts must never count a second time.
export async function runSources(guardian, root) {
  const files = [],
    queue = [[root, 0]];
  let visited = 0;
  while (queue.length && visited++ < 160 && files.length < 48) {
    const [directory, depth] = queue.shift();
    let resolved;
    try {
      resolved = await realpath(directory);
    } catch {
      continue;
    }
    if (
      (resolved !== root && !resolved.startsWith(root + path.sep)) ||
      !resolved.startsWith(guardian.workspace + path.sep) ||
      path
        .relative(guardian.workspace, resolved)
        .split(path.sep)
        .some((p) => p.startsWith("."))
    )
      continue;
    let found = false;
    for (const name of progressNames) {
      try {
        const source = await guardian.source(path.join(resolved, name)),
          raw = JSON.parse(await readFile(source, "utf8"));
        if (hasProgress(raw) && number(raw.total ?? raw.total_videos)) {
          files.push(source);
          found = true;
          break;
        }
      } catch {}
    }
    if (found || depth >= 3) continue;
    try {
      for (const entry of (await readdir(resolved, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (
          entry.isDirectory() &&
          !/^(\.|attempt-|resident|simulator|cache|native_results|videos|images|plans$|judges$)/.test(
            entry.name,
          )
        )
          queue.push([path.join(resolved, entry.name), depth + 1]);
      }
    } catch {}
  }
  return files;
}
export function hasProgress(raw) {
  return (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    ((number(raw.total ?? raw.total_videos) &&
      (number(
        raw.done ?? raw.complete ?? raw.completed ?? raw.completed_videos ?? raw.counts?.solved,
      ) ||
        Array.isArray(raw.results) ||
        (raw.models && typeof raw.models === "object"))) ||
      (typeof raw.status === "string" &&
        /^(running|completed|failed|converting|finalizing|preparing|stopped|paused)$/.test(
          raw.status,
        )))
  );
}

// Read only this named pane's existing history. Never probe it by typing /status.
export async function readSession(guardian, session, previous) {
  const identity = previous?.identity || guardian.registry.items?.[session]?.identity;
  if (!identity || !guardian.chats) throw Error("会话记录暂时无法读取");
  const query = new URLSearchParams({ identity });
  if (previous?.binding) query.set("binding", previous.binding);
  const page = await guardian.chats.page(session, query);
  if (!page.available || (previous?.binding && page.binding !== previous.binding))
    throw Error("会话记录已变化");
  return { identity, binding: page.binding, page };
}

export async function discover(guardian, text, project) {
  const explicit = guardian.registry.allowed
    .filter((name) => new RegExp("(?<![a-zA-Z0-9_-])" + name + "(?![a-zA-Z0-9_-])", "i").test(text))
    .slice(0, 4);
  const recent = guardian.data.discovery;
  if (!explicit.length)
    return recent && guardian.clock() - recent.time < 900000
      ? recent
      : { time: guardian.clock(), sessions: [], candidates: [] };
  const result = { time: guardian.clock(), sessions: [], candidates: [] };
  for (const session of explicit) {
    let observed;
    try {
      observed = await readSession(guardian, session);
    } catch {
      result.sessions.push({ session, note: "暂时读不到该会话记录，可先关注会话，恢复后继续观察" });
      result.candidates.push({
        id: randomUUID(),
        kind: "session",
        session,
        title: session + " 会话动态",
        identity: guardian.registry.items?.[session]?.identity,
      });
      continue;
    }
    const { identity, binding, page } = observed,
      messages = [...(page.messages || [])];
    // Two recent pages cover task launch/output references without scanning a
    // multi-gigabyte history or unrelated directories.
    if (page.before != null) {
      try {
        const query = new URLSearchParams({ identity, binding, before: String(page.before) });
        if (page.historyVersion) query.set("historyVersion", page.historyVersion);
        const older = await guardian.chats.page(session, query);
        if (older.available && older.binding === binding)
          messages.unshift(...(older.messages || []));
      } catch {}
    }
    const filenames = new Set(),
      directories = new Set(),
      runRoots = new Map();
    for (const m of messages.slice().reverse()) {
      const text = [m.text, ...(m.details || []).map((d) => d.text)]
        .join("\n")
        .slice(0, 100000)
        .replace(/\\"/g, '"');
      // Paths are observations, never executable commands. Stay within the
      // explicitly referenced directories; do not recursively scan a project.
      const roots = [...text.matchAll(/(?:\/[^\s"'`<>|;(),{}\[\]\\]+)+/g)]
        .map((m) => m[0].replace(/[.:]+$/, ""))
        .filter((p) => p.startsWith(guardian.workspace + path.sep));
      const cwd =
        (m.details || []).find((d) => d.label === "工作目录")?.text ||
        text.match(/["'](?:workdir|cwd)["']\s*:\s*["']([^"']+)["']/)?.[1];
      if (cwd === guardian.workspace || cwd?.startsWith(guardian.workspace + path.sep))
        for (const match of text.matchAll(
          /(?:^|[\s"'`])(outputs|output|runs|results)\/([^\s"'`<>|;(),{}\[\]\\]+)/g,
        ))
          roots.push(path.resolve(cwd, match[1], match[2]));
      // Keep run-root evidence even after the individual-path budget is used;
      // long diagnostic output must not hide a later referenced batch.
      const commands = (m.details || [])
        .filter((d) => ["命令", "参数", "文件"].includes(d.label))
        .map((d) => d.text)
        .join("\n")
        .replace(/\\"/g, '"');
      for (const ref of roots)
        if (/\/(outputs|output|runs|results)\/[^/]+/.test(ref)) {
          const root = runRoot(ref),
            relative = cwd ? path.relative(cwd, root) : null;
          const priority =
            commands.includes(root) || (relative && commands.includes(relative))
              ? 3
              : m.role === "assistant"
                ? 1
                : 0;
          if (runRoots.has(root) || runRoots.size < 120)
            runRoots.set(root, Math.max(runRoots.get(root) || 0, priority));
        }
      for (const ref of roots) {
        if (filenames.size >= 180) break;
        if (ref.endsWith(".json")) filenames.add(ref);
        let dir = path.extname(ref) ? path.dirname(ref) : ref;
        for (
          let level = 0;
          level < 8 && dir !== guardian.workspace && dir.startsWith(guardian.workspace + path.sep);
          level++, dir = path.dirname(dir)
        ) {
          if (["outputs", "output", "runs", "results"].includes(path.basename(dir))) break;
          if (directories.has(dir)) continue;
          directories.add(dir);
          for (const name of progressNames) filenames.add(path.join(dir, name));
          if (filenames.size >= 180) break;
        }
      }
    }
    for (const [root] of [...runRoots].sort((a, b) => b[1] - a[1]).slice(0, 6))
      for (const filename of await runSources(guardian, root)) filenames.add(filename);
    const candidates = [];
    for (const filename of filenames) {
      try {
        const source = await guardian.source(filename),
          raw = JSON.parse(await readFile(source, "utf8"));
        if (!hasProgress(raw) || candidates.some((c) => c.source === source)) continue;
        const relative = path.relative(guardian.workspace, path.dirname(source)).split(path.sep);
        const label = relative.slice(-3).join(" / ");
        const updatedAt = (await stat(source)).mtimeMs;
        candidates.push({
          id: randomUUID(),
          kind: "file",
          session,
          title: (session + " · " + label).slice(0, 100),
          source,
          root: runRoot(source),
          identity,
          binding,
          updatedAt,
          snapshot: project(raw, guardian.clock(), updatedAt),
        });
      } catch {}
    }
    // Prefer batch progress over individual attempt status beneath the batch.
    const batches = candidates.filter(
      (c) =>
        !candidates.some(
          (other) =>
            other !== c && path.dirname(c.source).startsWith(path.dirname(other.source) + path.sep),
        ),
    );
    batches.sort((a, b) => b.updatedAt - a.updatedAt);
    result.candidates.push(...batches.slice(0, 48));
    result.sessions.push({
      session,
      note: page.readOnly
        ? "来源是该终端启动会话的记录，当前接续身份尚未核对；不能声称是新启动的任务"
        : "已读取对应会话的近期记录",
      sources: batches.length,
    });
    if (!batches.length)
      result.candidates.push({
        id: randomUUID(),
        kind: "session",
        session,
        title: session + " 会话动态",
        identity,
        binding,
      });
  }
  return result;
}

export async function sessionProgress(guardian, task) {
  const { binding, page } = await readSession(guardian, task.session, task);
  if (!task.binding) task.binding = binding;
  const messages = page.messages || [],
    latest = messages.findLast(
      (m) => m.role === "assistant" && ["final_answer", "final"].includes(m.phase),
    );
  const review =
    latest && !page.readOnly
      ? {
          binding,
          finalId: String(latest.id),
          finalTime: latest.time,
          finalText: latest.text.slice(0, 12000),
          context: messages
            .filter(
              (m) =>
                ["user", "assistant"].includes(m.role) &&
                m.id !== latest.id &&
                m.time <= latest.time,
            )
            .slice(-8)
            .map(({ role, text }) => ({ role, text: text.slice(0, 2000) })),
        }
      : null;
  return {
    state: "observing",
    phase: "session",
    checkedAt: guardian.clock(),
    updatedAt: messages.at(-1)?.time || task.snapshot?.updatedAt || null,
    activityId: latest?.id || task.snapshot?.activityId || null,
    review,
    message: "静默关注进展，仅在重要成果完成或需要你处理时提醒",
  };
}
