/**
 * Canvas → channel-native rendering.
 *
 * The web chat UI parses `:::canvas\n{...}\n:::` fenced blocks and renders rich
 * React components (see CanvasRenderer.tsx). Other channels (Telegram, Discord)
 * have no such renderer, so the JSON would be useless noise.
 *
 * This module converts each canvas block to channel-native markdown — bold values,
 * native tables, unicode bars, blockquotes — so non-web channels still get a useful
 * representation. Replaces stripCanvasBlocks() at outbound time.
 */

const CANVAS_BLOCK_RE = /:::canvas[^\n]*\n([\s\S]*?)\n:::[ \t]*/g;

type CanvasJSON = Record<string, unknown>;

export type ChannelKind = "telegram" | "discord";

/**
 * Replace every `:::canvas...:::` block in `text` with a channel-native markdown
 * rendering. Falls back to deletion for malformed JSON or unknown types.
 */
export function renderCanvasForChannel(text: string, channel: ChannelKind): string {
  if (!text.includes(":::canvas")) return text;
  const out = text.replace(CANVAS_BLOCK_RE, (_match, body: string) => {
    const trimmed = body.trim();
    let json: CanvasJSON;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return ""; // malformed → strip, same as the legacy behaviour
    }
    const rendered = renderBlock(json, channel);
    return rendered ? "\n\n" + rendered + "\n\n" : "";
  });
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function renderBlock(b: CanvasJSON, channel: ChannelKind): string {
  const type = b.type as string | undefined;
  switch (type) {
    case "info-card": return renderInfoCard(b);
    case "metric-grid": return renderMetricGrid(b);
    case "data-table": return renderDataTable(b, channel);
    case "progress-bar": return renderProgressBar(b);
    case "link-list": return renderLinkList(b);
    case "bar-chart": return renderBarChart(b);
    case "line-chart": return renderLineChart(b);
    case "slider": return renderSlider(b);
    case "artifact": return `🧩 **${asStr(b.title) || "Artifact"}** (open in web chat)`;
    case "sketchpad": return `✏️ **${asStr(b.title) || "Sketch"}** (open in web chat)`;
    case "embed": return `[${asStr(b.title) || "Open"}](${asStr(b.url)})`;
    case "button": return `[${asStr(b.label)}]`;
    case "choice": return renderChoice(b);
    case "form": return renderForm(b);
    case "tabs": return renderTabs(b);
    case "sparkline": return renderSparkline(b);
    case "timeline": return renderTimeline(b);
    case "donut-chart": return renderDonut(b);
    case "heatmap": return renderHeatmap(b);
    case "callout": return renderCallout(b);
    case "countdown": return renderCountdown(b);
    case "radar-chart": return renderRadar(b);
    case "pixel-canvas": return renderPixelCanvas(b);
    case "drawing-canvas": return renderDrawingCanvas(b);
    default: return "";
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function changeArrow(change: string | undefined): string {
  if (!change) return "";
  const trimmed = change.trim();
  if (trimmed.startsWith("+")) return ` 📈 ${trimmed}`;
  if (trimmed.startsWith("-")) return ` 📉 ${trimmed}`;
  return ` ${trimmed}`;
}

function unicodeBar(percent: number, width = 12): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

const SPARK_CHARS = "▁▂▃▄▅▆▇█";
function sparklineChars(values: number[]): string {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v) => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor(((v - min) / range) * SPARK_CHARS.length))])
    .join("");
}

// ── Per-type adapters ───────────────────────────────────────────

function renderInfoCard(b: CanvasJSON): string {
  const title = asStr(b.title);
  const value = asStr(b.value);
  const subtitle = asStr(b.subtitle);
  const change = asStr(b.change);
  const lines = [`**${title}**`, `${value}${changeArrow(change)}`];
  if (subtitle) lines.push(`_${subtitle}_`);
  return lines.join("\n");
}

