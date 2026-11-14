// Canonical MCP-facing tool definitions.
// registry.ts composes these definitions with handlers and exposes projections
// for REST, stdio MCP, and API-agent tool calling.

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** If true, the tool requires a valid X-Chomp-Session-Id header */
  requiresSession?: boolean;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  // ── Session-bound tools ────────────────────────────────────────
  {
    name: "reply",
    description:
      "Send a message to the Chomp chat UI without expecting a response. Use for progress updates or interim results.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message to display in the chat",
        },
      },
      required: ["message"],
    },
    requiresSession: true,
  },
  {
    name: "ask_user",
    description:
      "Ask the user a question and wait for their response. Use this when you need clarification or approval from the user during a task.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
      },
      required: ["question"],
    },
    requiresSession: true,
  },

  // ── Conversation search ────────────────────────────────────────
  {
    name: "search_conversations",
    description:
      "Search past conversations by keyword or phrase. Returns matching conversations with a snippet of the relevant message. Use this to recall previous discussions, decisions, instructions, or context shared in earlier chats.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword or phrase to search for in past conversations",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 50)",
        },
      },
      required: ["query"],
    },
  },

  // ── Memory tools ───────────────────────────────────────────────
  {
    name: "save_memory",
    description:
      "Save a piece of information to persistent memory. Use this to remember user preferences, project context, facts, or instructions across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The content to remember",
        },
        category: {
          type: "string",
          enum: ["preferences", "project-context", "facts", "instructions", "lessons"],
          description:
            "Category for the memory. Use 'lessons' to record mistakes and how you resolved them so future agents can learn.",
        },
      },
      required: ["content", "category"],
    },
  },
  {
    name: "recall_memories",
    description:
      "Recall stored memories in full. The prompt's <stored-memories> block lists longer memories under [index] as one-line SUMMARIES — pass those ids here to read the complete text before acting on one. When a query is provided instead, uses semantic (embedding-based) search by default, surfacing related memories even when exact words differ; falls back to substring search if embeddings are unavailable. Each result includes its ID for use with update_memory or delete_memory.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Fetch specific memories by id, verbatim. Use this to expand entries shown as summaries under [index] in the prompt.",
        },
        query: {
          type: "string",
          description: "Text to search for in memories. Triggers semantic re-ranking when use_semantic is true (default).",
        },
        category: {
          type: "string",
          enum: ["preferences", "project-context", "facts", "instructions", "lessons"],
          description: "Filter by category",
        },
        limit: {
          type: "number",
          description: "Maximum number of memories to return (default 20)",
        },
        use_semantic: {
          type: "boolean",
          description: "Use semantic (embedding-based) search when a query is provided. Defaults to true. Set to false to force exact substring matching.",
        },
      },
    },
  },
  {
    name: "read_user_profile",
    description:
      "Read the user's full user.md profile on demand. Use only when deeper personal context is needed; normal prompts include only a lightweight hint to avoid wasting context.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_memory",
    description:
      "Update the content of an existing memory by ID. Use this to fix stale, outdated, or inaccurate memories instead of creating duplicates. Get the ID from recall_memories.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory ID to update (from recall_memories results)",
        },
        content: {
          type: "string",
          description: "The new content for this memory",
        },
      },
      required: ["id", "content"],
    },
  },
  {
    name: "delete_memory",
    description:
      "Delete a memory by ID. Use this to remove duplicates, outdated entries, or memories that are no longer relevant. Get the ID from recall_memories. The memory is retired, not erased: it disappears from prompts, listings and recall, but the row stays so a bad cleanup can be undone.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory ID to delete (from recall_memories results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "dream_digest",
    description:
      "For the dream skill: a compact digest of the last N days of Chomp chats. Recurring failures (same error 2+ times), user pushback and thumbs-down, then each conversation's user messages, failed commands/tools and replies. Read it next to the memory store to find what agents keep getting wrong.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days back to look (1-31, default 7)" },
      },
    },
  },

  // ── Google auth ────────────────────────────────────────────────
  {
    name: "get_google_token",
    description:
      "Get a fresh Google OAuth2 bearer token for making authenticated API calls to Gmail, Calendar, etc. Returns the token string or an error if Google is not connected.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // ── Spotify ────────────────────────────────────────────────────
  {
    name: "spotify_search",
    description:
      "Search Spotify for music and podcasts. Returns tracks, albums, artists, playlists, podcast shows, and/or episodes matching the query. Requires the user to have connected Spotify in Settings.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g. 'daft punk', 'lex fridman', 'lo-fi beats').",
        },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: ["track", "album", "artist", "playlist", "show", "episode"],
          },
          description:
            "Result types to include. Defaults to ['track','episode'] (music + podcasts). Use 'show' for podcast series, 'episode' for individual podcast episodes.",
        },
        limit: {
          type: "number",
          description: "Max results per type (1–20, default 5).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "spotify_list_playlists",
    description:
      "List the user's Spotify playlists (owned + followed). Returns each playlist's name, ID, owner, track count, URI, and link. Use the IDs with spotify_get_playlist / spotify_add_to_playlist / spotify_remove_from_playlist.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max playlists to return (1–50, default 20).",
        },
      },
    },
  },
  {
    name: "spotify_get_playlist",
    description:
      "Get the metadata + tracks of a single Spotify playlist by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        playlist_id: {
          type: "string",
          description: "Spotify playlist ID (from spotify_list_playlists).",
        },
        track_limit: {
          type: "number",
          description: "Max tracks to include (1–100, default 50).",
        },
      },
      required: ["playlist_id"],
    },
  },
  {
    name: "spotify_create_playlist",
    description:
      "Create a new Spotify playlist on the current user's account. Returns the new playlist's ID + URI + URL.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Playlist name (required).",
        },
        description: {
          type: "string",
          description: "Optional playlist description.",
        },
        public: {
          type: "boolean",
          description: "If true, the playlist is public. Defaults to false (private).",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "spotify_add_to_playlist",
    description:
      "Add tracks or podcast episodes to a Spotify playlist. Accepts spotify:track:... and spotify:episode:... URIs, bare 22-char track IDs, or open.spotify.com track/episode URLs. Chunks automatically beyond 100 items.",
    inputSchema: {
      type: "object",
      properties: {
        playlist_id: {
          type: "string",
          description: "Target playlist ID.",
        },
        track_uris: {
          type: "array",
          items: { type: "string" },
          description: "Track or episode URIs to add (from spotify_search results).",
        },
      },
      required: ["playlist_id", "track_uris"],
    },
  },
  {
    name: "spotify_remove_from_playlist",
    description:
      "Remove specific tracks or podcast episodes from a Spotify playlist. Same URI formats as spotify_add_to_playlist.",
    inputSchema: {
      type: "object",
      properties: {
        playlist_id: {
          type: "string",
          description: "Target playlist ID.",
        },
        track_uris: {
          type: "array",
          items: { type: "string" },
          description: "Track or episode URIs to remove.",
        },
      },
      required: ["playlist_id", "track_uris"],
    },
  },
  {
    name: "spotify_track_metrics",
    description:
      "Get ranking metrics for up to 20 Spotify tracks: popularity (0-100), release year, artist genres, and audio features (tempo, key, energy, valence, danceability, acousticness, instrumentalness). Audio features are restricted for newer Spotify apps; when blocked the tool says so per track and still returns popularity and genres. Use to tiebreak or filter music recommendation candidates.",
    inputSchema: {
      type: "object",
      properties: {
        track_ids: {
          type: "array",
          items: { type: "string" },
          description: "Track URIs (spotify:track:...), bare 22-char IDs, or open.spotify.com track URLs (from spotify_search results).",
        },
      },
      required: ["track_ids"],
    },
  },

  // ── Settings ───────────────────────────────────────────────────
  {
    name: "get_setting",
    description:
      "Read a Chomp setting by key. Allowed keys include background_model, embedding_model, drive_folder_id, github settings, guardrails, and user_profile_md. Prefer read_user_profile for user.md.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The setting key to read",
        },
      },
      required: ["key"],
    },
  },

  // ── Skills ─────────────────────────────────────────────────────
  {
    name: "get_skills",
    description:
      "List available Chomp skills, or get the full content of a specific skill. Skills contain instructions for tasks like Gmail, Calendar, weather, crypto, GitHub, etc.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Skill name to get full content for. Omit to list all available skills.",
        },
      },
    },
  },

  // ── Drive tools ────────────────────────────────────────────────
  {
    name: "list_drive_files",
    description:
      "List files and folders in the configured Google Drive folder. Returns name, ID, type, size, and modified date.",
    inputSchema: {
      type: "object",
      properties: {
        folder_id: {
          type: "string",
          description: "Subfolder ID to list (default: root configured folder)",
        },
        page_size: {
          type: "number",
          description: "Max items to return (default 50, max 100)",
        },
      },
    },
  },
  {
    name: "upload_drive_file",
    description:
      "Upload a file to Google Drive. Content must be base64-encoded. Supports any file type (images, text, PDFs, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Name for the file (e.g. 'photo.jpg', 'notes.txt')",
        },
        content: {
          type: "string",
          description: "File content, base64-encoded",
        },
        mime_type: {
          type: "string",
          description: "MIME type (e.g. 'image/png', 'text/plain', 'application/pdf')",
        },
        folder_id: {
          type: "string",
          description: "Target subfolder ID (default: root configured folder)",
        },
      },
      required: ["filename", "content", "mime_type"],
    },
  },
  {
    name: "get_drive_file",
    description:
      "Get metadata and content of a file from Google Drive. For text files under 32KB, returns content inline.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "Drive file ID (from list_drive_files)",
        },
      },
      required: ["file_id"],
    },
  },
  {
    name: "update_drive_file",
    description:
      "Replace the content of an existing Google Drive file. Content must be base64-encoded.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "Drive file ID to update",
        },
        content: {
          type: "string",
          description: "New file content, base64-encoded",
        },
        mime_type: {
          type: "string",
          description: "New MIME type (optional, keeps existing if omitted)",
        },
      },
      required: ["file_id", "content"],
    },
  },
  {
    name: "delete_drive_file",
    description:
      "Permanently delete a file or folder from Google Drive. Cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "Drive file or folder ID to delete",
        },
      },
      required: ["file_id"],
    },
  },
  {
    name: "create_drive_folder",
    description: "Create a new subfolder in Google Drive.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Folder name",
        },
        folder_id: {
          type: "string",
          description: "Parent subfolder ID (default: root configured folder)",
        },
      },
      required: ["name"],
    },
  },

  // ── Recipe tools (Chewable Foodie) ────────────────────────────
  {
    name: "search_recipes",
    description:
      "Search recipes in Chewable Foodie by name/description or by source URL. Returns matching recipes with name, author, cuisine, type, and ID.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for in recipe names and descriptions",
        },
        url: {
          type: "string",
          description: "Look up a recipe by its exact source URL",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 50)",
        },
      },
    },
  },
  {
    name: "import_recipe_from_url",
    description:
      "Import a recipe into Chewable Foodie by scraping a recipe URL. The service extracts name, ingredients, instructions, and image automatically.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL of the recipe page to import",
        },
        is_global: {
          type: "boolean",
          description: "Make recipe visible to all users (default true)",
        },
        source_tag: {
          type: "string",
          description: "Tag to identify the import source (default 'chomp')",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "import_recipe_from_text",
    description:
      "Import a recipe into Chewable Foodie from pasted text. Useful when you have recipe content but no URL, or the URL is behind a paywall.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "Full recipe text including name, ingredients, and instructions",
        },
        source_url: {
          type: "string",
          description: "Optional source URL to link back to the original",
        },
        is_global: {
          type: "boolean",
          description: "Make recipe visible to all users (default true)",
        },
        source_tag: {
          type: "string",
          description: "Tag to identify the import source (default 'chomp')",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "update_recipe_image",
    description:
      "Fetch an image from a URL and upload it as the cover photo for a recipe in Chewable Foodie. The image is downloaded, re-hosted on Supabase, and the recipe's imageUrl is updated. Use this after importing a recipe from text to attach a real photo.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: {
          type: "string",
          description: "UUID of the recipe to update (from import_recipe_from_url or import_recipe_from_text)",
        },
        image_url: {
          type: "string",
          description: "Public URL of an image to download and attach to the recipe",
        },
      },
      required: ["recipe_id", "image_url"],
    },
  },

  // ── Gmail tools ────────────────────────────────────────────────
  {
    name: "search_email",
    description:
      "Search Gmail using Gmail search syntax (e.g. 'is:unread', 'from:john', 'subject:meeting'). Returns subject, from, date, snippet, and message ID for each result.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query",
        },
        max_results: {
          type: "number",
          description: "Max results to return (default 10, max 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_email",
    description:
      "Read the full content of an email by its message ID (from search_email results).",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "Gmail message ID",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "draft_email",
    description:
      "Create a Gmail draft (does NOT send). The user can review and send from Gmail.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address",
        },
        subject: {
          type: "string",
          description: "Email subject",
        },
        body: {
          type: "string",
          description: "Email body (plain text)",
        },
        cc: {
          type: "string",
          description: "CC email address (optional)",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "mark_emails_read",
    description:
      "Mark Gmail messages as read. By default marks all unread messages. Optionally accepts a Gmail search query to target a specific subset (e.g. 'is:unread from:github.com').",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query to filter which messages to mark as read (default: 'is:unread')",
        },
      },
    },
  },
  {
    name: "mark_emails_unread",
    description:
      "Mark Gmail messages as unread. By default marks all inbox messages. Optionally accepts a Gmail search query to target a specific subset (e.g. 'from:boss@company.com').",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query to filter which messages to mark as unread (default: 'in:inbox')",
        },
      },
    },
  },

  // ── Calendar tools ─────────────────────────────────────────────
  {
    name: "list_events",
    description:
      "List Google Calendar events, plus busy times (work or private, no titles) synced from the user's iPhone calendars, which hold the work calendars. Defaults to all of today's events (midnight to midnight).",
    inputSchema: {
      type: "object",
      properties: {
        time_min: {
          type: "string",
          description: "Start time (ISO 8601). Default: now",
        },
        time_max: {
          type: "string",
          description: "End time (ISO 8601). Default: end of today",
        },
        max_results: {
          type: "number",
          description: "Max events to return (default 10, max 25)",
        },
      },
    },
  },
  {
    name: "create_event",
    description:
      "Create a Google Calendar event. Always confirm details with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Event title",
        },
        start_time: {
          type: "string",
          description: "Start time (ISO 8601, e.g. 2025-01-15T14:00:00)",
        },
        end_time: {
          type: "string",
          description: "End time (ISO 8601)",
        },
        description: {
          type: "string",
          description: "Event description (optional)",
        },
        location: {
          type: "string",
          description: "Event location (optional)",
        },
        timezone: {
          type: "string",
          description: "Timezone (e.g. America/New_York). Default: system TZ or UTC",
        },
      },
      required: ["summary", "start_time", "end_time"],
    },
  },

  // ── GitHub ──────────────────────────────────────────────────────

  {
    name: "create_github_issue",
    description:
      "Create a new GitHub issue. Used by Chomp to propose ideas (chomp:idea label).",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository slug (e.g. owner/repo)",
        },
        title: {
          type: "string",
          description: "Issue title",
        },
        body: {
          type: "string",
          description: "Issue body (markdown)",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels to apply (e.g. [\"chomp:idea\"])",
        },
      },
      required: ["repo", "title", "body"],
    },
  },

  // ── Proactive rules ────────────────────────────────────────────
  {
    name: "trigger_proactive_rule",
    description:
      "Manually trigger a proactive rule by name. Use when the user says 'run my morning brief', 'trigger the GitHub issue checker', etc. Lists available rules if no name is given.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name (or partial name) of the proactive rule to trigger. Omit to list all available rules.",
        },
      },
    },
  },
  {
    name: "create_proactive_rule",
    description:
      "Create a persistent recurring proactive rule in Chomp. Use this when the user wants to schedule something to happen automatically on a recurring basis — e.g. 'every day at 9am fetch my stocks', 'every morning send me a brief'. Unlike schedule_one_off (fires once then deletes), this rule persists across server restarts until explicitly deleted. For daily scheduling at a specific hour, set active_hours_start/end to that hour and cooldown_minutes to 1380 (23h). Hours are evaluated in the user's local timezone (the user_timezone setting, else the server's own zone; pass active_hours_timezone to override per-rule). The engine checks every 5 minutes, so rules fire within ~5 min of their window opening.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Human-readable name for the rule (e.g. 'Norwegian Market Tickers at 09:00')",
        },
        agent_prompt: {
          type: "string",
          description: "Prompt for the main Claude agent to execute when the rule fires. For script gates, this is used only after the gate matches and can include {{gateResult}}.",
        },
        gate: {
          type: "object",
          description:
            "Optional deterministic script gate. When provided, Chomp runs the built-in gate first and delegates to the agent only if it matches. Shapes: (1) {script:'market_quote_threshold', input:{ticker:'ACME', buyBelow:55}} for price/volume thresholds (input.groups supports grouped AND conditions like price 58-60 AND volume >= 5M); (2) {script:'company_news_scan', input:{ticker:'ACME', keywords:['NRC','offering','contract'], filterOut:['price target','rating'], lookbackMinutes:45, dailyCap:5}} which polls SEC EDGAR 8-K filings (primary) + Finnhub company-news (secondary), de-dupes against the news_seen table, and only wakes the agent on a genuinely new material item (8-Ks bypass keyword matching); (3) {script:'gmail_new_mail', input:{query:'from:alerts.pricewatch.example newer_than:2d', key:'pricewatch'}} which runs a Gmail search and wakes the agent only for messages it has not seen before under that key (the agent gets id, subject, from, date and snippet); (4) {script:'command', input:{command:['/usr/bin/python3','/abs/path/script.py','scan'], timeoutSeconds?:300}} which runs that argv (no shell) and wakes the agent only when its stdout JSON has matched:true (summary is shown in the run history, the whole JSON is the gate result). Use these instead of making the agent poll and decide from prose.",
          properties: {
            script: { type: "string", enum: ["market_quote_threshold", "company_news_scan", "gmail_new_mail", "command"] },
            input: { type: "object" },
          },
        },
        active_hours_start: {
          type: "number",
          description: "Hour (0–23) when the rule becomes eligible to fire. For '09:00 daily', set to 9.",
        },
        active_hours_end: {
          type: "number",
          description: "Hour (0–23) when the rule's window closes. For '09:00 daily', set to 9 (fires sometime in the 9am hour).",
        },
        active_hours_timezone: {
          type: "string",
          description: "IANA timezone for evaluating active_hours_start/end (e.g. 'Europe/Oslo', 'America/New_York'). Optional — defaults to the user_timezone setting (Europe/Oslo if unset).",
        },
        cooldown_minutes: {
          type: "number",
          description: "Minimum minutes between firings. For once-daily rules set to 1380 (23h). Default: 1380. For jittered rules this remains a safety cooldown.",
        },
        jitter_min_minutes: {
          type: "number",
          description: "Optional lower bound for randomized recurring wakeups. Set with jitter_max_minutes to schedule the next run randomly after each firing.",
        },
        jitter_max_minutes: {
          type: "number",
          description: "Optional upper bound for randomized recurring wakeups. Must be greater than or equal to jitter_min_minutes.",
        },
        guard: {
          type: "object",
          description:
            "Optional data-driven guard that must pass before the rule fires. Shape: {mode:'all'|'any', rules:[...]}. Supported rules: {type:'market_session', market:'XNAS'|'XNYS'|'XOSL', phase:'regular'|'after_close'|'trading_day'}, {type:'weekday', timezone:'Europe/Oslo', days:['Mon','Tue']}, {type:'date_range', startsAt:'2026-05-24T00:00:00Z', endsAt:'2026-06-01T00:00:00Z'}. Omit for default every-day behavior.",
          properties: {
            mode: { type: "string", enum: ["all", "any"] },
            rules: { type: "array", items: { type: "object" } },
          },
        },
        model: { type: "string", description: "Model of the provider (default: sonnet on claude)." },
        provider: { type: "string", enum: ["claude", "codex"], description: "Provider to run on (default: claude)." },
        soul: { type: "string", description: "Name of the agent (soul) that answers (default: the default agent)." },
        effort: { type: "string", description: "Reasoning effort (default: the model's)." },
        notification_channels: {
          type: "array",
          items: {
            type: "string",
            enum: ["telegram", "discord"],
          },
          description: "Channels to notify when the rule fires. Defaults to ['telegram']; use ['discord'] for Discord-only output, or [] to keep the result in its Chomp conversation only.",
        },
      },
      required: ["name", "agent_prompt"],
    },
  },
  {
    name: "delete_proactive_rule",
    description:
      "Delete a persistent proactive rule by name. Use when the user wants to remove or cancel a recurring scheduled task they previously set up.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name (or partial name) of the rule to delete.",
        },
      },
      required: ["name"],
    },
  },

  // ── Scheduling ─────────────────────────────────────────────────
  {
    name: "schedule_one_off",
    description:
      "Schedule a one-off task at a specific time. Creates a proactive rule that fires once at the given time, executes the action, and auto-deletes. Use when the user says things like 'at 20:00 do X', 'remind me at 3pm to Y', or 'tonight at 8 run Z'.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short descriptive name for the task (e.g. 'News report at 20:00')",
        },
        run_at: {
          type: "string",
          description: "ISO 8601 datetime for when to fire (e.g. '2026-03-21T19:00:00Z'). Must be in the future.",
        },
        action_type: {
          type: "string",
          enum: ["notify", "run_agent"],
          description: "Action type: 'notify' for a notification, 'run_agent' to dispatch an agent",
        },
        notify_title: {
          type: "string",
          description: "Notification title (only for action_type=notify)",
        },
        notify_body: {
          type: "string",
          description: "Notification body (only for action_type=notify)",
        },
        agent_prompt: {
          type: "string",
          description: "Prompt for the agent to execute (only for action_type=run_agent)",
        },
        agent_model: { type: "string", description: "Model of the provider (default: sonnet on claude)." },
        provider: { type: "string", enum: ["claude", "codex"], description: "Provider to run on (default: claude)." },
        soul: { type: "string", description: "Name of the agent (soul) that answers (default: the default agent)." },
        effort: { type: "string", description: "Reasoning effort (default: the model's)." },
      },
      required: ["name", "run_at", "action_type"],
    },
  },

  // ── Artifacts ───────────────────────────────────────────────────
  {
    name: "save_artifact",
    description:
      "Save an HTML page as an artifact and get back the canvas block that shows it inline in web chat (with expand and open-in-new-tab). Use it for bespoke pages, tools, mini-apps or visualisations that canvas blocks cannot express. Paste the returned block into your reply. To edit an existing artifact, pass its id and the FULL new html. Inside the page, `chomp.send(text)` sends text to you as the user's next message.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title shown on the card" },
        html: {
          type: "string",
          description:
            "Complete self-contained HTML page (inline CSS and JS). Mobile-first. External CDN scripts are fine. No access to Chomp's API or login.",
        },
        id: { type: "string", description: "Existing artifact id to replace (omit to create a new one)" },
      },
      required: ["title", "html"],
    },
  },

  // ── Other chats ─────────────────────────────────────────────────
  {
    name: "message_chat",
    description:
      "Send a message to the agent in another Chomp chat. It runs there as a new turn, shown in that chat under this chat's name, on that chat's own provider and model, so it works for idle, closed and Codex chats too. It does not wait for the answer: the other agent replies in its chat and can message you back the same way. Use it when the user asks you to tell, ask or hand something to another chat, or mentions one as @session:<id>. Read the chat first with get_conversation_messages if you need its context. Each chat takes at most 5 agent messages per 10 minutes, so do not ping-pong: answer only when an answer is needed.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "The other chat's conversation id, or its first 8 characters" },
        message: { type: "string", description: "What to tell its agent. Self-contained: it has not seen this chat" },
      },
      required: ["conversationId", "message"],
    },
    requiresSession: true,
  },

  // ── Preview ─────────────────────────────────────────────────────
  {
    name: "preview_start",
    description:
      "Start a dev server and show it in the chat's preview pane: one real browser page on this machine that the user watches live and can use, and that you drive with the other preview_* tools. Give `name`, a configuration in the project's .claude/launch.json (Claude Code's format: name, runtimeExecutable, runtimeArgs, port, optional url, cwd, env, autoPort); Chomp runs it, waits for its port and keeps its output for preview_logs. Or give `url` (such as http://localhost:3000/) for a server already running. With neither, the only configuration starts. A running server is reused. Use it whenever you build or change a web UI, then check your work in the page before you say it is done. Not for static pages (save_artifact) or anything public (site-publisher).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A configuration name from .claude/launch.json" },
        url: { type: "string", description: "Page to open. With name, overrides the configuration's page" },
      },
    },
    requiresSession: true,
  },
  {
    name: "preview_stop",
    description: "Stop a dev server that preview_start started.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The configuration name" } },
      required: ["name"],
    },
    requiresSession: true,
  },
  {
    name: "preview_list",
    description: "The project's launch configurations, the dev servers running for it, and the page the preview shows.",
    inputSchema: { type: "object", properties: {} },
    requiresSession: true,
  },
  {
    name: "preview_logs",
    description:
      "Read what the preview produced. source `server` (default): a dev server's output. `console`: the page's console messages and uncaught errors. `network`: the page's requests with status; pass request_id to read one response body.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["server", "console", "network"] },
        name: { type: "string", description: "For source server: which server. Optional when only one has run" },
        level: { type: "string", enum: ["error"], description: "Only errors: stderr and error lines, console errors, failed or 4xx/5xx requests" },
        search: { type: "string", description: "Only lines containing this text, any case" },
        lines: { type: "number", description: "How many of the newest to return. Default 50" },
        request_id: { type: "number", description: "For source network: the #id of a request whose response body to return" },
      },
    },
    requiresSession: true,
  },
  {
    name: "preview_snapshot",
    description:
      "Read the preview page as an accessibility tree. Each element you can use has a ref, such as [ref=e12], for preview_act. Refs belong to the latest snapshot only, so take a new one after the page changes. Prefer this over a screenshot for reading text and finding elements.",
    inputSchema: { type: "object", properties: {} },
    requiresSession: true,
  },
  {
    name: "preview_screenshot",
    description:
      "See the preview page as the user sees it: the visible part, at its CSS size, so a point in the picture is an x and y for preview_act. Use it to check layout, colour and anything visual.",
    inputSchema: { type: "object", properties: {} },
    requiresSession: true,
  },
  {
    name: "preview_act",
    description:
      "Use the preview page; the user sees each action happen. Target an element with `ref` from preview_snapshot, or a point with x and y in CSS pixels from preview_screenshot. Actions: click, double_click, right_click, hover; fill (replace a field's value: ref and text); type (click the target if given, then type text as keystrokes); press (key, such as Enter, Escape, ArrowDown or ControlOrMeta+a, on the focused element or ref); scroll (dy and dx in pixels at the target, or with only a ref, scroll it into view); select (values of a <select>); drag (ref to to_ref); wait (for text to appear, or ms). submit presses Enter afterwards. Returns the page's title and address afterwards, and any new console errors; take a new preview_snapshot to see what changed.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "double_click", "right_click", "hover", "fill", "type", "press", "scroll", "select", "drag", "wait"] },
        ref: { type: "string", description: "Element ref from preview_snapshot, such as e12" },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string", description: "For fill, type, and wait" },
        key: { type: "string", description: "For press" },
        values: { type: "array", items: { type: "string" }, description: "For select" },
        dx: { type: "number", description: "For scroll" },
        dy: { type: "number", description: "For scroll. Positive scrolls down" },
        to_ref: { type: "string", description: "For drag: where to drop" },
        ms: { type: "number", description: "For wait: how long, or how long to wait for text at most" },
        submit: { type: "boolean", description: "Press Enter after the action" },
      },
      required: ["action"],
    },
    requiresSession: true,
  },
  {
    name: "preview_navigate",
    description: "Open a page in the preview, or go back, forward or reload.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "A URL, or back, forward or reload" } },
      required: ["url"],
    },
    requiresSession: true,
  },
  {
    name: "preview_eval",
    description:
      "Run JavaScript in the preview page, as in the DevTools console: top-level await works, and the last expression is the result, as JSON. It can change the page, so prefer preview_act for what a user would do.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
    requiresSession: true,
  },
  {
    name: "preview_resize",
    description:
      "Change the preview's size and colours. preset desktop fills the user's pane; tablet is 768x1024; mobile is 375x812 with a phone user agent and touch. Or give width and height. color_scheme sets prefers-color-scheme; system follows the user's own. The user sees the change, so set desktop back when you are done testing.",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["desktop", "tablet", "mobile"] },
        width: { type: "number" },
        height: { type: "number" },
        color_scheme: { type: "string", enum: ["system", "light", "dark"] },
      },
    },
    requiresSession: true,
  },
  {
    name: "preview_window",
    description:
      "Change the user's preview pane in web chat, as its own buttons do. open or close the pane; docked beside the chat, floating over it, or full screen; pop_out into its own window that stays on top of other apps (picture in picture); browser_tab opens the page in a new browser tab. pop_out and browser_tab need the user's tap, as browsers allow nothing else: the pane shows a button for it. For a phone or tablet size, use preview_resize. One view per call.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["open", "close", "docked", "floating", "full", "pop_out", "browser_tab"] },
      },
      required: ["view"],
    },
    requiresSession: true,
  },

  // ── Sketches ────────────────────────────────────────────────────
  {
    name: "create_sketch",
    description:
      "Start a shared drawing sheet in web chat, which the user and you take turns on. Use it when they want to draw together, or give you an image and say draw this. Returns the canvas block: paste it into your reply. The sheet is 1000x750. The user draws, then hands over, and their message names the sketch id. Your turn: read_sketch, look at the images, draw_on_sketch with rehearse true, look and fix, draw_on_sketch for real, then ask whether this is what they want. Their finish buttons do pencil and 3D in the browser. Given a photo to draw, trace the subject with one closed thin stroke, because pencil then draws only inside closed outlines and leaves the background out. An AI request comes to you as a message: send the read_sketch sheet image through the nano-banana skill and show the result, and pass it as reference on draw_on_sketch if they want to keep drawing over it.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title shown on the sheet" },
        reference: { type: "string", description: "Optional /api/uploads/<file> image to lay faintly under the sheet" },
        note: { type: "string", description: "Optional short note shown under the sheet" },
      },
      required: ["title"],
    },
  },
  {
    name: "read_sketch",
    description:
      "See a shared drawing sheet. Returns the marks so far, oldest first, and two PNG paths: the sheet, and a grid view with coordinates and each mark's index. Open both with your file reader. Never draw on a sheet you have not looked at.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Sketch id" } },
      required: ["id"],
    },
  },
  {
    name: "draw_on_sketch",
    description:
      "Add your marks to a shared drawing sheet; the user watches them drawn one at a time, in order, so order them as you would draw them. With rehearse true nothing changes and you get PNG paths of how it would look: rehearse first, look, fix by coordinate. Without it the marks go on the sheet, your turn ends, and you get a canvas block to paste into your reply.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Sketch id" },
        strokes: {
          type: "array",
          description: "Marks in drawing order, in sheet coordinates (1000x750). Empty is fine when only setting a reference.",
          items: {
            type: "object",
            properties: {
              d: { type: "string", description: "SVG path data, starting with M, e.g. M10 10 C 40 0, 60 0, 90 10" },
              color: { type: "string", description: "Stroke colour as hex. Defaults to your ink colour." },
              width: { type: "number", description: "Stroke width, 0.5 to 40. Defaults to 3." },
              fill: { type: "string", description: "Fill colour as hex, for closed shapes. Fill is drawn under the stroke." },
            },
            required: ["d"],
          },
        },
        note: { type: "string", description: "Short question or remark shown under the sheet, such as: is this the dog you meant?" },
        reference: { type: "string", description: "Replace the image under the sheet with this /api/uploads/<file>, e.g. an AI result to draw over" },
        rehearse: { type: "boolean", description: "Render a preview only. Nothing is saved and the user sees nothing." },
      },
      required: ["id", "strokes"],
    },
  },

  // ── Site preview tools ──────────────────────────────────────────
  {
    name: "create_site",
    description:
      "Create a new static site preview. Returns the site ID and slug. The site starts as a draft — call publish_site to deploy it.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Site title",
        },
        html_content: {
          type: "string",
          description: "Full HTML content for the site (complete <!DOCTYPE html> page)",
        },
        slug: {
          type: "string",
          description: "URL slug (auto-generated from title if omitted)",
        },
        description: {
          type: "string",
          description: "Short description of the site (optional)",
        },
        password: {
          type: "string",
          description: "Password gate (optional, leave empty for none). It only hides the page from casual visitors: the content ships inside the page, so never use it for anything secret",
        },
      },
      required: ["title", "html_content"],
    },
  },
  {
    name: "list_sites",
    description:
      "List all static site previews with their source mode, status, slug, git status, and URL.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max results to return (default 20, max 50)",
        },
      },
    },
  },
  {
    name: "get_site",
    description:
      "Get full details of a site preview including source mode, git state, and a cached HTML snippet.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: {
          type: "string",
          description: "UUID of the site",
        },
      },
      required: ["site_id"],
    },
  },
  {
    name: "update_site",
    description:
      "Update a site's title, content, description, password, or slug. DB-source sites save content in the DB; git-source sites commit content to git, deploy it, and refresh the DB cache.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: {
          type: "string",
          description: "UUID of the site to update",
        },
        title: { type: "string", description: "New title (optional)" },
        html_content: { type: "string", description: "New HTML content (optional)" },
        description: { type: "string", description: "New description (optional)" },
        password: { type: "string", description: "New password gate (empty string to remove, optional). Not real protection: the content ships inside the page" },
        slug: { type: "string", description: "New slug (optional)" },
        skip_git: {
          type: "boolean",
          description: "Skip automatic git commit/push for git-source sites (default false)",
        },
      },
      required: ["site_id"],
    },
  },
  {
    name: "track_site_in_git",
    description:
      "Convert a preview site to git-source mode: git init, GitHub repo creation, initial commit/push, metadata sync, and optional collaborator invite.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: {
          type: "string",
          description: "UUID of the site to track",
        },
        private: {
          type: "boolean",
          description: "Private repo (default true)",
        },
        repo_name: {
          type: "string",
          description: "GitHub repo name (default = slug)",
        },
        invite_collaborator: {
          type: "string",
          description: "GitHub username to invite as admin. Omit or use null to skip.",
        },
      },
      required: ["site_id"],
    },
  },
  {
    name: "untrack_site_from_git",
    description:
      "Remove git tracking from a preview site (deletes local .git/). Optionally also deletes the GitHub repo.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: {
          type: "string",
          description: "UUID of the site",
        },
        delete_remote: {
          type: "boolean",
          description: "Also delete the GitHub repo (default false)",
        },
      },
      required: ["site_id"],
    },
  },
  {
    name: "delete_site",
    description:
      "Permanently delete a site preview and remove its files from disk. Cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: {
          type: "string",
          description: "UUID of the site to delete",
        },
      },
      required: ["site_id"],
    },
  },
  {
    name: "publish_site",
    description:
      "Publish a site preview to production. Writes the HTML to disk and returns the live URL plus a QR code link.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: {
          type: "string",
          description: "UUID of the site to publish",
        },
      },
      required: ["site_id"],
    },
  },
  {
    name: "unpublish_site",
    description:
      "Take a published site offline and set it back to draft. A git-source site keeps its repo and files and comes back as it was on publish_site; a DB-source site's files are removed and rewritten from the DB.",
    inputSchema: {
      type: "object",
      properties: {
        site_id: {
          type: "string",
          description: "UUID of the site to unpublish",
        },
      },
      required: ["site_id"],
    },
  },

  // ── Dashboards ────────────────────────────────────────────────
  {
    name: "list_dashboards",
    description:
      "List all Chomp dashboards with widget counts and auto-refresh status. Use to discover what dashboards exist before creating or modifying.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_dashboard",
    description:
      "Fetch one dashboard with its widgets. Pass either slug or id. Returns the dashboard metadata, each widget's title/id/blocks/refresher state, and the live URL.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Dashboard slug (e.g. 'markets')" },
        id: { type: "string", description: "Dashboard UUID" },
      },
    },
  },
  {
    name: "create_dashboard",
    description:
      "Create a new dashboard. Returns the created dashboard with its slug. Auto-refresh defaults to off — flip it on later only if widgets need to refresh.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name (slug is derived from this)" },
        description: { type: "string", description: "Optional one-line description" },
        autoRefreshEnabled: { type: "boolean", description: "Master killswitch for auto-refresh on this board (default false)" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_dashboard",
    description:
      "Update a dashboard's name, description, or master auto-refresh switch. Only provided fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Dashboard UUID" },
        name: { type: "string" },
        description: { type: "string" },
        autoRefreshEnabled: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_dashboard",
    description:
      "Delete a dashboard and all its widgets (cascade). Irreversible.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Dashboard UUID" } },
      required: ["id"],
    },
  },
  {
    name: "create_widget",
    description:
      "Create a new widget on a dashboard. Pass dashboardSlug or dashboardId, a title, and a blocks array of canvas-block objects (NOT fenced text — raw block objects). gridW is 1, 2, or 3 (3 = full row, default 1). The widget is frozen by default; call set_widget_refresher to make it refreshable.",
    inputSchema: {
      type: "object",
      properties: {
        dashboardSlug: { type: "string", description: "Slug of the parent dashboard" },
        dashboardId: { type: "string", description: "UUID of the parent dashboard (alternative to slug)" },
        title: { type: "string", description: "Widget title shown above the canvas blocks" },
        blocks: {
          type: "array",
          description: "Array of canvas-block objects, e.g. [{type: 'metric-grid', items: [...]}]",
          items: { type: "object", additionalProperties: true },
        },
        gridW: { type: "number", description: "Column span 1–3 (default 1)" },
        gridH: { type: "number", description: "Row span (default 1)" },
      },
      required: ["title", "blocks"],
    },
  },
  {
    name: "update_widget",
    description:
      "Update a widget's title, blocks, or grid placement. Only provided fields are changed. Use to fix or replace block content in place.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Widget UUID" },
        title: { type: "string" },
        blocks: {
          type: "array",
          description: "Replacement canvas-block objects (full array — not a partial update)",
          items: { type: "object", additionalProperties: true },
        },
        gridX: { type: "number" },
        gridY: { type: "number" },
        gridW: { type: "number" },
        gridH: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_widget",
    description: "Delete a single widget. Irreversible.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Widget UUID" } },
      required: ["id"],
    },
  },
  {
    name: "set_widget_refresher",
    description:
      "Configure how a widget refreshes itself. kind=null leaves it frozen. kind='template' (preferred): server-side fetch + transform, sub-200ms, zero LLM cost; payload {url, headers?, method?, body?, transform: <canvas-block template with {{$.path}} placeholders>} for one URL, or {requests:{key:{url, headers?, method?, body?}}, transform} to fetch multiple URLs in parallel and read them as $.key. kind='agent': claude -p fallback for judgment-heavy widgets; payload {prompt, context?: {url, headers?}, soulId?, provider?, model?, effort?}. Optionally set refreshIntervalMinutes for auto-refresh (only fires when the dashboard's autoRefreshEnabled is also true). Note: 'skill' and 'prompt' kinds were retired in Phase 7 — use 'template' or 'agent'.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Widget UUID" },
        kind: {
          type: ["string", "null"],
          enum: ["template", "agent", null],
          description: "Refresher mechanism",
        },
        payload: {
          type: ["object", "null"],
          description: "Refresher payload — shape depends on kind",
          additionalProperties: true,
        },
        schema: {
          type: "array",
          description: "Optional schema descriptors [{type, requiredKeys[]}, ...] used to validate refreshed blocks",
          items: { type: "object", additionalProperties: true },
        },
        refreshIntervalMinutes: {
          type: ["number", "null"],
          description: "Minutes between auto-refreshes. Null disables. Frozen kind forces null.",
        },
      },
      required: ["id"],
    },
  },

  // ── Generic HTTP fetch (dashboard refresher primitive) ─────────
  {
    name: "http_fetch_url",
    description:
      "Generic HTTPS fetch for dashboard widget refreshers. GET (default), POST, or PUT to a public HTTPS URL and return the raw response body. Use this as a skill-kind refresher's toolName so widgets stay config-driven — the URL/headers ARE the recipe, no per-widget code. Secrets in URL/headers/body resolve via {{secrets.KEY_NAME}} (e.g. https://api.x.com/v1?token={{secrets.MY_KEY}}). Localhost, private IPs, and .local TLDs are blocked. If the response is already canvas-shaped JSON ({\"blocks\": [...]}), the refresh executor skips the format LLM step for sub-second refreshes.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public HTTPS URL. Supports {{secrets.KEY_NAME}} substitution.",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT"],
          description: "HTTP method (default GET).",
        },
        headers: {
          type: "object",
          description: "Request headers. Values support {{secrets.KEY_NAME}} substitution.",
          additionalProperties: { type: "string" },
        },
        body: {
          type: "string",
          description: "Request body for POST/PUT. Supports {{secrets.KEY_NAME}} substitution.",
        },
      },
      required: ["url"],
    },
  },

  // ── Discord side-channel post ──────────────────────────────────
  {
    name: "discord_post",
    description:
      "Post a message to the linked Discord channel on demand. Use when the user explicitly asks to share, post, send, forward, or relay content to Discord (e.g. 'post this to discord', 'share that on discord'). Do not use for routine chat output — use 'reply' for the active conversation. Supports Discord markdown (bold **, italics *, headers, lists, fenced code blocks). Canvas blocks are stripped before sending since Discord cannot render them. Messages longer than Discord's 2000-char limit are chunked automatically. Returns the first chunk's message ID on success. Fails if the Discord bot is not running or no channel is linked.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Message content to post. Discord markdown supported; canvas JSON blocks are stripped.",
        },
      },
      required: ["message"],
    },
  },

  // ── Webhook context ────────────────────────────────────────────
  {
    name: "get_webhook_payload",
    description:
      "Retrieve the payload of the most recently received webhook. Use this when you are running as an agent triggered by a webhook.received event to inspect the incoming data. Returns the full payload body as a JSON string, along with the webhook name and received timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        webhook_id: {
          type: "string",
          description: "Optional: the specific webhook ID to fetch. Omit to get the most recently received payload across all webhooks.",
        },
      },
    },
  },

  // ── Settings (CRUD beyond get_setting) ─────────────────────────
  {
    name: "list_settings",
    description: "List all writable Chomp settings as a JSON map. Restricted to the safe-keys allow-list (background_model, embedding_model, guardrails, etc.).",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Proactive rules (manage existing rules) ────────────────────
  {
    name: "list_proactive_rules",
    description: "List every persistent proactive rule with parsed condition/action/activeHours. Use to discover what is currently scheduled before editing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_proactive_rule",
    description: "Get one proactive rule by id or by (partial) name. Returns the full parsed rule including action config and last-run state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Exact rule id (preferred when known)." },
        name: { type: "string", description: "Name or partial name. Falls back to substring match." },
      },
    },
  },
  {
    name: "update_proactive_rule",
    description: "Patch an existing proactive rule by id or name. Pass only the fields you want to change (enabled, cooldownMinutes, condition, actionConfig, activeHours, notificationChannels, priority, runAt). Validates against the same schema as create.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name_lookup: { type: "string", description: "Use this instead of name when you want to look up by name but ALSO rename the rule via the name field." },
        name: { type: "string", description: "New name for the rule (when renaming). For lookup-by-name without renaming, prefer providing id or name_lookup." },
        triggerType: { type: "string", enum: ["periodic", "event", "webhook"] },
        condition: { type: "object" },
        actionType: { type: "string", enum: ["notify", "compose_message", "run_agent", "script_gate"] },
        actionConfig: { type: "object", description: "For run_agent: {prompt, soulId?, provider? (claude or codex), model?, effort?, access? (set 'supervised' to ask the user's phone before acting)}. For script_gate the same fields go under onTrue." },
        enabled: { type: "boolean" },
        cooldownMinutes: { type: "number" },
        activeHours: { type: "object" },
        priority: { type: "number" },
        notificationChannels: { type: "array", items: { type: "string", enum: ["telegram", "discord"] } },
        runAt: { type: "string", description: "ISO 8601 datetime, or null to clear." },
      },
    },
  },
  {
    name: "list_proactive_rule_runs",
    description: "Get recent proactive rule run history (most recent first), including fired, guarded/skipped, rate-limited, script-gate false, and error outcomes. Use the reason/output fields to debug why a rule did or did not dispatch.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        limit: { type: "number", description: "Max runs to return (default 20, max 100)." },
      },
    },
  },
  {
    name: "dry_run_proactive_rule",
    description: "Preview what a proactive rule would do without actually firing it. Returns the action plan so you can verify before triggering.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
    },
  },

  // ── Cron schedules (the /api/schedules table — distinct from proactive rules)

  // ── Conversations management ───────────────────────────────────
  {
    name: "list_conversations",
    description: "List recent conversations (pinned first, then by updated_at). Returns id, title, tags, pinned state, and timestamps. Use to find a conversation id for get_conversation_messages / delete_conversation.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results to return (default 20, max 100)." },
      },
    },
  },
  {
    name: "get_conversation_messages",
    description: "Get all messages of a single conversation by id, ordered by createdAt ascending.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
      },
      required: ["conversation_id"],
    },
  },

  // ── Event triggers ─────────────────────────────────────────────
  {
    name: "list_triggers",
    description: "List every event trigger (parsed condition + action). Triggers fire on internal events (chat.message, webhook.received, schedule.tick, etc.) when their condition matches.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_trigger",
    description: "Get a single event trigger by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "create_trigger",
    description: "Create an event trigger. condition is an array of clauses evaluated against the event payload; action describes what to do when conditions match.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        event_type: { type: "string", description: "Event name to listen for (e.g. 'chat.message', 'webhook.received', 'schedule.tick')." },
        condition: { type: "array", description: "Array of condition clauses (defaults to [])." },
        action: { type: "object", description: "What to do: {type:'notify', title, body}, {type:'run-schedule', scheduleId} or {type:'delegate', prompt, deliver? (send the answer to the user's notification channels), soulId?, provider? (claude or codex), model?, effort?, access? (set 'supervised' to ask the user's phone before acting)}. Defaults to {}." },
        enabled: { type: "boolean", description: "Default true." },
        cooldown_seconds: { type: "number", description: "Min seconds between firings (default 0)." },
        once: { type: "boolean", description: "Delete the trigger after it fires once (default false)." },
      },
      required: ["name", "event_type"],
    },
  },
  {
    name: "update_trigger",
    description: "Patch an event trigger by id. Pass only the fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        event_type: { type: "string" },
        condition: { type: "array" },
        action: { type: "object" },
        enabled: { type: "boolean" },
        cooldown_seconds: { type: "number" },
        once: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_trigger",
    description: "Delete an event trigger by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },

  // ── Device bridge (phone/native client RPC) ────────────────────
  {
    name: "phone_list_devices",
    description:
      "List devices currently connected to the device bridge (e.g. a paired iPhone). Each entry includes the deviceId you can pass to phone_call_tool.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "phone_list_tools",
    description:
      "List tools advertised by a connected device. If device_id is omitted and only one device is connected, that one is used.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Optional deviceId to filter by (from phone_list_devices).",
        },
      },
    },
  },
  {
    name: "create_shortcut",
    description: "Build a signed Apple Shortcut and get a link the user taps on their iPhone to import it. Load the `apple-shortcuts` skill first for the action names and variables. Needs the user's Mac awake.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The Shortcut's name, which run_shortcut uses to find it. No slashes." },
        actions: {
          type: "array",
          description: "Steps in order.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", description: "A short name like 'gettext' for is.workflow.actions.gettext, or a full identifier." },
              id: { type: "string", description: "Lets later steps use this step's output as {{id}} in text, or {variable: id} for a whole parameter." },
              params: { type: "object", description: "The action's WFWorkflowActionParameters." },
            },
            required: ["action"],
          },
        },
        output: { type: "string", description: "Text the Shortcut returns to run_shortcut, e.g. '{{id}}'. Without it, run_shortcut gets the last action's output." },
      },
      required: ["name", "actions"],
    },
  },
  {
    name: "phone_call_tool",
    description:
      "Invoke a tool on a connected device (e.g. iPhone) and return its result. Use phone_list_tools first to see what's available. If device_id is omitted and only one device is connected, that one is used. Times out after timeout_ms (default 30s, max 5 min).",
    inputSchema: {
      type: "object",
      properties: {
        device_id: {
          type: "string",
          description: "Optional deviceId (from phone_list_devices).",
        },
        name: {
          type: "string",
          description: "Tool name as advertised by the device.",
        },
        args: {
          type: "object",
          description: "Arguments object, shaped by the tool's inputSchema.",
        },
        timeout_ms: {
          type: "number",
          description: "Per-call timeout in milliseconds (default 30000, max 300000).",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "publish_morning_report",
    description: "Publish the day's morning report: saves it for the /goodmorning page, speaks voiceScript, and sends the voice note to Telegram with a link to the page. Sections with nothing worth saying are left out, and the page drops them. Calling it again for a date replaces that report.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "The report's date, YYYY-MM-DD in the user's time zone." },
        place: { type: "string", description: "Where the user wakes up that day, e.g. 'Lisbon'. Becomes the dateline." },
        headline: { type: "string", description: "The one thing that matters today, in one short sentence. Set very large, so write it like a front page." },
        lead: { type: "string", description: "Two or three short paragraphs, separated by a blank line, connecting calendar, mail and travel. Plain text." },
        headsUp: { type: "array", items: { type: "string" }, description: "Short reminders: what to pack, what to bring, things for the kids." },
        weather: {
          type: "object",
          description: "Weather where the user will be.",
          properties: {
            summary: { type: "string" },
            high: { type: "number" },
            low: { type: "number" },
            sunrise: { type: "string", description: "HH:mm" },
            sunset: { type: "string", description: "HH:mm" },
          },
          required: ["summary"],
        },
        take: {
          type: "object",
          description: "One thing from AI or tech the user would care about, with an opinion.",
          properties: { title: { type: "string" }, body: { type: "string" }, url: { type: "string" } },
          required: ["title", "body", "url"],
        },
        news: {
          type: "array",
          description: "At most three items that matter.",
          items: {
            type: "object",
            properties: { title: { type: "string" }, why: { type: "string" }, source: { type: "string" }, url: { type: "string" } },
            required: ["title", "url"],
          },
        },
        inbox: {
          type: "array",
          description: "Only mail worth acting on.",
          items: {
            type: "object",
            properties: { from: { type: "string" }, subject: { type: "string" }, action: { type: "string" } },
            required: ["from", "subject"],
          },
        },
        travel: {
          type: "array",
          description: "Trips found in mail that the calendar lacks, added to the page's week: one entry per day, e.g. 'In Paris', or 'BA304 LHR to CDG' with its time.",
          items: {
            type: "object",
            properties: { date: { type: "string" }, title: { type: "string" }, time: { type: "string", description: "HH:mm" } },
            required: ["date", "title"],
          },
        },
        suggestions: { type: "array", items: { type: "string" }, description: "Up to three things the user might want done about today, as prompts in their voice, e.g. 'Nudge the landlord about the invoice'. They only fill a free-text box." },
        voiceScript: { type: "string", description: "60 to 90 seconds written for the ear, not a summary read aloud. No links, lists, or headings. Under 1500 characters." },
        send_voice: { type: "boolean", description: "Set false to save and speak without sending to Telegram, for a test." },
      },
      required: ["date", "place", "headline", "lead", "voiceScript"],
    },
  },
  {
    name: "publish_phone_cards",
    description: "Publish cards to the widget on the user's iPhone. The widget shows each card during its own time window and switches by itself, also with no network. Calling it again for a group replaces the whole group, so re-publish every card of a trip when one time changes. If a countdown still ahead moves, the phone gets a visible 'Time changed' notification. A widget cannot get the user's attention, so give each card that must be noticed its own alerts. All times are ISO 8601 with an offset, e.g. 2026-11-10T12:50:00+01:00.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Stable name for cards that belong together, e.g. 'trip-2026-11-10'." },
        board: { type: "string", description: "Which board the cards belong to, e.g. 'travel'. A widget can show one board or all of them. Default 'today'." },
        cards: {
          type: "array",
          description: "One card per stage, e.g. 'Flight today', 'Leave in 20 minutes', 'Leave now'. When cards overlap, the one that ends first shows first.",
          items: {
            type: "object",
            properties: {
              showFrom: { type: "string", description: "When the card appears." },
              showUntil: { type: "string", description: "When the card disappears. Must be after showFrom." },
              headline: { type: "string", description: "The one thing to know, at most 48 characters, e.g. 'Leave the office at 12:50'." },
              detail: { type: "string", description: "One line of supporting fact, at most 60 characters, e.g. 'Airport train 13:30 from the central station'." },
              countdownTo: { type: "string", description: "The moment the widget counts down to, usually the time to leave." },
              icon: { type: "string", description: "SF Symbol name shown before the headline, e.g. 'airplane', 'tram.fill', 'car.fill'." },
              tone: { type: "string", enum: ["normal", "urgent"], description: "'urgent' colours the card red. Keep it for the moment to act, e.g. 'Leave now'." },
              rows: {
                type: "array",
                description: "Up to 4 facts to look up at a glance, e.g. Gate B12, Seat 14A. Rows that do not fit are left out, so put the most important first.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "At most 14 characters." },
                    value: { type: "string", description: "At most 22 characters." },
                  },
                  required: ["label", "value"],
                },
              },
              link: { type: "string", description: "What opens when the card is tapped: a boarding pass, a booking or a map route. Without it, a tap opens Chomp." },
              alerts: {
                type: "array",
                description: "Notifications the phone schedules for itself, e.g. 15 minutes before leaving and at the moment to leave.",
                items: {
                  type: "object",
                  properties: { at: { type: "string" }, text: { type: "string" } },
                  required: ["at", "text"],
                },
              },
              source: { type: "string", description: "Where the facts came from, e.g. 'Train timetable' or 'Booking mail'. Shown on the card with checkedAt." },
              checkedAt: { type: "string", description: "When the facts were last checked." },
            },
            required: ["showFrom", "showUntil", "headline"],
          },
        },
      },
      required: ["group", "cards"],
    },
  },
  {
    name: "schedule_social_post",
    description: "Schedule a post the user publishes by hand on Instagram, TikTok or Pinterest. The Chomp app downloads the media ahead of time; at dueAt the user gets a phone alert and a Telegram message, and both nudge again after 2 hours if it is still unposted. Load the `social-publish` skill first. Pass id to change an existing post. All times are ISO 8601 with an offset.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "An existing post's id, to replace it. Platforms already posted stay posted." },
        title: { type: "string", description: "Short name for the user, e.g. 'Colour trios, ep. 2'. At most 80 characters." },
        dueAt: { type: "string", description: "When to publish." },
        platforms: {
          type: "array",
          description: "One entry per platform, each with its own caption and media, because crops differ.",
          items: {
            type: "object",
            properties: {
              platform: { type: "string", enum: ["instagram", "tiktok", "pinterest"] },
              caption: { type: "string" },
              media: {
                type: "array",
                description: "In posting order.",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string", description: "A direct https file URL, or an /api/uploads/<file> path." },
                    type: { type: "string", enum: ["image", "video"] },
                    altText: { type: "string" },
                  },
                  required: ["url", "type"],
                },
              },
            },
            required: ["platform", "caption", "media"],
          },
        },
      },
      required: ["title", "dueAt", "platforms"],
    },
  },
  {
    name: "list_social_posts",
    description: "List social posts that are still unposted or were due in the last 14 days, with what is posted on each platform.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remove_social_post",
    description: "Cancel a scheduled social post by id, including its phone alerts.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "remove_phone_cards",
    description: "Remove a whole group of cards from the iPhone widget, including its scheduled alerts.",
    inputSchema: {
      type: "object",
      properties: { group: { type: "string", description: "The group name from list_phone_cards." } },
      required: ["group"],
    },
  },
  {
    name: "get_location",
    description: "Where the user is: the newest position from the Chomp iPhone app or Home Assistant, with coordinates, accuracy and its age in minutes. `address` is a street name from the phone. `place` is the zone Home Assistant last reported and `placeAsOf` is when: it can be older than the position, so if it is much older, trust the position and address. `place` is empty when Home Assistant has the user outside every zone. The phone reports when it moves a meaningful distance, so an old position usually means they have not moved, unless they force-quit the app. Say how old it is when it matters. Set fresh to wake the phone with a silent push and ask for its position now. iOS can throttle that wake and a force-quit app does not wake, so a fresh request can fail; then you get the last known position and freshError.",
    inputSchema: {
      type: "object",
      properties: {
        fresh: { type: "boolean", description: "Wake the phone and get a new position. Use only when an old position would give the wrong answer." },
      },
    },
  },
  {
    name: "get_location_history",
    description: "Where the user has been, newest first: position reports with their named place. Kept for 90 days.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "How far back to look. Default 24." },
        limit: { type: "number", description: "Most rows to return. Default 100, maximum 500." },
      },
    },
  },
  {
    name: "list_places",
    description: "The named places Chomp can react to. These are the zones in Home Assistant. The phone watches them itself, so arriving and leaving costs almost no battery.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_place_trigger",
    description: "React when the user arrives at or leaves a named place: 'when I get to the store, show the list', 'when I leave home, tell me if the garage is open'. Fires once and deletes itself unless once is false. The place must already exist: see list_places. A run_agent answer goes to the user's notification channels.",
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string", description: "A name from list_places." },
        on: { type: "string", enum: ["arrive", "leave"] },
        action_type: { type: "string", enum: ["notify", "run_agent"], description: "'notify' for a fixed notification, 'run_agent' for an agent that works something out at that moment." },
        once: { type: "boolean", description: "Delete the trigger after it fires. Default true. When false, it waits 10 minutes between firings." },
        name: { type: "string", description: "Short name. Defaults to the place and direction." },
        notify_title: { type: "string", description: "Notification title (only for action_type=notify)." },
        notify_body: { type: "string", description: "Notification body (only for action_type=notify)." },
        agent_prompt: { type: "string", description: "Instructions for the agent (only for action_type=run_agent). It runs in a new conversation with no memory of this one, so say everything it needs." },
        agent_model: { type: "string", description: "Model of the provider (default: sonnet on claude)." },
        provider: { type: "string", enum: ["claude", "codex"], description: "Provider to run on (default: claude)." },
        effort: { type: "string", description: "Reasoning effort. Omit for the model default." },
        soul: { type: "string", description: "Name of the soul that answers. Omit for the default." },
      },
      required: ["place", "on", "action_type"],
    },
  },
  {
    name: "send_imessage",
    description: "Send an iMessage or SMS from the user's account, to someone they already have a chat with. This always asks the user first: they see a card with the exact text and recipient and must approve it, so do not also ask in your reply. The call waits for their answer, up to 30 minutes. If two people match, you get a list; ask which one, then call again with the chat id. Only send when the user asked you to.",
    requiresSession: true,
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "A contact's name, a phone number, or a chat id from a list this tool returned." },
        text: { type: "string", description: "The exact message. It is sent as written." },
      },
      required: ["chat", "text"],
    },
  },
  {
    name: "list_phone_cards",
    description: "List the cards on the iPhone widget that have not ended yet, including those that show later. Each card has its group and board.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "monitoring_status",
    description: "Say what is wrong with the user's services right now: the verdict, tracked services that are down or have gone quiet, open incidents and the open warnings (such as a database open to the LAN, or disk Docker can free). The Monitoring page in the web app shows the same. Use it first when the user asks if something is up or broken.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Only services whose key, name, host, project, container or unit contains this text (case-insensitive)." },
      },
    },
  },
  {
    name: "monitoring_target",
    description: "Show one monitored service: its facts, who can reach it, state, latest checks, and its open incident. Optionally includes the last 100 log lines (only for services on the machine Chomp runs on, host `mini`). Read-only: it cannot restart anything.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "A target key such as `mini:8080` or `container:redis`, or a name. A name that matches several services returns the list of keys." },
        logs: { type: "boolean", description: "Include the last 100 log lines of the container or systemd unit. Default false." },
      },
      required: ["target"],
    },
  },
  {
    name: "monitoring_incidents",
    description: "List recent incidents (outages), newest first: the open ones and those resolved in the last 30 days, with the services they cover and why they opened.",
    inputSchema: {
      type: "object",
      properties: {
        open_only: { type: "boolean", description: "Only incidents that are still open. Default false." },
        limit: { type: "number", description: "How many to return. Default 20, at most 50." },
      },
    },
  },
];
