import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, FileDiff, FolderGit2, Forward, GitBranch, GitFork, Laptop, SquareTerminal, X } from "lucide-react";
import type { AgentProvider, ChatItem, ContextUsage, ConversationInfo, ConversationLink, ProjectGitState } from "@chomp/shared";
import { apiFetch } from "../../lib/api";
import { changedFiles, type ChangedFile } from "../../lib/changed-files";
import type { DiffLine } from "../../lib/chat-timeline";
import { subagents } from "../../lib/subagents";
import { ContextDetails } from "./ContextMeter";
import DiffView, { DiffStat } from "./DiffView";
import { ProviderIcon } from "./ModelPicker";
import Subagents from "./Subagents";
import { DockResizeHandle } from "../PaneFrame";

/** The panel's server half (host, sessions, lineage), read on open and whenever a turn ends. */
export function useConversationInfo(conversationId: string | undefined, enabled: boolean, turnActive: boolean): ConversationInfo | null {
  const [info, setInfo] = useState<{ conversationId: string; value: ConversationInfo } | null>(null);

  useEffect(() => {
    if (!conversationId || !enabled || turnActive) return;
    let cancelled = false;
    apiFetch(`/conversations/${conversationId}/info`)
      .then((res) => (res.ok ? (res.json() as Promise<ConversationInfo>) : null))
      .then((value) => {
        if (!cancelled && value) setInfo({ conversationId, value });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, enabled, turnActive]);

  return info && info.conversationId === conversationId ? info.value : null;
}

const INFO_WIDTH_KEY = "chomp.info.width";
const INFO_MIN_WIDTH = 320;

/**
 * The panel docked beside the chat on a computer. Its left edge drags wider, and the width is remembered
 * on this device. When the row runs out of room it gives way first, down to 320px, before the chat list does.
 */
export function InfoDock({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(() => Number(window.localStorage.getItem(INFO_WIDTH_KEY)) || INFO_MIN_WIDTH);
  const aside = useRef<HTMLElement>(null);
  // From the rendered width, so a drag back from where it has given way responds at once.
  const resize = (dx: number) => {
    const next = Math.max(INFO_MIN_WIDTH, (aside.current?.offsetWidth ?? width) - dx);
    window.localStorage.setItem(INFO_WIDTH_KEY, String(next));
    setWidth(next);
  };
  return (
    <aside ref={aside} style={{ width }} className="relative min-w-[320px] shrink-[100] border-l border-border bg-surface flex flex-col h-full">
      <DockResizeHandle label="Resize chat info" onResize={resize} />
      {children}
    </aside>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 text-xs font-normal text-text-muted">{title}</h2>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}
      title={copied ? "Copied" : `Copy: ${text}`}
      aria-label={label}
      className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-text-muted cursor-pointer hover:bg-raised hover:text-text-primary"
    >
      {copied ? <Check size={14} strokeWidth={1.5} className="text-success" /> : <SquareTerminal size={14} strokeWidth={1.5} />}
    </button>
  );
}

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  return index < 0 ? { dir: "", name: path } : { dir: path.slice(0, index), name: path.slice(index + 1) };
}

function FileRow({ file, onComment }: { file: ChangedFile; onComment: (path: string, line: DiffLine, note: string) => void }) {
  const [open, setOpen] = useState(false);
  const { dir, name } = splitPath(file.path);
  return (
    <li className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={file.path}
        className="flex items-center gap-2 w-full min-w-0 p-0 bg-transparent border-none text-left cursor-pointer text-text-secondary hover:text-text-primary"
      >
        <ChevronRight size={12} strokeWidth={1.5} className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1 flex items-baseline gap-2 font-mono text-xs">
          <span className="shrink-0 max-w-full truncate">{name}</span>
          <span className="min-w-0 truncate text-text-muted">{dir}</span>
        </span>
        {file.kind !== "update" && <span className="shrink-0 font-mono text-xs text-text-muted">{file.kind === "add" ? "new" : "deleted"}</span>}
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          {file.changes.map((change, index) => (
            <DiffView key={index} file={change} onComment={(line, note) => onComment(file.path, line, note)} />
          ))}
        </div>
      )}
    </li>
  );
}

function LinkRow({ link, prefix, onOpen }: { link: ConversationLink; prefix: string; onOpen: (id: string) => void }) {
  const Icon = link.kind === "handoff" ? Forward : GitFork;
  return (
    <button
      type="button"
      onClick={() => onOpen(link.id)}
      className="flex items-center gap-2 w-full min-w-0 p-0 bg-transparent border-none text-left text-[13px] cursor-pointer text-text-secondary hover:text-text-primary"
    >
      <Icon size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
      <span className="shrink-0 text-text-muted">{prefix}</span>
      <span className="min-w-0 truncate">{link.title || "Untitled chat"}</span>
    </button>
  );
}

function Row({ icon: Icon, children }: { icon: typeof Laptop; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 min-w-0">
      <Icon size={14} strokeWidth={1.5} className="shrink-0 mt-0.5 text-text-muted" />
      <div className="flex flex-col min-w-0 flex-1">{children}</div>
    </div>
  );
}

