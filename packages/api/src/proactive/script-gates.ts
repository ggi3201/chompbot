import { execFile } from "child_process";
import { promisify } from "util";
import { and, eq, gte, sql } from "drizzle-orm";
import type { ActionConfig, JsonValue } from "./rule-model.js";
import { getSecret } from "../lib/secrets.js";
import { db } from "../db/index.js";
import { newsSeen } from "../db/schema.js";
import { getAllMemories, type MemoryRecord } from "../db/memories.js";
import { cosineSimilarity } from "../db/embeddings.js";

const execFileAsync = promisify(execFile);

export type ScriptGateResult = {
  matched: boolean;
  script: string;
  summary: string;
  data?: Record<string, JsonValue>;
};

type MarketQuote = {
  symbol?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  averageDailyVolume10Day?: number;
  averageDailyVolume3Month?: number;
  marketState?: string;
  currency?: string;
  shortName?: string;
  longName?: string;
};

type ThresholdRule = {
  label?: string;
  field?: "price" | "volume" | "changePercent" | "volumeMultiple";
  op?: "lte" | "lt" | "gte" | "gt" | "eq";
  value?: number;
};

type ThresholdRuleGroup = {
  label?: string;
  mode: "all" | "any";
  rules: ThresholdRule[];
};

type ThresholdRuleMatch = ThresholdRule & {
  actual: number;
  matched: boolean;
};

type ThresholdGroupMatch = {
  label?: string;
  mode: "all" | "any";
  matched: boolean;
  rules: ThresholdRuleMatch[];
};

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function compare(actual: number, op: ThresholdRule["op"], expected: number): boolean {
  switch (op) {
    case "lt": return actual < expected;
    case "gte": return actual >= expected;
    case "gt": return actual > expected;
    case "eq": return actual === expected;
    case "lte":
    default:
      return actual <= expected;
  }
}

function asRuleField(value: string | undefined): ThresholdRule["field"] {
  switch (value) {
    case "volume":
    case "changePercent":
    case "volumeMultiple":
      return value;
    case "price":
    default:
      return "price";
  }
}

function asRuleOp(value: string | undefined): ThresholdRule["op"] {
  switch (value) {
    case "lt":
    case "gte":
    case "gt":
    case "eq":
      return value;
    case "lte":
    default:
      return "lte";
  }
}

function quoteValue(quote: MarketQuote, field: ThresholdRule["field"]): number | undefined {
  if (field === "volume") return quote.regularMarketVolume;
  if (field === "changePercent") return quote.regularMarketChangePercent;
  if (field === "volumeMultiple") {
    const volume = quote.regularMarketVolume;
    const avg = quote.averageDailyVolume10Day ?? quote.averageDailyVolume3Month;
    if (volume === undefined || avg === undefined || avg <= 0) return undefined;
    return volume / avg;
  }
  return quote.regularMarketPrice;
}

function parseRule(input: Record<string, JsonValue>): ThresholdRule | undefined {
  const value = asNumber(input.value);
  if (value === undefined) return undefined;
  return {
    label: asString(input.label),
    field: asRuleField(asString(input.field)),
    op: asRuleOp(asString(input.op)),
    value,
  };
}

function parseRules(input: JsonValue | undefined): ThresholdRule[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => parseRule(asRecord(item)))
    .filter((rule): rule is ThresholdRule => rule !== undefined);
}

function parseRuleGroups(input: Record<string, JsonValue>): ThresholdRuleGroup[] {
  const explicitGroups = input.groups ?? input.ruleGroups;
  if (Array.isArray(explicitGroups)) {
    return explicitGroups
      .map((item) => asRecord(item))
      .map((group): ThresholdRuleGroup | undefined => {
        const rules = parseRules(group.conditions ?? group.rules);
        if (rules.length === 0) return undefined;
        return {
          label: asString(group.label),
          mode: asString(group.mode) === "any" ? "any" : "all",
          rules,
        };
      })
      .filter((group): group is ThresholdRuleGroup => group !== undefined);
  }

  const explicitRules = input.rules;
  if (Array.isArray(explicitRules)) {
    return parseRules(explicitRules).map((rule) => ({
      label: rule.label,
      mode: "all",
      rules: [rule],
    }));
  }

  const rules: ThresholdRule[] = [];
  const priceAtOrBelow = asNumber(input.priceAtOrBelow ?? input.buyBelow ?? input.priceBelow);
  if (priceAtOrBelow !== undefined) {
    rules.push({ label: `price <= ${priceAtOrBelow}`, field: "price", op: "lte", value: priceAtOrBelow });
  }
  const priceAtOrAbove = asNumber(input.priceAtOrAbove ?? input.priceAbove);
  if (priceAtOrAbove !== undefined) {
    rules.push({ label: `price >= ${priceAtOrAbove}`, field: "price", op: "gte", value: priceAtOrAbove });
  }
  const volumeMultipleAtOrAbove = asNumber(input.volumeMultipleAtOrAbove ?? input.volumeMultipleAbove);
  if (volumeMultipleAtOrAbove !== undefined) {
    rules.push({ label: `volume multiple >= ${volumeMultipleAtOrAbove}`, field: "volumeMultiple", op: "gte", value: volumeMultipleAtOrAbove });
  }
  return rules.map((rule) => ({
    label: rule.label,
    mode: "all",
    rules: [rule],
  }));
}

