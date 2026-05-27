import { createMiddleware } from "hono/factory";
import type { Env, ContextVars } from "../utils/types";

const SESSION_PREFIX = "session:";

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: ContextVars;
}>(async (c, next) => {
  const sessionToken =
    extractCookieSession(c.req.header("Cookie")) ??
    extractBearerToken(c.req.header("Authorization"));

  if (!sessionToken) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const sessionData = await c.env.KV_SESSION.get(
    `${SESSION_PREFIX}${sessionToken}`
  );
  if (!sessionData) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  c.set("admin", true);
  await next();
});

export function extractCookieSession(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  return match?.[1] ?? null;
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

export async function createSession(env: Env): Promise<string> {
  const token = crypto.randomUUID();
  await env.KV_SESSION.put(`${SESSION_PREFIX}${token}`, "active", {
    expirationTtl: 86400, // 24 hours
  });
  return token;
}

export async function deleteSession(
  env: Env,
  token: string
): Promise<void> {
  await env.KV_SESSION.delete(`${SESSION_PREFIX}${token}`);
}
