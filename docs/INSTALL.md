# 安装与登录

[English](INSTALL.en.md) · 简体中文

在 **Codex 所在的 Linux 机器**执行。要求 Node.js 22+、tmux 3.4+、Python 3；原生依赖可能需要 C/C++ 编译工具。应用与目标 tmux 使用同一非 root 用户。

## 1. 安装

将 `REPOSITORY_URL` 换成 GitHub 仓库的克隆地址，目标目录按需调整：

```sh
git clone REPOSITORY_URL /srv/codock/app
cd /srv/codock/app
mkdir -p runtime/tmp runtime/cache runtime/config runtime/npm
chmod 700 runtime
export TMPDIR="$PWD/runtime/tmp" XDG_CACHE_HOME="$PWD/runtime/cache"
export XDG_CONFIG_HOME="$PWD/runtime/config" npm_config_cache="$PWD/runtime/npm"
export npm_package_config_node_gyp_devdir="$PWD/runtime/node-gyp"
npm ci --omit=dev
cp config.example.json config.json
chmod 600 config.json
```

已有 tmux：在原会话执行 `tmux display-message -p '#{socket_path}'`，记下 socket。全新环境：

```sh
tmux -S /srv/codock/tmux/default.sock new-session -s dev -c /srv/codock/projects
```

在其中启动已安装并登录好的 Codex。按 `Ctrl+B`，松开，再按 `D` 保留会话回到 shell；不要重建现有会话。

## 2. 配置

编辑 `config.json`，不提交到 Git：

| 字段            | 内容                                                          |
| --------------- | ------------------------------------------------------------- |
| `origin`        | 你的完整 HTTPS 网址，无路径；免费隧道先取得网址再填           |
| `previewSuffix` | 标准部署填 `preview.你的域名`；免费体验保留示例值，不启用预览 |
| `socket`        | 上一步确认的真实 socket 绝对路径                              |
| `projectRoot`   | 项目上级目录，例如 `/srv/codock/projects`                     |
| `allowed`       | 明确批准的会话，例如 `["dev"]`                                |
| `codexHome`     | 当前用户实际的 Codex 记录目录，通常是主目录下 `.codex`        |
| `authMode`      | `github` 或 `local`，按下一节选择                             |

其余先保留默认。主站与预览须同一可注册域、不同 origin；不要只凭域名最后两个标签判断。更多外观与预览设置见[使用说明](USAGE.md)。

## 3. 登录身份（二选一）

**GitHub**：Settings → Developer settings → OAuth Apps → New OAuth App。Homepage 填 `origin`，回调填 `origin/auth/github/callback`；不启用通配回调或 Device Flow。访问 `https://api.github.com/users/YOUR_LOGIN`，将自己的 `login` 和数字 `id` 写入 `githubOwner`，然后运行 `npm run setup:github`，隐藏输入 Client ID / secret。示例 ID `0` 故意不能启动。不申请仓库权限，工作机须能访问 GitHub。[官方流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

**密码＋TOTP**：`authMode` 改为 `local`，运行 `npm run setup`，设置 16–256 字符密码，按提示在验证器中添加密钥并确认动态码。保存密钥，不分享截图。两种模式互斥，不会自动降级。

## 4. 启动检查

```sh
npm run check
npm start
```

另一个终端验证，Host 换成 `origin` 的域名：

```sh
curl --fail --show-error -H 'Host: terminal.example.com' http://127.0.0.1:8790/api/bootstrap
```

应返回 JSON，未登录时 `authenticated: false`。失败先修检查项，不要用 root 绕过。接着返回[免费网址](FREE-TRYOUT.md)或[正式部署](DEPLOYMENT.md)完成访问；配置修改后重启。
