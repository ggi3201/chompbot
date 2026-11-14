import { lazy, Suspense, useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { AccessMode, AgentProvider, AgentSelection, ChatItem } from "@chomp/shared";
import { useChat, type Message } from "../hooks/useChat";
import { useIsMobile } from "../hooks/useIsMobile";
import { useAgentModels, useAgentSelection } from "../hooks/useAgentModels";
import type { SoulOption } from "../components/chat/SoulMenu";
import ProjectMenu from "../components/chat/ProjectMenu";
import { useUsageLimits } from "../components/chat/UsageMeter";
import ContextMeter, { useContextUsage } from "../components/chat/ContextMeter";
import ChatInfoPanel, { InfoDock, useConversationInfo } from "../components/chat/ChatInfoPanel";
import PreviewWindow, { usePreview } from "../components/chat/PreviewWindow";
import PreviewMarkChips from "../components/chat/PreviewMarkChips";
import HelpDialog from "../components/chat/HelpDialog";
import { marksMessage, type PreviewMark } from "../lib/preview";
// Lazy: its grammars and highlighting are only needed once the panel opens.
const FilesPanel = lazy(() => import("../components/chat/FilesPanel"));
// xterm is large, so the terminal loads the first time it opens.
const TerminalPane = lazy(() => import("../components/terminal/TerminalPane"));
import { HANDOFF_COMMAND, parseHandoff } from "../lib/handoff";
import { useCrud } from "../hooks/useCrud";
import { useDraft } from "../hooks/useDraft";
import { readChatPrefill } from "../lib/chat-prefill";
import { writeStoredSelection } from "../lib/agent-selection";
import { apiFetch } from "../lib/api";
import {
  fileToBase64,
  placeholderForUploads,
  uploadAttachment,
  type PendingAttachment,
  type UploadedAttachment,
} from "../lib/attachments";
import ChatSidebar, { type Conversation } from "../components/ChatSidebar";
import { AgentOrb, Button } from "../components/ui";
import ChatAutocomplete, { type AutocompleteItem } from "../components/ChatAutocomplete";
import { AppWindow, ArrowDown, ArrowUp, CircleHelp, MessageCircle, MapPin, PanelRight, RefreshCw, Plus, Square, FolderTree, Terminal } from "lucide-react";
import { VoiceButton, stripMarkdown } from "../components/VoiceControls";
import { useVoiceMode } from "../hooks/useVoiceMode";
import { VoiceBeam } from "voice-glow";
import ResearchProgress from "../components/ResearchProgress";
import SaveWidgetModal from "../components/SaveWidgetModal";
import MessageList from "../components/chat/MessageList";
import { CanvasActionProvider } from "../components/canvas/CanvasActionContext";
import AttachmentPreview from "../components/chat/AttachmentPreview";
import ModelPicker, { selectionLabel } from "../components/chat/ModelPicker";
import { orbStateFor } from "../lib/agent-orb";
import { liveTurnId, pinnedTodos, type DiffLine } from "../lib/chat-timeline";
import { TodoListCard } from "../components/chat/AgentItems";
import { formatElapsed, formatTimeAgo } from "../lib/format";
import { diffComment, quoteBlock, stepPrompt } from "../lib/prompt-history";

interface ChatCompletionsData {
  commands: Array<{ trigger: string; label: string; description: string }>;
  agents: Array<{ name: string; type: string; shorthands: string[] }>;
}

type WebLocationState = "timezone-only" | "locating" | "shared" | "blocked";

// Told to the agent with a spoken message. iOS sends the same line (VoiceChat.spokenContext).
const SPOKEN_CONTEXT = "The user said this aloud in voice mode and may hear your reply read out: answer in one to three short spoken sentences, no lists, tables or markdown, and offer more only if they ask.";
// Round composer buttons, thumb-sized on phones.
const ROUND = "shrink-0 flex items-center justify-center w-10 h-10 md:w-8 md:h-8 rounded-full border border-white/12 backdrop-blur-md";
const WEB_CHANNEL_CONTEXT_KEY = "chomp:web-channel-context";
const HIDE_PROACTIVE_CHATS_KEY = "chomp:hide-proactive-chats";
const CONVERSATION_PAGE_SIZE = 100;
const MESSAGE_PAGE_SIZE = 200;
const PREFETCH_TTL_MS = 10_000;


function buildTimezoneOnlyContext(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return `Web UI timezone: ${timezone}`;
}

function buildWebChannelContext(position?: GeolocationPosition): string {
  const parts = [buildTimezoneOnlyContext()];
  if (!position) return parts.join("\n");

  parts.push(
    `Browser geolocation: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`,
  );
  parts.push(`Accuracy: about ${Math.round(position.coords.accuracy)}m`);
  parts.push(`Captured at: ${new Date(position.timestamp).toISOString()}`);
  return parts.join("\n");
}

async function loadConversationMessages(id: string, before?: string): Promise<{ messages: Message[]; hasMore: boolean }> {
  const params = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE) });
  if (before) params.set("before", before);
  const res = await apiFetch(`/conversations/${id}/messages?${params.toString()}`);
  if (!res.ok) return { messages: [], hasMore: false };
  return {
    messages: await res.json() as Message[],
    hasMore: res.headers.get("X-Has-More") === "true",
  };
}

// --- Loading states ---

const ShimmerBar = memo(function ShimmerBar({ status, latestItem, agentElapsed, activity, onStop }: { status?: string | null; latestItem?: ChatItem; agentElapsed?: number; activity?: string | null; onStop?: () => void }) {
  let label = "Writing";
  if (status === "triaging" || status === "routing") label = "Routing";
  else if (status === "agent_working") {
    label = agentElapsed ? `Agent working ${formatElapsed(agentElapsed)}` : "Agent working";
  }

  return (
    <div className="flex items-center gap-3">
      <AgentOrb state={orbStateFor(status, latestItem)} size={32} />
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="flex items-center gap-3 font-mono text-xs text-text-secondary">
          {label}
          {onStop && (
            <Button type="button" variant="outline" size="sm" onClick={onStop} className="!h-6 !px-2 !text-xs">
              Stop
            </Button>
          )}
        </div>
        {activity && <span className="font-mono text-xs text-text-muted truncate">{activity}</span>}
      </div>
    </div>
  );
});

const CONTEXT_HINT_PERCENT = 80;
const INFO_PANEL_KEY = "chomp:info-panel";

/**
 * A turn that ends while the tab is in the background marks the tab title,
 * so a long task can be left running; the mark clears when the tab is seen.
 */
function useDoneSignal(turnActive: boolean) {
  const wasActive = useRef(turnActive);
  useEffect(() => {
    const ended = wasActive.current && !turnActive;
    wasActive.current = turnActive;
    if (!ended || document.visibilityState === "visible" || document.title.startsWith("● ")) return;
    const title = document.title;
    document.title = `● ${title}`;
    function handleVisible() {
      if (document.visibilityState !== "visible") return;
      document.title = title;
      document.removeEventListener("visibilitychange", handleVisible);
    }
    document.addEventListener("visibilitychange", handleVisible);
  }, [turnActive]);
}