function flattenRules(groups: ThresholdRuleGroup[]): ThresholdRule[] {
  return groups.flatMap((group) => group.rules);
}

function evaluateRuleGroups(quote: MarketQuote, groups: ThresholdRuleGroup[]): ThresholdGroupMatch[] {
  return groups.map((group) => {
    const rules = group.rules.flatMap((rule) => {
      const actual = quoteValue(quote, rule.field ?? "price");
      if (actual === undefined || rule.value === undefined) return [];
      return [{
        ...rule,
        actual,
        matched: compare(actual, rule.op ?? "lte", rule.value),
      }];
    });
    const matched = group.mode === "any"
      ? rules.some((rule) => rule.matched)
      : rules.length === group.rules.length && rules.every((rule) => rule.matched);
    return {
      label: group.label,
      mode: group.mode,
      matched,
      rules,
    };
  });
}

async function fetchYahooQuote(ticker: string): Promise<MarketQuote> {
  const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  url.searchParams.set("symbols", ticker);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Yahoo quote HTTP ${res.status}`);
  const body = await res.json() as { quoteResponse?: { result?: MarketQuote[] } };
  const quote = body.quoteResponse?.result?.[0];
  if (!quote) throw new Error(`No quote returned for ${ticker}`);
  return quote;
}

async function fetchFinnhubQuote(ticker: string): Promise<MarketQuote> {
  const token = await getSecret("FINNHUB_API_KEY");
  if (!token) throw new Error("FINNHUB_API_KEY is not configured");
  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("token", token);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub quote HTTP ${res.status}`);
  const body = await res.json() as { c?: number; dp?: number; pc?: number };
  if (typeof body.c !== "number" || body.c <= 0) throw new Error(`No Finnhub quote returned for ${ticker}`);
  return {
    symbol: ticker,
    regularMarketPrice: body.c,
    regularMarketChangePercent: body.dp,
    marketState: "REGULAR",
  };
}

async function fetchMarketQuote(ticker: string, rules: ThresholdRule[]): Promise<MarketQuote> {
  const needsVolume = rules.some((rule) => rule.field === "volume" || rule.field === "volumeMultiple");
  if (!needsVolume) {
    try {
      return await fetchFinnhubQuote(ticker);
    } catch (finnhubErr) {
      try {
        return await fetchYahooQuote(ticker);
      } catch (yahooErr) {
        const f = finnhubErr instanceof Error ? finnhubErr.message : String(finnhubErr);
        const y = yahooErr instanceof Error ? yahooErr.message : String(yahooErr);
        throw new Error(`Quote fetch failed via Finnhub (${f}) and Yahoo (${y})`);
      }
    }
  }
  return fetchYahooQuote(ticker);
}

