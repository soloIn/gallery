import { Hono } from "hono";
import type { Env, ContextVars } from "../utils/types";
import { getConfig, verifyPassword, ensureAdminPassword } from "../config";
import { authMiddleware, createSession, deleteSession } from "../middleware/auth";

export const adminRoutes = new Hono<{
  Bindings: Env;
  Variables: ContextVars;
}>();

// Login (no auth required)
adminRoutes.post("/login", async (c) => {
  await ensureAdminPassword(c.env);

  const { username, password } = await c.req.json<{ username: string; password: string }>();

  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  // For v1, only "admin" username is supported
  if (username !== "admin") {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const config = await getConfig(c.env);
  if (!config.password_hash) {
    return c.json({ error: "Admin password not configured" }, 500);
  }

  const valid = await verifyPassword(password, config.password_hash);
  if (!valid) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const sessionToken = await createSession(c.env);

  c.header(
    "Set-Cookie",
    `session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`
  );

  return c.json({ success: true });
});

// Logout
adminRoutes.post("/logout", async (c) => {
  const sessionToken =
    extractCookieSession(c.req.header("Cookie")) ??
    extractBearerToken(c.req.header("Authorization"));

  if (sessionToken) {
    await deleteSession(c.env, sessionToken);
  }

  c.header("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
  return c.json({ success: true });
});

// All routes below require auth
adminRoutes.use("/*", authMiddleware);

// Check session status
adminRoutes.get("/me", (c) => {
  return c.json({ authenticated: true });
});

function extractCookieSession(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  return match?.[1] ?? null;
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}
