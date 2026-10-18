/**
 * Interprétation d'une réponse purchases.subscriptionsv2 de l'API Google Play Developer.
 * Fonction pure : testée sans réseau.
 */

export interface SubscriptionPurchaseV2 {
  subscriptionState?: string;
  acknowledgementState?: string;
  linkedPurchaseToken?: string;
  testPurchase?: Record<string, unknown>;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerDetails?: { basePlanId?: string; offerId?: string };
  }>;
}

export interface Entitlement {
  entitled: boolean;
  state: string;
  expiryMs: number;
  basePlanId: string | null;
  autoRenewing: boolean;
  needsAcknowledge: boolean;
  accountId: string | null;
  linkedPurchaseToken: string | null;
  testPurchase: boolean;
}

/**
 * États qui donnent accès au Premium tant que la date d'expiration n'est pas passée :
 * - ACTIVE : abonnement en cours ;
 * - IN_GRACE_PERIOD : problème de paiement, Google réessaie, l'accès est maintenu ;
 * - CANCELED : résilié mais payé jusqu'à la fin de la période.
 * ON_HOLD (suspension), PAUSED, EXPIRED et PENDING ne donnent pas accès.
 */
const ENTITLED_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_CANCELED"
]);

export function isEntitledState(state: string, expiryMs: number, nowMs: number): boolean {
  return ENTITLED_STATES.has(state) && expiryMs > nowMs;
}

export function evaluateSubscription(sub: SubscriptionPurchaseV2, productId: string, nowMs: number): Entitlement {
  const items = (sub.lineItems ?? []).filter((i) => i.productId === productId);
  // Plusieurs lignes possibles (changement de formule) : on garde celle qui expire le plus tard.
  let best: (typeof items)[number] | undefined;
  let bestExpiry = 0;
  for (const item of items) {
    const t = item.expiryTime ? Date.parse(item.expiryTime) : NaN;
    if (Number.isFinite(t) && t >= bestExpiry) {
      best = item;
      bestExpiry = t;
    }
  }
  const state = sub.subscriptionState ?? "SUBSCRIPTION_STATE_UNSPECIFIED";
  const entitled = best !== undefined && isEntitledState(state, bestExpiry, nowMs);
  return {
    entitled,
    state,
    expiryMs: bestExpiry,
    basePlanId: best?.offerDetails?.basePlanId ?? null,
    autoRenewing: best?.autoRenewingPlan?.autoRenewEnabled === true,
    needsAcknowledge: entitled && sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING",
    accountId: sub.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    linkedPurchaseToken: sub.linkedPurchaseToken ?? null,
    testPurchase: sub.testPurchase !== undefined
  };
}

/** Nom de formule lisible par l'application. */
export function planOf(basePlanId: string | null, monthly: string, yearly: string): "monthly" | "yearly" | "unknown" {
  if (basePlanId === monthly) return "monthly";
  if (basePlanId === yearly) return "yearly";
  return "unknown";
}
