import { numberVar, type Env } from "./env.ts";
import { Errors } from "./http.ts";

export type QuotaKind = "photo" | "sync" | "backup";
export type QuotaPeriod = "day" | "month";

export interface Usage {
  used: number;
  limit: number;
  period: QuotaPeriod;
  /** Début de la période suivante (ms, UTC) : date de renouvellement affichée par l'application. */
  resetsAt: number;
}

/** Analyse photo : quota MENSUEL ; synchronisation et sauvegardes : quotas quotidiens anti-abus. */
export function quotaPeriod(kind: QuotaKind): QuotaPeriod {
  return kind === "photo" ? "month" : "day";
}

export function quotaLimit(env: Env, kind: QuotaKind): number {
  switch (kind) {
    case "photo": return numberVar(env.QUOTA_PHOTO_MONTH, 5);
    case "sync": return numberVar(env.QUOTA_SYNC, 60);
    case "backup": return numberVar(env.QUOTA_BACKUP, 12);
  }
}

/** Clé de période : « 2026-10-19 » (jour) ou « M2026-10 » (mois). Le préfixe évite toute collision. */
export function periodKey(kind: QuotaKind, nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  return quotaPeriod(kind) === "month" ? `M${iso.slice(0, 7)}` : iso.slice(0, 10);
}

export function periodResetsAt(kind: QuotaKind, nowMs: number): number {
  const d = new Date(nowMs);
  return quotaPeriod(kind) === "month"
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Réserve une utilisation (atomique). Lève 429 au-delà de la limite de la période. */
export async function consume(env: Env, userId: string, kind: QuotaKind, nowMs: number): Promise<Usage> {
  const limit = quotaLimit(env, kind);
  const row = await env.DB.prepare(
    `INSERT INTO usage (user_id, day, kind, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id, day, kind) DO UPDATE SET count = count + 1
     RETURNING count`
  )
    .bind(userId, periodKey(kind, nowMs), kind)
    .first<{ count: number }>();
  const used = row?.count ?? 1;
  if (used > limit) {
    await refund(env, userId, kind, nowMs);
    throw Errors.quota(limit, quotaPeriod(kind), periodResetsAt(kind, nowMs));
  }
  return { used, limit, period: quotaPeriod(kind), resetsAt: periodResetsAt(kind, nowMs) };
}

/** Rend une utilisation quand l'opération a échoué (l'utilisateur ne paie pas une erreur). */
export async function refund(env: Env, userId: string, kind: QuotaKind, nowMs: number): Promise<void> {
  await env.DB.prepare("UPDATE usage SET count = MAX(count - 1, 0) WHERE user_id = ? AND day = ? AND kind = ?")
    .bind(userId, periodKey(kind, nowMs), kind)
    .run();
}

export async function currentUsage(env: Env, userId: string, nowMs: number): Promise<Record<QuotaKind, Usage>> {
  const kinds: QuotaKind[] = ["photo", "sync", "backup"];
  const out = {} as Record<QuotaKind, Usage>;
  for (const kind of kinds) {
    const row = await env.DB.prepare("SELECT count FROM usage WHERE user_id = ? AND day = ? AND kind = ?")
      .bind(userId, periodKey(kind, nowMs), kind)
      .first<{ count: number }>();
    out[kind] = {
      used: row?.count ?? 0,
      limit: quotaLimit(env, kind),
      period: quotaPeriod(kind),
      resetsAt: periodResetsAt(kind, nowMs)
    };
  }
  return out;
}
