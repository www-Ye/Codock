import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { createDesk } from "../server.mjs";
import { toWav, VoiceAsr } from "../lib/voice-asr.mjs";
import { LocalAsrWorker } from "../lib/local-asr-worker.mjs";
import { voiceVocabulary } from "../lib/voice-vocabulary.mjs";

const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
const wav = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(600),
]);
const input = { mime: "audio/webm;codecs=opus", language: "zh-CN", data: webm.toString("base64") };

test("mixed speech keeps automatic language and isolated bounded terminology hints", async () => {
  const hints = voiceVocabulary([
    "ExampleProject",
    "LoRA",
    "Codex",
    "codex",
    "<ignore>",
    "API,extra",
  ]);
  assert(hints.includes("ExampleProject") && hints.includes("LoRA"));
  assert.equal(hints.filter((x) => x.toLowerCase() === "codex").length, 1);
  assert(!hints.includes("<ignore>") && !hints.includes("API,extra"));
  assert(hints.length <= 16 && hints.join("").length <= 200);
  assert.throws(() => voiceVocabulary("invalid"), { status: 400 });
  const received = [];
  const asr = new VoiceAsr("/unused", {
    available: async () => {},
    qualityAvailable: async () => {},
    convert: async () => wav,
    recognize: async () => "",
    qualityRecognize: async (_wav, lang, options) => {
      assert.equal(lang, "auto");
      received.push(options.vocabulary);
      return "把 checkpoint 放进 data1，保留 sim2real 配置。";
    },
  });
  await asr.init();
  const r = await asr.transcribe({
    ...input,
    language: "auto",
    mode: "accurate",
    vocabulary: ["ExampleProject", "LoRA"],
  });
  assert.equal(r.text, "把 checkpoint 放进 data1，保留 sim2real 配置。");
  assert.equal(r.engine, "qwen3");
  await asr.transcribe({ ...input, mode: "accurate" });
  assert(received[0].includes("ExampleProject"));
  assert(!received[1].includes("ExampleProject"), "terms do not leak to another utterance");
  asr.close();
});

test("HTTPS gateway limits larger bodies to the exact voice upload route", async () => {
  const gateway = await readFile(new URL("../deploy/nginx.conf.example", import.meta.url), "utf8");
  assert.match(gateway, /client_max_body_size 24k;/);
  assert.match(
    gateway,
    /location = \/api\/voice\/transcribe \{\s*client_max_body_size 1400k;\s*proxy_pass http:\/\/workbench_backend;/,
  );
  assert.equal((gateway.match(/client_max_body_size 1400k;/g) || []).length, 1);
});

test(
  "voice API requires login and same origin, validates audio and inserts no files",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/voice-");
    let calls = 0;
    const desk = await createDesk({
      runtime: dir + "/runtime",
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
      socket: dir + "/absent.sock",
      allowed: [],
      secure: false,
      voiceDependencies: {
        available: async () => true,
        convert: async (bytes, format) => {
          assert.equal(format, "webm");
          assert(bytes.equals(webm));
          return wav;
        },
        recognize: async (bytes, language) => {
          calls++;
          assert(bytes.equals(wav));
          assert.equal(language, "auto");
          return "小鸭你好。";
        },
      },
    });
    await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const cookie = desk.auth.cookie(desk.auth.issue({ login: "fixture" })).split(";")[0];
    const post = (body, headers = {}) =>
      fetch(origin + "/api/voice/transcribe", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const prepare = (body, headers = {}) =>
      fetch(origin + "/api/voice/prepare", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await fetch(origin + "/api/voice/status")).status, 401);
    assert.equal(
      (
        await fetch(origin + "/api/voice/prepare", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ language: "zh-CN" }),
        })
      ).status,
      401,
    );
    assert.equal(
      (await prepare({ language: "zh-CN" }, { Origin: "https://evil.example" })).status,
      403,
    );
    assert.equal((await prepare({ language: "other" })).status, 400);
    assert.deepEqual(await (await prepare({ language: "auto" })).json(), { ready: true });
    assert.equal(
      (
        await fetch(origin + "/api/voice/transcribe", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
      401,
    );
    assert.equal((await post(input, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ ...input, mime: "audio/mp3" })).status, 400);
    assert.equal((await post({ ...input, data: Buffer.alloc(68).toString("base64") })).status, 400);
    assert.equal((await post({ ...input, data: "A".repeat(1400004) })).status, 413);
    assert.equal(calls, 0);
    assert.deepEqual(await (await post({ ...input, language: "auto" })).json(), {
      text: "小鸭你好。",
    });
    assert.equal(calls, 1);
    assert.equal(
      (await fetch(origin + "/api/voice/status", { headers: { Cookie: cookie } })).status,
      200,
    );
  },
);

