// Canvas parser — detects :::canvas blocks in message content and splits
// into renderable segments (markdown text + canvas components).

export interface CanvasBlock {
  type: string;
  [key: string]: unknown;
}

export type MessageSegment =
  | { kind: "text"; content: string }
  | { kind: "canvas"; data: CanvasBlock };

const CANVAS_REGEX = /:::canvas\s*\n([\s\S]*?)\n:::/g;

/**
 * Parse message content into alternating text and canvas segments.
 * Text outside :::canvas fences is returned as markdown segments.
 * JSON inside fences is parsed into typed canvas blocks.
 */
export function parseCanvasContent(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(CANVAS_REGEX)) {
    const before = content.slice(lastIndex, match.index);
    if (before.trim()) {
      segments.push({ kind: "text", content: before });
    }

    try {
      const data = JSON.parse(match[1]) as CanvasBlock;
      if (data && typeof data.type === "string") {
        segments.push({ kind: "canvas", data });
      } else {
        // Invalid canvas block — render as text
        segments.push({ kind: "text", content: match[0] });
      }
    } catch {
      // JSON parse failed — render raw as text
      segments.push({ kind: "text", content: match[0] });
    }

    lastIndex = match.index! + match[0].length;
  }

  const after = content.slice(lastIndex);
  if (after.trim()) {
    segments.push({ kind: "text", content: after });
  }

  return segments;
}

/** Quick check — does this message contain any canvas blocks? */
export function hasCanvasContent(content: string): boolean {
  return /:::canvas\s*\n/.test(content);
}
