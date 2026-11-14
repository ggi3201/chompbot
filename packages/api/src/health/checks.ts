import { execSync } from "child_process";
import { getSecret } from "../lib/secrets.js";

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

let lastReport: CheckResult[] = [];

export function getHealthReport(): CheckResult[] {
  return lastReport;
}

function checkCli(name: string, bin: string, authCmd?: string): CheckResult {
  try {
    execSync(`which ${bin}`, { timeout: 5000, stdio: "pipe" });
  } catch {
    return { name, status: "fail", message: "not installed" };
  }
  if (authCmd) {
    try {
      const out = execSync(authCmd, { timeout: 5000, stdio: "pipe" }).toString().trim();
      // Extract username from gh auth status output
      const userMatch = out.match(/Logged in to .+ as (\S+)/);
      return { name, status: "pass", message: userMatch ? `authenticated (${userMatch[1]})` : "authenticated" };
    } catch {
      return { name, status: "warn", message: "installed but not authenticated" };
    }
  }
  return { name, status: "pass", message: "installed" };
}

async function checkHttp(name: string, url: string, detail?: (body: string) => string): Promise<CheckResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { name, status: "fail", message: `HTTP ${res.status}` };
    const body = await res.text();
    const msg = detail ? detail(body) : "reachable";
    return { name, status: "pass", message: msg };
  } catch {
    return { name, status: "fail", message: "unreachable" };
  }
}

function checkApiKey(name: string, envKey: string): CheckResult {
  const val = getSecret(envKey) ?? process.env[envKey];
  if (val) return { name, status: "pass", message: "configured" };
  return { name, status: "fail", message: "missing" };
}

/**
 * Memory embeddings power semantic recall. When the embedding model is missing,
 * saves fail fire-and-forget and every recall silently degrades to a LIKE
 * substring match — a failure mode that went unnoticed for six months. Surface
 * it on the startup report instead.
 */
async function checkMemoryEmbeddings(): Promise<CheckResult> {
  const name = "Memory embeddings";
  try {
    const { isEmbeddingModelReady, embeddingModelId } = await import("../db/embeddings.js");
    const EMBEDDING_MODEL = embeddingModelId();
    const { countMemoriesMissingEmbeddings } = await import("../db/memories.js");

    if (!(await isEmbeddingModelReady())) {
      return {
        name,
        status: "fail",
        message: `model '${EMBEDDING_MODEL}' not ready — semantic recall degraded to substring match (pull it in Ollama, or pick another under Settings → AI and chat)`,
      };
    }

    const { total, missing } = countMemoriesMissingEmbeddings();
    if (missing > 0) {
      return {
        name,
        status: "warn",
        message: `${missing}/${total} memories unembedded — run scripts/backfill-embeddings.ts`,
      };
    }
    return { name, status: "pass", message: `${total} memories embedded (${EMBEDDING_MODEL})` };
  } catch (err) {
    return {
      name,
      status: "warn",
      message: `check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runStartupChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // CLI tools
  results.push(checkCli("claude CLI", "claude", "claude auth status"));
  const ghResult = checkCli("gh CLI", "gh", "gh auth status 2>&1");
  if (ghResult.status === "fail") {
    const glabResult = checkCli("glab CLI", "glab", "glab auth status 2>&1");
    results.push(glabResult.status !== "fail" ? glabResult : ghResult);
  } else {
    results.push(ghResult);
  }
  results.push(checkCli("rg (ripgrep)", "rg"));

  // Services
  const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const ollamaResult = await checkHttp("Ollama", `${ollamaHost}/api/tags`, (body) => {
    try {
      const data = JSON.parse(body);
      return `running (${data.models?.length ?? 0} models)`;
    } catch { return "running"; }
  });
  if (ollamaResult.status === "fail") {
    ollamaResult.message = "unreachable — memory search needs it for embeddings, or pick OpenAI or Gemini embeddings in Settings";
  }
  results.push(ollamaResult);

  results.push(await checkMemoryEmbeddings());

  const searxngUrl = process.env.SEARXNG_URL;
  if (searxngUrl) {
    results.push(await checkHttp("SearXNG", searxngUrl));
  } else {
    results.push({ name: "SearXNG", status: "warn", message: "not configured (SEARXNG_URL)" });
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    results.push({ name: "Redis", status: "pass", message: "configured" });
  } else {
    results.push({ name: "Redis", status: "warn", message: "not configured (no worker)" });
  }

  // API keys
  results.push(checkApiKey("Gemini API key", "GEMINI_API_KEY"));
  results.push(checkApiKey("Kimi API key", "KIMI_API_KEY"));

  lastReport = results;
  printReport(results);
  return results;
}

function printReport(results: CheckResult[]) {
  const icons: Record<string, string> = { pass: "\u2713", fail: "\u2717", warn: "\u26A0" };
  const maxName = Math.max(...results.map((r) => r.name.length));
  const maxMsg = Math.max(...results.map((r) => r.message.length));
  const innerWidth = maxName + maxMsg + 5; // icon + spaces

  const lines = results.map((r) => {
    const icon = icons[r.status];
    const pad = " ".repeat(maxName - r.name.length + 2);
    return `\u2502 ${icon} ${r.name}${pad}${r.message}`;
  });

  // Pad each line to same width for the right border
  const maxLine = Math.max(...lines.map((l) => l.length), innerWidth + 2);
  const paddedLines = lines.map((l) => l + " ".repeat(maxLine - l.length) + " \u2502");

  const title = " Chomp Health Check ";
  const topBorder = `\u256D\u2500${title}${ "\u2500".repeat(maxLine - title.length)}\u256E`;
  const bottomBorder = `\u2570${"\u2500".repeat(maxLine + 2)}\u256F`;

  console.log(topBorder);
  for (const line of paddedLines) {
    console.log(line);
  }
  console.log(bottomBorder);
}