test("missing local model is gated and recognition admits one CPU job at a time", async () => {
  const dir = await mkdtemp(process.env.TMPDIR + "/voice-busy-");
  const disabled = new VoiceAsr(dir, {
    available: async () => {
      throw Error("model absent");
    },
  });
  await disabled.init();
  assert.equal(disabled.status().enabled, false);
  await assert.rejects(() => disabled.transcribe(input), { status: 503 });
  let finish;
  const asr = new VoiceAsr(dir, {
    available: async () => true,
    convert: async () => wav,
    recognize: () => new Promise((resolve) => (finish = resolve)),
  });
  await asr.init();
  const first = asr.transcribe(input);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => asr.transcribe(input), { status: 429 });
  finish("完成");
  assert.deepEqual(await first, { text: "完成" });
});

test("final transcript selects optional quality CPU engine; preview and failures stay local", async () => {
  const dir = await mkdtemp(process.env.TMPDIR + "/voice-quality-");
  let fast = 0,
    quality = 0,
    failQuality = false;
  const asr = new VoiceAsr(dir, {
    available: async () => {},
    qualityAvailable: async () => {},
    convert: async () => wav,
    recognize: async () => {
      fast++;
      return "快速识别";
    },
    qualityRecognize: async () => {
      quality++;
      if (failQuality) throw Error("engine failed");
      return "高精度识别";
    },
  });
  await asr.init();
  assert.equal(asr.status().quality, true);
  assert.deepEqual(await asr.transcribe({ ...input, language: "auto", mode: "fast" }), {
    text: "快速识别",
  });
  assert.deepEqual(await asr.transcribe({ ...input, language: "auto", mode: "accurate" }), {
    text: "高精度识别",
    engine: "qwen3",
  });
  failQuality = true;
  assert.deepEqual(await asr.transcribe({ ...input, language: "auto", mode: "accurate" }), {
    text: "快速识别",
    engine: "fast",
  });
  assert.equal(fast, 2);
  assert.equal(quality, 2);
  await assert.rejects(() => asr.transcribe({ ...input, mode: "other" }), { status: 400 });
  asr.close();
  const fallback = new VoiceAsr(dir, {
    available: async () => {},
    qualityAvailable: async () => {
      throw Error("no optional weights");
    },
    convert: async () => wav,
    recognize: async () => "快速识别",
  });
  await fallback.init();
  assert.equal(fallback.status().quality, false);
  assert.deepEqual(await fallback.transcribe({ ...input, language: "auto", mode: "accurate" }), {
    text: "快速识别",
    engine: "fast",
  });
  fallback.close();
});

test("ffmpeg converts only local WAV audio through pipes without a task file", async () => {
  const pcm = Buffer.alloc(16000),
    header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  const result = await toWav(Buffer.concat([header, pcm]), "wav");
  assert.equal(result.toString("ascii", 0, 4), "RIFF");
  assert(result.length > 10000);
});

