import { createHash, timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { JWT_SECRET, MCP_SECRET } from "./config.js";

export function createToken(opts?: { longLived?: boolean }): string {
  const expiresIn = opts?.longLived ? "365d" : "30d";
  return jwt.sign({ sub: "owner" }, JWT_SECRET, { expiresIn });
}

export function hasValidToken(req: Request): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return false;
  try {
    jwt.verify(authHeader.slice(7), JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization token" });
    return;
  }
  if (!hasValidToken(req)) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  next();
}

/** Compares digests, so the time taken does not depend on how much of the secret was right. */
const digest = (value: string) => createHash("sha256").update(value).digest();

/** For the MCP tool bridge and the worker's internal calls, which carry no login: the X-Chomp-MCP-Secret header must match. */
export function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers["x-chomp-mcp-secret"];
  if (typeof provided === "string" && timingSafeEqual(digest(provided), digest(MCP_SECRET))) {
    next();
    return;
  }
  res.status(401).json({ content: [{ type: "text", text: "Invalid or missing MCP secret" }], isError: true });
}