const LOCATION_TITLES = {
  shared: "Location shared with Chomp. Click to update it",
  locating: "Finding your location",
  blocked: "Location blocked by the browser",
  off: "Share your browser location with Chomp",
} as const;

const CHAT_MENTIONS = 6;
const START_PREVIEW_PROMPT = "Start this project's dev server with preview_start and open it in the preview. Write .claude/launch.json first if it is missing.";

export default function Chat() {
  const {
    messages,
    items,
    answerApproval,
    hurry,
    sendMessage,
    stopResponse,
    answerQuestion,
    pendingQuestion,
    isConnected,
    isWaiting,
    waitStatus,
    agentElapsed,
    agentActivity,
    researchPlan,
    conversationId,
    switchConversation,
    prependMessages,
    reconcileConversation,
    newConversation,
    handoffNote,
    clearHandoffNote,
  } = useChat();

  const navigate = useNavigate();
  const location = useLocation();
  const { conversationId: urlConversationId } = useParams<{ conversationId: string }>();

  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // On a reload the URL names the chat before its messages load; use it so the draft shows at once.
  const [input, setInput, setDraftFor] = useDraft(conversationId ?? urlConversationId);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [isLoadingOlderConversations, setIsLoadingOlderConversations] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hideProactiveChats, setHideProactiveChats] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(HIDE_PROACTIVE_CHATS_KEY) !== "false";
  });
  const [saveWidgetTarget, setSaveWidgetTarget] = useState<{ messageId: string; defaultTitle: string } | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  // What the user pointed at in the preview, for the next message of the chat they pointed in.
  const [storedMarks, setStoredMarks] = useState<{ chat: string | undefined; marks: PreviewMark[] }>({ chat: undefined, marks: [] });
  const nextMarkId = useRef(1);
  const [isUploading, setIsUploading] = useState(false);
  const [isNearMessageBottom, setIsNearMessageBottom] = useState(true);
  const isSubmittingRef = useRef(false);
  const [webChannelContext, setWebChannelContext] = useState(() => {
    if (typeof window === "undefined") return buildTimezoneOnlyContext();
    return window.localStorage.getItem(WEB_CHANNEL_CONTEXT_KEY) || buildTimezoneOnlyContext();
  });
  const [voiceProblem, setVoiceProblem] = useState<string | null>(null);
  const [locationState, setLocationState] = useState<WebLocationState>(() => {
    if (typeof window === "undefined") return "timezone-only";
    return window.localStorage.getItem(WEB_CHANNEL_CONTEXT_KEY) ? "shared" : "timezone-only";
  });
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevConversationIdRef = useRef<string | undefined>(undefined);
  const urlLoadedRef = useRef(false);

  // Autocomplete state
  const [completionsData, setCompletionsData] = useState<ChatCompletionsData | null>(null);
  const [acItems, setAcItems] = useState<AutocompleteItem[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [acPrefix, setAcPrefix] = useState<{ type: "command" | "agent"; start: number } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const agentProviders = useAgentModels();
  const { selection, select: selectAgent, selectForNewChat } = useAgentSelection(conversationId, agentProviders);
  const { items: souls } = useCrud<SoulOption>("/souls");
  // A soul deleted since it was picked falls back to the default.
  const soulId = souls.some((s) => s.id === selection?.soulId) ? selection?.soulId : undefined;
  const usage = useUsageLimits(isWaiting || waitStatus !== null);
  const isTurnActive = isWaiting || waitStatus !== null;

  // Hands-free voice: each pause sends what was said, and talking on while the agent
  // works adds to the running task. With "Speak replies aloud" on, the reply is read out.
  // "Speak replies when I talk", from Settings or a long press on the mic.
  const [spokenReplies, setSpokenReplies] = useState(false);
  const speakReplies = useRef(false);
  const voiceName = useRef<string | null>(null);
  useEffect(() => {
    apiFetch("/settings")
      .then((res) => (res.ok ? (res.json() as Promise<Record<string, string>>) : {}))
      .then((settings: Record<string, string>) => {
        speakReplies.current = settings.voice_auto_speak === "true";
        setSpokenReplies(speakReplies.current);
        voiceName.current = settings.voice_tts_voice ?? null;
      })
      .catch(() => {});
  }, []);
  function toggleSpokenReplies() {
    const next = !speakReplies.current;
    speakReplies.current = next;
    setSpokenReplies(next);
    navigator.vibrate?.(15);
    void apiFetch("/settings/voice_auto_speak", { method: "PUT", body: JSON.stringify({ value: next ? "true" : "false" }) });
  }
  /** Where the replies to the current spoken question start in messages; null when none is pending. */
  const voiceReplyFrom = useRef<number | null>(null);
  const voice = useVoiceMode(
    (text, draft) => {
      if (draft) {
        setInput((prev) => (prev ? `${prev} ${text}` : text));
        textareaRef.current?.focus();
        return;
      }
      voiceReplyFrom.current ??= messages.length;
      // Sent as is: the box may not have redrawn yet. While a turn runs this adds to it.
      void handleSubmit(undefined, false, input.trim() ? `${input.trim()} ${text}` : text);
    },
    setVoiceProblem,
    // 2 s: at 1.3 s it sent while people were still finding the end of a sentence.
    { delivery: "", keepListening: true, pauseMs: 2000, rate: 1.15, speakReplies: () => speakReplies.current },
  );
  const { beginReply, feed, endReply, disable: voiceOff } = voice;
  // Voice belongs to the chat it was started in: opening another one turns it off,
  // so nothing there is read out. A new chat getting its id from its first message stays on.
  const voiceChatId = useRef(conversationId);
  useEffect(() => {
    const previous = voiceChatId.current;
    voiceChatId.current = conversationId;
    if (previous === undefined || previous === conversationId) return;
    voiceReplyFrom.current = null;
    voiceOff();
  }, [conversationId, voiceOff]);
  useEffect(() => {
    const from = voiceReplyFrom.current;
    if (from === null || isTurnActive) return;
    const replies = messages.slice(from).filter((m) => m.role === "assistant" && !m.isStreaming);
    if (replies.length === 0) return;
    voiceReplyFrom.current = null;
    beginReply();
    feed(`${replies.map((m) => stripMarkdown(m.content)).join("\n")}\n`);
    endReply();
  }, [isTurnActive, messages, beginReply, feed, endReply]);
  const playbackLevel = useMemo(() => {
    const analyser = voice.playbackAnalyser;
    if (!analyser) return 0;
    const wave = new Float32Array(analyser.fftSize);
    return () => {
      analyser.getFloatTimeDomainData(wave);
      return Math.min(1, 4 * Math.sqrt(wave.reduce((sum, v) => sum + v * v, 0) / wave.length));
    };
  }, [voice.playbackAnalyser]);
  function toggleVoice() {
    if (voice.phase === "speaking") return voice.tap();
    if (voice.phase !== "off") return voice.finish();
    setVoiceProblem(null);
    void voice.enable(); // first, inside the tap: browsers only open the mic and audio there
    voice.tune({ speaker: voiceName.current, hold: false });
  }
  const liveTurn = liveTurnId(items, isTurnActive);
  const todos = pinnedTodos(items, isTurnActive);
  const contextUsage = useContextUsage(conversationId, isTurnActive);
  // Info panel: a column on desktop that stays open across reloads, a sheet on a phone.
  const [infoPanelOpen, setInfoPanelOpen] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(INFO_PANEL_KEY) === "open");
  const [infoSheetOpen, setInfoSheetOpen] = useState(false);
  const toggleInfoPanel = () => {
    setInfoPanelOpen((open) => {
      window.localStorage.setItem(INFO_PANEL_KEY, open ? "closed" : "open");
      return !open;
    });
  };
  const preview = usePreview(items, conversationId);
  const [filesOpen, setFilesOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const infoVisible = !!conversationId && (isMobile ? infoSheetOpen : infoPanelOpen);
  const conversationInfo = useConversationInfo(conversationId, infoVisible, isTurnActive);
  const sessionModelLabel = useCallback((provider: AgentProvider, model: string | null) => {
    const engine = agentProviders.find((p) => p.provider === provider);
    return engine?.models.find((m) => m.id === model)?.label ?? model ?? (provider === "claude" ? "Claude" : "Codex");
  }, [agentProviders]);
  // The chat a handoff came from, until the new chat's first message records it.
  const handoffParentRef = useRef<string | null>(null);
  // The project picked for a new chat; the server keeps it from the first message on.
  const [newChatProject, setNewChatProject] = useState<string | undefined>();
  const [newChatWorktree, setNewChatWorktree] = useState(true);
  const currentConversation = conversations.find((c) => c.id === conversationId);
  // A chat that is not in the list yet is the one this composer just started.
  const projectPath = currentConversation ? currentConversation.projectPath ?? undefined : newChatProject;
  useDoneSignal(isTurnActive);
  // Mid-turn with something typed, Stop and Send now need the room the meters take.
  const previewMarks = storedMarks.chat === conversationId ? storedMarks.marks : [];
  const hasPending = pendingAttachments.length > 0 || previewMarks.length > 0;
  const showsSendNow = isTurnActive && !pendingQuestion && (input.trim() !== "" || hasPending);
  const addPreviewMark = (mark: Omit<PreviewMark, "id">) =>
    setStoredMarks((stored) => ({ chat: conversationId, marks: [...(stored.chat === conversationId ? stored.marks : []), { ...mark, id: nextMarkId.current++ }] }));
  const removePreviewMark = (id: number) => setStoredMarks((stored) => ({ ...stored, marks: stored.marks.filter((m) => m.id !== id) }));
  const selectedModelLabel = agentProviders
    .find((p) => p.provider === selection?.provider)
    ?.models.find((m) => m.id === selection?.model)?.label;
  // What each chat's pending /handoff opens the new chat on.
  const handoffTargets = useRef(new Map<string, Partial<AgentSelection>>());

  // Everything a chat message carries besides its text. Keyed on primitives so
  // the memoized MessageList keeps its handlers between keystrokes.
  const sendOptions = useMemo(() => ({
    ...(selection
      ? {
          provider: selection.provider,
          model: selection.model,
          ...(selection.effort ? { effort: selection.effort } : {}),
          fast: !!selection.fast,
          access: selection.access,
          ...(soulId ? { soulId } : {}),
        }
      : {}),
    channelContext: webChannelContext,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [selection?.provider, selection?.model, selection?.effort, selection?.fast, selection?.access, soulId, webChannelContext]);

  // Fetch completions data once
  useEffect(() => {
    apiFetch("/chat/completions")
      .then((r) => r.ok ? r.json() : null)
      .then((d: ChatCompletionsData | null) => {
        if (!d) return;
        setCompletionsData(d);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timezoneOnly = buildTimezoneOnlyContext();
    setWebChannelContext((prev) => {
      if (prev.includes("Browser geolocation:")) return prev;
      return timezoneOnly;
    });
    if (locationState === "timezone-only") {
      window.localStorage.removeItem(WEB_CHANNEL_CONTEXT_KEY);
    }
  }, [locationState]);

  const updateMessageScrollState = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsNearMessageBottom(distanceFromBottom < 96);
  }, []);

  // When the keyboard (or anything) makes the list shorter, keep its bottom in place instead of hiding it behind the composer.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const fromBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    let distance = fromBottom();
    const remember = () => { distance = fromBottom(); };
    const observer = new ResizeObserver(() => {
      el.scrollTop = el.scrollHeight - el.clientHeight - distance;
    });
    el.addEventListener("scroll", remember, { passive: true });
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", remember);
      observer.disconnect();
    };
  }, []);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Stable handlers so the memoized MessageList doesn't re-render on every keystroke.
  const handleRunNotificationAction = useCallback((prompt: string) => {
    sendMessage(prompt, undefined, sendOptions);
  }, [sendMessage, sendOptions]);

  // Implementing a plan leaves plan mode: the next turns may change things.
  const handleImplementPlan = useCallback((access: Extract<AccessMode, "auto-edits" | "full">) => {
    if (selection) selectAgent({ ...selection, access });
    sendMessage("Implement the plan.", undefined, { ...sendOptions, access });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendMessage, sendOptions, selection?.provider, selection?.model, selection?.effort, selection?.fast]);

  // Fork: a new chat with everything up to this reply; it keeps this chat's model and soul.
  // A prompt link (/chat?prompt=...) or router state ({ prompt }, from a page that hands off to a new chat)
  // fills the composer once and leaves the URL clean, so a reload does not refill it.
  const focusAfterPrefill = useRef(false);
  useEffect(() => {
    const prompt = new URLSearchParams(location.search).get("prompt") ?? readChatPrefill(location.state);
    if (!prompt) return;
    setInput(prompt);
    focusAfterPrefill.current = true;
    navigate(location.pathname, { replace: true });
  }, [location.search, location.state, location.pathname, navigate, setInput]);

  // The composer is disabled until the socket connects, so focus waits for it. The caret goes to the end, where the question is typed.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!focusAfterPrefill.current || !isConnected || !ta) return;
    focusAfterPrefill.current = false;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.scrollTop = ta.scrollHeight;
  }, [isConnected, input]);

  // The command palette's "New chat" / "Ask Chomp" while a chat is open. An event, not a URL,
  // so it runs outside a render commit like the sidebar button (the URL sync effect would snap back).
  useEffect(() => {
    const onNew = (e: Event) => {
      handleNewChat();
      const prompt = (e as CustomEvent<string | undefined>).detail;
      if (prompt) setDraftFor(undefined, prompt);
    };
    window.addEventListener("chomp:new-chat", onNew);
    return () => window.removeEventListener("chomp:new-chat", onNew);
  });

  // The path is relative to the folder the chat's agents work in, so the agent can open it as written.
  const addFileToChat = (path: string) => {
    setInput((prev) => `${prev}${prev && !/\s$/.test(prev) ? " " : ""}\`${path}\` `);
    if (isMobile) setFilesOpen(false);
    textareaRef.current?.focus();
  };

  const handleQuote = useCallback((text: string) => {
    setInput((prev) => `${prev.trim() ? `${prev.trimEnd()}\n\n` : ""}${quoteBlock(text)}`);
    textareaRef.current?.focus();
  }, [setInput]);

  const handleDiffComment = (path: string, line: DiffLine, note: string) => {
    setInput((prev) => `${prev.trim() ? `${prev.trimEnd()}\n\n` : ""}${diffComment(path, line, note)}`);
    if (isMobile) setInfoSheetOpen(false);
    textareaRef.current?.focus();
  };

  const handleFork = useCallback(async (messageId: string) => {
    if (!conversationId) return;
    const res = await apiFetch(`/conversations/${conversationId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId }),
    });
    if (!res.ok) return;
    const { id } = (await res.json()) as { id: string };
    if (selection) writeStoredSelection(id, selection);
    // Open it the way the sidebar does: the page follows its own conversation, not the URL.
    const { messages: msgs, hasMore } = await loadConversationMessages(id);
    switchConversation(id, msgs);
    setHasOlderMessages(hasMore);
    navigate(`/chat/${id}`, { replace: true });
    loadConversations();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, selection?.provider, selection?.model, selection?.effort, selection?.fast, selection?.access, selection?.soulId]);

  const handleSaveWidget = useCallback((messageId: string, defaultTitle: string) => {
    setSaveWidgetTarget({ messageId, defaultTitle });
  }, []);

  // The handoff note is written: open a new chat on the chosen model with the note in its composer.
  useEffect(() => {
    if (!handoffNote) return;
    clearHandoffNote();
    const target = handoffTargets.current.get(handoffNote.conversationId);
    if (!target) return;
    handoffTargets.current.delete(handoffNote.conversationId);
    selectForNewChat(target);
    // The new chat carries on the same work, so it starts in the same repo.
    setNewChatProject(conversations.find((c) => c.id === handoffNote.conversationId)?.projectPath ?? undefined);
    setDraftFor(undefined, handoffNote.content);
    handoffParentRef.current = handoffNote.conversationId;
    newConversation();
    setHasOlderMessages(false);
    navigate("/chat", { replace: true });
    requestAnimationFrame(() => textareaRef.current?.focus());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffNote]);

  const startPreview = () => sendMessage(START_PREVIEW_PROMPT, undefined, {
    ...sendOptions,
    ...(!conversationId && newChatProject ? { projectPath: newChatProject, worktree: newChatWorktree } : {}),
  });
  const compactChat = useCallback(() => sendMessage("/compact", undefined, sendOptions), [sendMessage, sendOptions]);

  const startHandoff = useCallback(() => {
    setInput(`${HANDOFF_COMMAND} `);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }, [setInput]);

  // Keep the view pinned only while the user is already near the bottom.
  // Streaming responses mutate text every token; smooth-scrolling each token causes visible jitter.
  useEffect(() => {
    if (!isNearMessageBottom) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollMessagesToBottom("auto");
    });
  }, [messages, items, isWaiting, isNearMessageBottom, scrollMessagesToBottom]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  // Load conversations list
  const loadConversations = useCallback(async () => {
    try {
      const res = await apiFetch(`/conversations?hideProactive=${hideProactiveChats}&limit=${CONVERSATION_PAGE_SIZE}`);
      if (res.ok) {
        setConversations(await res.json());
        setHasMoreConversations(res.headers.get("X-Has-More") === "true");
      }
    } catch {
      // ignore
    }
  }, [hideProactiveChats]);

  const loadOlderConversations = useCallback(async () => {
    if (isLoadingOlderConversations || !hasMoreConversations) return;
    setIsLoadingOlderConversations(true);
    try {
      const res = await apiFetch(`/conversations?hideProactive=${hideProactiveChats}&limit=${CONVERSATION_PAGE_SIZE}&offset=${conversations.length}`);
      if (!res.ok) return;
      const older = await res.json() as Conversation[];
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...older.filter((c) => !seen.has(c.id))];
      });
      setHasMoreConversations(res.headers.get("X-Has-More") === "true");
    } finally {
      setIsLoadingOlderConversations(false);
    }
  }, [conversations.length, hasMoreConversations, hideProactiveChats, isLoadingOlderConversations]);

  // Re-pull the current conversation's messages (and the list) from the server.
  const handleRefreshChat = useCallback(async () => {
    if (!conversationId) return;
    setIsRefreshing(true);
    try {
      await Promise.all([reconcileConversation(conversationId), loadConversations()]);
    } finally {
      window.setTimeout(() => setIsRefreshing(false), 400);
    }
  }, [conversationId, reconcileConversation, loadConversations]);

  const handleToggleHideProactiveChats = useCallback((hide: boolean) => {
    setHideProactiveChats(hide);
    window.localStorage.setItem(HIDE_PROACTIVE_CHATS_KEY, String(hide));
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Poll the conversation list so background running-spinners and unread dots
  // stay live even for chats the user isn't currently viewing.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadConversations();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [loadConversations]);

  // The server keeps when each chat was last on screen, on any device, and says which have a newer reply.
  const unreadIds = useMemo(
    () => new Set(conversations.filter((c) => c.unread && c.id !== conversationId).map((c) => c.id)),
    [conversations, conversationId],
  );

  // On a phone the list hides behind one button, so the button carries the strongest mark in it.
  const chatsButtonMark = [
    conversations.some((c) => c.needsInput && c.id !== conversationId) && "bg-accent",
    unreadIds.size > 0 && "bg-text-primary",
  ].find(Boolean);

  // The open chat on a visible page counts as seen, so its dot clears on the phone too.
  const openChatUnread = !!conversations.find((c) => c.id === conversationId)?.unread;
  useEffect(() => {
    if (!conversationId || !openChatUnread || document.visibilityState !== "visible") return;
    void apiFetch(`/conversations/${conversationId}/seen`, { method: "POST" }).then(loadConversations).catch(() => {});
  }, [conversationId, openChatUnread, loadConversations]);

  // Refresh conversation list when a new conversation is created (switching to a listed chat needs no refetch)
  useEffect(() => {
    if (conversationId && conversationId !== prevConversationIdRef.current) {
      prevConversationIdRef.current = conversationId;
      if (!conversations.some((c) => c.id === conversationId)) loadConversations();
    }
  }, [conversationId, conversations, loadConversations]);

  useEffect(() => {
    function handleVisible() {
      if (document.visibilityState === "visible") {
        void loadConversations();
        void reconcileConversation(conversationId);
      }
    }

    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("focus", handleVisible);
    return () => {
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("focus", handleVisible);
    };
  }, [conversationId, loadConversations, reconcileConversation]);

  // Load conversation from URL param on mount (e.g. reload or direct link)
  useEffect(() => {
    if (urlLoadedRef.current) return;
    if (!urlConversationId) return;
    urlLoadedRef.current = true;
    loadConversationMessages(urlConversationId)
      .then(({ messages: msgs, hasMore }) => {
        switchConversation(urlConversationId, msgs);
        setHasOlderMessages(hasMore);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlConversationId]);

  // Keep URL in sync with active conversationId.
  // Skip the redirect to /chat when a URL-specified conversation is still loading
  // (urlConversationId is set but conversationId hasn't been populated yet).
  useEffect(() => {
    if (conversationId) {
      const target = `/chat/${conversationId}`;
      if (window.location.pathname !== target) {
        navigate(target, { replace: true });
      }
    } else if (!urlConversationId) {
      if (window.location.pathname !== "/chat") {
        navigate("/chat", { replace: true });
      }
    }
  }, [conversationId, urlConversationId, navigate]);

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  // Hovering (or touching) a sidebar row starts loading its messages, so the click usually finds them ready.
  const prefetchRef = useRef(new Map<string, { at: number; load: ReturnType<typeof loadConversationMessages> }>());
  const prefetchConversation = useCallback((id: string) => {
    const hit = prefetchRef.current.get(id);
    if (hit && Date.now() - hit.at < PREFETCH_TTL_MS) return;
    const load = loadConversationMessages(id);
    load.catch(() => prefetchRef.current.delete(id));
    prefetchRef.current.set(id, { at: Date.now(), load });
  }, []);

  // Select conversation
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const pendingConversationRef = useRef<string | null>(null);
  async function handleSelectConversation(id: string) {
    pendingConversationRef.current = id;
    setPendingConversationId(id);
    const hit = prefetchRef.current.get(id);
    prefetchRef.current.delete(id);
    const age = hit ? Date.now() - hit.at : Infinity;
    const prefetched = hit && age < PREFETCH_TTL_MS ? hit.load : null;
    try {
      const { messages: msgs, hasMore } = await (prefetched ?? loadConversationMessages(id));
      // Fast clicks: only the last one switches.
      if (pendingConversationRef.current !== id) return;
      pendingConversationRef.current = null;
      setPendingConversationId(null);
      // A prefetched copy older than a couple of seconds may have missed a reply, so let reconcile refresh it.
      switchConversation(id, msgs, { fresh: !prefetched || age < 2_000 });
      setHasOlderMessages(hasMore);
      navigate(`/chat/${id}`, { replace: true });
    } catch {
      if (pendingConversationRef.current === id) {
        pendingConversationRef.current = null;
        setPendingConversationId(null);
      }
    }
  }

  async function handleLoadOlderMessages() {
    if (!conversationId || isLoadingOlderMessages || !hasOlderMessages) return;
    const before = messages.find((message) => message.createdAt)?.createdAt;
    if (!before) return;
    setIsLoadingOlderMessages(true);
    try {
      const { messages: older, hasMore } = await loadConversationMessages(conversationId, before);
      prependMessages(older);
      setHasOlderMessages(hasMore);
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }

  // Delete conversation
  async function handleDeleteConversation(id: string) {
    try {
      await apiFetch(`/conversations/${id}`, { method: "DELETE" });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === conversationId) {
        handleNewChat();
      }
    } catch {
      // ignore
    }
  }

  // Update conversation (title, tags, pinned)
  async function handleUpdateConversation(id: string, data: Partial<Pick<Conversation, "title" | "tags" | "pinned" | "pinnedAgent">>) {
    try {
      const res = await apiFetch(`/conversations/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const updated = await res.json() as Conversation;
        setConversations((prev) => prev.map((c) => c.id === id ? { ...c, ...updated } : c));
      }
    } catch {
      // ignore
    }
  }

  // A new chat lives in the browser until its first message: the server creates
  // it then, so an unused "New chat" leaves no empty conversation behind.
  function handleNewChat() {
    handoffParentRef.current = null;
    setNewChatProject(undefined);
    newConversation();
    setHasOlderMessages(false);
    navigate("/chat", { replace: true });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      const att = await fileToBase64(file);
      setPendingAttachments((prev) => [...prev, att]);
    }
    e.target.value = "";
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const att = await fileToBase64(file);
      setPendingAttachments((prev) => [...prev, att]);
    }
  }

  function removePendingAttachment(index: number) {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  function handleShareLocation() {
    if (!navigator.geolocation) {
      setLocationState("blocked");
      return;
    }

    setLocationState("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const context = buildWebChannelContext(position);
        setWebChannelContext(context);
        setLocationState("shared");
        window.localStorage.setItem(WEB_CHANNEL_CONTEXT_KEY, context);
      },
      () => {
        setLocationState((prev) => prev === "shared" ? "shared" : "blocked");
      },
      {
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 5 * 60 * 1000,
      },
    );
  }

  // While a turn runs, a plain send steers it; `sendNow` stops it and sends instead.
  /** spoken: words from voice mode, sent with whatever is in the box without waiting for it to redraw. */
  async function handleSubmit(e?: React.FormEvent, sendNow = false, spoken?: string) {
    e?.preventDefault();
    if (isSubmittingRef.current) return;
    const text = (spoken ?? input).trim();
    if (!text && !hasPending) return;

    if (text === "/help") {
      setHelpOpen(true);
      setInput("");
      return;
    }

    if (pendingQuestion && text) {
      answerQuestion(text);
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      return;
    }

    // The running session writes the note on its own model, so its prompt cache
    // pays for the read; the words after /handoff pick the new chat's model.
    const handoff = parseHandoff(text, agentProviders, selection);
    if (handoff) {
      if (!conversationId) return;
      handoffTargets.current.set(conversationId, handoff.target);
      sendMessage(text, undefined, { ...sendOptions, handoff: { goal: handoff.goal } });
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      return;
    }

    isSubmittingRef.current = true;
    try {
      let uploaded: UploadedAttachment[] = [];
      if (hasPending) {
        setIsUploading(true);
        try {
          // Marks' pictures go after the user's own files, numbered as the message numbers the marks.
          const results = await Promise.all([
            ...pendingAttachments.map((att) => uploadAttachment(att.data, att.mimeType, att.name)),
            ...previewMarks.map((m, i) => (m.element.crop ? uploadAttachment(m.element.crop, "image/jpeg", `pointed-${i + 1}.jpg`) : Promise.resolve(null))),
          ]);
          uploaded = results.filter((u): u is UploadedAttachment => u !== null);
          setPendingAttachments([]);
        } finally {
          setIsUploading(false);
        }
      }

      const content = [text, marksMessage(previewMarks)].filter(Boolean).join("\n\n") || placeholderForUploads(uploaded);
      if (!content) return;

      const handoffFrom = !conversationId ? handoffParentRef.current ?? undefined : undefined;
      const firstMessageProject = !conversationId ? newChatProject : undefined;
      handoffParentRef.current = null;
      sendMessage(content, uploaded.length > 0 ? uploaded : undefined, {
        ...sendOptions,
        ...(spoken !== undefined ? { channelContext: [sendOptions.channelContext, SPOKEN_CONTEXT].filter(Boolean).join("\n") } : {}),
        interrupt: sendNow,
        ...(handoffFrom ? { handoffFrom } : {}),
        ...(firstMessageProject ? { projectPath: firstMessageProject, worktree: newChatWorktree } : {}),
      });
      setStoredMarks({ chat: conversationId, marks: [] });
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } finally {
      isSubmittingRef.current = false;
    }
  }

  function handleInputChange(value: string) {
    setInput(value);

    if (!completionsData) { setAcItems([]); setAcPrefix(null); return; }

    // Detect `/` at start or after whitespace
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);

    // Check for `/command` pattern (must be at start of line or after whitespace)
    const slashMatch = before.match(/(^|\s)(\/\S*)$/);
    if (slashMatch) {
      const query = slashMatch[2].toLowerCase();
      const items: AutocompleteItem[] = completionsData.commands
        .filter((c) => c.trigger.toLowerCase().startsWith(query))
        .map((c) => ({
          label: c.label !== c.trigger ? `${c.trigger}  ${c.label}` : c.trigger,
          description: c.description,
          insertValue: c.trigger + " ",
        }));
      setAcItems(items);
      setAcIndex(0);
      setAcPrefix({ type: "command", start: cursor - slashMatch[2].length });
      return;
    }

    // Check for `@agent` pattern
    const atMatch = before.match(/(^|\s)(@\S*)$/);
    if (atMatch) {
      const query = atMatch[2].slice(1).toLowerCase(); // strip @
      const agents: AutocompleteItem[] = completionsData.agents
        .filter((a) => {
          if (a.name.toLowerCase().startsWith(query)) return true;
          return a.shorthands.some((s) => s.toLowerCase().startsWith(query));
        })
        .map((a) => ({
          label: `@${a.name}`,
          description: a.type + (a.shorthands.length > 0 ? ` (${a.shorthands.map((s) => "@" + s).join(", ")})` : ""),
          insertValue: `@${a.name} `,
        }));
      // Other chats, newest first. The server tells the agent which chat each reference is and how to message it.
      const chats: AutocompleteItem[] = conversations
        .filter((c) => c.id !== conversationId && (c.title || "Untitled").toLowerCase().includes(query))
        .slice(0, CHAT_MENTIONS)
        .map((c) => ({
          label: `@${c.title || "Untitled"}`,
          description: `Chat · ${formatTimeAgo(c.updatedAt)}`,
          insertValue: `@session:${c.id.slice(0, 8)} `,
        }));
      setAcItems([...agents, ...chats]);
      setAcIndex(0);
      setAcPrefix({ type: "agent", start: cursor - atMatch[2].length });
      return;
    }

    // No match — hide autocomplete
    setAcItems([]);
    setAcPrefix(null);
  }

  function handleAcSelect(item: AutocompleteItem) {
    if (!acPrefix) return;
    const before = input.slice(0, acPrefix.start);
    const after = input.slice(textareaRef.current?.selectionStart ?? input.length);
    setInput(before + item.insertValue + after);
    setAcItems([]);
    setAcPrefix(null);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Autocomplete keyboard nav
    if (acItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        handleAcSelect(acItems[acIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAcItems([]);
        setAcPrefix(null);
        return;
      }
    }

    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const box = e.currentTarget;
      const sent = messages.filter((m) => m.role === "user").map((m) => m.content);
      const recalled = stepPrompt(sent, input, e.key === "ArrowUp" ? "up" : "down", {
        atStart: box.selectionStart === 0 && box.selectionEnd === 0,
        atEnd: box.selectionStart === input.length,
      });
      if (recalled !== null) {
        e.preventDefault();
        setInput(recalled);
        return;
      }
    }

    if (e.key === "Escape" && isTurnActive && !pendingQuestion) {
      e.preventDefault();
      stopResponse();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(undefined, isTurnActive && (e.metaKey || e.ctrlKey));
    }
  }

  return (
    <div className="flex h-full">
      {/* Desktop: static sidebar */}
      {!isMobile && (
        <ChatSidebar
          conversations={conversations}
          activeId={pendingConversationId ?? conversationId}
          unreadIds={unreadIds}
          hideProactive={hideProactiveChats}
          hasMore={hasMoreConversations}
          isLoadingMore={isLoadingOlderConversations}
          onToggleHideProactive={handleToggleHideProactiveChats}
          onSelect={handleSelectConversation}
          onPrefetch={prefetchConversation}
          onNew={handleNewChat}
          onDelete={handleDeleteConversation}
          onUpdate={handleUpdateConversation}
          onLoadMore={loadOlderConversations}
        />
      )}

      {/* Mobile: overlay sidebar */}
      {isMobile && sidebarOpen && (
        <ChatSidebar
          conversations={conversations}
          activeId={pendingConversationId ?? conversationId}
          unreadIds={unreadIds}
          hideProactive={hideProactiveChats}
          hasMore={hasMoreConversations}
          isLoadingMore={isLoadingOlderConversations}
          onToggleHideProactive={handleToggleHideProactiveChats}
          onSelect={handleSelectConversation}
          onPrefetch={prefetchConversation}
          onNew={handleNewChat}
          onDelete={handleDeleteConversation}
          onUpdate={handleUpdateConversation}
          onLoadMore={loadOlderConversations}
          isOverlay
          onClose={() => setSidebarOpen(false)}
        />
      )}

      {/* The minimum makes a wide docked preview give way instead of crushing the chat. */}
      <div className="flex flex-col flex-1 min-w-0 lg:min-w-[320px]">
        {/* Mobile: chat header with sidebar toggle */}
        <header className="flex items-center gap-3 h-12 md:h-14 px-3 md:px-6 border-b border-border shrink-0">
          {isMobile && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="relative p-1.5 flex rounded-md text-text-muted bg-transparent border-none cursor-pointer"
              aria-label={chatsButtonMark ? "Show chats, some need a look" : "Show chats"}
            >
              <MessageCircle size={18} strokeWidth={1.5} />
              {chatsButtonMark && <span className={`absolute top-1 right-1 w-2 h-2 rounded-full ring-2 ring-surface ${chatsButtonMark}`} />}
            </button>
          )}
          <h1 className="text-[15px] font-medium truncate m-0">
            {currentConversation?.title || "New conversation"}
          </h1>
          <div className="ml-auto flex items-center gap-4 shrink-0">
            {selection && (
              <div className="hidden md:flex gap-4 font-mono text-xs text-text-muted">
                <span>{selection.provider === "claude" ? "Claude" : "Codex"}</span>
                <span>{selectionLabel(agentProviders, selection)}</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              aria-label="Help"
              title="What you can do here (/help)"
              className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-text-muted cursor-pointer hover:bg-raised hover:text-text-primary"
            >
              <CircleHelp size={14} strokeWidth={1.5} />
            </button>
            {projectPath && (
              <button
                type="button"
                onClick={() => setFilesOpen((open) => !open)}
                aria-label="Files"
                aria-expanded={filesOpen}
                title="Files"
                className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none cursor-pointer hover:bg-raised hover:text-text-primary ${
                  filesOpen ? "bg-raised text-text-primary" : "bg-transparent text-text-muted"
                }`}
              >
                <FolderTree size={14} strokeWidth={1.5} />
              </button>
            )}
            <button
              type="button"
              onClick={preview.toggle}
              aria-label="Preview"
              aria-expanded={preview.open}
              title="Preview"
              className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none cursor-pointer hover:bg-raised hover:text-text-primary ${
                preview.open ? "bg-raised text-text-primary" : "bg-transparent text-text-muted"
              }`}
            >
              <AppWindow size={14} strokeWidth={1.5} />
            </button>
            {conversationId && (
              <button
                type="button"
                onClick={() => setTerminalOpen((open) => !open)}
                aria-label="Terminal"
                aria-expanded={terminalOpen}
                title="Terminal in this chat's folder"
                className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none cursor-pointer hover:bg-raised hover:text-text-primary ${
                  terminalOpen ? "bg-raised text-text-primary" : "bg-transparent text-text-muted"
                }`}
              >
                <Terminal size={14} strokeWidth={1.5} />
              </button>
            )}
            {conversationId && (
              <button
                type="button"
                onClick={() => (isMobile ? setInfoSheetOpen(true) : toggleInfoPanel())}
                aria-label="Chat info"
                aria-expanded={isMobile ? infoSheetOpen : infoPanelOpen}
                title="Chat info"
                className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none cursor-pointer hover:bg-raised hover:text-text-primary ${
                  !isMobile && infoPanelOpen ? "bg-raised text-text-primary" : "bg-transparent text-text-muted"
                }`}
              >
                <PanelRight size={14} strokeWidth={1.5} />
              </button>
            )}
            {/* In the top bar, not the composer: it acts on the whole chat, and the composer row needs the room. */}
            {conversationId && (
              <button
                type="button"
                onClick={handleRefreshChat}
                disabled={!isConnected || isRefreshing}
                title="Refresh this chat"
                aria-label="Refresh this chat"
                className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-text-muted cursor-pointer ${
                  !isConnected ? "opacity-40 cursor-default" : "hover:bg-raised hover:text-text-primary"
                }`}
              >
                <RefreshCw size={14} strokeWidth={1.5} style={isRefreshing ? { animation: "spin 0.7s linear infinite" } : undefined} />
              </button>
            )}
          </div>
        </header>
        {/* Messages */}
        <div className="relative flex-1 min-h-0">
          <div
            ref={messagesScrollRef}
            onScroll={updateMessageScrollState}
            className="h-full overflow-auto px-4 md:px-6 pt-6 md:pt-8 pb-3"
          >
            {hasOlderMessages && (
              <div className="flex justify-center pb-6">
                <Button type="button" variant="outline" size="sm" onClick={handleLoadOlderMessages} disabled={isLoadingOlderMessages}>
                  {isLoadingOlderMessages ? "Loading" : "Load older messages"}
                </Button>
              </div>
            )}
            <div className="max-w-[800px] mx-auto">
              <CanvasActionProvider value={handleRunNotificationAction}>
                <MessageList
                  messages={messages}
                  items={items}
                  liveTurnId={liveTurn}
                  isWaiting={isTurnActive}
                  onAnswerApproval={answerApproval}
                  onImplementPlan={handleImplementPlan}
                  onFork={handleFork}
                  onQuote={handleQuote}
                  onSendNow={hurry}
                  onRunNotificationAction={handleRunNotificationAction}
                  onSaveWidget={handleSaveWidget}
                />
              </CanvasActionProvider>
              {researchPlan ? (
                <ResearchProgress plan={researchPlan} onStop={stopResponse} />
              ) : (isWaiting || waitStatus === "agent_working") ? (
                // The timeline shows the live turn's work, so the one-line activity is only for turns without items.
                <ShimmerBar status={waitStatus} latestItem={liveTurn ? items[items.length - 1] : undefined} agentElapsed={agentElapsed} activity={liveTurn ? null : agentActivity} onStop={stopResponse} />
              ) : null}
            </div>
            <div ref={bottomRef} />
          </div>
          {!isNearMessageBottom && (
            <button
              type="button"
              onClick={() => scrollMessagesToBottom("smooth")}
              className="absolute right-6 bottom-4 z-10 flex h-9 w-9 items-center justify-center rounded-md border border-border bg-raised text-text-secondary shadow-modal transition-colors hover:text-text-primary"
              aria-label="Scroll to latest message"
              title="Scroll to bottom"
            >
              <ArrowDown size={16} strokeWidth={1.5} />
            </button>
          )}
        </div>

        {/* Near the limit, before the CLI auto-compacts and drops detail: offer to compact or hand off. */}
        {!isTurnActive && contextUsage && contextUsage.provider === selection?.provider && contextUsage.percent >= CONTEXT_HINT_PERCENT && (
          <div className="max-w-[848px] w-full mx-auto px-4 md:px-6 pt-1 flex items-baseline gap-2 text-xs text-text-muted">
            <span>Context is {contextUsage.percent}% full.</span>
            {contextUsage.provider === "claude" && (
              <button
                type="button"
                onClick={compactChat}
                className="p-0 border-none bg-transparent text-xs text-accent-ink cursor-pointer hover:underline"
              >
                Compact
              </button>
            )}
            <button
              type="button"
              onClick={startHandoff}
              className="p-0 border-none bg-transparent text-xs text-accent-ink cursor-pointer hover:underline"
            >
              Hand off to a new chat
            </button>
          </div>
        )}


        {/* Composer */}
        <form
          onSubmit={handleSubmit}
          className="relative px-2 md:px-6 pt-2 pb-[max(0.5rem,var(--safe-bottom))] md:pb-4 [:root[data-keyboard]_&]:pb-1"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          {todos && (
            <div className="max-w-[800px] mx-auto mb-2 max-h-[40vh] overflow-auto">
              <TodoListCard item={todos} collapsible />
            </div>
          )}
          <div className="relative max-w-[800px] mx-auto rounded-[22px] border border-white/14 bg-glass p-3 flex flex-col gap-2 transition-colors focus-within:border-white/24">
            {/* Behind the composer, not around it: the beam clips what it wraps, and the menus open above the box. */}
            <VoiceBeam stream={voice.phase === "listening" ? voice.micStream : null} level={playbackLevel} active={voice.phase !== "off"} theme="auto" borderRadius={22} aria-hidden className="!absolute inset-0 pointer-events-none">
              <div className="w-full h-full rounded-[22px]" />
            </VoiceBeam>
            {/* Anchored to the composer box, like the model picker, not to the page column. */}
            {acItems.length > 0 && (
              <ChatAutocomplete items={acItems} activeIndex={acIndex} onSelect={handleAcSelect} />
            )}
            <PreviewMarkChips marks={previewMarks} onRemove={removePreviewMark} />
            <AttachmentPreview
              attachments={pendingAttachments}
              isUploading={isUploading}
              onRemove={removePendingAttachment}
            />
            {/* Never under one line: the auto-grow height was sometimes measured too small and clipped the text. */}
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={[
                voiceProblem,
                !isConnected && "Connecting",
                pendingQuestion && "Answer the agent's question",
                isTurnActive && "Add to the running task (⌘↵ sends now, Esc stops)",
              ].find(Boolean) || "Message Chomp, or type @ for an agent"}
              disabled={!isConnected}
              className="w-full shrink-0 min-h-[30px] px-1 py-1 bg-transparent !border-none text-text-primary text-sm leading-[22px] resize-none overflow-auto max-h-[200px] placeholder:text-text-muted"
            />
            {/* One row: only the project, soul and model menus (and the usage label) shrink, so nothing wraps or overlaps. */}
            {/* Opening a menu drops the keyboard: iOS keeps focus in the textarea on a button tap, and the menu would open off the top. */}
            <div
              className="@container z-[1] flex items-center gap-1 min-w-0"
              onClickCapture={(e) => (e.target as Element).closest("[aria-expanded]") && textareaRef.current?.blur()}
            >
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!isConnected || isUploading}
                title="Attach file"
                className={`${ROUND} bg-white/8 text-text-secondary cursor-pointer hover:bg-white/14 hover:text-text-primary ${!isConnected || isUploading ? "opacity-40" : ""}`}
              >
                <Plus size={18} strokeWidth={1.5} />
              </button>
              <ProjectMenu projectPath={projectPath} locked={!!conversationId} onChange={setNewChatProject} worktree={newChatWorktree} onWorktreeChange={setNewChatWorktree} />
              <ModelPicker providers={agentProviders} selection={selection} onChange={selectAgent} souls={souls} soulId={soulId} />

              {/* Icon only: the color says the state, the tooltip says it in words. */}
              <button
                type="button"
                onClick={handleShareLocation}
                disabled={!isConnected || locationState === "locating"}
                aria-label={LOCATION_TITLES[locationState as keyof typeof LOCATION_TITLES] ?? LOCATION_TITLES.off}
                title={LOCATION_TITLES[locationState as keyof typeof LOCATION_TITLES] ?? LOCATION_TITLES.off}
                className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent cursor-pointer ${
                  { shared: "text-success", blocked: "text-error" }[locationState as string] ?? "text-text-muted"
                } ${!isConnected || locationState === "locating" ? "opacity-40 cursor-default" : "hover:bg-raised"}`}
              >
                <MapPin size={15} strokeWidth={1.5} />
              </button>
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                {!showsSendNow && (
                  <ContextMeter
                    usage={contextUsage?.provider === selection?.provider ? contextUsage : null}
                    plan={usage.find((u) => u.provider === selection?.provider)}
                    modelLabel={selectedModelLabel}
                    onCompact={compactChat}
                    onHandoff={startHandoff}
                  />
                )}
                <VoiceButton
                  phase={voice.phase}
                  quiet={voice.quiet}
                  onClick={toggleVoice}
                  onLongPress={toggleSpokenReplies}
                  spokenReplies={spokenReplies}
                  disabled={!isConnected}
                  className={ROUND}
                  idleClassName="bg-white/8 text-text-secondary hover:bg-white/14 hover:text-text-primary"
                />
                {isTurnActive && !pendingQuestion && (
                  <Button type="button" variant="outline" size="sm" onClick={stopResponse} aria-label="Stop" title="Stop (Esc)" className="shrink-0 !rounded-full !w-10 !h-10 md:!w-8 md:!h-8 !px-0">
                    <Square size={12} strokeWidth={1.5} />
                  </Button>
                )}
                {showsSendNow && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    title="Stop the running task and send this instead (⌘↵)"
                    disabled={!isConnected || isUploading}
                    onClick={() => handleSubmit(undefined, true)}
                    className="shrink-0 whitespace-nowrap !px-2"
                  >
                    <span className="sm:hidden">Now</span>
                    <span className="hidden sm:inline">Send now</span>
                  </Button>
                )}
                {/* While a turn runs, sending steers it, so the send button only appears once there is something to send. */}
                {(!isTurnActive || pendingQuestion || input.trim() || hasPending) && (
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    aria-label={isTurnActive ? "Add to the running task" : "Send"}
                    title={isTurnActive ? "Add to the running task (↵)" : undefined}
                    disabled={!isConnected || isUploading || (!input.trim() && !hasPending)}
                    className={`shrink-0 !rounded-full ${isUploading ? "" : "!w-10 !h-10 md:!w-8 md:!h-8 !px-0"}`}
                  >
                    {isUploading ? "Uploading" : <ArrowUp size={16} strokeWidth={2} />}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </form>
      </div>
      {filesOpen && projectPath && (
        <Suspense fallback={null}>
          <FilesPanel
            key={conversationId ?? projectPath}
            source={conversationId ? { conversation: conversationId } : { project: projectPath }}
            title={projectPath.split("/").pop() ?? projectPath}
            titleHint={projectPath}
            readOnly={!conversationId}
            layout="panel"
            isMobile={isMobile}
            onAddToChat={addFileToChat}
            onClose={() => setFilesOpen(false)}
          />
        </Suspense>
      )}
      {preview.open && <PreviewWindow conversationId={conversationId} isMobile={isMobile} canAsk={isConnected} onAsk={startPreview} onClose={preview.toggle} onMark={addPreviewMark} modeRequest={preview.modeRequest} ask={preview.ask} onAskDone={preview.clearAsk} />}
      {terminalOpen && conversationId && (
        <Suspense fallback={null}>
          <TerminalPane conversationId={conversationId} isMobile={isMobile} onClose={() => setTerminalOpen(false)} />
        </Suspense>
      )}
      {!isMobile && infoVisible && (
        <InfoDock>
          <ChatInfoPanel
            info={conversationInfo}
            items={items}
            contextUsage={contextUsage}
            modelLabel={sessionModelLabel}
            onOpenConversation={handleSelectConversation}
            onComment={handleDiffComment}
            onClose={toggleInfoPanel}
          />
        </InfoDock>
      )}
      {isMobile && infoVisible && (
        <>
          <div className="fixed inset-0 bg-black/50 z-20" onClick={() => setInfoSheetOpen(false)} />
          <aside className="fixed inset-y-0 right-0 z-30 pt-[calc(3rem+var(--safe-top))] w-[88vw] max-w-[380px] border-l border-border bg-surface flex flex-col">
            <ChatInfoPanel
              info={conversationInfo}
              items={items}
              contextUsage={contextUsage}
              modelLabel={sessionModelLabel}
              onOpenConversation={(id) => {
                setInfoSheetOpen(false);
                void handleSelectConversation(id);
              }}
              onComment={handleDiffComment}
              onClose={() => setInfoSheetOpen(false)}
            />
          </aside>
        </>
      )}
      <HelpDialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        commands={completionsData?.commands ?? []}
        agents={completionsData?.agents ?? []}
        onInsert={(text) => {
          setInput(text);
          requestAnimationFrame(() => textareaRef.current?.focus());
        }}
      />
      <SaveWidgetModal
        open={!!saveWidgetTarget}
        messageId={saveWidgetTarget?.messageId ?? null}
        defaultTitle={saveWidgetTarget?.defaultTitle}
        onClose={() => setSaveWidgetTarget(null)}
      />
    </div>
  );
}
