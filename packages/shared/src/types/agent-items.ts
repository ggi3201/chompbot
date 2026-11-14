/**
 * Live agent runtime contract — what a Claude Code or Codex turn looks like on
 * the wire and in `chat_items`. Both runners normalise their native events into
 * these items, so the web timeline renders one shape regardless of provider.
 *
 * Items are upserted, not appended: every update replaces the whole item and
 * takes a new `seq`. A client that has seen everything up to `seq` N asks for
 * `afterSeq: N` and gets the latest state of each item changed since.
 */

export type AgentProvider = "claude" | "codex";

/**
 * How much the agent may do without asking. Maps to Claude's permission mode
 * and to Codex's approval policy + sandbox. `full` is the default because a run
 * outside web chat (Telegram, Discord, proactive rules) can only be answered
 * from the phone's lock screen, so it must opt in to `supervised` by its target.
 * A request nobody can answer expires: it never holds the turn forever.
 *
 * `plan` is each CLI's native plan mode (Claude's `plan` permission mode,
 * Codex's `plan` collaboration mode): read-only, and the turn ends with a
 * `proposed_plan` item instead of changes.
 */
export type AccessMode = "plan" | "supervised" | "auto-edits" | "full";

export const ACCESS_MODES: readonly AccessMode[] = ["plan", "supervised", "auto-edits", "full"];

export const ACCESS_MODE_LABELS: Record<AccessMode, string> = {
  plan: "Plan",
  supervised: "Supervised",
  "auto-edits": "Auto-accept edits",
  full: "Full access",
};

export function normalizeAccessMode(value: unknown): AccessMode {
  return ACCESS_MODES.includes(value as AccessMode) ? (value as AccessMode) : "full";
}

export type ChatItemStatus = "running" | "completed" | "failed" | "declined";

export interface FileDiff {
  path: string;
  kind: "add" | "update" | "delete";
  /** Unified diff text (`@@` hunks, no `---`/`+++` header). */
  diff: string;
  additions: number;
  deletions: number;
}

