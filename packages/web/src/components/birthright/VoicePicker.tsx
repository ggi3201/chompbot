import { useState } from "react";
import { motion } from "motion/react";
import { Button } from "../ui";
import { VOICES } from "../VoiceControls";

interface VoicePickerProps {
  name: string;
  /** The voice playing right now, if any. */
  playing: string | null;
  onTry: (voice: string, line: string) => void;
  onPick: (voice: string) => void;
}

/** Right after the agent gets a name, the person hears it say that name in each voice until one fits. */
export default function VoicePicker({ name, playing, onTry, onPick }: VoicePickerProps) {
  const [tried, setTried] = useState<string | null>(null);

  function tryVoice(voice: string) {
    setTried(voice);
    onTry(voice, `I'm ${name}. This is how I would sound.`);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 30, damping: 13 }}
      className="animate-zero-g motion-reduce:animate-none [animation-duration:19s]"
    >
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`A voice for ${name}`}>
        {VOICES.map((voice) => (
          <button
            key={voice}
            type="button"
            role="radio"
            aria-checked={tried === voice}
            onClick={() => tryVoice(voice)}
            className={`h-9 cursor-pointer rounded-full border px-3.5 text-sm capitalize transition-colors ${
              tried === voice
                ? "border-accent/60 bg-accent/10 text-accent-ink"
                : "border-white/10 bg-[#0a0b0f]/70 text-text-secondary hover:border-white/24 hover:text-text-primary"
            } ${playing === voice ? "border-accent" : ""}`}
          >
            {voice}
          </button>
        ))}
      </div>
      <div className="mt-3 flex min-h-9 items-center">
        {tried ? (
          <Button variant="primary" onClick={() => onPick(tried)}>
            <span>Keep <span className="capitalize">{tried}</span></span>
          </Button>
        ) : (
          <p className="m-0 text-[13px] text-text-muted">Tap one to hear it.</p>
        )}
      </div>
    </motion.div>
  );
}
