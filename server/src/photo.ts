/**
 * Analyse photo Premium : la seule fonction IA du service.
 * Reconnaît le plat et estime sa valeur nutritionnelle ; AUCUNE recette n'est générée
 * (l'application propose ensuite les recettes proches de sa propre bibliothèque grâce aux mots-clés).
 */
import { claudeJson, type ContentBlock } from "./claude.ts";
import type { Env } from "./env.ts";
import { ApiError, Errors, str, strList } from "./http.ts";

const PHOTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isFood", "dishName", "confidence", "observations", "perPortion", "keywords"],
  properties: {
    isFood: { type: "boolean" },
    dishName: { type: "string" },
    confidence: { type: "number" },
    observations: { type: "string" },
    perPortion: {
      type: "object",
      additionalProperties: false,
      required: ["grams", "kcal", "protein", "carbs", "fat"],
      properties: {
        grams: { type: "number" },
        kcal: { type: "number" },
        protein: { type: "number" },
        carbs: { type: "number" },
        fat: { type: "number" }
      }
    },
    keywords: { type: "array", items: { type: "string" } }
  }
} as const;

interface PhotoAnalysis {
  isFood: boolean;
  dishName: string;
  confidence: number;
  observations: string;
  perPortion: { grams: number; kcal: number; protein: number; carbs: number; fat: number };
  keywords: string[];
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Contrôle de l'image AVANT de décompter le quota (une image refusée ne consomme pas d'analyse). */
export function validatePhoto(body: Record<string, unknown>): { mediaType: string; image: string } {
  const mediaType = str(body.mediaType, 20) || "image/jpeg";
  if (!IMAGE_TYPES.includes(mediaType)) throw Errors.badRequest("Format d'image non pris en charge (JPEG, PNG ou WebP).");
  const image = typeof body.image === "string" ? body.image.replace(/\s+/g, "") : "";
  if (image.length < 100 || !/^[A-Za-z0-9+/]+=*$/.test(image)) throw Errors.badRequest("Image manquante ou illisible.");
  if (image.length > 6_000_000) throw Errors.tooLarge();
  return { mediaType, image };
}

const SYSTEM = [
  "Tu es un nutritionniste français. Tu analyses la photo d'un plat.",
  "- isFood = false si la photo ne montre pas de nourriture (laisse alors les autres champs vides ou à 0).",
  "- dishName : nom du plat en français ; confidence entre 0 et 1.",
  "- observations : ce que tu vois (ingrédients visibles, cuisson, présentation) en 2 phrases, au vouvoiement.",
  "- perPortion : estimation pour la portion visible (poids en g, kcal, protéines, glucides, lipides en g). Reste prudent : c'est une estimation visuelle.",
  "- keywords : 3 à 6 mots-clés en français, au singulier et en minuscules (plat, ingrédients principaux), pour retrouver des recettes proches.",
  "- Ne rédige aucune recette."
].join("\n");

export async function analyzePhoto(env: Env, body: Record<string, unknown>) {
  const { mediaType, image } = validatePhoto(body);
  const content: ContentBlock[] = [
    { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
    { type: "text", text: "Analysez ce plat." }
  ];
  const result = await claudeJson<PhotoAnalysis>(env, { system: SYSTEM, content, schema: PHOTO_SCHEMA, maxTokens: 800 });
  if (!result.isFood) {
    throw new ApiError(422, "not_food", "Aucun plat reconnu sur cette photo. Essayez avec une photo plus nette, prise au-dessus de l'assiette.");
  }
  const p = result.perPortion ?? ({} as PhotoAnalysis["perPortion"]);
  const round = (v: unknown, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0;
  };
  return {
    dish: {
      name: str(result.dishName, 90),
      confidence: Math.min(1, Math.max(0, Number(result.confidence) || 0)),
      observations: str(result.observations, 500),
      perPortion: {
        grams: round(p.grams, 3000),
        kcal: round(p.kcal, 5000),
        protein: round(p.protein, 500),
        carbs: round(p.carbs, 1000),
        fat: round(p.fat, 500)
      },
      keywords: strList(result.keywords, 6, 40).map((k) => k.toLowerCase())
    }
  };
}
