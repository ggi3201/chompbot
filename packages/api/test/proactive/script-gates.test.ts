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

test("script gate matches grouped threshold conditions inside a bounded reversal band, and not outside it", async () => {
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

  // No match once the price has already left the entry band.
  mockYahooQuote(65.7, 8_000_000);
  const left = await runScriptGate(ktosReversalGate);
  expect(left.matched).toBe(false);
  expect(left.summary).toContain("did not match");
  expect(left.data?.matchedGroups).toEqual([]);
});

test("SEC news never sends requests without a configured contact identity, and uses it when set", async () => {
  vi.stubEnv("SEC_USER_AGENT", "");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const result = await runScriptGate({ script: "company_news_scan", input: { ticker: "TESTCONFIG", finnhub: false } });
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.summary).toContain("SEC_USER_AGENT is not configured");

  vi.stubEnv("SEC_USER_AGENT", "Example Assistant contact@example.com");
  const configured = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
  vi.stubGlobal("fetch", configured);
  await runScriptGate({ script: "company_news_scan", input: { ticker: "TESTCONFIG", finnhub: false } });
  expect(configured).toHaveBeenCalledWith("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": "Example Assistant contact@example.com" },
  });
});
