import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
const scrypt = promisify(scryptCb),
  alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes) {
  let bits = 0,
    v = 0,
    out = "";
  for (const n of bytes) {
    v = (v << 8) | n;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(v << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0,
    v = 0,
    out = [];
  for (const c of s) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw Error("Invalid authenticator secret");
    v = (v << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totp(secret, time = Date.now()) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const h = createHmac("sha1", unbase32(secret)).update(c).digest(),
    i = h[19] & 15;
  return String((h.readUInt32BE(i) & 0x7fffffff) % 1000000).padStart(6, "0");
}
export function equal(a, b) {
  const x = Buffer.from(String(a || "")),
    y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function credentials(password, secret = base32(randomBytes(20))) {
  if (password.length < 16 || password.length > 256) throw Error("密码请使用 16–256 个字符");
  const salt = randomBytes(16);
  return {
    salt: salt.toString("base64url"),
    password: (await scrypt(password, salt, 32)).toString("base64url"),
    totp: secret,
  };
}
export function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim().split(/=(.*)/s).slice(0, 2))
      .filter((p) => p.length === 2),
  );
}
export function validateCredentials(c) {
  const encoded = (v, size) =>
    typeof v === "string" &&
    /^[A-Za-z0-9_-]+$/.test(v) &&
    Buffer.from(v, "base64url").length === size &&
    Buffer.from(v, "base64url").toString("base64url") === v;
  if (
    !c ||
    !encoded(c.salt, 16) ||
    !encoded(c.password, 32) ||
    typeof c.totp !== "string" ||
    !/^[A-Z2-7]{32}$/.test(c.totp)
  )
    throw Error("Invalid local credentials; run the authentication setup");
  return c;
}
export class Auth {
  constructor(file, { secure = true, clock = () => Date.now() } = {}) {
    this.file = file;
    this.secure = secure;
    this.clock = clock;
    this.sessions = new Map();
    this.attempts = new Map();
    this.lastOtp = -1;
    this.name = secure ? "__Host-workbench_terminal" : "workbench_terminal_dev";
  }
  async ready() {
    try {
      validateCredentials(JSON.parse(await readFile(this.file, "utf8")));
      return true;
    } catch {
      return false;
    }
  }
  async login(password, code, ip) {
    const now = this.clock();
    for (const [key, a] of this.attempts) if (a.until <= now) this.attempts.delete(key);
    for (const key of [ip, "*"]) {
      const a = this.attempts.get(key) || { count: 0, until: now + 900000 };
      if (a.count >= (key === "*" ? 30 : 5))
        throw Object.assign(Error("尝试次数过多，请 15 分钟后再试"), { status: 429 });
      a.count++;
      this.attempts.set(key, a);
    }
    if (this.attempts.size > 1000) throw Object.assign(Error("请稍后重试"), { status: 429 });
    let c;
    try {
      c = validateCredentials(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      throw Object.assign(Error("管理员尚未设置登录凭据"), { status: 503 });
    }
    const hash = await scrypt(
      String(password || "").slice(0, 257),
      Buffer.from(c.salt, "base64url"),
      32,
    );
    const step = Math.floor(now / 30000),
      valid = [step - 1, step, step + 1].find((n) => equal(totp(c.totp, n * 30000), code));
    if (
      !equal(hash.toString("base64url"), c.password) ||
      valid === undefined ||
      valid <= this.lastOtp
    )
      throw Object.assign(Error("密码或动态验证码不正确；验证码不可重复使用"), { status: 401 });
    this.lastOtp = valid;
    this.attempts.delete(ip);
    return this.issue({ provider: "local" });
  }
  issue(identity) {
    const now = this.clock();
    for (const [k, v] of this.sessions)
      if (v.expires <= now || v.idle <= now) this.sessions.delete(k);
    if (this.sessions.size >= 20)
      throw Object.assign(Error("登录设备过多，请稍后再试"), { status: 429 });
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { expires: now + 8 * 3600000, idle: now + 30 * 60000, identity });
    return token;
  }
  get(req) {
    const token = cookies(req)[this.name];
    return this.valid(token) ? token : null;
  }
  valid(token, touch = false) {
    const s = this.sessions.get(token),
      now = this.clock();
    if (!s || s.expires <= now || s.idle <= now) {
      this.sessions.delete(token);
      return false;
    }
    if (touch) s.idle = Math.min(s.expires, now + 30 * 60000);
    return true;
  }
  cookie(token, age = 28800) {
    return `${this.name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.secure ? "; Secure" : ""}`;
  }
}
