import type { BirthrightEvent } from "@chomp/shared";

/** What a finished soul has to cover. The interviewer reports these as it learns them. */
export const FACETS = [
  { key: "name", label: "Name" },
  { key: "voice", label: "Voice" },
  { key: "humor", label: "Humor" },
  { key: "pushback", label: "Pushback" },
  { key: "checking", label: "Checking" },
  { key: "asking", label: "Asking" },
  { key: "simplicity", label: "Simplicity" },
  { key: "limits", label: "Limits" },
  { key: "privacy", label: "Privacy" },
  { key: "person", label: "You" },
] as const;

const FACET_KEYS = new Set<string>(FACETS.map((f) => f.key));

export interface RiteMessage {
  from: "agent" | "person";
  text: string;
}

export interface SoulDraft {
  name: string;
  description: string;
  content: string;
  profile: string;
  writing: boolean;
}

export type RiteStatus = "arrival" | "returning" | "thinking" | "replying" | "waiting" | "born";

export interface RiteState {
  status: RiteStatus;
  sessionId: string | null;
  messages: RiteMessage[];
  facets: Record<string, string>;
  /** The spoken voice the person chose, once they have. */
  speaker: string | null;
  /** Two replies to choose between, when the agent is showing instead of asking. */
  choice: string[] | null;
  soul: SoulDraft | null;
  error: string | null;
}

export type RiteAction =
  | BirthrightEvent
  | { type: "begin" }
  | { type: "resume" }
  | { type: "say"; text: string }
  | { type: "failed"; message: string }
  | { type: "problem"; message: string }
  | { type: "speaker"; voice: string }
  | { type: "reset" }
  | { type: "born" };

export const ARRIVAL: RiteState = {
  status: "arrival",
  sessionId: null,
  messages: [],
  facets: {},
  speaker: null,
  choice: null,
  soul: null,
  error: null,
};

function appendReply(messages: RiteMessage[], delta: string): RiteMessage[] {
  const last = messages.at(-1);
  if (last?.from === "agent") return [...messages.slice(0, -1), { ...last, text: last.text + delta }];
  // The newlines around a control tag must not start a message of their own.
  return delta.trim() ? [...messages, { from: "agent", text: delta.trimStart() }] : messages;
}

function settleReply(messages: RiteMessage[]): RiteMessage[] {
  const last = messages.at(-1);
  return last?.from === "agent" ? [...messages.slice(0, -1), { ...last, text: last.text.trimEnd() }] : messages;
}

export function riteReducer(state: RiteState, action: RiteAction): RiteState {
  switch (action.type) {
    case "begin":
      return { ...ARRIVAL, status: "thinking" };
    case "resume":
      return { ...state, status: "waiting" };
    case "say":
      return { ...state, status: "thinking", error: null, choice: null, messages: [...state.messages, { from: "person", text: action.text }] };
    case "session":
      return { ...state, sessionId: action.id };
    case "text": {
      const messages = appendReply(state.messages, action.delta);
      return messages === state.messages ? state : { ...state, status: "replying", messages };
    }
    case "facet":
      return FACET_KEYS.has(action.key) && action.value
        ? { ...state, facets: { ...state.facets, [action.key]: action.value } }
        : state;
    case "choice":
      return action.options.length > 1 ? { ...state, choice: action.options } : state;
    case "soul_start":
      return { ...state, soul: { name: action.name, description: action.description, content: "", profile: "", writing: true } };
    case "soul_delta":
      return state.soul ? { ...state, soul: { ...state.soul, content: state.soul.content + action.delta } } : state;
    case "profile_delta":
      return state.soul ? { ...state, soul: { ...state.soul, profile: state.soul.profile + action.delta } } : state;
    case "soul_end":
    case "profile_end":
      return state;
    case "done":
      return {
        ...state,
        status: "waiting",
        messages: settleReply(state.messages),
        soul: state.soul && { ...state.soul, writing: false },
      };
    case "error":
    case "failed": {
      const last = state.messages.at(-1);
      // A question the agent never answered goes back to the composer, so nothing is lost.
      const messages = last?.from === "person" ? state.messages.slice(0, -1) : settleReply(state.messages);
      return {
        ...state,
        status: messages.length ? "waiting" : "arrival",
        messages,
        soul: state.soul && { ...state.soul, writing: false },
        error: action.message,
      };
    }
    case "problem":
      return { ...state, error: action.message };
    case "speaker":
      return { ...state, speaker: action.voice };
    case "born":
      return { ...state, status: "born", error: null };
    case "reset":
      return ARRIVAL;
  }
}

/** Reads one turn's server-sent events. Comment lines (the keepalive) carry no event. */
export async function* readTurnEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<BirthrightEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as BirthrightEvent;
    }
  }
}

/**
 * Splits text the agent is still writing into pieces worth speaking. Pieces keep their
 * trailing whitespace, so their lengths add up to the text the page types out.
 */
export function takeSpokenPieces(buffer: string, minLength: number): { pieces: string[]; rest: string } {
  const pieces: string[] = [];
  let piece = "";
  let start = 0;
  for (const match of buffer.matchAll(/[.!?…\n]+["'”’)\]]*\s+/g)) {
    const end = match.index + match[0].length;
    piece += buffer.slice(start, end);
    start = end;
    if (piece.length >= minLength) {
      pieces.push(piece);
      piece = "";
    }
  }
  return { pieces, rest: piece + buffer.slice(start) };
}
