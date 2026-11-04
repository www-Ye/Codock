import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isolatedEnvironment } from "../lib/account-pool.mjs";
const { home, thread, settings } = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!home?.startsWith("/") || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(thread || ""))
  throw Error("Invalid account session");
const toml = (v) =>
  Array.isArray(v)
    ? "[" + v.map(toml).join(",") + "]"
    : v && typeof v === "object"
      ? "{" +
        Object.entries(v)
          .map(([k, v]) => JSON.stringify(k) + "=" + toml(v))
          .join(",") +
        "}"
      : JSON.stringify(v);
const overrides = Object.entries(settings).flatMap(([key, value]) => [
  "-c",
  JSON.stringify(key) + "=" + toml(value),
]);
const child = spawn("codex", ["resume", thread, ...overrides], {
  env: isolatedEnvironment(home),
  stdio: "inherit",
});
child.on("error", () => {
  console.error("Codex 启动失败；请返回原窗口。");
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
