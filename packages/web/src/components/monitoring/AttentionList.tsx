import { MessageSquareText } from "lucide-react";
import type { MonitorTarget, MonitoringOverview } from "../../hooks/useMonitoring";
import { formatTimeAgo } from "../../lib/format";
import PanelTitle from "../dashboard/PanelTitle";
import { GlassCard, IconButton } from "../ui";
import { useChatAbout, warningMessage } from "./chatAbout";
import StatusDot from "./StatusDot";

const rowClass = "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2 text-left text-[13px] first:border-t-0";

// Where a pointer can hover, the chat button waits until the row is hovered or focused; on touch it is always there.
const chatButtonClass = "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100";

/** What to look at first: tracked services that are down or unsure, then the open warnings. A row opens its target; a warning can also start a chat about it. */
export default function AttentionList({ overview, targets, onOpen }: { overview: MonitoringOverview; targets: MonitorTarget[]; onOpen: (key: string) => void }) {
  const { attention, warnings } = overview;
  const chatAbout = useChatAbout();
  return (
    <GlassCard className="min-w-0 p-6 pb-3">
      <PanelTitle title="Needs attention" meta={attention.length + warnings.length || undefined} />
      {!attention.length && !warnings.length && <div className="pb-3 text-[13px] text-text-muted">Nothing needs a look</div>}
      <div className="max-h-[540px] overflow-y-auto">
      {attention.map((a) => (
        <button key={a.key} type="button" onClick={() => onOpen(a.key)} className={`${rowClass} cursor-pointer`}>
          <StatusDot state={a.state} />
          <span className="truncate"><span className="text-text-primary">{a.title}</span>{a.message && <span className="ml-3 text-text-muted">{a.message}</span>}</span>
          <span className="font-mono text-xs text-text-muted">{a.since ? formatTimeAgo(a.since) : ""}</span>
        </button>
      ))}
      {warnings.map((w) => {
        const content = (
          <>
            <span className={`h-1.5 w-1.5 rounded-full ${w.critical ? "bg-error" : "bg-accent"}`} />
            <span className="truncate text-text-secondary">{w.text}</span>
            <span className="font-mono text-xs text-text-muted">{formatTimeAgo(w.firstSeen)}</span>
          </>
        );
        const chat = (
          <IconButton
            label="Chat about this"
            className={chatButtonClass}
            onClick={() => chatAbout(warningMessage(w, targets.find((t) => t.key === w.targetKey)))}
          >
            <MessageSquareText size={16} strokeWidth={1.5} />
          </IconButton>
        );
        return (
          <div key={w.key} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 border-t border-border first:border-t-0">
            {w.targetKey
              ? <button type="button" onClick={() => onOpen(w.targetKey!)} className={`${rowClass} cursor-pointer border-t-0`}>{content}</button>
              : <div className={`${rowClass} border-t-0`}>{content}</div>}
            {chat}
          </div>
        );
      })}
      </div>
    </GlassCard>
  );
}
