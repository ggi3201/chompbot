import type { ChatItem } from "@chomp/shared";
import type { OrbState } from "thinking-orbs";

const WAITING: Record<string, OrbState> = {
  triaging: "connecting",
  routing: "connecting",
  researching: "searching",
  streaming: "composing",
  agent_working: "working",
};

/** Tools that look things up rather than change them. */
const LOOKUP_TOOL = /search|grep|glob|read|fetch|find|list|recall|^get_/i;

/** What the orb shows: what the latest item is doing right now, else what the turn is waiting on. */
export function orbStateFor(status: string | null | undefined, latest: ChatItem | undefined): OrbState {
  switch (latest?.kind) {
    case "reasoning":
      if (latest.streaming) return "solving";
      break;
    case "assistant_text":
      if (latest.streaming) return "composing";
      break;
    case "tool_call":
      if (latest.status === "running") return LOOKUP_TOOL.test(latest.tool) ? "searching" : "working";
      break;
    case "command":
      if (latest.status === "running") return "working";
      break;
    case "file_change":
      if (latest.status === "running") return "shaping";
      break;
    case "subagent":
      if (latest.status === "running") return "weaving";
      break;
  }
  return (status && WAITING[status]) || "breathing";
}
