# Security

English · [简体中文](SECURITY.zh-CN.md)

Codock is a remote terminal, **not a filesystem sandbox**. `projectRoot` limits previews, not shell access. Commands retain the original Linux user's filesystem and network permissions. The production entrypoint rejects root; that alone is not isolation.

## Protections

- One approved identity per instance: GitHub numeric ID or password + TOTP, rate limits, no automatic fallback.
- Exact Host/Origin checks, HTTPS, HttpOnly cookies, authenticated WebSockets.
- Separate preview origins, short-lived grants, sandboxed frames and static-path/symlink checks.
- Port previews disabled by default; owner-only local control socket.
- Read-only terminal by default, write leases and tmux identity checks; ambiguous input is never automatically replayed.
- Private configuration and runtime files excluded from source control.

## Limits

No multi-tenant RBAC, SSO, complete audit recording, automatic retention cleanup or HA cluster. Activity indicators infer TUI state; receipts do not promise distributed exactly-once delivery. No public network route is guaranteed without real-device testing.

Generated HTML can run JavaScript. Separate origin does not make it trusted: publish only dedicated display folders, never a project root or secrets. Port-preview WebSockets may perform writes; never approve administrative services. Path filters and secret scanners cannot recognize every sensitive value.

## Operations

Use a dedicated non-root user, tmux socket, Codex environment and instance. Avoid unnecessary sudo, Docker socket and shared secrets. Mutually untrusted users need additional VM/container and network isolation, not merely different ports.

Node listens on loopback. Keep runtime directories 0700 and credentials 0600. Receipts may contain message text: encrypt backups of `config.json` and `runtime/`; manage Codex history separately. GitHub tokens never reach the frontend or model. Login state is in memory and expires on restart.

To revoke access, stop the instance/tunnel or change the approved identity and restart; changing DNS is insufficient. See [deployment](docs/DEPLOYMENT.en.md) for TLS, proxy logs and acceptance checks.

## Publishing and reporting

Run `npm run lint`, then review `git diff --cached` and screenshots manually. Use only synthetic demo data; never force-add ignored runtime files. Report vulnerabilities through the repository's private reporting channel if enabled. Do not post credentials, cookies or URLs containing code/state/ticket publicly. Test only isolated instances you own.
