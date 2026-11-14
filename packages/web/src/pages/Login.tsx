import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Brain, CalendarDays, LayoutGrid, MessageCircle, Mic, Sparkles, Zap, type LucideIcon } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { Button, Input } from "../components/ui";
import Logo from "../components/Logo";

type SetupStep = "password" | "ollama" | "done";

// What a new user can ask for in the chat.
const CAPABILITIES: Array<{ icon: LucideIcon; name: string; what: string }> = [
  { icon: Brain, name: "Memory", what: "Remembers what you tell it, and uses it next time." },
  { icon: CalendarDays, name: "Mail and calendar", what: "Reads Gmail and Calendar, drafts replies, books events." },
  { icon: Zap, name: "Reminders and rules", what: "Runs a task on a schedule, or when something happens." },
  { icon: MessageCircle, name: "Telegram and Discord", what: "Chat from your phone, and get alerts there." },
  { icon: LayoutGrid, name: "Dashboards", what: "Live widgets for prices, weather, whatever you track." },
  { icon: Mic, name: "Voice", what: "Talk to Chomp and hear it answer." },
  { icon: Sparkles, name: "Personality", what: "A short interview sets how Chomp talks: Birthright, in the menu." },
];

interface OllamaModel {
  name: string;
  size: number;
}

export default function Login() {
  const { login } = useAuth();
  const [password, setPassword] = useState("");
  const [isSetup, setIsSetup] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  // First-run wizard state
  const [step, setStep] = useState<SetupStep>("password");
  const [token, setToken] = useState<string | null>(null);
  const [ollamaReady, setOllamaReady] = useState(false);
  const [models, setModels] = useState<OllamaModel[]>([]);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data) => setIsSetup(data.isSetup));
  }, []);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const endpoint = isSetup ? "/api/auth/login" : "/api/auth/setup";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error);
      return;
    }

    const data = await res.json();

    if (isSetup) {
      login(data.token);
      window.location.href = "/";
    } else {
      setToken(data.token);
      login(data.token);
      checkOllama(data.token);
      setStep("ollama");
    }
  }

  async function checkOllama(authToken: string) {
    try {
      const res = await fetch("/api/settings/ollama/status", {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setOllamaReady(data.ready);
        setModels(data.models ?? []);
      }
    } catch {
      setOllamaReady(false);
    }
  }

  function finishSetup() {
    window.location.href = "/chat";
  }

  if (isSetup === null) {
    return <div className="flex justify-center items-center h-screen bg-surface"><span className="text-text-muted">Loading</span></div>;
  }

  // Existing user login
  if (isSetup) {
    return (
      <div className="flex justify-center items-center h-screen bg-surface">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="w-[360px] max-w-[calc(100vw-32px)]"
        >
          <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
            <div className="flex items-center gap-2.5 mb-4 text-text-primary">
              <Logo size={24} />
              <h1 className="m-0 text-xl font-semibold">Chomp</h1>
            </div>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="h-11 text-base"
              autoFocus
            />
            {error && <p className="text-error m-0 text-[13px]">{error}</p>}
            <Button type="submit" variant="primary" className="h-11">Log in</Button>
          </form>
        </motion.div>
      </div>
    );
  }

  // First-run wizard
  return (
    <div className="flex justify-center items-center h-screen bg-surface">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className={`${step === "done" ? "w-[600px]" : "w-[400px]"} max-w-[calc(100vw-32px)]`}
      >
        {/* Progress indicator */}
        <div className="flex gap-2 mb-6">
          {["password", "ollama", "done"].map((s, i) => (
            <div
              key={s}
              className={`flex-1 h-1 rounded-sm transition-colors duration-300 ${
                i <= ["password", "ollama", "done"].indexOf(step) ? "bg-accent" : "bg-raised"
              }`}
            />
          ))}
        </div>

        {step === "password" && (
          <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
            <h1 className="m-0 text-2xl font-medium">Set up Chomp</h1>
            <p className="m-0 text-text-secondary">
              Choose a password of at least 8 characters
            </p>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Choose a password"
              className="h-11 text-base"
              autoFocus
            />
            {error && <p className="text-error m-0 text-[13px]">{error}</p>}
            <Button type="submit" variant="primary" className="h-11">Continue</Button>
          </form>
        )}

        {step === "ollama" && (
          <div className="flex flex-col gap-4">
            <h2 className="m-0 text-2xl text-text-primary">Ollama connection</h2>
            <p className="m-0 text-text-secondary">
              Memory search uses Ollama embeddings on this machine. Skip it if you will use OpenAI or Gemini embeddings instead.
            </p>
            <div className="p-4 border border-border rounded-lg bg-glass">
              <p className="m-0 mb-2 text-text-secondary">
                Status: <span className={`font-medium ${ollamaReady ? "text-success" : "text-error"}`}>
                  {ollamaReady ? "Connected" : "Not reachable"}
                </span>
              </p>
              {ollamaReady && models.length > 0 && (
                <div>
                  <p className="m-0 mb-1 text-[0.85rem] text-text-muted">Available models</p>
                  <ul className="m-0 pl-6">
                    {models.map((m) => (
                      <li key={m.name} className="text-[0.9rem] text-text-secondary">
                        <code>{m.name}</code> &mdash; {(m.size / 1e9).toFixed(1)} GB
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!ollamaReady && (
                <p className="text-[0.85rem] text-text-muted m-0">
                  Make sure Ollama is running and accessible. You can configure the host in Settings later.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => token && checkOllama(token)} className="h-11 flex-1">Refresh</Button>
              <Button variant="primary" onClick={() => setStep("done")} className="h-11 flex-1">
                {ollamaReady ? "Continue" : "Skip for now"}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <h2 className="m-0 text-2xl text-text-primary">Chomp is ready</h2>
              <p className="m-0 text-[15px] leading-relaxed text-text-secondary">
                Everything starts in the chat. Ask for what you want, in your own words.
              </p>
            </div>
            <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2">
              {CAPABILITIES.map(({ icon: Icon, name, what }) => (
                <li key={name} className="flex gap-3 rounded-xl border border-border bg-glass p-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Icon size={16} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-text-primary">{name}</span>
                    <span className="text-[13px] leading-snug text-text-secondary">{what}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-3">
              <Button variant="primary" onClick={finishSetup} className="h-11">Open the chat</Button>
              <p className="m-0 text-center text-[13px] text-text-muted">
                Some of these need a key or a login. Ask Chomp, and it sets them up with you.
              </p>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
