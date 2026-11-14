// Handler map for MCP tools.
// Each handler: (args, sessionId?) => Promise<McpToolResult>

import { randomUUID } from "crypto";
import { createPendingQuestion, QUESTION_TIMEOUT_MS } from "./pending-questions.js";
import { offerToPhones, withdrawFromPhones } from "../notifications/phone-requests.js";
import { getSessionConversationId, questionCallbacks } from "./state.js";
import { deliverAgentReply } from "./reply-delivery.js";
import { db } from "../db/index.js";
import { agentSessions, chatMessages, conversations, settings, skills } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { SAFE_SETTING_KEYS, isSafeSettingKey, validateSettingValue } from "../lib/setting-keys.js";
import { validateCreateProactiveRule } from "../proactive/rule-model.js";
import type { RunTarget } from "@chomp/shared";
import { findSoulByName, providerOfModel, runTargetFrom } from "../agents/run-target.js";
import type { MemoryRecord } from "../db/memories.js";
import type { StrokeInput } from "../lib/sketches.js";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

/** One memory as the agent sees it: with the user's own words it came from, so "why do you believe this?" is answerable. */
function formatMemory(m: MemoryRecord): string {
  const head = `[${m.category}] (id: ${m.id})${m.status === "active" ? "" : ` [${m.status.toUpperCase()}]`} ${m.content}`;
  const why = [
    m.evidenceQuote && `evidence: "${m.evidenceQuote}"${m.sourceConversationId ? ` (conversation ${m.sourceConversationId})` : ""}`,
    m.supersedesId && `replaces: ${m.supersedesId}`,
  ].filter(Boolean);
  return why.length ? `${head}\n  ${why.join("\n  ")}` : head;
}

