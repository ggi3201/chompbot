import { useState, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  FilePenLine,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ApprovalDecision, ChatItem, ChatItemStatus, TodoEntry } from "@chomp/shared";
import Markdown from "../Markdown";
import CanvasMessage from "../canvas/CanvasMessage";
import { hasCanvasContent } from "../../lib/canvas-parser";
import { Button, LiveDot } from "../ui";
import DiffView, { DiffStat } from "./DiffView";
import { summarizeWork, type TimelineItem, type WorkItem } from "../../lib/chat-timeline";

type ItemOf<K extends ChatItem["kind"]> = Extract<ChatItem, { kind: K }>;

const ICON = { size: 16, strokeWidth: 1.5 } as const;

/** A row that opens and closes. `defaultOpen` holds until the user toggles it, so a live block can close itself when the turn ends. */
function Disclosure({
  summary,
  defaultOpen,
  children,
  className = "",
}: {
  summary: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? defaultOpen;
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setToggled(!open)}
        aria-expanded={open}
        className="flex items-center gap-2 w-full min-w-0 p-0 bg-transparent border-none text-left text-[13px] text-text-muted cursor-pointer transition-colors hover:text-text-secondary"
      >
        <ChevronRight
          size={14}
          strokeWidth={1.5}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {summary}
      </button>
      {open && children}
    </div>
  );
}

function Mono({ children, label }: { children: string; label?: string }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="font-mono text-xs text-text-muted">{label}</span>}
      <pre className="m-0 max-h-60 overflow-auto rounded-md bg-surface-alt border border-border px-3 py-2 font-mono text-xs leading-5 text-text-secondary whitespace-pre-wrap break-words">
        {children}
      </pre>
    </div>
  );
}

export function AssistantTextItem({ item }: { item: ItemOf<"assistant_text"> }) {
  if (!item.text.trim() && !item.streaming) return null;
  return (
    <div className="mb-4">
      {/* A half-streamed :::canvas fence is not valid JSON yet; render it once the text is final. */}
      {!item.streaming && hasCanvasContent(item.text) ? <CanvasMessage content={item.text} /> : <Markdown>{item.text}</Markdown>}
      {item.streaming && <span className="typing-cursor" />}
    </div>
  );
}

export function ReasoningItem({ item }: { item: ItemOf<"reasoning"> }) {
  if (!item.text.trim() && !item.streaming) return null;
  return (
    <Disclosure
      className="mb-4"
      defaultOpen={item.streaming}
      summary={
        <>
          Thinking
          {item.streaming && <LiveDot />}
        </>
      }
    >
      <p className="mt-2 mb-0 ml-[7px] pl-4 border-l border-border max-h-60 overflow-auto text-[13px] leading-relaxed text-text-muted whitespace-pre-wrap">
        {item.text}
      </p>
    </Disclosure>
  );
}

function toolIcon(tool: string): LucideIcon {
  const name = tool.toLowerCase();
  if (name === "read") return FileText;
  if (name === "grep" || name === "glob" || name.includes("search")) return Search;
  if (name.includes("fetch") || name.includes("web")) return Globe;
  if (name === "task" || name === "agent") return Bot;
  return Wrench;
}

const statusLabels: Partial<Record<ChatItemStatus, { label: string; tone: string }>> = {
  failed: { label: "Failed", tone: "text-error" },
  declined: { label: "Declined", tone: "text-text-muted" },
};

function StatusMark({ status }: { status: ChatItemStatus }) {
  if (status === "running") return <LiveDot />;
  const mark = statusLabels[status];
  if (!mark) return null;
  return <span className={`font-mono text-xs shrink-0 ${mark.tone}`}>{mark.label}</span>;
}

