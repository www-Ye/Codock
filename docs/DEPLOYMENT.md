# 自己的网址：以腾讯云为例

[English](DEPLOYMENT.en.md) · 简体中文

目标：`https://terminal.你的域名`，手机直接登录，聊天、终端和独立网页预览都可用。只想先体验？看[免费方案](FREE-TRYOUT.md)。文中的 `example.com`、账号和路径都是占位示例。

## 1. 买域名和服务器

| 腾讯云控制台          | 怎么选                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------ |
| 账号 → 实名认证       | 提交本人信息；证件只放官方控制台                                                           |
| 域名注册 → 信息模板   | 创建并完成域名实名审核，再搜索、购买未注册且支持备案的域名；核对续费价                     |
| 轻量应用服务器 → 新建 | **系统镜像 → Ubuntu 24.04 LTS**；不选 AI 应用或管理面板                                    |
| 地域、套餐            | 靠近实际使用者，如华北可选北京；个人轻量用途可从 2 核 2 GB 起步，带公网 IPv4；项目计算另计 |
| 实例详情              | 复制**公网 IPv4**，不是内网 IP；通过「登录」进入命令行，Ubuntu 按提示使用 `ubuntu` 用户    |

参考：[域名注册](https://cloud.tencent.com/document/product/242/9595) · [域名实名](https://cloud.tencent.com/document/product/242/6707) · [服务器创建](https://cloud.tencent.com/document/product/1207/44548)。付费 DNS、短信、共享存储、CDN 都不是必需品，HTTPS 可用下文免费证书。不要仅看首年优惠；价格以下单页为准。

公网 IP 由服务器产品提供，不用另申请地址段；购买前确认地址保持策略，需要时选弹性公网 IP 产品。不要销毁重建实例来刷新网站，重建可能换地址。

**中国内地服务器先备案再公开开站**：控制台「ICP备案」提交真实主体、域名和用途。轻量备案资源目前要求累计购买至少 3 个月、备案期间剩余至少 1 个月，以[官方要求](https://cloud.tencent.cn/document/product/243/18908)为准。账号实名、域名实名、ICP备案不是一件事；通过后按控制台要求展示备案信息并办理适用的后续手续。

## 2. DNS 与防火墙

DNSPod → 我的域名 → 解析记录 → 添加记录，线路和 TTL 用默认值：

| 主机记录    | 类型 | 记录值        |
| ----------- | ---- | ------------- |
| `terminal`  | A    | 实例公网 IPv4 |
| `*.preview` | A    | 同一公网 IPv4 |

不用改 `@`，不填完整 URL、内网 IP 或 `127.0.0.1`，未验证 IPv6 不加 AAAA。[A 记录说明](https://intl.cloud.tencent.com/zh/document/product/1295/76974?lang=zh)

轻量实例 → 防火墙：允许 TCP 443，80 仅用于跳转，22 限自己的管理来源。主机防火墙同步检查；**不开放全部端口，不开放 8790、18790 或开发端口**。

## 3. 安装在哪里？

- **同机**：Codex、tmux、Codock、Nginx 都在云服务器上，Nginx 转发回环 `8790`。
- **异机**：Codock 与 tmux 留在工作机；公网服务器只运行 Nginx，通过[受限隧道](#可选工作机与网关分开)连接工作机。

全新 Ubuntu 工作机由管理员准备以下环境；已有会话沿用同一个非 root 用户和 socket，不递归改已有项目属主。

```sh
sudo apt update
sudo apt install -y git tmux python3 build-essential
sudo adduser --disabled-password --gecos '' --home /srv/codock codock
sudo install -d -o codock -g codock -m 0700 /srv/codock/tmux
sudo install -d -o codock -g codock -m 0750 /srv/codock/projects
sudo -iu codock
```

按 [Node 官方说明](https://nodejs.org/en/download)安装 Node 22+，不要假设系统软件源版本够新。然后完成[安装、配置、登录与本地检查](INSTALL.md)。确认 bootstrap 正常后，`Ctrl+C` 停止前台应用。

## 4. 常驻运行

编辑[服务模板](../deploy/workbench.service.example)：按 `command -v node` 填 `ExecStart` 的绝对路径，核对用户和目录。管理员执行：

```sh
sudo install -m 0644 /srv/codock/app/deploy/workbench.service.example /etc/systemd/system/codock.service
sudo systemd-analyze verify /etc/systemd/system/codock.service
sudo systemctl daemon-reload
sudo systemctl enable --now codock
sudo systemctl status codock --no-pager
```

应为 `active (running)`；排错用 `journalctl -u codock -n 50`。容器无 systemd 时用平台进程监管和持久卷。

## 5. HTTPS

在**公网服务器**由管理员安装并申请覆盖主站和预览的证书：

```sh
sudo apt install -y nginx certbot dnsutils
sudo certbot certonly --manual --preferred-challenges dns --cert-name codock \
  -d terminal.example.com -d '*.preview.example.com'
```

按提示在 DNSPod 添加 TXT；控制台自动补域名时，只填 `_acme-challenge.terminal` 或 `_acme-challenge.preview`。用 `dig TXT 完整验证域名 +short` 确认生效再按回车。证书生成于 `/etc/letsencrypt/live/codock/`。

**手动 TXT 不会自动续期**。长期运行应按 [Certbot DNS 插件指引](https://certbot.eff.org/instructions?os=snap&tab=wildcard&ws=nginx)配置实际 DNS 服务商支持的插件或 hook，API 密钥限权、0600、置于仓库外；不要混装不同来源 Certbot。验证 `certbot renew --dry-run`，并设置成功续期后 `nginx -t && systemctl reload nginx`。自动化完成前保留人工验证和到期提醒。通配证书须用 [DNS-01](https://letsencrypt.org/docs/challenge-types/)；`*.example.com` 不覆盖 `*.preview.example.com`。

修改 [Nginx 模板](../deploy/nginx.conf.example)的域名；同机 upstream 为 `8790`，异机为 `18790`。新增独立配置，不覆盖旧站：

```sh
sudo install -m 0644 /srv/codock/app/deploy/nginx.conf.example /etc/nginx/conf.d/codock.conf
sudo nginx -t
sudo systemctl reload nginx
```

异机先将模板复制到网关。主配置的 `http` 块需包含 `conf.d/*.conf`；检查失败不要 reload。模板兼容 Nginx 1.24，支持 WebSocket、不缓存授权内容、不重放 POST，也不记录回调 URL。

## 6. 真正打开试试

手机和电脑打开 `https://terminal.你的域名`：验证登录、聊天、中文和特殊按键、审批、中断，再按[使用说明](USAGE.md)绑定 HTML。分别测试 Wi-Fi、蜂窝、断线恢复；退出后预览应失效。仅本机 HTTP 200 不代表公网可用。

超时先查 DNS/443/Nginx；502 查工作机 bootstrap 和隧道；GitHub 错误查回调、数字 ID 和外网连接；预览证书错误查通配域名。更多见[架构与排错](ARCHITECTURE.md)、[安全](../SECURITY.zh-CN.md)。

<details>
<summary><a id="可选工作机与网关分开"></a>可选：工作机与网关分开</summary>

工作机主动连网关，无需开放工作机入站。

1. 工作机服务用户创建专用密钥：`install -d -m 0700 /srv/codock/ssh`，再 `ssh-keygen -t ed25519 -f /srv/codock/ssh/tunnel_ed25519`。常驻服务需无交互解锁；若用空口令，必须限制该密钥权限。
2. 网关创建无 sudo 的 `workbench-tunnel` 用户，`.ssh` 为 0700、`authorized_keys` 为 0600、均属该用户；只加入公钥，前缀为 `restrict,port-forwarding,permitlisten="127.0.0.1:18790"`，不复制私钥。
3. 网关适配 [sshd 限制模板](../deploy/sshd-tunnel.conf.example)，保留当前 SSH 连接；先 `sshd -t`，再 `sshd -T -C user=workbench-tunnel,host=localhost,addr=WORKSTATION_IP` 核对有效限制后 reload。`MaxSessions 0` 禁止 shell/session，不禁止指定转发。[OpenSSH 参考](https://man.openbsd.org/sshd_config)
4. 经可信管理通道核对网关主机公钥，写入工作机 `/srv/codock/ssh/known_hosts`；不关闭严格校验，`ssh-keyscan` 本身不能证明身份。
5. 工作机修改[隧道服务模板](../deploy/tunnel.service.example)的用户、路径、`GATEWAY_HOST`，安装为 `/etc/systemd/system/codock-tunnel.service`，verify 后 daemon-reload 并 enable。一个端口只运行一条隧道。
6. 网关执行 `curl --fail -H 'Host: terminal.example.com' http://127.0.0.1:18790/api/bootstrap`，返回正常 JSON 后才接 Nginx；同时验证隧道用户不能运行远程 `id` 或绑定其他端口。

撤回只停止新服务、撤销其公钥/OAuth/虚拟主机，保留原项目与 tmux，不执行全局 `kill-server`。

</details>
