import type { Env, AdminConfig } from "./utils/types";
import { hashPassword, verifyPassword } from "./utils/crypto";

export { hashPassword, verifyPassword };

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
