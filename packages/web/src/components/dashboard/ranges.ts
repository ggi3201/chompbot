export type Range = "24h" | "7d" | "30d";

export const RANGE_OPTIONS: { id: Range }[] = [{ id: "24h" }, { id: "7d" }, { id: "30d" }];
export const RANGE_TITLES: Record<Range, string> = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" };

const pad = (n: number) => n.toString().padStart(2, "0");

/** The x label of a point on a chart that covers the range. */
export const RANGE_TICKS: Record<Range, (d: Date) => string> = {
  "24h": (d) => pad(d.getHours()),
  "7d": (d) => `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${pad(d.getHours())}`,
  "30d": (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
};

/** The hover card's heading for a point. */
export const tipOf = (d: Date) => `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
