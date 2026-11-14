import { useCallback, useEffect, useReducer, useRef } from "react";
import { apiFetch } from "../lib/api";
import type { BirthrightBirth } from "@chomp/shared";
import { ARRIVAL, readTurnEvents, riteReducer, type RiteState, type SoulDraft } from "../lib/birthright";

const STORAGE_KEY = "chomp_birthright_rite_v2";

function restoreRite(): RiteState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as RiteState | null;
    return saved?.messages.length ? { ...ARRIVAL, ...saved, status: "returning", error: null } : ARRIVAL;
  } catch {
    return ARRIVAL;
  }
}

interface ReplyListener {
  beginReply: () => void;
  feed: (delta: string) => void;
  endReply: () => void;
}

export function useBirthright({ beginReply, feed, endReply }: ReplyListener) {
  const [state, dispatch] = useReducer(riteReducer, undefined, restoreRite);
  const sessionId = useRef(state.sessionId);
  const turnInFlight = useRef<AbortController | null>(null);

  const settled = state.status === "waiting" || state.status === "arrival";
  useEffect(() => {
    if (state.status === "born" || !state.messages.length) localStorage.removeItem(STORAGE_KEY);
    else if (settled) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [settled, state]);

  // Leaving mid-answer stops the agent too.
  useEffect(() => () => turnInFlight.current?.abort(), []);

  const runTurn = useCallback(async (body: { sessionId?: string; message?: string }): Promise<boolean> => {
    const controller = new AbortController();
    turnInFlight.current = controller;
    beginReply();
    try {
      const res = await apiFetch("/birthright/turn", { method: "POST", body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`The agent could not answer (${res.status})`);
      let answered = false;
      for await (const event of readTurnEvents(res.body)) {
        if (event.type === "session") sessionId.current = event.id;
        if (event.type === "text") feed(event.delta);
        // Someone listening can't see the two options, so they hear them too.
        if (event.type === "choice") feed(`First: ${event.options[0]}\nOr: ${event.options[1]}\n`);
        if (event.type === "error") {
          dispatch(event);
          return false;
        }
        answered ||= event.type === "done";
        dispatch(event);
      }
      if (!answered) throw new Error("The connection dropped before the agent finished");
      return true;
    } catch (err) {
      if (controller.signal.aborted) return false;
      dispatch({ type: "failed", message: err instanceof Error ? err.message : "The agent could not answer" });
      return false;
    } finally {
      endReply();
    }
  }, [beginReply, feed, endReply]);

  const begin = useCallback(() => {
    sessionId.current = null;
    dispatch({ type: "begin" });
    return runTurn({});
  }, [runTurn]);

  const say = useCallback((text: string) => {
    dispatch({ type: "say", text });
    return runTurn({ sessionId: sessionId.current ?? undefined, message: text });
  }, [runTurn]);

  const chooseSpeaker = useCallback((voice: string) => {
    dispatch({ type: "speaker", voice });
    return say(`I picked ${voice[0].toUpperCase()}${voice.slice(1)} for your voice.`);
  }, [say]);

  const reset = useCallback(() => {
    turnInFlight.current?.abort();
    sessionId.current = null;
    dispatch({ type: "reset" });
  }, []);

  const resume = useCallback(() => dispatch({ type: "resume" }), []);

  const showProblem = useCallback((message: string) => dispatch({ type: "problem", message }), []);

  /** Replaces the one default soul, user.md and the spoken voice. Nothing outside the rite changes before this. */
  const giveLife = useCallback(async (soul: SoulDraft, speaker: string | null) => {
    const birth: BirthrightBirth = {
      name: soul.name,
      description: soul.description,
      content: soul.content.trim(),
      ...(soul.profile.trim() ? { profile: soul.profile.trim() } : {}),
      ...(speaker ? { voice: speaker } : {}),
    };
    const res = await apiFetch("/birthright/birth", { method: "POST", body: JSON.stringify(birth) });
    if (!res.ok) throw new Error(`Could not save the soul (${res.status})`);
    dispatch({ type: "born" });
  }, []);

  return { state, begin, resume, say, chooseSpeaker, reset, giveLife, showProblem };
}
