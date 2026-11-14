import type { BirthrightControlEvent } from "@chomp/shared";

type Tag = "facet" | "choice" | "soul" | "user_profile";

const TAGS: Tag[] = ["facet", "choice", "soul", "user_profile"];
const OPENERS = TAGS.map((tag) => `<${tag}`);

/** Length of the longest suffix of `text` that could still grow into `word`. */
function heldBack(text: string, word: string): number {
  for (let n = Math.min(text.length, word.length - 1); n > 0; n--) {
    if (word.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

function optionsIn(body: string): string[] {
  return [...body.matchAll(/<option>([\s\S]*?)<\/option>/g)].map((m) => m[1].trim()).filter(Boolean);
}

function attributes(openTag: string): Record<string, string> {
  return Object.fromEntries([...openTag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

/**
 * Splits the interviewer's streamed reply into what the person reads and the control
 * tags the UI acts on. Chunks may cut a tag anywhere, so anything that could still
 * become a tag waits in the buffer until the next chunk settles it.
 */
export class ControlTagParser {
  private buffer = "";
  private open: { tag: Tag; attrs: Record<string, string> } | null = null;
  /** Tags the page only acts on once they are complete. */
  private heldBody = "";

  push(chunk: string): BirthrightControlEvent[] {
    this.buffer += chunk;
    const events: BirthrightControlEvent[] = [];
    while (this.buffer && (this.open ? this.readBody(events) : this.readText(events)));
    return events;
  }

  /** Call when the stream ends. A cut-off soul still closes, so the UI never waits forever. */
  flush(): BirthrightControlEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const open = this.open;
    this.open = null;
    if (!open) return rest ? [{ type: "text", delta: rest }] : [];
    if (open.tag === "facet" || open.tag === "choice") return [];
    const deltaType = open.tag === "soul" ? "soul_delta" : "profile_delta";
    const endType = open.tag === "soul" ? "soul_end" : "profile_end";
    return [...(rest ? [{ type: deltaType, delta: rest } as BirthrightControlEvent] : []), { type: endType } as BirthrightControlEvent];
  }

  private readText(events: BirthrightControlEvent[]): boolean {
    const start = this.buffer.indexOf("<");
    if (start === -1) {
      events.push({ type: "text", delta: this.buffer });
      this.buffer = "";
      return false;
    }
    if (start > 0) {
      events.push({ type: "text", delta: this.buffer.slice(0, start) });
      this.buffer = this.buffer.slice(start);
    }

    const opener = OPENERS.find((o) => this.buffer.startsWith(o));
    if (!opener) {
      if (OPENERS.some((o) => o.startsWith(this.buffer))) return false;
      events.push({ type: "text", delta: "<" });
      this.buffer = this.buffer.slice(1);
      return true;
    }

    const next = this.buffer[opener.length];
    if (next === undefined) return false;
    if (next !== " " && next !== ">") {
      events.push({ type: "text", delta: "<" });
      this.buffer = this.buffer.slice(1);
      return true;
    }

    const end = this.buffer.indexOf(">");
    if (end === -1) return false;
    const attrs = attributes(this.buffer.slice(0, end));
    this.buffer = this.buffer.slice(end + 1);
    this.open = { tag: opener.slice(1) as Tag, attrs };
    this.heldBody = "";
    if (this.open.tag === "soul") {
      events.push({ type: "soul_start", name: attrs.name ?? "", description: attrs.description ?? "" });
    }
    return true;
  }

  private readBody(events: BirthrightControlEvent[]): boolean {
    const { tag, attrs } = this.open!;
    const closer = `</${tag}>`;
    const end = this.buffer.indexOf(closer);
    const body = end === -1
      ? this.buffer.slice(0, this.buffer.length - heldBack(this.buffer, closer))
      : this.buffer.slice(0, end);

    if (tag === "facet" || tag === "choice") this.heldBody += body;
    else if (body) events.push({ type: tag === "soul" ? "soul_delta" : "profile_delta", delta: body });

    if (end === -1) {
      this.buffer = this.buffer.slice(body.length);
      return false;
    }

    this.buffer = this.buffer.slice(end + closer.length);
    this.open = null;
    if (tag === "facet") events.push({ type: "facet", key: attrs.key ?? "", value: this.heldBody.trim() });
    else if (tag === "choice") events.push({ type: "choice", options: optionsIn(this.heldBody) });
    else events.push({ type: tag === "soul" ? "soul_end" : "profile_end" });
    return true;
  }
}
