import { useCallback, useEffect, useRef, useState } from "react";
import { acquireAnalyser, getAudioContext, useMicrophone } from "voice-ring";
import { blobToBase64 } from "../components/VoiceControls";
import { apiFetch } from "../lib/api";
import { takeSpokenPieces } from "../lib/birthright";

export type VoicePhase = "off" | "waiting" | "speaking" | "listening" | "transcribing";

const TYPING_CPS = 16;
const MIN_PIECE_CHARS = 28;
const SPEECH_RMS = 0.022;
const SPEECH_OVER_ROOM = 3;
const ROOM_LEVEL_DRIFT = 1.002;
const SPEECH_START_MS = 160;
const SPEECH_END_MS = 1300;
const RECORDING_RESTART_MS = 30_000;
const MAX_UTTERANCE_MS = 90_000;
const SAMPLE_MS = 50;

const SPEECH_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const DELIVERY = "Speak softly and unhurried, close to the listener, like someone awake for the first time in a quiet place. Natural and warm, no drama.";

// A silent sound played inside the click, so Safari lets later playback start without one.
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

async function fetchSpeech(text: string, voice: string | null, delivery = DELIVERY): Promise<string | null> {
  const res = await apiFetch("/voice/tts", {
    method: "POST",
    body: JSON.stringify({ text: text.trim(), ...(delivery ? { instructions: delivery } : {}), ...(voice ? { voice } : {}) }),
  });
  return res.ok ? URL.createObjectURL(await res.blob()) : null;
}

