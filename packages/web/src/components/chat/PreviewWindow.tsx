import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Crosshair, Globe, Monitor, RotateCw, Smartphone, SquareArrowOutDownLeft, SquareArrowOutUpRight, SquareTerminal, Tablet, X } from "lucide-react";
import type { ChatItem, PreviewElement, PreviewState } from "@chomp/shared";
import { usePreviewStream } from "../../hooks/usePreviewStream";
import { Button, IconButton, LiveDot } from "../ui";
import PaneFrame, { type PaneMode } from "../PaneFrame";
import { latestPreview, previewWindowCalls, type PreviewRect } from "../../lib/preview";
import { copyStyles, documentPip, pipKind, toggleVideoPip } from "../../lib/pip";
import PreviewScreen from "./PreviewScreen";
import PreviewOutput from "./PreviewOutput";

const CLOSED_KEY = "chomp.preview.closed";
const APPLIED_KEY = "chomp.preview.applied";
const KEPT_IDS = 50;
// shortcut: a call older than this is history, not a request, so an old chat does not replay it. Fine while agents act on the chat they are in.
const FRESH_MS = 10 * 60_000;
const DOCK_WIDTH_KEY = "chomp.preview.dockWidth";

function readIds(key: string): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function keepIds(key: string, ids: string[]): string[] {
  const kept = ids.slice(-KEPT_IDS);
  window.localStorage.setItem(key, JSON.stringify(kept));
  return kept;
}

export type PreviewAsk = "pop_out" | "browser_tab";

/**
 * Whether the chat's preview pane is open. A new preview_start call opens it; closing it sticks for that call, across reloads.
 * A chat with no preview can still open the pane, to start a server or ask the agent for one.
 * The agent's preview_window calls open, close and arrange it, each once on this device.
 */
export function usePreview(items: ChatItem[], conversationId: string | undefined) {
  const [closed, setClosed] = useState(() => readIds(CLOSED_KEY));
  const [emptyOpenIn, setEmptyOpenIn] = useState<string | null>(null);
  const [modeRequest, setModeRequest] = useState<{ id: string; mode: PaneMode } | null>(null);
  const [ask, setAsk] = useState<PreviewAsk | null>(null);
  const latest = latestPreview(items);
  const chat = conversationId ?? "new";
  const open = latest ? !closed.includes(latest.itemId) : emptyOpenIn === chat;

  const setOpen = (next: boolean) => {
    if (!latest) return setEmptyOpenIn(next ? chat : null);
    setClosed((current) => keepIds(CLOSED_KEY, next ? current.filter((id) => id !== latest.itemId) : [...current.filter((id) => id !== latest.itemId), latest.itemId]));
  };

  const calls = previewWindowCalls(items);
  const newest = calls.at(-1)?.itemId;
  useEffect(() => {
    const applied = readIds(APPLIED_KEY);
    const fresh = calls.filter((c) => !applied.includes(c.itemId) && Date.now() - Date.parse(c.createdAt) < FRESH_MS);
    if (!fresh.length) return;
    keepIds(APPLIED_KEY, [...applied, ...fresh.map((c) => c.itemId)]);
    for (const { itemId, view } of fresh) {
      setOpen(view !== "close");
      if (view === "close") setAsk(null);
      else if (view === "pop_out" || view === "browser_tab") setAsk(view);
      else if (view !== "open") setModeRequest({ id: itemId, mode: view });
    }
    // Runs once per new call; the rest is read fresh from the items.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest]);

  const toggle = () => {
    // A closed pane forgets what the agent asked, so opening it again starts as the user left it.
    if (open) {
      setModeRequest(null);
      setAsk(null);
    }
    setOpen(!open);
  };

  return { open, toggle, modeRequest, ask, clearAsk: () => setAsk(null) };
}

function defaultRect(): PreviewRect {
  const width = Math.min(480, window.innerWidth - 24);
  const height = Math.min(420, Math.round(window.innerHeight * 0.5));
  // Below the top bars, which on a phone hold the button that reopens this window.
  return { x: window.innerWidth - width - 12, y: 104, width, height };
}

const POP_OUT_LABELS = {
  window: "Pop out into its own window",
  video: "Watch in picture in picture",
  back: "Back to the chat",
} as const;

const PRESETS = [
  { id: "desktop", label: "Fill the pane", Icon: Monitor },
  { id: "tablet", label: "Tablet, 768 by 1024", Icon: Tablet },
  { id: "mobile", label: "Phone, 375 by 812", Icon: Smartphone },
] as const;

/** Address bar text: what the user types while editing, the page's URL otherwise. */
function AddressBar({ url, loading, disabled, onGo }: { url: string; loading: boolean; disabled: boolean; onGo: (url: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <form
      className="flex-1 min-w-0 flex items-center gap-2 h-8 px-2 rounded-md bg-raised"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft?.trim()) onGo(draft);
        (e.currentTarget.elements.namedItem("address") as HTMLInputElement).blur();
      }}
    >
      {loading && <LiveDot />}
      <input
        name="address"
        aria-label="Address"
        placeholder="URL or port"
        disabled={disabled}
        value={draft ?? url}
        onFocus={(e) => {
          setDraft(url);
          e.currentTarget.select();
        }}
        onBlur={() => setDraft(null)}
        onChange={(e) => setDraft(e.target.value)}
        className="flex-1 min-w-0 bg-transparent border-none outline-none font-mono text-xs text-text-secondary focus:text-text-primary"
      />
    </form>
  );
}

