import type { Env, AdminConfig } from "./utils/types";
import { hashPassword, verifyPassword } from "./utils/crypto";

export { hashPassword, verifyPassword };

const DEFAULT_CONFIG: AdminConfig = {
  password_hash: "",
  sync_interval: "0 */6 * * *",
  rate_limit_rps: 3,
  circuit_breaker_threshold: 3,
  eleven5_client_id: "",
  eleven5_client_secret: "",
  api_tokens: [],
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
  if (!env.ADMIN_PASS) return;
  const config = await getConfig(env);
  if (!config.password_hash) {
    await updateConfig(env, { password_hash: await hashPassword(env.ADMIN_PASS) });
  } else {
    const matches = await verifyPassword(env.ADMIN_PASS, config.password_hash);
    if (!matches) {
      await updateConfig(env, { password_hash: await hashPassword(env.ADMIN_PASS) });
    }
  }
}