test("browser-style WebM/Opus also converts to bounded WAV without disk", async () => {
  const child = spawn(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.2",
      "-c:a",
      "libopus",
      "-f",
      "webm",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const parts = [];
  for await (const chunk of child.stdout) parts.push(chunk);
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  const source = Buffer.concat(parts);
  assert(source.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  const result = await toWav(source, "webm");
  assert.equal(result.toString("ascii", 0, 4), "RIFF");
  assert(result.length > 1000 && result.length < 900000);
});

const modelDir =
  process.env.DESK_ASR_MODEL_DIR ||
  new URL("../runtime/models/sensevoice-small-int8", import.meta.url).pathname;
const hasModel = await Promise.all(
  ["model.int8.onnx", "tokens.txt", "zh.wav", "en.wav"].map((name) =>
    access(modelDir + "/" + name),
  ),
).then(
  () => true,
  () => false,
);
const qualityModelDir =
  process.env.DESK_ASR_QUALITY_MODEL_DIR ||
  new URL("../runtime/models/qwen3-asr", import.meta.url).pathname;
const hasQuality = await Promise.all(
  ["conv_frontend.onnx", "encoder.int8.onnx", "decoder.int8.onnx", "tokenizer/vocab.json"].map(
    (name) => access(qualityModelDir + "/" + name),
  ),
).then(
  () => true,
  () => false,
);
test(
  "real Chromium timesliced recording reaches warm CPU recognition before and after release",
  { skip: !hasModel, timeout: 25000 },
  async (t) => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_BIN || chromium.executablePath(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required",
      ],
      env: { ...process.env, TMPDIR: process.env.TMPDIR },
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const clips = await page.evaluate(async () => {
      const audio = new AudioContext(),
        source = audio.createOscillator(),
        sink = audio.createMediaStreamDestination();
      source.connect(sink);
      source.start();
      await audio.resume();
      const recorder = new MediaRecorder(sink.stream, {
          mimeType: "audio/webm;codecs=opus",
          audioBitsPerSecond: 64000,
        }),
        chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      const encode = (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      recorder.start(600);
      await new Promise((resolve) => setTimeout(resolve, 2400));
      const partial = await encode(new Blob(chunks, { type: recorder.mimeType }));
      await new Promise((resolve) => {
        recorder.onstop = resolve;
        recorder.stop();
      });
      const full = await encode(new Blob(chunks, { type: recorder.mimeType }));
      source.stop();
      await audio.close();
      return { partial, full, count: chunks.length };
    });
    assert(clips.count >= 2, "MediaRecorder emitted incremental data");
    const partial = await toWav(Buffer.from(clips.partial, "base64"), "webm");
    const full = await toWav(Buffer.from(clips.full, "base64"), "webm");
    assert.equal(partial.toString("ascii", 0, 4), "RIFF");
    assert.equal(full.toString("ascii", 0, 4), "RIFF");
    assert(
      partial.length > 1000 && full.length > partial.length,
      "partial and final audio both decode",
    );
    const dir = await mkdtemp(process.env.TMPDIR + "/voice-chromium-");
    const desk = await createDesk({
      runtime: dir + "/runtime",
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
      socket: dir + "/absent.sock",
      allowed: [],
      secure: false,
    });
    await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const cookie = desk.auth.cookie(desk.auth.issue({ login: "fixture" })).split(";")[0];
    const headers = { Origin: origin, Cookie: cookie, "Content-Type": "application/json" };
    assert.equal(
      (
        await fetch(origin + "/api/voice/prepare", {
          method: "POST",
          headers,
          body: JSON.stringify({ language: "auto" }),
        })
      ).status,
      200,
    );
    for (const data of [clips.partial, clips.full]) {
      const response = await fetch(origin + "/api/voice/transcribe", {
        method: "POST",
        headers,
        body: JSON.stringify({ mime: "audio/webm;codecs=opus", language: "auto", data }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(typeof result.text, "string");
    }
  },
);

test(
  "CPU worker reuses one loaded model and releases it after idle",
  { skip: !hasModel, timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/voice-warm-");
    await mkdir(dir + "/tmp");
    await mkdir(dir + "/cache");
    const worker = new LocalAsrWorker({
      runtime: dir,
      python:
        process.env.DESK_ASR_PYTHON ||
        new URL("../runtime/asr-env/bin/python", import.meta.url).pathname,
      modelDir,
      idleMs: 250,
    });
    t.after(() => worker.stop());
    await worker.warm("auto");
    const pid = worker.child.pid;
    assert(worker.running());
    const sample = await readFile(modelDir + "/zh.wav");
    assert.match(await worker.recognize(sample, "auto"), /早上9点/);
    assert.match(await worker.recognize(sample, "auto"), /早上9点/);
    assert.equal(worker.child.pid, pid, "two phrases share one loaded CPU model");
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(worker.running(), false, "idle model process exits");
  },
);
test(
  "real authenticated HTTP recognizes upstream Chinese and English WAVs on CPU",
  { skip: !hasModel, timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/voice-real-");
    const desk = await createDesk({
      runtime: dir + "/runtime",
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
      socket: dir + "/absent.sock",
      allowed: [],
      secure: false,
    });
    await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const cookie = desk.auth.cookie(desk.auth.issue({ login: "fixture" })).split(";")[0];
    assert.equal(
      (await (await fetch(origin + "/api/voice/status", { headers: { Cookie: cookie } })).json())
        .enabled,
      true,
    );
    const prepared = await fetch(origin + "/api/voice/prepare", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ language: "auto" }),
    });
    assert.deepEqual(await prepared.json(), { ready: true });
    for (const [language, file, expected] of [
      ["auto", "zh.wav", /早上9点/],
      ["auto", "en.wav", /tribal chieftain/i],
    ]) {
      const data = (await readFile(modelDir + "/" + file)).toString("base64");
      const response = await fetch(origin + "/api/voice/transcribe", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ mime: "audio/wav", language, data }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.match(result.text, expected);
    }
    const encoder = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        modelDir + "/zh.wav",
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-f",
        "webm",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const parts = [];
    for await (const chunk of encoder.stdout) parts.push(chunk);
    assert.equal(await new Promise((resolve) => encoder.on("close", resolve)), 0);
    const webmData = Buffer.concat(parts).toString("base64");
    const webmResponse = await fetch(origin + "/api/voice/transcribe", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mime: "audio/webm;codecs=opus", language: "auto", data: webmData }),
    });
    const webmResult = await webmResponse.json();
    assert.equal(webmResponse.status, 200, JSON.stringify(webmResult));
    assert.match(webmResult.text, /早上9点/);
  },
);

