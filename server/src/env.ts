export interface Env {
  DB: D1Database;
  PACKAGE_NAME: string;
  PRODUCT_ID: string;
  BASE_PLAN_MONTHLY: string;
  BASE_PLAN_YEARLY: string;
  CLAUDE_MODEL: string;
  QUOTA_RECIPE: string;
  QUOTA_IMPORT: string;
  QUOTA_PHOTO: string;
  QUOTA_SUGGEST: string;
  QUOTA_SYNC: string;
  QUOTA_BACKUP: string;
  MAX_BACKUPS: string;
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
