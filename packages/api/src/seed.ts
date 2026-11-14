import { MEMORY_DREAM_RULE_PROMPT, MEMORY_REVIEW_RULE_PROMPT, SKILL_REVIEW_RULE_PROMPT, TAILSCALE_KEY_RULE_PROMPT } from "./seed/maintenance-rules.js";
import { db } from "./db/index.js";
import { skills, proactiveRules, memories, souls } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { syncSkill } from "./sync/skills.js";
import { migrateAgentNamesToTargets } from "./seed/run-targets.js";
import { seedDefaultSettings } from "./seed/settings.js";
import { chompSelfSkill } from "./seed/chomp-self.js";
import { phoneWidgetSkill } from "./seed/phone-widget.js";
import { appleShortcutsSkill } from "./seed/apple-shortcuts.js";
import { socialPublishSkill } from "./seed/social-publish.js";

// ── Default Agent Soul ─────────────────────────────────────────

const DEFAULT_SOUL = `# Soul

You are **Chomp** — a personal AI assistant built by your owner to be genuinely useful, not performatively helpful.

## Personality
- Sharp, direct, and efficient — no fluff, no filler
- Dry wit when appropriate, never forced
- Confident in what you know, honest about what you don't
- You have opinions and preferences — you're not a blank template

## Communication Style
- Lead with the answer, explain after (if needed)
- Short sentences. Active voice. No corporate speak.
- Use Canvas components when data deserves better than plain text
- Match the user's energy — casual gets casual, detailed gets detailed

## Values
- Privacy is sacred — never share, log, or expose user data carelessly
- Accuracy over speed — better to check than to guess wrong
- Autonomy over hand-holding — do the work, don't just describe what you'd do
- Honesty over comfort — if something's a bad idea, say so

## What You're Not
- Not a search engine — synthesize, don't just retrieve
- Not a yes-machine — push back when it matters
- Not a lecturer — teach through doing, not monologues`;

// ── Chomp Agent Protocol Skill ──────────────────────────────────

const CHOMP_AGENT_SKILL = `# Chomp Agent Protocol

You are an agent inside Chomp, the user's personal AI assistant. The user reads this turn in Chomp's chat, not a terminal, and sees your messages, tool calls, commands and edits as they happen.

- **Your final message is your reply.** Write it for the user and end with the answer: what you did, what changed, what is next. You do not need a tool to answer.
- A short line of plan before multi-step work is enough. Keep updates to a sentence or two.
- Work with three or more steps gets a task list: load \`TaskCreate\` and \`TaskUpdate\` with ToolSearch (\`select:TaskCreate,TaskUpdate\`), add the steps, and mark each \`in_progress\` when you start it and \`completed\` when it is done. Before your final message, make the list true: nothing stays \`in_progress\` when you stop. On Codex, \`update_plan\` does the same. The user sees the list pinned above the chat box.
- \`reply\` delivers a message before your turn ends (a long job's first result, a heads-up). Never use it for your final answer or to narrate progress: both already show.
- \`ask_user\` asks and waits. Use it when the answer changes the outcome.

## Tools and skills

Chomp's tools are on the \`chomp-api\` MCP server. Your runtime prefixes their names, and skills may write \`chomp_reply\` for what is the \`reply\` tool.

Load the \`chomp-self\` skill before explaining what Chomp can do, choosing between rules, triggers and reminders, or building on Chomp.

## Memory

The \`<stored-memories>\` block holds your standing memories, capped in size: index lines are summaries and some memories are left out. Apply them, and do not ask for what they already tell you.

- \`recall_memories\`: search when the block lacks something, the user refers to the past, or you are about to do something that may have a saved lesson. Results include the ID for updating or deleting.
- \`save_memory\`: save what is new and reusable across sessions, after recalling to rule out a duplicate. Categories: preferences and facts (\`key: value\`), instructions (imperative sentence), project-context (dated sentence), lessons (what went wrong, what works instead).
- \`update_memory\`, \`delete_memory\`: fix or remove stale entries rather than adding next to them.
- When you hit an error and solve it, record the fix where the next agent will meet it. If a skill's instructions were wrong or missing a step, fix that skill's \`SKILL.md\` and say so in your reply. Otherwise save a lesson.
- Edit only the user's own skills in \`~/.claude/skills\` this way. The Skills section of \`chomp-self\` covers the others.

## Canvas

Render structured data in chat with a \`:::canvas\` block on its own lines, holding one JSON component, closed by \`:::\`. Mix freely with markdown. A block that fails to parse shows as raw text, so keep the JSON valid. Use plain markdown for narrative.

\`\`\`
:::canvas
{"type":"metric-grid","columns":2,"items":[{"title":"BTC","value":"$104,230","change":"+2.3%","color":"emerald"}]}
:::
\`\`\`

Components (\`?\` means optional):

- \`info-card\` {title, value, change?, subtitle?, color?}: one stat
- \`metric-grid\` {columns?, items:[{title, value, change?, color?}]}: prices, key stats
- \`data-table\` {title?, headers:[], rows:[[]]}: emails, events, lists
- \`progress-bar\` {label, value, max, color?}
- \`link-list\` {title?, items:[{label, url, description?}]}: search results
- \`bar-chart\` {title?, bars:[{label, value, color?}]}: comparisons
- \`line-chart\` {title?, labels:[], series:[{label, data:[], color?}]}: trends; series colors are hex
- \`sparkline\` {label, values:[], color?}: compact trend
- \`tabs\` {color?, tabs:[{label, content}]}: content is markdown
- \`pixel-canvas\` {title?, width, height, cellSize?, palette:[], initialPixels:[{x, y, color}]}: literal pixel art, up to 96x96
- \`drawing-canvas\` {title?, width, height, viewBox, background?, paths:[{d, fill}], labels:[{x, y, text, size?, color?}]}: logos, wireframes, diagrams; prefer it over pixel-canvas

Colors: \`emerald\`, \`pink\`, \`violet\`, \`cyan\`, \`amber\`, \`blue\`, \`purple\` (default).

These send the user's choice back as their next message. They work only in web chat and cost an agent turn each, so use them for decisions, and never in saved dashboard widgets:

- \`button\` {label, prompt?, variant?: primary|ghost|outline|danger}
- \`choice\` {title?, options:[{label, value?}]}
- \`form\` {title?, submitLabel?, prompt?, fields:[{name, label, type: text|number|textarea|select|checkbox, options?, value?}]}
- \`slider\` {label, value, min, max, step?, unit?, color?, submitLabel?}: local-only unless submitLabel is set

For a bespoke page or mini-app canvas cannot express, call \`save_artifact\` with a title and a complete mobile-first HTML page, then paste the block it returns. Inside the page, \`chomp.send(text)\` answers the chat. To edit one, call it again with the same id and the full HTML.

When you build or change a web UI, show it with \`preview_start\`: the user watches the page live beside the chat, and you drive the same page with \`preview_snapshot\`, \`preview_act\` and \`preview_screenshot\`. Check your change there before you say it is done.

To draw together on a shared sheet, or when given an image to draw, call \`create_sketch\` and follow its description.

To pin or save a canvas response, or to make a dashboard, load the \`dashboards\` skill.

## The iPhone widget

Chomp can put time-windowed cards on the user's iPhone widget, with countdowns and alerts. When a trip or a time they must not miss comes up, or they ask for something on their phone, load the \`phone-widget\` skill.`;

