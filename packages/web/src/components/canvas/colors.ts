// Canvas blocks may name a hue ("emerald", "cyan"). These are the values the names map to,
// toned down to sit inside the graphite ramp. Violet and purple fold into a neutral grey.
const HUES: Record<string, string> = {
  amber: "#f2a33a",
  emerald: "#4cc38a",
  cyan: "#6cb6c8",
  pink: "#d68ba8",
  blue: "#7aa5e0",
  violet: "#a1a1a6",
  purple: "#a1a1a6",
};

/** The leading series takes the ember accent, the next two are greys, then toned hues for charts that need more. */
const SERIES = ["#f2a33a", "#85858b", "#5c5c62", "#6cb6c8", "#7aa5e0", "#d68ba8", "#4cc38a", "#d4d4d8"];

export const ACCENT = SERIES[0];

export const seriesColor = (index: number) => SERIES[index % SERIES.length];

/** The hue a block asked for, or the fallback when it named none or one we do not know. */
export const hue = (name: string | undefined, fallback = ACCENT) => HUES[name ?? ""] ?? fallback;
