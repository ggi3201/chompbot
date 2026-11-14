# Chomp — Agent Guide

Personal AI assistant: chat UI, agent delegation (Claude Code), Telegram/Discord bots, proactive automation, semantic memory.

> **Audience:** Claude Code working in this repo. For human onboarding, infra, and deploy, read `README.md`, `SETUP.md`, and `docs/deploy.md`.

## Commands

```bash
# Dev (all packages, parallel)
pnpm dev

# Per-package dev
pnpm --filter @chomp/api    dev   # API on :3001 (tsx watch)
pnpm --filter @chomp/web    dev   # Web on :5173 (vite, proxies /api → :3001)
pnpm --filter @chomp/worker dev   # Cron + health worker (needs Redis)

# Build
pnpm build                                # All
pnpm --filter @chomp/web run build        # Web only

# Type-check
npx tsc --noEmit -p packages/api/tsconfig.json
npx tsc --noEmit -p packages/web/tsconfig.json

# Test (vitest — see Testing below)
pnpm test                                 # All packages
pnpm --filter @chomp/api test             # API only
pnpm --filter @chomp/api test:watch       # Watch mode
pnpm --filter @chomp/api test:coverage    # Coverage
```

**Package manager:** pnpm only. Never run `npm install` / `yarn` — they desync `pnpm-lock.yaml`.

## Repo Map

```
packages/
  api/      Express 5 + WebSocket, SQLite (Drizzle), agent dispatch, MCP bridge
  web/      React 19 SPA (Vite, Tailwind v4, Graphite theme)
  shared/   Cross-package types (ChompEvent, etc.)
  worker/   BullMQ scheduler + service health checks (needs Redis)

docs/       Plans, deploy notes
.claude/    Agent-facing docs (this file lives here)
data/       Runtime data — chomp.db, uploads/ (gitignored)
```

### packages/api/src — find things by feel

| If you're touching… | Go to |
|---|---|
| Routes / REST handlers | `routes/` (one file per resource, mounted under `/api/`) |
| DB schema or migrations | `db/schema.ts` (Drizzle), `db/migrate.ts` |
| Chat routing / dispatch | `chat/handler.ts`, `chat/websocket.ts`, `ollama/triage.ts` |
| Running agent turns (Claude, Codex) | `agents/dispatch.ts`, `agents/runtime/` |
| MCP tools (definitions, handlers, impls) | `mcp/tool-definitions.ts`, `mcp/tool-handlers.ts`, `agents/tools/<name>.ts` |
| Internal event bus | `events/bus.ts` |
| Proactive rule engine | `proactive/engine.ts` |
| Encrypted secrets | `lib/secrets.ts` (uses `lib/crypto.ts`) |
| Auth (JWT, login) | `auth/` |
| Telegram / Discord adapters | `telegram/`, `discord/` |
| The browser terminal (PTY holders, `/ws/terminal`) | `terminal/`, `routes/terminals.ts`, design in `docs/terminal.md` |
| Channels (web/telegram/discord routing) | `channels/` |
| Google integrations | `integrations/google/` |
| LLM helpers | `ollama/`, `research/`, `awareness/` |

### packages/web/src — find things by feel

| If you're touching… | Go to |
|---|---|
| A page | `pages/<Name>.tsx` (routed inline in `App.tsx`) |
| A reusable primitive | `components/ui/` (Button, GlassCard, Input, Badge, PageHeader) |
| Chat UI | `components/chat/` |
| Terminal UI (xterm.js) | `pages/Terminal.tsx`, `components/terminal/`, `hooks/useTerminalSession.ts` |
| Canvas widgets in chat | `components/canvas/` |
| Settings panels | `components/settings/` |
| Data fetching hook | `hooks/useCrud.ts` (generic), `hooks/useAuth.ts`, `hooks/useChat.ts` |
| API client | `lib/api.ts` (`apiFetch` — handles JWT) |
| Theme / design tokens | `styles/global.css` (Tailwind v4 `@theme`) |

