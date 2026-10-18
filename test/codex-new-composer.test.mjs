import { test } from "node:test";
import assert from "node:assert/strict";
import { focusedThread } from "../lib/codex-status.mjs";
import { terminalStatus } from "../lib/terminal-status.mjs";
import { ChatInput } from "../lib/chat-input.mjs";
import { parseQuestion } from "../lib/chat-interaction.mjs";

const thread = "11111111-1111-1111-1111-111111111111";
const binding = `123:456:${thread}`;
const metadata = {
  id: thread,
  name: "sim1",
  cwd: "/workspace",
  source: "cli",
  parentThreadId: null,
};
const footer = (draft = "Ask Codex to do anything") =>
  `» ${draft}\n\n  GPT-6-Astra ultra · /workspace · sim1 · Main [default]       Goal hit usage limits (/goal resume)\n  ← for agents · ? for shortcuts`;

test("new composer and ultra effort retain exact identity and ready state", () => {
  assert.equal(focusedThread(footer(), [metadata]), thread);
  assert.equal(terminalStatus(footer()).state, "ready");
  assert.equal(focusedThread(footer().replace("ultra", "max"), [metadata]), thread);
  assert.equal(
    focusedThread(footer(), [
      metadata,
      { ...metadata, id: "22222222-2222-2222-2222-222222222222" },
    ]),
    null,
  );
  assert.equal(focusedThread(footer().replace("/workspace", "/elsewhere"), [metadata]), null);
  assert.equal(
    focusedThread("  GPT-6-Astra ultra · /workspace · sim1\n» Ask Codex to do anything", [
      metadata,
    ]),
    null,
  );
  const question = "Question 1/1\nWhich version?\n» 1. A\n  2. B\nEnter to confirm";
  assert.equal(terminalStatus(question).state, "waiting");
  assert.equal(parseQuestion(question, "%1").choices[0].selected, true);
});

test("new composer sends once but never overwrites drafts or confirms approvals", async () => {
  let screen = footer(),
    writes = 0;
  const keys = [];
  const registry = {
    target: async () => ({ id: "$1" }),
    command: async (args) => {
      if (args[0] === "display-message") return "%1\t123\t32\t0";
      if (args[0] === "capture-pane") return screen;
      if (args[0] === "paste-buffer") screen = footer("继续");
      if (args[0] === "send-keys") keys.push(args[3]);
      return "";
    },
  };
  const input = new ChatInput(
    { registry, read: async () => ({ available: true, binding }) },
    { writers: new Map() },
  );
  input.buffer = async () => {
    writes++;
  };
  const entry = { identity: "test", binding, text: "继续" };
  for (const blocked of [footer("不要覆盖的草稿"), "» 1. Yes\n  2. No\nEnter to confirm"]) {
    screen = blocked;
    assert.equal((await input.send("sim1", entry)).state, "failed");
  }
  assert.equal(writes, 0);
  assert.deepEqual(keys, []);
  screen = footer();
  assert.equal((await input.send("sim1", entry)).state, "submitted");
  assert.equal(writes, 1);
  assert.deepEqual(keys, ["Enter"]);
});
