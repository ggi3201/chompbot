import express from "express";
import { afterAll, beforeAll, expect, test } from "vitest";
import voiceRoutes from "../../src/routes/voice.js";
import { serve } from "../monitoring/helpers.js";

let api: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  const app = express();
  app.use("/api/voice", voiceRoutes);
  api = await serve(app);
});
afterAll(() => api.close());

const status = async () => (await (await fetch(`${api.url}/api/voice/status`)).json()) as { available: boolean };

test("voice is available only when an OpenAI key is configured", async () => {
  const saved = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    expect(await status()).toEqual({ available: false });
    process.env.OPENAI_API_KEY = "sk-test";
    expect(await status()).toEqual({ available: true });
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});
