import { createMiddleware } from "hono/factory";
import type { Env, ContextVars } from "../utils/types";
import { getConfig } from "../config";
import { hashToken, timingSafeEqual } from "../utils/crypto";

export const apiAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: ContextVars;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  if (!token) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const config = await getConfig(c.env);
  const tokens = config.api_tokens ?? [];
  if (tokens.length === 0) {
    return c.json({ error: "Invalid API token" }, 401);
  }

  const tokenHash = await hashToken(token);
  const valid = tokens.some((stored) => timingSafeEqual(tokenHash, stored));

  if (!valid) {
    return c.json({ error: "Invalid API token" }, 401);
  }

  await next();
});
