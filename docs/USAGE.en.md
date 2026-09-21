# Use and customize

English · [简体中文](USAGE.md)

## Continue a session

Sessions open in chat. Expand execution records or show conversation only. The sidebar supports recency ordering and pins; on mobile it collapses, with search on demand.

The composer forwards text and Enter to the original Codex terminal. It does not start another model: model, reasoning effort, tools, network access and quotas belong to that process. Website authentication is separate from Codex authentication.

Running/waiting/ready indicators infer current terminal cues, not a complete model event stream. Open the live controls for approvals, directional choices or interruptions; nothing is auto-approved. The terminal starts read-only; explicitly enable input to send keys. Scroll history separately from the live view.

For uncertain sends, inspect the terminal before retrying. Removing a failed receipt only clears the UI, not submitted input or Codex history. Browser dictation depends on permissions and recognition-service access; the phone keyboard's dictation is an alternative.

## Appearance

<img src="assets/appearance-mobile.png" width="320" alt="Mobile appearance settings: three palettes and four companions">

Choose Graphite, Midnight or Paper independently of Nailong, Duck, Cat or Robot. Preferences stay in this browser. Login and sidebar companions gently breathe, sway or float when idle; tap for a bigger gesture and a bubble. The chat-status companion is also tappable, with running/waiting hints. Bubbles disappear after 3.5 seconds, on outside tap or Escape. No automatic audio, model calls or terminal input. Companions can be hidden; motion respects `prefers-reduced-motion`.

Instance defaults go in `config.json`:

```json
{
  "brand": {
    "name": "Codock",
    "tagline": "Your Codex, anywhere.",
    "preset": "midnight",
    "mascot": true,
    "character": "nailong",
    "accent": null,
    "legalText": ""
  }
}
```

Merge this fragment into the full config. `preset`: `graphite`, `midnight`, `paper`; `character`: `nailong`, `duck`, `cat`, `robot`. `accent: null` follows the theme, or use `#RRGGBB`. Button text chooses black/white automatically; check link and status contrast yourself. Restart after changing defaults; saved browser preferences take precedence.

Layout is in `public/style.css`, palettes in `brand.css`, companion behavior in `theme.js`. Do not fork the frontend per theme. The interface is currently primarily Chinese; bilingual documentation is not full UI localization.

## HTML on your phone

Create a display-only subdirectory under `projectRoot`. Use relative resource URLs, not hardcoded localhost, which would refer to the phone itself. From the app directory:

```sh
node scripts/run.mjs preview --session dev --directory /srv/codock/projects/reports/demo --entry index.html
```

The backend must be running as the same Linux user. Success returns `ok: true` and a session URL; no restart or new DNS record. A different existing binding is not overwritten automatically: ask the owner first, then use settings. Never edit live binding files directly.

Copy the [sample page](../examples/workbench-page/index.html) into your display folder if useful. Media overlays are dismissible; use H.264 MP4 with yuv420p/faststart for mobile video and check the actual codec.

To automate handoff, add this to your project's `AGENTS.md`, adapting the path once:

```text
Present visual results as mobile-friendly HTML in a dedicated display folder, using relative assets.
Confirm the actual tmux session; never guess or overwrite another project's preview.
Run node /srv/codock/app/scripts/run.mjs preview --session <confirmed-session> --directory <display-folder> --entry index.html.
Check resources and interactions, then return the resulting URL. Never read credentials or copy cookies.
Successful binding does not establish real-device acceptance.
```

## Sessions and live apps

Create sessions in Linux, add names to `allowed` and restart. The web UI does not create or bulk-kill tmux sessions. Display labels can change without renaming tmux. Recreated sessions require explicit rebinding; old previews are not silently inherited.

Port previews default to disabled. Add only trusted ports to `previewPorts`, then bind in settings; binding does not start an app. This is not an arbitrary internal proxy: HTTP writes and complex login redirects may not work. WebSockets can perform writes, so never approve admin services, databases or Codock's own port.
