import { Copy, Check, GitFork, Star, TextQuote } from "lucide-react";
import { memo, useState } from "react";
import type { ApprovalDecision, ChatItem } from "@chomp/shared";
import type { Message } from "../../hooks/useChat";
import { buildTimeline } from "../../lib/chat-timeline";
import { AgentItem, WorkGroup } from "./AgentItems";
import Markdown from "../Markdown";
import CanvasMessage from "../canvas/CanvasMessage";
import { hasCanvasContent } from "../../lib/canvas-parser";
import { CanvasLockProvider } from "../canvas/CanvasActionContext";
import { SpeakButton } from "../VoiceControls";
import { AgentOrb, Button } from "../ui";

interface MessageListProps {
  messages: Message[];
  items: ChatItem[];
  /** The turn the agent is working on now; its work stays open. */
  liveTurnId?: string;
  isWaiting: boolean;
  onAnswerApproval: (requestId: string, decision: ApprovalDecision) => void;
  onImplementPlan: (access: "auto-edits" | "full") => void;
  onRunNotificationAction: (prompt: string) => void;
  onSaveWidget: (messageId: string, defaultTitle: string) => void;
  onFork: (messageId: string) => void;
  onQuote: (text: string) => void;
  /** Send now on a steer the agent has not taken in yet. */
  onSendNow: () => void;
}

