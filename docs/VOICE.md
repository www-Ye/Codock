# 本地语音

[English](VOICE.en.md) · 简体中文

轻点麦克风开始／结束，或按住说话、松开整理。录音通过 HTTPS 发送到自己的工作机，文字只进入草稿，不自动发送。需要浏览器麦克风权限；没有部署本地模型时可使用浏览器／系统键盘听写。

## 安装（在运行 Codock 的机器）

系统需要 Python 3、venv、ffmpeg；Ubuntu 可由管理员执行 `sudo apt install python3-venv ffmpeg`。以下命令在仓库目录执行，模型与环境不会提交到 Git：

```sh
mkdir -p runtime/models runtime/cache runtime/tmp
export TMPDIR="$PWD/runtime/tmp" PIP_CACHE_DIR="$PWD/runtime/cache/pip"
python3 -m venv runtime/asr-env
runtime/asr-env/bin/pip install numpy sherpa-onnx
curl -fL https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2 -o runtime/cache/sensevoice.tar.bz2
tar -xjf runtime/cache/sensevoice.tar.bz2 -C runtime/models
mv runtime/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17 runtime/models/sensevoice-small-int8
```

重启 Codock。默认读取 `runtime/asr-env/bin/python` 与 `runtime/models/sensevoice-small-int8/{model.int8.onnx,tokens.txt}`。已有环境可用 `DESK_ASR_PYTHON`、`DESK_ASR_MODEL_DIR` 指定绝对路径；使用 systemd 时写入服务环境，不仅是在交互式 shell 里 export。

可选高精度最终稿：将兼容 sherpa-onnx 的 Qwen3-ASR ONNX 模型放在 `runtime/models/qwen3-asr`，需包含 `conv_frontend.onnx`、`encoder.int8.onnx`、`decoder.int8.onnx`、`tokenizer/vocab.json`。也可设置 `DESK_ASR_QUALITY_MODEL_DIR`。临时识别仍用 SenseVoice；最终稿用 Qwen3，失败回退快速模型。请核对模型许可证与当前 sherpa-onnx 版本，不保证所有口音更准确。

## 部署要点

- 两种引擎均使用 CPU，不占 GPU；进程闲置约 20 秒退出。最长录音 25 秒，同一时刻处理一段。
- 更新已有 Nginx 时也同步 [配置模板](../deploy/nginx.conf.example)：只有 `/api/voice/transcribe` 需要 `1400k` 请求体额度，其余接口不放宽。
- 一直“整理中”：先确认 ffmpeg、模型文件、Python 环境和 HTTPS 麦克风权限；反向代理 413 表示上传大小限制未更新。
- 录音通过内存管道转为 WAV；不默认保存录音，也不发送到第三方语音服务。浏览器自身听写则由浏览器服务决定。
