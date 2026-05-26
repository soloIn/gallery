import type { Env, AdminConfig } from "./utils/types";

const DEFAULT_CONFIG: AdminConfig = {
  password_hash: "",
  sync_interval: "0 */6 * * *",
  rate_limit_rps: 3,
  circuit_breaker_threshold: 3,
};

export async function getConfig(env: Env): Promise<AdminConfig> {
  const stored = await env.KV_CONFIG.get<AdminConfig>("app:config", "json");
  return { ...DEFAULT_CONFIG, ...stored };
}

export async function updateConfig(
  env: Env,
  partial: Partial<AdminConfig>
): Promise<AdminConfig> {
  const current = await getConfig(env);
  const updated = { ...current, ...partial };
  await env.KV_CONFIG.put("app:config", JSON.stringify(updated));
  return updated;
}

export async function ensureAdminPassword(env: Env): Promise<void> {
  const config = await getConfig(env);
  if (!config.password_hash && env.ADMIN_PASS) {
    const hash = await hashPassword(env.ADMIN_PASS);
    await updateConfig(env, { password_hash: hash });
  }
}

export async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(hash);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  const computed = await hashPassword(password);
  return computed === hash;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
