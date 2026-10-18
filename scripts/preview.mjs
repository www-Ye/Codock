import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
      !["--session", "--directory", "--port", "--entry", "--replace-existing"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw Error(
        "用法：preview --session 会话名 (--directory 网页目录 [--entry index.html] | --port 本地端口) [--replace-existing yes]",
      );
    if (opts[args[i]]) throw Error("参数重复");
    opts[args[i]] = args[i + 1];
  }
  if (!opts["--session"])
    throw Error("必须明确指定 --session；不能从代理进程的 TMUX/TMUX_PANE 猜测网页会话");
  if (Boolean(opts["--directory"]) === Boolean(opts["--port"]))
    throw Error("必须且只能提供 --directory 或 --port");
  if (opts["--port"] && (opts["--entry"] || !/^\d+$/.test(opts["--port"])))
    throw Error("端口必须为整数，且不能同时指定 --entry");
  if (opts["--replace-existing"] && opts["--replace-existing"] !== "yes")
    throw Error("更换现有绑定须明确填写 --replace-existing yes");
  const target = opts["--port"]
    ? { port: Number(opts["--port"]) }
    : { directory: opts["--directory"], entry: opts["--entry"] || "index.html" };
  return requestBinding(socketPath, {
    session: opts["--session"],
    ...target,
    replaceExisting: opts["--replace-existing"] === "yes",
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
