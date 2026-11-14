export type CommandCategory =
  | "Core"
  | "Agents & Sessions"
  | "Memory"
  | "Schedules & Rules"
  | "Calendar & Email"
  | "GitHub"
  | "Info"
  | "Data"
  | "Config";

export interface DiscordOptionSpec {
  name: string;
  description: string;
  required?: boolean;
}

export interface ChannelCommandSpec {
  category: CommandCategory;
  handler: string;
  description: string;
  telegram?: {
    name: string;
    usage?: string;
  };
  discord?: {
    name: string;
    description: string;
    option?: DiscordOptionSpec;
  };
}

const CATEGORIES: CommandCategory[] = [
  "Core",
  "Agents & Sessions",
  "Memory",
  "Schedules & Rules",
  "Calendar & Email",
  "GitHub",
  "Info",
  "Data",
  "Config",
];

export const CHANNEL_COMMANDS: ChannelCommandSpec[] = [
  { category: "Core", handler: "help", description: "this message", telegram: { name: "help" }, discord: { name: "help", description: "Show all available commands" } },
  { category: "Core", handler: "status", description: "agents, schedules, services overview", telegram: { name: "status" }, discord: { name: "status", description: "Agents, schedules, services overview" } },
  { category: "Core", handler: "fresh", description: "start a fresh conversation", telegram: { name: "new" }, discord: { name: "fresh", description: "Start a fresh conversation" } },
  { category: "Core", handler: "resume", description: "resume the previous conversation", discord: { name: "resume", description: "Resume the previous conversation" } },

  { category: "Agents & Sessions", handler: "agents", description: "list all agents", telegram: { name: "agents" }, discord: { name: "agents", description: "List all agents" } },
  { category: "Agents & Sessions", handler: "sessions", description: "active and recent agent sessions", telegram: { name: "sessions" }, discord: { name: "sessions", description: "Active and recent agent sessions" } },
  { category: "Agents & Sessions", handler: "run", description: "run a named agent", telegram: { name: "run", usage: "<name>" }, discord: { name: "run", description: "Run a named agent", option: { name: "name", description: "Agent name", required: true } } },
  { category: "Agents & Sessions", handler: "use", description: "use a specific agent for next message", telegram: { name: "use", usage: "<agent>" }, discord: { name: "use", description: "Use a specific agent for next message", option: { name: "agent", description: "Agent name", required: true } } },
  { category: "Agents & Sessions", handler: "kill", description: "kill all running agents", telegram: { name: "kill" }, discord: { name: "kill", description: "Kill all running agents" } },
  { category: "Agents & Sessions", handler: "kill-id", description: "kill a specific session", telegram: { name: "kill_", usage: "<id>" } },

  { category: "Memory", handler: "memories", description: "list stored memories", telegram: { name: "memories" }, discord: { name: "memories", description: "List stored memories" } },
  { category: "Memory", handler: "remember", description: "store a memory", telegram: { name: "remember", usage: "<text>" }, discord: { name: "remember", description: "Store a memory", option: { name: "text", description: "What to remember", required: true } } },
  { category: "Memory", handler: "recall", description: "search memories", telegram: { name: "recall", usage: "<query>" }, discord: { name: "recall", description: "Search memories", option: { name: "query", description: "Search query", required: true } } },

  { category: "Schedules & Rules", handler: "schedules", description: "list all schedules", telegram: { name: "schedules" }, discord: { name: "schedules", description: "List all schedules" } },
  { category: "Schedules & Rules", handler: "pause", description: "pause all schedules", telegram: { name: "pause" }, discord: { name: "pause", description: "Pause all schedules" } },
  { category: "Schedules & Rules", handler: "mute", description: "pause for a duration", telegram: { name: "mute", usage: "<duration>" }, discord: { name: "mute", description: "Pause schedules for a duration", option: { name: "duration", description: "e.g. 1h, 30m, 2h30m", required: true } } },
  { category: "Schedules & Rules", handler: "enable-id", description: "enable a schedule by ID prefix", telegram: { name: "enable_", usage: "<id>" } },
  { category: "Schedules & Rules", handler: "disable-id", description: "disable a schedule by ID prefix", telegram: { name: "disable_", usage: "<id>" } },
  { category: "Schedules & Rules", handler: "rules", description: "list proactive rules", telegram: { name: "rules" }, discord: { name: "rules", description: "List proactive rules" } },
  { category: "Schedules & Rules", handler: "trigger", description: "manually trigger a rule", telegram: { name: "trigger", usage: "<rule-name>" }, discord: { name: "trigger", description: "Manually trigger a proactive rule", option: { name: "rule", description: "Rule name (partial match)", required: true } } },

  { category: "Calendar & Email", handler: "today", description: "today's calendar events", telegram: { name: "today" }, discord: { name: "today", description: "Today's calendar events" } },
  { category: "Calendar & Email", handler: "tomorrow", description: "tomorrow's calendar events", telegram: { name: "tomorrow" }, discord: { name: "tomorrow", description: "Tomorrow's calendar events" } },
  { category: "Calendar & Email", handler: "event", description: "create a calendar event", telegram: { name: "event" }, discord: { name: "event", description: "Create a calendar event", option: { name: "details", description: "Event details (optional)" } } },
  { category: "Calendar & Email", handler: "inbox", description: "check unread emails", telegram: { name: "inbox" }, discord: { name: "inbox", description: "Check unread emails" } },
  { category: "Calendar & Email", handler: "email", description: "read a specific email", telegram: { name: "email", usage: "<id>" }, discord: { name: "email", description: "Read a specific email", option: { name: "id", description: "Email ID", required: true } } },
  { category: "Calendar & Email", handler: "draft", description: "draft an email", telegram: { name: "draft" }, discord: { name: "draft", description: "Draft an email", option: { name: "details", description: "Email details (optional)" } } },

  { category: "GitHub", handler: "issues", description: "list recent GitHub issues", telegram: { name: "issues" }, discord: { name: "issues", description: "List recent GitHub issues" } },
  { category: "GitHub", handler: "issue", description: "show a specific issue", telegram: { name: "issue", usage: "<repo>#<num>" }, discord: { name: "issue", description: "Show a specific GitHub issue", option: { name: "ref", description: "repo#number", required: true } } },
  { category: "GitHub", handler: "create-issue", description: "create an issue", telegram: { name: "createissue", usage: "<repo> <title>" }, discord: { name: "createissue", description: "Create a GitHub issue", option: { name: "args", description: "repo title...", required: true } } },

  { category: "Info", handler: "weather", description: "current weather", telegram: { name: "weather" }, discord: { name: "weather", description: "Current weather" } },
  { category: "Info", handler: "crypto", description: "crypto prices", telegram: { name: "crypto" }, discord: { name: "crypto", description: "Crypto prices" } },
  { category: "Info", handler: "stocks", description: "stock prices", telegram: { name: "stocks" }, discord: { name: "stocks", description: "Stock prices" } },
  { category: "Info", handler: "news", description: "latest tech/AI news", telegram: { name: "news" }, discord: { name: "news", description: "Latest tech/AI news" } },

  { category: "Data", handler: "conversations", description: "list recent conversations", telegram: { name: "chats" }, discord: { name: "conversations", description: "List recent conversations" } },
  { category: "Data", handler: "search", description: "search conversations", telegram: { name: "search", usage: "<query>" }, discord: { name: "search", description: "Search conversations", option: { name: "query", description: "Search query", required: true } } },
  { category: "Data", handler: "recipes", description: "search recipes", telegram: { name: "recipes", usage: "<query>" }, discord: { name: "recipes", description: "Search recipes", option: { name: "query", description: "Search query", required: true } } },
  { category: "Data", handler: "drive", description: "list Google Drive files", telegram: { name: "drive" }, discord: { name: "drive", description: "List Google Drive files" } },

  { category: "Config", handler: "settings", description: "show key settings", telegram: { name: "settings" }, discord: { name: "settings", description: "Show key settings" } },
  { category: "Config", handler: "webhooks", description: "list webhooks", telegram: { name: "webhooks" }, discord: { name: "webhooks", description: "List webhooks" } },
];