function workRowParts(item: WorkItem): { Icon: LucideIcon; title: ReactNode; details: ReactNode } {
  switch (item.kind) {
    case "tool_call":
      return {
        Icon: toolIcon(item.tool),
        title: <span className="truncate">{item.title || item.tool}</span>,
        details: (item.input || item.output) && (
          <>
            {item.input && <Mono label="Input">{item.input}</Mono>}
            {item.output && <Mono label="Output">{item.output}</Mono>}
          </>
        ),
      };
    case "command":
      return {
        Icon: SquareTerminal,
        title: <span className="font-mono text-xs truncate">{item.command}</span>,
        details: (
          <>
            {item.cwd && <span className="font-mono text-xs text-text-muted truncate">{item.cwd}</span>}
            {item.output ? <Mono>{item.output}</Mono> : null}
            {item.exitCode !== null && (
              <span className={`font-mono text-xs ${item.exitCode === 0 ? "text-text-muted" : "text-error"}`}>
                Exit code {item.exitCode}
              </span>
            )}
          </>
        ),
      };
    case "file_change": {
      const additions = item.files.reduce((sum, f) => sum + f.additions, 0);
      const deletions = item.files.reduce((sum, f) => sum + f.deletions, 0);
      const [first, ...rest] = item.files;
      return {
        Icon: FilePenLine,
        title: (
          <>
            <span className="font-mono text-xs truncate">
              {first?.path ?? "Files"}
              {rest.length > 0 && ` and ${rest.length} more`}
            </span>
            <DiffStat additions={additions} deletions={deletions} />
          </>
        ),
        details: item.files.length > 0 && item.files.map((file) => <DiffView key={file.path} file={file} />),
      };
    }
  }
}

export function WorkRow({ item }: { item: WorkItem }) {
  const [open, setOpen] = useState(false);
  const { Icon, title, details } = workRowParts(item);
  const muted = item.status === "declined";
  return (
    <li className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!details}
        aria-expanded={details ? open : undefined}
        className={`flex items-center gap-2 w-full min-w-0 p-0 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors disabled:cursor-default ${
          muted ? "text-text-muted" : "text-text-secondary hover:text-text-primary disabled:hover:text-text-secondary"
        }`}
      >
        <Icon {...ICON} className="shrink-0 text-text-muted" />
        <span className="flex items-center gap-2 min-w-0 flex-1">{title}</span>
        <StatusMark status={item.status} />
      </button>
      {open && details && <div className="flex flex-col gap-2 pl-6">{details}</div>}
    </li>
  );
}

/** Consecutive tool calls, commands and edits of one turn. Open while the turn runs, one summary line after. */
export function WorkGroup({ items, live }: { items: WorkItem[]; live: boolean }) {
  return (
    <Disclosure
      className="mb-4"
      defaultOpen={live}
      summary={
        <>
          <span className="truncate">{summarizeWork(items)}</span>
          {live && <LiveDot />}
        </>
      }
    >
      <ul className="list-none m-0 mt-2 ml-[7px] pl-4 py-0.5 border-l border-border flex flex-col gap-2">
        {items.map((item) => <WorkRow key={item.id} item={item} />)}
      </ul>
    </Disclosure>
  );
}

const todoIcons: Record<TodoEntry["status"], ReactNode> = {
  pending: <CircleDashed size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />,
  in_progress: <Loader2 size={14} strokeWidth={1.5} className="shrink-0 text-text-secondary animate-spin" />,
  completed: <CircleCheck size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />,
};

const todoText: Record<TodoEntry["status"], string> = {
  pending: "text-text-secondary",
  in_progress: "text-text-primary",
  completed: "text-text-muted",
};

/**
 * The agent's task list. Collapsible (the copy pinned above the composer) starts as one
 * line, the task in hand and the count; tap it for the whole list.
 */
