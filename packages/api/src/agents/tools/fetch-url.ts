/**
 * URL content fetcher — extracts readable text from web pages.
 */

const MAX_CONTENT_LENGTH = 8_000;
const DEFAULT_TIMEOUT_MS = 10_000;

const BLOCKED_TAGS = /< *(script|style|nav|header|footer|aside|noscript|svg|iframe)[^>]*>[\s\S]*?< *\/ *\1 *>/gi;
const ALL_TAGS = /<[^>]+>/g;

/** Block fetching internal/private IPs */
function isPrivateUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.0\.0\.0|::1|\[::1\])/.test(host);
  } catch {
    return true;
  }
}

export async function execFetchUrl(url: string, timeoutMs?: number): Promise<string> {
  // Validate URL
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return "ERROR: Only http:// and https:// URLs are supported.";
  }

  if (isPrivateUrl(url)) {
    return "ERROR: Fetching internal/private URLs is not allowed.";
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Chomp/1.0; +https://chomp.ai)",
        "Accept": "text/html,text/plain,application/xhtml+xml",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      return `ERROR: HTTP ${res.status} ${res.statusText}`;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
      return `ERROR: Unsupported content type: ${contentType}. Only HTML and plain text are supported.`;
    }

    let html = await res.text();

    // Strip blocked tags and their content
    html = html.replace(BLOCKED_TAGS, " ");
    // Strip remaining HTML tags
    html = html.replace(ALL_TAGS, " ");
    // Decode common HTML entities
    html = html
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");
    // Collapse whitespace
    html = html.replace(/\s+/g, " ").trim();

    if (!html) {
      return "ERROR: Page returned no readable text content.";
    }

    if (html.length > MAX_CONTENT_LENGTH) {
      return html.slice(0, MAX_CONTENT_LENGTH) + "\n\n[Truncated — showing first 8,000 characters]";
    }

    return html;
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return `ERROR: Fetch timed out after ${(timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s.`;
    }
    return `ERROR: Fetch failed: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}
