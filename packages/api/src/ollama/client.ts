import { Ollama } from "ollama";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

export const ollama = new Ollama({ host: OLLAMA_HOST });

export async function isOllamaReady(): Promise<boolean> {
  try {
    await ollama.list();
    return true;
  } catch {
    return false;
  }
}
