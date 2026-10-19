import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSubscription, planOf } from "../src/entitlement.ts";
import { periodKey, periodResetsAt, quotaPeriod } from "../src/quota.ts";
import { validatePhoto } from "../src/photo.ts";
import { Errors, frenchDate } from "../src/http.ts";
import { signServiceAccountJwt } from "../src/google.ts";
import { gunzip, gzip, safeEqual, sha256Hex } from "../src/crypto.ts";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const future = "2026-11-18T10:00:00Z";
const past = "2026-10-01T10:00:00Z";

function sub(state: string, expiry: string, extra: Record<string, unknown> = {}) {
  return {
    subscriptionState: state,
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    externalAccountIdentifiers: { obfuscatedExternalAccountId: "3f1c2a8e-1111-4c4c-9999-abcdefabcdef" },
    lineItems: [{ productId: "premium", expiryTime: expiry, autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { basePlanId: "annuel" } }],
    ...extra
  };
}

test("abonnement actif : accès Premium et accusé de réception requis", () => {
  const e = evaluateSubscription(sub("SUBSCRIPTION_STATE_ACTIVE", future), "premium", NOW);
  assert.equal(e.entitled, true);
  assert.equal(e.needsAcknowledge, true);
  assert.equal(e.basePlanId, "annuel");
  assert.equal(e.autoRenewing, true);
  assert.equal(e.accountId, "3f1c2a8e-1111-4c4c-9999-abcdefabcdef");
  assert.equal(planOf(e.basePlanId, "mensuel", "annuel"), "yearly");
});

test("résilié mais payé jusqu'à la fin de la période : accès maintenu", () => {
  assert.equal(evaluateSubscription(sub("SUBSCRIPTION_STATE_CANCELED", future), "premium", NOW).entitled, true);
  assert.equal(evaluateSubscription(sub("SUBSCRIPTION_STATE_CANCELED", past), "premium", NOW).entitled, false);
});

test("délai de grâce : accès maintenu ; suspension, pause, expiré, en attente : refusé", () => {
  assert.equal(evaluateSubscription(sub("SUBSCRIPTION_STATE_IN_GRACE_PERIOD", future), "premium", NOW).entitled, true);
  for (const s of ["SUBSCRIPTION_STATE_ON_HOLD", "SUBSCRIPTION_STATE_PAUSED", "SUBSCRIPTION_STATE_EXPIRED", "SUBSCRIPTION_STATE_PENDING"]) {
    const e = evaluateSubscription(sub(s, future), "premium", NOW);
    assert.equal(e.entitled, false, s);
    assert.equal(e.needsAcknowledge, false, s);
  }
});

test("autre produit : jamais d'accès", () => {
  assert.equal(evaluateSubscription(sub("SUBSCRIPTION_STATE_ACTIVE", future), "autre", NOW).entitled, false);
});

test("déjà acquitté : pas de nouvel accusé de réception", () => {
  const e = evaluateSubscription(sub("SUBSCRIPTION_STATE_ACTIVE", future, { acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }), "premium", NOW);
  assert.equal(e.needsAcknowledge, false);
});

test("quota photo mensuel : clé, renouvellement le 1er du mois suivant, message en français", () => {
  const oct = Date.parse("2026-10-19T10:00:00Z");
  assert.equal(periodKey("photo", oct), "M2026-10");
  assert.equal(periodKey("sync", oct), "2026-10-19");
  assert.equal(quotaPeriod("photo"), "month");
  assert.equal(new Date(periodResetsAt("photo", oct)).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(new Date(periodResetsAt("photo", Date.parse("2026-12-31T23:00:00Z"))).toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(new Date(periodResetsAt("backup", oct)).toISOString(), "2026-10-20T00:00:00.000Z");
  const e = Errors.quota(5, "month", periodResetsAt("photo", oct));
  assert.equal(e.status, 429);
  assert.equal(e.message, "Vous avez utilisé vos 5 analyses photo ce mois-ci. Elles seront renouvelées le 1er novembre 2026.");
  assert.equal(frenchDate(Date.parse("2026-03-15T00:00:00Z")), "15 mars 2026");
});

test("photo : image contrôlée avant tout décompte", () => {
  assert.throws(() => validatePhoto({ image: "A".repeat(400), mediaType: "image/gif" }));
  assert.throws(() => validatePhoto({ image: "court" }));
  assert.equal(validatePhoto({ image: "A".repeat(400) }).mediaType, "image/jpeg");
});

test("JWT du compte de service signé RS256 et vérifiable", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  const jwt = await signServiceAccountJwt({ client_email: "play@projet.iam.gserviceaccount.com", private_key: pem }, 1_800_000_000);
  const [h, c, s] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(claims.iss, "play@projet.iam.gserviceaccount.com");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/androidpublisher");
  assert.equal(claims.exp - claims.iat, 3600);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${c}`));
  assert.equal(ok, true);
});

test("gzip aller-retour, empreinte, comparaison", async () => {
  const text = JSON.stringify({ recipes: Array.from({ length: 50 }, (_, i) => ({ title: `Recette ${i}` })) });
  const z = await gzip(text);
  assert.ok(z.length < text.length);
  assert.equal(await gunzip(z), text);
  assert.equal(await gunzip(Array.from(z)), text, "BLOB D1 sous forme de tableau");
  assert.equal((await sha256Hex("abc")).length, 64);
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
});
