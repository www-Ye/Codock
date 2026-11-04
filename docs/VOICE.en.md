# Local dictation

English · [简体中文](VOICE.md)

Tap to start/stop, or hold to speak and release to finalize. Audio travels over HTTPS to your workstation. Recognized text enters the draft; it is never sent automatically. Grant microphone permission. Browser or keyboard dictation remains an alternative.

## Install on the Codock workstation

Install Python 3, venv and ffmpeg (`sudo apt install python3-venv ffmpeg` on Ubuntu). From the repository:

```sh
mkdir -p runtime/models runtime/cache runtime/tmp
export TMPDIR="$PWD/runtime/tmp" PIP_CACHE_DIR="$PWD/runtime/cache/pip"
python3 -m venv runtime/asr-env
runtime/asr-env/bin/pip install numpy sherpa-onnx
curl -fL https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2 -o runtime/cache/sensevoice.tar.bz2
tar -xjf runtime/cache/sensevoice.tar.bz2 -C runtime/models
mv runtime/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17 runtime/models/sensevoice-small-int8
```

Restart Codock. Defaults are `runtime/asr-env/bin/python` and `runtime/models/sensevoice-small-int8/{model.int8.onnx,tokens.txt}`. Override with absolute `DESK_ASR_PYTHON` and `DESK_ASR_MODEL_DIR` paths. For systemd, configure service environment variables, not just shell exports.

Optional final-pass quality: put a sherpa-onnx-compatible Qwen3-ASR ONNX model in `runtime/models/qwen3-asr`, containing `conv_frontend.onnx`, `encoder.int8.onnx`, `decoder.int8.onnx`, and `tokenizer/vocab.json`; or set `DESK_ASR_QUALITY_MODEL_DIR`. SenseVoice handles interim text; Qwen3 handles final text with fast-model fallback. Mixed Chinese/English uses automatic language detection and per-utterance hints for terms such as Codex, tmux and API, without forced translation or replacement. Check model licensing and sherpa-onnx compatibility; quality varies with speech.

Both engines use CPU, not GPU, with idle shutdown after about 20 seconds for the fast model and 120 seconds for the final-pass model. Clips are limited to 25 seconds; one recognition runs at a time. WAV conversion uses memory pipes; recordings are not saved by default or sent to a third-party ASR service. Browser-native dictation follows its provider's behavior.

When upgrading Nginx, copy the exact `/api/voice/transcribe` exception with `client_max_body_size 1400k` from the [template](../deploy/nginx.conf.example). Keep other body limits unchanged. For stalled recognition, check ffmpeg, Python/model paths, HTTPS microphone permission and proxy 413 errors.

## Dictation in a preview

A bound preview can opt in by posting `{type: "codock-preview-voice-ready", enabled: true}` to the workbench's exact origin. The toolbar then offers dictation; microphone permission remains on the workbench. Listen for `codock-preview-voice-result`, validate `event.source === parent` and the exact workbench origin, then copy `event.data.text` into a draft when `phase === "done"`. Nothing is submitted automatically. See the [small example](VOICE.md#给预览页面接入语音).
