import { useEffect, useState } from "react";

/** Falls behind by at most this long, however fast the text arrives. */
const MAX_LAG_SECONDS = 1.4;
const PAUSES: Record<string, number> = { ".": 0.22, "?": 0.22, "!": 0.22, "…": 0.22, "\n": 0.2, ",": 0.07, ";": 0.09, ":": 0.09 };

interface TypewriterOptions {
  /** Characters per second while it keeps up. */
  cps: number;
  /** Never reveal past this many characters. Voice mode raises it as sentences start playing. */
  limit?: number;
  /** Breathe after punctuation, the way someone typing does. */
  rhythm?: boolean;
  /** Hold exactly `cps` instead of catching up, so the words keep pace with a voice. */
  steady?: boolean;
}

/**
 * How many characters of `text` to show. A new `key` types from the start. The first
 * key shows its text at once, so a restored conversation does not type itself out again.
 */
export function useTypewriter(key: number, text: string, { cps, limit = Infinity, rhythm = false, steady = false }: TypewriterOptions): number {
  const [track, setTrack] = useState({ key, shown: text.length });
  if (track.key !== key) setTrack({ key, shown: 0 });

  const target = Math.min(text.length, limit);
  const shown = track.key === key ? track.shown : 0;

  useEffect(() => {
    if (shown >= target) return;
    let current = shown;
    let carry = 0;
    let hold = 0;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const dt = (now - last) / 1000;
      last = now;
      if (hold > 0) {
        hold -= dt;
      } else {
        carry += dt * (steady ? cps : Math.max(cps, (target - current) / MAX_LAG_SECONDS));
        const step = Math.floor(carry);
        if (step > 0) {
          carry -= step;
          current = Math.min(target, current + step);
          if (rhythm) hold = PAUSES[text[current - 1]] ?? 0;
          setTrack({ key, shown: current });
        }
      }
      if (current < target) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // `shown` only seeds the loop, which then keeps its own count until the target moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, target, cps, rhythm, steady, text]);

  return Math.min(shown, text.length);
}
