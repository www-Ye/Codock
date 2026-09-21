# 免费网址，先试试看

[English](FREE-TRYOUT.en.md) · 简体中文

已有可运行 Codex 的 Linux 工作机，就能免费获得 HTTPS 入口，无须另买域名或服务器。免费不包括机器、电费或 Codex 费用；**这个单网址方案只体验聊天和终端，不提供独立 HTML 预览**。

## 最快：Cloudflare Quick Tunnel

1. 在工作机按[安装指南](INSTALL.md)安装应用；先不启动。
2. 安装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)，开一个终端运行：

   ```sh
   cloudflared tunnel --url http://127.0.0.1:8790
   ```

3. 复制输出的 `https://随机名字.trycloudflare.com`，填进应用 `config.json` 的 `origin`；`authMode` 设为 `local`。`previewSuffix` 保留示例值，不绑定预览。
4. 按安装指南设置密码＋TOTP，执行 `npm run check`、`npm start`。保持应用和隧道运行，手机直接打开生成的网址登录。

应用启动前出现 502 正常。若已有 cloudflared 配置影响临时隧道，使用独立测试环境，不覆盖原配置。重新建立隧道可能换地址，此时更新 `origin` 并重启应用；GitHub 登录还需同步回调，所以体验推荐本地认证。

临时隧道没有可用性保证，最多 200 个并发请求、不支持 SSE；本应用使用 HTTP 轮询与 WebSocket。预览页签仍会存在，但该方案下不可用。不要关闭鉴权或开放 8790 公网端口。[Cloudflare 限制说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

## 更固定：Tailscale Funnel

工作机安装 Tailscale、登录并启用 Funnel，然后运行 `tailscale funnel 8790`。将返回的 `https://设备名.网络名.ts.net` 填入 `origin`，其他安装与认证步骤不变。保持设备及网络命名时网址更适合收藏；它仍是服务商子域，不是你拥有的域名。

Funnel 当前支持免费计划，但须符合计划用途和限制。它是公网入口，**访问者不用安装 Tailscale**，不要与仅供内部访问的 Serve 混淆。单网址同样不支持本项目的独立预览。[官方说明](https://tailscale.com/docs/features/tailscale-funnel)

两种路线都需要在你的 Wi-Fi、蜂窝网络上实测，不能保证跨境访问稳定；本仓库未对这些第三方公网入口做在线验收。需要自有固定网址与完整网页预览时，使用[腾讯云部署方案](DEPLOYMENT.md)。
