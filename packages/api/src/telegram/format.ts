/**
 * Convert markdown text to Telegram-compatible HTML.
 *
 * Handles: ```code blocks```, `inline code`, **bold**, *italic*, _italic_,
 * [links](url), and escapes HTML entities in everything else.
 *
 * This runs at the Telegram send boundary only — messages stay as markdown
 * everywhere else (web UI, DB, etc.).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(md: string): string {
  // 1. Extract fenced code blocks first (preserve content verbatim)
  const codeBlocks: string[] = [];
  let result = md.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // 2. Extract inline code (preserve content verbatim)
  const inlineCode: string[] = [];
  result = result.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // 3. Escape HTML in remaining text
  result = escapeHtml(result);

  // 4. Convert markdown formatting to HTML tags
  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* (but not inside words like file*name)
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "<i>$1</i>");

  // Italic: _text_ (but not in snake_case like file_name)
  result = result.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "<i>$1</i>");

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 5. Restore code blocks and inline code
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) => codeBlocks[Number(idx)]);
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_m, idx) => inlineCode[Number(idx)]);

  return result;
}
