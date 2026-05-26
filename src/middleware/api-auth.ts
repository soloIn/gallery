import { createMiddleware } from "hono/factory";
import type { Env, ContextVars } from "../utils/types";
import { getConfig } from "../config";

export const apiAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: ContextVars;
}>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const config = await getConfig(c.env);

  if (!config.api_tokens.includes(token)) {
    return c.json({ error: "Invalid API token" }, 401);
  }

  await next();
});
