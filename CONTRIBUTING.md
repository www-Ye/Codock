# Development

English · [简体中文](CONTRIBUTING.zh-CN.md)

Keep one authentication layer, terminal executor and preview pipeline. Fix shared mechanisms instead of adding per-failure exceptions. Demo data must be synthetic.

## Test

Linux, Node.js 22+, tmux 3.4+, Python 3, FFmpeg and Chromium. Native dependencies may require a compiler.

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

Install missing browser system libraries as instructed by Playwright, or set `DESK_CHROMIUM` to an existing executable. Use a short checkout path to avoid Chromium's Unix socket path limit. Fixtures use isolated sockets, synthetic history and mock OAuth—not production config or paid models. Artifacts stay in ignored `runtime/`.

Run `smoke` as a **non-root user**. It copies source into an isolated directory and tests the actual entrypoint, login, PTY input, preview grants and logout. It reuses installed dependencies; for a clean-install check, first run `npm ci --omit=dev` in a fresh checkout. It does not validate public DNS, TLS or live OAuth.

## Screenshots

`npm run screenshots` renders the real frontend against a fixture API, checks themes, mobile/desktop layout, denied storage, reduced motion and contrast, then updates `docs/assets/`. Inspect the output; synthetic tests are not public-network acceptance.

## Publish

`npm run format` formats source. `npm run lint` checks Git candidates and staged contents for syntax, local links and common sensitive patterns. Then review `git status --short` and `git diff --cached` before committing or pushing.

Do not publish runtime, real config, `.env`, browser profiles, keys or dependencies. No source archive is needed. Code is [MIT](LICENSE); preserve [third-party notices](NOTICE.md).
