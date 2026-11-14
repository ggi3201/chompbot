import { randomUUID } from "crypto";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { socialPosts } from "../db/schema.js";

const NUDGE_AFTER_MS = 2 * 3_600_000;
const HISTORY_MS = 14 * 86_400_000;

const mediaSchema = z.object({
  url: z.string().refine((url) => /^https?:\/\/\S+$/.test(url) || /^\/api\/uploads\/[\w.-]+$/.test(url), {
    message: "must be an http(s) URL or an /api/uploads/<file> path",
  }),
  type: z.enum(["image", "video"]),
  altText: z.string().trim().min(1).optional(),
});

export const socialPostSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(80),
  dueAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  platforms: z.array(z.object({
    platform: z.enum(["instagram", "tiktok", "pinterest"]),
    caption: z.string().trim().min(1),
    media: z.array(mediaSchema).min(1),
  })).min(1).refine((platforms) => new Set(platforms.map(({ platform }) => platform)).size === platforms.length, {
    message: "each platform can appear once",
  }),
});

export type SocialPost = typeof socialPosts.$inferSelect;
export type SocialPlatform = SocialPost["platforms"][number]["platform"];

export const isFinished = (post: SocialPost) => post.platforms.every(({ postedAt }) => postedAt !== null);

export function getSocialPost(id: string): SocialPost | null {
  return db.select().from(socialPosts).where(eq(socialPosts.id, id)).get() ?? null;
}

/** Creates or replaces a post, or returns null for an unknown id. A new time pings again; posted platforms stay posted. */
export function saveSocialPost({ id, title, dueAt, platforms }: z.infer<typeof socialPostSchema>): SocialPost | null {
  const previous = id ? getSocialPost(id) : null;
  if (id && !previous) return null;

  const posted = new Map(previous?.platforms.map(({ platform, postedAt }) => [platform, postedAt]));
  const moved = previous?.dueAt !== dueAt;
  const post: SocialPost = {
    id: previous?.id ?? randomUUID(),
    title,
    dueAt,
    platforms: platforms.map((entry) => ({ ...entry, postedAt: posted.get(entry.platform) ?? null })),
    notifiedAt: moved ? null : previous?.notifiedAt ?? null,
    nudgedAt: moved ? null : previous?.nudgedAt ?? null,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  db.insert(socialPosts).values(post).onConflictDoUpdate({ target: socialPosts.id, set: post }).run();
  return post;
}

export function markSocialPostPosted(id: string, platform: SocialPlatform): SocialPost | null {
  const post = getSocialPost(id);
  const entry = post?.platforms.find((candidate) => candidate.platform === platform);
  if (!post || !entry) return null;
  entry.postedAt ??= new Date().toISOString();
  db.update(socialPosts).set({ platforms: post.platforms }).where(eq(socialPosts.id, id)).run();
  return post;
}

export function removeSocialPost(id: string): boolean {
  return db.delete(socialPosts).where(eq(socialPosts.id, id)).run().changes > 0;
}

const hasUnposted = sql`EXISTS (SELECT 1 FROM json_each(${socialPosts.platforms}) WHERE json_extract(value, '$.postedAt') IS NULL)`;

/** Everything still unposted, plus recent history. */
export function listSocialPosts(): SocialPost[] {
  const since = new Date(Date.now() - HISTORY_MS).toISOString();
  return db.select().from(socialPosts).where(or(gt(socialPosts.dueAt, since), hasUnposted)).orderBy(asc(socialPosts.dueAt)).all();
}

/** Unposted posts whose Telegram ping is due. */
export function postsToNotify(now = new Date()): SocialPost[] {
  return db.select().from(socialPosts)
    .where(and(isNull(socialPosts.notifiedAt), lte(socialPosts.dueAt, now.toISOString()), hasUnposted))
    .all();
}

/** Unposted posts that already got their ping and have sat for long enough to nudge. */
export function postsToNudge(now = new Date()): SocialPost[] {
  return db.select().from(socialPosts)
    .where(and(
      isNull(socialPosts.nudgedAt),
      sql`${socialPosts.notifiedAt} IS NOT NULL`,
      lte(socialPosts.dueAt, new Date(now.getTime() - NUDGE_AFTER_MS).toISOString()),
      hasUnposted,
    ))
    .all();
}

export function recordPing(id: string, column: "notifiedAt" | "nudgedAt") {
  db.update(socialPosts).set({ [column]: new Date().toISOString() }).where(eq(socialPosts.id, id)).run();
}

export const nudgeTime = (dueAt: string) => new Date(new Date(dueAt).getTime() + NUDGE_AFTER_MS).toISOString();
