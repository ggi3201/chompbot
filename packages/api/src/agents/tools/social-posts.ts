import { publishPhoneCards, publishSchema, removePhoneCards } from "../../phone-cards/store.js";
import {
  isFinished,
  listSocialPosts,
  markSocialPostPosted,
  nudgeTime,
  removeSocialPost,
  saveSocialPost,
  socialPostSchema,
  type SocialPlatform,
  type SocialPost,
} from "../../social-posts/store.js";
import { tellPhones } from "./phone-cards.js";

const DAY_MS = 86_400_000;
const NAMES = { instagram: "Instagram", tiktok: "TikTok", pinterest: "Pinterest" };

const cardGroup = (id: string) => `social-${id}`;

/** The widget card carries the phone's alerts, which fire with no network. */
function publishCard(post: SocialPost) {
  const due = new Date(post.dueAt).getTime();
  publishPhoneCards(publishSchema.parse({
    group: cardGroup(post.id),
    cards: [{
      showFrom: new Date(due - 3_600_000).toISOString(),
      showUntil: new Date(Math.max(due, Date.now()) + DAY_MS).toISOString(),
      headline: `Post: ${post.title}`.slice(0, 48).trim(),
      detail: post.platforms.map(({ platform }) => NAMES[platform]).join(", "),
      icon: "paperplane",
      alerts: [
        { at: post.dueAt, text: "Time to post" },
        { at: nudgeTime(post.dueAt), text: "Still not posted" },
      ],
      link: `chomp://post/${post.id}`,
    }],
  }));
}

export async function execScheduleSocialPost(args: Record<string, unknown>): Promise<string> {
  const parsed = socialPostSchema.safeParse(args);
  if (!parsed.success) {
    return `ERROR: Invalid post: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  }
  const post = saveSocialPost(parsed.data);
  if (!post) return `ERROR: No social post with id ${parsed.data.id}.`;

  publishCard(post);
  const failure = await tellPhones(null);
  const reached = failure ? ` The phone was not reached (${failure}), so it downloads the media when the app next opens.` : "";
  return `Scheduled post ${post.id} for ${post.dueAt}.${reached}`;
}

export function execListSocialPosts(): string {
  return JSON.stringify(listSocialPosts(), null, 2);
}

export async function execRemoveSocialPost(args: { id?: unknown }): Promise<string> {
  if (typeof args.id !== "string" || !removeSocialPost(args.id)) return `ERROR: No social post with id ${String(args.id)}.`;
  removePhoneCards(cardGroup(args.id));
  await tellPhones(null);
  return `Removed post ${args.id}.`;
}

/** Marks one platform posted. The alerts stop only when every platform is done. */
export async function markPosted(id: string, platform: SocialPlatform): Promise<SocialPost | null> {
  const post = markSocialPostPosted(id, platform);
  if (post && isFinished(post) && removePhoneCards(cardGroup(id)) > 0) await tellPhones(null);
  return post;
}