See `packages/web/CLAUDE.md` for frontend-specific rules.

### Entry points

- **API:** `packages/api/src/start.ts` → `index.ts` (Express setup, route mounting, engine startup)
- **Web:** `packages/web/src/main.tsx` → `App.tsx` (router + auth gate)
- **Worker:** `packages/worker/src/index.ts`

## Architecture rules

- **TypeScript strict, ESM everywhere.** API imports use `.js` extensions (Node ESM requirement). Web doesn't.
- **DB:** SQLite via `better-sqlite3` + Drizzle. Schema in one file (`db/schema.ts`). Migrations auto-run on startup.
- **Auth:** JWT. Password set on first login. `auth/config.ts` and `lib/crypto.ts` are the only places allowed to read `process.env.JWT_SECRET` directly — they bootstrap the encryption layer.
- **Secrets:** Everything else uses `getSecret("KEY_NAME")` from `lib/secrets.ts`. Stored AES-256-GCM-encrypted in the `settings` table. `getSecret()` reads only that table, with no fallback to `process.env`: a key that is only in `.env` returns null. Telegram's `TELEGRAM_API_KEY` is the exception, as `telegram/bot.ts` falls back to `.env` itself.
- **Chat flow:** WebSocket `/ws` → `routeMessage` reads `@mentions` (no LLM) → direct reply (`@chat`) OR an agent turn via `agents/dispatch.ts`, on the Claude Agent SDK or Codex app server (`agents/runtime/`).
- **What agents are told:** `chomp-agent` protocol and generated `chomp-self` skill, both seeded from `src/seed.ts`. A new or changed capability belongs in `src/seed/chomp-self.ts`.
- **Events:** `events/bus.ts` exposes `emit()` / `on()`. The proactive engine subscribes for real-time rule evaluation; a 5-min timer sweep handles time-based rules.
- **MCP tools = 3 files.** Definition → handler → implementation. Pattern below.

## Claude runtime internals

Facts from raw Agent SDK probes; `agents/runtime/claude.ts` relies on them.

- **Every task end emits `task_notification`:** foreground and background agents, `TaskStop`, and an interrupt. An interrupt also stops background agents (status `stopped`), so Stop in chat ends them for good.
- **Resume with orphaned tasks:** the session first emits `task_notification` status `stopped` with no `tool_use_id`, then an empty `result` (`num_turns` 0, `origin.kind: "task-notification"`), and only then answers the queued prompt. The runtime ignores that result while a prompt is pending. A wake turn's result has the same origin, but real text and no pending prompt.
- **Wake turns:** when the session answers on the main thread with no turn running (a background task finished), `openWakeTurn()` opens a turn on the last request and `runtime/wake.ts` delivers it with `deliverAgentResult`. Messages with `parent_tool_use_id` never open one. Test: `test/agents/runtime-wake.test.ts`.
- **A subagent resumed by `SendMessage`** keeps its `task_id` and gets a new `tool_use_id`, used by `task_started` and `task_notification`, but its own tool calls still carry the first `tool_use_id` as `parent_tool_use_id`.
- **To check SDK behaviour** (hooks, message order), run a throwaway `query()` script with model haiku and `settingSources: []` from `packages/api`, where the SDK resolves.

## Adding an MCP tool

1. **`packages/api/src/mcp/tool-definitions.ts`** — append to `MCP_TOOLS`: name, description, JSON Schema for inputs. Set `requiresSession: true` if it needs chat session context.
2. **`packages/api/src/mcp/tool-handlers.ts`** — handler that dynamically imports the impl and wraps the result with `wrapExec()`.
3. **`packages/api/src/agents/tools/<name>.ts`** — `exec*` functions doing the actual work.

Conventions:

