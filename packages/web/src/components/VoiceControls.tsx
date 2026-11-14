import { useState, useRef, useCallback } from "react";
import { Mic, Volume2, Square, Loader2 } from "lucide-react";
import { getToken } from "../lib/api";
import type { VoicePhase } from "../hooks/useVoiceMode";

export const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

// ── Voice button: the composer's way into hands-free voice (state lives in useVoiceMode) ──

interface VoiceButtonProps {
  phase: VoicePhase;
  /** 0–1 through the closing pause; the ring fills with it, full means it sends. */
  quiet: number;
  onClick: () => void;
  /** A press held for half a second; the click that ends it is swallowed. */
  onLongPress?: () => void;
  /** Replies are read aloud; shown as a small speaker on the button. */
  spokenReplies?: boolean;
  disabled?: boolean;
  className?: string;
  /** Look when voice is off, so a host can match its other buttons. */
  idleClassName?: string;
}

const VOICE_TITLES: Record<VoicePhase, string> = {
  off: "Talk hands-free",
  waiting: "Voice on. Tap to stop",
  listening: "Listening. Tap to stop and keep the text",
  transcribing: "Transcribing",
  speaking: "Speaking. Tap to cut in",
};

const LONG_PRESS_MS = 500;

export function VoiceButton({ phase, quiet, onClick, onLongPress, spokenReplies, disabled, className = "w-8 h-8 rounded-md border-none", idleClassName = "bg-transparent text-text-muted hover:bg-raised hover:text-text-primary" }: VoiceButtonProps) {
  const on = phase !== "off";
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };
  const replies = spokenReplies ? "Replies read aloud" : "Replies not read aloud";
  return (
    <button
      type="button"
      onClick={() => {
        if (longPressed.current) longPressed.current = false;
        else onClick();
      }}
      onPointerDown={() => {
        longPressed.current = false;
        if (!onLongPress) return;
        press.current = setTimeout(() => {
          longPressed.current = true;
          onLongPress();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={(e) => onLongPress && e.preventDefault()}
      disabled={disabled && !on}
      title={`${VOICE_TITLES[phase]}. ${replies}; hold to change`}
      aria-label={`${VOICE_TITLES[phase]}. ${replies}`}
      aria-pressed={on}
      className={`relative flex items-center justify-center select-none [-webkit-touch-callout:none] ${className} cursor-pointer transition-colors ${
        on ? "bg-error/15 text-error" : idleClassName
      } ${disabled && !on ? "opacity-40 cursor-default" : ""}`}
    >
      {/* Fills while you are quiet; full means it sends. Talking again empties it. */}
      {phase === "listening" && quiet > 0 && (
        <svg viewBox="0 0 40 40" aria-hidden className="absolute -inset-[3px] -rotate-90 pointer-events-none text-accent-ink">
          <circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" pathLength="1" strokeDasharray={`${quiet} 1`} />
        </svg>
      )}
      {spokenReplies && (
        <span aria-hidden className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-accent text-on-accent flex items-center justify-center pointer-events-none">
          <Volume2 size={10} strokeWidth={2} />
        </span>
      )}
      {phase === "transcribing" ? (
        <Loader2 size={18} strokeWidth={1.5} className="animate-spin" />
      ) : phase === "speaking" ? (
        <Square size={16} strokeWidth={1.5} />
      ) : (
        <Mic size={18} strokeWidth={1.5} />
      )}
    </button>
  );
}

// ── Speak button: click to TTS a message ──

interface SpeakButtonProps {
  text: string;
  voice?: string;
}

export function SpeakButton({ text, voice }: SpeakButtonProps) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleClick = useCallback(async () => {
    // If already playing, stop
    if (playing && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      abortRef.current?.abort();
      setPlaying(false);
      return;
    }

    setLoading(true);
    try {
      const abortController = new AbortController();
      abortRef.current = abortController;

      const token = getToken();
      const res = await fetch(`/api/voice/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text: stripMarkdown(text), voice }),
        signal: abortController.signal,
      });

      if (!res.ok) return;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      audio.onended = () => {
        URL.revokeObjectURL(url);
        setPlaying(false);
        audioRef.current = null;
      };

      audioRef.current = audio;
      setPlaying(true);
      await audio.play();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("[tts] Playback error:", err);
    } finally {
      setLoading(false);
    }
  }, [text, voice, playing]);

  return (
    <button
      type="button"
      onClick={handleClick}
      title={playing ? "Stop speaking" : "Read aloud"}
      className="p-1 rounded-sm border-none bg-transparent text-text-muted cursor-pointer leading-none flex items-center hover:text-text-primary transition-colors"
    >
      {loading ? (
        <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
      ) : playing ? (
        <Square size={14} strokeWidth={1.5} />
      ) : (
        <Volume2 size={14} strokeWidth={1.5} />
      )}
    </button>
  );
}

// ── Helpers ──

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data URL prefix: "data:audio/webm;base64,..."
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Strip markdown formatting so TTS reads clean text */
export function stripMarkdown(text: string): string {
  return text
    .replace(/:::canvas\n[\s\S]*?\n:::/g, "")      // canvas components
    .replace(/```[\s\S]*?```/g, " code block ")    // code blocks
    .replace(/`([^`]+)`/g, "$1")                     // inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")            // image markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")        // links (keep label, drop URL)
    .replace(/<?https?:\/\/[^\s>]+>?/g, "")          // raw URLs
    .replace(/<[^>]+>/g, "")                          // HTML tags
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1") // bold/italic/strikethrough
    .replace(/^#{1,6}\s+/gm, "")                     // headings
    .replace(/^>\s?/gm, "")                           // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, "")                   // list items
    .replace(/^\s*\d+\.\s+/gm, "")                   // numbered list items
    .replace(/^\|.*\|$/gm, "")                        // table rows
    .replace(/^[-|: ]+$/gm, "")                       // table separators
    .replace(/^-{3,}$|^\*{3,}$/gm, "")               // horizontal rules
    .replace(/\n{2,}/g, "\n")                         // excessive newlines
    .trim();
}
