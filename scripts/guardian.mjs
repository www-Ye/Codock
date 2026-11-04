import { loadConfig } from "../lib/config.mjs";
import http from "node:http";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2),
  fields = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--session", "--title", "--progress", "--pid"].includes(args[i]) || !args[i + 1])
    throw Error(
      "用法：node scripts/guardian.mjs --session dev --title 任务名称 --progress /完整路径/progress.json [--pid 进程号]",
    );
  fields[args[i].slice(2)] = args[i + 1];
}
const body = JSON.stringify({
  action: "register",
  session: fields.session,
  title: fields.title,
  source: fields.progress,
  ...(fields.pid ? { pid: Number(fields.pid) } : {}),
});
const result = await new Promise((resolve, reject) => {
  const req = http.request(
    {
      socketPath: fileURLToPath(new URL("../runtime/control.sock", import.meta.url)),
      path: "/guardian",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    (res) => {
      let text = "";
      res.on("data", (b) => (text += b));
      res.on("end", () =>
        res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(Error(JSON.parse(text).error)),
      );
    },
  );
  req.on("error", reject);
  req.end(body);
});
console.log(
  JSON.stringify({ registered: result.id, url: (await loadConfig()).origin + "/#guardian" }),
);
