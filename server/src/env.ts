export interface Env {
  DB: D1Database;
  PACKAGE_NAME: string;
  PRODUCT_ID: string;
  BASE_PLAN_MONTHLY: string;
  BASE_PLAN_YEARLY: string;
  CLAUDE_MODEL: string;
  /** Analyses photo par abonné et par mois. */
  QUOTA_PHOTO_MONTH: string;
  QUOTA_SYNC: string;
  QUOTA_BACKUP: string;
  MAX_BACKUPS: string;
  /** SHA-256 du code d'accès (examinateurs Google Play, tests). Vide = codes désactivés. */
  ACCESS_CODE_SHA256?: string;
  // Secrets
  ANTHROPIC_API_KEY: string;
  GOOGLE_SERVICE_ACCOUNT: string;
  RTDN_TOKEN: string;
  // Tests uniquement : services simulés.
  ANTHROPIC_API_BASE?: string;
  GOOGLE_API_BASE?: string;
}

export function numberVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