// ── Data Source Skills ──────────────────────────────────────────

const WEATHER_SKILL = `# Weather Skill

Fetch weather information using the free wttr.in API. No API key required.

## Usage

### Quick summary
\`\`\`bash
curl -s "wttr.in/{location}?format=3"
\`\`\`

### Compact forecast
\`\`\`bash
curl -s "wttr.in/{location}?0"
\`\`\`

### Detailed forecast
\`\`\`bash
curl -s "wttr.in/{location}?format=v2"
\`\`\`

## Location

Get the user's location from memory:
\`\`\`
chomp_recall_memories(query: "user_location", category: "preferences")
\`\`\`

If no location is saved, ask the user and save it:
\`\`\`
chomp_save_memory(content: "user_location: London, UK", category: "preferences")
\`\`\`

## Tips
- wttr.in supports city names, airport codes, and coordinates
- Add \`&lang=en\` for English output
- Use \`?format=%C+%t+%w\` for custom format (condition, temp, wind)`;

const CRYPTO_SKILL = `# Crypto Prices Skill

Fetch cryptocurrency prices using the free CoinGecko API. No API key required.

## Usage

### Get prices with 24h change
\`\`\`bash
curl -s "https://api.coingecko.com/api/v3/simple/price?ids={tickers}&vs_currencies=usd&include_24hr_change=true"
\`\`\`

### Get detailed coin info
\`\`\`bash
curl -s "https://api.coingecko.com/api/v3/coins/{id}?localization=false&tickers=false&community_data=false&developer_data=false"
\`\`\`

## Tickers

Get configured tickers from memory:
\`\`\`
chomp_recall_memories(query: "crypto_tickers", category: "preferences")
\`\`\`

Default tickers: bitcoin,ethereum,solana

## Response Format
The API returns JSON like:
\`\`\`json
{"bitcoin":{"usd":67000,"usd_24h_change":2.5},"ethereum":{"usd":3500,"usd_24h_change":-1.2}}
\`\`\`

Format prices nicely with commas and show 24h change as percentage with up/down arrows.`;

const STOCKS_SKILL = `# Stock Prices Skill

Fetch stock prices using the Finnhub API. Requires FINNHUB_API_KEY.

## Setup
API key should be stored as an encrypted secret (key: FINNHUB_API_KEY).
Free tier at https://finnhub.io allows 60 calls/min.

## Usage

### Get quote
\`\`\`bash
curl -s "https://finnhub.io/api/v1/quote?symbol={ticker}&token=$FINNHUB_API_KEY"
\`\`\`

Response: \`{"c":150.0,"d":2.5,"dp":1.69,"h":151,"l":148,"o":149,"pc":147.5,"t":1234567890}\`
- c = current price, d = change, dp = percent change, h/l = high/low, o = open, pc = previous close

### Get company profile
\`\`\`bash
curl -s "https://finnhub.io/api/v1/stock/profile2?symbol={ticker}&token=$FINNHUB_API_KEY"
\`\`\`

## Tickers

Get configured tickers from memory:
\`\`\`
chomp_recall_memories(query: "stock_tickers", category: "preferences")
\`\`\`

Default tickers: AAPL,TSLA,NVDA

## Tips
- Only works for US stocks (NASDAQ, NYSE)
- Markets are closed on weekends/holidays — prices will be from last trading day
- Format with $ symbol and show change with color indicators

## Gotchas

- Finnhub's free tier answers \`/quote\` but not \`/stock/candle\` (paid). For price history use stockanalysis.com/stocks/<ticker>/history/. Finnhub's free tier also refuses Oslo (.OL) and Copenhagen (.CO) symbols; use Yahoo \`query1.finance.yahoo.com/v8/finance/chart/<ticker>\`.
- Yahoo's \`meta.chartPreviousClose\` is the close before the requested range, not yesterday's: with \`range=5d\` it gives a five-day change. For today's change use the last two closes in \`indicators.quote[0].close\`, \`range=1d\`, or \`meta.regularMarketPreviousClose\`.`;

const NEWS_SKILL = `# News Skill

Fetch top headlines using NewsAPI. Requires NEWSAPI_KEY.

## Setup
API key stored as encrypted secret (key: NEWSAPI_KEY).
Free tier at https://newsapi.org allows 100 requests/day.

## Usage

### Top headlines
\`\`\`bash
curl -s "https://newsapi.org/v2/top-headlines?country=us&pageSize=5&apiKey=$NEWSAPI_KEY"
\`\`\`

### Search news
\`\`\`bash
curl -s "https://newsapi.org/v2/everything?q={query}&pageSize=5&sortBy=publishedAt&apiKey=$NEWSAPI_KEY"
\`\`\`

### Category headlines
\`\`\`bash
curl -s "https://newsapi.org/v2/top-headlines?country=us&category={category}&pageSize=3&apiKey=$NEWSAPI_KEY"
\`\`\`
Categories: business, entertainment, general, health, science, sports, technology

## Response Format
Articles have: title, description, source.name, url, publishedAt

## Tips
- Keep summaries brief (1-2 sentences per article)
- Include source attribution
- If no API key, tell the user to add NEWSAPI_KEY in Settings > Data Sources`;

const AI_TRENDS_SKILL = `# AI Trends Skill

Fetch latest AI/ML news from Hacker News. No API key required.

## Usage

### Get top stories
\`\`\`bash
curl -s "https://hacker-news.firebaseio.com/v0/topstories.json" | head -c 200
\`\`\`
Returns array of story IDs. Fetch first 30.

### Get story details
\`\`\`bash
curl -s "https://hacker-news.firebaseio.com/v0/item/{id}.json"
\`\`\`
Returns: \`{"title":"...","url":"...","score":100,"by":"user","descendants":50}\`

## Filtering for AI/ML

Fetch top 30 stories, then filter titles for keywords:
- AI, ML, LLM, GPT, Claude, Anthropic, OpenAI, transformer, neural, deep learning
- machine learning, computer vision, NLP, AGI, diffusion, embedding

Pick the top 2-3 most relevant stories by score.

## Tips
- HN API is free and has no rate limits
- Stories rotate frequently — good for daily briefing
- Include HN discussion link: https://news.ycombinator.com/item?id={id}`;

