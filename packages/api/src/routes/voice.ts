import { Router, type Request, type Response } from "express";
import { getApiKey } from "../chat/providers.js";

const router: ReturnType<typeof Router> = Router();

export const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const OPENAI_STT_URL = "https://api.openai.com/v1/audio/transcriptions";

export const VALID_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] as const;
const DEFAULT_VOICE = "coral";
// gpt-4o-mini-transcribe shuts down 2027-02-26; gpt-transcribe is its named replacement on the same endpoint.
const DEFAULT_STT_MODEL = "gpt-transcribe";
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";

const MIME_TO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-m4a": "m4a",
  "audio/mp4;codecs=opus": "mp4",
  "audio/webm;codecs=opus": "webm",
};

/** Speech to text through OpenAI. Throws when it is not configured or the request fails. */
export async function transcribeAudio(audio: Buffer, mimeType: string): Promise<string> {
  const apiKey = getApiKey("openai");
  if (!apiKey) throw new Error("OpenAI API key not configured");

  const baseMime = mimeType.split(";")[0].trim();
  const ext = MIME_TO_EXT[mimeType] ?? MIME_TO_EXT[baseMime] ?? "webm";

  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `recording.${ext}`);
  formData.append("model", DEFAULT_STT_MODEL);

  const response = await fetch(OPENAI_STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  if (!response.ok) throw new Error(`OpenAI responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return ((await response.json()) as { text: string }).text;
}

/**
 * POST /api/voice/tts
 * Body: { text: string, voice?: string, instructions?: string }
 * Returns: streaming audio/mp3
 */
router.post("/tts", async (req: Request, res: Response) => {
  const apiKey = getApiKey("openai");
  if (!apiKey) {
    res.status(400).json({ error: "OpenAI API key not configured" });
    return;
  }

  const { text, voice, instructions } = req.body;
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const selectedVoice = VALID_VOICES.includes(voice) ? voice : DEFAULT_VOICE;

  try {
    const response = await fetch(OPENAI_TTS_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_TTS_MODEL,
        input: text,
        voice: selectedVoice,
        ...(typeof instructions === "string" ? { instructions } : {}),
        response_format: "mp3",
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("[voice/tts] OpenAI error:", response.status, err);
      res.status(502).json({ error: "TTS request failed" });
      return;
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Transfer-Encoding", "chunked");

    const reader = response.body?.getReader();
    if (!reader) {
      res.status(502).json({ error: "No response body" });
      return;
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error("[voice/tts] Error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/**
 * POST /api/voice/transcribe
 * Body: { data: string (base64 audio), mimeType: string }
 * Returns: { text: string }
 */
router.post("/transcribe", async (req: Request, res: Response) => {
  const apiKey = getApiKey("openai");
  if (!apiKey) {
    res.status(400).json({ error: "OpenAI API key not configured" });
    return;
  }

  const { data, mimeType } = req.body;
  if (!data || !mimeType) {
    res.status(400).json({ error: "data (base64) and mimeType are required" });
    return;
  }


  try {
    res.json({ text: await transcribeAudio(Buffer.from(data, "base64"), mimeType) });
  } catch (err) {
    console.error("[voice/transcribe] Error:", err);
    res.status(502).json({ error: "Transcription request failed" });
  }
});

/** GET /api/voice/status — whether speech works here, so pages can leave voice out until an OpenAI key is set. */
router.get("/status", (_req: Request, res: Response) => {
  res.json({ available: Boolean(getApiKey("openai")) });
});

/** GET /api/voice/voices — list available TTS voices */
router.get("/voices", (_req: Request, res: Response) => {
  res.json({ voices: VALID_VOICES, default: DEFAULT_VOICE });
});

export default router;
