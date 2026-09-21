# 开发

[English](CONTRIBUTING.md) · 简体中文

保持一套认证、一套终端执行和一套预览链路。修复共同机制，不给每个失败再加一条特殊路径。演示素材必须是虚构数据。

## 环境与测试

Linux、Node.js 22+、Python 3、tmux、FFmpeg、Chromium；原生依赖可能需要编译工具。

```sh
mkdir -p runtime/tmp runtime/cache runtime/config runtime/npm
export TMPDIR="$PWD/runtime/tmp" XDG_CACHE_HOME="$PWD/runtime/cache"
export XDG_CONFIG_HOME="$PWD/runtime/config" npm_config_cache="$PWD/runtime/npm"
export npm_package_config_node_gyp_devdir="$PWD/runtime/node-gyp"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/runtime/browsers"
npm ci
node node_modules/playwright-core/cli.js install chromium
npm test
npm run smoke
npm run lint
npm run format:check
```

系统依赖缺失时按 Playwright 提示由管理员安装；也可设置 `DESK_CHROMIUM` 指向已有浏览器。测试使用独立 socket、合成历史和模拟 OAuth，不读取生产配置，不调用付费模型。缓存和截图留在忽略的 `runtime/`。过长路径可能超出 Chromium Unix socket 长度限制，应换短工作目录而非系统临时目录。

`npm run smoke` 必须以非 root 用户运行：复制源码到隔离目录，检查真实生产入口、登录、PTY 输入、预览授权和退出撤权。它复用已安装依赖；验证干净安装时，在全新 checkout 中先执行 `npm ci --omit=dev`，再运行 smoke。它不验证真实 DNS、TLS 或 GitHub 授权。

## 更新配图

```sh
npm run screenshots
```

运行真实前端与隔离演示 API，覆盖三套主题、手机/电脑、存储禁用、减少动画和文字对比度，然后更新 `docs/assets/`。原会话、账号、域名、路径均不进入截图。生成后人工检查图片，不把样例测试称作真实公网验收。

## 提交

`npm run format` 统一格式；`npm run lint` 检查 Git 候选文件、常见秘密/个人路径、源码语法和文档本地链接。已跟踪文件同样检查，不依赖忽略规则掩盖秘密。代码采用 [MIT](LICENSE)，第三方声明见 [NOTICE](NOTICE.md)。

```sh
git status --short
git add .
git diff --cached --stat
git diff --cached
```

确认无敏感数据后再自行 commit/push。不要上传 `runtime/`、真实 `config.json`、`.env`、浏览器 profile、密钥或依赖目录。仓库不生成源码压缩包。