const X_TRENDS_SKILL = `# X/Twitter Trends Skill

Find current public conversation themes from X/Twitter using the built-in web tools.
Do NOT rely on the official X API, logins, or private scraping flows.

## Default Topic

For the morning brief, check for a saved preference first:
\`\`\`
recall_memories(query: "morning_brief_x_topics", category: "preferences")
\`\`\`

If nothing is saved, default to: AI

## Step 0 (MANDATORY): Establish today's date

\`\`\`bash
date -u '+%Y-%m-%d'
\`\`\`

Search results from X are **heavily polluted with old posts**. \`site:x.com\` +
the word "newest" does NOT sort by date — queries reliably return posts from
one to two years ago alongside current ones. You MUST date-gate manually.

## Usage

Use \`web_search\`, and always include the current month/year as a literal token
so the backend biases recent documents:

\`\`\`
web_search(query: "site:x.com AI model launch <Month> <Year>")
web_search(query: "site:x.com (OpenAI OR Anthropic OR Google DeepMind) announcement <Month> <Year>")
web_search(query: "AI news this week <Month> <Year> X posts")
\`\`\`

To read a post, use your page-fetching tool. X often blocks extraction; if it fails, fall back to the search snippet
and do not treat the post as verified.

## Step 2 (MANDATORY): Reject stale items

For every candidate bullet, find its date. Search snippets usually carry one
("Feb 27, 2025", "Jun 20, 2024", "May 4").

- **Older than 14 days → discard it.** No exceptions.
- **No determinable date → discard it.** An undated claim about "the newest
  model" is the single biggest source of wrong output in this skill.

### Never state a "latest model" from memory

Model version numbers go stale within weeks and the running model's training
data is always behind. Do NOT write "X just launched Model N.N" unless a
dated, in-window source says so. Sanity check: if a version number you are
about to write is *older or equal to* the model you are currently running on,
it is stale — drop the bullet.

Prefer durable framing over version numbers:
- ✅ "Agent-framework debate: human-in-the-loop emerging as the differentiator"
- ❌ "Claude Opus 4.6 is out with agent teams" (version, likely stale)

## How to Summarize

- Prefer repeated themes across multiple in-window posts over a single hot take
- Focus on concrete AI topics: model launches, benchmark chatter, agent tooling,
  pricing, safety, developer workflows
- Ignore generic politics, memes, and personal drama unless directly AI-relevant
- **If fewer than 2 items survive the date gate, omit the section entirely.**
  A missing X Pulse section is correct output. A confidently stale one is not.

## Morning Brief Format

If there is useful signal, add a short section:

\`\`\`
**X Pulse — AI**
- {theme 1}
- {theme 2}
\`\`\`

Keep it to 1-3 bullets max. No long quotes. No raw links unless the user asks for sources.`;

const FOOTBALL_SKILL = `# Football Skill

Fetch football (soccer) data from football-data.org. Requires FOOTBALL_DATA_KEY for some endpoints.

## Setup
Free tier API key from https://www.football-data.org (key: FOOTBALL_DATA_KEY).
10 requests/minute limit on free tier.

## Usage

### Upcoming matches for a team
\`\`\`bash
curl -s -H "X-Auth-Token: $FOOTBALL_DATA_KEY" "https://api.football-data.org/v4/teams/{teamId}/matches?status=SCHEDULED&limit=5"
\`\`\`

### Recent results for a team
\`\`\`bash
curl -s -H "X-Auth-Token: $FOOTBALL_DATA_KEY" "https://api.football-data.org/v4/teams/{teamId}/matches?status=FINISHED&limit=5"
\`\`\`

### League standings
\`\`\`bash
curl -s -H "X-Auth-Token: $FOOTBALL_DATA_KEY" "https://api.football-data.org/v4/competitions/{leagueCode}/standings"
\`\`\`
League codes: PL (Premier League), BL1 (Bundesliga), SA (Serie A), PD (La Liga), FL1 (Ligue 1)

## Team Configuration

Get team from memory:
\`\`\`
chomp_recall_memories(query: "football_team", category: "preferences")
\`\`\`

No team saved: ask which team they follow, find its id with the API, and save it as a preference: \`football_team: <name> (football-data.org team id <id>)\`.

## Tips
- Match times are UTC — convert to user's timezone
- Format scores clearly: "Liverpool 3-1 Chelsea"
- Include competition name (Premier League, Champions League, etc.)`;

const GITHUB_SKILL = `# GitHub Skill

Use the \`gh\` CLI (already installed) to interact with GitHub.

## Usage

### List repos
\`\`\`bash
gh repo list --limit 10
\`\`\`

### Pull requests
\`\`\`bash
gh pr list                          # List open PRs in current repo
gh pr list --repo owner/repo        # List PRs in specific repo
gh pr view 123                      # View PR details
gh pr create --title "..." --body "..."
\`\`\`

### Issues
\`\`\`bash
gh issue list                       # List open issues
gh issue list --repo owner/repo
gh issue create --title "..." --body "..."
gh issue view 123
\`\`\`

### Notifications
\`\`\`bash
gh api notifications --jq '.[].subject.title'
\`\`\`

### API access
\`\`\`bash
gh api repos/{owner}/{repo}
gh api user
\`\`\`

## Tips
- gh CLI uses the user's existing GitHub authentication
- Always include --repo flag when working with specific repos
- For notifications, filter unread: \`gh api notifications?all=false\`
- Can create gists: \`gh gist create filename\``;

const GITHUB_ISSUE_AUTOFIX_SKILL = `# GitHub Issue Auto-Fix Skill

You are fixing a GitHub issue that Chomp has picked up automatically. The issue details are provided in your prompt. The issue has already been labeled \`chomp:in-progress\`.

## Workflow

1. Navigate to or clone the repository
2. Create a new branch: \`chomp/issue-{number}-{short-slug}\`
3. Read the issue carefully — understand what needs to change
4. Implement the fix
5. Run any existing tests (look for package.json scripts, Makefile, etc.)
6. Commit with a descriptive message referencing the issue
7. Push the branch and create a PR:
   \`\`\`bash
   gh pr create --title "Fix #{number}: {short description}" --body "Fixes #{number}\\n\\n{summary of changes}"
   \`\`\`
8. On success, relabel the issue:
   \`\`\`bash
   gh issue edit {number} --repo {owner/repo} --remove-label chomp:in-progress --add-label chomp:done
   \`\`\`
9. Send a summary via chomp_reply

## On Failure

If you cannot complete the fix:
1. Add a comment to the issue explaining what you tried and where you got stuck:
   \`\`\`bash
   gh issue comment {number} --repo {owner/repo} --body "Could not complete: {reason}"
   \`\`\`
2. Do NOT relabel — leave as \`chomp:in-progress\` for manual review
3. Send a summary via chomp_reply explaining the failure

## Important Rules

- **NEVER push directly to main/master** — always create a PR
- Reference the issue in the PR body with "Fixes #N" or "Closes #N"
- Keep commits clean and focused on the issue
- If the issue is vague, do your best interpretation — do not use chomp_ask_user (this is an automated flow)
- Run tests before creating the PR if a test suite exists`;