export function TodoListCard({ item, collapsible = false }: { item: ItemOf<"todo_list">; collapsible?: boolean }) {
  const [open, setOpen] = useState(false);
  const done = item.todos.filter((t) => t.status === "completed").length;
  const label = `Task list, ${done} of ${item.todos.length} done`;
  if (collapsible && !open) {
    const current =
      item.todos.find((t) => t.status === "in_progress") ?? item.todos.find((t) => t.status === "pending") ?? item.todos.at(-1);
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-label={`${label}. Show all`}
        className="w-full flex items-center gap-2.5 rounded-lg border border-border bg-glass px-3.5 py-2.5 text-left text-[13px] cursor-pointer"
      >
        {current && todoIcons[current.status]}
        <span className={`flex-1 min-w-0 truncate ${current ? todoText[current.status] : ""}`}>{current?.text}</span>
        <span className="shrink-0 font-mono text-xs text-text-muted">{done}/{item.todos.length}</span>
        <ChevronUp size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
      </button>
    );
  }
  return (
    <div className="relative rounded-lg border border-border bg-glass px-3.5 py-3" aria-label={label}>
      {collapsible && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-expanded
          aria-label="Show only the current task"
          className="absolute top-2 right-2 p-1 rounded-md border-none bg-transparent text-text-muted cursor-pointer hover:text-text-primary"
        >
          <ChevronDown size={14} strokeWidth={1.5} />
        </button>
      )}
      <ul className={`list-none m-0 p-0 flex flex-col gap-1.5 ${collapsible ? "pr-6" : ""}`}>
        {item.todos.map((todo, index) => (
          <li key={index} className="flex items-center gap-2.5 text-[13px]">
            {todoIcons[todo.status]}
            <span className={todoText[todo.status]}>{todo.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const decisionLabels: Record<Exclude<ItemOf<"approval">["state"], "pending">, string> = {
  accept: "Approved",
  "accept-session": "Approved for this session",
  decline: "Declined",
  expired: "Expired",
};

export function ApprovalCard({
  item,
  onAnswer,
}: {
  item: ItemOf<"approval">;
  onAnswer: (requestId: string, decision: ApprovalDecision) => void;
}) {
  const { state } = item;
  return (
    <div className={`mb-4 rounded-lg border bg-glass px-3.5 py-3 flex flex-col gap-2.5 ${state === "pending" ? "border-accent/40" : "border-border"}`}>
      <div className="flex items-center gap-2 text-[13px] text-text-primary">
        <ShieldAlert {...ICON} className="shrink-0 text-text-muted" />
        {item.title}
      </div>
      {item.detail && <Mono>{item.detail}</Mono>}
      {state === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" size="sm" onClick={() => onAnswer(item.requestId, "accept")}>
            Approve
          </Button>
          {!item.oneTime && (
            <Button type="button" variant="outline" size="sm" onClick={() => onAnswer(item.requestId, "accept-session")}>
              Approve for session
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => onAnswer(item.requestId, "decline")}>
            Decline
          </Button>
        </div>
      ) : (
        <span className="font-mono text-xs text-text-muted">{decisionLabels[state]}</span>
      )}
    </div>
  );
}

export function ErrorLine({ item }: { item: ItemOf<"error"> }) {
  return (
    <div className="mb-4 flex items-start gap-2 text-[13px] text-error/80">
      <CircleAlert {...ICON} className="shrink-0 mt-0.5" />
      <span className="min-w-0 break-words">{item.message}</span>
    </div>
  );
}

/** The plan a plan-mode turn ended with. Implementing it is a new message in a mode that allows changes. */
export function ProposedPlanCard({
  item,
  onImplement,
}: {
  item: ItemOf<"proposed_plan">;
  onImplement?: (access: "auto-edits" | "full") => void;
}) {
  return (
    <div className="mb-4 rounded-lg border border-border bg-glass px-3.5 py-3 flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-[13px] text-text-muted">
        <ListChecks {...ICON} className="shrink-0" />
        Proposed plan
      </div>
      <Markdown>{item.markdown}</Markdown>
      {onImplement && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" size="sm" onClick={() => onImplement("auto-edits")}>
            Implement
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onImplement("full")}>
            Implement with full access
          </Button>
        </div>
      )}
    </div>
  );
}

/** Any non-work item, by kind. */
export function AgentItem({
  item,
  onAnswerApproval,
  onImplementPlan,
}: {
  item: TimelineItem;
  onAnswerApproval: (requestId: string, decision: ApprovalDecision) => void;
  onImplementPlan?: (access: "auto-edits" | "full") => void;
}) {
  switch (item.kind) {
    case "assistant_text":
      return <AssistantTextItem item={item} />;
    case "reasoning":
      return <ReasoningItem item={item} />;
    case "todo_list":
      return <TodoListCard item={item} />;
    case "proposed_plan":
      return <ProposedPlanCard item={item} onImplement={onImplementPlan} />;
    case "approval":
      return <ApprovalCard item={item} onAnswer={onAnswerApproval} />;
    case "error":
      return <ErrorLine item={item} />;
  }
}
