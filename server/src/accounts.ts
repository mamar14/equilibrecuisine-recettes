/**
 * Comptes, abonnements et sessions.
 *
 * L'identité d'un abonné est l'identifiant de compte obfusqué (UUID aléatoire) que l'application transmet
 * à Google Play lors de l'achat : Google le renvoie dans la réponse de vérification, il est donc fiable, et
 * il permet de retrouver ses données sur un nouveau téléphone avec « Restaurer mes achats », sans compte
 * ni mot de passe.
 */
import { evaluateSubscription, isEntitledState, planOf, type Entitlement } from "./entitlement.ts";
import { randomToken, safeEqual, sha256Hex } from "./crypto.ts";
import type { Env } from "./env.ts";
import { ApiError, Errors } from "./http.ts";
import type { PlayClient } from "./google.ts";

export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** Délai avant de redemander l'état à Google quand l'abonnement en base semble expiré (renouvellement). */
const RECHECK_MS = 10 * 60 * 1000;

export interface SubscriptionRow {
  purchase_token: string;
  user_id: string;
  product_id: string;
  base_plan_id: string | null;
  state: string;
  expiry_ms: number;
  auto_renewing: number;
  test_purchase: number;
  checked_at: number;
}

export interface PremiumStatus {
  premium: boolean;
  plan: "monthly" | "yearly" | "unknown";
  state: string;
  expiresAt: number;
  autoRenewing: boolean;
}

export async function userIdFor(e: Entitlement, purchaseToken: string): Promise<string> {
  const id = e.accountId?.trim();
  if (id && /^[A-Za-z0-9-]{8,64}$/.test(id)) return id;
  // Achat sans identifiant (ancienne version) : identité dérivée du jeton.
  return `tok_${(await sha256Hex(purchaseToken)).slice(0, 32)}`;
}

export async function saveSubscription(
  env: Env,
  purchaseToken: string,
  userId: string,
  e: Entitlement,
  nowMs: number
): Promise<void> {
  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").bind(userId, nowMs),
    env.DB.prepare(
      `INSERT INTO subscriptions (purchase_token, user_id, product_id, base_plan_id, state, expiry_ms, auto_renewing, test_purchase, linked_token, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(purchase_token) DO UPDATE SET user_id = excluded.user_id, base_plan_id = excluded.base_plan_id,
         state = excluded.state, expiry_ms = excluded.expiry_ms, auto_renewing = excluded.auto_renewing,
         test_purchase = excluded.test_purchase, linked_token = excluded.linked_token, checked_at = excluded.checked_at`
    ).bind(
      purchaseToken,
      userId,
      env.PRODUCT_ID,
      e.basePlanId,
      e.state,
      e.expiryMs,
      e.autoRenewing ? 1 : 0,
      e.testPurchase ? 1 : 0,
      e.linkedPurchaseToken,
      nowMs
    )
  ];
  // Changement de formule (mensuel ↔ annuel) : l'ancien jeton est remplacé par le nouveau.
  if (e.linkedPurchaseToken) {
    statements.push(
      env.DB.prepare("UPDATE subscriptions SET state = 'REPLACED' WHERE purchase_token = ?").bind(e.linkedPurchaseToken)
    );
  }
  await env.DB.batch(statements);
}

/** Interroge Google, enregistre l'état et accuse réception de l'achat si nécessaire. */
export async function refreshFromGoogle(
  env: Env,
  play: PlayClient,
  purchaseToken: string,
  nowMs: number
): Promise<{ entitlement: Entitlement; userId: string; acknowledged: boolean } | null> {
  const sub = await play.getSubscription(purchaseToken);
  if (!sub) return null;
  const e = evaluateSubscription(sub, env.PRODUCT_ID, nowMs);
  if ((sub.lineItems ?? []).every((i) => i.productId !== env.PRODUCT_ID)) return null;
  const userId = await userIdFor(e, purchaseToken);
  await saveSubscription(env, purchaseToken, userId, e, nowMs);
  // Sans accusé de réception sous 3 jours, Google rembourse l'achat : fait côté serveur, l'application
  // le refait elle-même si cet appel échoue.
  let acknowledged = !e.needsAcknowledge;
  if (e.needsAcknowledge) acknowledged = await play.acknowledge(env.PRODUCT_ID, purchaseToken);
  return { entitlement: e, userId, acknowledged };
}

