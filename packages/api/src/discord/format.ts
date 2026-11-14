/**
 * Format markdown text for Discord.
 *
 * Discord natively supports most markdown (bold, italic, code blocks, links),
 * so this is much simpler than the Telegram HTML converter.
 *
 * Main tasks:
 * - Truncate messages to Discord's 2000 character limit
 * - Split long messages into chunks at paragraph boundaries
 */

/** Discord's max message length in characters */
export const DISCORD_MAX_LENGTH = 2000;

/**
 * Split text into chunks that fit within Discord's character limit.
 * Splits at paragraph boundaries first, then line boundaries.
 */
export function chunkMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split(/\n\n+/)) {
    const sep = current ? "\n\n" : "";
    if ((current + sep + paragraph).length <= DISCORD_MAX_LENGTH) {
      current += sep + paragraph;
    } else {
      if (current) chunks.push(current);
      // Paragraph itself too long — split at line boundaries
      if (paragraph.length > DISCORD_MAX_LENGTH) {
        current = "";
        for (const line of paragraph.split("\n")) {
          const lineSep = current ? "\n" : "";
          if ((current + lineSep + line).length <= DISCORD_MAX_LENGTH) {
            current += lineSep + line;
          } else {
            if (current) chunks.push(current);
            // Single line longer than limit — hard cut
            current = line.length <= DISCORD_MAX_LENGTH ? line : line.slice(0, DISCORD_MAX_LENGTH);
          }
        }
      } else {
        current = paragraph;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
