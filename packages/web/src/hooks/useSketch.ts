import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import type { SketchMark } from "../lib/sketch-finish";

export interface Sketch {
  id: string;
  title: string;
  reference: string | null;
  note: string | null;
  turn: "user" | "agent";
  strokes: SketchMark[];
}

const POLL_MS = 1500;

/** A shared sheet from the server. `live` keeps it fresh while the agent has the pen. */
export function useSketch(id: string, live: boolean) {
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pen strokes save in order, and a reply must not overwrite marks the server has yet to see.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);

  const save = useCallback(
    (path: string, method: string, body?: unknown) => {
      pending.current++;
      const run = queue.current.then(async () => {
        const res = await apiFetch(`/sketches/${id}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not save the sheet");
        setError(null);
        if (pending.current === 1) setSketch(data);
      });
      queue.current = run
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : "Could not save the sheet");
        })
        .finally(() => {
          pending.current--;
        });
      return queue.current;
    },
    [id],
  );

  const refresh = useCallback(async () => {
    const res = await apiFetch(`/sketches/${id}`);
    if (!res.ok) {
      setError("This sheet is gone");
      return;
    }
    const data = await res.json();
    if (pending.current === 0) setSketch(data);
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const waiting = live && sketch?.turn === "agent";
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, refresh]);

  const addStroke = (stroke: Pick<SketchMark, "d" | "color" | "width">) => {
    setSketch((s) => s && { ...s, strokes: [...s.strokes, { ...stroke, author: "user" }] });
    save("/strokes", "POST", { strokes: [stroke] });
  };

  const undo = () => {
    setSketch((s) => {
      if (!s) return s;
      const last = s.strokes.map((m) => m.author).lastIndexOf("user");
      return last === -1 ? s : { ...s, strokes: s.strokes.filter((_, i) => i !== last) };
    });
    save("/strokes/last", "DELETE");
  };

  const setTurn = (turn: Sketch["turn"]) => {
    setSketch((s) => s && { ...s, turn });
    return save("", "PATCH", { turn });
  };

  const setReference = (reference: string | null) => {
    setSketch((s) => s && { ...s, reference });
    return save("", "PATCH", { reference });
  };

  return { sketch, error, addStroke, undo, setTurn, setReference };
}

/** Stores an image for the sheet to sit on. Returns its upload URL. */
export async function uploadImage(blob: Blob, name: string): Promise<string> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });
  const res = await apiFetch("/uploads", { method: "POST", body: JSON.stringify({ data, mimeType: blob.type, name }) });
  if (!res.ok) throw new Error("Could not upload the image");
  return (await res.json()).url;
}
