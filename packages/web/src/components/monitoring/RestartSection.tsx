import { useState } from "react";
import { useRestart } from "../../hooks/useTargetActions";
import { Button } from "../ui";

interface RestartSectionProps {
  targetKey: string;
  /** What gets restarted, for the question. */
  name: string;
  onRestarted: () => void;
}

/** Restart asks first, then shows what the server answered. */
export default function RestartSection({ targetKey, name, onRestarted }: RestartSectionProps) {
  const [confirming, setConfirming] = useState(false);
  const { busy, result, restart } = useRestart(targetKey);

  const confirm = async () => {
    setConfirming(false);
    await restart();
    onRestarted();
  };

  return (
    <section className="mb-5">
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-[13px] text-text-secondary">Restart {name}?</span>
            <Button size="sm" variant="danger" onClick={() => void confirm()}>Restart</Button>
            <Button size="sm" variant="outline" autoFocus onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
            {busy ? "Restarting..." : "Restart"}
          </Button>
        )}
      </div>
      {result && <p className={`mb-0 mt-2 text-[13px] ${result.ok ? "text-text-secondary" : "text-error"}`}>{result.message}</p>}
    </section>
  );
}