function commandsByCategory() {
  return CATEGORIES.map((category) => ({
    category,
    commands: CHANNEL_COMMANDS.filter((command) => command.category === category),
  })).filter((group) => group.commands.length > 0);
}

export function getDiscordCommandSpecs(): Array<Required<Pick<ChannelCommandSpec, "handler">> & NonNullable<ChannelCommandSpec["discord"]>> {
  return CHANNEL_COMMANDS.flatMap((command) => (
    command.discord ? [{ handler: command.handler, ...command.discord }] : []
  ));
}

export const TELEGRAM_CHATS_GUIDE = [
  "Every reply starts with the chat it belongs to.",
  "• Just type: continues that chat (after 6 hours quiet, a new one starts)",
  "• Swipe-reply a message: continues the chat it came from",
  "• /new starts a new chat, /chats switches",
].join("\n");

export function renderTelegramHelp(): string {
  return [
    "<b>How chats work</b>",
    TELEGRAM_CHATS_GUIDE,
    "",
    "<b>Chomp Commands</b>",
    "",
    ...commandsByCategory().flatMap(({ category, commands }) => [
      `<b>${category.replace("&", "&amp;")}</b>`,
      ...commands
        .filter((command) => command.telegram)
        .map((command) => {
          const telegram = command.telegram!;
          const usage = telegram.usage ? ` ${telegram.usage}` : "";
          return `/${telegram.name}${usage} — ${command.description}`;
        }),
      "",
    ]),
  ].join("\n").trim();
}

