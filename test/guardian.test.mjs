import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Guardian, progressView } from "../lib/guardian.mjs";

test("guardian tracks real completion, preserves events and does not replay task work", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/guardian-"),
    source = dir + "/progress.json";
  await writeFile(
    source,
    JSON.stringify({ status: "converting", total_videos: 10, completed_videos: 3 }),
  );
  const calls = [],
    rpc = {
      request: async (method, params) => {
        calls.push({ method, params });
        return method === "thread/start"
          ? { thread: { id: "fixture-thread" } }
          : { turn: { id: "fixture-turn" } };
      },
      close() {},
    };
  const g = new Guardian({
    runtime: dir + "/runtime",
    workspace: dir,
    registry: { allowed: ["data"] },
    rpc,
  });
  await g.init();
  t.after(() => g.close());
  await g.register({ session: "data", title: "转换并发布", source });
  assert.equal(g.view().tasks[0].snapshot.percent, 30);
  assert.equal(g.view().events.length, 0);
  await writeFile(
    source,
    JSON.stringify({ status: "finalizing", total_videos: 10, completed_videos: 10 }),
  );
  await g.tick();
  assert.equal(g.view().tasks[0].snapshot.state, "running", "100% converted is not published");
  assert.equal(g.view().events.length, 0, "ordinary phase changes stay silent");
  assert.equal(calls.length, 0);
  await writeFile(
    source,
    JSON.stringify({ status: "completed", total_videos: 10, completed_videos: 10 }),
  );
  await g.tick();
  await g.tick();
  assert.equal(g.view().events.filter((e) => e.state === "completed").length, 1);
  assert(!JSON.stringify(g.view()).includes(source), "private source paths are not returned");
  await g.update({ readAll: true });
  assert(g.view().events.every((e) => e.read));
  const id = g.data.tasks[0].id;
  await g.update({ id, enabled: false });
  await writeFile(source, JSON.stringify({ status: "failed" }));
  await g.tick();
  assert.equal(
    g.data.tasks[0].snapshot.state,
    "completed",
    "paused monitoring does not affect the job",
  );
  await symlink("/etc/passwd", dir + "/outside.json");
  await assert.rejects(
    g.register({ session: "data", title: "bad", source: dir + "/outside.json" }),
  );
  assert.equal(JSON.parse(await readFile(g.file, "utf8")).tasks[0].enabled, false);
  await writeFile(source, JSON.stringify({ status: "running", total: 10, done: 4 }));
  await g.register({ session: "data", title: "转换并发布", source, pid: process.pid });
  g.data.tasks[0].processIdentity = "different-process";
  await g.tick();
  assert.equal(
    g.data.tasks[0].snapshot.state,
    "attention",
    "PID reuse or disappearance is never reported as success",
  );
  assert.match(g.data.tasks[0].snapshot.message, /进程已退出/);
});

test("guardian distinguishes stale observations, failures and a completed phase", () => {
  assert.equal(progressView({ status: "running" }, 10000000, 1).state, "stalled");
  assert.equal(progressView({ status: "failed" }, 10000000, 1).state, "failed");
  assert.equal(
    progressView({ controller_status: "stopped", total: 35, counts: { solved: 35 } }, 10, 10).state,
    "completed",
  );
  assert.equal(
    progressView({ controller_status: "stopped", total: 35, counts: { solved: 30 } }, 10, 10).state,
    "attention",
  );
  assert.equal(progressView({ total: 48, complete: 40, results: [] }, 10, 10).done, 40);
  assert.equal(
    progressView(
      {
        total: 10,
        models: { a: { complete: 6 }, b: { complete: 4 } },
        results: [{ success: false }],
      },
      10,
      10,
    ).state,
    "completed",
    "policy failure is not a crashed evaluator",
  );
  assert.equal(
    progressView(
      {
        total: 1,
        complete: 1,
        results: [{ instruction_following: { status: "pending_rescore" } }],
      },
      10,
      10,
    ).phase,
    "rescore_pending",
  );
});

