import { useCallback, useEffect, useState } from "react";
import type { CloneEvent, Project, RemoteRepoList } from "@chomp/shared";
import { apiFetch } from "../lib/api";

/** The git repos under ~/code on the host the agents run on. */
export function useProjects(): { projects: Project[]; refresh: () => Promise<void> } {
  const [projects, setProjects] = useState<Project[]>([]);
  const refresh = useCallback(async () => {
    const res = await apiFetch("/projects");
    if (res.ok) setProjects((await res.json()) as Project[]);
  }, []);
  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);
  return { projects, refresh };
}

/** The GitHub repos that are not cloned yet, read each time `enabled` turns on; null while loading. */
export function useRemoteRepos(enabled: boolean): RemoteRepoList | null {
  const [list, setList] = useState<RemoteRepoList | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setList(null);
    apiFetch("/projects/remote")
      .then(async (res) => (res.ok ? ((await res.json()) as RemoteRepoList) : { repos: [], unavailable: "Could not list GitHub repos." }))
      .then((value) => {
        if (!cancelled) setList(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return list;
}

/** Clones a repo into ~/code on the host, reporting git's progress lines as they stream in. */
export async function cloneProject(nameWithOwner: string, onProgress: (text: string) => void): Promise<Project> {
  const res = await apiFetch("/projects/clone", { method: "POST", body: JSON.stringify({ nameWithOwner }) });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Clone failed (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as CloneEvent;
      if (event.type === "progress") onProgress(event.text);
      else if (event.type === "done") return event.project;
      else throw new Error(event.error);
    }
  }
  throw new Error("The clone ended without an answer");
}