async function runMarketQuoteThreshold(input: Record<string, JsonValue>): Promise<ScriptGateResult> {
  const ticker = asString(input.ticker ?? input.symbol);
  if (!ticker) throw new Error("market_quote_threshold requires input.ticker");

  const groups = parseRuleGroups(input);
  if (groups.length === 0) {
    throw new Error("market_quote_threshold requires input.rules, input.groups, or a shorthand threshold such as buyBelow/priceAtOrBelow");
  }

  const quote = await fetchMarketQuote(ticker, flattenRules(groups));
  const evaluatedGroups = evaluateRuleGroups(quote, groups);
  const matchedGroups = evaluatedGroups.filter((group) => group.matched);
  const matchedRules = matchedGroups.flatMap((group) => group.rules.filter((rule) => rule.matched));

  const price = quote.regularMarketPrice;
  const volume = quote.regularMarketVolume;
  const change = quote.regularMarketChangePercent;
  const summary = matchedGroups.length > 0
    ? `${ticker} gate matched: ${matchedGroups.map((m) => m.label ?? m.rules.map((rule) => rule.label ?? `${rule.field ?? "price"} ${rule.op ?? "lte"} ${rule.value}`).join(" + ")).join(", ")}`
    : `${ticker} gate did not match (${price === undefined ? "price unavailable" : `price ${price}`})`;

  return {
    matched: matchedGroups.length > 0,
    script: "market_quote_threshold",
    summary,
    data: {
      ticker,
      price: price ?? null,
      currency: quote.currency ?? null,
      changePercent: change ?? null,
      volume: volume ?? null,
      averageDailyVolume10Day: quote.averageDailyVolume10Day ?? null,
      averageDailyVolume3Month: quote.averageDailyVolume3Month ?? null,
      marketState: quote.marketState ?? null,
      matchedRules: matchedRules.map((m) => ({
        label: m.label ?? null,
        field: m.field ?? "price",
        op: m.op ?? "lte",
        value: m.value ?? null,
        actual: m.actual,
      })),
      matchedGroups: matchedGroups.map((group) => ({
        label: group.label ?? null,
        mode: group.mode,
        rules: group.rules.map((rule) => ({
          label: rule.label ?? null,
          field: rule.field ?? "price",
          op: rule.op ?? "lte",
          value: rule.value ?? null,
          actual: rule.actual,
          matched: rule.matched,
        })),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// company_news_scan
//
// Polls SEC EDGAR 8-K filings (primary, highest-signal: material events are
// legally disclosed here) and optionally Finnhub company-news (secondary,
// narrative breadth). De-dupes every item against the news_seen table so the
// same filing/article never fires the agent twice. The gate itself spends zero
// agent tokens — it only returns matched:true when there is a genuinely new,
// material item, at which point the engine wakes the agent with the items in
// {{gateResult}}. A per-ticker daily cap bounds how many times the agent can be
// woken in a single day, regardless of news volume.
// ---------------------------------------------------------------------------

type NewsItem = {
  source: "edgar" | "finnhub";
  externalId: string;
  headline: string;
  url?: string;
  publishedAt?: string; // ISO
  summary?: string;
  // EDGAR-only: the 8-K item codes / form description, when parseable.
  detail?: string;
};

const DEFAULT_LOOKBACK_MINUTES = 45;
const DEFAULT_DAILY_CAP = 5;
const DEFAULT_RETENTION_DAYS = 30;
function secUserAgent(): string {
  const value = process.env.SEC_USER_AGENT?.trim();
  if (!value) throw new Error("SEC_USER_AGENT is not configured (include an application name and contact email)");
  return value;
}

// Cache the SEC ticker→CIK map in-process — it is a ~1MB file that rarely
// changes, and the gate runs frequently.
let cikMapCache: Record<string, string> | null = null;
let cikMapFetchedAt = 0;
const CIK_MAP_TTL_MS = 24 * 60 * 60 * 1000;

async function getCikForTicker(ticker: string): Promise<string | undefined> {
  const now = Date.now();
  if (!cikMapCache || now - cikMapFetchedAt > CIK_MAP_TTL_MS) {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": secUserAgent() },
    });
    if (!res.ok) throw new Error(`SEC ticker map HTTP ${res.status}`);
    const body = await res.json() as Record<string, { ticker?: string; cik_str?: number }>;
    const map: Record<string, string> = {};
    for (const entry of Object.values(body)) {
      if (entry.ticker && typeof entry.cik_str === "number") {
        map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, "0");
      }
    }
    cikMapCache = map;
    cikMapFetchedAt = now;
  }
  return cikMapCache[ticker.toUpperCase()];
}

function extractTag(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : undefined;
}

async function fetchEdgar8K(ticker: string, sinceMs: number): Promise<NewsItem[]> {
  const cik = await getCikForTicker(ticker);
  if (!cik) throw new Error(`No SEC CIK found for ticker ${ticker}`);
  const url = new URL("https://www.sec.gov/cgi-bin/browse-edgar");
  url.searchParams.set("action", "getcompany");
  url.searchParams.set("CIK", cik);
  url.searchParams.set("type", "8-K");
  url.searchParams.set("dateb", "");
  url.searchParams.set("owner", "include");
  url.searchParams.set("count", "20");
  url.searchParams.set("output", "atom");
  const res = await fetch(url, { headers: { "User-Agent": secUserAgent() } });
  if (!res.ok) throw new Error(`EDGAR HTTP ${res.status}`);
  const xml = await res.text();

  const items: NewsItem[] = [];
  const entryBlocks = xml.split(/<entry[ >]/i).slice(1);
  for (const raw of entryBlocks) {
    const block = raw.slice(0, raw.search(/<\/entry>/i));
    const accession = extractTag(block, "accession-n[uo]mber")
      ?? extractTag(block, "accession-number");
    const updated = extractTag(block, "updated") ?? extractTag(block, "filing-date");
    const title = extractTag(block, "title") ?? "8-K filing";
    const filingType = extractTag(block, "filing-type") ?? extractTag(block, "category");
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"/i);
    const link = linkMatch ? linkMatch[1] : undefined;
    const id = accession ?? extractTag(block, "id") ?? link ?? title;
    if (!id) continue;
    const publishedAt = updated ? new Date(updated).toISOString() : undefined;
    // Lookback filter — only consider filings updated within the window. If we
    // can't parse a date, keep it (dedup will stop repeats).
    if (publishedAt && new Date(publishedAt).getTime() < sinceMs) continue;
    items.push({
      source: "edgar",
      externalId: id,
      headline: filingType ? `8-K (${filingType}) — ${title}` : `8-K — ${title}`,
      url: link,
      publishedAt,
      detail: filingType,
    });
  }
  return items;
}

async function fetchFinnhubNews(ticker: string, sinceMs: number): Promise<NewsItem[]> {
  const token = await getSecret("FINNHUB_API_KEY");
  if (!token) throw new Error("FINNHUB_API_KEY is not configured");
  const toDate = new Date();
  const fromDate = new Date(sinceMs);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url = new URL("https://finnhub.io/api/v1/company-news");
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("from", fmt(fromDate));
  url.searchParams.set("to", fmt(toDate));
  url.searchParams.set("token", token);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub company-news HTTP ${res.status}`);
  const body = await res.json() as Array<{
    id?: number; datetime?: number; headline?: string; summary?: string; source?: string; url?: string;
  }>;
  if (!Array.isArray(body)) return [];
  const items: NewsItem[] = [];
  for (const a of body) {
    if (!a.headline) continue;
    const tsMs = typeof a.datetime === "number" ? a.datetime * 1000 : undefined;
    if (tsMs !== undefined && tsMs < sinceMs) continue;
    items.push({
      source: "finnhub",
      externalId: String(a.id ?? a.url ?? a.headline),
      headline: a.headline,
      url: a.url,
      publishedAt: tsMs !== undefined ? new Date(tsMs).toISOString() : undefined,
      summary: a.summary,
    });
  }
  return items;
}

function matchesAny(haystack: string, needles: string[]): boolean {
  if (needles.length === 0) return true; // empty keyword list = match anything
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

function parseStringList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0);
}

function dedupKey(item: NewsItem, ticker: string): string {
  return `${item.source}:${ticker.toUpperCase()}:${item.externalId}`;
}

async function runCompanyNewsScan(input: Record<string, JsonValue>): Promise<ScriptGateResult> {
  const ticker = asString(input.ticker ?? input.symbol);
  if (!ticker) throw new Error("company_news_scan requires input.ticker");

  const lookbackMinutes = asNumber(input.lookbackMinutes) ?? DEFAULT_LOOKBACK_MINUTES;
  const dailyCap = asNumber(input.dailyCap) ?? DEFAULT_DAILY_CAP;
  const retentionDays = asNumber(input.retentionDays) ?? DEFAULT_RETENTION_DAYS;
  const keywords = parseStringList(input.keywords);
  const filterOut = parseStringList(input.filterOut);
  // Source selection — both default on; set `edgar:false` / `finnhub:false` to disable.
  const useEdgar = input.edgar !== false;
  const useFinnhub = input.finnhub !== false;

  const nowMs = Date.now();
  const sinceMs = nowMs - lookbackMinutes * 60 * 1000;
  const runTimestamp = new Date(nowMs).toISOString();

  // --- Daily cap: count distinct fires (shared seen_at) for this ticker today.
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartIso = dayStart.toISOString();
  const firesToday = db.select({ c: sql<number>`count(distinct ${newsSeen.seenAt})` })
    .from(newsSeen)
    .where(and(eq(newsSeen.ticker, ticker.toUpperCase()), gte(newsSeen.seenAt, dayStartIso)))
    .get();
  if (firesToday && firesToday.c >= dailyCap) {
    return {
      matched: false,
      script: "company_news_scan",
      summary: `${ticker}: daily cap reached (${firesToday.c}/${dailyCap} agent wakes today) — suppressing further news fires`,
    };
  }

  // --- Fetch. A failing source must never block the rule or throw into the
  // agent path; collect what we can and note failures.
  const errors: string[] = [];
  const fetched: NewsItem[] = [];
  if (useEdgar) {
    try {
      fetched.push(...await fetchEdgar8K(ticker, sinceMs));
    } catch (err) {
      errors.push(`EDGAR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (useFinnhub) {
    try {
      fetched.push(...await fetchFinnhubNews(ticker, sinceMs));
    } catch (err) {
      errors.push(`Finnhub: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Filter: keyword match (EDGAR 8-Ks bypass keywords — material by
  // definition), kill-list, then dedup against the ledger.
  const candidates: NewsItem[] = [];
  for (const item of fetched) {
    const text = `${item.headline} ${item.summary ?? ""} ${item.detail ?? ""}`;
    const keywordOk = item.source === "edgar" ? true : matchesAny(text, keywords);
    if (!keywordOk) continue;
    if (filterOut.length > 0 && matchesAny(text, filterOut)) continue;
    const key = dedupKey(item, ticker);
    const already = db.select({ id: newsSeen.id }).from(newsSeen).where(eq(newsSeen.id, key)).get();
    if (already) continue;
    candidates.push(item);
  }

  if (candidates.length === 0) {
    const errSuffix = errors.length > 0 ? ` (source errors: ${errors.join("; ")})` : "";
    return {
      matched: false,
      script: "company_news_scan",
      summary: `${ticker}: no new material news in last ${lookbackMinutes}m${errSuffix}`,
    };
  }

  // --- Mark seen BEFORE returning matched, so a crash mid-dispatch can't cause
  // a re-fire next tick. All items in this fire share runTimestamp so the daily
  // cap counts fires, not articles.
  for (const item of candidates) {
    db.insert(newsSeen).values({
      id: dedupKey(item, ticker),
      ticker: ticker.toUpperCase(),
      source: item.source,
      externalId: item.externalId,
      headline: item.headline,
      url: item.url ?? null,
      publishedAt: item.publishedAt ?? null,
      seenAt: runTimestamp,
    }).onConflictDoNothing().run();
  }

  // --- Prune old rows for this ticker to keep the table bounded.
  const cutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.delete(newsSeen)
    .where(and(eq(newsSeen.ticker, ticker.toUpperCase()), sql`${newsSeen.seenAt} < ${cutoff}`))
    .run();

  const edgarCount = candidates.filter((c) => c.source === "edgar").length;
  const lead = candidates[0];
  const summary = `${ticker}: ${candidates.length} new item(s)` +
    `${edgarCount > 0 ? ` (${edgarCount} SEC 8-K)` : ""} — ${lead.headline}`;

  return {
    matched: true,
    script: "company_news_scan",
    summary,
    data: {
      ticker,
      lookbackMinutes,
      sourceErrors: errors.length > 0 ? errors : null,
      items: candidates.map((c) => ({
        source: c.source,
        headline: c.headline,
        url: c.url ?? null,
        publishedAt: c.publishedAt ?? null,
        summary: c.summary ?? null,
        detail: c.detail ?? null,
      })),
    },
  };
}

/**
 * New Gmail messages matching a search. The check is plain code, so the agent only boots for a
 * mail it has not seen. Seen ids go in news_seen under `gmail:<key>`; keep the query's newer_than
 * window short so old mail never crowds the 10-result page.
 */
async function runGmailNewMail(input: Record<string, JsonValue>): Promise<ScriptGateResult> {
  const query = asString(input.query);
  const key = asString(input.key);
  if (!query || !key) throw new Error("gmail_new_mail requires input.query and input.key");
  const namespace = `gmail:${key}`;

  const { searchEmailMessages } = await import("../agents/tools/gmail.js");
  const found = await searchEmailMessages(query, 10);
  const fresh = found.filter((m) =>
    !db.select({ id: newsSeen.id }).from(newsSeen).where(eq(newsSeen.id, `${namespace}:${m.id}`)).get());
  if (fresh.length === 0) {
    return { matched: false, script: "gmail_new_mail", summary: `${key}: no new mail (${found.length} already seen)` };
  }

  // Mark seen before returning, like company_news_scan, so a crash mid-dispatch can't re-fire.
  const seenAt = new Date().toISOString();
  for (const m of fresh) {
    db.insert(newsSeen).values({
      id: `${namespace}:${m.id}`, ticker: namespace, source: "gmail", externalId: m.id, headline: m.subject, seenAt,
    }).onConflictDoNothing().run();
  }
  const cutoff = new Date(Date.now() - DEFAULT_RETENTION_DAYS * 86_400_000).toISOString();
  db.delete(newsSeen).where(and(eq(newsSeen.ticker, namespace), sql`${newsSeen.seenAt} < ${cutoff}`)).run();

  return {
    matched: true,
    script: "gmail_new_mail",
    summary: `${key}: ${fresh.length} new mail — ${fresh[0].subject}`,
    data: { key, mails: fresh },
  };
}

/**
 * Fresh auto-extracted memories plus their nearest neighbours: all a memory review needs to read.
 * Quiet weeks match nothing, so the agent never boots; busy weeks hand over a handful of
 * candidates instead of the whole store. Stateless: the lookback window is the rule's cadence.
 */
export function memoryCandidates(all: MemoryRecord[], lookbackDays: number, now = Date.now()): ScriptGateResult {
  const since = new Date(now - lookbackDays * 86_400_000).toISOString();
  const fresh = all.filter((m) => m.status === "active" && m.source === "auto" && m.createdAt >= since);
  if (fresh.length === 0) {
    return { matched: false, script: "memory_candidates", summary: `no new auto memories in the last ${lookbackDays} days` };
  }

  const embedded = all.filter((m) => m.status === "active" && m.embedding).map((m) => ({ m, v: JSON.parse(m.embedding!) as number[] }));
  const candidates = fresh.map((f) => {
    const fv = f.embedding ? (JSON.parse(f.embedding) as number[]) : undefined;
    const neighbours = fv
      ? embedded
          .filter(({ m }) => m.id !== f.id)
          .map(({ m, v }) => ({ m, sim: cosineSimilarity(fv, v) }))
          .filter(({ sim }) => sim >= 0.7)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 3)
          .map(({ m, sim }) => ({ id: m.id, source: m.source, category: m.category, similarity: Math.round(sim * 100) / 100, content: m.content.slice(0, 200) }))
      : [];
    return { id: f.id, category: f.category, content: f.content, evidence: f.evidenceQuote, replaces: f.supersedesId, createdAt: f.createdAt, neighbours };
  });
  return {
    matched: true,
    script: "memory_candidates",
    summary: `${fresh.length} new auto memories to review`,
    data: { lookbackDays, candidates },
  };
}

/**
 * Runs a fixed argv (no shell) and wakes the agent only when its stdout JSON says
 * {"matched": true}. Lets a user script (IMAP sweeps and the like) gate a rule, so
 * every run, skip and failure shows in the rule's run history.
 */
async function runCommandGate(input: Record<string, JsonValue>): Promise<ScriptGateResult> {
  const argv = Array.isArray(input.command) ? input.command.filter((a): a is string => typeof a === "string") : [];
  if (argv.length === 0 || !argv[0].startsWith("/")) throw new Error("command gate requires input.command as an argv array with an absolute path first");
  const timeout = (asNumber(input.timeoutSeconds) ?? 300) * 1000;
  const { stdout } = await execFileAsync(argv[0], argv.slice(1), { timeout, maxBuffer: 4 * 1024 * 1024 });
  let out: Record<string, JsonValue>;
  try {
    out = asRecord(JSON.parse(stdout) as JsonValue);
  } catch {
    throw new Error(`command gate: stdout is not JSON (${stdout.slice(0, 200)})`);
  }
  return {
    matched: out.matched === true,
    script: "command",
    summary: asString(out.summary) ?? (out.matched === true ? "matched" : "no match"),
    data: out,
  };
}

export async function runScriptGate(actionConfig: ActionConfig): Promise<ScriptGateResult> {
  const script = asString(actionConfig.script);
  if (!script) throw new Error("script_gate action requires actionConfig.script");
  const input = asRecord(actionConfig.input);

  if (script === "market_quote_threshold") {
    return runMarketQuoteThreshold(input);
  }

  if (script === "company_news_scan") {
    return runCompanyNewsScan(input);
  }

  if (script === "gmail_new_mail") {
    return runGmailNewMail(input);
  }

  if (script === "command") {
    return runCommandGate(input);
  }

  if (script === "memory_candidates") {
    return memoryCandidates(getAllMemories(), asNumber(input.lookbackDays) ?? 8);
  }

  throw new Error(`Unknown script_gate script "${script}"`);
}
