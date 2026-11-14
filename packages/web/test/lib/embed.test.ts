import { afterEach, expect, test, vi } from "vitest";
import { allowedEmbedUrl } from "../../src/lib/embed";

afterEach(() => vi.unstubAllEnvs());
const app = "https://chomp.example.com";

test("embeds are disabled without an allowlist", () => {
  vi.stubEnv("VITE_EMBED_ALLOWED_ORIGINS", "");
  expect(allowedEmbedUrl("https://remote.example.com/page", app)).toBeNull();
});

test("allows exact configured origins including ports", () => {
  vi.stubEnv("VITE_EMBED_ALLOWED_ORIGINS", " https://remote.example.com:8451,https://other.example.com ");
  expect(allowedEmbedUrl("https://remote.example.com:8451/page", app)).toBe("https://remote.example.com:8451/page");
  expect(allowedEmbedUrl("https://remote.example.com/page", app)).toBeNull();
  expect(allowedEmbedUrl("https://remote.example.com:8451.attacker.example/page", app)).toBeNull();
});

test("blocks same-origin and non-HTTP URLs even if listed", () => {
  vi.stubEnv("VITE_EMBED_ALLOWED_ORIGINS", `${app},null,ftp://remote.example.com`);
  expect(allowedEmbedUrl(`${app}/page`, app)).toBeNull();
  expect(allowedEmbedUrl("javascript:alert(1)", app)).toBeNull();
  expect(allowedEmbedUrl("ftp://remote.example.com/page", app)).toBeNull();
});
