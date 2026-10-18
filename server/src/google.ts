/**
 * Accès à l'API Google Play Developer (androidpublisher v3) avec un compte de service :
 * jeton OAuth obtenu par JWT signé RS256 (WebCrypto), mis en cache jusqu'à son expiration.
 */
import { base64UrlEncode } from "./crypto.ts";
import { Errors } from "./http.ts";
import type { SubscriptionPurchaseV2 } from "./entitlement.ts";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_API_BASE = "https://androidpublisher.googleapis.com";

let cached: { key: string; token: string; expiresAt: number } | null = null;

/** Accepte le contenu du fichier JSON du compte de service, tel quel ou encodé en base64. */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim();
  let sa: ServiceAccount | undefined;
  for (const candidate of [text, safeAtob(text)]) {
    if (!candidate) continue;
    try {
      sa = JSON.parse(candidate) as ServiceAccount;
      break;
    } catch {
      // essai suivant
    }
  }
  if (!sa || !sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT invalide (JSON du compte de service attendu)");
  return sa;
}

function safeAtob(text: string): string | null {
  try {
    return atob(text);
  } catch {
    return null;
  }
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** JWT d'assertion signé avec la clé privée du compte de service. */
export async function signServiceAccountJwt(sa: ServiceAccount, nowSec: number): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri ?? DEFAULT_TOKEN_URI,
    iat: nowSec,
    exp: nowSec + 3600
  };
  const enc = new TextEncoder();
  const unsigned = `${base64UrlEncode(enc.encode(JSON.stringify(header)))}.${base64UrlEncode(enc.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function accessToken(rawServiceAccount: string): Promise<string> {
  const now = Date.now();
  if (cached && cached.key === rawServiceAccount && cached.expiresAt - 60_000 > now) return cached.token;
  const sa = parseServiceAccount(rawServiceAccount);
  const assertion = await signServiceAccountJwt(sa, Math.floor(now / 1000));
  const res = await fetch(sa.token_uri ?? DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) {
    console.error("Jeton Google refusé", res.status, await res.text());
    throw Errors.upstream("Vérification Google Play indisponible.");
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  cached = { key: rawServiceAccount, token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

export interface PlayClient {
  getSubscription(purchaseToken: string): Promise<SubscriptionPurchaseV2 | null>;
  acknowledge(productId: string, purchaseToken: string): Promise<boolean>;
}

export function playClient(env: { GOOGLE_SERVICE_ACCOUNT: string; PACKAGE_NAME: string; GOOGLE_API_BASE?: string }): PlayClient {
  const base = `${env.GOOGLE_API_BASE ?? DEFAULT_API_BASE}/androidpublisher/v3/applications/${encodeURIComponent(env.PACKAGE_NAME)}`;
  return {
    /** null si le jeton est inconnu de Google (faux achat, autre application). */
    async getSubscription(purchaseToken) {
      const token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT);
      const res = await fetch(`${base}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000)
      });
      if (res.status === 400 || res.status === 404 || res.status === 410) return null;
      if (!res.ok) {
        console.error("subscriptionsv2.get", res.status, await res.text());
        throw Errors.upstream("Vérification Google Play indisponible.");
      }
      return (await res.json()) as SubscriptionPurchaseV2;
    },
    async acknowledge(productId, purchaseToken) {
      const token = await accessToken(env.GOOGLE_SERVICE_ACCOUNT);
      const res = await fetch(
        `${base}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(15_000)
        }
      );
      if (!res.ok) console.error("acknowledge", res.status, await res.text());
      return res.ok;
    }
  };
}
