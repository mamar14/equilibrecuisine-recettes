/** Réponses JSON et erreurs typées, avec un message en français affichable tel quel par l'application. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

export function errorResponse(e: ApiError): Response {
  return json({ error: e.code, message: e.message, ...e.extra }, e.status);
}

export const Errors = {
  badRequest: (message: string) => new ApiError(400, "bad_request", message),
  unauthorized: () => new ApiError(401, "unauthorized", "Session expirée : restaurez vos achats pour vous reconnecter."),
  premiumRequired: () => new ApiError(402, "premium_required", "Cette fonction est réservée aux abonnés Premium."),
  notFound: () => new ApiError(404, "not_found", "Introuvable."),
  conflict: (extra: Record<string, unknown>) =>
    new ApiError(409, "conflict", "Les données ont changé sur un autre appareil.", extra),
  tooLarge: () => new ApiError(413, "too_large", "Données trop volumineuses."),
  unprocessable: (code: string, message: string) => new ApiError(422, code, message),
  quota: (limit: number, period: "day" | "month" = "day", resetsAt = 0) =>
    new ApiError(
      429,
      "quota",
      period === "month"
        ? `Vous avez utilisé vos ${limit} analyses photo ce mois-ci. Elles seront renouvelées le ${frenchDate(resetsAt)}.`
        : `Limite quotidienne atteinte (${limit} par jour). Elle sera réinitialisée demain.`,
      { limit, period, resetsAt }
    ),
  upstream: (message = "Service momentanément indisponible, réessayez dans un instant.") =>
    new ApiError(503, "unavailable", message)
};

/** « 1er novembre 2026 » (date de renouvellement d'un quota mensuel). */
export function frenchDate(ms: number): string {
  const d = new Date(ms);
  const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const day = d.getUTCDate();
  return `${day === 1 ? "1er" : day} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Lit un corps JSON en limitant sa taille (octets). */
export async function readJson<T>(request: Request, maxBytes: number): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw Errors.tooLarge();
  const text = await request.text();
  if (text.length > maxBytes) throw Errors.tooLarge();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw Errors.badRequest("Requête illisible (JSON invalide).");
  }
}

/** Chaîne nettoyée et bornée, ou valeur par défaut. */
export function str(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
}

export function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function strList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v, maxLength)).filter((v) => v.length > 0).slice(0, maxItems);
}