- Impls return plain strings. Failures: `"ERROR: ..."` prefix. `wrapExec()` converts to `{ content, isError }` MCP shape.
- Use `getSecret()` for keys/tokens.
- Use `googleFetch()` from `agents/tools/google-common.ts` for Google APIs (handles OAuth refresh).
- Keep dynamic `import()` in handlers — startup time matters.

Tools surface via two bridges:

- REST: `POST /api/mcp/tools/call` (web UI + internal callers)
- Stdio: `packages/api/src/mcp/bridge.mjs` (`claude mcp add`, used by spawned Claude Code agents)

## Code Quality Bar

**Elegance over cleverness, declarative over imperative, deletion over abstraction.**

- **Make the change small.** Touch what the task requires. No drive-by refactors, no hypothetical-future abstractions, no "while I'm here" rewrites.
- **Reuse before adding.** Before introducing a new helper, hook, util, or component, grep for one that already exists. The repo has `useCrud`, `apiFetch`, `getSecret`, `wrapExec`, `Button`, `GlassCard`, `Input`, `PageHeader` — use them.
- **Name things by what they are.** `apiFetch`, `getSecret`, `dispatchToAgent` — verbs and concrete nouns. No `manager`, `helper`, `utils`, `handler2`.
- **Boundaries:** validate inputs at system boundaries (HTTP, MCP, WS). Trust internal code. Don't add belt-and-braces validation between trusted layers.
- **No dead code.** No `// TODO` placeholders nobody will pick up, no commented-out blocks, no unused exports. Delete it; git remembers.
- **Comments are for *why*, not *what*.** Identifiers describe what. Comments only earn their keep when they explain a non-obvious constraint, invariant, or workaround.
- **Errors:** throw at the point of failure with a useful message. Don't swallow. Don't log-and-rethrow. The route layer / agent dispatcher catches and formats for the surface.
- **No nested ternaries.** One ternary is fine; nesting them is unreadable. For "first valid of N candidates" prefer `[a, b, c].find(isValid) ?? fallback`. For branching logic prefer early returns or a lookup object.

### Frontend (declarative React)

The frontend is the strictest about this. New code in `packages/web/` must be declarative.

- **State drives UI; UI never drives state.** No `ref.current` mutation, no DOM querying for state, no `useEffect` orchestration where derived state would do.
- **Compute, don't store.** If a value can be derived from props or state, derive it on render — don't mirror it into another `useState`.
- **`useEffect` is a code smell.** Use it for *external* synchronization only (subscriptions, network, focus, scroll). Never for chaining state updates, syncing two pieces of state, or "running on mount" what could be a render-time computation. If you reach for `useEffect`, ask whether an event handler or a derived value would do.
- **Compose primitives.** Build pages from `components/ui/*`. New page-level components only when they're reused or non-trivial. Don't reinvent `Button`.
- **Prefer Tailwind classes over inline styles.** Inline `style={}` is allowed where Tailwind can't reach (SVG paint attrs, Framer Motion `animate`, Prism token replacement) — see `packages/web/CLAUDE.md` Gotchas. Otherwise use the theme tokens in `styles/global.css`.
- **Lift state only as far as needed.** Co-locate by default.
- **Side effects out of render.** Async work goes in event handlers or hooks, never in the render body.

## Testing

**Vitest is the standard, in every package.** API is fully migrated. Web/worker are catching up.

- **Run:** `pnpm test` (all) · `pnpm --filter @chomp/api test:watch` · `pnpm --filter @chomp/api test:coverage`
- **Layout:** `packages/<pkg>/test/**/*.test.ts(x)` mirroring `src/`.
- **Config:** `packages/api/vitest.config.ts` — one file at a time (they share one SQLite file), 10s timeout, `clearMocks: true`, setup at `test/setup.ts`. Mirror this when adding vitest to `web` or `worker`.
- **No mocks for things you control.** API tests hit a real in-memory SQLite DB. Mock only at trust boundaries (HTTP to third parties, LLM calls, time/clock).
- **Critical paths first.** Auth, dispatch, MCP tool registry, proactive engine, channel routing, secrets crypto. Write a test before fixing a bug there.
- **Frontend tests** (when added): vitest + `@testing-library/react`, render through user-visible behavior (`getByRole`), never through implementation details.

