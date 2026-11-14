import { useEffect, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatePresence, animate, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { ArrowUp, AudioLines, X } from "lucide-react";
import { VoiceRing, type VoiceOrbState } from "voice-ring";
import FacetOrbit from "../components/birthright/FacetOrbit";
import ChoiceCards from "../components/birthright/ChoiceCards";
import NextSteps from "../components/birthright/NextSteps";
import SoulCard from "../components/birthright/SoulCard";
import SoulTrial from "../components/birthright/SoulTrial";
import SpaceScene from "../components/birthright/SpaceScene";
import Transcript from "../components/birthright/Transcript";
import VoicePicker from "../components/birthright/VoicePicker";
import { Button, IconButton } from "../components/ui";
import { useBirthright } from "../hooks/useBirthright";
import { useIsMobile } from "../hooks/useIsMobile";
import { useTypewriter } from "../hooks/useTypewriter";
import { useVoiceMode, type VoicePhase } from "../hooks/useVoiceMode";
import { apiFetch } from "../lib/api";

/** The stars drift out from behind the ring, so it sits where everything comes from. */
const FOCUS_Y = 0.17;
const RING_SIZE = 280;
const FLOAT = { type: "spring", stiffness: 22, damping: 11, mass: 1.3 } as const;
const REPLY_CPS = 54;
/** Speed of the spoken replies. The rite's soft, unhurried delivery dragged at 1x. */
const VOICE_RATE = 1.15;
/** A microphone is loud and levelled. Speech played back is much quieter, so the ring needs more gain to dance to it. */
const MIC_SENSITIVITY = 1.25;
const PLAYBACK_SENSITIVITY = 2.6;

const VOICE_PLACEHOLDERS: Partial<Record<VoicePhase, string>> = {
  speaking: "Speaking. Tap the ring to cut in.",
  listening: "Listening. Just talk.",
  transcribing: "Writing down what you said",
  waiting: "Tap the ring to talk, or type here",
};

/** With no real audio to follow, the ring moves as if someone were talking while the words type out. */
function typingLevel(): number {
  const t = performance.now() / 1000;
  return 0.3 + 0.2 * Math.sin(t * 9.1) * Math.sin(t * 2.3) + 0.12 * Math.sin(t * 5.3 + 1);
}

export default function Birthright() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const voice = useVoiceMode(
    (text) => void rite.say(text),
    (message) => rite.showProblem(message),
    { rate: VOICE_RATE },
  );
  const rite = useBirthright(voice);
  const { status, messages, facets, speaker, choice, soul, error } = rite.state;
  const { tune } = voice;
  const [testing, setTesting] = useState(false);

  // Speech needs an OpenAI key, which a fresh install does not have: offer voice only once it works.
  const [voiceReady, setVoiceReady] = useState(false);
  useEffect(() => {
    apiFetch("/voice/status")
      .then((res) => (res.ok ? res.json() : { available: false }))
      .then((body: { available?: boolean }) => setVoiceReady(Boolean(body.available)))
      .catch(() => setVoiceReady(false));
  }, []);

  // The name comes first, then how that name sounds. Listening waits until that is settled.
  const choosingSpeaker = Boolean(facets.name && !speaker);
  useEffect(() => {
    tune({ speaker, hold: choosingSpeaker || testing });
  }, [choosingSpeaker, speaker, testing, tune]);

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // Floating means inertia: the view answers the pointer late and keeps going for a moment.
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const lookX = useSpring(pointerX, { stiffness: 14, damping: 11, mass: 1.4 });
  const lookY = useSpring(pointerY, { stiffness: 14, damping: 11, mass: 1.4 });
  const warp = useMotionValue(0);
  const ringX = useTransform(lookX, (v) => v * -14);
  const ringY = useTransform(lookY, (v) => v * -10);
  const textX = useTransform(lookX, (v) => v * -4);
  const textY = useTransform(lookY, (v) => v * -3);

  const typingIndex = messages.map((m) => m.from).lastIndexOf("agent");
  const replyText = messages[typingIndex]?.text ?? "";
  const speakingAloud = voice.phase !== "off";
  const typed = useTypewriter(typingIndex, replyText, {
    cps: speakingAloud ? voice.typeCps : REPLY_CPS,
    limit: voice.typeLimit,
    rhythm: !speakingAloud,
    steady: speakingAloud,
  });
  const typing = typed < replyText.length;

  const arrival = status === "arrival";
  const returning = status === "returning";
  const born = status === "born";
  const inConversation = !arrival && !returning && !born;
  const busy = status === "thinking" || status === "replying";
  const listening = voice.phase === "listening";
  const placeholder = (() => {
    if (speakingAloud && busy && voice.phase === "waiting") return "Thinking";
    if (speakingAloud && choosingSpeaker && voice.phase === "waiting") return "Pick a voice above";
    if (voice.phase === "waiting" && !voice.micStream) return "Answer it";
    if (listening && voice.quiet > 0) return "Sending when you stay quiet";
    return VOICE_PLACEHOLDERS[voice.phase] ?? "Answer it";
  })();

  const ringState: VoiceOrbState = (() => {
    if (listening) return "listening";
    if (voice.phase === "speaking" || voice.auditioning || (typing && !soul?.writing)) return "speaking";
    if (busy || testing || voice.phase === "transcribing" || soul?.writing) return "processing";
    return "idle";
  })();

  function onPointerMove(e: PointerEvent) {
    pointerX.set((e.clientX / window.innerWidth) * 2 - 1);
    pointerY.set((e.clientY / window.innerHeight) * 2 - 1);
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    const answered = await rite.say(text);
    if (!answered) setDraft(text);
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function beginWithVoice() {
    void voice.enable();
    void rite.begin();
  }

  function startOver() {
    if (!confirmingReset) {
      setConfirmingReset(true);
      return;
    }
    setConfirmingReset(false);
    setDraft("");
    rite.reset();
  }

  async function giveLife() {
    if (!soul) return;
    setSaving(true);
    try {
      await rite.giveLife(soul, speaker);
      voice.disable();
      // The jump: everything streaks past, then the drift comes back around someone new.
      await animate(warp, 1, { duration: 1.3, ease: [0.55, 0, 0.9, 0.4] });
      await animate(warp, 0, { duration: 2.4, ease: [0.1, 0.8, 0.2, 1] });
    } catch (err) {
      rite.showProblem(err instanceof Error ? err.message : "Could not save the soul");
    } finally {
      setSaving(false);
    }
  }

  const ringScale = isMobile ? (inConversation ? 0.42 : 0.72) : inConversation ? 0.62 : 1;
  const ringDrop = !inConversation ? "calc(50dvh - 72%)" : isMobile ? "-5.5rem" : "-3.75rem";

  return (
    <div
      onPointerMove={onPointerMove}
      className="fixed inset-0 overflow-hidden bg-[#030408] text-text-primary font-body select-text"
    >
      <SpaceScene lookX={lookX} lookY={lookY} warp={warp} focusY={FOCUS_Y} />
      {inConversation && (
        // Stars thin out behind the words, so nothing bright lands on a letter.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 w-[min(100%,60rem)] -translate-x-1/2 bg-[linear-gradient(90deg,transparent,rgba(3,4,8,0.62)_20%,rgba(3,4,8,0.62)_80%,transparent)]"
        />
      )}

      <Link
        to="/chat"
        aria-label="Leave"
        title="Leave"
        className="absolute right-3 top-3 z-30 inline-flex size-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-white/8 hover:text-text-primary [margin-top:var(--safe-top)]"
      >
        <X size={16} strokeWidth={1.5} />
      </Link>

      <div className="relative z-10 flex h-full flex-col">
        {/* The ring floats above the conversation, on a layer that answers the pointer more than the text does. */}
        <motion.div style={{ x: ringX, y: ringY }} className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center">
          <motion.div initial={false} animate={{ y: ringDrop, scale: ringScale }} transition={FLOAT}>
            <div className="relative animate-zero-g motion-reduce:animate-none [animation-duration:23s]" style={{ width: RING_SIZE, height: RING_SIZE }}>
              <FacetOrbit facets={facets} showLabels={!isMobile} spread={1.5} labelScale={1 / ringScale} />
              <button
                type="button"
                onClick={voice.tap}
                disabled={!speakingAloud}
                aria-label={speakingAloud ? "Interrupt or finish talking" : "The agent"}
                className="pointer-events-auto absolute inset-0 z-2 rounded-full border-none bg-transparent p-0 disabled:cursor-default enabled:cursor-pointer"
              >
                <VoiceRing
                  size={RING_SIZE}
                  theme="dark"
                  state={ringState}
                  hoverBend={!speakingAloud}
                  stream={listening ? voice.micStream : null}
                  analyser={voice.phase === "speaking" || voice.auditioning ? voice.playbackAnalyser : null}
                  sensitivity={listening ? MIC_SENSITIVITY : PLAYBACK_SENSITIVITY}
                  level={typingLevel}
                  aria-label={facets.name ?? "The agent"}
                />
              </button>
              <AnimatePresence>
                {facets.name && (
                  <motion.p
                    key={facets.name}
                    initial={{ opacity: 0, filter: "blur(6px)" }}
                    animate={{ opacity: 1, filter: "blur(0px)" }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 1.6 }}
                    className="pointer-events-none absolute inset-0 z-3 m-0 flex items-center justify-center text-[22px] font-medium tracking-[-0.01em] text-text-primary"
                  >
                    {facets.name}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>

        <AnimatePresence mode="wait" initial={false}>
          {arrival && (
            <motion.div
              key="arrival"
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.8 }}
              className="absolute inset-x-0 top-[calc(50dvh+6.5rem)] z-20 flex flex-col items-center gap-6 px-6 text-center md:top-[calc(50dvh+10rem)]"
            >
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 2.2, delay: 0.5 }}
                className="m-0 max-w-[26rem] text-pretty text-[20px] leading-[1.45] tracking-[-0.012em] text-text-primary md:text-[23px]"
              >
                Something out here is waiting to become someone.
              </motion.p>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 1.6, delay: 1.5 }}
                className="flex flex-wrap items-center justify-center gap-2.5"
              >
                <Button variant="primary" onClick={() => void rite.begin()}>Begin</Button>
                {voiceReady && (
                  <Button variant="outline" onClick={beginWithVoice}>
                    <AudioLines size={16} strokeWidth={1.5} />
                    Begin with voice
                  </Button>
                )}
              </motion.div>
              {error && <p role="alert" className="m-0 max-w-[30rem] text-sm text-error">{error}</p>}
            </motion.div>
          )}

          {returning && (
            <motion.div
              key="returning"
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.8 }}
              className="absolute inset-x-0 top-[calc(50dvh+6.5rem)] z-20 flex flex-col items-center gap-6 px-6 text-center md:top-[calc(50dvh+10rem)]"
            >
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 1.8, delay: 0.3 }}
                className="m-0 max-w-[26rem] text-pretty text-[20px] leading-[1.45] tracking-[-0.012em] text-text-primary md:text-[23px]"
              >
                {facets.name ? `${facets.name} is still here.` : "It is still here."}
              </motion.p>
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <Button variant="primary" onClick={rite.resume}>Continue</Button>
                <Button variant="outline" onClick={startOver}>
                  {confirmingReset ? "Yes, forget this conversation" : "Start over"}
                </Button>
              </div>
            </motion.div>
          )}

          {born && soul && (
            <motion.div
              key="born"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 2.4, delay: 1.6 }}
              className="absolute inset-x-0 top-[calc(50dvh+6.5rem)] bottom-0 z-20 flex flex-col items-center gap-6 overflow-y-auto px-6 pb-8 text-center md:top-[calc(50dvh+10rem)]"
            >
              <p className="m-0 text-[20px] leading-[1.45] tracking-[-0.012em] text-text-primary md:text-[23px]">
                {soul.name} is awake.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <Button variant="primary" onClick={() => navigate("/chat")}>Talk to {soul.name}</Button>
                <Button variant="outline" onClick={rite.reset}>Run it again</Button>
              </div>
              <NextSteps name={soul.name} voiceReady={voiceReady} />
            </motion.div>
          )}
        </AnimatePresence>

        {inConversation && (
          <motion.main
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.4 }}
            style={{ x: textX, y: textY }}
            className="flex min-h-0 flex-1 flex-col pt-[clamp(8.5rem,24dvh,13rem)] [padding-bottom:var(--safe-bottom)]"
          >
            <Transcript messages={messages} typingIndex={typingIndex} typed={typed}>
              {choosingSpeaker && !busy && !typing && (
                <VoicePicker
                  name={facets.name}
                  playing={voice.auditioning}
                  onTry={voice.audition}
                  onPick={(picked) => void rite.chooseSpeaker(picked)}
                />
              )}
              {choice && !busy && !typing && (
                <ChoiceCards options={choice} onPick={(option) => void rite.say(`This one: "${option}"`)} />
              )}
              {soul && (soul.content || soul.writing) && (
                <SoulCard soul={soul} saving={saving} onGiveLife={() => void giveLife()} />
              )}
              {soul && !soul.writing && soul.content && (
                <SoulTrial
                  key={soul.content}
                  soul={soul.content.trim()}
                  name={soul.name}
                  onBusy={setTesting}
                  onReport={(report) => void rite.say(report)}
                />
              )}
            </Transcript>

            <div className="mx-auto w-full max-w-[40rem] px-4 pb-4 md:pb-7">
              {error && <p role="alert" className="m-0 mb-2 px-2 text-sm text-error">{error}</p>}
              <form
                onSubmit={send}
                className="relative flex items-end gap-1 overflow-hidden rounded-[22px] border border-border bg-[#0a0b0f]/80 py-1.5 pl-4 pr-1.5 transition-colors focus-within:border-white/20"
              >
                {/* Fills while you are quiet; full means it sends what you said. Talking again empties it. */}
                {listening && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] origin-left bg-accent transition-transform duration-75 ease-linear"
                    style={{ transform: `scaleX(${voice.quiet})` }}
                  />
                )}
                <label className="sr-only" htmlFor="birthright-reply">Your answer</label>
                <textarea
                  id="birthright-reply"
                  rows={1}
                  autoFocus={!isMobile}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onComposerKey}
                  placeholder={placeholder}
                  className="max-h-40 min-h-8 flex-1 resize-none border-none bg-transparent py-1 text-[15px] leading-6 text-text-primary outline-none [field-sizing:content] placeholder:text-text-muted"
                />
                {(voiceReady || speakingAloud) && <IconButton
                  label={speakingAloud ? "Turn voice off" : "Turn voice on"}
                  aria-pressed={speakingAloud}
                  onClick={() => (speakingAloud ? voice.disable() : void voice.enable())}
                  className={`size-8 rounded-full ${speakingAloud ? "!bg-accent/15 !text-accent-ink" : ""}`}
                >
                  <AudioLines size={16} strokeWidth={1.5} />
                </IconButton>}
                <button
                  type="submit"
                  aria-label="Send"
                  disabled={!draft.trim() || busy}
                  className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-accent text-on-accent transition-opacity disabled:cursor-default disabled:bg-raised disabled:text-text-muted"
                >
                  <ArrowUp size={16} strokeWidth={2} />
                </button>
              </form>
            </div>
          </motion.main>
        )}
      </div>
    </div>
  );
}
