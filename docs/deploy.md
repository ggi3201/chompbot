# Deploying Chomp to a New Machine

> **TODO:** Build a `chomp deploy` CLI that automates this (rsync data, verify env, health-check services, run smoke test).

## Prerequisites

On the target machine, install:

- **Node.js 22.x** (via nvm, fnm, or direct install)
- **pnpm 10.26.2** — `corepack enable && corepack prepare pnpm@10.26.2 --activate`
- **Redis 7+** — `docker run -d --name redis -p 127.0.0.1:6379:6379 redis:7-alpine` or native install
- **Ollama** — https://ollama.com/download
- **ripgrep** — `brew install ripgrep` (macOS) or equivalent
- **Xcode CLI tools** (macOS) — `xcode-select --install` (needed for `better-sqlite3`, `bcrypt`)

## Steps

### 1. Clone the repo

```bash
git clone <repo-url> ~/code/chomp
cd ~/code/chomp
pnpm install
```

### 2. Copy data from the old machine

```bash
# From the OLD machine:
rsync -avz data/ new-host:~/code/chomp/data/
rsync -avz .env new-host:~/code/chomp/.env
```

The `data/` directory contains:
- `chomp.db` — all state (conversations, memories, settings, encrypted secrets)
- `uploads/` — user-uploaded images

**Critical:** The `.env` must keep the same `JWT_SECRET` (and `ENCRYPTION_KEY` if set). This key encrypts all secrets in the DB. Changing it makes them unreadable.

### 3. Pull the Ollama embedding model (optional)

```bash
ollama pull nomic-embed-text
```

### 4. Install and authenticate Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude  # run once interactively to authenticate
```

MCP servers, skills, and plugins will auto-sync on API startup — no need to copy `~/.claude.json`.

### 5. Update env vars if needed

Check `.env` for anything host-specific:

| Variable | Why you might change it |
|---|---|
| `OLLAMA_HOST` | If Ollama runs on a different host/port |
| `REDIS_URL` | If Redis runs on a different host/port |
| `SEARXNG_URL` | Set to your SearXNG instance URL |
| `CHOMP_DOMAIN` | If exposing publicly on a new domain |
| `CHOMP_FRONTEND_URL` | If frontend URL changed |

See [local configuration](configuration.md) for optional host-specific defaults.

### 6. Start

```bash
# Dev mode (all packages in parallel)
pnpm dev

# Or production via systemd — see step 6b
```

### 6b. (Optional) Native systemd unit

Run it under systemd: copy the example unit and edit it for your user/paths. The real `chomp.service` is gitignored because it contains host-specific values.

```bash
# From the repo root:
sudo cp chomp.service.example /etc/systemd/system/chomp.service
sudoedit /etc/systemd/system/chomp.service     # replace YOUR_USER + paths
sudo systemctl daemon-reload
sudo systemctl enable --now chomp
```

The unit sets `KillMode=process` on purpose: agents are spawned detached, so `systemctl stop` should only signal the API process — not nuke every claude child in the cgroup. If you skip this, deploys will kill in-flight agent runs with exit 143.

When updating the unit on an already-running install:

```bash
sudo cp chomp.service.example /etc/systemd/system/chomp.service
# re-apply your local edits (or maintain a private copy)
sudo systemctl daemon-reload
# restart only when you actually want the API to bounce
sudo systemctl restart chomp
```

### 7. Verify

- API health: `curl http://localhost:3001/api/health`
- Web UI: open `http://localhost:5173`
- Telegram: send a message to your bot — should respond
- Agent dispatch: send a chat message that triggers Claude Code

## Post-migration

- **Google OAuth:** If your domain changed, update the authorized redirect URI in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) to `{CHOMP_DOMAIN}/api/google/callback`
- **Telegram:** No changes needed — the bot token is portable
- **Cron:** Not used — all scheduling is in-process (proactive engine, worker heartbeat)
- **systemd:** Optional, see step 6b. If used, the unit file is host-specific and gitignored — only `chomp.service.example` is tracked.

## Optional: Copy agent workspace

If there's in-progress agent work you want to preserve:

```bash
rsync -avz ~/chomp-work/ new-host:~/chomp-work/
```

## GitHub Actions deployment

The deploy workflow runs on pushes to `main` or an explicit manual dispatch. It
does not deploy pull requests. Verification runs in a throwaway container before
the workflow stops the service.

Set the repository Actions variable **`CHOMP_DEPLOY_DIR`** to the absolute path of
the production checkout on the self-hosted runner. Use Settings → Secrets and
variables → Actions → Variables. The checkout must already exist. The workflow
fails before stopping or starting the service if this variable is missing or
invalid. Keep its value private to your repository settings.

### Migration before merging configurable defaults

Before a future merge and deployment:

1. Set `CHOMP_DEPLOY_DIR` to your current production checkout path.
2. Add your existing preview domain, site Git author, Home Assistant entity IDs,
   optional cleanup repository list, phone calendar names/timezone,
   `SEC_USER_AGENT`, and `VITE_EMBED_ALLOWED_ORIGINS` to the production `.env`,
   using the names in [configuration.md](configuration.md). The embed allowlist
   uses exact iframe source origins and takes effect after a web rebuild. Keep
   the existing encryption and authentication secrets unchanged.
3. For future iOS builds, copy `packages/ios/Config.local.xcconfig.example` to
   `packages/ios/Config.local.xcconfig`, fill in your host and signing team, and
   regenerate the project with `xcodegen generate` from `packages/ios`.

Without these optional runtime values, the app uses neutral defaults, skips
location enrichment, and does not clean worktrees automatically. Existing iOS
settings remain saved on installed devices. No collaborator is invited to a new
site repository unless explicitly entered.

These are instructions for a future deployment. Preparing the PR does not change
production configuration, restart services, or deploy the app.