test("a watched pipeline only announces its last stage completion", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/guardian-stages-"),
    first = dir + "/progress.json",
    last = dir + "/publish.json";
  await writeFile(first, JSON.stringify({ status: "running" }));
  const g = new Guardian({
    runtime: dir + "/runtime",
    workspace: dir,
    registry: { allowed: ["data"] },
    rpc: {
      request: async () => {
        throw Error("no review needed");
      },
      close() {},
    },
  });
  await g.init();
  t.after(() => g.close());
  const { id } = await g.register({ session: "data", title: "转换", source: first });
  await g.register({ session: "data", title: "最终发布", source: last, after: id });
  await writeFile(first, JSON.stringify({ status: "completed" }));
  await g.tick();
  assert.equal(g.view().events.length, 0);
  await writeFile(last, JSON.stringify({ status: "running" }));
  await g.tick();
  assert.equal(g.view().events.length, 0);
  await writeFile(last, JSON.stringify({ status: "completed" }));
  await g.tick();
  await g.tick();
  assert.equal(g.view().events.length, 1);
  assert.equal(g.view().events[0].title, "最终发布");
});

test("natural chat discovers the named session, persists watches and rejects invented targets", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/guardian-chat-");
  await mkdir(dir + "/outputs/batch/attempt", { recursive: true });
  const source = dir + "/outputs/batch/status.json",
    original = JSON.stringify({ total: 48, complete: 40, results: [] });
  await writeFile(source, original);
  const reads = [],
    registry = {
      allowed: ["eval", "build"],
      items: { eval: { identity: "eval-identity" } },
      target: async (name, id) => {
        assert.equal(name, "eval");
        assert.equal(id, "eval-identity");
        return {};
      },
    };
  const chats = {
    page: async (name) => {
      reads.push(name);
      assert.equal(name, "eval");
      return {
        available: true,
        readOnly: true,
        binding: "eval-binding",
        messages: [
          {
            role: "activity",
            text: "",
            details: [{ text: "output " + dir + "/outputs/batch/attempt/run.log" }],
          },
        ],
      };
    },
  };
  let started;
  const rpc = {
    request: async (method, params) => {
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method === "turn/start") started(params);
      return { turn: { id: "turn" } };
    },
    close() {},
  };
  const g = new Guardian({ runtime: dir + "/runtime", workspace: dir, registry, chats, rpc });
  await g.init();
  t.after(() => g.close());
  async function ask(text) {
    const pending = new Promise((resolve) => {
      started = resolve;
    });
    await g.ask({ requestId: randomUUID(), text });
    return pending;
  }
  async function finish(actions, reply = "") {
    const id = randomUUID();
    await g.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          id,
          type: "agentMessage",
          phase: "final_answer",
          text: JSON.stringify({ reply, actions }),
        },
      },
    });
    await g.event({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
    });
  }
  const params = await ask("再关注下eval的评测进度");
  assert(params.outputSchema);
  assert(
    !params.input[0].text.includes(source),
    "model only receives projected progress, not private file contents",
  );
  assert(params.input[0].text.includes("40"));
  assert.equal(g.data.job.candidates.length, 2);
  const candidate = g.data.job.candidates.find((c) => c.kind === "file");
  assert.equal(candidate.source, source);
  assert.equal(g.data.tasks.length, 0, "a candidate is not a registered watch");
  await finish([{ kind: "watch", target: candidate.id }]);
  assert.equal(g.data.tasks.length, 1);
  assert.equal(g.data.tasks[0].snapshot.done, 40);
  assert.match(g.view().messages.at(-1).text, /已关注/);
  assert.equal(
    await readFile(source, "utf8"),
    original,
    "monitor must not modify evaluator output",
  );
  const id = g.data.tasks[0].id;
  await ask("暂停关注 eval");
  await finish([{ kind: "pause", target: id }]);
  assert.equal(g.data.tasks[0].enabled, false);
  await ask("重新关注 eval");
  await finish([{ kind: "resume", target: id }]);
  assert.equal(g.data.tasks[0].enabled, true);
  await ask("现在怎么样了");
  await finish([], "评测条目完成 40/48。");
  assert.equal(g.data.tasks.length, 1);
  await ask("关注 eval");
  await finish([
    { kind: "pause", target: id },
    { kind: "watch", target: "/etc/passwd" },
  ]);
  assert.equal(g.data.tasks[0].enabled, true, "validate the entire action set before any change");
  assert.equal(g.data.tasks.length, 1);
  assert(reads.every((name) => name === "eval"));
  g.data.events.push({ id: "pending", taskId: id, read: false, analysis: "pending" });
  await ask("取消关注 eval");
  await finish([{ kind: "remove", target: id }]);
  assert.equal(g.data.tasks[0].archived, true);
  assert.equal(g.data.tasks[0].enabled, false);
  assert.equal(g.view().events.length, 0);
  assert.equal(g.data.events[0].analysis, "dismissed");
  assert.equal(await readFile(source, "utf8"), original, "removing a watch preserves source files");
  await g.update({ id, archived: false, enabled: true });
  assert.equal(g.data.tasks[0].enabled, true);
  await ask("继续关注 eval");
  await g.update({ id, archived: true });
  await finish([{ kind: "resume", target: id }]);
  assert.equal(
    g.data.tasks[0].archived,
    true,
    "an old assistant decision must not undo a newer manual removal",
  );
  await g.update({ id, archived: false, enabled: true });
  await g.update({ pauseAll: true });
  assert.equal(g.data.tasks[0].enabled, false);
  assert.equal(JSON.parse(await readFile(g.file, "utf8")).tasks[0].enabled, false);
});

