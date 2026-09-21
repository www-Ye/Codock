import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cookies, equal } from "./auth.mjs";

// Authorization is per instance. No first-visitor enrollment or username-only matching.
export const callbackPath = "/auth/github/callback";
export function validateGithubConfig(config) {
  if (
    !config ||
    typeof config.clientId !== "string" ||
    !/^[A-Za-z0-9_.-]{6,100}$/.test(config.clientId) ||
    typeof config.clientSecret !== "string" ||
    !/^[A-Za-z0-9_\-]{16,512}$/.test(config.clientSecret)
  )
    throw Error("GitHub 应用配置格式不正确");
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}
function failure(code, status = 401) {
  return Object.assign(Error(code), { oauthCode: code, status });
}

export class GithubAuth {
  constructor(
    file,
    config,
    {
      fetcher = globalThis.fetch,
      clock = () => Date.now(),
      report = (event) => console.warn("github upstream", JSON.stringify(event)),
      delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    } = {},
  ) {
    Object.assign(this, { file, config, fetcher, clock, report, delay });
    this.pending = new Map();
    this.attempts = new Map();
    this.cookieName = config.secure ? "__Host-workbench_github_flow" : "workbench_github_flow_dev";
  }
  async status() {
    try {
      if (!this.config.githubOwner?.id) throw Error("Owner not configured");
      validateGithubConfig(JSON.parse(await readFile(this.file, "utf8")));
      return { enabled: true, ready: true };
    } catch (e) {
      return { enabled: e.code !== "ENOENT", ready: false };
    }
  }
  async settings() {
    try {
      if (!this.config.githubOwner?.id) throw Error("Owner not configured");
      return validateGithubConfig(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      throw failure("not_configured", 503);
    }
  }
  cookie(value, age = 300) {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.config.secure ? "; Secure" : ""}`;
  }
  sweep() {
    const now = this.clock();
    for (const [k, v] of this.pending) if (v.expires <= now) this.pending.delete(k);
    for (const [k, v] of this.attempts) if (v.until <= now) this.attempts.delete(k);
  }
  async start(req, ip) {
    this.sweep();
    const settings = await this.settings();
    for (const key of ["ip:" + ip, "global"]) {
      const limit = key === "global" ? 100 : 10,
        a = this.attempts.get(key) || { count: 0, until: this.clock() + 300000 };
      if (a.count >= limit) throw failure("rate_limited", 429);
      a.count++;
      this.attempts.set(key, a);
    }
    if (this.pending.size >= 200 || this.attempts.size >= 1000) throw failure("rate_limited", 429);
    const previous = cookies(req)[this.cookieName];
    if (previous) this.pending.delete(previous);
    const state = randomBytes(32).toString("base64url"),
      binder = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    // PKCE binds this authorization to the initiating browser flow.
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = this.config.origin + callbackPath;
    this.pending.set(binder, {
      state,
      verifier,
      clientId: settings.clientId,
      redirectUri,
      expires: this.clock() + 300000,
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    for (const [k, v] of Object.entries({
      client_id: settings.clientId,
      redirect_uri: redirectUri,
      login: this.config.githubOwner.login,
      scope: "",
      state,
      allow_signup: "false",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }))
      url.searchParams.set(k, v);
    return { url: url.href, cookie: this.cookie(binder) };
  }
  async finish(req, url) {
    this.sweep();
    const binder = cookies(req)[this.cookieName],
      pending = this.pending.get(binder);
    if (
      !pending ||
      url.searchParams.getAll("state").length !== 1 ||
      !equal(pending.state, url.searchParams.get("state"))
    )
      throw failure("expired");
    this.pending.delete(binder); // one attempt, including cancellation or upstream errors
    if (url.searchParams.has("error")) throw failure("cancelled");
    const code = url.searchParams.get("code");
    if (url.searchParams.getAll("code").length !== 1 || !code || code.length > 512)
      throw failure("expired");
    const settings = await this.settings();
    if (
      settings.clientId !== pending.clientId ||
      this.config.origin + callbackPath !== pending.redirectUri
    )
      throw failure("expired");
    let user,
      stage = "exchange",
      started = this.clock(),
      httpStatus;
    try {
      const response = await this.fetcher("https://github.com/login/oauth/access_token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "codock",
        },
        body: new URLSearchParams({
          client_id: settings.clientId,
          client_secret: settings.clientSecret,
          code,
          redirect_uri: pending.redirectUri,
          code_verifier: pending.verifier,
        }),
      });
      httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw failure("upstream", 502);
      }
      const token = await response.json();
      if (
        token.error ||
        typeof token.access_token !== "string" ||
        !token.access_token ||
        String(token.token_type).toLowerCase() !== "bearer"
      )
        throw failure("exchange_failed");
      // Dedicated identity-only app: never accept accidentally broader repository scopes.
      if (typeof token.scope !== "string" || token.scope.trim())
        throw failure("unexpected_scope", 403);
      stage = "profile";
      started = this.clock();
      httpStatus = undefined;
      // Only this read-only GET is retried. Never replay a possibly consumed
      // authorization code; never persist tokens to make retries work.
      for (let attempt = 0; attempt < 2; attempt++) {
        httpStatus = undefined;
        try {
          const profile = await this.fetcher("https://api.github.com/user", {
            redirect: "error",
            signal: AbortSignal.timeout(8000),
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: "Bearer " + token.access_token,
              "User-Agent": "codock",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });
          httpStatus = profile.status;
          if (!profile.ok) {
            await profile.body?.cancel();
            throw failure("upstream", 502);
          }
          user = await profile.json();
          break;
        } catch (error) {
          if (attempt || (httpStatus && httpStatus < 500)) throw error;
          await this.delay(300);
        }
      }
      // OAuth token stays in this function only: not returned to the browser, logged or stored.
    } catch (error) {
      if (error.oauthCode && error.oauthCode !== "upstream") throw error;
      const known = [
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ];
      const reason = known.includes(error.cause?.code)
        ? error.cause.code
        : error.name === "TimeoutError"
          ? "timeout"
          : httpStatus
            ? "http_error"
            : "network_error";
      // Fixed, non-secret fields only. No URLs, code/state, cookies, token,
      // request/response bodies or arbitrary exception messages are logged.
      this.report({ stage, reason, status: httpStatus || null, elapsedMs: this.clock() - started });
      throw Object.assign(failure("upstream", 502), { oauthStage: stage });
    }
    if (user?.id !== this.config.githubOwner.id || user?.type !== "User")
      throw failure("wrong_account", 403);
    return { provider: "github", id: this.config.githubOwner.id };
  }
}