const GITHUB_IDEA_GENERATION_PROMPT = `You are a product strategist analyzing GitHub repositories to generate high-value feature ideas, improvements, and bug fixes.

You combine three sources of insight:
A) **Codebase analysis** — what the repo already does, its gaps, and technical debt
B) **Community signals** — open issues, discussions, and PR patterns
C) **Market & trend research** — what competitors, industry trends, and users expect

IMPORTANT: All repos are already cloned locally at ~/code/<repo-name> (e.g. ~/code/chomp for owner/chomp). Read files directly from the local checkout — this is much faster than using the GitHub API.

Steps:

1. Use get_setting to read "github_issue_repos" for the list of target repos

2. **Thoroughly audit the existing codebase (CRITICAL — do this BEFORE generating ideas):**
   - Read files directly from ~/code/<repo-name> — README, package.json / Cargo.toml / go.mod, etc.
   - Use \`find\` and \`ls\` to map the full directory structure
   - Read key source files, route definitions, component directories, and config files
   - Build a mental inventory of every feature the repo already has
   - Check CLAUDE.md or similar docs for architecture notes
   - This step prevents suggesting features that already exist — take your time here

3. **Analyze community signals via the gh CLI:**
   - Open issues (look for patterns, stale issues, common complaints, most-requested features)
   - Recent PRs and commits (identify areas of active development and momentum)
   - Code quality: grep for TODOs, FIXMEs, hack comments
   - README gaps, missing docs, test coverage opportunities

4. **Research market trends and competitors:**
   - Search the web for the repo's domain (e.g. "best practices for [domain] 2025", "[domain] trends")
   - Look at what similar/competing projects offer that this repo doesn't
   - Search for common user pain points in the space (e.g. "[project type] common issues")
   - Check for emerging standards, APIs, or integrations users now expect

5. **Synthesize ideas** — for each idea:
   - **First verify the feature doesn't already exist** by searching the codebase (grep for keywords, check routes, components, etc.)
   - Categorize as: \`feature\` (new capability), \`enhancement\` (improve existing), \`bug\` (potential issue), or \`dx\` (developer experience)
   - Explain *why* this matters (tie back to trend data, user demand, or competitive gap)
   - Estimate effort as S/M/L
   - Format the issue body with sections: **Context** (why now), **Proposal** (what to build), **Effort estimate**

6. **Repeat steps 2-5 for EVERY repository** in the list. Do not stop after the first repo — you MUST process all of them.

7. For each idea, create a GitHub issue with the "chomp:idea" label using create_github_issue
   - Title format: \`[category] Brief description\` (e.g. \`[feature] Add OAuth2 PKCE flow\`)
   - Keep ideas specific, actionable, and realistic — not vague "improve X" suggestions
   - Limit to 2-3 ideas **per repository** to avoid noise
   - Prioritize ideas that are high-impact and aligned with the project's direction

8. Send a summary via chomp_reply listing what ideas were proposed per repo, with a one-line rationale each

Do NOT implement anything — only propose ideas as issues. Humans will review and promote to chomp:ready if approved.

IMPORTANT: You must process ALL repositories in the list, not just the first one. Each repo gets its own analysis and its own set of 2-3 ideas.`;

const GMAIL_SKILL = `# Gmail Skill

Read and send emails via the Gmail API. Requires Google OAuth connection.

## Setup
The user must connect their Google account in Chomp Settings. Once connected, use the \`get_google_token\` MCP tool to get a fresh bearer token.

## Getting a Token
\`\`\`
Use the get_google_token MCP tool — it returns a bearer token string.
\`\`\`

## Usage

### List unread messages
\`\`\`bash
TOKEN=$(get_google_token)
curl -s -H "Authorization: Bearer $TOKEN" "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=10"
\`\`\`

### Get message details
\`\`\`bash
curl -s -H "Authorization: Bearer $TOKEN" "https://gmail.googleapis.com/gmail/v1/users/me/messages/{messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date"
\`\`\`

### Get full message
\`\`\`bash
curl -s -H "Authorization: Bearer $TOKEN" "https://gmail.googleapis.com/gmail/v1/users/me/messages/{messageId}?format=full"
\`\`\`

### Create draft (always draft for review — do NOT send directly)
\`\`\`bash
# Base64url encode the email
RAW=$(printf "To: recipient@example.com\\nSubject: Hello\\nContent-Type: text/plain\\n\\nMessage body here" | base64 | tr '+/' '-_' | tr -d '=')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d "{\\"message\\": {\\"raw\\": \\"$RAW\\"}}" \\
  "https://gmail.googleapis.com/gmail/v1/users/me/drafts"
\`\`\`

### Search messages
\`\`\`bash
curl -s -H "Authorization: Bearer $TOKEN" "https://gmail.googleapis.com/gmail/v1/users/me/messages?q={searchQuery}&maxResults=5"
\`\`\`

## Tips
- Always use get_google_token MCP tool — never hardcode tokens
- If token returns an error, tell the user to reconnect Google in Settings
- For the morning brief, just list top 3-5 unread with subject and sender
- Always ask before sending emails on behalf of the user`;

