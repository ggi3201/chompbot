import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import { expect, test } from "vitest";
import { getSiteUrl } from "../../src/agents/tools/sites.js";

test("own web server: the link is on PREVIEW_DOMAIN", () => {
  expect(getSiteUrl("menu", { PREVIEW_DOMAIN: "sites.example.com", CHOMP_DOMAIN: "https://chomp.example.com" })).toBe("https://sites.example.com/menu");
});

test("no setup: Chomp serves the site under /pub on its own address", () => {
  expect(getSiteUrl("menu", { CHOMP_DOMAIN: "https://box.example-tailnet.ts.net/" })).toBe("https://box.example-tailnet.ts.net/pub/menu/");
  expect(getSiteUrl("menu", { PORT: "3002" })).toBe("http://localhost:3002/pub/menu/");
});

test("/pub serves a site's files but never its dotfiles, such as .git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chomp-pub-"));
  mkdirSync(join(dir, "menu", ".git"), { recursive: true });
  writeFileSync(join(dir, "menu", "index.html"), "<h1>Menu</h1>");
  writeFileSync(join(dir, "menu", ".git", "config"), "[remote]");
  const app = express().use("/pub", express.static(dir));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect(await (await fetch(`${base}/pub/menu/`)).text()).toContain("Menu");
    expect((await fetch(`${base}/pub/menu/.git/config`)).status).toBe(404);
    expect((await fetch(`${base}/pub/menu/../../etc/passwd`)).status).toBe(404);
  } finally {
    server.close();
  }
});
