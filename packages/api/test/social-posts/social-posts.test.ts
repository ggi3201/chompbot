import { beforeEach, expect, test, vi } from "vitest";

const apns = vi.hoisted(() => ({
  sendAlertPush: vi.fn(async () => ({ ok: true })),
  sendSilentPush: vi.fn(async () => ({ ok: true })),
}));
const telegram = vi.hoisted(() => ({ sendTelegramMessage: vi.fn(async (): Promise<number | null> => 1) }));
vi.mock("../../src/lib/apns.js", () => apns);
vi.mock("../../src/telegram/bot.js", () => telegram);

import { db } from "../../src/db/index.js";
import { devicePushTokens, phoneCards, socialPosts } from "../../src/db/schema.js";
import { execScheduleSocialPost, markPosted } from "../../src/agents/tools/social-posts.js";
import { pingDueSocialPosts } from "../../src/social-posts/notifier.js";
import { listSocialPosts, saveSocialPost, socialPostSchema } from "../../src/social-posts/store.js";
import { socialPublishSkill } from "../../src/seed/social-publish.js";
import { MCP_TOOLS } from "../../src/mcp/tool-definitions.js";

const HOUR = 3_600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
const image = { url: "https://images.example/1.jpg", type: "image", altText: "A coat" };
const input = (dueAt: string) => ({
  title: "Colour trios",
  dueAt,
  platforms: [
    { platform: "instagram", caption: "Insta words", media: [image] },
    { platform: "tiktok", caption: "TikTok words", media: [image] },
  ],
});
const save = (dueAt: string) => saveSocialPost(socialPostSchema.parse(input(dueAt)))!;

beforeEach(() => {
  db.delete(socialPosts).run();
  db.delete(phoneCards).run();
  db.delete(devicePushTokens).run();
  db.insert(devicePushTokens).values({ deviceId: "phone", apnsToken: "token" }).run();
  vi.clearAllMocks();
  telegram.sendTelegramMessage.mockResolvedValue(1);
});

test("scheduling puts the alerts on a phone card and wakes the phone silently", async () => {
  const dueAt = inHours(5);
  const result = await execScheduleSocialPost(input(dueAt));
  expect(result).toContain("Scheduled post");
  const [card] = db.select().from(phoneCards).all();
  const [post] = listSocialPosts();
  expect(card.link).toBe(`chomp://post/${post.id}`);
  expect(card.alerts.map(({ at }) => at)).toEqual([dueAt, inHoursFrom(dueAt, 2)]);
  expect(apns.sendSilentPush).toHaveBeenCalledOnce();
  expect(apns.sendAlertPush).not.toHaveBeenCalled();
});

const inHoursFrom = (iso: string, hours: number) => new Date(new Date(iso).getTime() + hours * HOUR).toISOString();

test("a post due in the past still gets a card, so it can be opened and marked", async () => {
  expect(await execScheduleSocialPost(input(inHours(-48)))).toContain("Scheduled post");
  expect(db.select().from(phoneCards).all()).toHaveLength(1);
});

test("media must be something the phone can fetch, and a platform can appear once", () => {
  const bad = (url: string) => socialPostSchema.safeParse({ ...input(inHours(1)), platforms: [{ platform: "tiktok", caption: "x", media: [{ url, type: "image" }] }] }).success;
  expect(bad("/home/testuser/secret.jpg")).toBe(false);
  expect(bad("/api/uploads/../chomp.db")).toBe(false);
  expect(bad("/api/uploads/a-b_c.jpg")).toBe(true);
  const twice = { ...input(inHours(1)), platforms: [input("")["platforms"][0], input("")["platforms"][0]] };
  expect(socialPostSchema.safeParse(twice).success).toBe(false);
});

test("Telegram pings once at the due time, and only after a successful send", async () => {
  save(inHours(1));
  await pingDueSocialPosts();
  expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();

  const due = new Date(Date.now() + 2 * HOUR);
  telegram.sendTelegramMessage.mockResolvedValueOnce(null);
  await pingDueSocialPosts(due);
  await pingDueSocialPosts(due);
  await pingDueSocialPosts(due);
  expect(telegram.sendTelegramMessage).toHaveBeenCalledTimes(2);
  expect(telegram.sendTelegramMessage.mock.calls[1]).toEqual([expect.stringContaining("Time to post: Colour trios")]);
});

test("the nudge comes 2 hours after the ping and names only what is left", async () => {
  const post = save(inHours(-1));
  await pingDueSocialPosts();
  await markPosted(post.id, "instagram");
  await pingDueSocialPosts(new Date(Date.now() + 2 * HOUR));
  await pingDueSocialPosts(new Date(Date.now() + 3 * HOUR));
  const texts = telegram.sendTelegramMessage.mock.calls.map(([text]: unknown[]) => text as string);
  expect(texts).toHaveLength(2);
  expect(texts[1]).toContain("Still not posted");
  expect(texts[1]).toContain("TikTok");
  expect(texts[1]).not.toContain("Instagram");
});

test("marking every platform stops the pings and removes the card", async () => {
  await execScheduleSocialPost(input(inHours(-1)));
  const [post] = listSocialPosts();
  await markPosted(post.id, "instagram");
  expect(db.select().from(phoneCards).all()).toHaveLength(1);
  await markPosted(post.id, "tiktok");
  expect(db.select().from(phoneCards).all()).toHaveLength(0);
  await pingDueSocialPosts();
  expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
  expect(await markPosted(post.id, "pinterest")).toBeNull();
});

test("editing keeps posted platforms, and a new time pings again", async () => {
  const post = save(inHours(-1));
  await pingDueSocialPosts();
  await markPosted(post.id, "instagram");
  const later = inHours(-0.5);
  const edited = saveSocialPost(socialPostSchema.parse({ ...input(later), id: post.id }))!;
  expect(edited.platforms.find(({ platform }) => platform === "instagram")!.postedAt).not.toBeNull();
  expect(edited.notifiedAt).toBeNull();
  expect(saveSocialPost(socialPostSchema.parse({ ...input(later), id: "00000000-0000-4000-8000-000000000000" }))).toBeNull();
});

test("old finished posts drop off the list, old unposted ones stay", async () => {
  const finished = save(inHours(-24 * 30));
  await markPosted(finished.id, "instagram");
  await markPosted(finished.id, "tiktok");
  const forgotten = save(inHours(-24 * 30));
  expect(listSocialPosts().map(({ id }) => id)).toEqual([forgotten.id]);
});

test("the skill only names tools that exist", () => {
  const names = new Set(MCP_TOOLS.map((tool) => tool.name));
  const toolLike = [...socialPublishSkill().content.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
  expect(toolLike).toContain("schedule_social_post");
  expect(toolLike.filter((name) => !names.has(name))).toEqual([]);
});
