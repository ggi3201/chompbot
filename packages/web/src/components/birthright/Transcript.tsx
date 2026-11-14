import { memo, useEffect, useRef, type ReactNode } from "react";
import { motion } from "motion/react";
import type { RiteMessage } from "../../lib/birthright";

/** The last letters typed fade in one by one. Everything older is plain text again, so long replies stay cheap. */
const FADING_GLYPHS = 44;

/** Each line floats on its own clock. */
const DRIFT_PHASES = ["[animation-delay:-2s]", "[animation-delay:-9s] [animation-duration:21s]", "[animation-delay:-5s] [animation-duration:19s]", "[animation-delay:-13s] [animation-duration:23s]"];

const RECEDE = ["opacity-100", "opacity-[0.62]", "opacity-[0.42]", "opacity-[0.3]"];

function recedeClass(age: number): string {
  return RECEDE[Math.min(age, RECEDE.length - 1)];
}

function TypedText({ text, shown }: { text: string; shown: number }) {
  const settledEnd = Math.max(0, shown - FADING_GLYPHS);
  return (
    <>
      {text.slice(0, settledEnd)}
      {Array.from(text.slice(settledEnd, shown)).map((glyph, i) => (
        <span key={settledEnd + i} className="animate-glyph-in motion-reduce:animate-none">{glyph}</span>
      ))}
      <span aria-hidden="true" className="inline-block ml-px h-[0.95em] w-[2px] translate-y-[0.14em] rounded-full bg-accent-ink" />
      {/* Holding the place of the words still to come keeps lines from reflowing while they type. */}
      <span className="invisible">{text.slice(shown)}</span>
    </>
  );
}

const SettledMessage = memo(function SettledMessage({ message }: { message: RiteMessage }) {
  return <>{message.text}</>;
});

function MessageLine({ message, index, age, typed }: { message: RiteMessage; index: number; age: number; typed: number | null }) {
  const fromAgent = message.from === "agent";
  return (
    <motion.div
      initial={fromAgent ? false : { opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 34, damping: 14 }}
      className={fromAgent ? "" : "flex justify-end"}
    >
      <div className={`animate-zero-g motion-reduce:animate-none ${DRIFT_PHASES[index % DRIFT_PHASES.length]}`}>
        <p
          className={`whitespace-pre-wrap text-pretty transition-opacity duration-1000 hover:opacity-100 ${recedeClass(age)} ${
            fromAgent
              ? "text-[20px] md:text-[23px] leading-[1.48] tracking-[-0.012em] text-text-primary"
              : "max-w-[30rem] rounded-[18px] bg-white/[0.055] px-4 py-2.5 text-[15px] leading-[1.5] text-text-secondary"
          }`}
        >
          {typed === null ? <SettledMessage message={message} /> : <TypedText text={message.text} shown={typed} />}
        </p>
      </div>
    </motion.div>
  );
}

interface TranscriptProps {
  messages: RiteMessage[];
  /** Index of the message still typing, and how far along it is. */
  typingIndex: number;
  typed: number;
  children?: ReactNode;
}

/**
 * Older lines recede and drift up into the dark. The view chases the bottom with a slow
 * ease instead of jumping, unless the person has scrolled back to read.
 */
export default function Transcript({ messages, typingIndex, typed, children }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Whatever is said next is worth seeing, even after reading back.
  useEffect(() => {
    pinned.current = true;
  }, [messages.length]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let lastTouchY = 0;
    const unpinOnWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) pinned.current = false;
    };
    const noteTouch = (e: TouchEvent) => {
      lastTouchY = e.touches[0].clientY;
    };
    const unpinOnTouch = (e: TouchEvent) => {
      if (e.touches[0].clientY > lastTouchY) pinned.current = false;
      lastTouchY = e.touches[0].clientY;
    };
    const repinAtBottom = () => {
      if (element.scrollHeight - element.clientHeight - element.scrollTop < 24) pinned.current = true;
    };
    element.addEventListener("wheel", unpinOnWheel, { passive: true });
    element.addEventListener("touchstart", noteTouch, { passive: true });
    element.addEventListener("touchmove", unpinOnTouch, { passive: true });
    element.addEventListener("scroll", repinAtBottom, { passive: true });
    let frame = requestAnimationFrame(function drift() {
      const gap = element.scrollHeight - element.clientHeight - element.scrollTop;
      if (pinned.current && gap > 0.5) element.scrollTop += Math.max(0.35, gap * 0.035);
      frame = requestAnimationFrame(drift);
    });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("wheel", unpinOnWheel);
      element.removeEventListener("touchstart", noteTouch);
      element.removeEventListener("touchmove", unpinOnTouch);
      element.removeEventListener("scroll", repinAtBottom);
    };
  }, []);

  return (
    <div
      ref={scroller}
      aria-live="polite"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,black_16%,black_92%,transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[40rem] flex-col justify-end gap-7 px-6 pb-8 pt-[12vh]">
        {messages.map((message, index) => (
          <MessageLine
            key={index}
            message={message}
            index={index}
            age={messages.length - 1 - index}
            typed={index === typingIndex && typed < message.text.length ? typed : null}
          />
        ))}
        {children}
      </div>
    </div>
  );
}
