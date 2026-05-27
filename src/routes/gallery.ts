import { Hono } from "hono";
import type { Env, ContextVars, GalleryImageResponse, GalleryMetaResponse } from "../utils/types";
import {
  getNextImage,
  getRandomImage,
  getClientState,
  setClientState,
  getImageCount,
} from "../db/queries";
import { getDownloadURL } from "../services/eleven5";
import { CloudflareLimitError, isCloudflareLimitError } from "../utils/cloudflare-errors";

export const galleryRoutes = new Hono<{
  Bindings: Env;
  Variables: ContextVars;
}>();

// Helper to extract and validate client param
function getClient(c: any): string | null {
  return c.req.query("client") ?? null;
}

// Helper to handle Cloudflare limit errors
function handleLimitError(err: unknown): Response {
  if (isCloudflareLimitError(err)) {
    const cfErr = err instanceof CloudflareLimitError ? err : new CloudflareLimitError("d1_read", String(err));
    return new Response(
      JSON.stringify({ error: "Service temporarily unavailable", retryAfter: cfErr.retryAfter }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(cfErr.retryAfter),
        },
      }
    );
  }
  throw err;
}

// GET /api/image/next?client={id}
galleryRoutes.get("/image/next", async (c) => {
  const clientId = getClient(c);
  if (!clientId) {
    return c.json({ error: "client parameter required" }, 400);
  }

  try {
    const state = await getClientState(c.env.DB, clientId);
    const { image, nextIndex } = await getNextImage(c.env.DB, state.last_index);

    if (!image) {
      return c.json({ error: "No images available" }, 404);
    }

    // Update client state
    await setClientState(c.env.DB, clientId, { last_index: nextIndex });

    // Get download URL
    const url = await getDownloadURL(c.env, image.pick_code);
    const total = await getImageCount(c.env.DB);

    const response: GalleryImageResponse = {
      url,
      name: image.name,
      index: state.last_index,
      total,
    };

    return c.json(response);
  } catch (err) {
    return handleLimitError(err);
  }
});

// GET /api/image/random?client={id}
galleryRoutes.get("/image/random", async (c) => {
  const clientId = getClient(c);
  if (!clientId) {
    return c.json({ error: "client parameter required" }, 400);
  }

  try {
    const state = await getClientState(c.env.DB, clientId);
    const total = await getImageCount(c.env.DB);

    if (total === 0) {
      return c.json({ error: "No images available" }, 404);
    }

    // Random cursor: jump by random offset from current position
    const maxOffset = Math.max(1, Math.floor(total / 10));
    const offset = 1 + Math.floor(Math.random() * maxOffset);
    const nextIndex = (state.last_index + offset) % total;

    const image = await getRandomImage(c.env.DB, nextIndex);

    if (!image) {
      return c.json({ error: "No images available" }, 404);
    }

    await setClientState(c.env.DB, clientId, { last_index: nextIndex });

    const url = await getDownloadURL(c.env, image.pick_code);
    const response: GalleryImageResponse = {
      url,
      name: image.name,
      index: nextIndex,
      total,
    };

    return c.json(response);
  } catch (err) {
    return handleLimitError(err);
  }
});

// GET /api/image/meta?client={id}
galleryRoutes.get("/image/meta", async (c) => {
  const clientId = getClient(c);
  if (!clientId) {
    return c.json({ error: "client parameter required" }, 400);
  }

  try {
    const state = await getClientState(c.env.DB, clientId);
    const total = await getImageCount(c.env.DB);

    const response: GalleryMetaResponse = {
      total,
      currentIndex: state.last_index,
      seenCount: 0, // seen tracking removed
    };

    return c.json(response);
  } catch (err) {
    return handleLimitError(err);
  }
});
