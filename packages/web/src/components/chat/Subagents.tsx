import { useState } from "react";
import { Bot, ChevronRight } from "lucide-react";
import type { SubagentStatus } from "@chomp/shared";
import { subagentLine, type SubagentRow } from "../../lib/subagents";
import Markdown from "../Markdown";
import { LiveDot } from "../ui";
import { WorkRow } from "./AgentItems";

const endMarks: Partial<Record<SubagentStatus, { label: string; tone: string }>> = {
  failed: { label: "Failed", tone: "text-error" },
  stopped: { label: "Stopped", tone: "text-text-muted" },
};

function SubagentEntry({ row }: { row: SubagentRow }) {
  const [open, setOpen] = useState(false);
  const { subagent, calls } = row;
  const running = subagent.status === "running";
  const mark = endMarks[subagent.status];
  const detail = running ? subagentLine(subagent) : subagent.summary;
  return (
    <li className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-start gap-2 w-full min-w-0 p-0 bg-transparent border-none text-left cursor-pointer text-text-secondary hover:text-text-primary"
      >
        <ChevronRight size={12} strokeWidth={1.5} className={`shrink-0 mt-1 text-text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        <Bot size={14} strokeWidth={1.5} className="shrink-0 mt-0.5 text-text-muted" />
        <span className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="flex items-center gap-2 min-w-0 text-[13px]">
            <span className="shrink-0 text-text-primary">{subagent.name}</span>
            <span className="min-w-0 truncate">{subagent.description}</span>
            {running && <span className="ml-auto shrink-0"><LiveDot /></span>}
            {mark && <span className={`ml-auto shrink-0 font-mono text-xs ${mark.tone}`}>{mark.label}</span>}
          </span>
          {detail && !(open && !running) && <span className="text-xs text-text-muted line-clamp-2 wrap-anywhere">{detail.replace(/`/g, "")}</span>}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 pl-[26px]">
          {!running && subagent.summary && (
            <div className="wrap-anywhere">
              <Markdown>{subagent.summary}</Markdown>
            </div>
          )}
          {!running && <span className="font-mono text-xs text-text-muted">{subagentLine({ ...subagent, lastActivity: undefined })}</span>}
          {calls.length > 0 ? (
            <ul className="list-none m-0 ml-[7px] pl-4 py-0.5 border-l border-border flex flex-col gap-2">
              {calls.map((item) => <WorkRow key={item.id} item={item} />)}
            </ul>
          ) : (
            <p className="m-0 text-xs text-text-muted">No tool calls yet.</p>
          )}
        </div>
      )}
    </li>
  );
}

/** The subagents a chat's agents started: what each is doing while it runs, and how it ended. Opens to its tool calls. */
export default function Subagents({ rows }: { rows: SubagentRow[] }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-3">
      {rows.map((row) => <SubagentEntry key={row.subagent.id} row={row} />)}
    </ul>
  );
}
