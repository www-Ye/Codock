import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { createDesk } from "../server.mjs";
import { toWav, VoiceAsr } from "../lib/voice-asr.mjs";
import { LocalAsrWorker } from "../lib/local-asr-worker.mjs";

const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
const wav = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(600),
]);
const input = { mime: "audio/webm;codecs=opus", language: "zh-CN", data: webm.toString("base64") };

test("HTTPS gateway limits larger bodies to the exact voice upload route", async () => {
  const gateway = await readFile(new URL("../deploy/nginx.conf.example", import.meta.url), "utf8");
  assert.match(gateway, /client_max_body_size 24k;/);
  assert.match(gateway, /location = \/api\/voice\/transcribe \{\s*client_max_body_size 1400k;/);
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