test(
  "authenticated final transcription uses local Qwen3-ASR while fast path remains available",
  { skip: !hasModel || !hasQuality, timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(process.env.TMPDIR + "/voice-qwen-http-");
    const desk = await createDesk({
      runtime: dir + "/runtime",
      codexHome: dir + "/runtime" + "/codex",
      claudeHome: dir + "/runtime" + "/claude",
      socket: dir + "/absent.sock",
      allowed: [],
      secure: false,
    });
    await new Promise((resolve) => desk.server.listen(0, "127.0.0.1", resolve));
    t.after(() => desk.close());
    const origin = "http://127.0.0.1:" + desk.server.address().port;
    desk.config.origin = origin;
    const cookie = desk.auth.cookie(desk.auth.issue({ login: "fixture" })).split(";")[0];
    const headers = { Origin: origin, Cookie: cookie, "Content-Type": "application/json" };
    assert.equal(
      (await (await fetch(origin + "/api/voice/status", { headers: { Cookie: cookie } })).json())
        .quality,
      true,
    );
    assert.equal(
      (
        await fetch(origin + "/api/voice/prepare", {
          method: "POST",
          headers,
          body: JSON.stringify({ language: "auto" }),
        })
      ).status,
      200,
    );
    const data = (await readFile(modelDir + "/zh.wav")).toString("base64");
    const response = await fetch(origin + "/api/voice/transcribe", {
      method: "POST",
      headers,
      body: JSON.stringify({ mime: "audio/wav", language: "auto", mode: "accurate", data }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.engine, "qwen3");
    assert.match(result.text, /早上[九9][点點]/);
  },
);
