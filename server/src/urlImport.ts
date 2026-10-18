/**
 * Import d'une recette depuis une page web : lecture des données structurées schema.org/Recipe (JSON-LD)
 * publiées par la quasi-totalité des sites de cuisine, sinon du texte visible de la page.
 */
import { ApiError, Errors } from "./http.ts";

const MAX_PAGE_BYTES = 3_000_000;
const MAX_TEXT_CHARS = 18_000;

/** Adresse publique http(s) uniquement : pas d'IP privée, de localhost ni de port exotique (SSRF). */
export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw Errors.badRequest("Adresse invalide.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw Errors.badRequest("Seules les adresses http(s) sont acceptées.");
  if (url.username || url.password) throw Errors.badRequest("Adresse invalide.");
  if (url.port && url.port !== "80" && url.port !== "443") throw Errors.badRequest("Adresse invalide.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost =
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
    !host.includes(".") ||
    /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    host.includes(":"); // IPv6 littérale
  if (privateHost) throw Errors.badRequest("Adresse non autorisée.");
  url.hash = "";
  return url;
}

export async function fetchPage(url: URL): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; EquilibreCuisine/2.1; +https://mamar14.github.io/equilibrecuisine-recettes/)",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "fr-FR,fr;q=0.9"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new ApiError(422, "unreachable", "Impossible d'ouvrir cette page. Vérifiez l'adresse.");
  }
  if (!res.ok) throw new ApiError(422, "unreachable", `La page a répondu avec une erreur (${res.status}).`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("html") && !type.includes("text")) throw new ApiError(422, "not_html", "Cette adresse n'est pas une page web.");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(Math.min(total, MAX_PAGE_BYTES));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.max(0, all.length - offset));
    all.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder("utf-8").decode(all);
}

type Json = Record<string, unknown>;

function isRecipe(node: unknown): node is Json {
  if (!node || typeof node !== "object") return false;
  const t = (node as Json)["@type"];
  return t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"));
}

function findRecipe(node: unknown, depth = 0): Json | null {
  if (depth > 6 || !node || typeof node !== "object") return null;
  if (isRecipe(node)) return node;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Json;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = findRecipe(obj[key], depth + 1);
    if (r) return r;
  }
  return null;
}

/** Premier objet schema.org Recipe des balises <script type="application/ld+json">. */
export function extractJsonLdRecipe(html: string): Json | null {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = decodeEntities(m[1].trim()).replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "");
    try {
      const r = findRecipe(JSON.parse(raw));
      if (r) return r;
    } catch {
      // JSON-LD mal formé : on essaie le bloc suivant.
    }
  }
  return null;
}

/** Durée ISO 8601 (PT1H30M) en minutes. */
export function isoMinutes(value: unknown): number {
  if (typeof value !== "string") return 0;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!m) return 0;
  const [, d, h, min] = m;
  return Math.round(Number(d ?? 0) * 1440 + Number(h ?? 0) * 60 + Number(min ?? 0));
}

function text(value: unknown): string {
  if (typeof value === "string") return decodeEntities(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "text" in (value as Json)) return text((value as Json).text);
  if (value && typeof value === "object" && "name" in (value as Json)) return text((value as Json).name);
  return "";
}

function instructions(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof value === "string") {
    value.split(/\n+|<br\s*\/?>/i).map(text).filter(Boolean).forEach((s) => out.push(s));
  } else if (Array.isArray(value)) {
    value.forEach((v) => instructions(v, out, depth + 1));
  } else if (value && typeof value === "object") {
    const obj = value as Json;
    if (obj["@type"] === "HowToSection") {
      const name = text(obj.name);
      if (name) out.push(`— ${name} —`);
      instructions(obj.itemListElement, out, depth + 1);
    } else {
      const t = text(obj.text ?? obj.name);
      if (t) out.push(t);
    }
  }
  return out;
}

/** Résumé textuel compact d'une recette schema.org, transmis à l'IA pour conversion. */
export function describeJsonLd(r: Json): string {
  const lines: string[] = [];
  lines.push(`Titre : ${text(r.name)}`);
  if (r.description) lines.push(`Description : ${text(r.description).slice(0, 500)}`);
  const yieldText = Array.isArray(r.recipeYield) ? r.recipeYield.map(text).join(" / ") : text(r.recipeYield);
  if (yieldText) lines.push(`Portions : ${yieldText}`);
  const prep = isoMinutes(r.prepTime);
  const cook = isoMinutes(r.cookTime);
  const total = isoMinutes(r.totalTime);
  lines.push(`Temps : préparation ${prep} min, cuisson ${cook} min, total ${total} min`);
  if (r.recipeCategory) lines.push(`Catégorie : ${[r.recipeCategory].flat().map(text).join(", ")}`);
  const ingredients = [r.recipeIngredient ?? r.ingredients].flat().map(text).filter(Boolean);
  lines.push("Ingrédients :");
  ingredients.slice(0, 60).forEach((i) => lines.push(`- ${i}`));
  lines.push("Instructions :");
  instructions(r.recipeInstructions).slice(0, 60).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  return lines.join("\n").slice(0, MAX_TEXT_CHARS);
}

/** Texte visible d'une page (sans scripts, styles ni menus), borné. */
export function visibleText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const cleaned = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1)
    .join("\n");
  return `Titre de la page : ${decodeEntities(title).trim()}\n${cleaned}`.slice(0, MAX_TEXT_CHARS);
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", ecirc: "ê", agrave: "à",
  acirc: "â", ccedil: "ç", ocirc: "ô", ucirc: "û", ugrave: "ù", icirc: "î", iuml: "ï", euml: "ë", oelig: "œ", deg: "°",
  rsquo: "’", lsquo: "‘", hellip: "…", frac12: "½", frac14: "¼", frac34: "¾"
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+\d*);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

export function siteName(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}
