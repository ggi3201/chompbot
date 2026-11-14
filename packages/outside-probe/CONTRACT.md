# Contract between Chomp and the outside probe

Chomp writes the target list. The Worker reads it, checks the targets, and posts the results back.

## Target list (Workers KV)

- Binding `TARGETS`, key `targets`. The value is a JSON string.
- Chomp writes it only when discovery changes. The free plan allows 1,000 KV writes a day.
- The Worker reads it on every run. KV caches reads, so a change can take up to a minute to arrive.

```json
{
  "version": 12,
  "urls": [
    { "key": "recipes-web", "url": "https://app.example.com/health" },
    { "key": "grafana", "url": "https://grafana.example.com/", "expectedStatus": 401 }
  ],
  "ports": [22, 80, 443, 3001, 5433, 5434, 5435, 5632, 6379, 8000, 9000, 9443],
  "homeHost": "home.example.com"
}
```

| Field | Type | Rule |
|---|---|---|
| `version` | number | Any number. Chomp bumps it on each write. |
| `urls[].key` | string | Not empty. Chomp's target key. Comes back unchanged in `results[].key`. |
| `urls[].url` | string | A valid `http:` or `https:` URL. |
| `urls[].expectedStatus` | integer, optional | 100 to 599. A response with this status counts as up, even for 5xx. |
| `ports` | integer[] | Each 1 to 65535. At most 20 entries. May be empty. |
| `homeHost` | string | Not empty. Hostname or IP for the port checks. It must not be proxied by Cloudflare (a DNS-only record, or the raw home IP). |

If the key is missing, or any field breaks a rule, the Worker ignores the whole list. It checks nothing, but it still posts a report with `results: []`. That report is the heartbeat.

## How often each target is checked

- The cron runs every minute.
- Ports: when the Unix minute divides by 15.
- URLs: every minute. The free plan allows 50 subrequests per run, and the Worker keeps to 48. After the fixed work of a run, 43 fetches and connects remain. If the URLs and the due ports do not fit, the URLs are split into shards and each minute checks one. Every URL is still checked at least every 2 minutes while `urls.length <= 2 * (43 - ports.length)`: up to 62 URLs next to 12 ports. Beyond that the interval grows to the number of shards.
- So one report may hold only some of the URLs. Chomp must not treat a URL that is absent from a report as down.

## Report

`POST` to `CHOMP_RESULTS_URL` (for example `https://webhooks.example.com/api/monitoring/outside`).

Headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `chomp-outside-probe` |
| `X-Chomp-Timestamp` | Unix time in **seconds**, as a decimal string. |
| `X-Chomp-Signature` | `sha256=` followed by the lowercase hex HMAC-SHA256 of the signed string. |

Body:

```json
{
  "ts": 1794153600123,
  "colo": null,
  "vantage": "outside",
  "results": [
    { "key": "recipes-web", "ok": true, "statusCode": 200, "latencyMs": 84, "error": null },
    { "key": "grafana", "ok": false, "statusCode": null, "latencyMs": 8001, "error": "timeout" }
  ],
  "ports": [
    { "port": 22, "open": false },
    { "port": 443, "open": true }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `ts` | integer | Epoch **milliseconds** when the run started. Same unit as `monitor_checks.ts`. Use this as the check time. |
| `colo` | string or null | Always `null` for now. A scheduled run has no request data. |
| `vantage` | `"outside"` | Always this value. |
| `results` | array | One entry per URL checked in this run. May be empty. |
| `results[].key` | string | The `key` from the target list. |
| `results[].ok` | boolean | `statusCode < 500`, or `statusCode === expectedStatus`. False on any error. |
| `results[].statusCode` | integer or null | Null when there was no response. |
| `results[].latencyMs` | integer | Time until the response headers arrived, or until the error. |
| `results[].error` | string or null | `HTTP <status>` for a 5xx, `timeout` after 8 s, else the network error message. Null when `ok`. |
| `ports` | array, optional | Present only on runs that checked ports. Absent otherwise. |
| `ports[].port` | integer | A port from the list. |
| `ports[].open` | boolean | True when a TCP connection to `homeHost:port` opened within 3 s. |

Each report is a sample from one run. Responses are not read. Redirects are not followed, so a 301 or 302 counts as up.

## Signature

1. `timestamp` is the value of `X-Chomp-Timestamp`.
2. `body` is the raw request body, exactly as received. Do not parse and re-serialize it.
3. Signed string: `<timestamp>.<body>`.
4. Key: the shared secret `MONITOR_OUTSIDE_SECRET`, UTF-8 bytes.
5. Expected header: `sha256=` + lowercase hex of HMAC-SHA256(key, signed string).

The receiver must:

1. Read the raw body before any JSON parsing.
2. Reject with 401 when a header is missing or the signature does not match. Compare in constant time (`crypto.timingSafeEqual`), after checking that both have the same length.
3. Reject with 401 when `|now - timestamp| > 300` seconds. This is the replay window: 5 minutes.
4. Answer 2xx when accepted. Any other status, or no answer within 10 s, counts as a failed report.

The Worker cannot tell a bad signature from an outage. After 3 failed reports in a row it sends a Telegram alarm, so a wrong secret looks like a dead Chomp.

## Dead-Chomp alarm

The Worker keeps its own state in KV key `state`: `{ "failures": number, "since": number | null, "alarmed": boolean }`. Chomp does not read or write it. The Worker writes it only when it changes, so a healthy Worker makes no KV writes.

- Third failed report in a row: one Telegram message to `TELEGRAM_ALERTS_CHAT_ID` through the alerts bot. If Telegram does not accept it, the Worker tries again on the next failed run.
- First good report after that: one message `Chomp is back after N min.`.
