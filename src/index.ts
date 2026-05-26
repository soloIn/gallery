import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, ContextVars } from "./utils/types";
import { ensureAdminPassword } from "./config";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { galleryRoutes } from "./routes/gallery";

const app = new Hono<{ Bindings: Env; Variables: ContextVars }>();

// Middleware
app.use("*", cors());

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Routes
app.route("/auth", authRoutes);
app.route("/admin", adminRoutes);
app.route("/api", galleryRoutes);

// Static files (public/)
app.get("/*", async (c) => {
  const url = new URL(c.req.url);
  let path = url.pathname;
  if (path === "/") path = "/index.html";

  const asset = await c.env.ASSETS?.fetch(
    new Request(new URL(path, url.origin))
  );
  if (asset && asset.status !== 404) return asset;

  // SPA fallback
  const index = await c.env.ASSETS?.fetch(
    new Request(new URL("/index.html", url.origin))
  );
  if (index) return index;

  return c.text("Not Found", 404);
});

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    await ensureAdminPassword(env);
    return app.fetch(request, env, ctx);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // Import sync service lazily
    const { syncAll } = await import("./services/image-index");
    ctx.waitUntil(syncAll(env));
  },
};
