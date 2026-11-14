# Terminal

A real shell on the host, in the browser. Main menu → Server → **Terminal** opens shells in `~`. The terminal button in a chat's top bar opens a shell in that chat's folder (its worktree, else its project, else the agents' default folder), docked, floating or full screen.

## Three layers

```
 browser                          Chomp API                         host
┌──────────────────────┐  /ws/terminal  ┌─────────────┐  unix socket  ┌──────────────────────┐
│ rendering            │◀── binary ───▶│ transport   │◀── frames ──▶│ session (holder)     │
│ xterm.js + chrome    │    + JSON      │ auth, relay │               │ node-pty + headless  │
│ useTerminalSession   │                │ socket.ts   │               │ xterm mirror         │
└──────────────────────┘                └─────────────┘               └──────────────────────┘
```

**Session: `packages/api/src/terminal/holder.ts`.** One detached Node process per shell. It owns the PTY (node-pty) and a headless xterm that mirrors the screen. It listens on `<dir of DB_PATH>/terminals/<id>.sock` (mode 0700 folder). Because it is detached and the systemd unit uses `KillMode=process`, it outlives Chomp restarts and deploys. It ends when the shell exits, and then deletes its socket. A reboot kills it; the next listing removes the stale socket.

- Any number of connections attach at once. Each gets `attached`, then the serialized screen (scrollback, alternate screen and modes included), then live output. The snapshot waits for the mirror to parse everything before it, so nothing is lost or doubled.
- The latest connection to attach or resize sets the size (like tmux's `window-size latest`). Others get a `size` event and show the shell at that size, with a "Fit here" button.
- A connection more than 4 MB behind stops getting output. When its socket drains, it gets a fresh screen instead of the backlog.
- The shell gets a login environment (`HOME`, `USER`, `PATH`, `LANG` and a few more), never Chomp's own, so `JWT_SECRET` and `DB_PATH` do not leak. It also gets `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Chomp` and `CHOMP_TERMINAL_ID`.

**Wire: `packages/api/src/terminal/frames.ts`.** Holder frames are a kind byte, a u32 length and a payload: JSON control or raw bytes. `HOLDER_PROTOCOL` must go up on any change, because holders started before a deploy keep the old code. The relay refuses an old holder with close code 4005.

**Transport: `packages/api/src/terminal/socket.ts` and `routes/terminals.ts`.** `/ws/terminal?token&id&cols&rows` relays one browser tab to one holder: binary frames are keystrokes in and output out; JSON frames are `resize` and `ack`. The browser acks drawn bytes every 64 KB; past 2 MB unacked the relay pauses the holder socket. REST: `GET /api/terminals[?scope=home|chat&conversationId]`, `POST /api/terminals`, `DELETE /api/terminals/:id`.

- Access (`access.ts`): a valid JWT, an `Origin` equal to the `Host`, a loopback, LAN or tailnet peer, and no Cloudflare headers (a tunnel connects from loopback too).
- Close codes the browser does not retry: 4000 shell exited, 4001 bad token, 4003 not from here, 4004 no such terminal, 4005 old holder.
- Nothing logs keystrokes or output.

**Rendering: `packages/web/src`.**

- `lib/terminal/connection.ts`: the socket, reconnect with backoff, acks, and a reconnect at once when a phone comes back after 5 s in the background.
- `hooks/useTerminalSession.ts`: the one imperative island. It owns xterm.js and its addons (fit, WebGL on desktop, web links, Unicode 11, OSC 52 clipboard) and returns plain state and actions.
- `components/terminal/`: `TerminalView` (screen and overlays), `KeyBar` (phone keys with Ctrl and Alt latches), `TextSheet` (the buffer as selectable text, since iOS cannot select on a canvas), `TerminalPane` (the chat pane), `EndShellButton` (two presses).
- `components/PaneFrame.tsx`: dock, float and full screen for any chat side pane. The preview window still has its own copy; it can move to this.
- `pages/Terminal.tsx`: tabs for every shell, chat ones included; new tabs open in `~`. The URL `/terminal/<id>` names the shell, so the same link opens it on another device.
- `lib/terminal/theme.ts`: Graphite colors for xterm, Geist Mono, the ember cursor and selection.

## Where new features go

- **The shell tells the browser something** (marks, images, notifications, custom data): an OSC sequence. It passes from the PTY to the browser untouched. Handle it in `useTerminalSession` with `term.parser.registerOscHandler(<number>, …)`. To also know it on the host (for agents), register the same handler on the holder's headless mirror and add a `HolderEvent`.
- **The browser asks the host something** beyond keys and size: a new `TerminalClientMessage` (shared types), validated in `socket.ts`, and a new `HolderRequest` handled in `holder.ts`. Bump `HOLDER_PROTOCOL`.
- **A different program than a login shell** (a terminal that runs `claude`, `htop` or a REPL): `createTerminal` already takes `shell`; give the route a way to ask for it.
- **Agents reading or typing in a terminal:** an MCP tool that opens the holder with `openHolder`, sends input frames, and reads the mirror. The mirror is already a parsed screen.
- **Chrome** (search, split panes, themes, gestures): the web layer only. `TerminalView` takes a session, so several can sit side by side.

## Testing

`packages/api/test/terminal/` starts real holders with `/bin/sh` (frames, access rules, attach and replay, size, flood, exit, kill, the socket's auth and close codes). `packages/web/test/lib/terminal.test.ts` covers the key bar's bytes and tab names.

Headless Chromium with an emulated pixel ratio above 1 draws xterm's WebGL canvas at the wrong scale (xterm 5.5 too). This is the emulator, not the app. Check retina and phone rendering on a real device.
