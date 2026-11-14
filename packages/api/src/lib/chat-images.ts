import { copyFileSync, existsSync, realpathSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { extname, join, sep } from "path";
import { UPLOADS_DIR } from "../routes/uploads.js";

// /api/uploads is public with no auth, so only images from these folders may be copied in.
const ALLOWED_ROOTS = [join(homedir(), "chomp-work"), "/tmp"];
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const MAX_BYTES = 10 * 1024 * 1024;
const MD_IMAGE = /!\[([^\]]*)\]\((\/[^)\s]+)((?:\s+"[^"]*")?)\)/g;

/**
 * Agents sometimes link an image by server path (`![x](/home/.../a.png)`), which no browser can open.
 * Copy such a file (image, inside an allowed root, under the size cap) into uploads under a UUID
 * name and point the link at /api/uploads. Anything else is left exactly as written.
 */
export function publishLocalImages(
  content: string,
  opts: { roots?: string[]; uploadsDir?: string } = {},
): string {
  if (!content.includes("![")) return content;
  const roots = (opts.roots ?? ALLOWED_ROOTS).flatMap((r) => { try { return [realpathSync(r)]; } catch { return []; } });
  const uploadsDir = opts.uploadsDir ?? UPLOADS_DIR;
  return content.replace(MD_IMAGE, (whole, alt: string, src: string, title: string) => {
    const ext = extname(src).toLowerCase();
    if (src.startsWith("/api/") || !IMAGE_EXTS.has(ext) || !existsSync(src)) return whole;
    try {
      const real = realpathSync(src); // resolves ../ and symlinks, so neither can escape the roots
      if (!roots.some((r) => real.startsWith(r + sep))) return whole;
      const st = statSync(real);
      if (!st.isFile() || st.size > MAX_BYTES) return whole;
      const name = `${randomUUID()}${ext}`;
      copyFileSync(real, join(uploadsDir, name));
      return `![${alt}](/api/uploads/${name}${title})`;
    } catch {
      return whole;
    }
  });
}
