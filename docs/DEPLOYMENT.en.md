# Your own website: Tencent Cloud example

English · [简体中文](DEPLOYMENT.md)

Goal: `https://terminal.your-domain`, with chat, terminal and isolated previews. Just exploring? [Try for free](FREE-TRYOUT.en.md). All domains, usernames and paths below are placeholders.

## 1. Domain and server

| Tencent Cloud console                       | Choose                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Account → identity verification             | Your real details; submit documents only to the official console                                                                       |
| Domain registration → information templates | Verify the registrant template, then buy an available domain eligible for the intended region; check renewal pricing                   |
| Lighthouse → create                         | **OS image → Ubuntu 24.04 LTS**, not an AI app or management panel                                                                     |
| Region and plan                             | Near your users; 2 vCPU / 2 GB is a starting point for light personal use, with public IPv4; project workloads need their own capacity |
| Instance details                            | Copy **public IPv4**, not private IP; use the console login, normally the prompted `ubuntu` user                                       |

Official guides: [registration](https://cloud.tencent.com/document/product/242/9595), [domain verification](https://cloud.tencent.com/document/product/242/6707), [server creation](https://cloud.tencent.com/document/product/1207/44548). Paid DNS, SMS, shared storage and CDN are not required. Use a free certificate below; check actual checkout and renewal prices.

The server product supplies the public IP; you do not need an address allocation of your own. Confirm its persistence policy, or select an elastic-IP product if needed. Destroying and recreating an instance may change its address.

**For mainland China hosting, complete applicable ICP filing before public launch.** Submit the real owner, domain and website purpose. Lighthouse filing resources currently require at least three months purchased and one month remaining during filing; confirm the [current requirements](https://cloud.tencent.cn/document/product/243/18908). Account verification, domain verification and ICP filing are different steps. Follow the console's post-approval display and other applicable requirements.

## 2. DNS and firewall

DNSPod → domains → records → add; retain default routing and TTL:

| Host        | Type | Value                |
| ----------- | ---- | -------------------- |
| `terminal`  | A    | Instance public IPv4 |
| `*.preview` | A    | Same public IPv4     |

Do not change `@`, enter a URL, use private IP/localhost, or add unverified AAAA records. [A records](https://intl.cloud.tencent.com/zh/document/product/1295/76974?lang=zh)

Allow TCP 443 in the instance firewall; 80 is only for HTTPS redirects. Restrict SSH 22 to administrative sources. Check the host firewall too. **Do not open all ports, 8790, 18790 or development ports.**

## 3. Where to install

- **Same host:** Codex, tmux, Codock and Nginx share the cloud server; Nginx uses loopback `8790`.
- **Separate hosts:** keep Codock with tmux on the workstation; Nginx on the public server reaches it through the [restricted tunnel](#separate-workstation-and-gateway).

An administrator prepares a fresh Ubuntu workstation below. For existing sessions, reuse their non-root user and socket; never recursively change ownership of an existing shared project.

```sh
sudo apt update
sudo apt install -y git tmux python3 build-essential
sudo adduser --disabled-password --gecos '' --home /srv/codock codock
sudo install -d -o codock -g codock -m 0700 /srv/codock/tmux
sudo install -d -o codock -g codock -m 0750 /srv/codock/projects
sudo -iu codock
```

Install Node 22+ using the [official instructions](https://nodejs.org/en/download); the OS package may be older. Complete [installation and local checks](INSTALL.en.md), then stop the foreground app with `Ctrl+C`.

## 4. Keep it running

Edit the [service template](../deploy/workbench.service.example): use the Node path from `command -v node`; verify user and directories. As administrator:

```sh
sudo install -m 0644 /srv/codock/app/deploy/workbench.service.example /etc/systemd/system/codock.service
sudo systemd-analyze verify /etc/systemd/system/codock.service
sudo systemctl daemon-reload
sudo systemctl enable --now codock
sudo systemctl status codock --no-pager
```

Expect `active (running)`. Diagnose with `journalctl -u codock -n 50`. Without systemd, use your platform's supervisor and persistent volumes.

## 5. HTTPS

On the **public server**, an administrator installs Nginx and requests a certificate for both origins:

```sh
sudo apt install -y nginx certbot dnsutils
sudo certbot certonly --manual --preferred-challenges dns --cert-name codock \
  -d terminal.example.com -d '*.preview.example.com'
```

Add the requested TXT records in DNSPod; if the console appends the domain, enter only `_acme-challenge.terminal` or `_acme-challenge.preview`. Check `dig TXT FULL_VALIDATION_NAME +short` before continuing. Certificates are saved under `/etc/letsencrypt/live/codock/`.

**Manual TXT validation does not renew unattended.** For long-term use, configure a supported provider plugin or reviewed DNS hook using [Certbot's guide](https://certbot.eff.org/instructions?os=snap&tab=wildcard&ws=nginx). Limit DNS credentials, keep them 0600 outside the repo, and do not mix Certbot distributions. Test `certbot renew --dry-run` and a successful-renewal hook of `nginx -t && systemctl reload nginx`. Until automated, maintain expiry reminders and manual renewal. Wildcards need [DNS-01](https://letsencrypt.org/docs/challenge-types/); `*.example.com` does not cover `*.preview.example.com`.

Edit domains in the [Nginx template](../deploy/nginx.conf.example); use upstream `8790` on the same host or `18790` through a gateway. Add a new file, never replace an existing site:

```sh
sudo install -m 0644 /srv/codock/app/deploy/nginx.conf.example /etc/nginx/conf.d/codock.conf
sudo nginx -t
sudo systemctl reload nginx
```

For separate hosts, copy the template to the gateway first. The main `http` block must include `conf.d/*.conf`. Do not reload after failed validation. The template supports Nginx 1.24, WebSockets, uncached authenticated responses and no POST replay or callback URL logging.

## 6. Test real devices

Open your HTTPS domain on phone and desktop. Verify login, chat, text and special keys, approvals and interruption; bind HTML following [usage](USAGE.en.md). Test Wi-Fi, cellular and reconnects. Logout must revoke previews. A local HTTP 200 is not public-network acceptance.

Timeout: check DNS/443/Nginx. 502: workstation bootstrap/tunnel. GitHub failure: exact callback, numeric ID, outbound access. Preview TLS failure: wildcard coverage. See [troubleshooting](ARCHITECTURE.en.md) and [security](../SECURITY.md).

<details>
<summary><a id="separate-workstation-and-gateway"></a>Optional: separate workstation and gateway</summary>

The workstation initiates the connection; it needs no inbound public port.

1. As its service user, run `install -d -m 0700 /srv/codock/ssh`, then `ssh-keygen -t ed25519 -f /srv/codock/ssh/tunnel_ed25519`. Unattended startup needs non-interactive unlocking; an empty passphrase requires the restrictions below.
2. Create a non-sudo `workbench-tunnel` user on the gateway. Its `.ssh` is 0700 and `authorized_keys` 0600, owned by that user. Add only the public key with prefix `restrict,port-forwarding,permitlisten="127.0.0.1:18790"`; never copy the private key.
3. Adapt the [sshd restrictions](../deploy/sshd-tunnel.conf.example). Keep an admin SSH connection open; validate with `sshd -t` and `sshd -T -C user=workbench-tunnel,host=localhost,addr=WORKSTATION_IP` before reload. `MaxSessions 0` forbids shell/session channels while permitting the specified forwarding. [OpenSSH reference](https://man.openbsd.org/sshd_config)
4. Verify the gateway host key over a trusted channel; place it in `/srv/codock/ssh/known_hosts` on the workstation. Do not disable strict checking; `ssh-keyscan` alone does not establish trust.
5. Adapt user, paths and `GATEWAY_HOST` in the [tunnel unit](../deploy/tunnel.service.example); install it on the workstation as `/etc/systemd/system/codock-tunnel.service`, verify, daemon-reload and enable it. One tunnel per forwarded port.
6. On the gateway, verify `curl --fail -H 'Host: terminal.example.com' http://127.0.0.1:18790/api/bootstrap` before connecting Nginx. Also verify the tunnel user cannot run remote `id` or forward other ports.

Rollback stops only the new services and revokes their keys/OAuth/virtual host. Preserve existing projects and tmux; never use a global `kill-server`.

</details>
