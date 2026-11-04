// A conservative observation of the *current* Codex TUI, not an app-server
// lifecycle subscription. Never return, persist or log the captured footer.
export async function captureTerminalFooter(registry, pane, rows, count = 16) {
  // After a resize, Codex may leave blank rows below its actual footer. Read
  // only the visible screen, discard trailing padding, then bound the tail.
  const screen = await registry.command(
    ["capture-pane", "-p", "-t", pane, "-S", "0", "-E", String(rows - 1)],
    1024 * 1024,
  );
  return screen.trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

export function terminalStatus(footer, { inMode = false, checkedAt = Date.now(), provider } = {}) {
  const result = (state) => ({ state, source: "terminal-hint", checkedAt });
  if (inMode || typeof footer !== "string" || footer.length > 32000) return result("unknown");
  // Codex's animated composer can paint Braille particles immediately beside
  // the input chevron. Normalize display decoration, never the submitted text.
  const text = footer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u2800-\u28ff]/g, " ");
  const compact = text.replace(/\s+/g, " ");
  const lines = text.split(/\r?\n/);
  if (
    provider === "claude" ||
    (/^\s*❯/m.test(text) && /shift\+tab to cycle|bypass permissions|auto mode on/i.test(text))
  ) {
    if (
      /^\s*❯\s*\d+[.)]\s+\S/m.test(text) ||
      /enter to (?:confirm|submit|select)|space to (?:select|toggle)/i.test(text)
    )
      return { ...result("waiting"), attention: { kind: "question", summary: null } };
    if (/esc to interrupt/i.test(text)) return result("running");
    if (/^\s*❯(?:\s|$)/m.test(text)) return result("ready");
    return result("unknown");
  }
  const questionAt = lines.findIndex((line) =>
    /^\s*Question\s+[1-9]\d*\/[1-9]\d*(?:\s*\(\d+\s+unanswered\))?(?:\s*[·•]\s*auto-resolves\s+in\s+\S+)?\s*$/i.test(
      line,
    ),
  );
  if (questionAt !== -1) {
    const summary = lines
      .slice(questionAt + 1, questionAt + 5)
      .map((line) => line.trim())
      .find((line) => line && !/^[›❯»]\s*\d+[.)]/.test(line));
    return {
      ...result("waiting"),
      attention: { kind: "question", summary: summary?.slice(0, 180) || null },
    };
  }
  // Follow-up inputs are user messages queued for Codex, not proof that Codex
  // is asking the user a question. Never present them as an approval prompt.
  if (/^\s*[•●◦]?\s*Queued follow-up inputs\s*$/im.test(text)) return result("running");
  if (/(?:^|\n)\s*Shift\s*\+\s*(?:←|Left)\s+to\s+answer\s+questions?\b/i.test(text))
    return { ...result("waiting"), attention: { kind: "question", summary: null } };
  // Match the Codex execution row, including a duration and interrupt hint.
  if (
    /(?:^|\n)\s*[•●◦][^\n]{0,240}\(\s*\d+\s*[smhd][^\n]{0,100}(?:\n[^\n]{0,100})?esc to interrupt/i.test(
      text,
    )
  )
    return result("running");
  if (/enter to (?:confirm|submit|select)/i.test(compact) && /^\s*[›❯»]\s*\d+[.)]\s+\S/m.test(text))
    return result("waiting");
  // Don't turn a partially rendered/unknown busy row into "ready".
  if (
    /esc to interrupt|enter to (?:confirm|submit|select)/i.test(compact) ||
    /^\s*[•●◦]\s*(?:Working|Thinking)\s*\(/im.test(text)
  )
    return result("unknown");
  if (/^\s*[›»](?!\s*\d+[.)])(?:\s|$)/m.test(text)) return result("ready");
  return result("unknown");
}

export async function observeTerminal(registry, meta, options = {}) {
  const [pane, , height, mode] = meta.split("\t");
  const rows = Number(height);
  if (!/^%\d+$/.test(pane) || !Number.isInteger(rows) || rows < 1 || rows > 1000 || mode !== "0")
    return terminalStatus(null);
  try {
    const footer = await captureTerminalFooter(registry, pane, rows);
    return terminalStatus(footer, options);
  } catch {
    return terminalStatus(null);
  }
}
