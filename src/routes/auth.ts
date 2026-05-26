import { Hono } from "hono";
import type { Env, ContextVars } from "../utils/types";
import {
  getAuthorizeURL,
  createState,
  validateState,
  exchangeCode,
} from "../services/eleven5";

export const authRoutes = new Hono<{ Bindings: Env; Variables: ContextVars }>();

// Start OAuth flow
authRoutes.get("/115/login", async (c) => {
  const clientId = c.env.ELEVEN5_CLIENT_ID;
  if (!clientId) {
    return c.json({ error: "115 client ID not configured" }, 500);
  }

  const url = new URL(c.req.url);
  const redirectUri = `${url.origin}/auth/115/callback`;
  const state = await createState(c.env);

  const authorizeUrl = getAuthorizeURL(clientId, redirectUri, state);
  return c.redirect(authorizeUrl);
});

// OAuth callback
authRoutes.get("/115/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "Missing code or state parameter" }, 400);
  }

  const valid = await validateState(c.env, state);
  if (!valid) {
    return c.json({ error: "Invalid or expired state parameter" }, 400);
  }

  try {
    await exchangeCode(c.env, code);
    return c.redirect("/#/admin?connected=true");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.redirect(`/#/admin?error=${encodeURIComponent(message)}`);
  }
});

// Check 115 connection status
authRoutes.get("/115/status", async (c) => {
  const { getStoredToken } = await import("../services/eleven5");
  const token = await getStoredToken(c.env);
  return c.json({
    connected: !!token,
    expires_at: token?.expires_at ?? null,
  });
});