export interface TodoEntry {
  /** Claude Code's task id. Saved so a restarted runtime still knows which task an update is for. */
  id?: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export type ApprovalDecision = "accept" | "accept-session" | "decline";

export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ["accept", "accept-session", "decline"];

/** `stopped` is a subagent the user or its parent ended before it finished. */
export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

interface ChatItemBase {
  id: string;
  conversationId: string;
  /** The dispatch session id of the turn this item belongs to. */
  turnId: string;
  seq: number;
  /** Set for items produced inside a subagent: the id of its `subagent` item. */
  parentId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatItemBody =
  | { kind: "assistant_text"; text: string; streaming: boolean }
  | { kind: "reasoning"; text: string; streaming: boolean }
  | {
      kind: "tool_call";
      /** Native tool name (`Read`, `mcp__chomp-api__reply`, `web_search`, …). */
      tool: string;
      /** One line for the collapsed row, e.g. `Read src/index.ts`. */
      title: string;
      input?: string;
      output?: string;
      status: ChatItemStatus;
    }
  | {
      kind: "command";
      command: string;
      cwd?: string;
      output: string;
      exitCode: number | null;
      status: ChatItemStatus;
    }
  | { kind: "file_change"; files: FileDiff[]; status: ChatItemStatus }
  | { kind: "todo_list"; todos: TodoEntry[] }
  /** The plan a turn in plan mode ends with. The user implements it with a new message. */
  | { kind: "proposed_plan"; markdown: string }
  | {
      kind: "approval";
      requestId: string;
      /** What is being asked, e.g. `Run command` or `Edit file`. */
      title: string;
      detail: string;
      state: "pending" | ApprovalDecision | "expired";
      /** The answer covers this request only, so "for this session" is not offered. */
      oneTime?: boolean;
    }
  | { kind: "error"; message: string }
  /** A subagent the turn started. Its own tool calls are items with this item's id as `parentId`. */
  | {
      kind: "subagent";
      /** The subagent type, e.g. `Explore`. */
      name: string;
      /** What it was asked to do, in a few words. */
      description: string;
      status: SubagentStatus;
      toolUses: number;
      tokens: number;
      durationMs: number;
      /** What it is doing now, e.g. `Reading src/index.ts`. */
      lastActivity?: string;
      /** Its result, when it ends. */
      summary?: string;
    };

export type ChatItem = ChatItemBase & ChatItemBody;
export type ChatItemKind = ChatItem["kind"];

/** One selectable model, as the picker shows it. */
export interface AgentModelOption {
  /** What the runner receives (`opus`, `gpt-6.1-sol`). */
  id: string;
  label: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
  supportsFast: boolean;
  /** Shown above the "Show more" fold. */
  featured: boolean;
}

export interface AgentProviderModels {
  provider: AgentProvider;
  available: boolean;
  /** Why the provider is unavailable — not installed, not logged in. */
  reason?: string;
  models: AgentModelOption[];
}

/**
 * What runs a turn: an agent (soul) on a provider's model. Every field is
 * optional; what is unset comes from the channel default, then the global one.
 */
export interface RunTarget {
  provider?: AgentProvider;
  soulId?: string;
  model?: string;
  effort?: string;
  /** Unlike the rest, this also binds a turn started with an @mention. */
  access?: AccessMode;
}

/** The composer's choice, sent with every chat message and steer. */
export interface AgentSelection {
  provider: AgentProvider;
  /** The soul to answer as; absent means the default soul, if one is marked. */
  soulId?: string;
  model: string;
  effort?: string;
  fast?: boolean;
  access: AccessMode;
}

/** One usage window of a plan, e.g. the 5-hour or the weekly limit. */
export interface UsageWindow {
  id: string;
  label: string;
  /** 0–100. */
  percent: number;
  resetsAt?: string;
}

/** A provider's plan limits, as its CLI reports them for the logged-in account. */
export interface ProviderUsage {
  provider: AgentProvider;
  available: boolean;
  plan?: string;
  windows: UsageWindow[];
}

/** One row of a context breakdown: the system prompt, tools, messages… */
export interface ContextCategory {
  name: string;
  tokens: number;
}

/** How full a conversation's native session is, as of its last turn. */
export interface ContextUsage {
  provider: AgentProvider;
  model?: string;
  usedTokens: number;
  maxTokens: number;
  /** 0–100, may pass 100 just before the CLI compacts. */
  percent: number;
  /** What fills it. Claude reports this; Codex reports only the total. */
  categories: ContextCategory[];
  updatedAt: string;
}

/** A chat linked to another by a fork or a handoff. */
export interface ConversationLink {
  id: string;
  title: string | null;
  kind: "fork" | "handoff";
}

/** One native CLI session of a chat, and how to open it in a terminal. */
export interface ConversationSession {
  provider: AgentProvider;
  sessionId: string;
  model: string | null;
  cwd: string | null;
  lastTurnAt: string | null;
  resume: string;
}

/** A git repo directly under ~/code on the host, which a chat's agents can run in. */
export interface Project {
  name: string;
  path: string;
}

/** A GitHub repo the host's `gh` can clone into ~/code. */
export interface RemoteRepo {
  nameWithOwner: string;
  description: string | null;
  pushedAt: string;
}

/** The user's and their orgs' repos that are not under ~/code yet. */
export interface RemoteRepoList {
  repos: RemoteRepo[];
  /** Why the host cannot list them: gh is missing or not logged in. */
  unavailable?: string;
}

/** One line of the streamed `POST /api/projects/clone` response. */
export type CloneEvent =
  | { type: "progress"; text: string }
  | { type: "done"; project: Project }
  | { type: "error"; error: string };

/** A project's working tree and branch, as git reports them. */
export interface ProjectGitState {
  /** null when HEAD is detached. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Changed and untracked files. */
  files: number;
  /** Lines changed against HEAD, staged or not. Untracked files do not count. */
  insertions: number;
  deletions: number;
}

/** What the chat info panel shows beyond the chat's own items. */
export interface ConversationInfo {
  /** The machine the agents run on. */
  host: string;
  /** git is null when the directory is gone or git does not answer in time. */
  project: (Project & { git: ProjectGitState | null }) | null;
  sessions: ConversationSession[];
  parent: ConversationLink | null;
  children: ConversationLink[];
}
