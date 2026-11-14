import { Router, type Request, type Response } from "express";
import { getAuthUrl, handleCallback, getAccessToken, isConnected, disconnect } from "../integrations/spotify/auth.js";
import { authMiddleware } from "../auth/middleware.js";
import { issueOAuthState, takeOAuthState } from "../lib/oauth-state.js";

const router: ReturnType<typeof Router> = Router();

/** GET /api/spotify/callback — OAuth callback (redirected from Spotify, public) */
router.get("/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  // Only a login this Chomp started counts, and the browser goes back only where that login came from.
  const frontend = takeOAuthState(req.query.state);
  if (!frontend) {
    res.status(400).send("This login was not started here or has expired. Start it again from Settings.");
    return;
  }

  const result = await handleCallback(code);
  if (result.success) {
    res.redirect(`${frontend}/settings?spotify=connected`);
  } else {
    res.status(400).send(`OAuth failed: ${result.error}`);
  }
});

// All other endpoints need auth
router.use(authMiddleware);

/** GET /api/spotify/auth-url — get OAuth consent URL */
router.get("/auth-url", (req: Request, res: Response) => {
  const origin =
    req.get("origin") ??
    (req.get("referer") ? new URL(req.get("referer")!).origin : undefined) ??
    process.env.CHOMP_FRONTEND_URL ??
    `${req.protocol}://${req.get("host")}`;

  const url = getAuthUrl(issueOAuthState(origin));
  res.json({ url });
});

/** GET /api/spotify/status — check connection status */
router.get("/status", (_req: Request, res: Response) => {
  res.json({ connected: isConnected() });
});

/** POST /api/spotify/disconnect — remove tokens */
router.post("/disconnect", (_req: Request, res: Response) => {
  disconnect();
  res.json({ status: "disconnected" });
});

/** GET /api/spotify/token — get fresh access token (for agent use) */
router.get("/token", async (_req: Request, res: Response) => {
  const token = await getAccessToken();
  if (!token) {
    res.status(401).json({ error: "Spotify not connected or token expired" });
    return;
  }
  res.json({ token });
});

export default router;
