import { loadConfig } from "../lib/config.mjs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function requestBinding(socketPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: "/preview",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      },
      (res) => {
        let text = "";
        res.on("data", (b) => (text += b));
        res.on("end", () => {
          try {
            const data = JSON.parse(text);
            if (res.statusCode !== 200) throw Error(data.error || "绑定失败");
            resolve(data);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(Error("绑定超时，请核实后重试")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
export async function main(args, { socketPath = path.join(root, "runtime/control.sock") } = {}) {
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--session", "--directory", "--entry"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw Error("用法：preview --session 会话名 --directory 网页目录 [--entry index.html]");
    if (opts[args[i]]) throw Error("参数重复");
    opts[args[i]] = args[i + 1];
  }
  if (!opts["--directory"]) throw Error("需要 --directory 网页目录");
  let session = opts["--session"];
  if (!session && /^%\d+$/.test(process.env.TMUX_PANE || "")) {
    const config = await loadConfig();
    if (process.env.TMUX?.startsWith(config.socket + ","))
      session = (
        await promisify(execFile)(
          "tmux",
          [
            "-S",
            config.socket,
            "display-message",
            "-p",
            "-t",
            process.env.TMUX_PANE,
            "#{session_name}",
          ],
          { timeout: 3000 },
        )
      ).stdout.trim();
  }
  if (!session) throw Error("无法确定当前 tmux，请由代理确认会话名并传入 --session，不要猜测");
  return requestBinding(socketPath, {
    session,
    directory: opts["--directory"],
    entry: opts["--entry"] || "index.html",
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
  } catch (e) {
    console.error(
      ["ENOENT", "ECONNREFUSED"].includes(e.code)
        ? "本地绑定服务未就绪。请检查终端台后台；不要直接修改 sessions.json，也无需用户填写路径。"
        : e.message,
    );
    process.exitCode = 1;
  }
}
