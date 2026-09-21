import { loadConfig } from "../lib/config.mjs";
const settings = await loadConfig();
if (settings.authMode !== "local") throw Error("Set authMode to local before password setup");
import { stdin, stdout } from "node:process";
import { hidden } from "./prompts.mjs";
import readline from "node:readline/promises";
import { writeFile, access } from "node:fs/promises";
import { credentials, totp } from "../lib/auth.mjs";
const target = new URL("../runtime/auth.json", import.meta.url);
try {
  await access(target);
  throw Error("登录凭据已经存在。本命令不会覆盖；重设需管理员确认。");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
if (!stdin.isTTY) throw Error("请在自己的交互式终端运行 npm run setup");

const password = await hidden("终端台独立密码（至少 16 个字符，输入不回显）：");
if (password !== (await hidden("再输入一次："))) throw Error("两次密码不同");
const record = await credentials(password);
console.log("\n不用扫码：在手机验证器中选择「添加账号 → 手动输入密钥」。");
console.log("账号名称：Codock");
console.log("类型：基于时间（TOTP），6 位数字，30 秒，SHA1（通常保持默认即可）。");
console.log("设置密钥：" + record.totp);
console.log("请将密钥保存在密码管理器中，不要截图分享或放入公开记录。");
const rl = readline.createInterface({ input: stdin, output: stdout });
const code = (await rl.question("输入验证器的 6 位动态码：")).trim();
rl.close();
if (![-1, 0, 1].some((n) => totp(record.totp, Date.now() + n * 30000) === code))
  throw Error("验证码不匹配，未保存，请重新设置");
await writeFile(target, JSON.stringify(record), { flag: "wx", mode: 0o600 });
console.log("设置完成。请使用下一组动态验证码登录。");
