/**
 * Synchronisation et sauvegardes : la bibliothèque exportée par l'application (JSON) est stockée
 * compressée dans D1. La synchronisation utilise une version : un envoi basé sur une version périmée
 * est refusé (409) et l'application fusionne d'abord la copie distante.
 */
import { gunzip, gzip, randomToken } from "./crypto.ts";
import { numberVar, type Env } from "./env.ts";
import { Errors, int, str } from "./http.ts";

export const MAX_LIBRARY_BYTES = 12_000_000;
const AUTO_BACKUP_MIN_INTERVAL_MS = 20 * 3600 * 1000;

function parseLibrary(data: unknown): { text: string; recipes: number } {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Errors.badRequest("Bibliothèque manquante.");
  const recipes = (data as { recipes?: unknown }).recipes;
  if (!Array.isArray(recipes)) throw Errors.badRequest("Bibliothèque invalide.");
  const text = JSON.stringify(data);
  if (text.length > MAX_LIBRARY_BYTES) throw Errors.tooLarge();
  return { text, recipes: recipes.length };
}

export async function getSnapshot(env: Env, userId: string) {
  const row = await env.DB.prepare("SELECT version, updated_at, device, recipes, data FROM snapshots WHERE user_id = ?")
    .bind(userId)
    .first<{ version: number; updated_at: number; device: string | null; recipes: number; data: ArrayBuffer | number[] }>();
  if (!row) return { version: 0, updatedAt: 0, device: null, recipes: 0, data: null };
  return {
    version: row.version,
    updatedAt: row.updated_at,
    device: row.device,
    recipes: row.recipes,
    data: JSON.parse(await gunzip(row.data))
  };
}

export async function putSnapshot(env: Env, userId: string, body: Record<string, unknown>, nowMs: number) {
  const baseVersion = int(body.baseVersion, 0, Number.MAX_SAFE_INTEGER, 0);
  const device = str(body.device, 60) || null;
  const { text, recipes } = parseLibrary(body.data);
  const compressed = await gzip(text);
  const current = await env.DB.prepare("SELECT version, updated_at, device FROM snapshots WHERE user_id = ?")
    .bind(userId)
    .first<{ version: number; updated_at: number; device: string | null }>();
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== baseVersion) {
    throw Errors.conflict({ version: currentVersion, updatedAt: current?.updated_at ?? 0, device: current?.device ?? null });
  }
  const next = currentVersion + 1;
  // Mise à jour conditionnelle : deux appareils simultanés ne peuvent pas écraser la même version.
  const result = await env.DB.prepare(
    `INSERT INTO snapshots (user_id, version, updated_at, device, size, recipes, data) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, device = excluded.device,
       size = excluded.size, recipes = excluded.recipes, data = excluded.data
     WHERE snapshots.version = ?`
  )
    .bind(userId, next, nowMs, device, compressed.length, recipes, compressed, baseVersion)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw Errors.conflict({ version: currentVersion + 1, updatedAt: nowMs, device: null });
  }
  return { version: next, updatedAt: nowMs, recipes };
}

export async function listBackups(env: Env, userId: string) {
  const rows = await env.DB.prepare(
    "SELECT id, created_at, device, size, recipes, auto FROM backups WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(userId)
    .all<{ id: string; created_at: number; device: string | null; size: number; recipes: number; auto: number }>();
  return rows.results.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    device: r.device,
    size: r.size,
    recipes: r.recipes,
    auto: r.auto === 1
  }));
}

export async function createBackup(env: Env, userId: string, body: Record<string, unknown>, nowMs: number) {
  const auto = body.auto === true;
  if (auto) {
    const last = await env.DB.prepare("SELECT MAX(created_at) AS t FROM backups WHERE user_id = ? AND auto = 1")
      .bind(userId)
      .first<{ t: number | null }>();
    if (last?.t && nowMs - last.t < AUTO_BACKUP_MIN_INTERVAL_MS) return { skipped: true, backups: await listBackups(env, userId) };
  }
  const { text, recipes } = parseLibrary(body.data);
  const compressed = await gzip(text);
  const id = randomToken(12);
  const keep = numberVar(env.MAX_BACKUPS, 10);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO backups (id, user_id, created_at, device, size, recipes, auto, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, userId, nowMs, str(body.device, 60) || null, compressed.length, recipes, auto ? 1 : 0, compressed),
    // Rotation : seules les [keep] plus récentes sont conservées.
    env.DB.prepare(
      `DELETE FROM backups WHERE user_id = ? AND id NOT IN
         (SELECT id FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`
    ).bind(userId, userId, keep)
  ]);
  return { skipped: false, id, backups: await listBackups(env, userId) };
}

export async function getBackup(env: Env, userId: string, id: string) {
  const row = await env.DB.prepare("SELECT created_at, data FROM backups WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ created_at: number; data: ArrayBuffer | number[] }>();
  if (!row) throw Errors.notFound();
  return { id, createdAt: row.created_at, data: JSON.parse(await gunzip(row.data)) };
}

export async function deleteBackup(env: Env, userId: string, id: string) {
  await env.DB.prepare("DELETE FROM backups WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return { backups: await listBackups(env, userId) };
}

/** Droit à l'effacement : supprime toutes les données cloud de l'utilisateur (l'abonnement reste géré par Google). */
export async function deleteCloudData(env: Env, userId: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM snapshots WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM backups WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM usage WHERE user_id = ?").bind(userId)
  ]);
  return { deleted: true };
}
