/** Fonctions IA Premium : génération, import d'URL, analyse de photo, suggestions. */
import { claudeJson, type ContentBlock } from "./claude.ts";
import type { Env } from "./env.ts";
import { ApiError, Errors, int, str, strList } from "./http.ts";
import { RECIPE_SCHEMA, recipeWritingRules, toLibrary, type AiRecipe } from "./recipe.ts";
import { describeJsonLd, extractJsonLdRecipe, fetchPage, siteName, validatePublicUrl, visibleText } from "./urlImport.ts";

const RECIPE_MAX_TOKENS = 6000;

/** Noms d'ingrédients déjà présents dans l'application (réutilisés tels quels par l'IA). */
export function knownIngredients(body: Record<string, unknown>): string[] {
  return strList(body.knownIngredients, 500, 60);
}

export async function generateRecipe(env: Env, body: Record<string, unknown>) {
  const prompt = str(body.prompt, 500);
  if (prompt.length < 3) throw Errors.badRequest("Décrivez la recette souhaitée.");
  const servings = int(body.servings, 1, 12, 4);
  const maxMinutes = int(body.maxMinutes, 0, 600, 0);
  const diet = str(body.diet, 60);
  const budget = str(body.budget, 20);
  const avoid = strList(body.avoidTitles, 40, 90);
  const known = knownIngredients(body);
  const request = [
    `Demande : ${prompt}`,
    `Portions : ${servings}`,
    maxMinutes > 0 ? `Temps total maximum : ${maxMinutes} minutes` : "",
    diet ? `Régime : ${diet}` : "",
    budget === "eco" ? "Budget : économique (moins de 2 € par portion)" : budget === "festif" ? "Budget : repas de fête" : "",
    avoid.length > 0 ? `Recettes déjà présentes à ne pas reproduire : ${avoid.join(" ; ")}` : ""
  ].filter(Boolean).join("\n");
  const ai = await claudeJson<AiRecipe>(env, {
    system: recipeWritingRules(known),
    content: [{ type: "text", text: request }],
    schema: RECIPE_SCHEMA,
    maxTokens: RECIPE_MAX_TOKENS
  });
  return { library: toLibrary(ai, known, { source: "Créée avec l'IA" }) };
}

export async function importFromUrl(env: Env, body: Record<string, unknown>) {
  const url = validatePublicUrl(str(body.url, 2000));
  const known = knownIngredients(body);
  const html = await fetchPage(url);
  const jsonLd = extractJsonLdRecipe(html);
  const material = jsonLd ? describeJsonLd(jsonLd) : visibleText(html);
  const system = [
    recipeWritingRules(known),
    "",
    "Tâche : convertir la recette fournie (extraite d'une page web) au format demandé.",
    "- Reste fidèle à la recette d'origine : mêmes ingrédients, quantités et étapes. N'invente rien d'essentiel.",
    "- Convertis les quantités en grammes ou millilitres quand c'est possible ; garde les pièces pour les éléments entiers.",
    "- Reformule les étapes avec tes propres mots au tutoiement, en complétant ustensile, durée, feu et repère visuel quand c'est déductible.",
    "- Si le texte ne contient aucune recette de cuisine, renvoie un titre vide et aucune étape ni ingrédient."
  ].join("\n");
  const ai = await claudeJson<AiRecipe>(env, {
    system,
    content: [{ type: "text", text: `Page : ${url.toString()}\n\n${material}` }],
    schema: RECIPE_SCHEMA,
    maxTokens: RECIPE_MAX_TOKENS
  });
  if (!str(ai.title, 90) || !Array.isArray(ai.ingredients) || ai.ingredients.length === 0) {
    throw new ApiError(422, "not_a_recipe", "Aucune recette trouvée sur cette page.");
  }
  return {
    structuredData: jsonLd !== null,
    library: toLibrary(ai, known, { source: siteName(url), sourceUrl: url.toString(), id: `url:${url.hostname}${url.pathname}`.slice(0, 200) })
  };
}

const PHOTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isFood", "dishName", "confidence", "observations", "perPortion", "recipe"],
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
    recipe: RECIPE_SCHEMA
  }
} as const;

