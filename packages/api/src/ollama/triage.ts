import { db } from "../db/index.js";
import { souls } from "../db/schema.js";
import type { RoutingDecision } from "@chomp/shared";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic message routing — no LLM call.
 *
 * 1. @name of a soul → answer as it
 * 2. No mention → the channel's default (the runtime is chosen in the composer)
 */
export function routeMessage(userMessage: string): RoutingDecision {
  // --- @soulname → answer as that soul ---
  const mentionedSoul = db.select().from(souls).all()
    .sort((a, b) => b.name.length - a.name.length)
    .find((s) => new RegExp(`@${escapeRegExp(s.name)}\\b`, "i").test(userMessage));
  if (mentionedSoul) {
    const cleanPrompt = userMessage.replace(new RegExp(`@${escapeRegExp(mentionedSoul.name)}\\b`, "i"), "").trim() || userMessage;
    console.log(`[routing] @${mentionedSoul.name} (soul)`);
    return { action: "delegate", prompt: cleanPrompt, reason: "@mention", soulId: mentionedSoul.id };
  }

  return { action: "delegate", prompt: userMessage, reason: "default" };
}
