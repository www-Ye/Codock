# Try a free HTTPS address

English · [简体中文](FREE-TRYOUT.md)

Already have a Linux machine running Codex? A free tunnel provides an HTTPS entrypoint without another server or domain. Hardware, electricity and Codex usage are not included. **These single-address options support chat and terminal, not isolated HTML previews.**

## Quickest: Cloudflare Quick Tunnel

1. Follow [installation](INSTALL.en.md) on the workstation; do not start the app yet.
2. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) and run:

   ```sh
   cloudflared tunnel --url http://127.0.0.1:8790
   ```

3. Copy the generated HTTPS URL into `config.json` as `origin`. Set `authMode: "local"`. Keep the example `previewSuffix` and do not bind previews.
4. Complete password + TOTP setup, then `npm run check` and `npm start`. Keep both processes running and open the generated URL on your phone.

A 502 before app startup is expected. If an existing cloudflared configuration conflicts, use an isolated test environment rather than overwriting it. A new tunnel may get a new address: update `origin` and restart. GitHub authentication also requires updating its callback, so local authentication is simpler for trials.

Quick Tunnels have no availability guarantee, a 200 concurrent-request limit and no SSE support; Codock uses HTTP polling and WebSockets. The preview tab remains visible but is unavailable in this setup. Never disable authentication or expose port 8790 publicly. [Official limits](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

## More persistent: Tailscale Funnel

Install Tailscale on the workstation, sign in, enable Funnel and run `tailscale funnel 8790`. Use its generated HTTPS URL as `origin`; installation and authentication are otherwise unchanged. The device/tailnet address remains more bookmark-friendly while those names and settings remain unchanged. It is a provider subdomain, not a domain you own.

Funnel currently supports the free plan, subject to plan eligibility and limits. **Visitors do not need a Tailscale client.** Do not confuse public Funnel with private Serve. This single-address route also lacks Codock's isolated preview domains. [Official documentation](https://tailscale.com/docs/features/tailscale-funnel)

Test Wi-Fi and cellular access yourself; neither route guarantees cross-border performance. This repository has not acceptance-tested these live third-party entrypoints. For your own stable address and full previews, use [standard deployment](DEPLOYMENT.en.md).
