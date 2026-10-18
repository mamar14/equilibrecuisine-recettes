import { numberVar, type Env } from "./env.ts";
import { Errors } from "./http.ts";

export type QuotaKind = "recipe" | "import" | "photo" | "suggest" | "sync" | "backup";

export function quotaLimit(env: Env, kind: QuotaKind): number {
  switch (kind) {
    case "recipe": return numberVar(env.QUOTA_RECIPE, 15);
    case "import": return numberVar(env.QUOTA_IMPORT, 20);
    case "photo": return numberVar(env.QUOTA_PHOTO, 8);
    case "suggest": return numberVar(env.QUOTA_SUGGEST, 8);
    case "sync": return numberVar(env.QUOTA_SYNC, 60);
    case "backup": return numberVar(env.QUOTA_BACKUP, 12);
  }
}

export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Réserve une utilisation (atomique). Lève 429 au-delà de la limite du jour. */
export async function consume(env: Env, userId: string, kind: QuotaKind, nowMs: number): Promise<{ used: number; limit: number }> {
  const limit = quotaLimit(env, kind);
  const row = await env.DB.prepare(
    `INSERT INTO usage (user_id, day, kind, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id, day, kind) DO UPDATE SET count = count + 1
     RETURNING count`
  )
    .bind(userId, dayKey(nowMs), kind)
    .first<{ count: number }>();
  const used = row?.count ?? 1;
  if (used > limit) {
    await refund(env, userId, kind, nowMs);
    throw Errors.quota(limit);
  }
  return { used, limit };
}

/** Rend une utilisation quand l'opération a échoué (l'utilisateur ne paie pas une erreur). */
export async function refund(env: Env, userId: string, kind: QuotaKind, nowMs: number): Promise<void> {
  await env.DB.prepare("UPDATE usage SET count = MAX(count - 1, 0) WHERE user_id = ? AND day = ? AND kind = ?")
    .bind(userId, dayKey(nowMs), kind)
    .run();
}

export async function usageToday(env: Env, userId: string, nowMs: number): Promise<Record<string, { used: number; limit: number }>> {
  const rows = await env.DB.prepare("SELECT kind, count FROM usage WHERE user_id = ? AND day = ?")
    .bind(userId, dayKey(nowMs))
    .all<{ kind: QuotaKind; count: number }>();
  const used = new Map(rows.results.map((r) => [r.kind, r.count]));
  const kinds: QuotaKind[] = ["recipe", "import", "photo", "suggest", "sync", "backup"];
  return Object.fromEntries(kinds.map((k) => [k, { used: used.get(k) ?? 0, limit: quotaLimit(env, k) }]));
}
