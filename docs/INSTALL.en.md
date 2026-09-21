# Install and sign in

English · [简体中文](INSTALL.md)

Use the **Linux machine running Codex**. Requires Node.js 22+, tmux 3.4+ and Python 3; native dependencies may need a C/C++ compiler. The app and tmux must run as the same non-root user.

## 1. Install

Replace `REPOSITORY_URL` with the repository's HTTPS clone URL; adapt the destination:

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

Existing session: run `tmux display-message -p '#{socket_path}'` inside it to find the socket. For a new environment:

```sh
tmux -S /srv/codock/tmux/default.sock new-session -s dev -c /srv/codock/projects
```

Start your installed, authenticated Codex there. Press `Ctrl+B`, release, then `D` to detach without ending the session. Do not recreate an existing session.

## 2. Configure

Edit `config.json`; never commit it:

| Field           | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| `origin`        | Your HTTPS origin, without a path; obtain the tunnel URL first for a free trial        |
| `previewSuffix` | `preview.your-domain`; for free trials keep the example value and do not bind previews |
| `socket`        | Actual absolute tmux socket path                                                       |
| `projectRoot`   | Project parent, e.g. `/srv/codock/projects`                                            |
| `allowed`       | Approved session names, e.g. `["dev"]`                                                 |
| `codexHome`     | This user's actual Codex history directory, usually `.codex` under their home          |
| `authMode`      | `github` or `local`, as below                                                          |

Leave other defaults initially. Main and preview origins must be distinct but share the same registrable domain; merely comparing the last two labels is insufficient. See [usage](USAGE.en.md) for appearance and previews.

## 3. Choose authentication

**GitHub:** Settings → Developer settings → OAuth Apps → New OAuth App. Homepage is `origin`; callback is `origin/auth/github/callback`. Do not enable wildcard callbacks or Device Flow. Get your `login` and numeric `id` from `https://api.github.com/users/YOUR_LOGIN`, put them in `githubOwner`, then run `npm run setup:github` and enter Client ID/secret at the hidden prompts. Example ID `0` intentionally fails validation. No repository scope is needed; the workstation needs access to GitHub. [Official steps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

**Password + TOTP:** set `authMode: "local"`, run `npm run setup`, choose a 16–256 character password and enroll the secret in an authenticator. Verify the code and store the secret securely. Modes are mutually exclusive; failures never trigger fallback.

## 4. Verify startup

```sh
npm run check
npm start
```

In another terminal, substitute your origin hostname:

```sh
curl --fail --show-error -H 'Host: terminal.example.com' http://127.0.0.1:8790/api/bootstrap
```

Expect JSON with `authenticated: false` before login. Fix failed checks; do not bypass them with root. Return to [free access](FREE-TRYOUT.en.md) or [deployment](DEPLOYMENT.en.md). Restart after configuration changes.
