import { basename } from "path";
import { structuredPatch } from "diff";
import type { ChatItemBody, FileDiff, TodoEntry } from "@chomp/shared";

/** Tool output can be megabytes (a `cat` of a log). The timeline needs the gist;
 *  the native session keeps the full text. Keep the tail, where errors land. */
const MAX_OUTPUT_CHARS = 24_000;

export function clipOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `… ${text.length - MAX_OUTPUT_CHARS} characters cut …\n${text.slice(-MAX_OUTPUT_CHARS)}`;
}

function oneLine(value: string, max = 120): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Unified hunks without the `---`/`+++` header, plus the counts the row shows. */
export function diffFile(path: string, before: string, after: string, kind: FileDiff["kind"]): FileDiff {
  const patch = structuredPatch(path, path, before, after, "", "", { context: 3 });
  let additions = 0;
  let deletions = 0;
  const lines: string[] = [];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
      lines.push(line);
    }
  }
  return { path, kind, diff: lines.join("\n"), additions, deletions };
}

/** Count the +/- lines of a diff another tool already produced (Codex). */
export function countDiff(path: string, diff: string, kind: FileDiff["kind"]): FileDiff {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { path, kind, diff, additions, deletions };
}

type ToolInput = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The one-line title a collapsed tool row shows. */
export function claudeToolTitle(tool: string, input: ToolInput): string {
  return toolTitle(tool, input).trim();
}

function toolTitle(tool: string, input: ToolInput): string {
  switch (tool) {
    case "Read":
      return `Read ${basename(str(input.file_path))}`;
    case "Glob":
      return `Find ${str(input.pattern)}`;
    case "Grep":
      return `Search ${oneLine(str(input.pattern), 80)}`;
    case "WebFetch":
      return `Fetch ${str(input.url)}`;
    case "WebSearch":
      return `Search the web: ${oneLine(str(input.query), 80)}`;
    case "Task":
    case "Agent":
      return `Subagent: ${oneLine(str(input.description) || str(input.prompt), 80)}`;
    case "Skill":
      return `Skill ${str(input.skill) || str(input.command)}`;
    case "ToolSearch":
      return `Load tools ${oneLine(str(input.query), 80)}`;
    default: {
      const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
      return mcp ? `${mcp[2].replace(/_/g, " ")} (${mcp[1]})` : tool;
    }
  }
}

/**
 * Turn a Claude `tool_use` block into the item the timeline shows while it
 * runs. Bash becomes a command, the edit tools become diffs computed from
 * their own input (no file reads), TodoWrite becomes a checklist.
 */
export function claudeToolItem(tool: string, input: ToolInput): ChatItemBody {
  switch (tool) {
    case "Bash":
      return { kind: "command", command: str(input.command), output: "", exitCode: null, status: "running" };
    case "Edit":
      return {
        kind: "file_change",
        files: [diffFile(str(input.file_path), str(input.old_string), str(input.new_string), "update")],
        status: "running",
      };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as ToolInput[]) : [];
      const files = edits.map((edit) => diffFile(str(input.file_path), str(edit.old_string), str(edit.new_string), "update"));
      return { kind: "file_change", files, status: "running" };
    }
    case "Write":
      return { kind: "file_change", files: [diffFile(str(input.file_path), "", str(input.content), "add")], status: "running" };
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as ToolInput[]) : [];
      return {
        kind: "todo_list",
        todos: todos.map((todo): TodoEntry => ({
          text: str(todo.content) || str(todo.activeForm),
          status: (["pending", "in_progress", "completed"] as const).find((s) => s === todo.status) ?? "pending",
        })),
      };
    }
    default:
      return {
        kind: "tool_call",
        tool,
        title: claudeToolTitle(tool, input),
        input: Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : undefined,
        status: "running",
      };
  }
}

/** Flatten a tool_result's content (string or content blocks) to text. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") return block.text;
      if (block && typeof block === "object" && "type" in block && block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** What `canUseTool` tells Claude when the user says no; its tool result echoes it back. */
export const DECLINED_MESSAGE = "The user declined this action.";

function resultStatus(output: string, isError: boolean): "completed" | "failed" | "declined" {
  if (!isError) return "completed";
  return output.trim() === DECLINED_MESSAGE ? "declined" : "failed";
}

/** Apply a tool's result to the item its tool_use created. */
export function withToolResult(body: ChatItemBody, output: string, isError: boolean): ChatItemBody {
  const status = resultStatus(output, isError);
  switch (body.kind) {
    case "command": {
      // Claude reports a non-zero exit as an error result that starts "Exit code N".
      const exit = output.match(/^Exit code (\d+)/m);
      const exitCode = exit ? Number(exit[1]) : Number(isError);
      return { ...body, output: clipOutput(output), exitCode, status };
    }
    case "tool_call":
      return { ...body, output: clipOutput(output), status };
    case "file_change":
      return { ...body, status };
    default:
      return body;
  }
}

/** One line for an approval card: the command, or the file being touched. */
export function approvalDetail(tool: string, input: ToolInput): string {
  if (tool === "Bash") return str(input.command);
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.url === "string") return input.url;
  return oneLine(JSON.stringify(input), 400);
}

const SUMMARY_MAX = 80;

/** A command in words: only its program and subcommand, since its arguments can hold anything. */
function commandSummary(command: string): string {
  // A compound command cannot be named by its first word: `cd x && rm -rf y`.
  if (/[;&|<>`$()\n]/.test(command)) return "Run a command";
  const [program, ...rest] = command.trim().replace(/^(\w+=\S*\s+)+/, "").split(/\s+/);
  if (!/^[\w./-]+$/.test(program)) return "Run a command";
  const subcommand = rest[0] && /^[a-z][a-z-]*$/.test(rest[0]) ? ` ${rest[0]}` : "";
  const more = rest.length > (subcommand ? 1 : 0) ? " …" : "";
  return `Run ${basename(program)}${subcommand}${more}`.slice(0, SUMMARY_MAX);
}

/** What the lock screen says Claude wants to do. Short, and never the tool's input as such. */
export function claudeApprovalSummary(tool: string, input: ToolInput): string {
  if (tool === "Bash") return commandSummary(str(input.command));
  if (tool === "WebFetch") return URL.canParse(str(input.url)) ? `Fetch ${new URL(str(input.url)).host}` : "Fetch a page";
  const path = str(input.file_path) || str(input.notebook_path);
  if (path) return `${tool === "Read" ? "Read" : "Edit"} ${basename(path)}`.slice(0, SUMMARY_MAX);
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  return `Use ${mcp ? mcp[2].replace(/_/g, " ") : tool}`.slice(0, SUMMARY_MAX);
}

/** The same for Codex, whose approval titles are already safe. */
export function codexApprovalSummary(title: string, command: unknown): string {
  const text = Array.isArray(command) ? command.join(" ") : str(command);
  return text ? commandSummary(text) : title;
}

/**
 * Codex's plan mode ends its final message with the plan inside a
 * `<proposed_plan>` block (its own mode instructions ask for exactly that).
 * Split it out so the plan renders as a card and the message keeps the rest.
 */
export function splitProposedPlan(text: string): { text: string; plan?: string } {
  const match = text.match(/^<proposed_plan>[ \t]*\n([\s\S]*?)\n<\/proposed_plan>[ \t]*$/m);
  if (!match?.[1].trim()) return { text };
  return { text: text.replace(match[0], "").trim(), plan: match[1].trim() };
}
