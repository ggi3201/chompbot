import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { settings, souls } from "../db/schema.js";
import { USER_PROFILE_SETTING_KEY } from "../user-profile.js";

const VOICE_SETTING_KEY = "voice_tts_voice";

export interface Birth {
  name: string;
  description: string;
  content: string;
  profile?: string;
  voice?: string;
}

/**
 * Makes this the one default soul. Running the rite again rewrites the same row, so it
 * never adds another agent, and every other soul stays as it was.
 */
export function saveBirth(birth: Birth): string {
  return db.transaction((tx) => {
    const current = tx.select().from(souls).where(eq(souls.isDefault, true)).get();
    const now = new Date().toISOString();
    const id = current?.id ?? randomUUID();
    const written = { name: birth.name, description: birth.description, content: birth.content, isDefault: true, updatedAt: now };

    tx.update(souls).set({ isDefault: false }).where(eq(souls.isDefault, true)).run();
    if (current) tx.update(souls).set(written).where(eq(souls.id, id)).run();
    else tx.insert(souls).values({ id, ...written, color: "violet", createdAt: now }).run();

    const put = (key: string, value: string) =>
      tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
    if (birth.profile) put(USER_PROFILE_SETTING_KEY, birth.profile);
    if (birth.voice) put(VOICE_SETTING_KEY, birth.voice);
    return id;
  });
}
