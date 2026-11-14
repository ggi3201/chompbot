/** Only explicitly configured HTTP(S) origins may escape the artifact sandbox. */
export function allowedEmbedUrl(url: string, appOrigin: string): string | null {
  const origins = (import.meta.env.VITE_EMBED_ALLOWED_ORIGINS ?? "").split(",").map((origin: string) => origin.trim()).filter(Boolean);
  try {
    const target = new URL(url);
    if (!["https:", "http:"].includes(target.protocol) || target.origin === appOrigin) return null;
    return origins.includes(target.origin) ? target.href : null;
  } catch {
    return null;
  }
}
