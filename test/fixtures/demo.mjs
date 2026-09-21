import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDesk } from "../../server.mjs";

// Synthetic content only. Never reads an existing socket, config, history or credential.
export async function createDemo() {
  const directory = await mkdtemp(process.env.TMPDIR + "/demo-");
  let footer = "› ";
  const binding = "123:456:11111111-1111-1111-1111-111111111111";
  const text = [
    {
      role: "user",
      text: "把这个项目的进展整理成一个手机也能看的页面。保留关键结果，细节可以展开。",
    },
    {
      role: "assistant",
      phase: "commentary",
      text: "我会先梳理结果，再把对比图和使用说明放进同一页。",
    },
    {
      role: "activity",
      title: "查看项目结构",
      status: "completed",
      details: [
        { label: "命令", text: "rg --files src docs" },
        { label: "输出", text: "src/app.js\ndocs/notes.md\ndocs/site/index.html" },
      ],
    },
    {
      role: "activity",
      title: "更新展示页面",
      status: "completed",
      details: [{ label: "变更", text: "新增响应式布局、结果对比和可展开的实现说明。" }],
    },
    {
      role: "assistant",
      phase: "final_answer",
      text: "页面整理好了。手机看结论，电脑看全景。\n\n### 这次完成了什么\n\n- **一眼看懂**：结论和关键结果放在最前面。\n- **随时继续**：原来的上下文和执行记录都保留。\n- **按需展开**：长代码和细节不挤占阅读空间。\n\n| 视图 | 展示内容 |\n| --- | --- |\n| 手机 | 结论、关键图、下一步 |\n| 电脑 | 完整对比和实现细节 |\n\n打开上方「预览」即可查看，也可以继续告诉我想调整哪里。",
    },
  ];
  const messages = text.map((m, i) => ({
    ...m,
    id: String(i + 1),
    time: 1789900000000 + i * 60000,
  }));
  const desk = await createDesk({
    runtime: directory + "/runtime",
    socket: directory + "/absent.sock",
    allowed: ["demo", "design", "research"],
    secure: false,
    projectRoot: fileURLToPath(new URL("../../examples", import.meta.url)),
    previewSuffix: "preview.terminal.localhost",
    chatDependencies: {
      read: async () => ({ available: true, binding, revision: "5", messages, before: null }),
    },
    chatSendDependencies: { deliver: async () => ({ state: "submitted" }) },
  });
  const labels = ["项目概览", "界面设计", "研究笔记"];
  desk.registry.allowed.forEach((name, i) => {
    desk.registry.items[name] = {
      name,
      label: labels[i],
      identity: name + "-fixture",
      preview:
        name === "demo"
          ? { type: "static", directory: "workbench-page", entry: "index.html" }
          : null,
      revision: 1,
    };
  });
  desk.registry.live = async () =>
    desk.registry.allowed.map((name, i) => ({
      name,
      identity: name + "-fixture",
      id: "$" + i,
      windows: 1,
      attached: 1,
    }));
  desk.registry.command = async (args) => (args[0] === "capture-pane" ? footer : "%1\t123\t30\t0");
  await new Promise((r) => desk.server.listen(0, "127.0.0.1", r));
  const origin = "http://terminal.localhost:" + desk.server.address().port;
  desk.config.origin = origin;
  desk.config.previewPort = String(desk.server.address().port);
  return {
    desk,
    directory,
    origin,
    setStatus(state) {
      footer = {
        running: "• Working (5s • esc to interrupt)\n› ",
        waiting: "› 1. Yes, proceed (y)\nPress enter to confirm or esc to cancel",
        ready: "› ",
        unknown: "SHELL_OUTPUT",
      }[state];
    },
  };
}
