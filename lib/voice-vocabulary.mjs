// Recognition hints, not replacements: never rewrite a decoded Chinese word
// into a guessed English term. Each utterance gets its own bounded hints.
const common = [
  "Codex",
  "Claude",
  "tmux",
  "GPT",
  "API",
  "GPU",
  "Python",
  "checkpoint",
  "sim2real",
  "PyTorch",
  "CUDA",
  "vLLM",
];
export function voiceVocabulary(extra = []) {
  if (!Array.isArray(extra) || extra.length > 24)
    throw Object.assign(Error("语音术语参数无效"), { status: 400 });
  const terms = [],
    seen = new Set();
  let size = 0;
  for (const word of [...extra.slice(0, 8), ...common]) {
    if (
      typeof word !== "string" ||
      word.length > 40 ||
      !/^[A-Za-z][A-Za-z0-9_+.#-]*(?: [A-Za-z0-9_+.#-]+){0,2}$/.test(word)
    )
      continue;
    if (seen.has(word.toLowerCase()) || size + word.length > 200 || terms.length >= 16) continue;
    seen.add(word.toLowerCase());
    size += word.length;
    terms.push(word);
  }
  return terms;
}
