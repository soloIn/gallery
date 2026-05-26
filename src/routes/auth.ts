import { Hono } from "hono";
import type { Env, ContextVars } from "../utils/types";

export const authRoutes = new Hono<{ Bindings: Env; Variables: ContextVars }>();
