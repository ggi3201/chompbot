import { useState } from "react";
import { motion } from "motion/react";
import type { BirthrightTrial } from "@chomp/shared";
import Markdown from "../Markdown";
import { Button } from "../ui";
import { apiFetch } from "../../lib/api";

interface SoulTrialProps {
  soul: string;
  name: string;
  onBusy: (busy: boolean) => void;
  onReport: (report: string) => void;
}

/** A blind test: the same real messages, answered by the new soul and by what runs today. */
export default function SoulTrial({ soul, name, onBusy, onReport }: SoulTrialProps) {
  const [trial, setTrial] = useState<BirthrightTrial | null>(null);
  const [picks, setPicks] = useState<Array<"new" | "current">>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setRunning(true);
    setError(null);
    onBusy(true);
    try {
      const res = await apiFetch("/birthright/trial", { method: "POST", body: JSON.stringify({ soul }) });
      if (!res.ok) throw new Error(`The test failed (${res.status})`);
      const result = (await res.json()) as BirthrightTrial;
      setTrial(result);
      if (!result.rounds.length) onBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The test failed");
      onBusy(false);
    } finally {
      setRunning(false);
    }
  }

  function pick(source: "new" | "current") {
    const next = [...picks, source];
    setPicks(next);
    if (trial && next.length === trial.rounds.length) onBusy(false);
  }

  if (!trial) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={running} onClick={() => void start()}>
          {running ? "Answering your messages" : "Test it first"}
        </Button>
        <p className="m-0 text-[13px] text-text-muted">
          {error ?? "Blind test on three of your real messages. You pick the better answer."}
        </p>
      </div>
    );
  }

  if (!trial.rounds.length) {
    return <p className="m-0 text-[13px] text-text-muted">There are no past chats to test on yet.</p>;
  }

  const round = trial.rounds[picks.length];
  if (round) {
    return (
      <motion.div
        key={picks.length}
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 30, damping: 13 }}
      >
        <p className="m-0 font-mono text-xs text-text-muted">Which answer is better? {picks.length + 1} of {trial.rounds.length}</p>
        <p className="m-0 mt-2 text-[15px] leading-[1.5] text-text-secondary">{round.message}</p>
        <div className="mt-3 grid gap-2.5 md:grid-cols-2">
          {round.answers.map((answer) => (
            <button
              key={answer.source}
              type="button"
              onClick={() => pick(answer.source)}
              className="max-h-72 cursor-pointer overflow-y-auto rounded-xl border border-white/10 bg-[#0a0b0f]/80 px-4 py-3.5 text-left text-sm leading-[1.5] text-text-secondary transition-colors hover:border-accent/50 hover:text-text-primary"
            >
              <Markdown>{answer.text}</Markdown>
            </button>
          ))}
        </div>
      </motion.div>
    );
  }

  const wins = picks.filter((source) => source === "new").length;
  const rival = trial.current ?? "no soul at all";
  const result = `You picked ${name} ${wins} of ${picks.length} times, against ${rival}.`;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="m-0 text-sm text-text-primary">{result}</p>
      <Button variant="outline" size="sm" onClick={() => onReport(`I tested you blind against ${rival}. I picked you ${wins} of ${picks.length} times. What should change?`)}>
        Tell {name}
      </Button>
    </div>
  );
}