/** Accès par code (examinateurs Google Play) : ligne d'abonnement sans achat Google derrière. */
export const ACCESS_CODE_PREFIX = "code:";
export const ACCESS_CODE_TTL_MS = 30 * 24 * 3600 * 1000;

export function normalizeAccessCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

/** Vérifie un code d'accès et accorde le Premium pour 30 jours à cet identifiant de compte. */
export async function redeemAccessCode(env: Env, code: string, accountId: string, nowMs: number): Promise<PremiumStatus> {
  const expected = (env.ACCESS_CODE_SHA256 ?? "").trim().toLowerCase();
  const normalized = normalizeAccessCode(code);
  if (!expected || normalized.length < 12 || !safeEqual(await sha256Hex(normalized), expected)) {
    throw new ApiError(403, "invalid_code", "Code d'accès invalide.");
  }
  if (!/^[A-Za-z0-9-]{8,64}$/.test(accountId)) throw Errors.badRequest("Identifiant d'appareil invalide.");
  const e: Entitlement = {
    entitled: true,
    state: "SUBSCRIPTION_STATE_ACTIVE",
    expiryMs: nowMs + ACCESS_CODE_TTL_MS,
    basePlanId: null,
    autoRenewing: false,
    needsAcknowledge: false,
    accountId,
    linkedPurchaseToken: null,
    testPurchase: true
  };
  await saveSubscription(env, ACCESS_CODE_PREFIX + accountId, accountId, e, nowMs);
  return statusOf(env, await latestSubscription(env, accountId), nowMs);
}

export function statusOf(env: Env, row: SubscriptionRow | null, nowMs: number): PremiumStatus {
  if (!row) return { premium: false, plan: "unknown", state: "NONE", expiresAt: 0, autoRenewing: false };
  return {
    premium: isEntitledState(row.state, row.expiry_ms, nowMs),
    plan: planOf(row.base_plan_id, env.BASE_PLAN_MONTHLY, env.BASE_PLAN_YEARLY),
    state: row.state,
    expiresAt: row.expiry_ms,
    autoRenewing: row.auto_renewing === 1
  };
}

export async function latestSubscription(env: Env, userId: string): Promise<SubscriptionRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM subscriptions WHERE user_id = ? AND state != 'REPLACED' ORDER BY expiry_ms DESC LIMIT 1"
  )
    .bind(userId)
    .first<SubscriptionRow>();
}

export async function createSession(env: Env, userId: string, nowMs: number): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const expiresAt = nowMs + SESSION_TTL_MS;
  await env.DB.batch([
    // Sessions expirées de cet utilisateur : nettoyées au passage.
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(userId, nowMs),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
      await sha256Hex(token),
      userId,
      nowMs,
      expiresAt
    )
  ]);
  return { token, expiresAt };
}

/** Utilisateur de la session (en-tête Authorization: Bearer), sinon 401. */
export async function authenticate(env: Env, request: Request, nowMs: number): Promise<string> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length < 20 || token.length > 200) throw Errors.unauthorized();
  const row = await env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at <= nowMs) throw Errors.unauthorized();
  return row.user_id;
}

/**
 * Vérifie que l'utilisateur est abonné : contrôle fait à CHAQUE appel d'une fonction payante.
 * Un abonnement apparemment expiré est revérifié auprès de Google (renouvellement non encore notifié).
 */
export async function requirePremium(env: Env, play: PlayClient, userId: string, nowMs: number): Promise<PremiumStatus> {
  let row = await latestSubscription(env, userId);
  // Codes d'accès désactivés (variable vidée) : l'accès par code s'arrête immédiatement.
  if (row?.purchase_token.startsWith(ACCESS_CODE_PREFIX) && !env.ACCESS_CODE_SHA256) throw Errors.premiumRequired();
  let status = statusOf(env, row, nowMs);
  if (!status.premium && row && !row.purchase_token.startsWith(ACCESS_CODE_PREFIX) && nowMs - row.checked_at > RECHECK_MS && row.state !== "SUBSCRIPTION_STATE_EXPIRED") {
    await refreshFromGoogle(env, play, row.purchase_token, nowMs);
    row = await latestSubscription(env, userId);
    status = statusOf(env, row, nowMs);
  }
  if (!status.premium) throw Errors.premiumRequired();
  return status;
}
