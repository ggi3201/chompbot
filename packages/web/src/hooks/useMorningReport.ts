import { useEffect, useState } from "react";

export interface WeekItem {
  title: string;
  time?: string;
  kind: "event" | "match";
  crest?: string;
  detail?: string;
}

export interface WeekDay {
  date: string;
  items: WeekItem[];
}

export interface MorningReport {
  date: string;
  place: string;
  headline: string;
  lead: string;
  headsUp: string[];
  weather?: { summary: string; high?: number; low?: number; sunrise?: string; sunset?: string };
  take?: { title: string; body: string; url: string };
  news: { title: string; why?: string; source?: string; url: string }[];
  inbox: { from: string; subject: string; action?: string }[];
  suggestions: string[];
}

export interface MorningPayload {
  report: MorningReport | null;
  conversationId: string;
  hasVoice: boolean;
  week: { days: WeekDay[]; missing: string[] };
}

export type MorningState =
  | { status: "loading" }
  | { status: "denied" }
  | { status: "failed" }
  | { status: "ready"; payload: MorningPayload };

/** Not apiFetch: this page opens from a Telegram link, with its key instead of a login. */
export function useMorningReport(date: string, key: string): MorningState {
  const [state, setState] = useState<MorningState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetch(`/api/goodmorning/${date}?key=${encodeURIComponent(key)}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) return setState({ status: "denied" });
        if (!response.ok) return setState({ status: "failed" });
        setState({ status: "ready", payload: (await response.json()) as MorningPayload });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          console.error("[goodmorning]", err);
          setState({ status: "failed" });
        }
      });
    return () => controller.abort();
  }, [date, key]);

  return state;
}