**Done means tsc + build + vitest all green.** Type-check alone is not enough — see Lessons.

## Workflow expectations

- **Type-check before claiming done.** `npx tsc --noEmit` for both api and web.
- **Run vitest** on any package you touched.
- **Build the web** if you touched it: `pnpm --filter @chomp/web run build` (Vite catches a class of errors tsc doesn't).
- **`agents/dispatch.ts` paths surprise you.** A widget refresher / scheduled task that *spawns an agent* is hard to validate from types alone. Do one real end-to-end agent run before claiming it works. `result.response` is the agent's final text, which is the reply; the `reply` tool is only for messages mid-turn.

## Production (quick reference)

How the installation you are on runs prod is in its own setup: a systemd unit or launchd agent (see `SETUP.md`), its `.env`, and for the author's install a self-hosted GitHub Actions runner that deploys pushes to `main` (`.github/workflows/deploy.yml`, checkout path in the `CHOMP_DEPLOY_DIR` repository variable). Check before assuming any path or port; the code defaults to port 3002 when `.env` sets none.

**CRITICAL:** Never start prod with ad-hoc `nohup node …` from an unknown folder. `DB_PATH` decides which database opens; a wrong or missing one makes a fresh empty DB and the real data looks lost. Restart prod through its service manager.

## Environment

`.env` carries infrastructure and installation config. The full list is in [`docs/configuration.md`](../docs/configuration.md) and `.env.example`; the core:

| Var | Purpose |
|---|---|
| `JWT_SECRET` | JWT signing, and the encryption key for saved secrets unless `ENCRYPTION_KEY` is set |
| `PORT` | API port |
| `DB_PATH` | SQLite path |
| `CHOMP_ALLOW_PROD_DB` | Lets the server open a non-/tmp database |
| `REDIS_URL` | Only for the optional old worker |

All API keys (OpenAI, Gemini, Telegram, Google OAuth, …) go through the **Settings UI**, encrypted in SQLite. Read them via `getSecret("KEY_NAME")`, or `getApiKey()` for provider keys (which also falls back to the environment). Exceptions: `auth/config.ts` and `lib/crypto.ts` (bootstrap layer for `getSecret()` itself).

## Gotchas

- **A local API writes to your real home directory.** On startup it overwrites `~/.claude/skills`, re-points the `chomp-api` MCP in Claude and Codex at this checkout, and links skills into `~/.codex/skills`. Set `CHOMP_SKIP_MCP_SYNC=1` in `.env` for any test run.
- **Port 3001 conflicts:** API won't start if it's taken. Kill the existing process before retrying.
- **Agent sessions are in-memory.** Server restart leaves orphan `claude` child processes. `ps aux | grep claude` to spot them.
- **Web dev requires API running.** Vite proxies `/api` and `/ws` to the `PORT` in `.env`.
- **SQLite WAL.** DB at `data/chomp.db`. Delete to reset (migrations re-run on fresh DB).
- **Tailwind v4 migration in progress** — see `docs/plans/2026-02-26-tailwind-migration.md`. New code: pure Tailwind. Don't add inline styles unless `packages/web/CLAUDE.md` Gotchas explicitly allows it.
- **Don't `npm install`.** pnpm only. The lockfile + workspace protocol breaks otherwise.

## Lessons (don't relearn these)

- **Type-check is not "done" for agent paths.** Anything that spawns Claude Code via `dispatchToAgent` (widget refreshers, scheduled tasks) needs an end-to-end run before being declared shipped — too many emergent surprises in the spawn path.
- **`chat_messages` → `conversations` foreign keys do not cascade.** Delete a conversation's messages before the conversation.
- **`.env` `DB_PATH` is load-bearing.** Restart prod through its service manager, not by hand — see Production above.
