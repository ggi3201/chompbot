import { GlassCard } from "../ui";
import { CurveChart, Note, useSize, type CurveSeries } from "./CurveChart";

export interface InsightsData {
  tiles: {
    runs7: number;
    runsWeekBefore: number;
    runs30: number;
    successRate30: number | null;
    agentHours7: number;
    messagesYesterday: number;
    spark: { messages: number[]; runs: number[]; successRate: number[]; agentHours: number[] };
  };
  today: string;
  daily: Record<string, number>;
  punchcard: number[][];
  weekly: Array<{ week: string; completed: number; killed: number; failed: number; opus: number; sonnet: number; gpt: number; other: number }>;
  durations: { labels: string[]; counts: number[]; p50: number; p90: number; total: number };
  rules: { outcomes: Array<{ outcome: string; count: number }>; top: Array<{ name: string; count: number }> };
  memoryGrowth: Array<{ week: string; total: number }>;
  tools: Array<{ name: string; count: number }>;
  toolsSince: string | null;
  context: { conversations: number; groups: Array<{ name: string; tokens: number }> };
}

const EMBER = "#f2a33a";
const NEUTRAL = "#5c5c62";
const BLUE = "#3f88d4";
const MAGENTA = "#b85c8c";
const FAILED = "#e5484d";
// One hue, dark to bright. Thresholds are hand-set per chart so a single huge day does not flatten the rest.
const RAMP = ["#3f2d16", "#6e4a18", "#a56c1c", "#d68f2c", "#f8c070"];
const EMPTY = "rgba(255,255,255,0.05)";
const CALENDAR_STEPS = [3, 10, 25, 60];
const CALENDAR_LEGEND = ["1–3", "4–10", "11–25", "26–60", "60+"];
const PUNCHCARD_STEPS = [3, 10, 25, 50];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const RULE_OUTCOMES: Record<string, string> = {
  fired: "Fired",
  error: "Error",
  skipped_cooldown: "Skipped: cooldown",
  skipped_guard: "Skipped: guard",
  skipped_active_hours: "Skipped: active hours",
  skipped_script_gate: "Skipped: script gate",
  skipped_rate_limit: "Skipped: rate limit",
};

const count = (n: number) => n.toLocaleString("en-GB");
const shortDate = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};
const shade = (value: number, steps: number[]) => {
  if (!value) return EMPTY;
  const level = steps.findIndex((step) => value <= step);
  return RAMP[level === -1 ? RAMP.length - 1 : level];
};

function Panel({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <GlassCard className="p-6 min-w-0">
      <div className="flex items-baseline gap-3 mb-3">
        <h3 className="text-[15px] font-medium m-0">{title}</h3>
        {meta && <div className="ml-auto font-mono text-xs text-text-muted text-right">{meta}</div>}
      </div>
      {children}
    </GlassCard>
  );
}

