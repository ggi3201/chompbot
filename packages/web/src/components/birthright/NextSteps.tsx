import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../../lib/api";

interface Step {
  title: string;
  detail: string;
  /** Links to Settings; steps done outside Chomp get no link. */
  inSettings: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

async function json<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** What a new user could set up next, from what is still missing. A check that fails is left out rather than guessed. */
export default function NextSteps({ name, voiceReady }: { name: string; voiceReady: boolean }) {
  const [connections, setConnections] = useState<{ google: boolean | null; telegram: boolean | null }>({ google: null, telegram: null });

  useEffect(() => {
    void Promise.all([
      json<{ connected: boolean }>("/google/status"),
      json<{ linkedChatId: number | null }>("/telegram/status"),
    ]).then(([google, telegram]) => setConnections({
      google: google ? google.connected : null,
      telegram: telegram ? telegram.linkedChatId != null : null,
    }));
  }, []);

  const steps: Step[] = [];
  if (!voiceReady) steps.push({ title: `Talk out loud with ${name}`, detail: "Add an OpenAI API key under API keys.", inSettings: true });
  if (connections.google === false) steps.push({ title: "Mail and calendar", detail: `Connect Google, so ${name} can read your calendar and mail.`, inSettings: true });
  if (connections.telegram === false) steps.push({ title: "Chat from your phone", detail: "Set up a Telegram bot under Telegram.", inSettings: true });
  if (LOCAL_HOSTS.has(window.location.hostname)) steps.push({ title: "Open Chomp on your phone", detail: "Set up Tailscale on this machine and your phone. SETUP.md shows how.", inSettings: false });
  if (steps.length === 0) return null;

  return (
    <section aria-labelledby="next-steps" className="w-full max-w-[26rem] text-left">
      <h2 id="next-steps" className="m-0 mb-2 text-center text-[13px] font-medium text-text-muted">When you want more</h2>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {steps.map((step) => {
          const body = (
            <>
              <span className="block text-[14px] text-text-primary">{step.title}</span>
              <span className="block text-[13px] leading-snug text-text-secondary">{step.detail}</span>
            </>
          );
          return (
            <li key={step.title}>
              {step.inSettings ? (
                <Link to="/settings" className="block rounded-xl px-3 py-2 no-underline transition-colors hover:bg-white/5 focus-visible:bg-white/5">
                  {body}
                </Link>
              ) : (
                <div className="px-3 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
