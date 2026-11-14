import { test, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { publishLocalImages } from "../../src/lib/chat-images.js";

let root: string, outside: string, uploads: string, opts: { roots: string[]; uploadsDir: string };

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "chat-images-"));
  root = join(base, "allowed"); outside = join(base, "outside"); uploads = join(base, "uploads");
  [root, outside, uploads].forEach((d) => mkdirSync(d));
  opts = { roots: [root], uploadsDir: uploads };
});

test("an image inside an allowed root is copied under a uuid name and the link rewritten", () => {
  writeFileSync(join(root, "a.png"), "png");
  const out = publishLocalImages(`hi\n![Kulda](${join(root, "a.png")})`, opts);
  expect(out).toMatch(/^hi\n!\[Kulda\]\(\/api\/uploads\/[0-9a-f-]{36}\.png\)$/);
  expect(readdirSync(uploads)).toHaveLength(1);
});

test("a path outside the roots, a symlink out of them, a non-image and a missing file are left alone", () => {
  writeFileSync(join(outside, "secret.png"), "x");
  writeFileSync(join(root, "notes.txt"), "x");
  symlinkSync(join(outside, "secret.png"), join(root, "link.png"));
  for (const src of [join(outside, "secret.png"), join(root, "link.png"), join(root, "notes.txt"), join(root, "nope.png"), "/api/uploads/placeholder.jpg"]) {
    const md = `![x](${src})`;
    expect(publishLocalImages(md, opts)).toBe(md);
  }
  expect(readdirSync(uploads)).toHaveLength(0);
});
