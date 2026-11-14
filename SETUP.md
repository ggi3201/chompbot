# Setting up Chomp

This guide is written so that a person, or their coding agent (Claude Code, Codex),
can follow it from top to bottom. Every step ends with a command that shows whether
it worked. Do the steps in order, and stop at the first check that fails.

## What you are setting up

Chomp is a personal assistant for **one person on one machine**: a home server, a
mini PC or a laptop that stays on. One Node process serves the web app, the API and
the WebSocket chat on a single port. Each chat message runs as an agent turn in the
Claude Code or Codex CLI on that same machine, with the tools Chomp gives it.

**Chomp is built to be private.** The agents can run shell commands as the user
Chomp runs as, and the web app has a terminal and a file browser. The only lock is
one password. Keep it on your own network and reach it remotely over Tailscale. Read
[Reaching Chomp from your phone](#reaching-chomp-from-your-phone) before you put
it anywhere else.

## Tools

### Required

| Tool | Why | Check |
|---|---|---|
| Linux or macOS | Linux is what the author runs. macOS works with a few differences, see [macOS](#macos-mac-mini-and-similar). | `uname -a` |
| Node.js 22 or newer | Runs Chomp. The current LTS (26) is fine; the author runs 24. | `node -v` |
| pnpm 10, through corepack | The repo pins its pnpm version in `package.json`. `corepack enable` needs root when Node is installed system-wide; see step 1. Node 25 and newer no longer include corepack: install it with `npm install -g corepack` (macOS: `brew install corepack`). | `pnpm -v` |
| Build tools | `better-sqlite3` compiles when it installs. macOS: `xcode-select --install`. Linux: `build-essential` and `python3` (Debian/Ubuntu). | `xcode-select -p` or `g++ --version` |
| Claude Code CLI, logged in | Runs the agent turns. Chomp finds it with `which claude`. A Claude subscription is enough; no API key is needed. | `claude auth status` (exit code 0) and `claude -p "say ok"` |
| git | Worktrees per chat, project chats, site publishing. | `git --version` |

### Recommended

| Tool | What you get | Check |
|---|---|---|
| Tailscale | HTTPS access from your phone and laptop without opening anything to the internet. The browser only allows the microphone (voice chat) over HTTPS or on localhost. Set up in [Reaching Chomp from your phone](#reaching-chomp-from-your-phone). | `tailscale status` |
| Codex CLI, logged in | A second agent runtime you can pick per chat. Chomp registers its tools with Codex too when it is installed. | `codex --version` |
| GitHub CLI, logged in | **Needed for anything with GitHub:** project chats (Chomp lists and clones your repos to work in), the GitHub tools and issue rules, and publishing sites to a git repo. Chat works without it. Install it, then run `gh auth login` as the user Chomp runs as. | `gh auth status` |
| ripgrep | Fast search for agents and the file browser. | `rg --version` |
| jq | Used by several seeded skills. | `jq --version` |
| Chromium | The live preview panel. Install one with `pnpm --filter @chomp/api exec playwright-core install chromium`, or point `CHOMP_PREVIEW_CHROME` at an existing Chrome. | |
| ffmpeg | The voice note for the morning report. | `ffmpeg -version` |
| Ollama with only `nomic-embed-text` | Memory search by meaning, locally: about 30 ms per search, a 274 MB model that unloads itself when idle. You don't need any chat models. Without it, Chomp matches memories as plain text. Install Ollama, then `ollama pull nomic-embed-text`. | `ollama list` |

### Optional

| Tool | Only needed for |
|---|---|
| SearXNG | The `web_search` tool, at `SEARXNG_URL`. Claude Code and Codex have their own web search either way. |
| Redis 7 and the `worker` package | The old BullMQ worker (heartbeat, widget refresh tick). The API does not use Redis, and the author's install runs without the worker. `pnpm dev` starts it too, and works without Redis. |
| Docker | Optional: Redis, Ollama and SearXNG from `docker-compose.yml`, and the monitoring pages that read containers. |
| Home Assistant | Location and smart-home skills. |
| A Mac with Xcode and xcodegen | The iOS app in `packages/ios`. |
| cloudflared | A public route for inbound webhooks only. See below. |
| Traefik | Only if you already run it. See [Option: Traefik in front](#option-traefik-in-front). |

## 1. Install and build

```bash
git clone <repo-url> ~/code/chomp
cd ~/code/chomp
corepack enable    # Node 25+: npm install -g corepack first
                   # without root: corepack enable --install-directory ~/.local/bin
                   # and make sure ~/.local/bin is on your PATH
pnpm install --frozen-lockfile
pnpm build
```

Check: `ls packages/api/dist/index.js packages/web/dist/index.html` lists both files.

## 2. Configure

```bash
cp .env.example .env
sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env && rm .env.bak
```

- `JWT_SECRET` signs logins, and it also encrypts the API keys you save in Settings
  unless you set a separate `ENCRYPTION_KEY`. **If you change it later, every saved
  key stops working.** Set `ENCRYPTION_KEY` to its own random value now if you
  expect to rotate `JWT_SECRET`. Left empty, Chomp makes a random one on first start
  and keeps it in `data/.jwt-secret`; back that file up with the database.
- `DB_PATH` can stay `./data/chomp.db`. Back that file up: it holds your chats,
  memories, rules and encrypted keys.
- Everything specific to one installation (published site domain, Git author,
  Home Assistant entities, calendar names) is described in
  [`docs/configuration.md`](docs/configuration.md). Leave it at the defaults for now.

Check: `grep -c change-me .env` prints `0`.

## 3. Run it

For development, with hot reload:

```bash
pnpm dev    # API on PORT from .env (3001), web on :5173, which proxies /api to it
```

To run it the way the author does, start the built API alone. It reads the repo's
`.env`, keeps its data in `packages/api/data/`, and serves the built web app on the same
port (`PORT`, 3001 by default). It works from any folder:

```bash
node packages/api/dist/start.js
```

Check, from a second terminal:

```bash
curl -s http://127.0.0.1:3001/api/health        # {"status":"ok",...}
curl -s http://127.0.0.1:3001/api/auth/status   # {"isSetup":false} on a fresh install
```

At startup Chomp prints a health check box to its log: which CLIs are installed
and logged in, which services answer, which keys are set. A ✗ there for something you
haven't set up yet (Ollama, SearXNG, Kimi) is fine; use it as the list of what is left.

**Chomp changes your `~/.claude` at startup**, for the user it runs as:

- It writes each of its skills to `~/.claude/skills/<name>/SKILL.md`, marked
  `chomp-managed: true`, and deletes that file when you remove the skill in Chomp. A
  skill of yours with the same folder name gets overwritten, so check for clashes
  first: `ls ~/.claude/skills`.
- It imports the skills already in `~/.claude/skills` into its own list.
- It registers its MCP server, described below.

If you use Claude Code for other work as the same user, those sessions see Chomp's
skills and tools too. Run Chomp as its own user if you want them kept apart.

On startup Chomp registers itself as the `chomp-api` MCP server in Claude Code
(`claude mcp add -s user`) and in Codex, so its agents get Chomp's tools. Check with
`claude mcp list | grep chomp-api`. Set `CHOMP_SKIP_MCP_SYNC=1` for any second or
test instance, or it takes over that registration from your real one.

## 4. First login and onboarding

Open `http://localhost:3001` (or `:5173` with `pnpm dev`). The first visit asks you
to choose a password of at least 8 characters. Whoever opens it first sets that
password, so do this before you make Chomp reachable from other machines. Then open **Birthright** in the side
menu: a short interview that writes your assistant's personality, its "soul". It does
not start by itself. After that, send a
chat message such as "what can you do?". If the answer comes back, the agent
runtime works.

If the chat hangs or errors, the usual cause is Claude Code not being logged in for
the user Chomp runs as. Run `claude -p "say ok"` as that user.

## 5. Keep it running

On macOS, use launchd instead: see [macOS](#macos-mac-mini-and-similar).

Copy `chomp.service.example` to `/etc/systemd/system/chomp.service`, replace
`YOUR_USER` and the paths, then:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now chomp
systemctl status chomp --no-pager
```

Keep `KillMode=process`. Without it, every restart kills the agents that are
working at that moment.

## macOS (Mac mini and similar)

Chomp runs on macOS, but nobody has tested it there yet. Steps 1 to 4 are the same.
These parts differ:

**Tools.** With [Homebrew](https://brew.sh):

```bash
xcode-select --install    # build tools, if you don't have Xcode
brew install node corepack git gh ripgrep jq ffmpeg
gh auth login
```

Homebrew's `node` is the current LTS, and `corepack enable` needs no root there. For memory search, install the Ollama app from ollama.com, then
`ollama pull nomic-embed-text`.

**Never sleep.** A Mac mini that sleeps takes Chomp with it. In System Settings →
Energy, turn on "Prevent automatic sleeping when the display is off" and "Start up
automatically after a power failure". In Users & Groups, turn on automatic login, so
that Chomp (a per-user service) comes back after a reboot.

**Keep it running with launchd** instead of systemd. Save this as
`~/Library/LaunchAgents/com.chomp.api.plist`, with your own paths (`which node`,
`which claude`, and where you cloned the repo):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.chomp.api</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>dist/start.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/code/chomp/packages/api</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/YOU/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Like KillMode=process: a restart must not kill agents that are mid-turn. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/chomp.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/chomp.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.chomp.api.plist
launchctl print gui/$(id -u)/com.chomp.api | grep state     # state = running
curl -s http://127.0.0.1:3001/api/health                    # {"status":"ok",...}
```

Restart after a deploy with `launchctl kickstart -k gui/$(id -u)/com.chomp.api`. Stop it
with `launchctl bootout gui/$(id -u)/com.chomp.api`. The `PATH` line matters: launchd
starts with a bare PATH, and Chomp must find `claude`, `git` and `rg`.

**Tailscale.** Install the standalone Tailscale app from tailscale.com/download (not
the App Store version), and in its settings choose "Install CLI" so `tailscale` works
in the terminal. Then run `tailscale serve --bg 3001` as in the Tailscale section;
the operator step is not needed on macOS.

**What won't work on macOS:**

- Parts of the **Monitoring** page read Linux-only sources (`/proc`, `ss`,
  `systemctl`, `journalctl`): CPU, memory, temperature, open ports, service logs and
  restarts. Expect those to be empty or skipped. The rest of Chomp does not use them.
- **Codex chats** may fail to deliver replies when Codex starts Chomp's MCP bridge
  through a shell: the bridge finds its chat by walking the process tree through
  `/proc`. Claude chats are not affected. Use Claude as the agent runtime on macOS.

## Reaching Chomp from your phone

### Tailscale (recommended)

Tailscale puts the server, your phone and your laptop on a private network (a
"tailnet"). Chomp stays unreachable from the internet, and you still get a real
HTTPS address, which the browser needs for the microphone and "Add to Home Screen".

**Once, in the Tailscale admin console** (login.tailscale.com, the DNS page): turn on
**MagicDNS** and **HTTPS Certificates**. Without HTTPS Certificates, `tailscale serve`
cannot give you an `https://` address. The machine name then appears in public
certificate logs, so name the server something you don't mind being seen.

**On the server:**

```bash
curl -fsSL https://tailscale.com/install.sh | sh    # or your package manager
sudo tailscale up                                     # log in
sudo tailscale set --operator=$USER                   # the user Chomp runs as
tailscale serve --bg 3001                             # HTTPS on the tailnet -> Chomp
tailscale serve status                                # shows https://<machine>.<tailnet>.ts.net
```

`--bg` keeps the setting across reboots. Undo it with `tailscale serve reset`. The
operator setting lets Chomp itself run `tailscale serve` without sudo: the live
preview panel uses it to show a dev server on your phone, at the same address on
the dev server's port plus 40000 (5173 becomes 45173).

**On your phone and laptop:** install the Tailscale app, log in to the same account,
and open `https://<machine>.<tailnet>.ts.net`. The first visit can take a few
seconds while the certificate is issued. In the iPhone app, enter the same
`<machine>.<tailnet>.ts.net` as the server.

Check, from the laptop: `curl -s https://<machine>.<tailnet>.ts.net/api/health`
returns `{"status":"ok",...}`.

The terminal and file browser only open over the tailnet, the LAN or localhost. That
check works with `tailscale serve`, because Tailscale hands the requests to Chomp
from localhost.

**Never use `tailscale funnel`** for Chomp. Funnel publishes a port to the whole
internet, which is the public hosting described below.

### Option: Traefik in front

Skip this unless you already run Traefik for other services. `tailscale serve` does
the same job for Chomp with nothing extra to run.

The author's install uses Traefik so all their home services share one entry: a
router for the machine's `*.ts.net` name, with Tailscale's certificate (Traefik's
`tailscale` certificate resolver, which needs `/var/run/tailscale` mounted), and the
service pointing at Chomp's port. Two things to know:

- **Keep the router off the internet.** Behind Traefik every request reaches Chomp
  from Traefik's address, so the terminal's "tailnet or LAN only" check passes for
  anyone who can reach Traefik. Serve Chomp only on an entry point that listens on
  the tailnet, or add an IP allowlist for `100.64.0.0/10`. Traefik in Docker sees
  tailnet clients as the Docker bridge address, so test the allowlist from your
  phone before relying on it.
- **Monitoring reads Traefik's API** at `http://127.0.0.1:8081/api/http` to list your
  routes. Without Traefik that source shows as skipped, and nothing breaks.

### Public hosting: don't

Chomp was not designed to face the internet:

- One password protects everything, including agents that run any shell command.
  The login has no rate limit and no second factor, and tokens last 30 days, or a
  year with "stay logged in".
- The terminal checks where a connection comes from. Behind a reverse proxy on the
  same machine (Caddy, nginx, Traefik), every request seems to come from the proxy,
  so the check passes for everyone. Only a Cloudflare tunnel is recognised (by its
  headers) and refused.
- Uploaded files (`/api/uploads/...`) and artifacts are served to anyone who has
  the link, by design. They rely on unguessable file names.


### If you need inbound webhooks

GitHub webhooks and similar services need a public URL. Expose
**only the webhook path**, never the whole app. With a Cloudflare tunnel:

```yaml
ingress:
  - hostname: webhooks.example.com
    path: /api/webhooks/receive/*
    service: http://localhost:3001
  - service: http_status:404
```

The Webhooks page shows its public URLs as `https://webhooks.example.com`. Set
`VITE_WEBHOOKS_ORIGIN` in `.env` to your public webhook address and rebuild the web app.

## Add-ons

Add each one when you want it. Keys go in **Settings**, under API keys or Custom
secrets, where they are stored encrypted in the database, not in `.env`.

| Add-on | What it needs |
|---|---|
| Telegram | A bot from @BotFather. Save its token as `TELEGRAM_API_KEY` in Settings or `.env`, and put your numeric Telegram user ID in `.env` as `TELEGRAM_OWNER_ID` (ask @userinfobot for it); without it the bot answers nobody. Restart, then send `/start` to the bot. |
| Gmail, Calendar, Drive | A Google Cloud OAuth client: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Then connect in Settings. |
| Voice chat | `OPENAI_API_KEY` for transcription and speech, and HTTPS (Tailscale). |
| Discord | A bot in your server: save `DISCORD_BOT_TOKEN`, and optionally `DISCORD_NOTIFICATION_CHANNEL_ID`, under Settings → Custom secrets. Only the account that owns the bot (in the Discord developer portal) can use it; to let someone else in, ask Chomp to add their Discord user ID to `discord_user_names`. |
| Home Assistant | `HOMEASSISTANT_URL` and `HOMEASSISTANT_TOKEN` in Settings, plus the entities in `.env` (see `docs/configuration.md`). |
| Stocks, news, football | `FINNHUB_API_KEY`, `NEWSAPI_KEY`, `FOOTBALL_DATA_KEY`. |
| Spotify | `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. |
| iPhone app | A Mac with Xcode and xcodegen, your own bundle ID and signing team. Put them in `packages/ios/Config.local.xcconfig` (copy `Config.local.xcconfig.example`); see "iOS build defaults" in `docs/configuration.md`. |
| Sites | Nothing: Chomp serves published sites at `<CHOMP_DOMAIN>/pub/<site>/`, so set `CHOMP_DOMAIN` to the address you open Chomp at (with Tailscale, your `https://<machine>.<tailnet>.ts.net`). They are as reachable as Chomp itself. For public sites, point your own web server (Traefik, Caddy, nginx) at `PREVIEW_SITES_DIR` and set `PREVIEW_DOMAIN`. |
| Other machines on Monitoring | Monitoring → Add a machine makes a token and shows the steps for the Linux or macOS host agent (`packages/api/scripts/host-agent/`). |

## What you won't have

A fresh install starts empty. The author's install has a lot that lives in their
data, not in this repo:

- **Skills.** Chomp seeds about 17 general skills (weather, GitHub, Gmail, calendar,
  memory "dream", ...). The author has many more in `~/.claude/skills` and in the
  database (meal planning, portfolio, home lab, travel). Ask your agent to write
  skills for your own needs, under `~/.claude/skills/<name>/SKILL.md`.
- **Memories.** Chomp learns them as you chat. Expect generic answers for the first days.
- **Maintenance rules.** Memory dream, memory review, skill review and a Tailscale key
  watch are seeded switched off. Ask Chomp what each needs, then switch them on under
  Automation → Proactive.
- **The morning brief rule.** It is seeded, but switched off on a fresh install, and
  it reads your home, team and habits from memories, so it gets better as Chomp learns them. Change it under Automation → Proactive, or delete it.
- **Other services** the author connected: Chewable Foodie (recipes), an iMessage
  bridge on a Mac, a Shortcuts signer, a home lab monitoring setup. The code is
  here; without the services those tools simply report that they are not set up.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Startup refuses to open the database | `CHOMP_ALLOW_PROD_DB=1` is missing. It is a guard so that tests never open a real database. |
| Chat never answers | `claude` not on the service's `PATH`, or not logged in for that user. |
| Saved keys suddenly invalid | `JWT_SECRET` or `ENCRYPTION_KEY` changed. |
| Agents have no Chomp tools | The MCP registration failed: check the startup log for `[mcp-sync]`, and `claude mcp list`. |
| `pnpm install` fails on `better-sqlite3` or `node-pty` | Missing build tools, or a Node version without prebuilt binaries. |
| Microphone does nothing on the phone | Not on HTTPS. Use the Tailscale address. |
