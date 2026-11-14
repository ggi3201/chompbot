import { db } from "../../db/index.js";
import { chatItems, conversations } from "../../db/schema.js";
import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import type { ChatItem, ChatItemBody } from "@chomp/shared";

type ItemListener = (item: ChatItem) => void;
const listeners: ItemListener[] = [];

/** Subscribe to every persisted item update (the WebSocket layer fans them out). */
export function onChatItem(listener: ItemListener) {
  listeners.push(listener);
}

const lastSeq = new Map<string, number>();

function nextSeq(conversationId: string): number {
  let seq = lastSeq.get(conversationId);
  if (seq === undefined) {
    seq = db.select({ seq: max(chatItems.seq) }).from(chatItems).where(eq(chatItems.conversationId, conversationId)).get()?.seq ?? 0;
  }
  seq += 1;
  lastSeq.set(conversationId, seq);
  return seq;
}

function rowToItem(row: typeof chatItems.$inferSelect): ChatItem {
  return {
    ...(JSON.parse(row.payload) as ChatItemBody),
    id: row.id,
    conversationId: row.conversationId,
    turnId: row.turnId,
    seq: row.seq,
    ...(row.parentId ? { parentId: row.parentId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listChatItems(conversationId: string, afterSeq = 0): ChatItem[] {
  return db
    .select()
    .from(chatItems)
    .where(and(eq(chatItems.conversationId, conversationId), gt(chatItems.seq, afterSeq)))
    .orderBy(asc(chatItems.seq))
    .all()
    .map(rowToItem);
}

/** A subagent row with no session behind it: nothing will ever report how it ended. */
export function orphanedSubagentPayload(payload: string): string {
  const body = JSON.parse(payload) as ChatItemBody;
  return "status" in body && body.status === "running" ? JSON.stringify({ ...body, status: "stopped" }) : payload;
}

/** A clean shutdown closes running subagents itself; a crash leaves their rows running forever. Call at startup. */
export function stopOrphanedSubagents() {
  const orphans = db.select().from(chatItems).where(and(eq(chatItems.kind, "subagent"), sql`json_extract(${chatItems.payload}, '$.status') = 'running'`)).all();
  for (const row of orphans) {
    db.update(chatItems)
      .set({ payload: orphanedSubagentPayload(row.payload), seq: nextSeq(row.conversationId), updatedAt: new Date().toISOString() })
      .where(eq(chatItems.id, row.id))
      .run();
  }
}

/** Streaming text arrives a token at a time; writing and broadcasting each one
 *  would be a SQLite write per token. Updates inside this window coalesce. */
const FLUSH_MS = 80;

interface PendingItem {
  body: ChatItemBody;
  parentId?: string;
  createdAt: string;
}

/**
 * The items of one agent turn. Runners describe what happened with `set` /
 * `patch`; this batches the writes, stamps a fresh `seq` on every change and
 * notifies listeners. Native ids are namespaced by turn so they can never
 * collide across conversations.
 */
export class TurnItems {
  private readonly bodies = new Map<string, PendingItem>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly conversationId: string, readonly turnId: string) {}

  private key(nativeId: string): string {
    return `${this.turnId}:${nativeId}`;
  }

  get(nativeId: string): ChatItemBody | undefined {
    return this.bodies.get(this.key(nativeId))?.body;
  }

  has(nativeId: string): boolean {
    return this.bodies.has(this.key(nativeId));
  }

  /** `parentId` is the native id of the subagent item this one belongs to. */
  set(nativeId: string, body: ChatItemBody, options?: { parentId?: string; immediate?: boolean }) {
    const id = this.key(nativeId);
    const existing = this.bodies.get(id);
    this.bodies.set(id, {
      body,
      parentId: options?.parentId ? this.key(options.parentId) : existing?.parentId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
    this.dirty.add(id);
    if (options?.immediate) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Merge fields into an existing item of the same kind. No-op for unknown ids. */
  patch<K extends ChatItemBody["kind"]>(nativeId: string, kind: K, fields: Partial<Extract<ChatItemBody, { kind: K }>>, options?: { immediate?: boolean }) {
    const current = this.get(nativeId);
    if (!current || current.kind !== kind) return;
    this.set(nativeId, { ...current, ...fields } as ChatItemBody, options);
  }

  /** Append streamed text to an assistant_text / reasoning item, creating it on the first delta. */
  appendText(nativeId: string, kind: "assistant_text" | "reasoning", delta: string, options?: { parentId?: string }) {
    const current = this.get(nativeId);
    const text = current && current.kind === kind ? current.text + delta : delta;
    this.set(nativeId, { kind, text, streaming: true }, options);
  }

  /** Every item still marked running/streaming — used to close them out when a turn ends abruptly. */
  openIds(): string[] {
    const open: string[] = [];
    for (const [id, { body }] of this.bodies) {
      const running = "status" in body && body.status === "running";
      const streaming = "streaming" in body && body.streaming;
      const pending = body.kind === "approval" && body.state === "pending";
      if (running || streaming || pending) open.push(id.slice(this.turnId.length + 1));
    }
    return open;
  }

  /**
   * Mark everything still open as finished; `failed` turns running tools into
   * failures. Subagents in `outliving` run on past the turn, and so do their calls.
   */
  settle(outcome: "completed" | "failed", outliving: string[] = []) {
    const kept = new Set(outliving.map((nativeId) => this.key(nativeId)));
    for (const nativeId of this.openIds()) {
      const { body, parentId } = this.bodies.get(this.key(nativeId))!;
      if (kept.has(this.key(nativeId)) || (parentId && kept.has(parentId))) continue;
      if (body.kind === "approval") this.set(nativeId, { ...body, state: "expired" });
      else if (body.kind === "subagent") this.set(nativeId, { ...body, status: "stopped" });
      else if ("streaming" in body) this.set(nativeId, { ...body, streaming: false });
      else if ("status" in body) this.set(nativeId, { ...body, status: outcome } as ChatItemBody);
    }
    this.flush();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty.size === 0) return;
    const now = new Date().toISOString();
    const written: ChatItem[] = [];
    try {
      db.transaction((tx) => {
        for (const id of this.dirty) {
          const { body, parentId, createdAt } = this.bodies.get(id)!;
          const seq = nextSeq(this.conversationId);
          const payload = JSON.stringify(body);
          tx.insert(chatItems)
            .values({ id, conversationId: this.conversationId, turnId: this.turnId, seq, kind: body.kind, payload, parentId, createdAt, updatedAt: now })
            .onConflictDoUpdate({ target: chatItems.id, set: { seq, kind: body.kind, payload, updatedAt: now } })
            .run();
          written.push({ ...body, id, conversationId: this.conversationId, turnId: this.turnId, seq, ...(parentId ? { parentId } : {}), createdAt, updatedAt: now });
        }
      });
    } catch (err) {
      // The chat was deleted while its agent ran, so there is nowhere left to write. From the timer, a throw would take the API down.
      if (db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, this.conversationId)).get()) throw err;
      written.length = 0;
    }
    this.dirty.clear();
    for (const item of written) {
      for (const listener of listeners) listener(item);
    }
  }
}
