import "@fontsource-variable/newsreader/opsz.css";
import { useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { MotionConfig, motion } from "motion/react";
import { ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { setConversationDraft } from "../hooks/useDraft";
import { useMorningReport, type MorningReport, type WeekDay, type WeekItem } from "../hooks/useMorningReport";

const EASE = [0.22, 1, 0.36, 1] as const;
const DAY_MS = 86_400_000;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

/** Today on this device. Links from Telegram carry their date, so this only applies to a bare /goodmorning. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function formatDate(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(new Date(`${date}T00:00:00Z`));
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function Rise({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function DayLink({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <Link to={to} aria-label={label} className={`grid size-8 place-items-center rounded text-ink-soft transition-colors hover:bg-paper-raised hover:text-ink ${FOCUS}`}>
      {children}
    </Link>
  );
}

function Masthead({ date, pageKey, report }: { date: string; pageKey: string; report: MorningReport | null }) {
  const dayLink = (days: number) => `/goodmorning?date=${shiftDate(date, days)}&key=${encodeURIComponent(pageKey)}`;
  const weather = report?.weather;
  const temperatures = [weather?.high, weather?.low].filter((t) => t !== undefined).map((t) => `${t}°`).join(" / ");
  const daylight = weather?.sunrise && weather.sunset ? `Light ${weather.sunrise} to ${weather.sunset}` : null;
  const meta = [report?.place, weather?.summary, temperatures, daylight].filter(Boolean);

  return (
    <header className="flex items-start justify-between gap-6 border-b border-ink py-4 font-mono text-xs leading-5 text-ink-soft">
      <div className="flex flex-col gap-1 md:flex-row md:gap-6">
        <span className="text-ink">{formatDate(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
        {meta.length > 0 && <span>{meta.join(" · ")}</span>}
      </div>
      <nav className="-my-2 flex shrink-0" aria-label="Other days">
        <DayLink to={dayLink(-1)} label="Previous day"><ChevronLeft size={16} strokeWidth={1.5} /></DayLink>
        <DayLink to={dayLink(1)} label="Next day"><ChevronRight size={16} strokeWidth={1.5} /></DayLink>
      </nav>
    </header>
  );
}

function Listen({ src }: { src: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(Number.NaN);
  const progress = duration > 0 ? position / duration : 0;

  const toggle = () => {
    if (playing) audio.current?.pause();
    else void audio.current?.play();
  };

  return (
    <div className="flex items-center gap-4">
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
      />
      <button
        type="button"
        onClick={toggle}
        className={`flex h-12 shrink-0 items-center gap-2 rounded-lg bg-ink pr-5 pl-4 font-mono text-sm text-paper transition-[transform,background-color] hover:bg-ink-soft active:scale-[0.98] ${FOCUS}`}
      >
        {playing ? <Pause size={16} strokeWidth={1.5} /> : <Play size={16} strokeWidth={1.5} />}
        {playing ? "Pause" : "Listen"}
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="relative h-px flex-1 bg-rule" role="progressbar" aria-label="Voice note progress" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <motion.div className="absolute inset-x-0 -top-px h-[3px] origin-left bg-signal" animate={{ scaleX: progress }} initial={false} transition={{ duration: 0.25, ease: "linear" }} />
        </div>
        <span className="font-mono text-xs tabular-nums text-ink-muted">{formatClock(playing || position > 0 ? position : duration)}</span>
      </div>
    </div>
  );
}

function Lead({ report }: { report: MorningReport }) {
  const dateline = `${report.place}, ${formatDate(report.date, { weekday: "long" })}`;
  const [first, ...rest] = report.lead.split(/\n\s*\n/);
  return (
    <div className="flex max-w-[62ch] flex-col gap-4 font-paper text-xl leading-[1.5] text-ink">
      <p>
        <span className="font-medium">{dateline} —</span> {first}
      </p>
      {rest.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="border-t border-ink pt-2 pb-4 font-mono text-xs leading-5 text-ink">{children}</h2>;
}

function TideItem({ item }: { item: WeekItem }) {
  if (item.kind === "match") {
    return (
      <li className="flex items-start gap-3 lg:flex-col lg:gap-2">
        {item.crest && <img src={item.crest} alt="" className="size-12 shrink-0 object-contain lg:size-14" />}
        <div>
          <p className="font-mono text-xs leading-5 tabular-nums text-signal">{item.time}</p>
          <p className="text-sm leading-5 font-medium text-ink">{item.title}</p>
          {item.detail && <p className="text-xs leading-4 text-ink-muted">{item.detail}</p>}
        </div>
      </li>
    );
  }
  return (
    <li>
      {item.time && <p className="font-mono text-xs leading-5 tabular-nums text-ink-muted">{item.time}</p>}
      <p className={`text-sm leading-5 text-ink ${item.time ? "" : "font-medium"}`}>{item.title}</p>
    </li>
  );
}

function TideDay({ day, isToday, index }: { day: WeekDay; isToday: boolean; index: number }) {
  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.25 + index * 0.04, ease: EASE }}
      className={`grid grid-cols-[64px_1fr] gap-4 border-t py-3 lg:flex lg:flex-col lg:gap-4 lg:border-t-[3px] lg:pt-3 lg:pb-0 ${isToday ? "border-signal" : "border-rule lg:border-ink"}`}
    >
      <div className="flex flex-col">
        <span className={`font-mono text-xs leading-5 ${isToday ? "text-signal" : "text-ink-muted"}`}>{formatDate(day.date, { weekday: "short" })}</span>
        <span className={`font-paper text-4xl leading-none tabular-nums ${isToday ? "text-signal" : "text-ink"}`}>{formatDate(day.date, { day: "numeric" })}</span>
      </div>
      <ul className="flex min-w-0 flex-col gap-3">
        {day.items.map((item) => (
          <TideItem key={`${item.time ?? "all-day"}-${item.title}`} item={item} />
        ))}
      </ul>
    </motion.li>
  );
}

function Week({ days, missing, reportDate }: { days: WeekDay[]; missing: string[]; reportDate: string }) {
  return (
    <section aria-label="The week">
      <div className="flex items-baseline justify-between gap-4 pb-4">
        <h2 className="font-paper text-3xl leading-tight text-ink">The week</h2>
        {missing.length > 0 && <p className="font-mono text-xs leading-5 text-signal">No {missing.join(" or ")} right now, so this may be missing things</p>}
      </div>
      <ol className="grid grid-cols-1 lg:grid-cols-7 lg:gap-4">
        {days.map((day, index) => (
          <TideDay key={day.date} day={day} isToday={day.date === reportDate} index={index} />
        ))}
      </ol>
    </section>
  );
}

function HeadsUp({ items }: { items: string[] }) {
  return (
    <section>
      <SectionTitle>Before you go</SectionTitle>
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item} className="font-paper text-lg leading-snug text-ink">{item}</li>
        ))}
      </ul>
    </section>
  );
}

function Take({ take }: { take: NonNullable<MorningReport["take"]> }) {
  return (
    <section>
      <SectionTitle>One take</SectionTitle>
      <a href={take.url} target="_blank" rel="noreferrer" className={`group flex flex-col gap-3 ${FOCUS}`}>
        <h3 className="font-paper text-3xl leading-[1.15] text-ink transition-colors group-hover:text-signal md:text-4xl">
          {take.title}
          <ArrowUpRight size={18} strokeWidth={1.5} className="ml-1 inline-block align-baseline text-ink-muted" />
        </h3>
        <p className="max-w-[56ch] font-paper text-lg leading-normal text-ink-soft">{take.body}</p>
      </a>
    </section>
  );
}

function News({ items }: { items: MorningReport["news"] }) {
  return (
    <section>
      <SectionTitle>Elsewhere</SectionTitle>
      <ul className="flex flex-col gap-4">
        {items.map((item) => (
          <li key={item.url}>
            <a href={item.url} target="_blank" rel="noreferrer" className={`group block ${FOCUS}`}>
              <p className="font-paper text-lg leading-snug text-ink transition-colors group-hover:text-signal">{item.title}</p>
              {item.why && <p className="pt-1 text-sm leading-5 text-ink-soft">{item.why}</p>}
              {item.source && <p className="pt-1 font-mono text-xs leading-4 text-ink-muted">{item.source}</p>}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Inbox({ items }: { items: MorningReport["inbox"] }) {
  return (
    <section>
      <SectionTitle>Waiting on you</SectionTitle>
      <ul className="flex flex-col gap-4">
        {items.map((item) => (
          <li key={`${item.from}-${item.subject}`}>
            <p className="font-mono text-xs leading-5 text-ink-muted">{item.from}</p>
            <p className="text-sm leading-5 text-ink">{item.subject}</p>
            {item.action && <p className="pt-1 text-sm leading-5 text-ink-soft">{item.action}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Act({ conversationId, suggestions }: { conversationId: string; suggestions: string[] }) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");

  const openInChomp = (event: React.FormEvent) => {
    event.preventDefault();
    setConversationDraft(conversationId, prompt.trim());
    navigate(`/chat/${conversationId}`);
  };

  return (
    <form onSubmit={openInChomp} className="flex flex-col gap-4">
      <label htmlFor="act" className="font-paper text-3xl leading-tight text-ink">What should we do about it</label>
      <textarea
        id="act"
        rows={2}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Anything. Chomp has read this edition"
        className="w-full resize-none border-y border-ink bg-transparent py-3 font-paper text-xl leading-normal text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-signal"
      />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <button type="submit" className={`flex h-12 shrink-0 items-center rounded-lg bg-ink px-5 font-mono text-sm text-paper transition-[transform,background-color] hover:bg-ink-soft active:scale-[0.98] ${FOCUS}`}>
          Continue in Chomp
        </button>
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => setPrompt(suggestion)} className={`py-2 text-left text-sm leading-5 text-ink-soft underline decoration-rule underline-offset-4 transition-colors hover:text-signal ${FOCUS}`}>
            {suggestion}
          </button>
        ))}
      </div>
    </form>
  );
}

function Message({ headline, body }: { headline: string; body?: string }) {
  return (
    <Rise className="flex flex-col gap-4 py-16 md:py-24">
      <h1 className="max-w-[16ch] font-paper text-5xl leading-[1.04] tracking-[-0.02em] text-balance text-ink md:text-7xl">{headline}</h1>
      {body && <p className="max-w-[56ch] font-paper text-xl leading-normal text-ink-soft">{body}</p>}
    </Rise>
  );
}

export default function GoodMorning() {
  const [params] = useSearchParams();
  const date = params.get("date") ?? today();
  const key = params.get("key") ?? "";
  const state = useMorningReport(date, key);
  const payload = state.status === "ready" ? state.payload : null;
  const report = payload?.report ?? null;
  const hasColumns = report && (report.take || report.news.length > 0 || report.inbox.length > 0);

  return (
    <MotionConfig reducedMotion="user">
      <div className="fixed inset-0 overflow-y-auto bg-paper font-body text-ink">
        <main className="mx-auto flex min-h-full max-w-[1320px] flex-col px-5 pb-16 md:px-10">
          <Masthead date={date} pageKey={key} report={report} />

          {state.status === "denied" && <Message headline="This link has lost its key" body="Open today's paper from the Telegram message." />}
          {state.status === "failed" && <Message headline="The paper did not arrive" body="Chomp could not load this page. Try again in a moment." />}
          {payload && !report && <Message headline="Nothing was printed for this day" />}

          {report && (
            <>
              <Rise className="pt-10 pb-8 md:pt-16 md:pb-12">
                <h1 className="max-w-[20ch] font-paper text-[clamp(3rem,8.4vw,7.5rem)] leading-[0.98] tracking-[-0.025em] text-balance text-ink">
                  {report.headline}
                </h1>
              </Rise>

              <Rise delay={0.08} className="grid gap-10 pb-16 lg:grid-cols-12 lg:gap-4">
                <div className="flex flex-col gap-8 lg:col-span-8">
                  {payload?.hasVoice && (
                    <div className="max-w-[62ch]">
                      <Listen src={`/api/goodmorning/${date}/voice.mp3?key=${encodeURIComponent(key)}`} />
                    </div>
                  )}
                  <Lead report={report} />
                </div>
                {report.headsUp.length > 0 && (
                  <div className="lg:col-span-4">
                    <HeadsUp items={report.headsUp} />
                  </div>
                )}
              </Rise>
            </>
          )}

          {payload && <Week days={payload.week.days} missing={payload.week.missing} reportDate={date} />}

          {hasColumns && (
            <Rise delay={0.2} className="grid gap-12 pt-16 lg:grid-cols-12 lg:gap-4">
              {report.take && <div className="lg:col-span-6"><Take take={report.take} /></div>}
              {report.news.length > 0 && <div className="lg:col-span-3"><News items={report.news} /></div>}
              {report.inbox.length > 0 && <div className="lg:col-span-3"><Inbox items={report.inbox} /></div>}
            </Rise>
          )}

          {payload && report && (
            <Rise delay={0.2} className="max-w-[62ch] pt-16">
              <Act conversationId={payload.conversationId} suggestions={report.suggestions} />
            </Rise>
          )}
        </main>
      </div>
    </MotionConfig>
  );
}
