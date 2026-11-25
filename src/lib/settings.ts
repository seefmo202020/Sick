import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { decryptText, encryptText, maskSecret } from "./crypto";

export const SETTING_KEYS = [
  "google_client_id",
  "google_client_secret",
  "app_base_url",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const SECRET_KEYS = new Set<SettingKey>(["google_client_secret"]);

const ENV_MAP: Record<SettingKey, string> = {
  google_client_id: "GOOGLE_CLIENT_ID",
  google_client_secret: "GOOGLE_CLIENT_SECRET",
  app_base_url: "APP_BASE_URL",
};

export interface RuntimeConfig {
  googleClientId: string;
  googleClientSecret: string;
  appBaseUrl: string;
  isGoogleConfigured: boolean;
}

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const rows = await db.select().from(appSettings);
  const map = new Map<string, string>();
  for (const row of rows) {
    const val = row.isSecret ? decryptText(row.valueEnc) : row.valueEnc;
    if (val) map.set(row.key, val);
  }

  const pick = (key: SettingKey): string => {
    const dbVal = map.get(key);
    if (dbVal && dbVal.trim().length > 0) return dbVal.trim();
    return (process.env[ENV_MAP[key]] || "").trim();
  };

  const googleClientId = pick("google_client_id");
  const googleClientSecret = pick("google_client_secret");
  const appBaseUrl = pick("app_base_url").replace(/\/+$/, "");

  return {
    googleClientId,
    googleClientSecret,
    appBaseUrl,
    isGoogleConfigured: Boolean(googleClientId && googleClientSecret),
  };
}

export async function getPublicSettingsSummary() {
  const cfg = await getRuntimeConfig();
  return {
    googleClientId: cfg.googleClientId,
    hasGoogleClientSecret: Boolean(cfg.googleClientSecret),
    googleClientSecretMasked: maskSecret(cfg.googleClientSecret),
    appBaseUrl: cfg.appBaseUrl,
    isGoogleConfigured: cfg.isGoogleConfigured,
    // The SEO engine is built in and needs no external API key.
    aiEngine: "tubesmart" as const,
  };
}

export async function upsertSetting(key: SettingKey, value: string | null) {
  const cleaned = (value ?? "").trim();
  if (!cleaned) {
    await db.delete(appSettings).where(eq(appSettings.key, key));
    return;
  }
  const isSecret = SECRET_KEYS.has(key);
  const stored = isSecret ? encryptText(cleaned) : cleaned;

  const existing = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key));

  if (existing.length > 0) {
    await db
      .update(appSettings)
      .set({ valueEnc: stored, isSecret, updatedAt: new Date() })
      .where(eq(appSettings.key, key));
  } else {
    await db.insert(appSettings).values({
      key,
      valueEnc: stored,
      isSecret,
      updatedAt: new Date(),
    });
  }
}
