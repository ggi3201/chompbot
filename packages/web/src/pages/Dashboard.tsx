import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../lib/api";
import { ChoicePills, GlassCard, LiveDot } from "../components/ui";
import { CurveChart, SparkCurve } from "../components/dashboard/CurveChart";
import Insights, { type InsightsData } from "../components/dashboard/Insights";
import PanelTitle from "../components/dashboard/PanelTitle";
import { RANGE_OPTIONS, RANGE_TICKS, RANGE_TITLES, tipOf, type Range } from "../components/dashboard/ranges";
import { formatTimeAgo } from "../lib/format";

// ─── Types ───

interface Stats {
  messagesToday: number;
}

interface ActivityEntry {
  id: string;
  type: string;
  summary: string;
  details: Record<string, unknown> | null;
  agentUsed: string | null;
  createdAt: string;
}

interface TimeSeries {
  messages: number[];
  activity: number[];
  toolCalls: number[];
  ruleFires: number[];
  memoriesSaved: number[];
  failedRuns: number[];
  hours: string[];
  totalMessages: number;
  totalActivity: number;
}

interface ActiveSession {
  sessionId: string;
  agentName: string;
  agentType: string;
  runtimeSeconds: number;
  outputBytes: number;
}

// ─── Chart ───

function MainChart({ series, range }: { series: TimeSeries; range: Range }) {
  const dates = series.hours.map((h) => new Date(h));
  return (
    <CurveChart
      label={`Messages and agent activity, ${RANGE_TITLES[range].toLowerCase()}`}
      ticks={dates.map(RANGE_TICKS[range])}
      tips={dates.map(tipOf)}
      series={[
        { key: "messages", label: "Messages", color: "#f2a33a", data: series.messages, lead: true },
        { key: "activity", label: "Agent activity", color: "#5c5c62", data: series.activity },
        { key: "ruleFires", label: "Rules fired", color: "#3f88d4", data: series.ruleFires },
        { key: "memoriesSaved", label: "Memories saved", color: "#b85c8c", data: series.memoriesSaved },
        { key: "failedRuns", label: "Failed runs", color: "#e5484d", data: series.failedRuns },
        // Off by default: at over 100 an hour it flattens everything else.
        { key: "toolCalls", label: "Tool calls", color: "#d4d4d8", data: series.toolCalls, hidden: true },
      ]}
    />
  );
}

// ─── Rows ───


const formatCount = (n: number) => n.toLocaleString("en-GB");

function Stat({ label, value, note, spark, highlight }: { label: string; value: string; note: string; spark?: number[]; highlight?: boolean }) {
  return (
    <GlassCard className="p-5 flex flex-col gap-2 min-w-0">
      <div className="text-[13px] text-text-secondary">{label}</div>
      <div className={`text-[32px] leading-none font-medium tabular-nums ${highlight ? "text-accent-ink" : "text-text-primary"}`}>{value}</div>
      <div className="font-mono text-xs text-text-muted">{note}</div>
      {spark && <div className="mt-1"><SparkCurve values={spark} /></div>}
    </GlassCard>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] text-text-muted">{children}</div>;
}

// ─── Main Dashboard ───

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [range, setRange] = useState<Range>("24h");
  const [timeseries, setTimeseries] = useState<TimeSeries | null>(null);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [statsRes, tsRes, insightsRes, activeRes, activityRes] = await Promise.all([
        apiFetch("/dashboard/stats"),
        apiFetch(`/dashboard/timeseries?range=${range}`),
        apiFetch("/dashboard/insights"),
        apiFetch("/agent-monitor/active"),
        apiFetch("/dashboard/activity?limit=12"),
      ]);

      if (statsRes.ok) setStats(await statsRes.json());
      if (tsRes.ok) setTimeseries(await tsRes.json());
      if (insightsRes.ok) setInsights(await insightsRes.json());
      if (activeRes.ok) {
        const data = await activeRes.json();
        setActiveSessions(data.sessions ?? []);
      }
      if (activityRes.ok) setActivity(await activityRes.json());
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    loadData();
    // Refresh every 30s
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const runningCount = activeSessions.length;
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const tiles = insights?.tiles;

  if (loading) {
    return <div className="p-8 text-text-muted">Loading</div>;
  }

  return (
    <div className="p-4 md:p-8 flex flex-col gap-6 max-w-[1600px]">
      <div className="flex flex-wrap items-end gap-4">
        <h2 className="text-[28px] leading-tight font-medium m-0">{today}</h2>
        {runningCount > 0 && (
          <div className="ml-auto flex items-center gap-2 font-mono text-xs text-text-muted">
            <LiveDot />
            {runningCount} {runningCount === 1 ? "agent" : "agents"} running
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Messages today" value={formatCount(stats?.messagesToday ?? 0)} note={tiles ? `${formatCount(tiles.messagesYesterday)} yesterday` : ""} spark={tiles?.spark.messages} highlight />
        <Stat label="Agent runs, 7 days" value={formatCount(tiles?.runs7 ?? 0)} note={tiles ? `${formatCount(tiles.runsWeekBefore)} the week before` : ""} spark={tiles?.spark.runs} />
        <Stat label="Success rate, 30 days" value={tiles?.successRate30 == null ? "–" : `${Math.round(tiles.successRate30 * 100)}%`} note={tiles ? `of ${formatCount(tiles.runs30)} runs` : ""} spark={tiles?.spark.successRate} />
        <Stat label="Agent hours, 7 days" value={tiles ? tiles.agentHours7.toFixed(1) : "0"} note="machine time, not yours" spark={tiles?.spark.agentHours} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3">
        <GlassCard className="p-6 min-w-0 flex flex-col">
          <PanelTitle title={RANGE_TITLES[range]} meta={<ChoicePills options={RANGE_OPTIONS} value={range} onChange={(id) => setRange(id as Range)} />} />
          {timeseries ? <MainChart series={timeseries} range={range} /> : <Empty>No data yet</Empty>}
        </GlassCard>

        <GlassCard className="p-6 pb-2 min-w-0">
          <PanelTitle title="Activity" />
          {activity.length === 0 ? (
            <Empty>No recent activity</Empty>
          ) : (
            activity.map((item) => (
              <div key={item.id} className="grid grid-cols-[64px_1fr_auto] gap-2 items-center py-2 border-t border-border first:border-t-0 text-[13px]">
                <span className="font-mono text-xs text-text-muted">{formatTimeAgo(item.createdAt)}</span>
                <span className="truncate text-text-secondary">{item.summary}</span>
                <span className="font-mono text-xs text-text-muted">{item.type.split(".").pop()}</span>
              </div>
            ))
          )}
        </GlassCard>
      </div>

      {insights && <Insights data={insights} />}
    </div>
  );
}