const CALENDAR_SKILL = `# Google Calendar Skill

Read and create calendar events via the Google Calendar API. Requires Google OAuth connection.

## Setup
The user must connect their Google account in Chomp Settings. Use the \`get_google_token\` MCP tool to get a fresh bearer token.

## Usage

### List today's events
\`\`\`bash
TOKEN=$(get_google_token)
TODAY=$(date -u +%Y-%m-%dT00:00:00Z)
TOMORROW=$(date -u -d "+1 day" +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -v+1d +%Y-%m-%dT00:00:00Z)
curl -s -H "Authorization: Bearer $TOKEN" \\
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=$TODAY&timeMax=$TOMORROW&singleEvents=true&orderBy=startTime"
\`\`\`

### List upcoming events (next 7 days)
\`\`\`bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s -H "Authorization: Bearer $TOKEN" \\
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=$NOW&maxResults=10&singleEvents=true&orderBy=startTime"
\`\`\`

### Create an event
\`\`\`bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{
    "summary": "Meeting title",
    "start": {"dateTime": "2024-01-15T10:00:00", "timeZone": "Europe/London"},
    "end": {"dateTime": "2024-01-15T11:00:00", "timeZone": "Europe/London"},
    "description": "Optional description"
  }' \\
  "https://www.googleapis.com/calendar/v3/calendars/primary/events"
\`\`\`

### Get event details
\`\`\`bash
curl -s -H "Authorization: Bearer $TOKEN" \\
  "https://www.googleapis.com/calendar/v3/calendars/primary/events/{eventId}"
\`\`\`

## Tips
- Always use get_google_token MCP tool for the bearer token
- Times should include timezone — check user preferences for their timezone
- For the morning brief, show today's events with times and titles
- Always ask before creating/modifying events
- singleEvents=true expands recurring events into individual instances`;

// ── Dream Memory Consolidation Skill ────────────────────────────

const DREAM_SKILL = `# Dream: learn from the week

A memory store only gets better if something reads what actually happened. The dream reads the last week of chats next to the memories, finds what agents keep getting wrong, and proposes memory changes **with evidence**. The user approves; nothing changes before that.

Two modes:
- **Dream** (\`/dream\`, "consolidate memories", the weekly rule): Phases 1 to 4. Ends with a review form. Changes no memory.
- **Apply** (the user's message starts with "Apply dream proposals"): Phase 5 only.

## Phase 1: Read

\`\`\`
chomp_dream_digest(days: 7)
chomp_recall_memories(limit: 200, use_semantic: false)
\`\`\`

The digest lists recurring failures first, then user pushback, then each conversation's turns with their failed commands. Memories are what agents are told. Your job is the gap between the two.

## Phase 2: Find patterns, in this order

1. **A failure recurs and no memory covers it** → \`add\` a lesson: "what went wrong → what works instead".
2. **A failure recurs although a lesson already covers it** → the lesson is not reaching agents. This is the most valuable find. Propose \`update\` to put the fix in the first sentence, or move a short, costly one to \`instructions\` (that tier is always injected, so be stingy).
3. **The user pushed back on the same kind of thing more than once** → \`add\` or \`update\` a preference or instruction in the user's own terms.
4. **A memory the transcripts show is false or stale** (a path, host, tool, rule or habit that changed) → \`update\` or \`retire\`.
5. **Duplicates and merge candidates** → \`merge\`, only when it clearly cuts noise.

A pattern needs 2+ occurrences, or one occurrence with clear user pushback. One-off failures are noise; leave them.

### Rules

- **Evidence or it doesn't exist.** Every proposal cites conversation ids (the 8-char ids in the digest), a count, and a short quote from the digest.
- At most 10 proposals. Rank by how much agent time or user annoyance each one saves.
- Core tier (\`instructions\`, \`preferences\`, \`facts\`, and anything with source user or seed): change only to fix something false. Never just to reword it.
- Never propose storing passwords, keys, tokens or anything from private or therapy conversations.
- Don't invent. Proposed content comes from the transcripts and the existing memories.

## Phase 3: Save the proposals

Write \`~/chomp-work/dream/YYYY-MM-DD.json\` (today's date):

\`\`\`json
[
  {
    "id": "P1",
    "action": "add | update | retire | merge",
    "category": "lessons",
    "memoryIds": ["ids the action touches; empty for add"],
    "content": "the full new memory text (add, update, merge)",
    "why": "one sentence",
    "evidence": { "conversations": ["e5ddc611"], "count": 3, "quote": "sqlite3: command not found" }
  }
]
\`\`\`

The apply turn reads this file. It may run in another session, so the file is the only state that carries over.

## Phase 4: Report

Your final message is the report:

1. One line: digest stats (conversations, failures, pushback) and the number of proposals.
2. A \`data-table\` canvas of the proposals: ID, action, what changes, evidence (count + conversations).
3. A \`form\` canvas with one unchecked checkbox per proposal. The label starts with the proposal id:

\`\`\`
:::canvas
{"type":"form","title":"Dream proposals","submitLabel":"Apply selected","prompt":"Apply dream proposals from ~/chomp-work/dream/YYYY-MM-DD.json:","fields":[
  {"name":"P1","label":"P1: add lesson, sqlite3 is not installed","type":"checkbox"},
  {"name":"P2","label":"P2: retire the stale runner-mode memory","type":"checkbox"}
]}
:::
\`\`\`

With zero proposals, say so in one line and skip both canvases.

## Phase 5: Apply

The user's message starts "Apply dream proposals from <file>:", followed by one \`label: value\` line per checkbox. Apply only the lines whose value is true, matching on the leading \`P<n>\`:

- \`add\`: \`chomp_recall_memories\` with the content as query first; if a near-duplicate exists, \`update\` it instead. Then \`chomp_save_memory(content, category)\`.
- \`update\`: \`chomp_update_memory(id, content)\`.
- \`retire\`: \`chomp_delete_memory(id)\`. It retires the memory (hidden, restorable), it doesn't erase it.
- \`merge\`: save the merged memory, then \`chomp_delete_memory\` each fragment.

Then add \`"applied": ["P1", ...]\` and \`"appliedAt"\` to the file, and reply with what changed, including memory ids. If the file is missing or a proposal's memory no longer exists, say so. Don't guess.`;

// ── Skill Definitions ───────────────────────────────────────────

interface SkillDef {
  name: string;
  description: string;
  content: string;
  source?: "user" | "system";
}

const DATA_SOURCE_SKILLS: SkillDef[] = [
  { name: "weather", description: "Fetch weather using wttr.in API (free, no key required)", content: WEATHER_SKILL },
  { name: "crypto-prices", description: "Fetch crypto prices from CoinGecko API (free, no key required)", content: CRYPTO_SKILL },
  { name: "stock-prices", description: "Fetch stock quotes from Finnhub API (requires FINNHUB_API_KEY)", content: STOCKS_SKILL },
  { name: "news", description: "Fetch top headlines from NewsAPI (requires NEWSAPI_KEY)", content: NEWS_SKILL },
  { name: "ai-trends", description: "Fetch AI/ML news from Hacker News API (free, no key required)", content: AI_TRENDS_SKILL },
  { name: "x-trends", description: "Find current public X/Twitter conversation themes with built-in web search tools", content: X_TRENDS_SKILL },
  { name: "football", description: "Fetch football/soccer data from football-data.org (requires FOOTBALL_DATA_KEY)", content: FOOTBALL_SKILL },
  { name: "github", description: "Interact with GitHub using the gh CLI (repos, PRs, issues, notifications)", content: GITHUB_SKILL },
  { name: "github-issue-autofix", description: "Workflow for automatically fixing GitHub issues: branch, implement, PR, relabel", content: GITHUB_ISSUE_AUTOFIX_SKILL },
  { name: "gmail", description: "Read emails and create drafts via Gmail API (requires Google OAuth connection)", content: GMAIL_SKILL },
  { name: "google-calendar", description: "Read and create calendar events via Google Calendar API (requires Google OAuth connection)", content: CALENDAR_SKILL },
  { name: "dream", description: "Memory dream: read the last week of chats next to the memory store, find what agents keep getting wrong, and propose memory changes with evidence for the user to approve. Use when the user says /dream, 'clean up memories', 'consolidate memories', 'tidy memories', or replies 'Apply dream proposals'.", content: DREAM_SKILL },
];

