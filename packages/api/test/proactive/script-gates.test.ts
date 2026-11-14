import { afterEach, expect, test, vi } from "vitest";
import { runScriptGate } from "../../src/proactive/script-gates.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mockYahooQuote(price: number, volume: number): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    quoteResponse: {
      result: [{
        symbol: "KTOS",
        regularMarketPrice: price,
        regularMarketVolume: volume,
        regularMarketChangePercent: 4.2,
        currency: "USD",
        marketState: "REGULAR",
      }],
    },
  }))));
}

const ktosReversalGate = {
  script: "market_quote_threshold",
  input: {
    ticker: "KTOS",
    groups: [{
      label: "confirmed reversal band",
      conditions: [
        { field: "price", op: "gte", value: 58 },
        { field: "price", op: "lte", value: 60 },
        { field: "volume", op: "gte", value: 5_000_000 },
      ],
    }],
  },
};

test("script gate supports grouped threshold conditions for bounded reversal entries", async () => {
  mockYahooQuote(59, 6_000_000);

  const result = await runScriptGate(ktosReversalGate);

  expect(result.matched).toBe(true);
  expect(result.summary).toContain("confirmed reversal band");
  expect(result.data?.matchedGroups).toEqual([{
    label: "confirmed reversal band",
    mode: "all",
    rules: [
      { label: null, field: "price", op: "gte", value: 58, actual: 59, matched: true },
      { label: null, field: "price", op: "lte", value: 60, actual: 59, matched: true },
      { label: null, field: "volume", op: "gte", value: 5_000_000, actual: 6_000_000, matched: true },
    ],
  }]);
});

test("script gate does not match a reversal when price has already left the entry band", async () => {
  mockYahooQuote(65.7, 8_000_000);

  const result = await runScriptGate(ktosReversalGate);

  expect(result.matched).toBe(false);
  expect(result.summary).toContain("did not match");
  expect(result.data?.matchedGroups).toEqual([]);
});

test("SEC news never sends requests without a configured contact identity", async () => {
  vi.stubEnv("SEC_USER_AGENT", "");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const result = await runScriptGate({ script: "company_news_scan", input: { ticker: "TESTCONFIG", finnhub: false } });
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.summary).toContain("SEC_USER_AGENT is not configured");
});

test("SEC requests use the configured contact identity", async () => {
  vi.stubEnv("SEC_USER_AGENT", "Example Assistant contact@example.com");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  await runScriptGate({ script: "company_news_scan", input: { ticker: "TESTCONFIG", finnhub: false } });
  expect(fetcher).toHaveBeenCalledWith("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": "Example Assistant contact@example.com" },
  });
});
