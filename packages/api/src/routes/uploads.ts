import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { join, extname } from "path";

const router: ReturnType<typeof Router> = Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./data/uploads";
mkdirSync(UPLOADS_DIR, { recursive: true });

// Hard cap so a malformed client can't push arbitrary bytes to disk.
// The express body-parser limit (set in index.ts) is the outer wall; this is the inner.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Fallback extensions for common MIME types when the client doesn't send a filename.
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/json": "json",
  "application/zip": "zip",
};

function sanitizeFilename(name: string): string {
  const base = name.replace(/[\/\\]/g, "_").replace(/[\x00-\x1f]/g, "");
  return base.slice(-120) || "file";
}

function extFromNameOrMime(name: string | undefined, mimeType: string): string {
  if (name) {
    const e = extname(name).replace(/^\./, "").toLowerCase();
    if (e) return e;
  }
  return MIME_TO_EXT[mimeType] ?? "bin";
}

router.post("/", (req: Request, res: Response) => {
  const { data, mimeType, name } = req.body as {
    data?: string;
    mimeType?: string;
    name?: string;
  };
  if (!data || !mimeType) {
    res.status(400).json({ error: "Missing data or mimeType" });
    return;
  }

  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    res.status(400).json({ error: "Empty file" });
    return;
  }
  if (buffer.length > MAX_FILE_BYTES) {
    res.status(413).json({ error: `File too large (max ${MAX_FILE_BYTES} bytes)` });
    return;
  }

  const ext = extFromNameOrMime(name, mimeType);
  const storedFilename = `${randomUUID()}.${ext}`;
  const filePath = join(UPLOADS_DIR, storedFilename);
  writeFileSync(filePath, buffer);

  const displayName = name ? sanitizeFilename(name) : storedFilename;

  res.status(201).json({
    url: `/api/uploads/${storedFilename}`,
    name: displayName,
    mimeType,
    size: buffer.length,
  });
});

export { UPLOADS_DIR };
export default router;
