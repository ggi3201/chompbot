import { resolve } from "path";

const UPLOADS_DIR = resolve(process.env.UPLOADS_DIR ?? "./data/uploads");

const CONTENT = `# Publishing to social media

The user publishes by hand, so they can pick the sound and post from the real app. Chomp gets everything ready on their phone. It does not post for them, and it uses no Buffer. Use this when the user wants a post scheduled, or when a reel or slideshow is finished and ready to go out.

## Tools

- \`schedule_social_post\`: schedules a post. Passing \`id\` replaces that post.
- \`list_social_posts\`: shows what is scheduled and what is posted. Check it first, so you do not double-book a day.
- \`remove_social_post\`: cancels a post and its alerts.

## What happens

1. The Chomp app downloads the media in the background when it can, and otherwise when the post is opened.
2. At \`dueAt\` the user gets a phone alert and a Telegram message. Both open the post in the app.
3. There, one button per platform saves the media to Photos, copies the caption and opens the platform's app. The user picks a sound, posts, and taps Mark posted.
4. If a platform is still unposted after 2 hours, the phone and Telegram nudge once more.

## Writing a post

- Give each platform its own entry: captions and crops differ. Instagram feed slides are 1080x1350, TikTok 1080x1920.
- Write alt text for every image. The user pastes it by hand in Instagram's advanced settings, so describe what matters and keep it short.
- Say so in the caption when images are AI-generated. Instagram and TikTok have their own AI label too, which the user sets when posting, so remind them.
- Do not pick a sound in the caption. That is the point of posting by hand, but you may suggest one in your reply.

## Media

Each \`url\` must be reachable from the phone: a direct https file URL, or \`/api/uploads/<file>\` after copying the file to \`${UPLOADS_DIR}/\`. That path has no auth, so use an unguessable name for anything not yet public.

Always tell the user the post's title, time and platforms, so they can catch a wrong one.`;

export function socialPublishSkill() {
  return {
    name: "social-publish",
    description: "Schedule posts the user publishes by hand on Instagram, TikTok or Pinterest: media on their phone, alert at the time, caption and alt text ready. Use for 'schedule this post', 'post this', or when a reel or slideshow is ready to go out.",
    content: CONTENT,
  };
}
