import { useCallback, useEffect, useState } from "react";
import type { TerminalInfo, TerminalScope } from "@chomp/shared";
import { apiFetch } from "../lib/api";
import { isTouch } from "./useIsMobile";
import { FONT_SIZES } from "../lib/terminal/theme";

const FONT_SIZE_KEY = "chomp.terminal.fontSize";

async function errorOf(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? `The host answered ${res.status}.`);
}

function query(scope?: TerminalScope): string {
  if (!scope) return "";
  return `?${new URLSearchParams(scope.scope === "home" ? { scope: "home" } : { scope: "chat", conversationId: scope.conversationId })}`;
}

export async function createTerminal(scope: TerminalScope, size?: { cols: number; rows: number }): Promise<TerminalInfo> {
  const res = await apiFetch("/terminals", { method: "POST", body: JSON.stringify({ ...scope, ...size }) });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as TerminalInfo;
}

export async function endTerminal(id: string): Promise<void> {
  const res = await apiFetch(`/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await errorOf(res);
}

/** The shells running on the host, all of them or one scope's; null until the first answer. */
export function useTerminals(scope?: TerminalScope) {
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null);
  const key = query(scope);
  const refresh = useCallback(async () => {
    const res = await apiFetch(`/terminals${key}`);
    if (!res.ok) throw await errorOf(res);
    const list = (await res.json()) as TerminalInfo[];
    setTerminals(list);
    return list;
  }, [key]);

  useEffect(() => {
    refresh().catch(() => setTerminals([]));
    const onFocus = () => void refresh().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { terminals, refresh };
}

/** One size for every terminal on this device, kept across visits. */
export function useTerminalFontSize() {
  const [fontSize, setFontSize] = useState(() => Number(window.localStorage.getItem(FONT_SIZE_KEY)) || (isTouch ? FONT_SIZES.phone : FONT_SIZES.desktop));
  const change = (step: number) => {
    const next = Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, fontSize + step));
    window.localStorage.setItem(FONT_SIZE_KEY, String(next));
    setFontSize(next);
  };
  return { fontSize, smaller: () => change(-1), larger: () => change(1), canShrink: fontSize > FONT_SIZES.min, canGrow: fontSize < FONT_SIZES.max };
}

const opening = new Map<string, Promise<TerminalInfo>>();

/** The scope's latest shell, or a new one. Calls at the same time share one answer, so a double mount opens one shell. */
export function openLatestTerminal(scope: TerminalScope): Promise<TerminalInfo> {
  const key = query(scope);
  const pending =
    opening.get(key) ??
    (async () => {
      const res = await apiFetch(`/terminals${key}`);
      if (!res.ok) throw await errorOf(res);
      const list = (await res.json()) as TerminalInfo[];
      return list.at(-1) ?? (await createTerminal(scope));
    })().finally(() => opening.delete(key));
  opening.set(key, pending);
  return pending;
}
