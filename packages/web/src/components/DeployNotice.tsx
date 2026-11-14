import { useEffect, useState } from "react";
import { X } from "lucide-react";
import Button from "./ui/Button";
import { useIsMobile } from "../hooks/useIsMobile";

type Build = { sha: string; subject: string };

// Module-level so a Layout remount doesn't mistake new server code for what this page loaded.
let loadedSha: string | undefined;

// Shows a bar when the server runs a newer commit than the one this page was loaded with.
export default function DeployNotice() {
  const isMobile = useIsMobile();
  const [fresh, setFresh] = useState<Build | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const build: Build | null = (await (await fetch("/api/health", { cache: "no-store" })).json()).build;
        if (!build) return;
        loadedSha ??= build.sha;
        setFresh(build.sha === loadedSha ? null : build);
      } catch {
        // Mid-deploy the server is down; the next check picks it up.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    void check();
    const timer = setInterval(check, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!fresh || fresh.sha === dismissed) return null;

  return (
    <div
      role="status"
      className="fixed left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 max-w-[calc(100vw-1.5rem)] pl-4 pr-2 py-2 rounded-lg bg-surface-alt border border-border shadow-lg text-[13px]"
      style={{ top: isMobile ? "calc(3.5rem + var(--safe-top))" : "0.75rem" }}
    >
      <span className="min-w-0 truncate">
        <span className="font-medium text-text-primary">New version deployed</span>
        <span className="text-text-muted"> · {fresh.subject}</span>
      </span>
      <Button variant="primary" size="sm" className="shrink-0" onClick={() => window.location.reload()}>
        Reload
      </Button>
      <button
        aria-label="Dismiss"
        onClick={() => setDismissed(fresh.sha)}
        className="shrink-0 p-1 rounded-md text-text-muted bg-transparent border-none cursor-pointer"
      >
        <X size={16} />
      </button>
    </div>
  );
}
