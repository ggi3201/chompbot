import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runScriptGate } from "../../src/proactive/script-gates.js";
import { db } from "../../src/db/index.js";
import { newsSeen } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const TICKER = "ACME";

const TICKER_MAP = { "0": { ticker: "ACME", cik_str: 1234567 } };

function atomFeed(accession: string, title: string, filingType = "8-K"): string {
  return `<?xml version="1.0" encoding="ISO-8859-1"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>${title}</title>
    <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1234567/${accession}.htm"/>
    <updated>2026-05-30T12:00:00-04:00</updated>
    <content type="text/xml">
      <accession-number>${accession}</accession-number>
      <filing-type>${filingType}</filing-type>
      <filing-date>2026-05-30</filing-date>
    </content>
  </entry>
</feed>`;
}

// Route fetch by URL: SEC ticker map vs EDGAR atom feed. Finnhub is disabled in
// these tests (finnhub:false) so no secret is required.
function mockEdgar(accession: string, title: string, filingType = "8-K"): void {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("company_tickers.json")) {
      return new Response(JSON.stringify(TICKER_MAP));
    }
    if (url.includes("browse-edgar")) {
      return new Response(atomFeed(accession, title, filingType));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

const baseGate = (overrides: Record<string, unknown> = {}) => ({
  script: "company_news_scan",
  input: {
    ticker: TICKER,
    finnhub: false,
    lookbackMinutes: 525_600, // huge window so the date filter is a no-op in tests
    ...overrides,
  },
});

beforeEach(() => {
  vi.stubEnv("SEC_USER_AGENT", "Example Assistant contact@example.com");
  db.delete(newsSeen).where(eq(newsSeen.ticker, TICKER)).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  db.delete(newsSeen).where(eq(newsSeen.ticker, TICKER)).run();
});

test("fires on a new SEC 8-K filing, and does not re-fire once it is seen (dedup ledger)", async () => {
  mockEdgar("0001234567-26-000045", "8-K - ACME INC (0001234567) (Filer)");

  const first = await runScriptGate(baseGate());
  expect(first.matched).toBe(true);
  expect(first.summary).toContain("SEC 8-K");
  const items = first.data?.items as Array<{ source: string; headline: string }>;
  expect(items).toHaveLength(1);
  expect(items[0].source).toBe("edgar");

  const second = await runScriptGate(baseGate());
  expect(second.matched).toBe(false);
  expect(second.summary).toContain("no new material news");
});

test("respects the per-ticker daily cap", async () => {
  // Seed 5 distinct fires today (distinct seen_at values).
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 5; i++) {
    db.insert(newsSeen).values({
      id: `edgar:${TICKER}:cap-${i}`,
      ticker: TICKER,
      source: "edgar",
      externalId: `cap-${i}`,
      seenAt: `${today}T0${i}:00:00.000Z`,
    }).run();
  }

  mockEdgar("0001234567-26-000099", "8-K - ACME INC fresh filing");
  const result = await runScriptGate(baseGate({ dailyCap: 5 }));

  expect(result.matched).toBe(false);
  expect(result.summary).toContain("daily cap reached");
});

test("does not throw into the agent path when EDGAR errors", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("company_tickers.json")) {
      return new Response(JSON.stringify(TICKER_MAP));
    }
    return new Response("upstream boom", { status: 503 });
  }));

  const result = await runScriptGate(baseGate());
  expect(result.matched).toBe(false);
  expect(result.summary).toContain("no new material news");
  expect(result.summary).toContain("source errors");
});