function EmptyPage({ state, conversationId, connected, asked, canAsk, onAsk, onStart, onOpen }: {
  state: PreviewState | null;
  conversationId: string | undefined;
  connected: boolean;
  asked: boolean;
  canAsk: boolean;
  onAsk: () => void;
  onStart: (name: string) => void;
  onOpen: (url: string) => void;
}) {
  const configs = state?.configs ?? [];
  const starting = new Set(state?.servers.filter((s) => s.status === "starting").map((s) => s.name));
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
      {asked ? (
        <p className="m-0 text-[13px] text-text-secondary">Asked the agent. The page opens here when its server is up.</p>
      ) : (
        <p className="m-0 text-[13px] text-text-secondary">{conversationId ? "No page open in this chat." : "No preview yet."}</p>
      )}
      {state?.closedBecause && <p className="m-0 max-w-sm text-[13px] text-text-muted">{state.closedBecause}</p>}
      {configs.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {configs.map((c, i) => (
            <Button key={c.name} variant={i === 0 ? "primary" : "ghost"} size="sm" disabled={!connected || starting.has(c.name)} onClick={() => onStart(c.name)}>
              {starting.has(c.name) ? `Starting ${c.name}…` : `Start ${c.name}`}
              <span className="font-mono text-xs opacity-70">:{c.port}</span>
            </Button>
          ))}
        </div>
      )}
      {state?.lastUrl && (
        <Button variant="outline" size="sm" disabled={!connected} onClick={() => onOpen(state.lastUrl!)}>
          Reopen {state.lastUrl.replace(/^https?:\/\//, "")}
        </Button>
      )}
      {!asked && (
        <Button variant={configs.length ? "outline" : "primary"} size="sm" disabled={!canAsk} onClick={onAsk}>
          Ask the agent to start one
        </Button>
      )}
      {state?.configError && <p className="m-0 max-w-sm text-[13px] text-error">{state.configError}</p>}
    </div>
  );
}

