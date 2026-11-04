import { mkdir, readFile, writeFile, rename, realpath, stat, unlink, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AccountRpc } from "./account-rpc.mjs";
import { AccountQuota } from "./account-quota.mjs";
import { observeTerminal } from "./terminal-status.mjs";
import { portableRollout } from "./account-history.mjs";
import { Chats } from "./chat.mjs";

const exec = promisify(execFile),
  uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (message, status = 409) => Object.assign(Error(message), { status });
const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
const samePane = (a, b) => {
  const x = a.split("\t"),
    y = b.split("\t");
  return x[0] === y[0] && x[1] === y[1] && (x[4] || "default") === (y[4] || "default");
};
const active = (job) => job && ["waiting", "switching", "starting"].includes(job.state);
export function isolatedEnvironment(home, base = process.env) {
  const env = {
    ...base,
    CODEX_HOME: home,
    TMPDIR: path.join(home, "tmp"),
    XDG_CACHE_HOME: path.join(home, "cache"),
  };
  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_REMOTE_TOKEN",
    "CODEX_REMOTE_URL",
    "CODEX_THREAD_ID",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "TMUX",
    "TMUX_PANE",
  ])
    delete env[key];
  return env;
}
export class AccountPool {
  constructor({
    runtime,
    root,
    defaultHome,
    registry,
    terminals,
    chats,
    command = exec,
    readContext,
    readCandidate,
    copyHistory = portableRollout,
    rpcFactory = (home, options) => new AccountRpc(home, options),
  }) {
    Object.assign(this, {
      runtime,
      root,
      defaultHome,
      registry,
      terminals,
      chats,
      command,
      rpcFactory,
      copyHistory,
    });
    this.readContext =
      readContext ||
      (async (home, thread) => {
        const helper = new URL("./account-context.py", import.meta.url).pathname;
        try {
          const result = await this.command("python3", ["-B", helper, home, thread], {
            timeout: 15000,
            maxBuffer: 262144,
          });
          return JSON.parse(result.stdout);
        } catch {
          throw fail("原对话的执行权限暂时不能迁移；没有切换或扩大权限。");
        }
      });
    this.file = path.join(runtime, "accounts.json");
    this.items = {};
    this.clients = new Map();
    this.started = new Set();
    this.starting = new Map();
    this.flows = new Map();
    this.quotas = new Map();
    this.switches = new Map();
    this.write = Promise.resolve();
    this.jobsFile = path.join(runtime, "account-switches.json");
    this.jobsWrite = Promise.resolve();
    this.inFlight = new Map();
    this.reservations = new Set();
    this.closed = false;
    this.readCandidate = readCandidate || this.candidate.bind(this);
  }
  async init() {
    try {
      this.items = JSON.parse(await readFile(this.file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    try {
      this.switches = new Map(Object.entries(JSON.parse(await readFile(this.jobsFile, "utf8"))));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const job of this.switches.values())
      if (job.state === "switching") {
        // Fork/window creation may already have happened. Never replay it blindly.
        job.state = "failed";
        job.message = "服务重启时准备尚未完成；原窗口保留，请重新选择账号。";
      }
    if (this.switches.size) await this.saveJobs();
    this.timer = setInterval(() => void this.tick(), 4000);
    this.timer.unref();
  }
  saveJobs() {
    const content = JSON.stringify(Object.fromEntries(this.switches));
    this.jobsWrite = this.jobsWrite
      .catch(() => {})
      .then(async () => {
        const file = await open(this.jobsFile + ".next", "w", 0o600);
        try {
          await file.writeFile(content);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(this.jobsFile + ".next", this.jobsFile);
        const dir = await open(this.runtime, "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      });
    return this.jobsWrite;
  }
  async transition(job, state, message) {
    job.state = state;
    job.message = message;
    await this.saveJobs();
  }
  item(id) {
    if (id === "default") return { id, label: "原有账号", builtin: true };
    const item = this.items[id];
    if (!item || !/^a_[a-f0-9]{12}$/.test(id)) throw fail("账号不存在", 404);
    return item;
  }
  home(id) {
    this.item(id);
    return id === "default" ? this.defaultHome : path.join(this.root, id);
  }
  async save() {
    const content = JSON.stringify(this.items);
    this.write = this.write
      .catch(() => {})
      .then(async () => {
        await writeFile(this.file + ".next", content, { mode: 0o600 });
        await rename(this.file + ".next", this.file);
      });
    return this.write;
  }
  async add(label) {
    label = String(label || "").trim();
    if (!label || label.length > 40 || /[\x00-\x1f\x7f]/.test(label))
      throw fail("请填写 1–40 字的账号昵称", 400);
    const id = "a_" + randomUUID().replaceAll("-", "").slice(0, 12),
      home = path.join(this.root, id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    for (const dir of ["tmp", "cache"]) await mkdir(path.join(home, dir), { mode: 0o700 });
    // No copying auth, config secrets or another account's mutable databases.
    await writeFile(
      path.join(home, "config.toml"),
      'cli_auth_credentials_store = "file"\ndefault_permissions = ":workspace"\napproval_policy = "on-request"\n',
      { mode: 0o600, flag: "wx" },
    );
    this.items[id] = { id, label, created: Date.now() };
    await this.save();
    return this.items[id];
  }
  async rename(id, label) {
    const item = this.item(id);
    if (item.builtin) throw fail("原有账号保持原名");
    label = String(label || "").trim();
    if (!label || label.length > 40 || /[\x00-\x1f\x7f]/.test(label)) throw fail("昵称无效", 400);
    item.label = label;
    await this.save();
    return { ok: true };
  }
  async ensure(id) {
    this.item(id);
    if (id === "default" || this.started.has(id)) return;
    if (!this.starting.has(id))
      this.starting.set(
        id,
        (async () => {
          await this.command("codex", ["app-server", "daemon", "start"], {
            env: isolatedEnvironment(this.home(id)),
            cwd: this.home(id),
            timeout: 15000,
            maxBuffer: 65536,
          }).catch(() => {
            throw fail("独立账号后台启动失败，请稍后重试。", 503);
          });
          this.started.add(id);
        })().finally(() => this.starting.delete(id)),
      );
    await this.starting.get(id);
  }
  async client(id) {
    await this.ensure(id);
    if (!this.clients.has(id))
      this.clients.set(
        id,
        this.rpcFactory(this.home(id), {
          notify: (m) => {
            if (m.method === "account/login/completed") {
              const flow = this.flows.get(id);
              if (flow && m.params?.loginId === flow.loginId) {
                flow.state = m.params.success ? "complete" : "failed";
                delete flow.userCode;
                delete flow.url;
              }
            }
          },
        }),
      );
    return this.clients.get(id);
  }
  async status(id) {
    const item = this.item(id),
      flow = this.flows.get(id);
    let state = "unavailable",
      plan = null,
      emailHint = null;
    try {
      const result = await (await this.client(id)).request("account/read", { refreshToken: false });
      state =
        result.account?.type === "chatgpt"
          ? "ready"
          : result.account
            ? "unsupported"
            : "signed_out";
      plan = typeof result.account?.planType === "string" ? result.account.planType : null;
      const email = result.account?.email;
      if (typeof email === "string" && email.includes("@")) {
        const [local, domain] = email.slice(0, 254).split("@");
        emailHint = local.slice(0, 2) + "…@" + domain;
      }
      if (state === "ready" && flow?.state === "pending") {
        flow.state = "complete";
        delete flow.userCode;
        delete flow.url;
      }
    } catch {
      this.started.delete(id);
    }
    return {
      ...item,
      state,
      plan,
      emailHint,
      login: flow
        ? {
            state: flow.state,
            ...(flow.state === "pending" ? { url: flow.url, userCode: flow.userCode } : {}),
          }
        : null,
    };
  }
  async list() {
    return {
      accounts: await Promise.all(
        ["default", ...Object.keys(this.items)].map((id) => this.status(id)),
      ),
    };
  }
  async login(id) {
    if (id === "default") throw fail("不会改动原有账号的登录，请添加一个独立账号。");
    if (this.flows.get(id)?.state === "pending") return this.status(id);
    const rpc = await this.client(id),
      account = await rpc.request("account/read", { refreshToken: false });
    if (account.account) throw fail("该账号已登录；添加另一个账号即可，不会覆盖正在使用的登录。");
    const flow = { state: "starting" };
    this.flows.set(id, flow);
    try {
      const result = await rpc.request("account/login/start", { type: "chatgptDeviceCode" }, 25000);
      const url = new URL(result.verificationUrl);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "auth.openai.com" ||
        url.pathname !== "/codex/device" ||
        typeof result.userCode !== "string" ||
        result.userCode.length > 64 ||
        typeof result.loginId !== "string"
      )
        throw Error("unexpected login response");
      Object.assign(flow, {
        loginId: result.loginId,
        state: "pending",
        url: url.href,
        userCode: result.userCode,
      });
      return { state: flow.state, url: flow.url, userCode: flow.userCode };
    } catch {
      flow.state = "failed";
      throw fail(
        "设备授权暂时未开启或登录服务不可用。请先在 ChatGPT 安全设置中启用设备代码登录，再重试。",
        503,
      );
    }
  }
  async cancelLogin(id) {
    const flow = this.flows.get(id);
    if (flow?.loginId && flow.state === "pending")
      await (await this.client(id)).request("account/login/cancel", { loginId: flow.loginId });
    this.flows.delete(id);
    return { ok: true };
  }
  async current(name, identity) {
    const target = await this.registry.target(
      name,
      identity ?? this.registry.items[name]?.identity,
    );
    const meta = (
      await this.registry.command([
        "display-message",
        "-p",
        "-t",
        target.id,
        "#{pane_id}\t#{pane_pid}\t#{pane_height}\t#{pane_in_mode}\t#{@desk_account}",
      ])
    ).trimEnd();
    const account = meta.split("\t")[4] || "default";
    this.item(account);
    return { target, meta, account, pane: meta.split("\t")[0], home: this.home(account) };
  }
  async homeFor(name) {
    return (await this.current(name)).home;
  }
  homeFromMeta(meta) {
    return this.home(meta.split("\t")[4] || "default");
  }
  async quota(id) {
    this.item(id);
    if (!this.quotas.has(id))
      this.quotas.set(
        id,
        new AccountQuota(this.home(id), {
          read: async () => (await this.client(id)).request("account/rateLimits/read"),
          refresh: async () =>
            (await this.client(id)).request("account/read", { refreshToken: true }),
        }),
      );
    return { ...(await this.quotas.get(id).snapshot()), accountId: id, label: this.item(id).label };
  }
  async session(name, identity) {
    const current = await this.current(name, identity),
      job = this.switches.get(name);
    return {
      accountId: current.account,
      label: this.item(current.account).label,
      switch: job
        ? { id: job.id, accountId: job.accountId, state: job.state, message: job.message }
        : null,
    };
  }
  async switch(name, input) {
    if (
      input.confirm !== true ||
      !uuid.test(input.requestId || "") ||
      typeof input.identity !== "string" ||
      !/^\d+:\d+:[a-f0-9-]{36}$/.test(input.binding || "")
    )
      throw fail("请载入当前对话后确认切换", 400);
    this.item(input.accountId);
    if (input.accountId === "default")
      throw fail("原有账号保持原样；如需在账号池中使用它，请把它也添加并独立登录。");
    const existing = this.switches.get(name);
    if (existing?.id === input.requestId) {
      if (
        existing.accountId !== input.accountId ||
        existing.identity !== input.identity ||
        existing.binding !== input.binding
      )
        throw fail("切换编号已用于另一请求");
      return this.session(name, input.identity);
    }
    if (active(existing) || this.reservations.has(name) || this.inFlight.has(name))
      throw fail("已有切换请求，取消后可重新选择");
    this.reservations.add(name);
    try {
      const current = await this.current(name, input.identity);
      if (current.account === input.accountId) return this.session(name, input.identity);
      const job = {
        id: input.requestId,
        identity: input.identity,
        binding: input.binding,
        accountId: input.accountId,
        source: current.account,
        meta: current.meta,
        state: "waiting",
        message: "等待原会话空闲后接续；可取消",
      };
      this.switches.set(name, job);
      try {
        await this.saveJobs();
      } catch (e) {
        this.switches.delete(name);
        throw e;
      }
      this.run(name, job);
      return this.session(name, input.identity);
    } finally {
      this.reservations.delete(name);
    }
  }
  async cancel(name, id) {
    const job = this.switches.get(name);
    if (
      !job ||
      job.id !== id ||
      !["waiting", "starting"].includes(job.state) ||
      (job.activating && this.inFlight.has(name))
    )
      throw fail("当前已在执行切换，请稍后查看结果");
    await this.transition(job, "cancelled", "已取消；原窗口保留，已创建的副本不会自动切入");
    return { ok: true };
  }
  run(name, job) {
    if (this.closed || this.inFlight.has(name) || !active(job)) return;
    const work = this.perform(name, job)
      .catch(() => {
        job.state = "failed";
        job.message = "切换状态保存失败，未确认完成；请检查窗口后重试。";
      })
      .finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, work);
  }
  async tick() {
    for (const [name, job] of this.switches)
      if (["waiting", "starting"].includes(job.state)) this.run(name, job);
  }
  continuing(job) {
    return !this.closed && active(job);
  }
  async candidate(name, job) {
    const session = await this.registry.target(name, job.identity);
    const check = async () => {
      const fields = (
        await this.registry.command([
          "display-message",
          "-p",
          "-t",
          job.pane,
          "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@desk_account}\t#{@desk_thread}",
        ])
      )
        .trim()
        .split("\t");
      if (
        fields[0] !== session.id ||
        fields[1] !== job.window ||
        fields[2] !== job.pane ||
        fields[4] !== job.accountId ||
        fields[5] !== job.fork
      )
        throw fail("接续窗口已变化；没有切换");
      if (fields[3] === "1") throw fail("新 Codex 启动失败；原窗口仍保留，请检查目标账号后重试");
      return { id: job.pane };
    };
    await check();
    const registry = {
      socket: this.registry.socket,
      command: this.registry.command.bind(this.registry),
      target: async () => {
        await this.registry.target(name, job.identity);
        return check();
      },
    };
    const reader = new Chats(registry, {
      home: this.home(job.accountId),
      writers: this.terminals.writers,
    });
    try {
      return await reader.page(name, new URLSearchParams({ identity: job.identity }));
    } catch (e) {
      await check();
      return { available: false };
    }
  }
  async sourceUnchanged(name, job) {
    const current = await this.current(name, job.identity);
    if (!samePane(current.meta, job.meta)) throw fail("原窗口已变化；接续副本保留但没有切换");
    const view = await this.chats.page(
      name,
      new URLSearchParams({ identity: job.identity, binding: job.binding }),
    );
    const { thread } = await (
      await this.client(job.source)
    ).request("thread/read", { threadId: job.binding.split(":").at(-1), includeTurns: false });
    const stamp = await stat(job.rollout);
    if (
      !view.available ||
      view.readOnly ||
      view.binding !== job.binding ||
      view.runtime.state !== "ready" ||
      thread?.id !== job.binding.split(":").at(-1) ||
      thread.status?.type !== "idle" ||
      thread.updatedAt !== job.updatedAt ||
      stamp.size !== job.sourceSize ||
      stamp.mtimeMs !== job.sourceMtime
    )
      throw fail("准备期间原对话有更新或继续工作；没有切到旧副本，请重新选择账号");
    const [pane, , height, mode] = current.meta.split("\t");
    if (mode !== "0") throw fail("原窗口正在查看历史；没有自动切换");
    const footer = await this.registry.command(
      [
        "capture-pane",
        "-p",
        "-t",
        pane,
        "-S",
        String(Math.max(0, Number(height) - 18)),
        "-E",
        String(Number(height) - 1),
      ],
      32768,
    );
    const composer = footer
      .replace(/[\u2800-\u28ff]/g, " ")
      .split("\n")
      .reverse()
      .find((line) => /^\s*[›»]/.test(line));
    if (!composer || !/^\s*[›»]\s*(?:Ask Codex to do anything[.…]*)?\s*$/i.test(composer))
      throw fail("原窗口还有未发送的输入；没有自动切换");
    if (!samePane((await this.current(name, job.identity)).meta, job.meta))
      throw fail("原窗口已变化；没有切换");
  }
  async finishStart(name, job, lease) {
    let view;
    try {
      view = await this.readCandidate(name, job);
    } catch (e) {
      if (e.status) throw e;
      view = { available: false };
    }
    if (!this.continuing(job)) return;
    const current = await this.current(name, job.identity);
    const selected = current.pane === job.pane && current.account === job.accountId;
    if (
      view.available &&
      (view.provider === "claude" || view.binding?.split(":").at(-1) !== job.fork)
    )
      throw fail("接续窗口已进入其他对话；没有自动切换");
    if (
      !view.available ||
      view.readOnly ||
      view.binding?.split(":").at(-1) !== job.fork ||
      !["ready", "running", "waiting"].includes(view.runtime?.state)
    ) {
      job.message = "新 Codex 尚未就绪；原窗口仍可使用，也可取消等待";
      return;
    }
    // Recovery after select-window: verify the exact destination, never fork again.
    if (selected && job.activating) {
      await this.transition(job, "complete", "已切换，接续原对话；原窗口已保留");
      return;
    }
    if (!samePane(current.meta, job.meta)) throw fail("当前窗口已被手动切换；没有覆盖你的选择");
    if (view.runtime.state !== "ready") {
      job.message = "接续窗口尚未空闲；原窗口保留，可取消后检查新窗口";
      return;
    }
    if (this.terminals.writers.has(name)) return;
    this.terminals.writers.set(name, lease);
    await this.sourceUnchanged(name, job);
    if (!this.continuing(job)) return;
    job.activating = true;
    await this.saveJobs();
    if (!this.continuing(job)) return;
    await this.registry.command(["select-window", "-t", job.window]);
    const after = await this.current(name, job.identity);
    if (after.pane !== job.pane || after.account !== job.accountId)
      throw fail("窗口切换结果未确认；没有标记完成，请查看原终端");
    await this.transition(job, "complete", "已切换，接续原对话；原窗口已保留");
  }
  async perform(name, job) {
    let forkClient, portable;
    const lease = { accountSwitch: true };
    try {
      if (!this.continuing(job)) return;
      if (job.state === "starting") {
        await this.finishStart(name, job, lease);
        return;
      }
      if (this.terminals.writers.has(name)) {
        job.message = "等待当前输入完成；可取消切换";
        return;
      }
      const current = await this.current(name, job.identity);
      if (!samePane(current.meta, job.meta) || current.account !== job.source)
        throw fail("原终端已切换，已取消这次账号切换。");
      const view = await this.chats.page(
        name,
        new URLSearchParams({ identity: job.identity, binding: job.binding }),
      );
      if (!this.continuing(job)) return;
      if (
        view.provider === "claude" ||
        view.reason === "changed" ||
        (view.available && view.binding !== job.binding)
      )
        throw fail("当前不是原来的 Codex 对话；没有改动原终端。");
      if (!view.available || view.readOnly) {
        job.message = "正在等待核对原对话；不会中断任务，可取消";
        return;
      }
      if (view.runtime.state === "running" || view.runtime.state === "waiting") {
        job.message = "本轮结束后切换；原任务继续运行";
        return;
      }
      if (view.runtime.state !== "ready") {
        job.message = "等待原会话状态明确；可取消切换";
        return;
      }
      const targetStatus = await this.status(job.accountId);
      if (!this.continuing(job)) return;
      if (targetStatus.state !== "ready") throw fail("目标账号尚未完成 ChatGPT 登录。");
      const source = await this.client(job.source),
        dest = await this.client(job.accountId),
        threadId = job.binding.split(":").at(-1);
      if (!uuid.test(threadId)) throw fail("原对话编号无效");
      const { thread } = await source.request("thread/read", { threadId, includeTurns: false });
      if (thread?.id === threadId && thread.status?.type === "active") {
        job.message = "原任务继续运行，结束后切换";
        return;
      }
      if (
        thread?.id !== threadId ||
        thread.status?.type !== "idle" ||
        !path.isAbsolute(thread.cwd || "") ||
        !thread.path
      )
        throw fail("原对话尚未空闲或暂不支持接续；没有切换。");
      const rollout = await realpath(thread.path),
        sourceHome = await realpath(current.home);
      if (!rollout.startsWith(sourceHome + path.sep) || !(await stat(rollout)).isFile())
        throw fail("原对话的历史文件不可用");
      const before = await this.current(name, job.identity);
      if (!samePane(before.meta, job.meta)) throw fail("原窗口已变化，没有切换");
      if ((await observeTerminal(this.registry, before.meta)).state !== "ready") return;
      if (!this.continuing(job) || this.terminals.writers.has(name)) return;
      this.terminals.writers.set(name, lease);
      await this.transition(job, "switching", "正在复制已保存的对话…");
      // Official fork preserves full persisted context, including compaction;
      // never reduce the conversation to visible chat text or edit its database.
      const context = await this.readContext(current.home, threadId);
      const settings = {
        ...context.config,
        ...(view.model ? { model: view.model } : {}),
        ...(view.effort ? { model_reasoning_effort: view.effort } : {}),
      };
      const sourceStamp = await stat(rollout);
      Object.assign(job, {
        rollout,
        updatedAt: thread.updatedAt,
        sourceSize: sourceStamp.size,
        sourceMtime: sourceStamp.mtimeMs,
      });
      portable = await this.copyHistory(rollout, this.home(job.accountId), threadId);
      if (!this.continuing(job)) return;
      const fork = await dest.request(
        "thread/fork",
        {
          threadId,
          path: portable,
          cwd: thread.cwd,
          excludeTurns: true,
          deferGoalContinuation: true,
          ...context.params,
          ...(view.model ? { model: view.model } : {}),
          config: settings,
        },
        60000,
      );
      const next = fork.thread?.id;
      if (!uuid.test(next || "")) throw fail("接续副本未创建，原对话未改动。");
      job.fork = next;
      forkClient = dest;
      if (
        context.params.permissions &&
        fork.activePermissionProfile?.id !== context.params.permissions
      )
        throw fail("目标环境没有采用原会话的权限设置；未切换。");
      await dest.request("thread/name/set", {
        threadId: next,
        name: name + "-" + job.accountId.slice(0, 8) + "-" + next.slice(-4),
      });
      await dest.request("thread/unsubscribe", { threadId: next });
      forkClient = null;
      const latest = await this.current(name, job.identity),
        live = await source.request("thread/read", { threadId, includeTurns: false });
      const afterStamp = await stat(rollout);
      if (
        !samePane(latest.meta, job.meta) ||
        afterStamp.size !== sourceStamp.size ||
        afterStamp.mtimeMs !== sourceStamp.mtimeMs ||
        live.thread?.updatedAt !== thread.updatedAt ||
        live.thread?.status?.type !== "idle" ||
        (await observeTerminal(this.registry, latest.meta)).state !== "ready"
      )
        throw fail("复制期间原对话有更新，未切换；请重新操作。");
      // A detached window cannot steal focus until its account tag is in place.
      // Keep every old window and process; no kill, respawn or global login swap.
      const launcher = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../scripts/account-terminal.mjs",
      );
      const launchRoot = path.join(this.runtime, "account-launch");
      await mkdir(launchRoot, { recursive: true, mode: 0o700 });
      const launchFile = path.join(launchRoot, next + ".json");
      await writeFile(
        launchFile,
        JSON.stringify({ home: this.home(job.accountId), thread: next, settings }),
        { mode: 0o600, flag: "wx" },
      );
      const args = [process.execPath, launcher, launchFile];
      if (!this.continuing(job)) return;
      const output = (
        await this.registry.command([
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{window_id}\t#{pane_id}",
          "-t",
          current.target.id,
          "-n",
          "codex-" + job.accountId,
          "-c",
          thread.cwd,
          args.map(quote).join(" "),
        ])
      ).trim();
      const [window, pane] = output.split("\t");
      if (!/^@\d+$/.test(window) || !/^%\d+$/.test(pane))
        throw fail("窗口创建结果未确认；请刷新查看原终端。");
      await this.registry.command(["set-option", "-w", "-t", window, "remain-on-exit", "failed"]);
      await this.registry.command(["set-option", "-p", "-t", pane, "@desk_account", job.accountId]);
      await this.registry.command(["set-option", "-p", "-t", pane, "@desk_thread", next]);
      Object.assign(job, { window, pane });
      await this.transition(job, "starting", "新 Codex 正在启动；确认就绪后切换，原窗口可继续使用");
    } catch (e) {
      if (!this.closed && job.state !== "cancelled")
        await this.transition(
          job,
          "failed",
          e.status ? e.message : "切换未完成，原窗口和任务仍保留。",
        );
    } finally {
      if (portable) await unlink(portable).catch(() => {});
      if (forkClient) {
        await forkClient.request("thread/unsubscribe", { threadId: job.fork }).catch(() => {
          forkClient.close();
          this.clients.delete(job.accountId);
        });
      }
      if (this.terminals.writers.get(name) === lease) this.terminals.writers.delete(name);
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const client of this.clients.values()) client.close();
    await this.jobsWrite.catch(() => {});
  }
}
