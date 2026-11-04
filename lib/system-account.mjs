import { readFile, open, rename, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccountRpc } from "./account-rpc.mjs";

const fail = (message) => Object.assign(Error(message), { status: 409 });
const live = (job) => job && ["waiting", "applying"].includes(job.state);
const inactive = (thread) => ["idle", "notLoaded", "systemError"].includes(thread.status?.type);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function claims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  } catch {
    throw fail("账号登录资料不完整，请重新授权该账号");
  }
}
export function credential(data) {
  const t = data?.tokens,
    id = claims(t?.id_token || ""),
    access = claims(t?.access_token || "");
  if (
    data.OPENAI_API_KEY ||
    !t?.access_token ||
    !t.refresh_token ||
    !t.account_id ||
    typeof id.email !== "string"
  )
    throw fail("只支持已授权的 ChatGPT 账号");
  return {
    accountId: t.account_id,
    email: id.email,
    subject: id.sub || id.email,
    expires: access.exp || 0,
    params: {
      type: "chatgptAuthTokens",
      accessToken: t.access_token,
      chatgptAccountId: t.account_id,
      chatgptPlanType: id["https://api.openai.com/auth"]?.chatgpt_plan_type || null,
    },
  };
}
async function atomic(file, value) {
  const next = file + "." + randomUUID() + ".next",
    handle = await open(next, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(next, file);
    const dir = await open(path.dirname(file), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (e) {
    await unlink(next).catch(() => {});
    throw e;
  }
}

// Shared login only: no fork, resume, window selection or terminal keystrokes.
export class SystemAccount {
  constructor(pool, { rpc, readAuth, writeAuth, now = Date.now } = {}) {
    this.pool = pool;
    this.home = pool.defaultHome;
    this.file = path.join(pool.runtime, "system-account.json");
    this.now = now;
    this.data = { selected: null, job: null };
    this.busy = false;
    this.closed = false;
    this.write = Promise.resolve();
    this.readAuth =
      readAuth ||
      (async (home) => JSON.parse(await readFile(path.join(home, "auth.json"), "utf8")));
    this.writeAuth =
      writeAuth ||
      (async (home, data) => {
        const file = path.join(home, "auth.json");
        try {
          if ((await lstat(file)).isSymbolicLink())
            throw fail("登录文件是符号链接，未覆盖；请先确认存储方式");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        await atomic(file, data);
      });
    this.rpc = rpc || new AccountRpc(this.home, { onRequest: (m) => this.refreshTokens(m) });
  }
  async init() {
    try {
      this.data = JSON.parse(await readFile(this.file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (this.data.job?.state === "applying") {
      this.data.job.state = "uncertain";
      this.data.job.message = "上次切换被服务重启打断；未自动重试，请核对当前账号后重新选择";
      await this.save();
    }
    // Retire only legacy auto-switch intentions. Keep every original/copy window.
    let changed = false;
    for (const job of this.pool.switches.values())
      if (["waiting", "switching", "starting"].includes(job.state)) {
        job.state = "cancelled";
        job.message = "已改用系统统一账号；原窗口和副本保留，不再自动切入";
        changed = true;
      }
    if (changed) await this.pool.saveJobs();
    this.timer = setInterval(() => void this.tick(), 4000);
    this.timer.unref();
  }
  save() {
    const data = JSON.parse(JSON.stringify(this.data));
    this.write = this.write.catch(() => {}).then(() => atomic(this.file, data));
    return this.write;
  }
  async status() {
    let accountId = null,
      label = "系统账号",
      state = "unavailable",
      emailHint = null;
    try {
      await this.ensureBridge();
      const value = await this.rpc.request("account/read", { refreshToken: false });
      state =
        value.account?.type === "chatgpt" ? "ready" : value.account ? "unsupported" : "signed_out";
      const email = value.account?.email;
      if (email) {
        const [local, domain] = email.split("@");
        emailHint = local.slice(0, 2) + "…@" + domain;
      }
      if (this.data.selected) {
        const source = credential(await this.readAuth(this.pool.home(this.data.selected)));
        if (state === "ready" && source.email === email) {
          accountId = this.data.selected;
          label = this.pool.item(accountId).label;
        }
      }
    } catch {}
    const job = this.data.job;
    return {
      accountId,
      label,
      state,
      emailHint,
      scope: "shared",
      switch: job
        ? { id: job.id, accountId: job.accountId, state: job.state, message: job.message }
        : null,
    };
  }
  async request(input) {
    if (input.confirm !== true || !uuid.test(input.requestId || "") || input.scope !== "system")
      throw fail("请确认切换整个系统的共享 Codex 账号");
    const item = this.pool.item(input.accountId);
    if (item.builtin) throw fail("请选择已保存的账号");
    if (this.data.job?.id === input.requestId) {
      if (this.data.job.accountId !== input.accountId) throw fail("请求编号已用于另一账号");
      return this.status();
    }
    if (this.busy || live(this.data.job)) throw fail("已有系统切换请求，请等待或先取消");
    this.data.job = {
      id: input.requestId,
      accountId: input.accountId,
      state: "waiting",
      message: "等待当前任务结束后统一切换；不会重启终端或复制对话",
    };
    try {
      await this.save();
    } catch (e) {
      this.data.job = null;
      throw e;
    }
    void this.tick();
    return this.status();
  }
  async cancel(id) {
    if (this.data.job?.id !== id || this.data.job.state !== "waiting")
      throw fail("当前切换已进入提交阶段，不能取消");
    this.data.job.state = "cancelled";
    this.data.job.message = "已取消系统账号切换";
    await this.save();
    return { ok: true };
  }
  async loaded() {
    const ids = new Set();
    let cursor;
    do {
      const page = await this.rpc.request("thread/loaded/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.data)) throw fail("无法核对后台任务");
      for (const id of page.data) {
        if (ids.has(id) || ids.size >= 1000) throw fail("无法核对后台任务");
        ids.add(id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return Promise.all(
      [...ids].map(async (id) => {
        const { thread } = await this.rpc.request("thread/read", {
          threadId: id,
          includeTurns: false,
        });
        if (thread?.id !== id) throw fail("无法核对后台任务");
        return thread;
      }),
    );
  }
  async source(id, { refresh = false } = {}) {
    let data = await this.readAuth(this.pool.home(id)),
      info = credential(data);
    if (refresh || info.expires * 1000 < this.now() + 120000) {
      await (await this.pool.client(id)).request("account/read", { refreshToken: true });
      data = await this.readAuth(this.pool.home(id));
      info = credential(data);
    }
    if (info.expires * 1000 < this.now() + 30000) throw fail("目标账号登录已过期，请重新授权");
    return { data, info };
  }
  async refreshTokens(message) {
    if (this.refreshing) {
      await this.refreshing;
      return this.refreshTokens(message);
    }
    const id = this.data.selected;
    if (!id || this.closed || this.data.job?.state === "applying") throw fail("系统账号正在切换");
    this.refreshing = (async () => {
      const { data, info } = await this.source(id, { refresh: true });
      if (
        this.closed ||
        this.data.selected !== id ||
        this.data.job?.state === "applying" ||
        (message.params?.previousAccountId && message.params.previousAccountId !== info.accountId)
      )
        throw fail("账号已变化，不为旧请求续期");
      await this.writeAuth(this.home, data);
      const { type, ...tokens } = info.params;
      return tokens;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  async ensureBridge() {
    if (!this.data.selected || this.busy || this.data.job?.state === "uncertain" || this.closed)
      return;
    if (this.bridgePending) return this.bridgePending;
    this.bridgePending = (async () => {
      await this.rpc.connect?.();
      if (this.bridgeWs && this.bridgeWs === this.rpc.ws) return;
      const shared = credential(await this.readAuth(this.home)),
        source = await this.source(this.data.selected);
      // A manual login outside the desk must not be silently undone.
      if (shared.accountId !== source.info.accountId || shared.subject !== source.info.subject) {
        this.data.selected = null;
        await this.save();
        return;
      }
      if (this.closed || this.busy) return;
      await this.rpc.request("account/login/start", source.info.params);
      await this.writeAuth(this.home, source.data);
      this.bridgeWs = this.rpc.ws;
    })().finally(() => {
      this.bridgePending = null;
    });
    return this.bridgePending;
  }
  async tick() {
    if (this.closed || this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  async runTick() {
    if (this.closed || this.busy) return;
    if (this.data.job?.state !== "waiting") {
      await this.ensureBridge().catch(() => {});
      return;
    }
    if (this.bridgePending || this.refreshing) return;
    this.busy = true;
    const job = this.data.job;
    let previous,
      previousId,
      committing = false;
    const still = () => !this.closed && this.data.job === job && job.state === "waiting";
    try {
      // Only hold the shared auth update until all loaded turns are idle.
      const rows = await this.loaded();
      const working = rows.filter((t) => t.status?.type === "active");
      if (working.length) {
        job.message = `等待 ${working.length} 个正在运行的任务结束后统一切换；可取消`;
        return;
      }
      if (rows.some((t) => !inactive(t)))
        throw fail("后台返回了无法识别的任务状态；未更改登录，请稍后重试");
      const target = await this.source(job.accountId);
      if (!still()) return;
      previous = await this.readAuth(this.home);
      const old = credential(previous);
      previousId = this.data.selected || job.previousId;
      const prior = previousId ? credential(await this.readAuth(this.pool.home(previousId))) : null;
      if (!prior || prior.subject !== old.subject || prior.accountId !== old.accountId) {
        previousId = null;
        for (const id of Object.keys(this.pool.items)) {
          try {
            const info = credential(await this.readAuth(this.pool.home(id)));
            if (info.subject === old.subject && info.accountId === old.accountId) {
              previousId = id;
              break;
            }
          } catch {}
        }
        if (!previousId) previousId = (await this.pool.add("切换前的系统账号")).id;
        await this.writeAuth(this.pool.home(previousId), previous);
        job.previousId = previousId;
        await this.save();
      }
      if (!still()) return;
      // An open keyboard is not a running task. Gate only the short commit,
      // and let already-started message deliveries finish before checking again.
      if (this.pool.terminals.accountDeliveryPending?.()) return;
      this.pool.terminals.systemAccountApplying = true;
      if ((await this.loaded()).some((t) => !inactive(t))) return;
      if (!still() || this.refreshing) return;
      job.state = "applying";
      job.message = "正在更新系统登录；不重启终端";
      job.previousId = previousId;
      await this.save();
      committing = true;
      await this.writeAuth(this.home, target.data);
      await this.rpc.request("account/login/start", target.info.params);
      const result = await this.rpc.request("account/read", { refreshToken: false });
      if (result.account?.type !== "chatgpt" || result.account.email !== target.info.email)
        throw fail("后台尚未确认目标账号");
      this.data.selected = job.accountId;
      job.state = "complete";
      job.message = "系统共享 Codex 账号已切换；原对话、终端和预览不变";
      this.bridgeWs = this.rpc.ws;
      this.pool.quotas.clear();
      await this.save();
    } catch (e) {
      if (committing && previous) {
        try {
          const old = credential(previous);
          await this.writeAuth(this.home, previous);
          await this.rpc.request("account/login/start", old.params);
          const result = await this.rpc.request("account/read", { refreshToken: false });
          if (result.account?.email !== old.email) throw Error("rollback unconfirmed");
          this.data.selected = previousId;
          this.bridgeWs = this.rpc.ws;
          job.state = "failed";
          job.message = "切换未完成，已恢复原账号；终端和对话未改动";
        } catch {
          job.state = "uncertain";
          job.message = "账号切换结果未能确认，未重启任何终端；请核对系统登录后重试";
        }
      } else if (job.state !== "cancelled") {
        job.state = "failed";
        job.message = e.status ? e.message : "账号暂时无法连接，尚未更改系统登录，请稍后重试";
      }
      await this.save().catch(() => {});
    } finally {
      this.pool.terminals.systemAccountApplying = false;
      this.busy = false;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([this.inFlight, this.bridgePending, this.refreshing]);
    this.rpc.close();
    await this.write.catch(() => {});
  }
}