/** The chat's live page on the host, which the agent drives and the user watches and uses. */
export default function PreviewWindow({ conversationId, isMobile, canAsk, onAsk, onClose, onMark, modeRequest, ask: agentAsk, onAskDone }: {
  conversationId: string | undefined;
  /** How the agent last asked the pane to sit: docked, floating or full screen. */
  modeRequest: { id: string; mode: PaneMode } | null;
  /** A pop-out or a browser tab the agent asked for, which needs the user's tap. */
  ask: PreviewAsk | null;
  onAskDone: () => void;
  isMobile: boolean;
  canAsk: boolean;
  onAsk: () => void;
  onClose: () => void;
  /** Something the user pointed at in the page and what they said about it, for the next message. */
  onMark: (mark: { url: string; element: PreviewElement; comment: string }) => void;
}) {
  const [asked, setAsked] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [popOutError, setPopOutError] = useState<string | null>(null);
  const frame = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = usePreviewStream(conversationId);
  const { state, connected, send } = stream;
  const page = state?.page ?? null;
  const serverLive = state?.servers.some((s) => s.status !== "exited") ?? false;
  // The page's console, or servers to start or follow; with none of them the panel would be empty.
  const hasOutput = !!page || !!state?.configs.length || !!state?.servers.length || !!state?.configError;

  // The popped-out window belongs to this pane: closing the pane closes it.
  useEffect(() => () => pipWindow?.close(), [pipWindow]);
  // Docking, floating or full screen happen in the tab, so the popped-out window gives the pane back.
  useEffect(() => {
    if (modeRequest) pipWindow?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeRequest?.id]);

  // Closing the window, by this button or its own, brings the pane back to the tab as it was.
  const popOut = async () => {
    setPopOutError(null);
    if (pipWindow) return pipWindow.close();
    try {
      if (!documentPip) return video.current && (await toggleVideoPip(video.current));
      const win = await documentPip.requestWindow({ width: frame.current?.offsetWidth ?? 480, height: frame.current?.offsetHeight ?? 640 });
      copyStyles(document, win.document);
      win.addEventListener("pagehide", () => setPipWindow(null), { once: true });
      setPipWindow(win);
    } catch {
      // Embedded browsers, such as an app's web view, have the API but no window to give.
      setPopOutError("This browser cannot open a picture-in-picture window here. Float the preview over the chat instead.");
    }
  };
  const error = popOutError ?? stream.error;
  const ask = () => {
    setAsked(true);
    onAsk();
  };
  const live = connected && !!conversationId;

  return (
    <PaneFrame
      label="Preview"
      isMobile={isMobile}
      initialMode={isMobile ? "floating" : "docked"}
      modeRequest={modeRequest}
      dockWidthKey={DOCK_WIDTH_KEY}
      initialRect={defaultRect}
      escapeExitsFull
      ownWindow={pipWindow}
      frameRef={frame}
      onClose={onClose}
      title={
        <span className="min-w-0 text-[13px] text-text-secondary truncate" title={page?.title || undefined}>
          {page?.title || "Preview"}
        </span>
      }
      actions={
        <>
          {hasOutput && (
            <IconButton tooltip="end" label="Console and server output" aria-pressed={outputOpen} onClick={() => setOutputOpen((v) => !v)} className={outputOpen ? "!bg-raised text-text-primary" : ""}>
              <span className="relative inline-flex">
                <SquareTerminal size={14} strokeWidth={1.5} />
                {serverLive && <span className="absolute -right-1 -top-1"><LiveDot /></span>}
              </span>
            </IconButton>
          )}
          {page && pipKind && (
            <IconButton tooltip="end" label={POP_OUT_LABELS[pipWindow ? "back" : pipKind]} onClick={() => void popOut()}>
              {pipWindow ? <SquareArrowOutDownLeft size={14} strokeWidth={1.5} /> : <SquareArrowOutUpRight size={14} strokeWidth={1.5} />}
            </IconButton>
          )}
          {page && (
            <IconButton tooltip="end" label="Open in a browser tab" onClick={stream.openInNewTab}><Globe size={14} strokeWidth={1.5} /></IconButton>
          )}
        </>
      }
    >
      <div className="flex items-center gap-1 px-2 h-11 border-b border-border shrink-0">
        <IconButton tooltip="start" label="Back" disabled={!page?.canGoBack} onClick={() => send({ type: "history", action: "back" })}><ArrowLeft size={14} strokeWidth={1.5} /></IconButton>
        <IconButton tooltip="start" label="Forward" disabled={!page?.canGoForward} onClick={() => send({ type: "history", action: "forward" })}><ArrowRight size={14} strokeWidth={1.5} /></IconButton>
        <IconButton tooltip="start" label="Reload" disabled={!page} onClick={() => send({ type: "history", action: "reload" })}><RotateCw size={14} strokeWidth={1.5} /></IconButton>
        <AddressBar url={page?.url ?? ""} loading={!!page?.loading} disabled={!live} onGo={(url) => send({ type: "navigate", url })} />
        {page && (
          <IconButton tooltip="end" label="Point at something to comment on it" aria-pressed={picking} disabled={!live} onClick={() => setPicking((v) => !v)} className={picking ? "!bg-accent !text-on-accent" : ""}>
            <Crosshair size={14} strokeWidth={1.5} />
          </IconButton>
        )}
        {/* A phone's window is already phone-sized, and its address bar needs the room. */}
        {page &&
          !isMobile &&
          PRESETS.map(({ id, label, Icon }) => (
            <IconButton tooltip="end" key={id} label={label} aria-pressed={page.viewport.preset === id} onClick={() => send({ type: "preset", preset: id })} className={page.viewport.preset === id ? "!bg-raised text-text-primary" : ""}>
              <Icon size={14} strokeWidth={1.5} />
            </IconButton>
          ))}
      </div>
      {page && agentAsk && !(agentAsk === "pop_out" && pipWindow) && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <p className="flex-1 m-0 text-[13px] text-text-secondary">
            {agentAsk === "browser_tab" ? "The agent wants to open this page in a browser tab." : pipKind ? "The agent wants to pop this page out." : "The agent wants to pop this page out, but this browser cannot."}
          </p>
          {(agentAsk === "browser_tab" || pipKind) && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (agentAsk === "browser_tab") stream.openInNewTab();
                else void popOut();
                onAskDone();
              }}
            >
              {agentAsk === "browser_tab" ? "Open tab" : "Pop out"}
            </Button>
          )}
          <IconButton label="Dismiss" onClick={onAskDone}>
            <X size={14} strokeWidth={1.5} />
          </IconButton>
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-start gap-2 px-3 py-2 border-b border-border shrink-0">
          <p className="flex-1 m-0 text-[13px] text-error whitespace-pre-wrap max-h-24 overflow-auto">{error}</p>
          <IconButton
            label="Dismiss"
            onClick={() => {
              setPopOutError(null);
              stream.dismissError();
            }}
          >
            <X size={14} strokeWidth={1.5} />
          </IconButton>
        </div>
      )}
      {page ? (
        <PreviewScreen
          send={send}
          onFrame={stream.onFrame}
          agentMark={stream.agentMark}
          touchDevice={window.matchMedia("(pointer: coarse)").matches}
          video={video}
          picking={picking}
          inspect={stream.inspect}
          onMark={(element, comment) => onMark({ url: page.url, element, comment })}
          onPickDone={() => setPicking(false)}
        />
      ) : (
        <EmptyPage
          state={state}
          conversationId={conversationId}
          connected={live}
          asked={asked}
          canAsk={canAsk}
          onAsk={ask}
          onStart={(name) => send({ type: "start", name })}
          onOpen={(url) => send({ type: "navigate", url })}
        />
      )}
      {outputOpen && hasOutput && state && <PreviewOutput state={state} logs={stream.logs} connected={live} send={send} />}
    </PaneFrame>
  );
}
