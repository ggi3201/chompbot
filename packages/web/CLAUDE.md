# @chomp/web

React 19 SPA with the Graphite theme. Vite 6 bundler. Tailwind v4 (migration from inline styles in progress).

For repo-wide rules (commands, testing, code quality, declarative-first principles), see [`.claude/CLAUDE.md`](../../.claude/CLAUDE.md) at the repo root. This file is the *web-specific* layer: design system, primitives, page patterns, gotchas.

## Commands

```bash
pnpm dev        # Vite dev server :5173 (proxies /api → :3001)
pnpm build      # Production build (tsc + vite build) — use this to verify changes
```

Vitest is the testing standard for the monorepo (see `.claude/CLAUDE.md`). When this package gets its first test, mirror the API setup: `vitest.config.ts` + `test/` co-located with `src/`.

## Theme: Graphite

Steady, technical, a little warm: a home server at night. Neutral graphite surfaces, one ember accent, no glass. Tokens live in `src/styles/global.css` via Tailwind v4 `@theme`.

**Key values**

- Surfaces: `bg-surface` (#141415 page), `bg-surface-alt` (#0f0f10 sidebar), `bg-glass` (#19191b card — old name kept), `bg-raised` (#232325 active row, input)
- Borders: `border-border` hairline (text color at 8%). Depth comes from surface steps, not shadows or blur
- Text: `text-text-primary`, `text-text-secondary`, `text-text-muted`. No `text-white/NN`
- Accent: `bg-accent` / `text-accent-ink` (ember #f2a33a) only for the primary action, selection and live state. `text-on-accent` on top of it
- Live state: `AgentOrb` for the turn as a whole, `LiveDot` from `components/ui` for single items running now
- Type: Geist for everything, Geist Mono (`font-mono`) for times, counts and meta. Weights 400/500, 600 at most. Sentence case, no uppercase tracked labels
- Icons: lucide, 16px, `strokeWidth={1.5}`, color of the text role
- Motion: `transition-colors` or `transition-[transform,opacity]`, never `transition-all`. No looping pulses on things that are not live

**Rule:** keep chrome quiet. No gradients, glows, blur, emoji or purple. Color belongs to content (charts, canvas widgets, soul colors).

## Reusable primitives (`components/ui/`)

| Component | Usage |
|---|---|
| `Button` | `variant="primary\|ghost\|danger\|outline"`, `size="sm\|md"` |
| `GlassCard` | Card surface with a hairline (name kept from the glass era). `hover` prop for interactive cards |
| `Input` | `as="input\|textarea\|select"` — polymorphic form input |
| `Badge` | Inline mono code/status badge |
| `LiveDot` | Amber status LED for anything running now |
| `AgentOrb` | `thinking-orbs` orb for an agent at work. `state` from `orbStateFor`, `size` 20, 32 or 64 |
| `IconButton` | 32px ghost button for one icon; `tone="danger"` stays muted until hover |
| `ChoicePills` | Row of mono options; the selected one steps up a surface, not the accent |
| `PageHeader` | `title` + optional `action` (typically a Button) |

Import via the barrel: `import { Button, GlassCard } from "../components/ui"`.

**When adding a primitive:** keep it presentational, prop-typed with `keyof typeof variants` patterns (see `Button.tsx`), no data fetching. If it needs data, it's a feature component — put it next to the page that uses it.

## Page patterns

- **CRUD pages** (Agents, Skills, Memories, Schedules, Triggers, ProactiveRules, Services, Plugins): `PageHeader` + `CrudTable` + `FormModal`, data via `useCrud<T>(endpoint)`. Add a new CRUD page in ~50 lines by following any existing one.
- **Custom pages:** Dashboard (stat cards, 24h chart, real data), Chat (WebSocket, streaming), AgentMonitor (active sessions), Settings (multi-section form), Login (Framer Motion entry), Webhooks (custom card layout), McpServers (live status polling).

## Routing

`App.tsx` wraps authenticated routes in `Layout` (sidebar + content). Routes are inline — no separate config file. Add a route there.

## Hooks

- `useAuth` — JWT auth state, login/logout
- `useChat` — WebSocket connection, message streaming, `stopResponse()`
- `useCrud<T>(endpoint)` — generic CRUD (items, loading, error, create, update, remove, refresh)
- `useIsMobile` — viewport breakpoint

**New page that needs data → new hook.** Don't inline `fetch` in the component — that's the imperative escape hatch `.claude/CLAUDE.md` warns against.

## Declarative-first reminders (web specifics)

The principles in `.claude/CLAUDE.md` apply here, with these concrete tells:

- **Effects are not for state synchronisation.** If you're writing `useEffect(() => setX(deriveFrom(y)), [y])`, derive `x` directly during render.
- **Lists are data.** Don't manually `appendChild`. Map state to JSX.
- **Refs are for what React can't express.** Native `<dialog>` (FormModal), focus, scroll position, third-party canvas. That's it.
- **Tailwind variants in typed objects.** Pattern: `const variants = { … } as const; type Variant = keyof typeof variants`. No string concatenation of class names from arbitrary input.
- **Streaming UI** (chat) is the one place imperative-feeling code is OK — but isolate it inside `useChat`. Components below it should still be pure functions of state.

## Gotchas

- **`FormModal` uses native `<dialog>`** with `showModal()` / `close()`. Don't replace with a div-based modal — accessibility and focus-trap are free with `<dialog>`.
- **`JsonEditor` keeps inline styles** — Prism.js highlight theme is applied via string replacement; Tailwind can't reach it.
- **`Markdown` keeps `customStyle`** — required by `react-syntax-highlighter`.
- **Framer Motion `animate` props** in Login/App require style objects, not className.
- **SVG charts** use Tailwind `fill-*` / `stroke-*` utilities with theme colors; gradient stops still need raw values.
- **Pre-existing TS errors in `useChat.ts`** (lines 30-31): `useRef` calls without an initial argument. Known, unrelated to your change.