function deriveWidgetTitle(content: string): string {
  const stripped = content.replace(/:::canvas[\s\S]*?\n:::/g, "").trim();
  const heading = stripped.match(/^#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].replace(/[*_`]/g, "").trim().slice(0, 80);
  const firstLine = stripped.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
  if (firstLine) return firstLine.replace(/[*_`#>]/g, "").trim().slice(0, 80);
  return "Saved widget";
}

// Which agent answered. The orb shows while the reply is still streaming.
function AgentHeader({ msg }: { msg: Message }) {
  return (
    <div className="flex items-center gap-2 mb-2 font-mono text-xs text-text-muted">
      {msg.isStreaming && <AgentOrb state="composing" />}
      {msg.agentUsed?.trim() || "Chomp"}
    </div>
  );
}

const MESSAGE_SOURCE_LABELS = { telegram: "Telegram", discord: "Discord" } as const;

const formatTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    let promise: Promise<void>;
    if (navigator.clipboard) {
      promise = navigator.clipboard.writeText(text);
    } else {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
        promise = Promise.resolve();
      } catch {
        promise = Promise.reject();
      } finally {
        document.body.removeChild(el);
      }
    }
    promise.then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="p-1 rounded-sm border-none bg-transparent text-text-muted cursor-pointer leading-none flex items-center hover:text-text-primary"
      title="Copy message"
    >
      {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
    </button>
  );
}

function ModelBadge({ model }: { model?: string }) {
  if (!model) return null;
  return (
    <span className="font-mono text-xs text-text-muted">
      {model}
    </span>
  );
}

function NotificationMessage({
  msg,
  onRunAction,
}: {
  msg: Message;
  onRunAction: (prompt: string) => void;
}) {
  return (
    <div
      className="mx-8 my-4 px-4 py-3 rounded-xl bg-glass border border-border text-[13px] text-text-secondary"
    >
      <Markdown>{msg.content}</Markdown>
      {msg.actionPrompt && (
        <Button type="button" size="sm" onClick={() => onRunAction(msg.actionPrompt!)} className="mt-2">
          {msg.actionLabel ?? "Run"}
        </Button>
      )}
      {msg.createdAt && (
        <div className="font-mono text-xs text-text-muted mt-2">
          {formatTime(msg.createdAt)}
        </div>
      )}
    </div>
  );
}

/** Text selected in the conversation, if any. A footer can sit apart from its message, so any selection in the list counts. */
function selectedText(from: Element): string {
  const selection = window.getSelection();
  const list = from.closest("[data-message-list]");
  if (!selection || selection.isCollapsed || !list?.contains(selection.anchorNode)) return "";
  return selection.toString().trim();
}

/** Time and actions under a message: copy, read aloud, quote, fork from here, save canvas to a board. */
function MessageFooter({
  msg,
  onSaveWidget,
  onFork,
  onQuote,
  onSendNow,
}: {
  msg: Message;
  onSaveWidget: (messageId: string, defaultTitle: string) => void;
  onFork: (messageId: string) => void;
  onQuote: (text: string) => void;
  onSendNow: () => void;
}) {
  if (!msg.createdAt) return null;
  return (
    <div
      className={`font-mono text-xs text-text-muted mt-1.5 flex items-center gap-2 ${
        msg.role === "user" ? "justify-end" : "justify-start"
      }`}
    >
      {msg.waiting && (
        <button
          type="button"
          onClick={onSendNow}
          className="h-6 px-2 rounded-md border border-border bg-transparent text-text-secondary hover:text-text-primary hover:bg-white/6 cursor-pointer font-sans text-xs transition-colors"
          title="The agent takes this in at its next step. Send now stops the current step instead."
        >
          Send now
        </button>
      )}
      {msg.source && <span>via {MESSAGE_SOURCE_LABELS[msg.source]}</span>}
      {formatTime(msg.createdAt)}
      {msg.role === "assistant" && msg.model && msg.model !== (msg.agentUsed?.trim() || "Chomp") && (
        <ModelBadge model={msg.model} />
      )}
      <CopyButton text={msg.content} />
      {msg.role === "assistant" && <SpeakButton text={msg.content} />}
      {msg.role === "assistant" && (
        <button
          type="button"
          // Keeps a text selection alive through the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => onQuote(selectedText(e.currentTarget) || msg.content)}
          className="p-1 rounded-sm border-none bg-transparent text-text-muted hover:text-text-primary cursor-pointer leading-none flex items-center transition-colors"
          title="Quote in your reply: the text you selected, or this whole message"
          aria-label="Quote in your reply"
        >
          <TextQuote size={14} strokeWidth={1.5} />
        </button>
      )}
      {msg.role === "assistant" && msg.id && (
        <button
          type="button"
          onClick={() => onFork(msg.id!)}
          className="p-1 rounded-sm border-none bg-transparent text-text-muted hover:text-text-primary cursor-pointer leading-none flex items-center transition-colors"
          title="Fork from here: a new chat with everything up to this reply"
          aria-label="Fork from here"
        >
          <GitFork size={14} strokeWidth={1.5} />
        </button>
      )}
      {msg.role === "assistant" && msg.id && hasCanvasContent(msg.content) && (
        <button
          onClick={() => onSaveWidget(msg.id!, deriveWidgetTitle(msg.content))}
          className="p-1 rounded-sm border-none bg-transparent text-text-muted hover:text-accent cursor-pointer leading-none flex items-center"
          title="Save to a board"
        >
          <Star size={14} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

const ChatMessageBubble = memo(function ChatMessageBubble({
  msg,
  onSaveWidget,
  onFork,
  onQuote,
  onSendNow,
}: {
  msg: Message;
  onSaveWidget: (messageId: string, defaultTitle: string) => void;
  onFork: (messageId: string) => void;
  onQuote: (text: string) => void;
  onSendNow: () => void;
}) {
  return (
    <div
      className={`flex mb-6 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div className={msg.role === "user" ? "max-w-[90%] md:max-w-[75%]" : "w-full"}>
        <div
          className={msg.role === "user" ? "px-3.5 py-2.5 rounded-xl bg-raised border border-border" : ""}
        >
          {msg.role === "assistant" && <AgentHeader msg={msg} />}
          {msg.role === "assistant" ? (
            hasCanvasContent(msg.content) ? (
              <CanvasMessage content={msg.content} />
            ) : (
              <Markdown>{msg.content}</Markdown>
            )
          ) : (
            <Markdown>{msg.content}</Markdown>
          )}
          {msg.isStreaming && <span className="typing-cursor" />}
        </div>
        <MessageFooter msg={msg} onSaveWidget={onSaveWidget} onFork={onFork} onQuote={onQuote} onSendNow={onSendNow} />
      </div>
    </div>
  );
});

function MessageList({
  messages,
  items,
  liveTurnId,
  isWaiting,
  onAnswerApproval,
  onImplementPlan,
  onRunNotificationAction,
  onSaveWidget,
  onFork,
  onQuote,
  onSendNow,
}: MessageListProps) {
  const visibleMessages = messages.filter((msg) => msg.content?.trim());
  const timeline = buildTimeline(visibleMessages, items, liveTurnId);
  // Only the newest plan can still be implemented, and only between turns.
  const actionablePlanId = isWaiting ? undefined : items.filter((item) => item.kind === "proposed_plan").at(-1)?.id;

  // Canvas actions in anything above the latest user message are already answered.
  const answered: boolean[] = [];
  for (let i = timeline.length - 1, later = false; i >= 0; i--) {
    answered[i] = later;
    const e = timeline[i];
    if (e.type === "message" && e.message.role === "user") later = true;
  }

  if (timeline.length === 0 && !isWaiting) {
    return (
      <p className="text-text-muted text-center mt-16 text-[15px]">
        No messages yet
      </p>
    );
  }

  return (
    <div data-message-list>
      {timeline.map((entry, i) => {
        if (entry.type === "work") {
          return <WorkGroup key={entry.id} items={entry.items} live={entry.live} />;
        }
        if (entry.type === "item") {
          return (
            <CanvasLockProvider key={entry.item.id} value={answered[i]}>
              <AgentItem
                item={entry.item}
                onAnswerApproval={onAnswerApproval}
                onImplementPlan={entry.item.id === actionablePlanId ? onImplementPlan : undefined}
              />
            </CanvasLockProvider>
          );
        }
        const msg = entry.message;
        if (entry.type === "footer") {
          return (
            <div key={`footer-${msg.key ?? msg.id ?? msg.createdAt}`} className="-mt-3 mb-6">
              <MessageFooter msg={msg} onSaveWidget={onSaveWidget} onFork={onFork} onQuote={onQuote} onSendNow={onSendNow} />
            </div>
          );
        }
        return msg.isNotification ? (
          <NotificationMessage
            key={msg.key ?? msg.id ?? msg.createdAt}
            msg={msg}
            onRunAction={onRunNotificationAction}
          />
        ) : (
          <CanvasLockProvider key={msg.key ?? msg.id ?? msg.createdAt} value={answered[i]}>
            <ChatMessageBubble msg={msg} onSaveWidget={onSaveWidget} onFork={onFork} onQuote={onQuote} onSendNow={onSendNow} />
          </CanvasLockProvider>
        );
      })}
    </div>
  );
}

export default memo(MessageList);
