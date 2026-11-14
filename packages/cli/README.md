# @chomp/cli

Command-line interface to every Chomp MCP tool, over the same HTTP endpoints
the MCP stdio bridge uses (`/mcp/tools/list`, `/mcp/tools/call`).

Built for environments where MCP cannot run — e.g. Copilot CLI with
third-party MCP servers disabled by org policy, or any shell-based agent that
just wants to call Chomp without a JSON-RPC adapter.

## Install

The package ships with the monorepo. After `pnpm install`, the `chomp` bin is
available inside any workspace package:

```bash
pnpm --filter @chomp/cli exec chomp tools list
```

For a globally-available binary, point your shell at the script directly:

```bash
ln -s "$(pwd)/packages/cli/cli.mjs" ~/.local/bin/chomp
```

## Configuration

The CLI talks to the same API your MCP bridge does. Defaults match the dev
setup; override per call or via env.

| Env var            | Flag             | Default      | Purpose                                                  |
| ------------------ | ---------------- | ------------ | -------------------------------------------------------- |
| `CHOMP_HOST`       | `--host`         | `127.0.0.1`  | API host                                                 |
| `CHOMP_PORT`       | `--port`         | `3001`       | API port                                                 |
| `CHOMP_MCP_SECRET` | `--secret`       | _(none)_     | Sent as `X-Chomp-MCP-Secret` when set                    |
| `CHOMP_SESSION_ID` | `--session-id`   | _(none)_     | Required only for session-bound tools (`reply`, `ask_user`) |

## Usage

```bash
# Discover what is available
chomp tools list
chomp tools schema reply
chomp help recall_memories

# Call a tool with typed flags (numbers, booleans, JSON objects are coerced
# according to the tool's input schema)
chomp reply --message "Hello from the CLI"
chomp recall_memories --query "stock tickers" --limit 5
chomp save_memory --category preferences --content "user likes dark mode"

# Raw JSON args
chomp search_conversations --json '{"query":"AI","limit":3}'

# Create a deterministic stock-watch gate that delegates only when triggered
chomp create_proactive_rule --json '{
  "name":"ACME deterministic buy gate",
  "agent_prompt":"ACME gate fired. Gate result:\n{{gateResult}}\nVerify thesis/news before recommending action.",
  "active_hours_start":10,
  "active_hours_end":15,
  "active_hours_timezone":"America/New_York",
  "cooldown_minutes":120,
  "guard":{"rules":[{"type":"market_session","market":"XNYS","phase":"regular"}]},
  "gate":{"script":"market_quote_threshold","input":{"ticker":"ACME","buyBelow":55}}
}'

# Bounded gates can require grouped conditions, e.g. price in a reversal band
# AND volume confirmation. Groups are ORed; conditions inside a group default to AND.
chomp create_proactive_rule --json '{
  "name":"KTOS bounded reversal gate",
  "agent_prompt":"KTOS gate fired. Gate result:\n{{gateResult}}\nCheck catalyst quality before recommending action.",
  "active_hours_start":10,
  "active_hours_end":15,
  "active_hours_timezone":"America/New_York",
  "cooldown_minutes":120,
  "guard":{"rules":[{"type":"market_session","market":"XNAS","phase":"regular"}]},
  "gate":{"script":"market_quote_threshold","input":{"ticker":"KTOS","groups":[{"label":"confirmed reversal band","conditions":[{"field":"price","op":"gte","value":58},{"field":"price","op":"lte","value":60},{"field":"volume","op":"gte","value":5000000}]}]}}
}'

# News gate: polls SEC EDGAR 8-K filings (primary) + Finnhub company-news
# (secondary), de-dupes against the news_seen table, and only wakes the agent on
# a genuinely new material item. 8-K filings bypass keyword matching (material by
# definition); news headlines must match a keyword and avoid the filterOut list.
# dailyCap bounds how many times the agent can be woken per ticker per day.
chomp create_proactive_rule --json '{
  "name":"ACME thesis-break news watch",
  "agent_prompt":"ACME news hit:\n{{gateResult}}\nDecide: thesis-breaking, thesis-confirming, or noise? If actionable, give a sized buy/trim/hold call; if noise, say so in one line.",
  "active_hours_start":0,
  "active_hours_end":24,
  "cooldown_minutes":20,
  "gate":{"script":"company_news_scan","input":{"ticker":"ACME","keywords":["NRC","license","contract","PPA","SMR","offering","dilution","guidance"],"filterOut":["price target","rating","initiated","reiterated","analyst"],"lookbackMinutes":45,"dailyCap":5}}
}'

# Pipe args via stdin
echo '{"query":"AI"}' | chomp search_conversations

# Get the full MCP response shape instead of the text payload
chomp recall_memories --query foo --raw
```

Tool names accept any of these equivalent forms:

```
reply
chomp_reply
mcp__chomp-api__reply
```

## Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| `0`  | Tool returned a successful result                  |
| `1`  | Tool returned `isError: true`                      |
| `2`  | CLI usage error (bad flag, missing arg, etc.)      |
| `3`  | Transport error (could not reach API, non-200)     |
| `4`  | Internal CLI error                                 |

## Notes

- The CLI never spawns a stdio MCP server; it is a plain HTTP client and
  inherits whatever auth model the API enforces. In dev, the API allows
  localhost without a secret. In any environment where `CHOMP_MCP_SECRET` is
  set on the server, the same value must be passed to the CLI.
- The tool catalog is fetched fresh on every invocation. This keeps the CLI
  in lockstep with the server-side tool registry — there is no codegen step
  and no risk of drift.