interface MetricItem { title?: string; value?: string; subtitle?: string; change?: string }

function renderMetricGrid(b: CanvasJSON): string {
  const items = (b.items as MetricItem[] | undefined) ?? [];
  if (!items.length) return "";
  return items
    .map((it) => {
      const title = asStr(it.title);
      const value = asStr(it.value);
      const subtitle = asStr(it.subtitle);
      const change = asStr(it.change);
      const sub = subtitle ? ` _(${subtitle})_` : "";
      return `• **${title}** — ${value}${changeArrow(change)}${sub}`;
    })
    .join("\n");
}

function renderDataTable(b: CanvasJSON, channel: ChannelKind): string {
  const title = asStr(b.title);
  const headers = (b.headers as string[] | undefined) ?? [];
  const rows = (b.rows as string[][] | undefined) ?? [];
  if (!headers.length || !rows.length) return title ? `**${title}**` : "";
  const head = title ? `**${title}**\n\n` : "";
  // Discord supports markdown tables natively in 2024+; Telegram does not.
  // Telegram-friendly fallback is a per-row bullet list.
  if (channel === "discord") {
    const headerLine = `| ${headers.join(" | ")} |`;
    const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
    const bodyLines = rows.map((r) => `| ${r.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
    return head + [headerLine, sepLine, ...bodyLines].join("\n");
  }
  // Telegram: bullet list, one row per group with header→value pairs
  const grouped = rows
    .map((r) =>
      headers
        .map((h, i) => `  • _${h}:_ ${r[i] ?? ""}`)
        .join("\n"),
    )
    .join("\n\n");
  return head + grouped;
}

function renderProgressBar(b: CanvasJSON): string {
  const label = asStr(b.label);
  const value = asNum(b.value);
  const max = asNum(b.max, 100);
  const pct = (value / max) * 100;
  const showPercent = b.showPercent !== false;
  const pctText = showPercent ? ` ${Math.round(pct)}%` : "";
  return `**${label}**\n\`${unicodeBar(pct)}\`${pctText} (${value} / ${max})`;
}

interface LinkItem { label?: string; url?: string; description?: string }

function renderLinkList(b: CanvasJSON): string {
  const title = asStr(b.title);
  const items = (b.items as LinkItem[] | undefined) ?? [];
  if (!items.length) return title ? `**${title}**` : "";
  const head = title ? `**${title}**\n` : "";
  return (
    head +
    items
      .map((it) => {
        const label = asStr(it.label);
        const url = asStr(it.url);
        const desc = asStr(it.description);
        const link = url ? `[${label || url}](${url})` : label;
        return desc ? `• ${link} — _${desc}_` : `• ${link}`;
      })
      .join("\n")
  );
}

interface Bar { label?: string; value?: number }

function renderBarChart(b: CanvasJSON): string {
  const title = asStr(b.title);
  const bars = (b.bars as Bar[] | undefined) ?? [];
  if (!bars.length) return title ? `**${title}**` : "";
  const max = Math.max(...bars.map((x) => asNum(x.value)), 0) || 1;
  const head = title ? `**${title}**\n` : "";
  const longestLabel = Math.max(...bars.map((x) => asStr(x.label).length));
  return (
    head +
    bars
      .map((x) => {
        const label = asStr(x.label).padEnd(Math.min(longestLabel, 16));
        const value = asNum(x.value);
        const pct = (value / max) * 100;
        return `\`${label} ${unicodeBar(pct, 10)}\` ${value}`;
      })
      .join("\n")
  );
}

interface Series { label?: string; data?: number[] }

function renderLineChart(b: CanvasJSON): string {
  const title = asStr(b.title);
  const series = (b.series as Series[] | undefined) ?? [];
  if (!series.length) return title ? `**${title}**` : "";
  const head = title ? `**${title}**\n` : "";
  return (
    head +
    series
      .map((s) => {
        const label = asStr(s.label) || "series";
        const data = s.data ?? [];
        if (!data.length) return `• **${label}** — (no data)`;
        const spark = sparklineChars(data);
        const last = data[data.length - 1];
        const first = data[0];
        const delta = last - first;
        const arrow = delta > 0 ? "📈" : delta < 0 ? "📉" : "→";
        return `• **${label}** \`${spark}\` ${arrow} ${first} → ${last}`;
      })
      .join("\n")
  );
}

function renderSlider(b: CanvasJSON): string {
  const label = asStr(b.label);
  const value = asNum(b.value);
  const min = asNum(b.min, 0);
  const max = asNum(b.max, 100);
  const unit = asStr(b.unit);
  const range = max - min || 1;
  const pct = ((value - min) / range) * 100;
  return `**${label}**\n\`${unicodeBar(pct)}\` ${value}${unit} (${min}–${max}${unit})`;
}

// Telegram/Discord have no way to answer a canvas action, so show the options as text the user can reply with.
function renderChoice(b: CanvasJSON): string {
  const title = asStr(b.title);
  const options = ((b.options as { label?: string }[] | undefined) ?? []).map((o) => `• ${o.label ?? ""}`).join("\n");
  return title ? `**${title}**\n${options}` : options;
}

function renderForm(b: CanvasJSON): string {
  const title = asStr(b.title);
  const fields = ((b.fields as { name?: string; label?: string }[] | undefined) ?? []).map((f) => `• ${f.label || f.name || ""}`).join("\n");
  return title ? `**${title}**\n${fields}` : fields;
}

interface Tab { label?: string; content?: string }

function renderTabs(b: CanvasJSON): string {
  const tabs = (b.tabs as Tab[] | undefined) ?? [];
  if (!tabs.length) return "";
  return tabs
    .map((t) => `**${asStr(t.label)}**\n${asStr(t.content)}`)
    .join("\n\n");
}

function renderSparkline(b: CanvasJSON): string {
  const label = asStr(b.label);
  const values = (b.values as number[] | undefined) ?? [];
  if (!values.length) return label ? `**${label}** — (no data)` : "";
  const spark = sparklineChars(values);
  const last = values[values.length - 1];
  const head = label ? `**${label}** ` : "";
  return `${head}\`${spark}\` (latest: ${last})`;
}

interface Event { time?: string; title?: string; description?: string }

function renderTimeline(b: CanvasJSON): string {
  const title = asStr(b.title);
  const events = (b.events as Event[] | undefined) ?? [];
  if (!events.length) return title ? `**${title}**` : "";
  const head = title ? `**${title}**\n` : "";
  return (
    head +
    events
      .map((e) => {
        const time = asStr(e.time);
        const evTitle = asStr(e.title);
        const desc = asStr(e.description);
        const lead = time ? `\`${time}\` ` : "";
        return desc ? `• ${lead}**${evTitle}** — ${desc}` : `• ${lead}**${evTitle}**`;
      })
      .join("\n")
  );
}

interface Segment { label?: string; value?: number }

function renderDonut(b: CanvasJSON): string {
  const title = asStr(b.title);
  const segments = (b.segments as Segment[] | undefined) ?? [];
  if (!segments.length) return title ? `**${title}**` : "";
  const total = segments.reduce((acc, s) => acc + asNum(s.value), 0) || 1;
  const head = title ? `**${title}**\n` : "";
  return (
    head +
    segments
      .map((s) => {
        const label = asStr(s.label);
        const value = asNum(s.value);
        const pct = (value / total) * 100;
        return `• **${label}** — ${value} (${pct.toFixed(0)}%)`;
      })
      .join("\n")
  );
}

function renderHeatmap(b: CanvasJSON): string {
  const title = asStr(b.title);
  const data = (b.data as number[] | undefined) ?? [];
  const columns = asNum(b.columns, 7);
  if (!data.length) return title ? `**${title}**` : "";
  const head = title ? `**${title}**\n` : "";
  const max = Math.max(...data) || 1;
  const grid = SPARK_CHARS;
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += columns) {
    const row = data.slice(i, i + columns);
    lines.push(
      row
        .map((v) => grid[Math.min(grid.length - 1, Math.floor((v / max) * grid.length))])
        .join(""),
    );
  }
  return head + "`" + lines.join("`\n`") + "`";
}

function renderCallout(b: CanvasJSON): string {
  const variant = asStr(b.variant) || "info";
  const title = asStr(b.title);
  const message = asStr(b.message);
  const icons: Record<string, string> = { info: "💡", warning: "⚠️", success: "✅", error: "❌", tip: "💡" };
  const icon = icons[variant] ?? "💡";
  const head = title ? `${icon} **${title}**` : `${icon}`;
  return `> ${head}\n> ${message.replace(/\n/g, "\n> ")}`;
}

function renderCountdown(b: CanvasJSON): string {
  const title = asStr(b.title);
  const target = asStr(b.target);
  const subtitle = asStr(b.subtitle);
  const targetDate = target ? new Date(target) : null;
  let timeLine = "";
  if (targetDate && !Number.isNaN(targetDate.getTime())) {
    const ms = targetDate.getTime() - Date.now();
    if (ms <= 0) {
      timeLine = "⏰ Expired";
    } else {
      const days = Math.floor(ms / 86_400_000);
      const hours = Math.floor((ms % 86_400_000) / 3_600_000);
      const mins = Math.floor((ms % 3_600_000) / 60_000);
      const parts = [days ? `${days}d` : "", hours ? `${hours}h` : "", `${mins}m`].filter(Boolean);
      timeLine = `⏳ ${parts.join(" ")} until ${targetDate.toISOString().slice(0, 16).replace("T", " ")}`;
    }
  }
  const lines = [title ? `**${title}**` : "", timeLine, subtitle ? `_${subtitle}_` : ""].filter(Boolean);
  return lines.join("\n");
}

interface Dataset { label?: string; values?: number[] }

function renderRadar(b: CanvasJSON): string {
  const title = asStr(b.title);
  const axes = (b.axes as string[] | undefined) ?? [];
  const datasets = (b.datasets as Dataset[] | undefined) ?? [];
  if (!axes.length || !datasets.length) return title ? `**${title}**` : "";
  const head = title ? `**${title}**\n` : "";
  return (
    head +
    datasets
      .map((d) => {
        const label = asStr(d.label) || "set";
        const values = d.values ?? [];
        const pairs = axes.map((ax, i) => `${ax} ${values[i] ?? "-"}`).join(", ");
        return `• **${label}** — ${pairs}`;
      })
      .join("\n")
  );
}

function renderPixelCanvas(b: CanvasJSON): string {
  const title = asStr(b.title) || "Pixel canvas";
  const width = asNum(b.width, 16);
  const height = asNum(b.height, 16);
  const initialPixels = Array.isArray(b.initialPixels) ? b.initialPixels.length : 0;
  const pixelLabel = initialPixels === 1 ? "pixel" : "pixels";
  return `**${title}**\nEditable ${width}x${height} pixel canvas. Open this in Chomp web chat to draw. ${initialPixels} ${pixelLabel} prefilled.`;
}

function renderDrawingCanvas(b: CanvasJSON): string {
  const title = asStr(b.title) || "Drawing canvas";
  const width = asNum(b.width, 640);
  const height = asNum(b.height, 360);
  const paths = Array.isArray(b.paths) ? b.paths.length : 0;
  const shapes = Array.isArray(b.shapes) ? b.shapes.length : 0;
  const labels = Array.isArray(b.labels) ? b.labels.length : 0;
  return `**${title}**\nVector drawing canvas ${width}x${height}. Open this in Chomp web chat to view/copy SVG. ${paths + shapes + labels} elements.`;
}