function recorderMimeType(): string {
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

interface QueuedSpeech {
  text: string;
  url: Promise<string | null>;
}

export interface VoiceModeOptions {
  /** How the voice should sound; "" for the voice's own manner. Defaults to the rite's soft delivery. */
  delivery?: string;
  /** Whether to say this reply aloud. Read when the reply begins; defaults to always. */
  speakReplies?: () => boolean;
  /** Listen again right after each utterance, so the person can add to it while the agent works. */
  keepListening?: boolean;
  /** Quiet that ends an utterance, in ms. Defaults to the rite's 1.3 s. */
  pauseMs?: number;
  /** Playback speed of what it says; the pitch stays. Defaults to 1. */
  rate?: number;
}

/**
 * The spoken side of the rite: it says each sentence as it arrives, then listens until
 * the person has finished talking. Half duplex on purpose, so it never hears itself.
 * onUtterance gets draft=true for words caught by finish(), to edit rather than send.
 */
export function useVoiceMode(
  onUtterance: (text: string, draft: boolean) => void,
  onProblem: (message: string) => void,
  options: VoiceModeOptions = {},
) {
  const mic = useMicrophone({ constraints: SPEECH_CONSTRAINTS });
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [typeLimit, setTypeLimit] = useState(Infinity);
  const [typeCps, setTypeCps] = useState(TYPING_CPS);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [auditioning, setAuditioning] = useState<string | null>(null);
  /** How far through the closing pause the person is: 0 while talking, 1 when it stops listening. */
  const [quiet, setQuiet] = useState(0);

  const callbacks = useRef({ onUtterance, onProblem, options });
  useEffect(() => {
    callbacks.current = { onUtterance, onProblem, options };
  });

  const on = useRef(false);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const finishPlayback = useRef<(() => void) | null>(null);
  const queue = useRef<QueuedSpeech[]>([]);
  const unspoken = useRef("");
  const speakingReply = useRef(false);
  const replyEnded = useRef(true);
  const playing = useRef(false);
  const stopRecording = useRef<((keep: boolean) => void) | null>(null);
  const speaker = useRef<string | null>(null);
  const holdListening = useRef(false);
  const samples = useRef(new Map<string, Promise<string | null>>());
  const draft = useRef(false);

  const listen = useCallback(() => {
    draft.current = false;
    if (!on.current || !stream.current || holdListening.current) {
      setPhase(on.current ? "waiting" : "off");
      return;
    }
    const lease = acquireAnalyser(stream.current);
    const mimeType = recorderMimeType();
    if (!lease || !mimeType) {
      setPhase("waiting");
      return;
    }

    const recorder = new MediaRecorder(stream.current, { mimeType });
    const chunks: Blob[] = [];
    let keep = false;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      if (!keep) return;
      const asDraft = draft.current;
      draft.current = false;
      setPhase("transcribing");
      try {
        const data = await blobToBase64(new Blob(chunks, { type: mimeType }));
        const res = await apiFetch("/voice/transcribe", { method: "POST", body: JSON.stringify({ data, mimeType }) });
        if (!res.ok) throw new Error("Could not understand that. Try again, or type it.");
        const text = ((await res.json()) as { text: string }).text.trim();
        if (text) callbacks.current.onUtterance(text, asDraft);
        else setPhase("waiting");
      } catch (err) {
        callbacks.current.onProblem(err instanceof Error ? err.message : "Could not understand that.");
        setPhase("waiting");
      }
      if (!on.current) setPhase("off");
      else if (callbacks.current.options.keepListening && !speakingReply.current && !stopRecording.current) listen();
    };

    const wave = new Float32Array(lease.analyser.fftSize);
    const started = performance.now();
    let spokenMs = 0;
    let silentMs = 0;
    let heard = false;
    let roomLevel = Infinity;

    const finish = (save: boolean) => {
      clearInterval(meter);
      setQuiet(0);
      lease.release();
      stopRecording.current = null;
      keep = save;
      recorder.stop();
    };
    stopRecording.current = (save) => finish(save && heard);

    const meter = setInterval(() => {
      lease.analyser.getFloatTimeDomainData(wave);
      const rms = Math.sqrt(wave.reduce((sum, s) => sum + s * s, 0) / wave.length);
      // A noisy room must not read as someone who never stops talking.
      roomLevel = Math.min(rms, roomLevel * ROOM_LEVEL_DRIFT);
      if (rms > Math.max(SPEECH_RMS, roomLevel * SPEECH_OVER_ROOM)) {
        spokenMs += SAMPLE_MS;
        silentMs = 0;
        heard ||= spokenMs >= SPEECH_START_MS;
      } else {
        silentMs += SAMPLE_MS;
        if (!heard) spokenMs = 0;
      }
      const pauseMs = callbacks.current.options.pauseMs ?? SPEECH_END_MS;
      if (heard) setQuiet(Math.min(1, silentMs / pauseMs));
      const elapsed = performance.now() - started;
      if (heard && (silentMs >= pauseMs || elapsed >= MAX_UTTERANCE_MS)) finish(true);
      else if (!heard && elapsed >= RECORDING_RESTART_MS) {
        // People take their time. Keep listening, but do not keep a long recording of silence.
        finish(false);
        listen();
      }
    }, SAMPLE_MS);

    recorder.start();
    setPhase("listening");
  }, []);

  const playNext = useCallback(async () => {
    if (playing.current) return;
    const next = queue.current.shift();
    if (!next) {
      if (replyEnded.current && speakingReply.current) {
        speakingReply.current = false;
        setTypeLimit(Infinity);
        listen();
      }
      return;
    }

    playing.current = true;
    setPhase("speaking");
    const url = await next.url.catch(() => null);
    const element = audio.current;
    if (url && element && on.current && speakingReply.current) {
      await new Promise<void>((resolve) => {
        finishPlayback.current = resolve;
        element.onplaying = () => {
          const seconds = Number.isFinite(element.duration) ? element.duration : next.text.length / TYPING_CPS;
          setTypeCps(next.text.length / Math.max(seconds, 0.2));
          setTypeLimit((limit) => limit + next.text.length);
          element.onplaying = null;
        };
        element.onended = element.onerror = () => resolve();
        element.src = url;
        element.playbackRate = callbacks.current.options.rate ?? 1;
        element.play().catch(() => resolve());
      });
      finishPlayback.current = null;
      URL.revokeObjectURL(url);
    } else {
      // No voice for this piece: its words still have to appear.
      setTypeLimit((limit) => limit + next.text.length);
      if (!url && on.current) callbacks.current.onProblem("Could not speak that. Voice needs an OpenAI key in Settings.");
    }
    playing.current = false;
    void playNext();
  }, [listen]);

  const enqueue = useCallback((text: string) => {
    queue.current.push({ text, url: fetchSpeech(text, speaker.current, callbacks.current.options.delivery) });
    void playNext();
  }, [playNext]);

  const beginReply = useCallback(() => {
    const { speakReplies, keepListening } = callbacks.current.options;
    const speak = on.current && (speakReplies?.() ?? true);
    // A silent reply leaves a listening mic alone; a spoken one must not be heard, so words already said are kept.
    if (speak || !keepListening) stopRecording.current?.(!!keepListening);
    queue.current = [];
    unspoken.current = "";
    replyEnded.current = false;
    speakingReply.current = speak;
    setTypeLimit(speak ? 0 : Infinity);
    setTypeCps(TYPING_CPS);
    if (speak) setPhase("waiting");
  }, []);

  const feed = useCallback((delta: string) => {
    if (!speakingReply.current) return;
    const { pieces, rest } = takeSpokenPieces(unspoken.current + delta, MIN_PIECE_CHARS);
    unspoken.current = rest;
    pieces.forEach(enqueue);
  }, [enqueue]);

  const endReply = useCallback(() => {
    replyEnded.current = true;
    if (!speakingReply.current) {
      if (on.current && !stopRecording.current) listen();
      return;
    }
    const rest = unspoken.current;
    unspoken.current = "";
    if (rest.trim()) enqueue(rest);
    else void playNext();
  }, [enqueue, listen, playNext]);

  const stopSpeaking = useCallback(() => {
    speakingReply.current = false;
    queue.current = [];
    unspoken.current = "";
    setTypeLimit(Infinity);
    audio.current?.pause();
    finishPlayback.current?.();
  }, []);

  /** One audio element for everything it says, wired through an analyser so the ring can move with it. */
  const preparePlayback = useCallback((): HTMLAudioElement => {
    if (audio.current) return audio.current;
    const element = new Audio(SILENCE);
    void element.play().catch(() => {});
    audio.current = element;
    const context = getAudioContext();
    if (context) {
      const node = context.createAnalyser();
      node.fftSize = 512;
      context.createMediaElementSource(element).connect(node);
      node.connect(context.destination);
      setAnalyser(node);
    }
    return element;
  }, []);

  /** Plays a short sample of a voice, from a tap. Trying the same voice again costs nothing. */
  const audition = useCallback(async (voice: string, line: string) => {
    const element = preparePlayback();
    finishPlayback.current?.();
    setAuditioning(voice);
    const sample = `${voice}:${line}`;
    const pending = samples.current.get(sample) ?? fetchSpeech(line, voice);
    samples.current.set(sample, pending);
    const url = await pending.catch(() => null);
    if (!url) {
      samples.current.delete(sample);
      setAuditioning(null);
      callbacks.current.onProblem("Could not play that voice. Voice needs an OpenAI key in Settings.");
      return;
    }
    await new Promise<void>((resolve) => {
      finishPlayback.current = resolve;
      element.onplaying = null;
      element.onended = element.onerror = () => resolve();
      element.src = url;
      element.play().catch(() => resolve());
    });
    finishPlayback.current = null;
    setAuditioning((current) => (current === voice ? null : current));
  }, [preparePlayback]);

  /** Call from a click: browsers only open the microphone and start audio inside one. */
  const enable = useCallback(async () => {
    preparePlayback();
    on.current = true;
    setPhase("waiting");
    stream.current = await mic.start();
    if (!stream.current) callbacks.current.onProblem("The microphone is blocked, so type your answers. I can still speak.");
    if (replyEnded.current && !playing.current) listen();
  }, [listen, mic, preparePlayback]);

  const disable = useCallback(() => {
    on.current = false;
    stopSpeaking();
    stopRecording.current?.(false);
    mic.stop();
    stream.current = null;
    setPhase("off");
  }, [mic, stopSpeaking]);

  /** Turns voice off; words it was still hearing come back as a draft instead of being sent. */
  const finish = useCallback(() => {
    draft.current = true;
    on.current = false;
    stopSpeaking();
    stopRecording.current?.(true);
    setPhase("off");
    mic.stop();
    stream.current = null;
  }, [mic, stopSpeaking]);

  /** The ring is the one control: tap to interrupt it, or to say you are done talking. */
  const tap = useCallback(() => {
    if (phase === "speaking") {
      stopSpeaking();
      // Cutting in means it is your turn.
      listen();
    } else if (phase === "listening") {
      // If it heard anything, the recorder moves on to transcribing from here.
      setPhase("waiting");
      stopRecording.current?.(true);
    } else if (phase === "waiting") {
      listen();
    }
  }, [listen, phase, stopSpeaking]);

  /** Who speaks, and whether listening has to wait for the person to do something else first. */
  const tune = useCallback((next: { speaker: string | null; hold: boolean }) => {
    speaker.current = next.speaker;
    const released = holdListening.current && !next.hold;
    holdListening.current = next.hold;
    if (released && on.current && replyEnded.current && !playing.current && !stopRecording.current) listen();
  }, [listen]);

  useEffect(() => () => {
    on.current = false;
    audio.current?.pause();
    stopRecording.current?.(false);
  }, []);

  return {
    phase,
    enable,
    disable,
    finish,
    tap,
    quiet,
    tune,
    audition,
    auditioning,
    beginReply,
    feed,
    endReply,
    typeLimit,
    typeCps,
    /** Hand this to the ring while listening. */
    micStream: mic.stream,
    /** Hand this to the ring while speaking. */
    playbackAnalyser: analyser,
  };
}