function Bars({ rows }: { rows: Array<{ label: string; value: number; text?: string; muted?: boolean }> }) {
  const top = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="flex items-baseline gap-3 mb-1">
            <span className="text-[13px] text-text-secondary truncate">{row.label}</span>
            <span className="ml-auto font-mono text-xs text-text-muted tabular-nums">{row.text ?? count(row.value)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-raised overflow-hidden">
            {/* A real but tiny count still gets a visible sliver. */}
            <div className={`h-full rounded-full ${row.muted ? "bg-[#5c5c62]" : "bg-accent"}`} style={{ width: `${Math.max((row.value / top) * 100, 0.8)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function RunCalendar({ daily, today }: { daily: Record<string, number>; today: string }) {
  const [ref, { width }] = useSize();
  const LEFT = 30;
  const GAP = 2;
  const TOP = 18;
  // Shows as many weeks as fit, never more than the data holds, with a floor on cell size so a phone gets fewer weeks and not specks.
  const end = new Date(`${today}T12:00:00Z`);
  const days = Object.keys(daily).sort();
  const thisMonday = end.getTime() - ((end.getUTCDay() + 6) % 7) * 864e5;
  const firstData = days[0] ? new Date(`${days[0]}T12:00:00Z`).getTime() : end.getTime();
  const weeksOfData = Math.floor((thisMonday - firstData) / (7 * 864e5)) + 2;
  const weeks = Math.max(1, Math.min(weeksOfData, 53, Math.floor((width - LEFT) / 14)));
  const cell = Math.min(30, Math.floor((width - LEFT) / weeks) - GAP);
  const cells = [];
  for (let column = 0; column < weeks; column++) {
    for (let row = 0; row < 7; row++) {
      const time = thisMonday + (column - weeks + 1) * 7 * 864e5 + row * 864e5;
      if (time > end.getTime()) continue;
      const day = new Date(time).toISOString().slice(0, 10);
      const px = LEFT + column * (cell + GAP);
      cells.push(
        <rect key={day} x={px} y={TOP + row * (cell + GAP)} width={cell} height={cell} rx={2} fill={shade(daily[day] ?? 0, CALENDAR_STEPS)}>
          <title>{`${shortDate(day)}: ${count(daily[day] ?? 0)} runs`}</title>
        </rect>,
      );
      if (row === 0 && new Date(time).getUTCDate() <= 7) {
        cells.push(<text key={`m${day}`} x={px} y={11} className="fill-text-muted font-mono text-[11px]">{new Date(time).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}</text>);
      }
    }
  }
  return (
    <>
      <div ref={ref}>
        {width > 0 && (
          <svg width={width} height={TOP + 7 * (cell + GAP)} className="block" role="img" aria-label="Agent runs per day">
            {["Mon", "Wed", "Fri"].map((day, i) => (
              <text key={day} x={0} y={TOP + i * 2 * (cell + GAP) + cell - 2} className="fill-text-muted font-mono text-[11px]">{day}</text>
            ))}
            {cells}
          </svg>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 mt-2 font-mono text-xs text-text-muted">
        <span>runs a day</span>
        <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-xs bg-white/5" />0</span>
        {CALENDAR_LEGEND.map((label, i) => (
          <span key={label} className="flex items-center gap-1.5"><i className="size-2.5 rounded-xs" style={{ backgroundColor: RAMP[i] }} />{label}</span>
        ))}
      </div>
    </>
  );
}

function Punchcard({ data }: { data: number[][] }) {
  const [ref, { width }] = useSize();
  const LEFT = 30;
  const HEIGHT = 212;
  const cellW = (width - LEFT) / 24;
  const cellH = (HEIGHT - 16) / 7;
  return (
    <div ref={ref} style={{ height: HEIGHT }}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} className="block" role="img" aria-label="Your messages by weekday and hour">
          {data.map((hours, day) => (
            <g key={day}>
              <text x={0} y={day * cellH + cellH / 2 + 3} className="fill-text-muted font-mono text-[11px]">{WEEKDAYS[day]}</text>
              {hours.map((value, hour) => (
                <rect key={hour} x={LEFT + hour * cellW} y={day * cellH} width={Math.max(1, cellW - 2)} height={cellH - 2} rx={2} fill={shade(value, PUNCHCARD_STEPS)}>
                  <title>{`${LONG_WEEKDAYS[day]} ${String(hour).padStart(2, "0")}:00: ${count(value)} messages`}</title>
                </rect>
              ))}
            </g>
          ))}
          {[0, 6, 12, 18].map((hour) => (
            <text key={hour} x={LEFT + hour * cellW} y={HEIGHT - 2} className="fill-text-muted font-mono text-[11px]">{String(hour).padStart(2, "0")}</text>
          ))}
          <text x={width - 2} y={HEIGHT - 2} textAnchor="end" className="fill-text-muted font-mono text-[11px]">23</text>
        </svg>
      )}
    </div>
  );
}

export default function Insights({ data }: { data: InsightsData }) {
  const weekTicks = data.weekly.map((w) => shortDate(w.week));
  const weekTips = weekTicks.map((tick) => `Week of ${tick}`);
  const series = (key: keyof InsightsData["weekly"][number], label: string, color: string, extra: Partial<CurveSeries> = {}): CurveSeries => ({
    key,
    label,
    color,
    data: data.weekly.map((w) => Number(w[key])),
    ...extra,
  });
  const share = (key: "opus" | "sonnet" | "gpt" | "other", label: string, color: string, extra: Partial<CurveSeries> = {}): CurveSeries => ({
    ...series(key, label, color, extra),
    data: data.weekly.map((w) => {
      const total = w.opus + w.sonnet + w.gpt + w.other;
      return total ? (w[key] / total) * 100 : 0;
    }),
  });

  const totalRuns = Object.values(data.daily).reduce((a, b) => a + b, 0);
  const busiest = Object.entries(data.daily).sort((a, b) => b[1] - a[1])[0];
  const peak = data.punchcard.flatMap((hours, day) => hours.map((value, hour) => ({ day, hour, value }))).sort((a, b) => b.value - a.value)[0];
  const thisWeek = data.weekly[data.weekly.length - 1];
  const runsIn = (w: InsightsData["weekly"][number]) => w.completed + w.killed + w.failed;
  const earlier = data.weekly.slice(0, -1).map(runsIn).sort((a, b) => a - b);
  const modelTotal = (key: "opus" | "sonnet" | "gpt") => data.weekly.reduce((sum, w) => sum + w[key], 0);
  const ruleChecks = data.rules.outcomes.reduce((sum, o) => sum + o.count, 0);
  const ruleFired = data.rules.outcomes.find((o) => o.outcome === "fired")?.count ?? 0;
  const firedShare = ruleChecks ? (ruleFired / ruleChecks) * 100 : 0;
  const overhead = data.context.groups.filter((g) => g.name !== "Messages").reduce((sum, g) => sum + g.tokens, 0);
  const memoryTotal = data.memoryGrowth[data.memoryGrowth.length - 1]?.total ?? 0;
  const memoryThisWeek = memoryTotal - (data.memoryGrowth[data.memoryGrowth.length - 2]?.total ?? 0);

  return (
    <>
      <Panel title="Every agent run, every day" meta={busiest ? `${count(totalRuns)} runs · busiest ${busiest[1]} on ${shortDate(busiest[0])}` : undefined}>
        <RunCalendar daily={data.daily} today={data.today} />
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="When you bother Chomp" meta="your messages, all time">
          <Note>Peak is <b>{LONG_WEEKDAYS[peak.day]} {String(peak.hour).padStart(2, "0")}:00</b>, {count(peak.value)} messages.</Note>
          <Punchcard data={data.punchcard} />
        </Panel>
        <Panel title="Runs per week, by outcome" meta="26 weeks">
          <Note>This week: <b>{count(runsIn(thisWeek))} runs, {count(thisWeek.failed)} failed</b>. The median week before it had {count(earlier[Math.floor(earlier.length / 2)] ?? 0)}.</Note>
          <CurveChart
            label="Agent runs per week by outcome"
            ticks={weekTicks}
            tips={weekTips}
            height={180}
            series={[series("completed", "Completed", EMBER, { lead: true }), series("killed", "Killed", NEUTRAL), series("failed", "Failed", FAILED)]}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="Which brain did the work" meta="share of runs per week">
          <Note>Last 26 weeks: <b>Sonnet {count(modelTotal("sonnet"))}, Opus {count(modelTotal("opus"))}, GPT {count(modelTotal("gpt"))}</b>.</Note>
          <CurveChart
            label="Share of agent runs per model family, per week"
            ticks={weekTicks}
            tips={weekTips}
            height={180}
            max={100}
            unit="%"
            series={[share("opus", "Opus", EMBER, { lead: true }), share("sonnet", "Sonnet", BLUE), share("gpt", "GPT", MAGENTA), share("other", "Other", NEUTRAL, { hidden: true })]}
          />
        </Panel>
        <Panel title="How long a turn takes" meta="completed, 90 days">
          <Note>Median <b>{duration(data.durations.p50)}</b>, 90% done by <b>{duration(data.durations.p90)}</b>, over {count(data.durations.total)} turns.</Note>
          <CurveChart
            label="Completed turns by duration"
            ticks={data.durations.labels}
            height={212}
            series={[{ key: "turns", label: "Turns", color: EMBER, lead: true, data: data.durations.counts }]}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel title="Rules: checks vs action" meta="30 days">
          <div className="text-[44px] leading-none font-medium tabular-nums mb-1">{firedShare.toFixed(2)}%</div>
          <Note>of <b>{count(ruleChecks)}</b> checks did anything. The rest is your rule engine deciding not to.</Note>
          <Bars rows={data.rules.outcomes.map((o) => ({ label: RULE_OUTCOMES[o.outcome] ?? o.outcome, value: o.count, muted: o.outcome !== "fired" }))} />
        </Panel>
        <Panel title="Who actually fires" meta="30 days">
          <Bars rows={data.rules.top.map((r) => ({ label: r.name.replace(/\s*\(.*$/, ""), value: r.count }))} />
        </Panel>
        <Panel title="What a conversation weighs" meta="avg tokens">
          <Note><b>{Math.round(overhead / 1000)}k tokens</b> are spent before anyone says hello, across {count(data.context.conversations)} recent chats.</Note>
          <Bars rows={data.context.groups.map((g) => ({ label: g.name, value: g.tokens, text: `${Math.round(g.tokens / 1000)}k`, muted: g.name === "Messages" }))} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="What Chomp remembers" meta={`${count(memoryTotal)} active`}>
          <Note><b>{count(memoryThisWeek)} saved this week.</b> Merged or retired memories drop out, so this shows what survived.</Note>
          <CurveChart
            label="Active memories over time"
            ticks={data.memoryGrowth.map((m) => shortDate(m.week))}
            tips={data.memoryGrowth.map((m) => `Week of ${shortDate(m.week)}`)}
            height={200}
            series={[{ key: "memories", label: "Memories", color: EMBER, lead: true, data: data.memoryGrowth.map((m) => m.total) }]}
          />
        </Panel>
        <Panel title="What agents actually do" meta={data.toolsSince ? `since ${shortDate(data.toolsSince.slice(0, 10))}` : undefined}>
          <Bars rows={data.tools.map((t) => ({ label: t.name, value: t.count }))} />
        </Panel>
      </div>
    </>
  );
}
