import { useEffect, useState } from "react";
import type { AgentProvider } from "@chomp/shared";
import { apiFetch } from "../../lib/api";
import { ClaudeIcon, OpenAIIcon } from "../ProviderIcons";
import { UsageBar, useUsageLimits } from "../chat/UsageMeter";

interface Runtime {
  provider: AgentProvider;
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  loginCommand: string;
}

const NAMES: Record<AgentProvider, string> = { claude: "Claude Code", codex: "Codex" };

function Logo({ provider }: { provider: AgentProvider }) {
  return provider === "claude" ? <ClaudeIcon size={22} /> : <OpenAIIcon size={22} className="text-text-primary" />;
}

const STATES = {
  connected: ["bg-success", "Connected"],
  loggedOut: ["bg-error", "Not logged in"],
  missing: ["bg-text-muted", "Not installed"],
} as const;

function stateOf(runtime: Runtime): keyof typeof STATES {
  if (runtime.loggedIn) return "connected";
  return runtime.installed ? "loggedOut" : "missing";
}

function Status({ runtime }: { runtime: Runtime | undefined }) {
  if (!runtime) return <span className="text-[13px] text-text-muted">Checking</span>;
  const [dot, text] = STATES[stateOf(runtime)];
  return (
    <span className="flex items-center gap-2 text-[13px] text-text-secondary">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {text}
    </span>
  );
}

/** Claude Code and Codex, the runtimes every chat runs on: login state from the CLIs, plan and usage when connected. */
export function RuntimeStatus() {
  const [runtimes, setRuntimes] = useState<Runtime[] | null>(null);
  const usage = useUsageLimits(false);

  useEffect(() => {
    apiFetch("/settings/runtimes")
      .then((res) => (res.ok ? (res.json() as Promise<Runtime[]>) : []))
      .then(setRuntimes)
      .catch(() => setRuntimes([]));
  }, []);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(["claude", "codex"] as const).map((provider) => {
        const runtime = runtimes?.find((r) => r.provider === provider);
        const limits = usage.find((u) => u.provider === provider);
        return (
          <div key={provider} className="flex flex-col gap-4 rounded-xl border border-border bg-glass p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-raised">
                <Logo provider={provider} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[15px] font-medium text-text-primary">{NAMES[provider]}</span>
                  {limits?.plan && <span className="text-xs capitalize text-text-muted">{limits.plan}</span>}
                </div>
                <Status runtime={runtimes ? runtime : undefined} />
              </div>
            </div>
            {runtime?.loggedIn && limits?.available && limits.windows.length > 0 && (
              <div className="flex flex-col gap-3">
                {limits.windows.slice(0, 2).map((w) => <UsageBar key={w.id} window={w} />)}
              </div>
            )}
            {runtime && !runtime.loggedIn && (
              <p className="m-0 text-[13px] leading-relaxed text-text-secondary">
                {runtime.installed ? "Log in" : "Install it, then log in"} on the server, as the user Chomp runs as:{" "}
                <code className="font-mono text-xs text-text-primary">{runtime.loginCommand}</code>
              </p>
            )}
            {runtime?.version && <span className="mt-auto font-mono text-xs text-text-muted">{runtime.version}</span>}
          </div>
        );
      })}
    </div>
  );
}
