import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAsrWorker } from "./local-asr-worker.mjs";
import { voiceVocabulary } from "./voice-vocabulary.mjs";

const fail = (message, status) => Object.assign(Error(message), { status });
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const formats = {
  "audio/webm": "webm",
  "audio/webm;codecs=opus": "webm",
  "audio/ogg": "ogg",
  "audio/ogg;codecs=opus": "ogg",
  "audio/mp4": "mp4",
  "audio/mp4;codecs=mp4a.40.2": "mp4",
  "audio/wav": "wav",
  "audio/wave": "wav",
};
function validAudio(bytes, format) {
  if (bytes.length < 32 || bytes.length > 1000000)
    throw fail("录音过大或为空，请录 25 秒以内的短语音", 413);
  const head = bytes.subarray(0, 16).toString("ascii");
  const valid = {
    webm: bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    ogg: head.startsWith("OggS"),
    mp4: head.slice(4, 8) === "ftyp",
    wav: head.startsWith("RIFF") && head.slice(8, 12) === "WAVE",
  };
  if (!valid[format]) throw fail("录音格式与内容不符，请换浏览器或使用键盘麦克风", 400);
}
export async function toWav(input, format) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-threads",
        "1",
        "-protocol_whitelist",
        "pipe",
        "-f",
        format,
        "-i",
        "pipe:0",
        "-t",
        "25",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks = [];
    let size = 0,
      done = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 900000) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", (error) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      const wav = Buffer.concat(chunks);
      if (code || wav.length < 64 || wav.length > 900000)
        reject(fail("录音转换失败，请缩短语音或使用键盘麦克风", 422));
      else resolve(wav);
    });
  });
}

export class VoiceAsr {
  constructor(
    runtime,
    {
      env = process.env,
      convert = toWav,
      recognize,
      available,
      qualityRecognize,
      qualityAvailable,
    } = {},
  ) {
    this.runtime = runtime;
    this.modelDir = env.DESK_ASR_MODEL_DIR || path.join(runtime, "models/sensevoice-small-int8");
    this.qualityModelDir = env.DESK_ASR_QUALITY_MODEL_DIR || path.join(runtime, "models/qwen3-asr");
    this.python = env.DESK_ASR_PYTHON || path.join(runtime, "asr-env/bin/python");
    this.available =
      available ||
      (() =>
        Promise.all(
          [
            this.python,
            path.join(this.modelDir, "model.int8.onnx"),
            path.join(this.modelDir, "tokens.txt"),
            path.join(root, "scripts/local-asr.py"),
          ].map((file) => access(file)),
        ));
    this.qualityAvailable =
      qualityAvailable ||
      (recognize
        ? async () => {
            throw Error("mock fast engine only");
          }
        : () =>
            Promise.all(
              [
                this.python,
                "conv_frontend.onnx",
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "tokenizer/vocab.json",
              ].map((file, index) => access(index ? path.join(this.qualityModelDir, file) : file)),
            ));
    this.worker = recognize
      ? null
      : new LocalAsrWorker({ runtime, python: this.python, modelDir: this.modelDir });
    this.qualityWorker = qualityRecognize
      ? null
      : new LocalAsrWorker({
          runtime,
          python: this.python,
          modelDir: this.qualityModelDir,
          kind: "qwen3",
          idleMs: 120000,
        });
    this.convert = convert;
    this.recognize = recognize || ((wav, language) => this.worker.recognize(wav, language));
    this.qualityRecognize =
      qualityRecognize ||
      ((wav, _language, options) =>
        this.qualityWorker.recognize(wav, "auto", { vocabulary: options.vocabulary }));
    this.ready = false;
    this.qualityReady = false;
    this.busy = false;
  }
  async init() {
    try {
      await this.available();
      this.ready = true;
    } catch {
      this.ready = false;
    }
    try {
      await this.qualityAvailable();
      this.qualityReady = true;
    } catch {
      this.qualityReady = false;
    }
  }
  enabled() {
    return this.ready;
  }
  status() {
    return { enabled: this.enabled(), quality: this.qualityReady, maxSeconds: 25 };
  }
  async prepare({ language } = {}) {
    if (!this.enabled()) throw fail("本地语音识别暂时不可用", 503);
    if (!["auto", "zh-CN", "en-US"].includes(language)) throw fail("听写语言无效", 400);
    if (!this.busy && this.worker)
      await this.worker.warm(language === "auto" ? "auto" : language === "en-US" ? "en" : "zh");
    if (!this.busy && this.qualityReady && this.qualityWorker)
      void this.qualityWorker.warm("auto").catch(() => {});
    return { ready: true };
  }
  close() {
    this.worker?.stop();
    this.qualityWorker?.stop();
  }
  async transcribe(input) {
    if (!this.enabled()) throw fail("本地语音识别暂时不可用，请用手机键盘上的麦克风", 503);
    if (this.busy) throw fail("已有一段语音正在识别，请稍后再试", 429);
    const format = formats[input?.mime],
      lang = input?.language,
      mode = input?.mode || "fast";
    if (
      !format ||
      !["auto", "zh-CN", "en-US"].includes(lang) ||
      !["fast", "accurate"].includes(mode) ||
      typeof input.data !== "string" ||
      input.data.length > 1400000 ||
      !/^([A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)
    )
      throw fail("录音参数无效", 400);
    const bytes = Buffer.from(input.data, "base64");
    validAudio(bytes, format);
    const vocabulary = voiceVocabulary(input.vocabulary);
    this.busy = true;
    try {
      const wav = await this.convert(bytes, format);
      if (!Buffer.isBuffer(wav) || wav.length < 64 || wav.length > 900000)
        throw fail("录音长度无效", 422);
      let text,
        engine = "fast";
      if (mode === "accurate" && this.qualityReady) {
        try {
          text = await this.qualityRecognize(wav, "auto", {
            runtime: this.runtime,
            python: this.python,
            modelDir: this.qualityModelDir,
            vocabulary,
          });
          engine = "qwen3";
        } catch {
          /* Optional quality engine failure leaves the local fast engine available. */
        }
      }
      if (text === undefined)
        text = await this.recognize(
          wav,
          lang === "auto" ? "auto" : lang === "en-US" ? "en" : "zh",
          { runtime: this.runtime, python: this.python, modelDir: this.modelDir },
        );
      if (typeof text !== "string" || text.length > 4000) throw fail("本地识别返回异常", 503);
      return mode === "accurate" ? { text: text.trim(), engine } : { text: text.trim() };
    } finally {
      this.busy = false;
    }
  }
}
