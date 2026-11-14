import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { settings } from "./db/schema.js";

export const USER_PROFILE_SETTING_KEY = "user_profile_md";

export function getUserProfileMarkdown(): string {
  return db.select().from(settings).where(eq(settings.key, USER_PROFILE_SETTING_KEY)).get()?.value ?? "";
}

export function getUserProfileHint(): string {
  if (!getUserProfileMarkdown().trim()) return "";
  return [
    "<user-profile>",
    "A full user.md profile exists, but is intentionally kept out of normal prompt context.",
    "Use the read_user_profile tool only when deeper personal context is needed for this task.",
    "</user-profile>",
  ].join("\n");
}
