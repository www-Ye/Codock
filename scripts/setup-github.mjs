import { access, writeFile } from "node:fs/promises";
import { validateGithubConfig } from "../lib/github-auth.mjs";
import { loadConfig } from "../lib/config.mjs";
import { hidden } from "./prompts.mjs";

try {
  const desk = await loadConfig();
  if (desk.authMode !== "github") throw Error("Set authMode to github first");
  const target = new URL("../runtime/github.json", import.meta.url);
  try {
    await access(target);
    throw Error("GitHub 登录配置已存在。本命令不会覆盖；更新应用密钥需管理员明确操作。");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  console.log("配置 GitHub 登录，仅允许 " + desk.githubOwner.login + "。这不是你的 GitHub 密码。");
  console.log("从你创建的 OAuth App 页面复制 Client ID，再点 Generate a new client secret。");
  console.log("下面两项输入均不回显。不要将 Client secret 发到聊天或写入命令参数。");
  const config = validateGithubConfig({
    clientId: (await hidden("粘贴 Client ID，按回车：")).trim(),
    clientSecret: (await hidden("粘贴 Client secret，按回车：")).trim(),
  });
  await writeFile(target, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  console.log("配置已保存。现在打开 " + desk.origin + "，点击「使用 GitHub 登录」。");
  console.log("是否授权成功以浏览器登录结果为准；原密码配置未修改。");
} catch (e) {
  console.error(e.code === "EEXIST" ? "配置已存在，未覆盖。" : e.message);
  process.exitCode = 1;
}
