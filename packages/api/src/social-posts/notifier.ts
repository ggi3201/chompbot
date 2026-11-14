import { sendTelegramMessage } from "../telegram/bot.js";
import { postsToNotify, postsToNudge, recordPing, type SocialPost } from "./store.js";

const NAMES = { instagram: "Instagram", tiktok: "TikTok", pinterest: "Pinterest" };

function message(post: SocialPost, heading: string): string {
  const domain = process.env.CHOMP_DOMAIN ?? `http://localhost:${process.env.PORT ?? "3001"}`;
  const left = post.platforms.filter(({ postedAt }) => postedAt === null).map(({ platform }) => NAMES[platform]);
  return `**${heading}: ${post.title}**\n${left.join(", ")}\n[Open in Chomp](${domain}/api/social-post-link/${post.id})`;
}

/** A failed send is not recorded, so the next sweep tries again. */
export async function pingDueSocialPosts(now = new Date()) {
  for (const post of postsToNotify(now)) {
    if (await sendTelegramMessage(message(post, "Time to post"))) recordPing(post.id, "notifiedAt");
  }
  for (const post of postsToNudge(now)) {
    if (await sendTelegramMessage(message(post, "Still not posted"))) recordPing(post.id, "nudgedAt");
  }
}

export function startSocialPostNotifier() {
  setInterval(() => {
    pingDueSocialPosts().catch((err) => console.error("[social-posts] ping failed:", err));
  }, 60_000);
}