function ok(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** The chat whose preview a run drives. Each chat has its own page, as each has its own agents. */
function previewChat(sessionId: string | undefined): string {
  const conversationId = sessionId && getSessionConversationId(sessionId);
  if (!conversationId) throw new Error("The preview belongs to a chat, and this run has none.");
  return conversationId;
}

/** Wrap tool-runner-style exec functions: ERROR: prefix → err(), else ok() */
function wrapExec(result: string): McpToolResult {
  return result.startsWith("ERROR:") ? err(result) : ok(result);
}

/** A device tool's result for the agent. An image goes as an image block, because base64 in text can't be seen and burns tokens. */
export function deviceToolResult(result: unknown): McpToolResult {
  if (result && typeof result === "object" && "imageBase64" in result && typeof result.imageBase64 === "string") {
    const { imageBase64, mimeType, ...meta } = result as { imageBase64: string; mimeType?: string };
    return {
      content: [
        { type: "image", data: imageBase64, mimeType: mimeType ?? "image/jpeg" },
        { type: "text", text: JSON.stringify(meta, null, 2) },
      ],
    };
  }
  return ok(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

/**
 * Send an APNs silent push to wake a suspended ChompCompanion app, then wait
 * up to `timeoutMs` for the bridge WS to reconnect. Returns `true` if the
 * device shows up in the registry within the window, `false` otherwise.
 *
 * Tolerates missing APNs config — returns `false` without throwing so the
 * caller can fall back to the usual "device not connected" error message.
 */
async function tryWakeAndAwait(preferredDeviceId: string | undefined, timeoutMs: number): Promise<boolean> {
  const [{ deviceRegistry }, { devicePushTokens }, { sendSilentPush, isApnsConfigured }] = await Promise.all([
    import("../device-bridge/index.js"),
    import("../db/schema.js"),
    import("../lib/apns.js"),
  ]);
  if (!isApnsConfigured()) return false;

  // Figure out which device to wake. If preferredDeviceId was given, use it.
  // Otherwise, wake every registered device — for a single-phone setup
  // there's only one, and for multi-device the user has to specify which.
  const rows = preferredDeviceId
    ? db.select().from(devicePushTokens).where(eq(devicePushTokens.deviceId, preferredDeviceId)).all()
    : db.select().from(devicePushTokens).all();
  if (rows.length === 0) return false;

  const pushes = rows.map((row) =>
    sendSilentPush({
      deviceToken: row.apnsToken,
      environment: row.environment === "development" ? "development" : "production",
      collapseId: "wake",
    }).catch(() => ({ ok: false, error: "push send threw" })),
  );
  const results = await Promise.all(pushes);
  // If ALL pushes failed, no point waiting.
  if (!results.some((r) => r.ok)) return false;

  // Wait for any of the targeted devices to reconnect.
  const awaitOne = (deviceId: string) => deviceRegistry.awaitDeviceConnect(deviceId, timeoutMs);
  const targetIds = rows.map((r) => r.deviceId);
  const winner = await Promise.race(targetIds.map(awaitOne));
  return !!winner;
}

/** The provider, model, effort and soul a rule tool was asked for; a bare rule runs on Claude Sonnet, as these tools always did. */
function runTargetArgs(args: Record<string, unknown>): RunTarget {
  const soulName = typeof args.soul === "string" ? args.soul : undefined;
  const soul = soulName ? findSoulByName(soulName) : undefined;
  if (soulName && !soul) throw new Error(`Soul not found: ${soulName}`);
  const asked = runTargetFrom({ ...args, soulId: soul?.id });
  if (!asked.provider && !asked.model) return { ...asked, provider: "claude", model: "sonnet" };
  return { ...asked, provider: asked.provider ?? providerOfModel(asked.model) };
}

export type ToolHandler = (
  args: Record<string, unknown>,
  sessionId?: string,
) => Promise<McpToolResult>;

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface ProactiveRuleRow {
  id: string;
  name: string;
}

type ProactiveRuleMatch = { rule: ProactiveRuleRow } | { error: string };

/**
 * Resolve a proactive rule from args: prefer `id` exact, fall back to
 * case-insensitive `name` (exact, then substring). Used by every
 * proactive-rule management tool except create.
 */
async function findProactiveRule(args: Record<string, unknown>): Promise<ProactiveRuleMatch> {
  const idArg = typeof args.id === "string" ? args.id : undefined;
  const nameArg = typeof args.name === "string" ? args.name : (typeof args.name_lookup === "string" ? args.name_lookup : undefined);
  if (!idArg && !nameArg) {
    return { error: "Provide either `id` or `name` to identify the rule." };
  }

  const { proactiveRules } = await import("../db/schema.js");
  const allRules = db.select().from(proactiveRules).all() as Array<ProactiveRuleRow & Record<string, unknown>>;

  if (idArg) {
    const match = allRules.find((r) => r.id === idArg);
    if (!match) return { error: `No rule with id "${idArg}".` };
    return { rule: match };
  }

  const lower = nameArg!.toLowerCase();
  const exact = allRules.find((r) => r.name.toLowerCase() === lower);
  if (exact) return { rule: exact };
  const partial = allRules.find((r) => r.name.toLowerCase().includes(lower));
  if (partial) return { rule: partial };
  const available = allRules.map((r) => `- ${r.name}`).join("\n") || "(none)";
  return { error: `No rule matching "${nameArg}". Available:\n${available}` };
}

export const toolHandlers: Record<string, ToolHandler> = {
  // ── Session-bound ──────────────────────────────────────────────

  async ask_user(args, sessionId) {
    const question = args.question as string;
    for (const cb of questionCallbacks) cb(sessionId!, question);
    const questionId = randomUUID();
    const answer = createPendingQuestion(sessionId!, question, questionId);
    void offerToPhones({
      id: questionId,
      category: "CHOMP_QUESTION",
      title: "Chomp asks",
      body: question,
      answerWith: { kind: "question", sessionId: sessionId!, questionId },
      expiresInMs: QUESTION_TIMEOUT_MS,
    }, { webFirst: true });
    try {
      return ok(await answer);
    } finally {
      withdrawFromPhones(questionId);
    }
  },

  async reply(args, sessionId) {
    const message = args.message as string;
    deliverAgentReply(sessionId!, message);
    return ok("Message sent");
  },

  // ── Conversation search ────────────────────────────────────────

  async search_conversations(args) {
    const { query, limit } = args as { query: string; limit?: number };
    const maxLimit = Math.min(limit ?? 10, 50);

    try {
      const sqlite = (db as { $client: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } }).$client;
      const rows = sqlite
        .prepare(
          `SELECT
            c.id AS conversationId,
            c.title AS conversationTitle,
            c.updated_at AS updatedAt,
            cm.role,
            snippet(chat_messages_fts, 2, '', '', '…', 20) AS snippet
          FROM chat_messages_fts
          JOIN chat_messages cm ON chat_messages_fts.message_id = cm.id
          JOIN conversations c ON cm.conversation_id = c.id
          WHERE chat_messages_fts MATCH ?
          ORDER BY rank
          LIMIT ?`
        )
        .all(`${query}*`, maxLimit * 3) as Array<{
          conversationId: string;
          conversationTitle: string | null;
          updatedAt: string;
          role: string;
          snippet: string;
        }>;

      // Deduplicate by conversation
      const seen = new Set<string>();
      const results = rows
        .filter((r) => {
          if (seen.has(r.conversationId)) return false;
          seen.add(r.conversationId);
          return true;
        })
        .slice(0, maxLimit);

      if (results.length === 0) {
        return ok(`No conversations found matching "${query}".`);
      }

      const text = results
        .map(
          (r) =>
            `[${r.updatedAt?.slice(0, 10) ?? ""}] ${r.conversationTitle ?? "Untitled"} — ${r.snippet}`,
        )
        .join("\n");
      return ok(text);
    } catch {
      return err(
        `Search failed. The conversation index may not be initialized yet.`,
      );
    }
  },

  // ── Memory ─────────────────────────────────────────────────────

  async save_memory(args) {
    const { content, category } = args as { content: string; category: string };
    const { saveMemory } = await import("../db/memories.js");
    const { emit } = await import("../events/bus.js");
    const memory = saveMemory({ content, category, agentId: null });
    emit({ type: "memory.saved", memoryId: memory.id, category, content, source: "agent" });
    return ok(`Memory saved (id: ${memory.id})`);
  },

  async recall_memories(args) {
    const { ids, query, category, limit, use_semantic } = args as {
      ids?: string[];
      query?: string;
      category?: string;
      limit?: number;
      use_semantic?: boolean;
    };
    const { recallMemories, recallMemoriesSemantic, getMemoryById } = await import(
      "../db/memories.js"
    );

    // Direct id lookup — how the agent expands an [index] summary into full text.
    if (ids && ids.length > 0) {
      const found = ids.map((id) => getMemoryById(id)).filter((m) => m !== undefined);
      const missing = ids.filter((id) => !found.some((m) => m.id === id));
      const body =
        found.length === 0
          ? "No memories found for those ids."
          : found.map(formatMemory).join("\n\n");
      return ok(
        missing.length > 0 ? `${body}\n\nNot found: ${missing.join(", ")}` : body,
      );
    }

    // use_semantic defaults to true; only disable when explicitly set to false
    const useSemantic = use_semantic !== false;

    let memories;
    if (query && useSemantic) {
      memories = await recallMemoriesSemantic({ query, category, limit });
    } else {
      memories = recallMemories({ query, category, limit });
    }

    const text =
      memories.length === 0
        ? "No memories found."
        : memories.map(formatMemory).join("\n\n");
    return ok(text);
  },

  async update_memory(args) {
    const { id, content } = args as { id: string; content: string };
    const { updateMemory } = await import("../db/memories.js");
    const { emit } = await import("../events/bus.js");
    const updated = updateMemory(id, content);
    if (!updated) return err(`Memory not found (id: ${id})`);
    emit({ type: "memory.saved", memoryId: id, category: updated.category, content, source: "agent" });
    return ok(`Memory updated (id: ${id})`);
  },

  async delete_memory(args) {
    const { id } = args as { id: string };
    const { retireMemory } = await import("../db/memories.js");
    if (!retireMemory(id)) return err(`No active memory with id ${id}`);
    return ok(`Memory deleted (id: ${id}). It is retired, not erased, so it can be restored.`);
  },

  async dream_digest(args) {
    const { execDreamDigest } = await import("../agents/tools/dream-digest.js");
    return wrapExec(execDreamDigest({ days: args.days as number | undefined }));
  },

  // ── Google auth ────────────────────────────────────────────────

  async get_google_token() {
    const { getAccessToken } = await import("../integrations/google/auth.js");
    const token = await getAccessToken();
    if (token) return ok(token);
    return err(
      "Google is not connected. Ask the user to connect Google in Settings.",
    );
  },

  // ── Spotify ────────────────────────────────────────────────────

  async spotify_search(args) {
    const { execSearchSpotify } = await import("../agents/tools/spotify.js");
    const result = await execSearchSpotify(
      args.query as string,
      args.types as string[] | undefined,
      args.limit as number | undefined,
    );
    return wrapExec(result);
  },

  async spotify_list_playlists(args) {
    const { execListPlaylists } = await import("../agents/tools/spotify.js");
    const result = await execListPlaylists(args.limit as number | undefined);
    return wrapExec(result);
  },

  async spotify_get_playlist(args) {
    const { execGetPlaylist } = await import("../agents/tools/spotify.js");
    const result = await execGetPlaylist(
      args.playlist_id as string,
      args.track_limit as number | undefined,
    );
    return wrapExec(result);
  },

  async spotify_create_playlist(args) {
    const { execCreatePlaylist } = await import("../agents/tools/spotify.js");
    const result = await execCreatePlaylist(
      args.name as string,
      args.description as string | undefined,
      args.public as boolean | undefined,
    );
    return wrapExec(result);
  },

  async spotify_add_to_playlist(args) {
    const { execAddToPlaylist } = await import("../agents/tools/spotify.js");
    const result = await execAddToPlaylist(
      args.playlist_id as string,
      args.track_uris as string[],
    );
    return wrapExec(result);
  },

  async spotify_track_metrics(args) {
    const { execTrackMetrics } = await import("../agents/tools/spotify.js");
    const result = await execTrackMetrics(args.track_ids as string[]);
    return wrapExec(result);
  },

  async spotify_remove_from_playlist(args) {
    const { execRemoveFromPlaylist } = await import("../agents/tools/spotify.js");
    const result = await execRemoveFromPlaylist(
      args.playlist_id as string,
      args.track_uris as string[],
    );
    return wrapExec(result);
  },

  // ── Settings ───────────────────────────────────────────────────

  async get_setting(args) {
    const key = args.key as string;
    if (!isSafeSettingKey(key)) {
      return err(
        `Invalid setting key: ${key}. Allowed: ${SAFE_SETTING_KEYS.join(", ")}`,
      );
    }
    const rows = db.select().from(settings).where(eq(settings.key, key)).all();
    if (rows.length === 0) return ok("");
    return ok(rows[0].value);
  },

  async list_settings() {
    const rows = db.select().from(settings).all();
    const map: Record<string, string> = {};
    for (const row of rows) {
      if (isSafeSettingKey(row.key)) map[row.key] = row.value;
    }
    return ok(JSON.stringify(map, null, 2));
  },

  async read_user_profile() {
    const { getUserProfileMarkdown } = await import("../user-profile.js");
    const profile = getUserProfileMarkdown().trim();
    if (!profile) return ok("No user.md profile has been saved yet.");
    return ok(profile);
  },

  // ── Skills ─────────────────────────────────────────────────────

  async get_skills(args) {
    const allSkills = db
      .select()
      .from(skills)
      .all()
      .filter((s) => s.enabled);
    const name = args.name as string | undefined;
    if (name) {
      const skill = allSkills.find(
        (s) => s.name.toLowerCase() === name.toLowerCase(),
      );
      if (!skill) {
        return ok(
          `Skill "${name}" not found. Available: ${allSkills.map((s) => s.name).join(", ")}`,
        );
      }
      return ok(`# Skill: ${skill.name}\n${skill.description}\n\n${skill.content}`);
    }
    const list = allSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    return ok(`Available skills:\n${list}`);
  },

  // ── Drive ──────────────────────────────────────────────────────

  async list_drive_files(args) {
    const { execListDriveFiles } = await import("../agents/tools/drive.js");
    const result = await execListDriveFiles(
      args.folder_id as string | undefined,
      args.page_size as number | undefined,
    );
    return wrapExec(result);
  },

  async upload_drive_file(args) {
    const { execUploadDriveFile } = await import("../agents/tools/drive.js");
    const result = await execUploadDriveFile(
      args.filename as string,
      args.content as string,
      args.mime_type as string,
      args.folder_id as string | undefined,
    );
    return wrapExec(result);
  },

  async get_drive_file(args) {
    const { execGetDriveFile } = await import("../agents/tools/drive.js");
    const result = await execGetDriveFile(args.file_id as string);
    return wrapExec(result);
  },

  async update_drive_file(args) {
    const { execUpdateDriveFile } = await import("../agents/tools/drive.js");
    const result = await execUpdateDriveFile(
      args.file_id as string,
      args.content as string,
      args.mime_type as string | undefined,
    );
    return wrapExec(result);
  },

  async delete_drive_file(args) {
    const { execDeleteDriveFile } = await import("../agents/tools/drive.js");
    const result = await execDeleteDriveFile(args.file_id as string);
    return wrapExec(result);
  },

  async create_drive_folder(args) {
    const { execCreateDriveFolder } = await import("../agents/tools/drive.js");
    const result = await execCreateDriveFolder(
      args.name as string,
      args.folder_id as string | undefined,
    );
    return wrapExec(result);
  },

  // ── Recipes (Chewable Foodie) ──────────────────────────────────

  async search_recipes(args) {
    const { execSearchRecipes } = await import("../agents/tools/recipes.js");
    const result = await execSearchRecipes(
      args.query as string | undefined,
      args.url as string | undefined,
      args.limit as number | undefined,
    );
    return wrapExec(result);
  },

  async import_recipe_from_url(args) {
    const { execImportRecipeFromUrl } = await import(
      "../agents/tools/recipes.js"
    );
    const result = await execImportRecipeFromUrl(
      args.url as string,
      args.is_global as boolean | undefined,
      args.source_tag as string | undefined,
    );
    return wrapExec(result);
  },

  async import_recipe_from_text(args) {
    const { execImportRecipeFromText } = await import(
      "../agents/tools/recipes.js"
    );
    const result = await execImportRecipeFromText(
      args.text as string,
      args.source_url as string | undefined,
      args.is_global as boolean | undefined,
      args.source_tag as string | undefined,
    );
    return wrapExec(result);
  },

  async update_recipe_image(args) {
    const { execUpdateRecipeImage } = await import("../agents/tools/recipes.js");
    const result = await execUpdateRecipeImage(
      args.recipe_id as string,
      args.image_url as string,
    );
    return wrapExec(result);
  },

  // ── Gmail ──────────────────────────────────────────────────────

  async search_email(args) {
    const { execSearchEmail } = await import("../agents/tools/gmail.js");
    const result = await execSearchEmail(
      args.query as string,
      args.max_results as number | undefined,
    );
    return wrapExec(result);
  },

  async read_email(args) {
    const { execReadEmail } = await import("../agents/tools/gmail.js");
    const result = await execReadEmail(args.message_id as string);
    return wrapExec(result);
  },

  async draft_email(args) {
    const { execDraftEmail } = await import("../agents/tools/gmail.js");
    const result = await execDraftEmail(
      args.to as string,
      args.subject as string,
      args.body as string,
      args.cc as string | undefined,
    );
    return wrapExec(result);
  },

  async mark_emails_read(args) {
    const { execMarkEmailsRead } = await import("../agents/tools/gmail.js");
    const result = await execMarkEmailsRead(args.query as string | undefined);
    return wrapExec(result);
  },

  async mark_emails_unread(args) {
    const { execMarkEmailsUnread } = await import("../agents/tools/gmail.js");
    const result = await execMarkEmailsUnread(args.query as string | undefined);
    return wrapExec(result);
  },

  // ── Calendar ───────────────────────────────────────────────────

  async list_events(args) {
    const { execListEvents } = await import("../agents/tools/calendar.js");
    const result = await execListEvents(
      args.time_min as string | undefined,
      args.time_max as string | undefined,
      args.max_results as number | undefined,
    );
    return wrapExec(result);
  },

  async create_event(args) {
    const { execCreateEvent } = await import("../agents/tools/calendar.js");
    const result = await execCreateEvent(
      args.summary as string,
      args.start_time as string,
      args.end_time as string,
      args.description as string | undefined,
      args.location as string | undefined,
      args.timezone as string | undefined,
    );
    return wrapExec(result);
  },

  // ── GitHub ───────────────────────────────────────────────────

  async create_github_issue(args) {
    const { execCreateGithubIssue } = await import("../agents/tools/github.js");
    const result = await execCreateGithubIssue(
      args.repo as string,
      args.title as string,
      args.body as string,
      args.labels as string[] | undefined,
    );
    return wrapExec(result);
  },

  // ── Proactive rules ────────────────────────────────────────────

  async create_proactive_rule(args) {
    const { proactiveRules } = await import("../db/schema.js");
    const name = args.name as string;
    const agentPrompt = args.agent_prompt as string;
    const activeHoursStart = args.active_hours_start as number | undefined;
    const activeHoursEnd = args.active_hours_end as number | undefined;
    const activeHoursTimezone = args.active_hours_timezone as string | undefined;
    const cooldownMinutes = (args.cooldown_minutes as number | undefined) ?? 1380;
    const jitterMinMinutes = args.jitter_min_minutes as number | undefined;
    const jitterMaxMinutes = args.jitter_max_minutes as number | undefined;
    const guard = args.guard as Record<string, unknown> | undefined;
    const gate = args.gate as Record<string, unknown> | undefined;
    const target = runTargetArgs(args);
    const rawNotificationChannels = args.notification_channels as unknown;
    let notificationChannels = ["telegram"];
    if (rawNotificationChannels !== undefined) {
      if (!Array.isArray(rawNotificationChannels)) {
        return err("notification_channels must be an array containing 'telegram' and/or 'discord'.");
      }
      const invalid = rawNotificationChannels.find((channel) => channel !== "telegram" && channel !== "discord");
      if (invalid !== undefined) {
        return err(`Invalid notification channel "${String(invalid)}". Expected 'telegram' and/or 'discord'.`);
      }
      notificationChannels = [...new Set(rawNotificationChannels as string[])];
    }

    const activeHours: Record<string, number | string> = {};
    if (activeHoursStart !== undefined) activeHours.start = activeHoursStart;
    if (activeHoursEnd !== undefined) activeHours.end = activeHoursEnd;
    if (activeHoursTimezone) activeHours.timezone = activeHoursTimezone;

    const condition: Record<string, unknown> = {};
    if (jitterMinMinutes !== undefined || jitterMaxMinutes !== undefined) {
      const min = Math.max(1, Math.floor(jitterMinMinutes ?? cooldownMinutes));
      const max = Math.max(min, Math.floor(jitterMaxMinutes ?? min));
      condition.scheduleMode = "jittered";
      condition.jitterMinMinutes = min;
      condition.jitterMaxMinutes = max;
    }
    if (guard !== undefined) condition.guard = guard;

    const delegateConfig: Record<string, unknown> = { ...target, prompt: agentPrompt };
    const actionConfig: Record<string, unknown> = gate
      ? {
          script: gate.script,
          input: gate.input ?? {},
          onTrue: delegateConfig,
        }
      : delegateConfig;
    const actionType = gate ? "script_gate" : "run_agent";
    const validation = validateCreateProactiveRule({
      name,
      triggerType: "periodic",
      condition,
      actionType,
      actionConfig,
      enabled: true,
      cooldownMinutes,
      activeHours,
      priority: 0,
      notificationChannels,
      runAt: null,
    });
    if (!validation.ok) {
      return err(`${validation.error}: ${validation.details.join("; ")}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(proactiveRules).values({
      id,
      name,
      triggerType: "periodic",
      condition: JSON.stringify(validation.value.condition),
      actionType,
      actionConfig: JSON.stringify(validation.value.actionConfig),
      enabled: true,
      cooldownMinutes,
      activeHours: JSON.stringify(validation.value.activeHours),
      notificationChannels: JSON.stringify(validation.value.notificationChannels),
      priority: 0,
      runAt: null,
      createdAt: now,
      updatedAt: now,
    }).run();

    const windowTz = activeHoursTimezone ? ` ${activeHoursTimezone}` : "";
    const windowDesc = activeHoursStart !== undefined
      ? `active window: ${activeHoursStart}:00–${activeHoursEnd ?? activeHoursStart}:59${windowTz}`
      : "no time window restriction";
    const jitterDesc = condition.scheduleMode === "jittered"
      ? `, randomized interval: ${condition.jitterMinMinutes}–${condition.jitterMaxMinutes}min`
      : "";
    const guardDesc = condition.guard ? ", guard: configured" : "";
    const gateDesc = gate ? `, gate: ${String(gate.script)}` : "";
    return ok(`Created proactive rule "${name}" (id: ${id}). ${windowDesc}, cooldown: ${cooldownMinutes}min${jitterDesc}${guardDesc}${gateDesc}, channels: ${notificationChannels.join(", ")}. It will persist across restarts.`);
  },

  async delete_proactive_rule(args) {
    const { proactiveRules } = await import("../db/schema.js");
    const name = args.name as string;
    const allRules = db.select().from(proactiveRules).all();
    const lower = name.toLowerCase();
    const match = allRules.find((r) => r.name.toLowerCase() === lower)
      ?? allRules.find((r) => r.name.toLowerCase().includes(lower));

    if (!match) {
      const available = allRules.map((r) => `- ${r.name}`).join("\n");
      return err(`No rule matching "${name}". Available rules:\n${available}`);
    }

    db.delete(proactiveRules).where(eq(proactiveRules.id, match.id)).run();
    return ok(`Deleted proactive rule "${match.name}".`);
  },

  async trigger_proactive_rule(args) {
    const { proactiveRules } = await import("../db/schema.js");
    const { triggerRule } = await import("../proactive/engine.js");
    const allRules = db.select().from(proactiveRules).all();

    const name = args.name as string | undefined;
    if (!name) {
      const list = allRules
        .map((r) => `- ${r.name} [${r.enabled ? "enabled" : "disabled"}] (${r.triggerType}, ${r.actionType})`)
        .join("\n");
      return ok(list || "No proactive rules configured.");
    }

    const lower = name.toLowerCase();
    const match = allRules.find((r) => r.name.toLowerCase() === lower)
      ?? allRules.find((r) => r.name.toLowerCase().includes(lower));

    if (!match) {
      const suggestions = allRules
        .filter((r) => r.enabled)
        .map((r) => `- ${r.name}`)
        .join("\n");
      return err(`No rule matching "${name}". Available rules:\n${suggestions}`);
    }

    const result = await triggerRule(match.id);
    if (!result.ok) {
      return err(`Failed to trigger "${match.name}": ${result.error}`);
    }
    return ok(`Triggered "${match.name}" successfully.`);
  },

  // ── Scheduling ─────────────────────────────────────────────────

  async schedule_one_off(args) {
    const { proactiveRules } = await import("../db/schema.js");
    const name = args.name as string;
    const runAt = args.run_at as string;
    const actionType = args.action_type as string;

    if (!name || !runAt || !actionType) {
      return err("ERROR: name, run_at, and action_type are required");
    }

    const runAtDate = new Date(runAt);
    if (isNaN(runAtDate.getTime())) {
      return err("ERROR: run_at must be a valid ISO 8601 datetime");
    }
    if (runAtDate.getTime() <= Date.now()) {
      return err("ERROR: run_at must be in the future");
    }

    const actionConfig: Record<string, string> = {};
    if (actionType === "notify") {
      actionConfig.title = (args.notify_title as string) ?? name;
      actionConfig.body = (args.notify_body as string) ?? "";
    } else if (actionType === "run_agent") {
      Object.assign(actionConfig, runTargetArgs({ ...args, model: args.agent_model }));
      actionConfig.prompt = (args.agent_prompt as string) ?? "";
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(proactiveRules).values({
      id,
      name,
      triggerType: "periodic",
      condition: "{}",
      actionType,
      actionConfig: JSON.stringify(actionConfig),
      enabled: true,
      cooldownMinutes: 0,
      activeHours: "{}",
      priority: 0,
      runAt: runAtDate.toISOString(),
      createdAt: now,
      updatedAt: now,
    }).run();

    return ok(`Scheduled "${name}" for ${runAtDate.toISOString()}. It will fire once and auto-delete.`);
  },

  async save_artifact(args) {
    const { saveArtifact, artifactFence } = await import("../lib/artifacts.js");
    try {
      const id = saveArtifact(args.html as string, args.id as string | undefined);
      return ok(`Saved. Paste this block into your reply to show it:\n\n${artifactFence(id, args.title as string)}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : "Could not save artifact");
    }
  },

  // ── Other chats ────────────────────────────────────────────────

  async message_chat(args, sessionId) {
    const { execMessageChat } = await import("../agents/tools/message-chat.js");
    return wrapExec(execMessageChat({ conversationId: args.conversationId as string, message: args.message as string }, sessionId));
  },

  // ── Preview ────────────────────────────────────────────────────

  async preview_start(args, sessionId) {
    const { execPreviewStart } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewStart(previewChat(sessionId), { name: args.name as string | undefined, url: args.url as string | undefined }));
  },

  async preview_stop(args, sessionId) {
    const { execPreviewStop } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewStop(previewChat(sessionId), { name: args.name as string }));
  },

  async preview_list(_args, sessionId) {
    const { execPreviewList } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewList(previewChat(sessionId)));
  },

  async preview_logs(args, sessionId) {
    const { execPreviewLogs } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewLogs(previewChat(sessionId), args as Parameters<typeof execPreviewLogs>[1]));
  },

  async preview_snapshot(_args, sessionId) {
    const { execPreviewSnapshot } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewSnapshot(previewChat(sessionId)));
  },

  async preview_screenshot(_args, sessionId) {
    const { execPreviewScreenshot } = await import("../agents/tools/preview.js");
    return deviceToolResult(await execPreviewScreenshot(previewChat(sessionId)));
  },

  async preview_act(args, sessionId) {
    const { execPreviewAct } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewAct(previewChat(sessionId), args as unknown as Parameters<typeof execPreviewAct>[1]));
  },

  async preview_navigate(args, sessionId) {
    const { execPreviewNavigate } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewNavigate(previewChat(sessionId), { url: args.url as string }));
  },

  async preview_eval(args, sessionId) {
    const { execPreviewEval } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewEval(previewChat(sessionId), { expression: args.expression as string }));
  },

  async preview_resize(args, sessionId) {
    const { execPreviewResize } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewResize(previewChat(sessionId), args as Parameters<typeof execPreviewResize>[1]));
  },

  async preview_window(args, sessionId) {
    const { execPreviewWindow } = await import("../agents/tools/preview.js");
    return wrapExec(await execPreviewWindow(previewChat(sessionId), args as Parameters<typeof execPreviewWindow>[1]));
  },

  // ── Sketches ───────────────────────────────────────────────────

  async create_sketch(args) {
    const { createSketch, sketchFence } = await import("../lib/sketches.js");
    try {
      const sketch = createSketch({
        title: args.title as string,
        reference: args.reference as string | undefined,
        note: args.note as string | undefined,
      });
      return ok(`Sketch ${sketch.id} created. Paste this block into your reply:\n\n${sketchFence(sketch)}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : "Could not create sketch");
    }
  },

  async read_sketch(args) {
    const { readSketch, describeSketch, renderSketchViews } = await import("../lib/sketches.js");
    const sketch = readSketch(args.id as string);
    if (!sketch) return err(`No sketch with id ${args.id}`);
    try {
      const views = await renderSketchViews(sketch.id);
      return ok(`${describeSketch(sketch)}\n\nSheet: ${views.sheet}\nGrid view: ${views.grid}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : "Could not render sketch");
    }
  },

  async draw_on_sketch(args) {
    const { addStrokes, renderRehearsal, sketchFence } = await import("../lib/sketches.js");
    const id = args.id as string;
    const strokes = args.strokes as StrokeInput[];
    try {
      if (args.rehearse) {
        const views = await renderRehearsal(id, strokes);
        return ok(`Rehearsal only, the sheet is unchanged.\nSheet: ${views.sheet}\nGrid view: ${views.grid}`);
      }
      const sketch = addStrokes(id, strokes, "agent", {
        note: args.note as string | undefined,
        reference: args.reference as string | undefined,
      });
      return ok(`Drawn. Your turn is over. Paste this block into your reply:\n\n${sketchFence(sketch)}`);
    } catch (e) {
      return err(e instanceof Error ? e.message : "Could not draw on sketch");
    }
  },

  // ── Site preview ───────────────────────────────────────────────

  async create_site(args) {
    const { execCreateSite } = await import("../agents/tools/sites.js");
    const result = await execCreateSite(
      args.title as string,
      args.html_content as string,
      args.slug as string | undefined,
      args.description as string | undefined,
      args.password as string | undefined,
    );
    return wrapExec(result);
  },

  async list_sites(args) {
    const { execListSites } = await import("../agents/tools/sites.js");
    const result = await execListSites(args.limit as number | undefined);
    return wrapExec(result);
  },

  async get_site(args) {
    const { execGetSite } = await import("../agents/tools/sites.js");
    const result = await execGetSite(args.site_id as string);
    return wrapExec(result);
  },

  async update_site(args) {
    const { execUpdateSite } = await import("../agents/tools/sites.js");
    const result = await execUpdateSite(
      args.site_id as string,
      args.title as string | undefined,
      args.html_content as string | undefined,
      args.description as string | undefined,
      args.password as string | undefined,
      args.slug as string | undefined,
      args.skip_git as boolean | undefined,
    );
    return wrapExec(result);
  },

  async track_site_in_git(args) {
    const { execTrackSiteInGit } = await import("../agents/tools/site-git.js");
    const result = await execTrackSiteInGit(args.site_id as string, {
      private: args.private as boolean | undefined,
      repoName: args.repo_name as string | undefined,
      inviteCollaborator:
        args.invite_collaborator === null
          ? null
          : (args.invite_collaborator as string | undefined),
    });
    return wrapExec(result);
  },

  async untrack_site_from_git(args) {
    const { execUntrackSiteFromGit } = await import("../agents/tools/site-git.js");
    const result = await execUntrackSiteFromGit(args.site_id as string, {
      deleteRemote: args.delete_remote as boolean | undefined,
    });
    return wrapExec(result);
  },

  async delete_site(args) {
    const { execDeleteSite } = await import("../agents/tools/sites.js");
    const result = await execDeleteSite(args.site_id as string);
    return wrapExec(result);
  },

  async publish_site(args) {
    const { execPublishSite } = await import("../agents/tools/sites.js");
    const result = await execPublishSite(args.site_id as string);
    return wrapExec(result);
  },

  async unpublish_site(args) {
    const { execUnpublishSite } = await import("../agents/tools/sites.js");
    const result = await execUnpublishSite(args.site_id as string);
    return wrapExec(result);
  },

  // ── Dashboards ─────────────────────────────────────────────────

  async list_dashboards() {
    const { execListDashboards } = await import("../agents/tools/dashboards.js");
    return wrapExec(await execListDashboards());
  },

  async get_dashboard(args) {
    const { execGetDashboard } = await import("../agents/tools/dashboards.js");
    return wrapExec(await execGetDashboard({
      id: args.id as string | undefined,
      slug: args.slug as string | undefined,
    }));
  },

  async create_dashboard(args) {
    const { execCreateDashboard } = await import("../agents/tools/dashboards.js");
    return wrapExec(await execCreateDashboard({
      name: args.name as string | undefined,
      description: args.description as string | undefined,
      autoRefreshEnabled: args.autoRefreshEnabled as boolean | undefined,
    }));
  },

  async update_dashboard(args) {
    const { execUpdateDashboard } = await import("../agents/tools/dashboards.js");
    return wrapExec(await execUpdateDashboard({
      id: args.id as string | undefined,
      name: args.name as string | undefined,
      description: args.description as string | undefined,
      autoRefreshEnabled: args.autoRefreshEnabled as boolean | undefined,
    }));
  },

  async delete_dashboard(args) {
    const { execDeleteDashboard } = await import("../agents/tools/dashboards.js");
    return wrapExec(await execDeleteDashboard({ id: args.id as string | undefined }));
  },

  async create_widget(args) {
    const { execCreateWidget } = await import("../agents/tools/dashboards.js");
    return wrapExec(await execCreateWidget({
      dashboardId: args.dashboardId as string | undefined,
      dashboardSlug: args.dashboardSlug as string | undefined,
      title: args.title as string | undefined,
      blocks: args.blocks,
      gridW: args.gridW as number | undefined,
      gridH: args.gridH as number | undefined,
    }));
  },

  async update_widget(args) {
    const { execUpdateWidget } = await import("../agents/tools/dashboards.js");
    return wrapExec(await execUpdateWidget({
      id: args.id as string | undefined,
      title: args.title as string | undefined,
      blocks: args.blocks,
      gridX: args.gridX as number | undefined,
      gridY: args.gridY as number | undefined,
      gridW: args.gridW as number | undefined,
      gridH: args.gridH as number | undefined,
    }));
  },

  async delete_widget(args) {
    const { execDeleteWidget } = await import("../agents/tools/dashboards.js");
    return wrapExec(await execDeleteWidget({ id: args.id as string | undefined }));
  },

  async set_widget_refresher(args) {
    const { execSetWidgetRefresher } = await import("../agents/tools/dashboards.js");
    return wrapExec(await execSetWidgetRefresher({
      id: args.id as string | undefined,
      kind: args.kind as "skill" | "prompt" | null | undefined,
      payload: args.payload as Record<string, unknown> | null | undefined,
      schema: args.schema,
      refreshIntervalMinutes: args.refreshIntervalMinutes as number | null | undefined,
    }));
  },

  // ── Proactive rule management (CRUD beyond create/delete/trigger) ──

  async list_proactive_rules() {
    const { proactiveRules } = await import("../db/schema.js");
    const { parseStoredProactiveRule } = await import("../proactive/rule-model.js");
    const rows = db.select().from(proactiveRules).all();
    return ok(JSON.stringify(rows.map(parseStoredProactiveRule), null, 2));
  },

  async get_proactive_rule(args) {
    const { proactiveRules } = await import("../db/schema.js");
    const { parseStoredProactiveRule } = await import("../proactive/rule-model.js");
    const match = await findProactiveRule(args);
    if ("error" in match) return err(match.error);
    const fresh = db.select().from(proactiveRules).where(eq(proactiveRules.id, match.rule.id)).get();
    if (!fresh) return err(`Rule disappeared: ${match.rule.id}`);
    return ok(JSON.stringify(parseStoredProactiveRule(fresh), null, 2));
  },

  async update_proactive_rule(args) {
    const { proactiveRules } = await import("../db/schema.js");
    const { parseStoredProactiveRule, validateUpdateProactiveRule } = await import("../proactive/rule-model.js");
    const match = await findProactiveRule(args);
    if ("error" in match) return err(match.error);

    const updates = { ...args } as Record<string, unknown>;
    delete updates.id;
    delete updates.name_lookup;

    const validated = validateUpdateProactiveRule(updates);
    if (!validated.ok) return err(`Invalid update: ${validated.error}`);
    const v = validated.value;

    db.update(proactiveRules).set({
      ...(v.name !== undefined && { name: v.name }),
      ...(v.triggerType !== undefined && { triggerType: v.triggerType }),
      ...(v.condition !== undefined && { condition: JSON.stringify(v.condition) }),
      ...(v.actionType !== undefined && { actionType: v.actionType }),
      ...(v.actionConfig !== undefined && { actionConfig: JSON.stringify(v.actionConfig) }),
      ...(v.enabled !== undefined && { enabled: v.enabled }),
      ...(v.cooldownMinutes !== undefined && { cooldownMinutes: v.cooldownMinutes }),
      ...(v.activeHours !== undefined && { activeHours: JSON.stringify(v.activeHours) }),
      ...(v.priority !== undefined && { priority: v.priority }),
      ...(v.notificationChannels !== undefined && { notificationChannels: JSON.stringify(v.notificationChannels) }),
      ...(v.runAt !== undefined && { runAt: v.runAt }),
      updatedAt: new Date().toISOString(),
    }).where(eq(proactiveRules.id, match.rule.id)).run();

    const updated = db.select().from(proactiveRules).where(eq(proactiveRules.id, match.rule.id)).get()!;
    return ok(JSON.stringify(parseStoredProactiveRule(updated), null, 2));
  },

  async list_proactive_rule_runs(args) {
    const { proactiveRuleRuns } = await import("../db/schema.js");
    const match = await findProactiveRule(args);
    if ("error" in match) return err(match.error);
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    const runs = db
      .select()
      .from(proactiveRuleRuns)
      .where(eq(proactiveRuleRuns.ruleId, match.rule.id))
      .orderBy(desc(proactiveRuleRuns.triggeredAt))
      .limit(limit)
      .all();
    return ok(JSON.stringify({ rule: match.rule.name, runs }, null, 2));
  },

  async dry_run_proactive_rule(args) {
    const { dryRunRule } = await import("../proactive/engine.js");
    const match = await findProactiveRule(args);
    if ("error" in match) return err(match.error);
    const result = await dryRunRule(match.rule.id);
    if (!result.ok) return err(`Dry-run failed: ${result.error}`);
    return ok(JSON.stringify({ rule: match.rule.name, preview: result.preview }, null, 2));
  },

  // ── Conversations management ───────────────────────────────────

  async list_conversations(args) {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    const rows = db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
      .limit(limit)
      .all();
    return ok(JSON.stringify(
      rows.map((c) => ({ ...c, tags: safeJsonParse(c.tags, []) })),
      null,
      2,
    ));
  },

  async get_conversation_messages(args) {
    const id = args.conversation_id as string;
    if (!id) return err("conversation_id is required");
    const convo = db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!convo) return err(`Conversation not found: ${id}`);
    const msgs = db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, id))
      .orderBy(chatMessages.createdAt)
      .all();
    return ok(JSON.stringify(
      msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, agentUsed: m.agentUsed, createdAt: m.createdAt })),
      null,
      2,
    ));
  },

  // ── Event triggers ─────────────────────────────────────────────

  async list_triggers() {
    const { eventTriggers } = await import("../db/schema.js");
    const rows = db.select().from(eventTriggers).all();
    const parsed = rows.map((t) => ({
      ...t,
      condition: safeJsonParse(t.condition, []),
      action: safeJsonParse(t.action, {}),
    }));
    return ok(JSON.stringify(parsed, null, 2));
  },

  async get_trigger(args) {
    const { eventTriggers } = await import("../db/schema.js");
    const id = args.id as string;
    if (!id) return err("id is required");
    const row = db.select().from(eventTriggers).where(eq(eventTriggers.id, id)).get();
    if (!row) return err(`Trigger not found: ${id}`);
    return ok(JSON.stringify({
      ...row,
      condition: safeJsonParse(row.condition, []),
      action: safeJsonParse(row.action, {}),
    }, null, 2));
  },

  async create_trigger(args) {
    const { eventTriggers } = await import("../db/schema.js");
    const name = args.name as string;
    const eventType = args.event_type as string;
    if (!name || !eventType) return err("name and event_type are required");
    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(eventTriggers).values({
      id,
      name,
      description: (args.description as string | undefined) ?? "",
      eventType,
      condition: JSON.stringify((args.condition as unknown[] | undefined) ?? []),
      action: JSON.stringify((args.action as Record<string, unknown> | undefined) ?? {}),
      enabled: (args.enabled as boolean | undefined) ?? true,
      cooldownSeconds: (args.cooldown_seconds as number | undefined) ?? 0,
      once: (args.once as boolean | undefined) ?? false,
      createdAt: now,
      updatedAt: now,
    }).run();
    return ok(`Created trigger "${name}" (id: ${id}) for event ${eventType}.`);
  },

  async update_trigger(args) {
    const { eventTriggers } = await import("../db/schema.js");
    const id = args.id as string;
    if (!id) return err("id is required");
    const existing = db.select().from(eventTriggers).where(eq(eventTriggers.id, id)).get();
    if (!existing) return err(`Trigger not found: ${id}`);

    db.update(eventTriggers).set({
      ...(args.name !== undefined && { name: String(args.name) }),
      ...(args.description !== undefined && { description: String(args.description) }),
      ...(args.event_type !== undefined && { eventType: String(args.event_type) }),
      ...(args.condition !== undefined && { condition: JSON.stringify(args.condition) }),
      ...(args.action !== undefined && { action: JSON.stringify(args.action) }),
      ...(args.enabled !== undefined && { enabled: Boolean(args.enabled) }),
      ...(args.cooldown_seconds !== undefined && { cooldownSeconds: Number(args.cooldown_seconds) }),
      ...(args.once !== undefined && { once: Boolean(args.once) }),
      updatedAt: new Date().toISOString(),
    }).where(eq(eventTriggers.id, id)).run();

    const updated = db.select().from(eventTriggers).where(eq(eventTriggers.id, id)).get()!;
    return ok(JSON.stringify({
      ...updated,
      condition: safeJsonParse(updated.condition, []),
      action: safeJsonParse(updated.action, {}),
    }, null, 2));
  },

  async delete_trigger(args) {
    const { eventTriggers } = await import("../db/schema.js");
    const id = args.id as string;
    if (!id) return err("id is required");
    const existing = db.select().from(eventTriggers).where(eq(eventTriggers.id, id)).get();
    if (!existing) return err(`Trigger not found: ${id}`);
    db.delete(eventTriggers).where(eq(eventTriggers.id, id)).run();
    return ok(`Deleted trigger "${existing.name}" (${id}).`);
  },

  // ── Generic HTTP fetch (dashboard refresher primitive) ─────────

  async http_fetch_url(args) {
    const { execHttpFetchUrl } = await import("../agents/tools/http-fetch.js");
    return wrapExec(await execHttpFetchUrl({
      url: args.url as string | undefined,
      method: args.method as string | undefined,
      headers: args.headers as Record<string, string> | undefined,
      body: args.body as string | undefined,
    }));
  },

  // ── Discord side-channel post ──────────────────────────────────

  async discord_post(args) {
    const message = args.message;
    if (typeof message !== "string" || message.trim() === "") {
      return err("discord_post: 'message' must be a non-empty string");
    }
    const { sendDiscordMessage, getClient, getLinkedChannelId } = await import("../discord/bot.js");
    if (!getClient()) {
      return err("discord_post: Discord bot is not running (DISCORD_BOT_TOKEN not configured)");
    }
    if (!getLinkedChannelId()) {
      return err("discord_post: no Discord channel is linked. Run /link in the target channel first.");
    }
    const messageId = await sendDiscordMessage(message);
    if (!messageId) {
      return err("discord_post: send failed (bot may be offline or channel unreachable)");
    }
    return ok(`Posted to Discord (message id: ${messageId})`);
  },

  // ── Device bridge (phone/native client RPC) ────────────────────

  async phone_list_devices() {
    const { deviceRegistry } = await import("../device-bridge/index.js");
    const devices = deviceRegistry.list().map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      platform: d.platform,
      toolCount: d.tools.length,
      connectedAt: new Date(d.connectedAt).toISOString(),
      lastSeen: new Date(d.lastSeen).toISOString(),
    }));
    return ok(JSON.stringify({ devices }, null, 2));
  },

  async phone_list_tools(args) {
    const { deviceRegistry } = await import("../device-bridge/index.js");
    const deviceId = typeof args.device_id === "string" ? args.device_id : undefined;
    const resolved = deviceRegistry.resolveDevice(deviceId);
    if ("error" in resolved) return err(resolved.error);
    return ok(JSON.stringify({
      deviceId: resolved.deviceId,
      deviceName: resolved.deviceName,
      tools: resolved.tools,
    }, null, 2));
  },

  async create_shortcut(args) {
    const { execCreateShortcut } = await import("../agents/tools/shortcuts.js");
    return wrapExec(await execCreateShortcut(args));
  },

  async phone_call_tool(args) {
    const { deviceRegistry } = await import("../device-bridge/index.js");
    const deviceIdArg = typeof args.device_id === "string" ? args.device_id : undefined;
    const name = typeof args.name === "string" ? args.name : undefined;
    if (!name) return err("phone_call_tool: `name` is required");
    const toolArgs = (args.args && typeof args.args === "object") ? args.args : {};

    // The phone gives a Shortcut 2 minutes, so the default must wait longer than that.
    const defaultTimeout = name === "run_shortcut" ? 150_000 : 30_000;
    const rawTimeout = typeof args.timeout_ms === "number" ? args.timeout_ms : defaultTimeout;
    const timeoutMs = Math.max(1_000, Math.min(rawTimeout, 300_000));

    let resolved = deviceRegistry.resolveDevice(deviceIdArg);
    if ("error" in resolved) {
      // Try to wake the device via APNs silent push. iOS suspends background
      // WebSockets aggressively, so even an "always-connected" iPhone goes
      // offline within minutes of the app backgrounding. We wake it with a
      // silent push and wait up to ~6s for the bridge WS to reconnect.
      const woke = await tryWakeAndAwait(deviceIdArg, 6000);
      if (!woke) return err(resolved.error);
      resolved = deviceRegistry.resolveDevice(deviceIdArg);
      if ("error" in resolved) return err(resolved.error);
    }

    try {
      const result = await deviceRegistry.callTool(resolved.deviceId, name, toolArgs, timeoutMs);
      return deviceToolResult(result);
    } catch (e) {
      return err(`phone_call_tool: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  // ── Location ───────────────────────────────────────────────────

  async get_location(args) {
    const { execGetLocation } = await import("../agents/tools/location.js");
    if (args.fresh !== true) return wrapExec(execGetLocation());
    const fix = await toolHandlers.phone_call_tool({ name: "get_location", timeout_ms: 20_000 });
    const text = fix.content[0].type === "text" ? fix.content[0].text : "";
    return wrapExec(execGetLocation({ text, failed: !!fix.isError }));
  },

  async get_location_history(args) {
    const { execGetLocationHistory } = await import("../agents/tools/location.js");
    return wrapExec(execGetLocationHistory(args));
  },

  async list_places() {
    const { execListPlaces } = await import("../agents/tools/location.js");
    return wrapExec(await execListPlaces());
  },

  async create_place_trigger(args) {
    const { execCreatePlaceTrigger } = await import("../agents/tools/location.js");
    return wrapExec(await execCreatePlaceTrigger(args, runTargetArgs({ ...args, model: args.agent_model })));
  },

  // ── Webhook context ────────────────────────────────────────────

  async get_webhook_payload(args) {
    const { getWebhookPayload } = await import("../proactive/webhook-context.js");
    const webhookId = args.webhook_id as string | undefined;
    const entry = getWebhookPayload(webhookId);
    if (!entry) {
      return err("No webhook payload available. This tool is only useful when the agent is triggered by a webhook.received event.");
    }
    return ok(JSON.stringify({
      webhookId: entry.webhookId,
      webhookName: entry.webhookName,
      receivedAt: entry.receivedAt,
      payload: entry.payload,
    }, null, 2));
  },

  // ── Morning report ───────────────────────────────

  async publish_morning_report(args) {
    const { execPublishMorningReport } = await import("../agents/tools/goodmorning.js");
    return wrapExec(await execPublishMorningReport(args));
  },

  // ── Phone cards ──────────────────────────────────

  async publish_phone_cards(args) {
    const { execPublishPhoneCards } = await import("../agents/tools/phone-cards.js");
    return wrapExec(await execPublishPhoneCards(args));
  },

  async remove_phone_cards(args) {
    const { execRemovePhoneCards } = await import("../agents/tools/phone-cards.js");
    return wrapExec(await execRemovePhoneCards(args));
  },

  async schedule_social_post(args) {
    const { execScheduleSocialPost } = await import("../agents/tools/social-posts.js");
    return wrapExec(await execScheduleSocialPost(args));
  },

  async list_social_posts() {
    const { execListSocialPosts } = await import("../agents/tools/social-posts.js");
    return wrapExec(execListSocialPosts());
  },

  async remove_social_post(args) {
    const { execRemoveSocialPost } = await import("../agents/tools/social-posts.js");
    return wrapExec(await execRemoveSocialPost(args));
  },

  async send_imessage(args, sessionId) {
    const { execSendImessage } = await import("../agents/tools/imessage.js");
    return wrapExec(await execSendImessage(args, getSessionConversationId(sessionId!)));
  },

  async list_phone_cards() {
    const { execListPhoneCards } = await import("../agents/tools/phone-cards.js");
    return wrapExec(execListPhoneCards());
  },

  async monitoring_status(args) {
    const { execMonitoringStatus } = await import("../agents/tools/monitoring.js");
    return wrapExec(execMonitoringStatus(args));
  },

  async monitoring_target(args) {
    const { execMonitoringTarget } = await import("../agents/tools/monitoring.js");
    return wrapExec(await execMonitoringTarget(args));
  },

  async monitoring_incidents(args) {
    const { execMonitoringIncidents } = await import("../agents/tools/monitoring.js");
    return wrapExec(execMonitoringIncidents(args));
  },
};