export function renderDiscordHelp(): string {
  return [
    "**Chomp Commands**\n",
    ...commandsByCategory().flatMap(({ category, commands }) => [
      `**${category}**`,
      ...commands
        .filter((command) => command.discord)
        .map((command) => {
          const discord = command.discord!;
          const usage = discord.option ? ` <${discord.option.name}>` : "";
          return `\`/${discord.name}${usage}\` — ${command.description}`;
        }),
      "",
    ]),
  ].join("\n").trim();
}

// ── Delegated commands ──────────────────────────────────────────
//
// These commands have no channel-specific behavior — they just forward a prompt
// to the chat handler. Centralizing the prompts here means a fix lands in both
// Telegram and Discord at once, instead of drifting between two switch
// statements.

export type DelegatedPromptOutcome =
  | { ok: true; prompt: string }
  | { ok: false; usage: string };

type DelegatedPromptBuilder = (rawArgs: string) => DelegatedPromptOutcome;

function noArgs(prompt: string): DelegatedPromptBuilder {
  return () => ({ ok: true, prompt });
}

function optionalArgs(builder: (args: string) => string): DelegatedPromptBuilder {
  return (rawArgs) => ({ ok: true, prompt: builder(rawArgs.trim()) });
}

function requireArgs(usage: string, builder: (args: string) => string): DelegatedPromptBuilder {
  return (rawArgs) => {
    const args = rawArgs.trim();
    if (!args) return { ok: false, usage };
    return { ok: true, prompt: builder(args) };
  };
}

const DELEGATED_PROMPTS: Record<string, DelegatedPromptBuilder> = {
  today: noArgs("What are my calendar events for today? List them in order."),
  tomorrow: noArgs("What are my calendar events for tomorrow? List them in order."),
  event: optionalArgs((args) => args
    ? `Create a new calendar event: ${args}`
    : "Create a new calendar event. Please ask me for the event title, date, time, and any other details needed.",
  ),
  inbox: noArgs("Check my email inbox and list the most recent unread messages with sender, subject, and a brief preview."),
  email: requireArgs("Usage: <id>", (args) => `Read email with ID: ${args}. Show the full content.`),
  draft: optionalArgs((args) => args
    ? `Draft an email: ${args}`
    : "Help me draft an email. Please ask me for the recipient, subject, and what I want to say.",
  ),
  issues: noArgs("List my recent GitHub issues — both open issues I created and issues assigned to me."),
  issue: requireArgs("Usage: <repo>#<number>", (args) => `Show GitHub issue: ${args}. Include the title, status, description, and recent comments.`),
  "create-issue": (rawArgs) => {
    const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return { ok: false, usage: "Usage: <repo> <title>\nExample: myorg/myrepo Fix login bug" };
    }
    const [repo, ...titleParts] = parts;
    return { ok: true, prompt: `Create a GitHub issue in ${repo} with title: "${titleParts.join(" ")}"` };
  },
  weather: noArgs("What is the current weather? Use my location settings if available."),
  crypto: noArgs("What are the current prices for major cryptocurrencies? Include BTC, ETH, SOL, and any others you have data for."),
  stocks: noArgs("What are the current stock prices for major tech stocks? Include AAPL, GOOGL, MSFT, TSLA, NVDA, and any others you have data for."),
  news: noArgs("What are the latest tech and AI news headlines? Give me the top 5-10 stories."),
  recipes: requireArgs("Usage: <query>", (args) => `Search for recipes matching: ${args}`),
  drive: noArgs("List my Google Drive files — show the most recently modified ones first."),
};

export function getDelegatedPrompt(handler: string, rawArgs: string): DelegatedPromptOutcome | null {
  const builder = DELEGATED_PROMPTS[handler];
  if (!builder) return null;
  return builder(rawArgs);
}

export function isDelegatedCommand(handler: string): boolean {
  return handler in DELEGATED_PROMPTS;
}

export function listDelegatedCommands(): string[] {
  return Object.keys(DELEGATED_PROMPTS);
}
