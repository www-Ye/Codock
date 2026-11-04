"""Short-lived CPU-only ASR worker; one JSON/WAV line in, one result out."""

import base64
import io
import json
import os
import re
import sys
import wave

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["OMP_NUM_THREADS"] = "2"

import numpy as np
import sherpa_onnx


def decode(recognizer, raw, vocabulary=None):
    if len(raw) < 64 or len(raw) > 900000:
        raise ValueError("invalid audio length")
    with wave.open(io.BytesIO(raw), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, "NONE"):
            raise ValueError("invalid audio format")
        frames = wav.readframes(400001)
    if len(frames) < 320 or len(frames) > 800000:
        raise ValueError("invalid audio duration")
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    stream = recognizer.create_stream()
    if vocabulary:
        # Qwen3 per-stream context supports mixed speech; do not force a
        # language token, translate text or share hints with the next request.
        if not isinstance(vocabulary, list) or len(vocabulary) > 16:
            raise ValueError("invalid recognition vocabulary")
        if any(not isinstance(w, str) or len(w) > 40 or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_+.#-]*(?: [A-Za-z0-9_+.#-]+){0,2}", w) for w in vocabulary):
            raise ValueError("invalid recognition term")
        stream.set_option("hotwords", ",".join(vocabulary))
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    return stream.result.text


def main():
    kind, directory, language = sys.argv[1:]
    if language not in ("auto", "zh", "en"):
        raise ValueError("unsupported language")
    if kind == "sensevoice":
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=os.path.join(directory, "model.int8.onnx"),
            tokens=os.path.join(directory, "tokens.txt"), num_threads=2,
            provider="cpu", language=language, use_itn=True, debug=False,
        )
    elif kind == "qwen3" and language == "auto":
        recognizer = sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
            conv_frontend=os.path.join(directory, "conv_frontend.onnx"),
            encoder=os.path.join(directory, "encoder.int8.onnx"),
            decoder=os.path.join(directory, "decoder.int8.onnx"),
            tokenizer=os.path.join(directory, "tokenizer"),
            num_threads=16, provider="cpu", max_new_tokens=256, debug=False,
        )
    else:
        raise ValueError("unsupported model or language")
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin.buffer:
        if len(line) > 1200100:
            raise ValueError("invalid request length")
        request = json.loads(line)
        raw = base64.b64decode(request["wav"], validate=True)
        print(json.dumps({"text": decode(recognizer, raw, request.get("vocabulary") if kind == "qwen3" else None)}), flush=True)


if __name__ == "__main__":
    main()