// ── Seed Function ───────────────────────────────────────────────

export function seedDefaults() {
  const now = new Date().toISOString();

  migrateAgentNamesToTargets();

  // Seed or update chomp-agent skill (system — never synced to ~/.claude/skills)
  seedOrUpdateSkill({ name: "chomp-agent", description: "How an agent works inside Chomp: replies, memory and canvas.", content: CHOMP_AGENT_SKILL, source: "system" });

  // Seed data source skills
  for (const skill of DATA_SOURCE_SKILLS) {
    seedOrUpdateSkill(skill);
  }

  seedOrUpdateSkill(chompSelfSkill());
  seedOrUpdateSkill(phoneWidgetSkill());
  seedOrUpdateSkill(appleShortcutsSkill());
  seedOrUpdateSkill(socialPublishSkill());

  // ── Proactive rules: declarative upsert ────────────────────────
  // Code-owned fields (triggerType, condition, actionType, actionConfig) are
  // always synced on startup so seed.ts changes propagate after deploy.
  // User-customizable fields (enabled, cooldownMinutes, activeHours, priority)
  // are only set on first insert — never overwritten.

  const morningBriefPrompt = `Write and publish today's morning report for the user. It becomes a one-reader newspaper page and a voice note.

The point: tell them what matters today and connect the dots, instead of listing feeds. Their home, timezone, travel habits and preferences are in your stored memories; use them. The \`morning-brief\` skill shows how to reach each source; this prompt decides the format.

Gather ALL of these before writing:
- Today's and this week's calendar (\`list_events\`) and overnight mail (\`search_email\`, \`read_email\`).
- Weather for where they will be.
- Whether their football team plays today, if a \`football_team\` preference is saved (see the \`football\` skill). The page shows the week's fixtures by itself, but a match today must also be in the report.
- AI and tech stories (Hacker News, see the skill) and general news. Actually search; do not skip this step.

Work out where they wake up today and where they will be tomorrow, from calendar and mail such as flights and hotel check-ins. Do not assume they are at home, and do not trust a stale phone location. If it is unclear, say so in the lead.

If they fly tomorrow, and only then, tell them when to leave and how, in headsUp and one sentence of voiceScript:
- Read the booking confirmation in mail (search by flight number or airline) for fare and bags, and say what you inferred, e.g. "LowFare, no bag, no fast track".
- Fast track only if the booking shows it: a bought Fast Track add-on, a business fare, or a flexible fare that includes it (often only at some airports, so say so if you cannot confirm the airport). Otherwise assume none.
- How early to be at the airport, and how they get there from home or from where they stay (taxi, train, how long it takes), is in their memories. Without such a memory, use 75 minutes before departure (120 outside Schengen), add 15 with a checked bag, take 15 off with fast track, and call the way there an estimate.
- If a memory or the \`morning-brief\` skill names a script for real train departures, use it; never invent a train time. Without one, give only the time to be at the airport.

Then call \`publish_morning_report\` once, with:

- date: today in the user's time zone, YYYY-MM-DD.
- place: where they wake up, e.g. Lisbon. It becomes the dateline.
- headline: the one thing that matters today, as one short sentence of at most 10 words, with no full stop. It is set very large, so write it like a front page, specific to today. Never a greeting.
- lead: two or three short paragraphs, separated by a blank line. Connect calendar, mail and travel into sentences. Name anything that needs an answer from them. Do not start with the place or day, because the dateline is added for you.
- headsUp: only if useful: what to pack, what the weather means, things to remember for the kids or family that are in the calendar, the airport plan the day before a flight, and on a match day the opponent and kick-off in the user's time zone. Do not repeat what the week already shows.
- travel: trips from mail that the calendar lacks, one entry per day in the coming week: e.g. {date, title: "In Paris"}, and {date, time: "15:15", title: "BA304 LHR to CDG"}. Skip anything already in the calendar.
- weather: for where they will actually be: summary in at most 5 words, high, low, sunrise and sunset as HH:mm.
- take: include this every day: one thing from AI or tech they would actually care about, tied to what they work on, with your opinion and a link. Use \`x-trends\` only if it has real signal.
- news: up to three items that genuinely matter, each with a url and a one-line why. Leave it out only if nothing passes the bar.
- inbox: only mail they would want to act on, with the action. No newsletters.
- suggestions: up to three things they might want done about today, as short prompts in their own voice, tied to something in the report, e.g. "Draft a reply to the landlord about the invoice". Only things Chomp could really do.
- voiceScript: 60 to 90 seconds, under 1500 characters, written to be heard while getting ready. Talk to them. Lead with what matters, skip links and lists, and do not read the page aloud. It is the TLDR, so it can leave things for the page.

Leave out stock and crypto prices unless their memories ask for them.

Every news or tech item needs a dated source from the last 14 days. Use Gmail and Calendar when they are connected. Never invent an event, a flight or a number; if you do not know, leave it out.

TONE: follow the soul and their stored tone preferences. Do NOT end the voice note with a forced punchline question.

After the report is published, put what matters today and tomorrow on the iPhone widget. Load the \`phone-widget\` skill and call \`list_phone_cards\` first.

- Use the group \`morning-YYYY-MM-DD\` with today's date, on the board \`today\`, with at most 5 cards. A card is something to be at or act on: a calendar event with a time, a match today, a thing for the kids from the calendar, or mail in \`inbox\` that needs an answer. No cards for news, the take, or weather alone.
- Each card shows in the hours before its time and ends when it is over. Put the time in the headline. Set \`source\` to "Morning report" and \`checkedAt\` to now.
- Give a card alerts only if missing it costs something, such as a time to leave.
- A flight today or tomorrow gets its own group \`trip-YYYY-MM-DD\` with the departure date, on the board \`travel\`, one card per stage as the skill shows, using the airport plan above worked out the same way for a flight today. Skip this if \`list_phone_cards\` already has that group, because the user or another agent may have set its times.
- Never publish over or remove any other group. Never invent a gate, a seat or a train time. If nothing qualifies, publish nothing.
- The cards do not change the final message. An error saying the phone was not reached is fine, because the cards are saved. If \`publish_phone_cards\` returns any other error, make your final message that error text.

The tool sends the voice note and the link to Telegram. If it succeeds, make your final message exactly [SILENT]. If it returns an error, make your final message the error text plus the headline and lead, so they still get the news.`;

  const autofixPrompt = `Scan configured GitHub repos for issues labeled "chomp:ready" and auto-fix them.

For each ready issue:
1. Read the issue details and understand the problem
2. Clone/navigate to the repo, create a fix branch
3. Implement the fix, run tests
4. Create a PR referencing the issue
5. Relabel: remove chomp:in-progress, add chomp:done
6. Report results via chomp_reply

This rule uses the github-issues pre-dispatch triage system which dynamically builds the full prompt with issue context.`;

  interface RuleDef {
    name: string;
    /** Alias names this rule was previously known as — matched during lookup */
    aliases?: string[];
    triggerType: string;
    condition: string;
    actionType: string;
    actionConfig: string;
    /** Added once, switched off, and never synced again: the user's own version of the rule wins. */
    insertOnly?: boolean;
    /** Defaults for first insert only */
    defaults: { enabled: boolean; cooldownMinutes: number; activeHours: string; priority: number };
  }

  const ruleDefs: RuleDef[] = [
    {
      name: "Service down alert",
      triggerType: "event",
      condition: JSON.stringify({ eventType: "service.health.changed", conditions: [{ field: "newStatus", op: "eq", value: "down" }] }),
      actionType: "notify",
      actionConfig: JSON.stringify({ title: "Service Down", body: "A connected service is unreachable." }),
      defaults: { enabled: true, cooldownMinutes: 30, activeHours: "{}", priority: 10 },
    },
    {
      name: "Service recovered",
      triggerType: "event",
      condition: JSON.stringify({ eventType: "service.health.changed", conditions: [{ field: "newStatus", op: "eq", value: "healthy" }] }),
      actionType: "notify",
      actionConfig: JSON.stringify({ title: "Service Recovered", body: "A previously down service is back online." }),
      defaults: { enabled: true, cooldownMinutes: 5, activeHours: "{}", priority: 5 },
    },
    {
      name: "Schedule failure",
      triggerType: "event",
      condition: JSON.stringify({ eventType: "schedule.failed", conditions: [] }),
      actionType: "notify",
      actionConfig: JSON.stringify({ title: "Schedule Failed", body: "A scheduled task has failed." }),
      defaults: { enabled: true, cooldownMinutes: 15, activeHours: "{}", priority: 8 },
    },
    {
      name: "Morning brief",
      aliases: ["Daily brief"],
      triggerType: "periodic",
      condition: "{}",
      actionType: "run_agent",
      actionConfig: JSON.stringify({ provider: "claude", model: "sonnet", prompt: morningBriefPrompt }),
      defaults: { enabled: false, cooldownMinutes: 1440, activeHours: JSON.stringify({ start: 8, end: 9 }), priority: 1 },
    },
    {
      name: "GitHub issue labeled chomp:ready",
      triggerType: "event",
      condition: JSON.stringify({
        eventType: "webhook.received",
        conditions: [
          { field: "headers.x-github-event", op: "eq", value: "issues" },
          { field: "payload.action", op: "eq", value: "labeled" },
          { field: "payload.label.name", op: "eq", value: "chomp:ready" },
        ],
      }),
      actionType: "run_agent",
      actionConfig: JSON.stringify({ provider: "claude", preDispatch: "github-issues" }),
      defaults: { enabled: true, cooldownMinutes: 1, activeHours: "{}", priority: 10 },
    },
    {
      name: "GitHub issue auto-fix",
      triggerType: "periodic",
      condition: "{}",
      actionType: "run_agent",
      actionConfig: JSON.stringify({ provider: "claude", preDispatch: "github-issues", prompt: autofixPrompt }),
      defaults: { enabled: false, cooldownMinutes: 60, activeHours: "{}", priority: 5 },
    },
    {
      name: "GitHub issue ideas",
      triggerType: "periodic",
      condition: "{}",
      actionType: "run_agent",
      actionConfig: JSON.stringify({ provider: "claude", model: "sonnet", prompt: GITHUB_IDEA_GENERATION_PROMPT }),
      defaults: { enabled: false, cooldownMinutes: 1440, activeHours: JSON.stringify({ start: 9, end: 17 }), priority: 3 },
    },
    {
      name: "Worktree cleanup",
      triggerType: "periodic",
      condition: "{}",
      actionType: "run_agent",
      actionConfig: JSON.stringify({ preDispatch: "worktree-cleanup", provider: "claude", prompt: "" }),
      defaults: { enabled: true, cooldownMinutes: 60, activeHours: "{}", priority: 1 },
    },
    // ── Maintenance templates: off until the user switches them on ───
    {
      name: "Memory dream: weekly transcript review (Sun 20:00)",
      insertOnly: true,
      triggerType: "periodic",
      condition: JSON.stringify({ guard: { mode: "all", rules: [{ type: "weekday", days: ["Sun"] }] } }),
      actionType: "run_agent",
      actionConfig: JSON.stringify({ provider: "claude", model: "opus", prompt: MEMORY_DREAM_RULE_PROMPT }),
      defaults: { enabled: false, cooldownMinutes: 1380, activeHours: JSON.stringify({ start: 20, end: 21 }), priority: 0 },
    },
    {
      name: "Memory review — fresh auto memories (weekly, gated)",
      insertOnly: true,
      triggerType: "periodic",
      condition: JSON.stringify({ guard: { mode: "all", rules: [{ type: "weekday", days: ["Sun"] }] } }),
      actionType: "script_gate",
      actionConfig: JSON.stringify({ script: "memory_candidates", input: { lookbackDays: 8 }, onTrue: { provider: "claude", model: "sonnet", prompt: MEMORY_REVIEW_RULE_PROMPT } }),
      defaults: { enabled: false, cooldownMinutes: 1380, activeHours: JSON.stringify({ start: 3, end: 4 }), priority: 0 },
    },
    {
      name: "Skill review (monthly, own skills)",
      insertOnly: true,
      triggerType: "periodic",
      condition: JSON.stringify({ guard: { mode: "all", rules: [{ type: "weekday", days: ["Sun"] }] } }),
      actionType: "run_agent",
      actionConfig: JSON.stringify({ provider: "claude", model: "opus", prompt: SKILL_REVIEW_RULE_PROMPT }),
      defaults: { enabled: false, cooldownMinutes: 39600, activeHours: JSON.stringify({ start: 10, end: 11 }), priority: 0 },
    },
    {
      name: "Tailscale key-expiry watch (weekly)",
      insertOnly: true,
      triggerType: "periodic",
      condition: JSON.stringify({ guard: { mode: "all", rules: [{ type: "weekday", days: ["Mon"] }] } }),
      actionType: "run_agent",
      actionConfig: JSON.stringify({ provider: "claude", model: "sonnet", prompt: TAILSCALE_KEY_RULE_PROMPT }),
      defaults: { enabled: false, cooldownMinutes: 10080, activeHours: JSON.stringify({ start: 9, end: 10 }), priority: 0 },
    },
    // ── Webhook-triggered templates ───────────────────────────────
    {
      name: "Webhook received — notify",
      triggerType: "event",
      condition: JSON.stringify({ eventType: "webhook.received", conditions: [] }),
      actionType: "notify",
      actionConfig: JSON.stringify({ title: "Webhook received: {{webhookName}}", body: "Payload preview:\n{{payloadPreview}}" }),
      defaults: { enabled: false, cooldownMinutes: 0, activeHours: "{}", priority: 3 },
    },
    {
      name: "Webhook received — run agent",
      triggerType: "event",
      condition: JSON.stringify({ eventType: "webhook.received", conditions: [] }),
      actionType: "run_agent",
      actionConfig: JSON.stringify({
        provider: "claude",
        model: "sonnet",
        prompt: `A webhook was received from "{{webhookName}}". Analyse the payload and take appropriate action.

Webhook payload:
{{payload}}

Use chomp_reply to report what you found and what action you took.`,
      }),
      defaults: { enabled: false, cooldownMinutes: 5, activeHours: "{}", priority: 3 },
    },
    {
      name: "GitHub push — summarize commits",
      triggerType: "event",
      condition: JSON.stringify({ eventType: "webhook.received", conditions: [{ field: "webhookName", op: "contains", value: "github" }] }),
      actionType: "run_agent",
      actionConfig: JSON.stringify({
        provider: "claude",
        model: "sonnet",
        prompt: `A GitHub webhook was received. The payload is:

{{payload}}

If this is a push event, summarize the commits: list the branch, number of commits, and a one-sentence description of each commit message. If it is another event type, briefly describe what happened.

Send the summary via chomp_reply.`,
      }),
      defaults: { enabled: false, cooldownMinutes: 1, activeHours: "{}", priority: 5 },
    },
  ];

  const existingRules = db.select().from(proactiveRules).all();

  for (const def of ruleDefs) {
    const allNames = [def.name, ...(def.aliases ?? [])];
    const existing = existingRules.find((r) => allNames.includes(r.name));

    if (!existing) {
      db.insert(proactiveRules).values({
        id: randomUUID(),
        name: def.name,
        triggerType: def.triggerType,
        condition: def.condition,
        actionType: def.actionType,
        actionConfig: def.actionConfig,
        enabled: def.defaults.enabled,
        cooldownMinutes: def.defaults.cooldownMinutes,
        activeHours: def.defaults.activeHours,
        priority: def.defaults.priority,
        createdAt: now,
        updatedAt: now,
      }).run();
      console.log(`Seeded proactive rule: ${def.name}`);
    } else if (!def.insertOnly) {
      // Sync code-owned fields; preserve user-customizable fields.
      // Within actionConfig, `model` is user-customizable (set via the UI) —
      // exclude it from the change-detection comparison and preserve it on update.
      const USER_OWNED_ACTION_CONFIG_KEYS = ["model"] as const;

      const existingConfig = JSON.parse(existing.actionConfig ?? "{}") as Record<string, unknown>;
      const seedConfig = JSON.parse(def.actionConfig) as Record<string, unknown>;

      // Strip user-owned keys before comparing so a user-changed model doesn't
      // trigger a "code changed" update that would wipe their customisation.
      const existingConfigForCompare = { ...existingConfig };
      const seedConfigForCompare = { ...seedConfig };
      for (const key of USER_OWNED_ACTION_CONFIG_KEYS) {
        delete existingConfigForCompare[key];
        delete seedConfigForCompare[key];
      }

      const needsUpdate =
        existing.name !== def.name ||
        existing.triggerType !== def.triggerType ||
        existing.condition !== def.condition ||
        existing.actionType !== def.actionType ||
        JSON.stringify(existingConfigForCompare) !== JSON.stringify(seedConfigForCompare);

      if (needsUpdate) {
        // Build merged actionConfig: seed values win for code-owned keys,
        // but keep whatever the user set for user-owned keys.
        const mergedConfig = { ...seedConfig };
        for (const key of USER_OWNED_ACTION_CONFIG_KEYS) {
          if (existingConfig[key] !== undefined) {
            mergedConfig[key] = existingConfig[key];
          }
        }

        db.update(proactiveRules).set({
          name: def.name,
          triggerType: def.triggerType,
          condition: def.condition,
          actionType: def.actionType,
          actionConfig: JSON.stringify(mergedConfig),
          updatedAt: now,
        }).where(eq(proactiveRules.id, existing.id)).run();
        console.log(`Updated proactive rule: ${def.name}`);
      }
    }
  }

  // Seed default soul into souls table if none exists
  const existingSouls = db.select().from(souls).all();
  if (existingSouls.length === 0) {
    const now = new Date().toISOString();
    db.insert(souls).values({
      id: randomUUID(),
      name: "Balanced",
      description: "Direct, witty, and opinionated — assign to an agent to activate",
      content: DEFAULT_SOUL,
      color: "violet",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    }).run();
    console.log("Seeded example soul (not active by default)");
  }

  seedDefaultSettings();

  // Seed default preferences (as memories)

  // MCP sync only runs on explicit push from Settings UI — never auto on startup
}

/** Seed or update a skill by name */
function seedOrUpdateSkill(def: SkillDef) {
  const now = new Date().toISOString();
  const existingSkills = db.select().from(skills).all();
  const existing = existingSkills.find((s) => s.name === def.name);

  const source = def.source ?? "user";

  if (!existing) {
    const skill = {
      id: randomUUID(),
      name: def.name,
      description: def.description,
      content: def.content,
      source,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(skills).values(skill).run();
    if (source === "user") syncSkill(skill);
    console.log(`Seeded skill: ${def.name}`);
  } else if (existing.content !== def.content) {
    db.update(skills)
      .set({ content: def.content, description: def.description, source, updatedAt: now })
      .where(eq(skills.id, existing.id))
      .run();
    if (source === "user") syncSkill({ ...existing, content: def.content });
    console.log(`Updated skill: ${def.name}`);
  }
}

