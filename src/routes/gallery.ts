import { Hono } from "hono";
import type { Env, ContextVars, GalleryImageResponse, GalleryMetaResponse } from "../utils/types";
import {
  getNextImage,
  getRandomUnseenImage,
  getClientState,
  setClientState,
  getImageCount,
} from "../db/queries";
import { getDownloadURL } from "../services/eleven5";

export const galleryRoutes = new Hono<{
  Bindings: Env;
  Variables: ContextVars;
}>();

const MAX_SEEN_IMAGES = 500;

// Helper to extract and validate client param
function getClient(c: any): string | null {
  return c.req.query("client") ?? null;
}

// GET /api/image/next?client={id}
galleryRoutes.get("/image/next", async (c) => {
  const clientId = getClient(c);
  if (!clientId) {
    return c.json({ error: "client parameter required" }, 400);
  }

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
});

// GET /api/image/random?client={id}
galleryRoutes.get("/image/random", async (c) => {
  const clientId = getClient(c);
  if (!clientId) {
    return c.json({ error: "client parameter required" }, 400);
  }

  const state = await getClientState(c.env.DB, clientId);
  const seenIds: string[] = JSON.parse(state.seen_images || "[]");
  const total = await getImageCount(c.env.DB);

  if (total === 0) {
    return c.json({ error: "No images available" }, 404);
  }

  let recycled = false;
  let currentSeen = [...seenIds];

  // Reset seen list if all images have been shown
  if (currentSeen.length >= total || currentSeen.length >= MAX_SEEN_IMAGES) {
    currentSeen = [];
    recycled = true;
  }

  const image = await getRandomUnseenImage(c.env.DB, currentSeen);

  if (!image) {
    // All images seen, reset and try again
    currentSeen = [];
    const retryImage = await getRandomUnseenImage(c.env.DB, currentSeen);
    if (!retryImage) {
      return c.json({ error: "No images available" }, 404);
    }

    currentSeen.push(retryImage.file_id);
    await setClientState(c.env.DB, clientId, {
      seen_images: JSON.stringify(currentSeen),
    });

    const url = await getDownloadURL(c.env, retryImage.pick_code);
    const response: GalleryImageResponse = {
      url,
      name: retryImage.name,
      remaining: total - currentSeen.length,
      total,
      recycled: true,
    };
    return c.json(response);
  }

  currentSeen.push(image.file_id);
  await setClientState(c.env.DB, clientId, {
    seen_images: JSON.stringify(currentSeen),
  });

  const url = await getDownloadURL(c.env, image.pick_code);
  const response: GalleryImageResponse = {
    url,
    name: image.name,
    remaining: total - currentSeen.length,
    total,
    recycled,
  };

  return c.json(response);
});

// GET /api/image/meta?client={id}
galleryRoutes.get("/image/meta", async (c) => {
  const clientId = getClient(c);
  if (!clientId) {
    return c.json({ error: "client parameter required" }, 400);
  }

  const state = await getClientState(c.env.DB, clientId);
  const seenIds: string[] = JSON.parse(state.seen_images || "[]");
  const total = await getImageCount(c.env.DB);

  const response: GalleryMetaResponse = {
    total,
    currentIndex: state.last_index,
    seenCount: seenIds.length,
  };

  return c.json(response);
});
