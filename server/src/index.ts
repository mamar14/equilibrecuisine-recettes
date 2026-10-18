/**
 * Serveur Premium d'EquilibreCuisine (Cloudflare Worker).
 *
 * Seuls les abonnés appellent ce serveur : la version gratuite de l'application fonctionne entièrement
 * hors ligne et ne génère aucun coût. Chaque fonction payante (IA, cloud) vérifie l'abonnement à chaque
 * appel, côté serveur : modifier l'application ne permet pas de contourner le paiement.
 */
import {
  authenticate, createSession, latestSubscription, refreshFromGoogle, requirePremium, statusOf
} from "./accounts.ts";
import { analyzePhoto, generateRecipe, importFromUrl, suggest, validatePhoto } from "./ai.ts";
import { validatePublicUrl } from "./urlImport.ts";
import {
  createBackup, deleteBackup, deleteCloudData, getBackup, getSnapshot, listBackups, MAX_LIBRARY_BYTES, putSnapshot
} from "./cloud.ts";
import { safeEqual } from "./crypto.ts";
import type { Env } from "./env.ts";
import { planOf } from "./entitlement.ts";
import { playClient, type PlayClient } from "./google.ts";
import { ApiError, Errors, errorResponse, json, readJson, str } from "./http.ts";
import { consume, refund, usageToday, type QuotaKind } from "./quota.ts";

const SMALL_BODY = 64_000;
const PHOTO_BODY = 7_000_000;

export interface Deps {
  play: (env: Env) => PlayClient;
  now: () => number;
}

const defaultDeps: Deps = { play: (env) => playClient(env), now: () => Date.now() };

export function createHandler(deps: Deps = defaultDeps) {
  return async function handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const now = deps.now();
    const play = deps.play(env);
    try {
      if (path === "/v1/health" && method === "GET") return json({ ok: true });

      if (path === "/v1/purchases/verify" && method === "POST") {
        const body = await readJson<Record<string, unknown>>(request, SMALL_BODY);
        const purchaseToken = str(body.purchaseToken, 4096);
        const productId = str(body.productId, 100);
        if (purchaseToken.length < 10) throw Errors.badRequest("Jeton d'achat manquant.");
        if (productId !== env.PRODUCT_ID) throw Errors.badRequest("Produit inconnu.");
        const result = await refreshFromGoogle(env, play, purchaseToken, now);
        if (!result) throw new ApiError(400, "invalid_purchase", "Achat introuvable auprès de Google Play.");
        const { entitlement: e, userId, acknowledged } = result;
        const status = {
          premium: e.entitled,
          plan: planOf(e.basePlanId, env.BASE_PLAN_MONTHLY, env.BASE_PLAN_YEARLY),
          state: e.state,
          expiresAt: e.expiryMs,
          autoRenewing: e.autoRenewing,
          acknowledged
        };
        if (!e.entitled) return json(status);
        const session = await createSession(env, userId, now);
        return json({ ...status, sessionToken: session.token, sessionExpiresAt: session.expiresAt });
      }

      // Notifications Google Play en temps réel (Pub/Sub, abonnement « push »).
      if (path === "/v1/rtdn" && method === "POST") {
        const token = url.searchParams.get("token") ?? "";
        if (!env.RTDN_TOKEN || !safeEqual(token, env.RTDN_TOKEN)) return json({ error: "forbidden" }, 403);
        const body = await readJson<{ message?: { data?: string } }>(request, SMALL_BODY);
        let note: { packageName?: string; subscriptionNotification?: { purchaseToken?: string } } = {};
        try {
          note = JSON.parse(atob(body.message?.data ?? ""));
        } catch {
          return new Response(null, { status: 204 });
        }
        const purchaseToken = note.subscriptionNotification?.purchaseToken;
        if (note.packageName === env.PACKAGE_NAME && purchaseToken) {
          await refreshFromGoogle(env, play, purchaseToken, now);
        }
        return new Response(null, { status: 204 });
      }

      if (!path.startsWith("/v1/")) throw Errors.notFound();

      // ----- Routes authentifiées -----
      const userId = await authenticate(env, request, now);

      if (path === "/v1/me" && method === "GET") {
        const status = statusOf(env, await latestSubscription(env, userId), now);
        const snapshot = await env.DB.prepare("SELECT version, updated_at, device, recipes FROM snapshots WHERE user_id = ?")
          .bind(userId)
          .first<{ version: number; updated_at: number; device: string | null; recipes: number }>();
        return json({
          ...status,
          usage: await usageToday(env, userId, now),
          sync: snapshot ? { version: snapshot.version, updatedAt: snapshot.updated_at, device: snapshot.device, recipes: snapshot.recipes } : null,
          backups: await listBackups(env, userId)
        });
      }
      if (path === "/v1/me/data" && method === "DELETE") {
        return json(await deleteCloudData(env, userId));
      }

      // Toutes les routes suivantes exigent un abonnement actif.
      await requirePremium(env, play, userId, now);

      const metered = async <T>(kind: QuotaKind, run: () => Promise<T>) => {
        const usage = await consume(env, userId, kind, now);
        try {
          return json({ ...(await run()), usage });
        } catch (e) {
          await refund(env, userId, kind, now);
          throw e;
        }
      };

      if (method === "POST" && path === "/v1/ai/recipe") {
        const body = await readJson<Record<string, unknown>>(request, SMALL_BODY);
        return await metered("recipe", () => generateRecipe(env, body));
      }
      if (method === "POST" && path === "/v1/ai/import-url") {
        const body = await readJson<Record<string, unknown>>(request, SMALL_BODY);
        validatePublicUrl(str(body.url, 2000));
        return await metered("import", () => importFromUrl(env, body));
      }
      if (method === "POST" && path === "/v1/ai/photo") {
        const body = await readJson<Record<string, unknown>>(request, PHOTO_BODY);
        validatePhoto(body);
        return await metered("photo", () => analyzePhoto(env, body));
      }
      if (method === "POST" && path === "/v1/ai/suggestions") {
        const body = await readJson<Record<string, unknown>>(request, 200_000);
        return await metered("suggest", () => suggest(env, body));
      }

      if (path === "/v1/sync") {
        if (method === "GET") return json(await getSnapshot(env, userId));
        if (method === "PUT") {
          const body = await readJson<Record<string, unknown>>(request, MAX_LIBRARY_BYTES + 10_000);
          return await metered("sync", () => putSnapshot(env, userId, body, now));
        }
      }

      if (path === "/v1/backups") {
        if (method === "GET") return json({ backups: await listBackups(env, userId) });
        if (method === "POST") {
          const body = await readJson<Record<string, unknown>>(request, MAX_LIBRARY_BYTES + 10_000);
          return await metered("backup", () => createBackup(env, userId, body, now));
        }
      }
      const backupMatch = /^\/v1\/backups\/([A-Za-z0-9_-]{8,40})$/.exec(path);
      if (backupMatch) {
        if (method === "GET") return json(await getBackup(env, userId, backupMatch[1]));
        if (method === "DELETE") return json(await deleteBackup(env, userId, backupMatch[1]));
      }

      throw Errors.notFound();
    } catch (e) {
      if (e instanceof ApiError) return errorResponse(e);
      console.error("Erreur inattendue", e);
      return json({ error: "internal", message: "Erreur du serveur, réessayez plus tard." }, 500);
    }
  };
}

const handler = createHandler();

export default {
  fetch: (request: Request, env: Env) => handler(request, env)
} satisfies ExportedHandler<Env>;
