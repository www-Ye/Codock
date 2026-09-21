// A conservative observation of the *current* Codex TUI, not an app-server
// lifecycle subscription. Never return, persist or log the captured footer.
export function terminalStatus(footer, { inMode = false, checkedAt = Date.now() } = {}) {
  const result = (state) => ({ state, source: "terminal-hint", checkedAt });
  if (inMode || typeof footer !== "string" || footer.length > 32000) return result("unknown");
  // Codex's animated composer can paint Braille particles immediately beside
  // the input chevron. Normalize display decoration, never the submitted text.
  const text = footer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u2800-\u28ff]/g, " ");
  const compact = text.replace(/\s+/g, " ");
  // Match the Codex execution row, including a duration and interrupt hint.
  if (
    /(?:^|\n)\s*[•●◦][^\n]{0,240}\(\s*\d+\s*[smhd][^\n]{0,100}(?:\n[^\n]{0,100})?esc to interrupt/i.test(
      text,
    )
  )
    return result("running");
  if (/enter to (?:confirm|submit|select)/i.test(compact) && /^\s*[›❯]\s*\d+[.)]\s+\S/m.test(text))
    return result("waiting");
  // Don't turn a partially rendered/unknown busy row into "ready".
  if (
    /esc to interrupt|enter to (?:confirm|submit|select)/i.test(compact) ||
    /^\s*[•●◦]\s*(?:Working|Thinking)\s*\(/im.test(text)
  )
    return result("unknown");
  if (/^\s*›(?!\s*\d+[.)])(?:\s|$)/m.test(text)) return result("ready");
  return result("unknown");
}

export async function observeTerminal(registry, meta) {
  const [pane, , height, mode] = meta.split("\t");
  const rows = Number(height);
  if (!/^%\d+$/.test(pane) || !Number.isInteger(rows) || rows < 1 || rows > 1000 || mode !== "0")
    return terminalStatus(null);
  try {
    const footer = await registry.command(
      [
        "capture-pane",
        "-p",
        "-t",
        pane,
        "-S",
        String(Math.max(0, rows - 16)),
        "-E",
        String(rows - 1),
      ],
      32768,
    );
    return terminalStatus(footer);
  } catch {
    return terminalStatus(null);
  }
}
