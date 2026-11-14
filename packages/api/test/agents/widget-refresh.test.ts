import { beforeEach, describe, expect, test, vi } from "vitest";

const { execHttpFetchUrl } = vi.hoisted(() => ({
  execHttpFetchUrl: vi.fn(),
}));

vi.mock("../../src/agents/tools/http-fetch.js", () => ({
  execHttpFetchUrl,
}));

import { executeTemplateRefresh } from "../../src/agents/widget-refresh.js";

describe("executeTemplateRefresh", () => {
  beforeEach(() => {
    execHttpFetchUrl.mockReset();
  });

  test("renders a single-url template against fetched JSON", async () => {
    execHttpFetchUrl.mockResolvedValueOnce(JSON.stringify({ c: 212.6, dp: -1.27 }));

    await expect(
      executeTemplateRefresh({
        url: "https://example.com/nvda",
        transform: {
          type: "info-card",
          title: "NVDA",
          value: "{{$.c | usd}}",
          change: "{{$.dp | signed_pct}}",
          color: "{{$.dp >= 0 ? 'emerald' : 'pink'}}",
        },
      }),
    ).resolves.toEqual([
      {
        type: "info-card",
        title: "NVDA",
        value: "$212.60",
        change: "-1.27%",
        color: "pink",
      },
    ]);
  });

  test("fetches multiple template requests in parallel and exposes them by key", async () => {
    execHttpFetchUrl
      .mockResolvedValueOnce(JSON.stringify({ c: 163.27, dp: 2.11 }))
      .mockResolvedValueOnce(JSON.stringify({ c: 69.67, dp: 5.75 }));

    await expect(
      executeTemplateRefresh({
        requests: {
          mstr: { url: "https://example.com/mstr" },
          acme: { url: "https://example.com/acme" },
        },
        transform: {
          type: "metric-grid",
          items: [
            {
              title: "MSTR",
              value: "{{$.mstr.c | usd}}",
              change: "{{$.mstr.dp | signed_pct}}",
              color: "{{$.mstr.dp >= 0 ? 'emerald' : 'pink'}}",
            },
            {
              title: "ACME",
              value: "{{$.acme.c | usd}}",
              change: "{{$.acme.dp | signed_pct}}",
              color: "{{$.acme.dp >= 0 ? 'emerald' : 'pink'}}",
            },
          ],
        },
      }),
    ).resolves.toEqual([
      {
        type: "metric-grid",
        items: [
          { title: "MSTR", value: "$163.27", change: "+2.11%", color: "emerald" },
          { title: "ACME", value: "$69.67", change: "+5.75%", color: "emerald" },
        ],
      },
    ]);

    expect(execHttpFetchUrl).toHaveBeenCalledTimes(2);
    expect(execHttpFetchUrl).toHaveBeenNthCalledWith(1, {
      url: "https://example.com/mstr",
      headers: undefined,
      method: undefined,
      body: undefined,
    });
    expect(execHttpFetchUrl).toHaveBeenNthCalledWith(2, {
      url: "https://example.com/acme",
      headers: undefined,
      method: undefined,
      body: undefined,
    });
  });
});