interface PhotoAnalysis {
  isFood: boolean;
  dishName: string;
  confidence: number;
  observations: string;
  perPortion: { grams: number; kcal: number; protein: number; carbs: number; fat: number };
  recipe: AiRecipe;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Contrôle de l'image AVANT de décompter le quota. */
export function validatePhoto(body: Record<string, unknown>): { mediaType: string; image: string } {
  const mediaType = str(body.mediaType, 20) || "image/jpeg";
  if (!IMAGE_TYPES.includes(mediaType)) throw Errors.badRequest("Format d'image non pris en charge (JPEG, PNG ou WebP).");
  const image = typeof body.image === "string" ? body.image.replace(/\s+/g, "") : "";
  if (image.length < 100 || !/^[A-Za-z0-9+/]+=*$/.test(image)) throw Errors.badRequest("Image manquante ou illisible.");
  if (image.length > 6_000_000) throw Errors.tooLarge();
  return { mediaType, image };
}

export async function analyzePhoto(env: Env, body: Record<string, unknown>) {
  const { mediaType, image } = validatePhoto(body);
  const known = knownIngredients(body);
  const servings = int(body.servings, 1, 12, 2);
  const system = [
    recipeWritingRules(known),
    "",
    "Tâche : analyser la photo d'un plat.",
    "- isFood = false si la photo ne montre pas de nourriture (laisse alors les autres champs vides ou à 0).",
    "- dishName : nom du plat en français ; confidence entre 0 et 1 ; observations : ce que tu vois (ingrédients visibles, cuisson, présentation) en 2 phrases.",
    "- perPortion : estimation pour la portion visible (poids en g, kcal, protéines, glucides, lipides en g). Reste prudent : c'est une estimation visuelle.",
    `- recipe : une recette fidèle pour refaire ce plat à la maison, pour ${servings} portions.`
  ].join("\n");
  const content: ContentBlock[] = [
    { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
    { type: "text", text: "Analyse ce plat." }
  ];
  const result = await claudeJson<PhotoAnalysis>(env, { system, content, schema: PHOTO_SCHEMA, maxTokens: RECIPE_MAX_TOKENS + 500 });
  if (!result.isFood) throw new ApiError(422, "not_food", "Aucun plat reconnu sur cette photo. Essayez avec une photo plus nette, prise au-dessus de l'assiette.");
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
      }
    },
    library: toLibrary(result.recipe, known, { source: "Analyse photo (IA)" })
  };
}

const SUGGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "picks", "ideas"],
  properties: {
    summary: { type: "string" },
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reason"],
        properties: { id: { type: "integer" }, reason: { type: "string" } }
      }
    },
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "pitch"],
        properties: { title: { type: "string" }, pitch: { type: "string" } }
      }
    }
  }
} as const;

interface Suggestions {
  summary: string;
  picks: Array<{ id: number; reason: string }>;
  ideas: Array<{ title: string; pitch: string }>;
}

interface CatalogItem {
  id: number;
  title: string;
  category: string;
  kcal: number;
  cost: number;
  minutes: number;
}

export async function suggest(env: Env, body: Record<string, unknown>) {
  const catalog: CatalogItem[] = (Array.isArray(body.recipes) ? body.recipes : [])
    .slice(0, 400)
    .map((r: Record<string, unknown>) => ({
      id: int(r?.id, 0, Number.MAX_SAFE_INTEGER, 0),
      title: str(r?.title, 90),
      category: str(r?.category, 40),
      kcal: int(r?.kcal, 0, 5000, 0),
      cost: Math.max(0, Math.round(Number(r?.cost) * 100) / 100 || 0),
      minutes: int(r?.minutes, 0, 2000, 0)
    }))
    .filter((r) => r.id > 0 && r.title);
  if (catalog.length === 0) throw Errors.badRequest("Aucune recette à proposer.");
  const favorites = strList(body.favorites, 50, 90);
  const recent = strList(body.recent, 40, 90);
  const request = str(body.request, 300);
  const profile = (body.profile ?? {}) as Record<string, unknown>;
  const lines = [
    `Profil : ${int(profile.householdSize, 1, 12, 2)} personne(s), objectif ${int(profile.calorieTarget, 800, 5000, 2000)} kcal/jour/personne, budget ${Number(profile.dailyBudget) || 0} €/jour pour le foyer.`,
    favorites.length ? `Favoris : ${favorites.join(" ; ")}` : "Aucun favori.",
    recent.length ? `Déjà planifié ou cuisiné récemment (à éviter) : ${recent.join(" ; ")}` : "",
    request ? `Envie du moment : ${request}` : "",
    "Recettes disponibles (id | titre | catégorie | kcal par portion | coût par portion € | minutes) :",
    ...catalog.map((r) => `${r.id} | ${r.title} | ${r.category} | ${r.kcal} | ${r.cost} | ${r.minutes}`)
  ].filter(Boolean);
  const result = await claudeJson<Suggestions>(env, {
    system: [
      "Tu es un nutritionniste français bienveillant. Tu proposes des repas variés, équilibrés et adaptés au budget.",
      "- picks : 6 recettes maximum choisies UNIQUEMENT parmi les identifiants fournis, chacune avec une raison courte et personnalisée (une phrase, au vouvoiement).",
      "- Varie les catégories et les ingrédients principaux ; évite les recettes récentes ; respecte l'envie du moment si elle est donnée.",
      "- ideas : 2 idées de nouvelles recettes absentes de la liste (titre + une phrase).",
      "- summary : une phrase d'introduction chaleureuse."
    ].join("\n"),
    content: [{ type: "text", text: lines.join("\n") }],
    schema: SUGGEST_SCHEMA,
    maxTokens: 2000
  });
  const valid = new Set(catalog.map((r) => r.id));
  const seen = new Set<number>();
  const picks = (result.picks ?? [])
    .filter((p) => valid.has(p.id) && !seen.has(p.id) && seen.add(p.id))
    .slice(0, 6)
    .map((p) => ({ id: p.id, reason: str(p.reason, 200) }));
  const ideas = (result.ideas ?? []).slice(0, 3).map((i) => ({ title: str(i.title, 90), pitch: str(i.pitch, 200) })).filter((i) => i.title);
  return { summary: str(result.summary, 300), picks, ideas };
}
