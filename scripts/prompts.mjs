import { stdin, stdout } from "node:process";

// Interactive input only; no values in argv, environment variables, logs or shell history.
export async function hidden(prompt) {
  if (!stdin.isTTY) throw Error("请在自己的交互式终端运行设置命令");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (buf) => {
      for (const ch of buf.toString()) {
        if (ch === "\u0003") {
          cleanup();
          reject(Error("已取消，未保存"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