function GitState({ git }: { git: ProjectGitState }) {
  const sync = [git.ahead > 0 && `↑${git.ahead}`, git.behind > 0 && `↓${git.behind}`].filter(Boolean).join(" ");
  return (
    <>
      <Row icon={GitBranch}>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="min-w-0 truncate text-[13px] text-text-secondary">{git.branch ?? "Detached HEAD"}</span>
          {sync && <span className="ml-auto shrink-0 font-mono text-xs text-text-secondary" title={`${git.ahead} ahead, ${git.behind} behind`}>{sync}</span>}
        </div>
        <span className="font-mono text-xs text-text-muted truncate">{git.upstream ?? "No upstream"}</span>
      </Row>
      <Row icon={FileDiff}>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="min-w-0 truncate text-[13px] text-text-secondary">
            {git.files === 0 ? "No uncommitted changes" : `${git.files} ${git.files === 1 ? "file" : "files"} uncommitted`}
          </span>
          {git.files > 0 && <span className="ml-auto"><DiffStat additions={git.insertions} deletions={git.deletions} /></span>}
        </div>
      </Row>
    </>
  );
}

/**
 * What a chat is made of beyond its messages: its project's git state, where its agents run and how to
 * open their sessions in a terminal, the subagents they started, how full the context is, the files they
 * changed, and the chats it was forked or handed off from or to.
 */
export default function ChatInfoPanel({
  info,
  items,
  contextUsage,
  modelLabel,
  onOpenConversation,
  onComment,
  onClose,
}: {
  info: ConversationInfo | null;
  items: ChatItem[];
  contextUsage: ContextUsage | null;
  modelLabel: (provider: AgentProvider, model: string | null) => string;
  onOpenConversation: (id: string) => void;
  /** A note on one line of a changed file, for the composer. */
  onComment: (path: string, line: DiffLine, note: string) => void;
  onClose: () => void;
}) {
  const files = changedFiles(items);
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const lineage = info && (info.parent || info.children.length > 0);
  const agents = subagents(items);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 h-12 md:h-14 px-4 border-b border-border shrink-0">
        <span className="text-[13px] text-text-primary">Chat info</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat info"
          className="ml-auto flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-text-muted cursor-pointer hover:bg-raised hover:text-text-primary"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 flex flex-col gap-6">
        {info?.project && (
          <Section title="Project">
            <Row icon={FolderGit2}>
              <span className="text-[13px] text-text-secondary truncate">{info.project.name}</span>
              <span className="font-mono text-xs text-text-muted truncate" title={info.project.path}>{info.project.path}</span>
            </Row>
            {info.project.git ? <GitState git={info.project.git} /> : <p className="m-0 text-xs text-text-muted">Git did not answer for this directory.</p>}
          </Section>
        )}

        <Section title="Sessions">
          {info && (
            <div className="flex items-center gap-2 text-[13px] text-text-secondary">
              <Laptop size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
              <span className="truncate">{info.host}</span>
            </div>
          )}
          {info?.sessions.map((session) => (
            <div key={session.provider} className="flex items-start gap-2">
              <span className="shrink-0 mt-0.5 flex text-text-muted">
                <ProviderIcon provider={session.provider} size={14} />
              </span>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-[13px] text-text-secondary truncate">{modelLabel(session.provider, session.model)}</span>
                {session.cwd && <span className="font-mono text-xs text-text-muted truncate" title={session.cwd}>{session.cwd}</span>}
              </div>
              <CopyButton text={session.resume} label={`Copy the command that resumes the ${session.provider} session`} />
            </div>
          ))}
          {info && info.sessions.length === 0 && <p className="m-0 text-xs text-text-muted">No agent session yet.</p>}
        </Section>

        {agents.length > 0 && (
          <Section title="Subagents">
            <Subagents rows={agents} />
          </Section>
        )}

        <Section title="Context">
          {contextUsage ? <ContextDetails usage={contextUsage} /> : <p className="m-0 text-xs text-text-muted">Shows after the next agent turn.</p>}
        </Section>

        <Section title="Files changed" aside={files.length > 0 && <DiffStat additions={additions} deletions={deletions} />}>
          {files.length > 0 ? (
            <ul className="m-0 p-0 list-none flex flex-col gap-2">
              {files.map((file) => (
                <FileRow key={file.path} file={file} onComment={onComment} />
              ))}
            </ul>
          ) : (
            <p className="m-0 text-xs text-text-muted">No files changed in this chat.</p>
          )}
        </Section>

        {lineage && (
          <Section title="Lineage">
            {info.parent && (
              <LinkRow link={info.parent} prefix={info.parent.kind === "handoff" ? "Handed off from" : "Forked from"} onOpen={onOpenConversation} />
            )}
            {info.children.map((child) => (
              <LinkRow key={child.id} link={child} prefix={child.kind === "handoff" ? "Handed off to" : "Fork"} onOpen={onOpenConversation} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
