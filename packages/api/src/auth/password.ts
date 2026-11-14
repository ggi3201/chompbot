import bcrypt from "bcrypt";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";

const SALT_ROUNDS = 12;

export async function isSetup(): Promise<boolean> {
  const result = db.select().from(settings).where(eq(settings.key, "password_hash")).get();
  return !!result;
}

export async function setupPassword(password: string): Promise<void> {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  db.insert(settings).values({ key: "password_hash", value: hash }).run();
}

export async function verifyPassword(password: string): Promise<boolean> {
  const result = db.select().from(settings).where(eq(settings.key, "password_hash")).get();
  if (!result) return false;
  return bcrypt.compare(password, result.value);
}