test("guardian can stop connecting before a model turn exists", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/guardian-cancel-");
  let release;
  const waiting = new Promise((r) => (release = r)),
    calls = [];
  const g = new Guardian({
    runtime: dir + "/runtime",
    workspace: dir,
    registry: { allowed: ["eval"], items: { eval: { identity: "identity" } } },
    chats: { page: () => waiting },
    rpc: {
      request: async (method) => {
        calls.push(method);
        return {};
      },
      close() {},
    },
  });
  await g.init();
  t.after(() => g.close());
  await g.ask({ requestId: randomUUID(), text: "关注 eval" });
  await g.cancel();
  assert.equal(g.view().busy, false);
  release({ available: true, binding: "binding", messages: [] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, []);
  assert.match(g.view().messages.at(-1).text, /已停止/);
});

test("session notifications wait for a significant result, suppress progress and deduplicate milestones", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/guardian-session-");
  let started,
    sequence = 0,
    available = true,
    messages = [
      { id: "old", role: "assistant", phase: "final_answer", text: "之前的回复", time: 1 },
    ];
  const registry = {
      allowed: ["eval"],
      items: { eval: { identity: "identity" } },
      target: async () => ({}),
    },
    calls = [];
  const chats = { page: async () => ({ available, binding: "binding", messages }) };
  const rpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method === "turn/start") started?.(params);
      return { turn: { id: "turn" } };
    },
    close() {},
  };
  const g = new Guardian({ runtime: dir + "/runtime", workspace: dir, registry, chats, rpc });
  await g.init();
  t.after(() => g.close());
  const { id } = await g.watch({
    kind: "session",
    session: "eval",
    title: "评测成果",
    identity: "identity",
    binding: "binding",
  });
  const add = (text, phase = "final_answer") =>
    messages.push({ id: String(++sequence), role: "assistant", phase, text, time: Date.now() });
  async function review(text) {
    const ready = new Promise((r) => {
      started = r;
    });
    add(text);
    await g.tick();
    const params = await ready;
    await new Promise((r) => setImmediate(r));
    return { params, eventId: g.data.job.eventIds[0] };
  }
  async function finish(notices) {
    await g.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          id: randomUUID(),
          type: "agentMessage",
          phase: "final_answer",
          text: JSON.stringify({ notices }),
        },
      },
    });
    await g.event({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
    });
  }
  for (let i = 0; i < 3; i++) {
    add("正在检查第 " + i + " 步", "commentary");
    await g.tick();
  }
  assert.equal(calls.length, 0, "commentary does not start a review or notify");
  assert.equal(g.view().events.length, 0);
  let r = await review("后台评测已经启动，还在运行。");
  assert.equal(r.params.sandboxPolicy.type, "readOnly");
  assert(r.params.outputSchema.properties.notices);
  assert(
    !JSON.stringify(g.view()).includes("后台评测已经启动"),
    "classification evidence stays private",
  );
  assert.equal(g.view().events.length, 0, "a final reply is not itself a notification");
  await finish([]);
  assert.equal(g.view().messages.length, 0, "silent reviews do not fill the guardian chat");
  r = await review("整批评测完成，已整理并发布对比报告。");
  await finish([
    {
      eventId: r.eventId,
      state: "completed",
      milestone: "整批评测报告",
      text: "整批评测和报告已完成。",
    },
  ]);
  assert.equal(g.view().events.length, 1);
  assert.equal(g.view().events[0].state, "completed");
  available = false;
  await g.tick();
  available = true;
  await g.tick();
  assert.equal(g.data.job, null, "transient read failures do not reclassify the same reply");
  r = await review("补充说明：之前的报告也包含结果表。");
  assert(r.params.input[0].text.includes("整批评测报告"));
  await finish([
    {
      eventId: r.eventId,
      state: "completed",
      milestone: "整批评测报告",
      text: "报告结果表已完成。",
    },
  ]);
  assert.equal(g.view().events.length, 1, "the same milestone is not notified twice");
  r = await review("继续需要你提供新的授权。");
  await finish([
    {
      eventId: r.eventId,
      state: "attention",
      milestone: "需要授权",
      text: "下一批任务需要你提供授权。",
    },
  ]);
  assert.equal(g.view().events.length, 2);
  r = await review("第二批报告已完成。");
  await g.update({ id, enabled: false });
  await finish([
    { eventId: r.eventId, state: "completed", milestone: "第二批报告", text: "第二批报告已完成。" },
  ]);
  assert.equal(g.view().events.length, 2, "pausing while reviewing prevents a later notification");
  assert(
    calls.every((c) => ["thread/start", "thread/resume", "turn/start"].includes(c.method)),
    "the guardian never sends input to the work session",
  );
});

