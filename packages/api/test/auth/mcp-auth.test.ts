import { readFileSync } from "fs";
import { dirname, join } from "path";
import type { NextFunction, Request, Response } from "express";
import { afterEach, expect, test, vi } from "vitest";

const request = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as unknown as Request;

async function middleware(secret?: string) {
  vi.resetModules();
  if (secret) process.env.CHOMP_MCP_SECRET = secret;
  else delete process.env.CHOMP_MCP_SECRET;
  return (await import("../../src/auth/middleware.js")).mcpAuthMiddleware;
}

function verdict(mw: (req: Request, res: Response, next: NextFunction) => void, req: Request): number {
  let status = 200;
  const res = { status: (code: number) => ((status = code), res), json: () => res } as unknown as Response;
  mw(req, res, (() => {}) as NextFunction);
  return status;
}

afterEach(() => {
  delete process.env.CHOMP_MCP_SECRET;
});

test("the header must match the secret, wherever the request comes from", async () => {
  const mw = await middleware("s3cret");
  expect(verdict(mw, request("127.0.0.1"))).toBe(401);
  expect(verdict(mw, request("127.0.0.1", { "x-chomp-mcp-secret": "wrong" }))).toBe(401);
  expect(verdict(mw, request("172.18.0.4", { "x-chomp-mcp-secret": "s3cret" }))).toBe(200);
});

test("without CHOMP_MCP_SECRET Chomp makes one, puts it in its environment, and a local request without it is refused", async () => {
  const mw = await middleware();
  const generated = readFileSync(join(dirname(process.env.DB_PATH!), ".mcp-secret"), "utf8").trim();
  expect(generated).toMatch(/^[0-9a-f]{64}$/);
  expect(process.env.CHOMP_MCP_SECRET).toBe(generated);
  expect(verdict(mw, request("127.0.0.1"))).toBe(401);
  expect(verdict(mw, request("127.0.0.1", { "x-chomp-mcp-secret": generated }))).toBe(200);
});
