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

// --- Directory Management ---

// List configured directories
adminRoutes.get("/directories", async (c) => {
  const { getDirectories } = await import("../db/queries");
  const dirs = await getDirectories(c.env.DB);
  return c.json(dirs);
});

// Add directory
adminRoutes.post("/directories", async (c) => {
  const { upsertDirectory, getDirectory } = await import("../db/queries");
  const { listDirectory } = await import("../services/eleven5");

  const body = await c.req.json<{
    dir_id: string;
    name?: string;
    include_subdirs?: boolean;
  }>();

  if (!body.dir_id) {
    return c.json({ error: "dir_id is required" }, 400);
  }

  // Check if already configured
  const existing = await getDirectory(c.env.DB, body.dir_id);
  if (existing) {
    return c.json({ error: "Directory already configured" }, 409);
  }

  // Validate directory exists in 115
  try {
    const result = await listDirectory(c.env, body.dir_id, 0, 1);
    if (result.errno !== 0) {
      return c.json({ error: "Invalid directory ID" }, 400);
    }
  } catch {
    return c.json({ error: "Failed to validate directory with 115 API" }, 400);
  }

  await upsertDirectory(c.env.DB, {
    dir_id: body.dir_id,
    name: body.name ?? "",
    include_subdirs: body.include_subdirs ? 1 : 0,
  });

  return c.json({ success: true });
});

// Delete directory
adminRoutes.delete("/directories/:id", async (c) => {
  const { deleteDirectory, getDirectory } = await import("../db/queries");
  const dirId = c.req.param("id");

  const existing = await getDirectory(c.env.DB, dirId);
  if (!existing) {
    return c.json({ error: "Directory not found" }, 404);
  }

  await deleteDirectory(c.env.DB, dirId);
  return c.json({ success: true });
});

// Browse 115 directory tree
adminRoutes.get("/browse", async (c) => {
  const { browseDirectory } = await import("../services/eleven5");
  const cid = c.req.query("cid");

  if (!cid) {
    return c.json({ error: "cid parameter required" }, 400);
  }

  const subdirs = await browseDirectory(c.env, cid);
  return c.json(subdirs);
});

// Trigger manual sync
adminRoutes.post("/sync", async (c) => {
  const { syncAll } = await import("../services/image-index");
  c.executionCtx.waitUntil(syncAll(c.env));
  return c.json({ success: true, message: "Sync started" });
});

// Get settings
adminRoutes.get("/settings", async (c) => {
  const { getConfig } = await import("../config");
  const config = await getConfig(c.env);
  return c.json({
    sync_interval: config.sync_interval,
    rate_limit_rps: config.rate_limit_rps,
    circuit_breaker_threshold: config.circuit_breaker_threshold,
  });
});

// Update settings
adminRoutes.put("/settings", async (c) => {
  const { updateConfig } = await import("../config");

  const body = await c.req.json<{
    sync_interval?: string;
    rate_limit_rps?: number;
    circuit_breaker_threshold?: number;
  }>();

  await updateConfig(c.env, body);
  return c.json({ success: true });
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