test("session watch follows new run generations and preserves missing or paused sources", async (t) => {
  const dir = await mkdtemp(process.env.TMPDIR + "/guardian-follow-");
  let now = Date.now(),
    run = "day-1",
    reads = 0;
  for (const suffix of ["day-1/model", "day-2/model-a", "day-2/model-b"])
    await mkdir(dir + "/outputs/" + suffix, { recursive: true });
  const old = dir + "/outputs/day-1/model/status.json",
    a = dir + "/outputs/day-2/model-a/status.json",
    b = dir + "/outputs/day-2/model-b/status.json";
  await writeFile(old, JSON.stringify({ total: 5, complete: 4, results: [] }));
  await writeFile(a, JSON.stringify({ total: 8, complete: 2, results: [] }));
  await writeFile(
    b,
    JSON.stringify({ total: 6, complete: 1, results: [{ status: "runtime_error" }] }),
  );
  const registry = {
    allowed: ["eval"],
    items: { eval: { identity: "identity" } },
    target: async () => ({}),
  };
  const chats = {
    page: async () => {
      reads++;
      return {
        available: true,
        binding: "binding",
        messages: [
          {
            role: "activity",
            details: [
              {
                label: "参数",
                text: JSON.stringify({
                  workdir: dir,
                  cmd: "read outputs/" + run + "/launch_specs.json",
                }),
              },
            ],
          },
          {
            role: "activity",
            details: [
              {
                label: "输出",
                text: Array.from(
                  { length: 12 },
                  (_, i) => dir + "/outputs/old-log-" + i + "/some/file.txt",
                ).join("\n"),
              },
            ],
          },
        ],
      };
    },
  };
  const g = new Guardian({
    runtime: dir + "/runtime",
    workspace: dir,
    registry,
    chats,
    clock: () => now,
    rpc: { request: async () => ({}), close() {} },
  });
  await g.init();
  g.busy = true;
  t.after(() => g.close());
  await g.follow("eval");
  assert.equal(g.data.tasks.length, 1);
  const task = g.data.tasks[0];
  assert.equal(task.kind, "bundle");
  assert.equal(task.snapshot.done, 4);
  assert.equal(task.snapshot.total, 5);
  await writeFile(old, JSON.stringify({ total: 5, complete: 5, results: [] }));
  await g.tick();
  assert.equal(task.snapshot.state, "completed");
  run = "day-2";
  now += 120001;
  await g.tick();
  assert.equal(task.snapshot.total, 14);
  assert.equal(task.snapshot.done, 3);
  assert.equal(task.snapshot.failures, 1);
  assert.equal(task.snapshot.state, "attention");
  assert.equal(task.sourceHistory.length, 1);
  assert.equal(task.sourceHistory[0].sources[0].source, old);
  assert.equal(g.data.tasks.length, 1, "a new generation updates the same compact watch");
  assert(!JSON.stringify(g.view()).includes(dir), "raw source paths stay private");
  assert.equal(g.view().checkedAt, now, "polling heartbeat is distinct from source mtime");
  await rename(b, b + ".saved");
  await g.tick();
  assert.equal(task.snapshot.total, null);
  assert.equal(
    task.snapshot.state,
    "unavailable",
    "missing batches cannot silently shrink the denominator",
  );
  await g.update({ id: task.id, enabled: false });
  const before = reads;
  now += 120001;
  await g.tick();
  assert.equal(reads, before, "paused watches do not discover or read tasks");
});
