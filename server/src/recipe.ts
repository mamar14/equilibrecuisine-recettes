/**
 * Recette produite par l'IA : schéma JSON imposé à Claude, consignes de rédaction, et conversion vers
 * le format de bibliothèque de l'application (LibraryJson v2, voir docs/FORMATS.md).
 */
import { int, str, strList } from "./http.ts";

export const RECIPE_CATEGORIES = [
  "Entrée", "Plat", "Dessert", "Petit-déjeuner", "Collation", "Batch cooking", "Repas sportif", "Recette familiale"
];
export const INGREDIENT_CATEGORIES = [
  "Légumes", "Fruits", "Viandes & volailles", "Poissons & fruits de mer", "Produits laitiers", "Œufs",
  "Féculents & céréales", "Légumineuses", "Huiles & matières grasses", "Épices & aromates", "Condiments & sauces",
  "Sucrants & douceurs", "Noix & graines", "Liquides & bouillons", "Autres"
];
const LINE_UNITS = ["g", "kg", "ml", "cl", "l", "pièce", "c. à café", "c. à soupe", "pincée"];
const HEATS = ["", "Feu très doux", "Feu doux", "Feu moyen", "Feu moyen-vif", "Feu vif"];

const strings = { type: "array", items: { type: "string" } };

export const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "description", "emoji", "category", "tags", "servings", "prepMinutes", "cookMinutes", "restMinutes",
    "difficulty", "ingredients", "steps", "equipment", "storage", "makeAhead", "tips", "mistakes", "sides",
    "variants", "newIngredients"
  ],
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    emoji: { type: "string" },
    category: { type: "string", enum: RECIPE_CATEGORIES },
    tags: strings,
    servings: { type: "integer" },
    prepMinutes: { type: "integer" },
    cookMinutes: { type: "integer" },
    restMinutes: { type: "integer" },
    difficulty: { type: "integer", enum: [1, 2, 3] },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quantity", "unit"],
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
          unit: { type: "string", enum: LINE_UNITS }
        }
      }
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "minutes", "heat", "temperature", "utensil", "cue"],
        properties: {
          text: { type: "string" },
          minutes: { type: "number" },
          heat: { type: "string", enum: HEATS },
          temperature: { type: "integer" },
          utensil: { type: "string" },
          cue: { type: "string" }
        }
      }
    },
    equipment: strings,
    storage: { type: "string" },
    makeAhead: { type: "string" },
    tips: strings,
    mistakes: strings,
    sides: strings,
    variants: {
      type: "object",
      additionalProperties: false,
      required: ["vegetarian", "glutenFree", "cheaper", "protein"],
      properties: {
        vegetarian: { type: "string" },
        glutenFree: { type: "string" },
        cheaper: { type: "string" },
        protein: { type: "string" }
      }
    },
    newIngredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "category", "unit", "price", "kcal", "protein", "carbs", "fat", "fiber", "sugar", "satFat", "gramsPerPiece", "diet"],
        properties: {
          name: { type: "string" },
          category: { type: "string", enum: INGREDIENT_CATEGORIES },
          unit: { type: "string", enum: ["g", "ml", "piece"] },
          price: { type: "number" },
          kcal: { type: "number" },
          protein: { type: "number" },
          carbs: { type: "number" },
          fat: { type: "number" },
          fiber: { type: "number" },
          sugar: { type: "number" },
          satFat: { type: "number" },
          gramsPerPiece: { type: "number" },
          diet: { type: "integer", enum: [0, 1, 2, 3] }
        }
      }
    }
  }
} as const;

/** Consignes communes : même style que les 288 recettes fournies avec l'application. */
export function recipeWritingRules(known: string[]): string {
  return [
    "Tu es un chef cuisinier et nutritionniste français. Tu rédiges des recettes familiales, équilibrées et économiques, en français.",
    "Règles de rédaction :",
    "- Étapes au tutoiement, à l'impératif (« Coupe », « Fais revenir »). Chaque étape précise l'action, la quantité concernée, l'ustensile, la durée, le feu et un repère visuel (« jusqu'à ce que les oignons soient translucides »).",
    "- Une étape = une action principale ; 5 à 10 étapes. `minutes` = durée minutée de l'étape (0 si aucune attente), `temperature` = four en °C (0 si pas de four), `heat` = intensité du feu (\"\" si pas de feu).",
    "- Quantités réalistes pour le nombre de portions, en grammes de préférence (pièce pour les œufs, gousses, fruits entiers…).",
    "- Noms d'ingrédients simples au singulier, sans quantité ni préparation (« Oignon jaune », pas « 2 oignons émincés »).",
    known.length > 0
      ? `- Ingrédients déjà connus de l'utilisateur : réutilise EXACTEMENT ces noms quand ils conviennent : ${known.join(" ; ")}.`
      : "",
    "- `newIngredients` : uniquement les ingrédients de la recette absents de cette liste. Pour chacun : prix moyen constaté en supermarché en France (€/kg si unit=g, €/L si unit=ml, €/pièce si unit=piece), valeurs nutritionnelles pour 100 g, gramsPerPiece (0 si non pertinent), diet : 0 végan, 1 végétarien, 2 poisson, 3 viande.",
    "- `difficulty` : 1 facile, 2 moyen, 3 difficile. `emoji` : un seul emoji représentatif.",
    "- Conseils, erreurs à éviter, accompagnements : 2 à 4 éléments courts chacun. Variantes : une phrase chacune.",
    "- Ne jamais inventer de marque, de source ni de lien."
  ].filter(Boolean).join("\n");
}

export interface AiRecipe {
  title: string;
  description: string;
  emoji: string;
  category: string;
  tags: string[];
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  restMinutes: number;
  difficulty: number;
  ingredients: Array<{ name: string; quantity: number; unit: string }>;
  steps: Array<{ text: string; minutes: number; heat: string; temperature: number; utensil: string; cue: string }>;
  equipment: string[];
  storage: string;
  makeAhead: string;
  tips: string[];
  mistakes: string[];
  sides: string[];
  variants: { vegetarian: string; glutenFree: string; cheaper: string; protein: string };
  newIngredients: Array<{
    name: string; category: string; unit: string; price: number; kcal: number; protein: number; carbs: number;
    fat: number; fiber: number; sugar: number; satFat: number; gramsPerPiece: number; diet: number;
  }>;
}

export function nameKey(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9œæ]+/g, " ").trim();
}

function num(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return Math.round(n * 100) / 100;
}

export interface SourceInfo {
  source: string;
  sourceUrl?: string;
  id?: string;
}

/**
 * Convertit la sortie de l'IA en bibliothèque importable par l'application, en bornant chaque valeur :
 * une réponse aberrante ne peut ni planter l'import ni créer de prix nul.
 */
export function toLibrary(ai: AiRecipe, known: string[], info: SourceInfo): Record<string, unknown> {
  const ingredients = (Array.isArray(ai.ingredients) ? ai.ingredients : [])
    .map((i) => ({
      name: str(i?.name, 60),
      quantity: num(i?.quantity, 0, 10_000) ?? 0,
      unit: LINE_UNITS.includes(i?.unit) ? i.unit : "g"
    }))
    .filter((i) => i.name.length > 0)
    .slice(0, 40);
  if (ingredients.length === 0) throw new Error("Recette sans ingrédient");

  const steps = (Array.isArray(ai.steps) ? ai.steps : [])
    .map((s) => {
      const minutes = num(s?.minutes, 0, 24 * 60);
      const temperature = num(s?.temperature, 40, 300);
      const heat = HEATS.includes(s?.heat) && s.heat !== "" ? s.heat : undefined;
      return {
        text: str(s?.text, 600),
        ...(minutes && minutes > 0 ? { minutes } : {}),
        ...(heat ? { heat } : {}),
        ...(temperature ? { temperature: Math.round(temperature) } : {}),
        ...(str(s?.utensil, 80) ? { utensil: str(s?.utensil, 80) } : {}),
        ...(str(s?.cue, 200) ? { cue: str(s?.cue, 200) } : {})
      };
    })
    .filter((s) => s.text.length > 0)
    .slice(0, 20);

  const knownKeys = new Set(known.map(nameKey));
  const usedKeys = new Set(ingredients.map((i) => nameKey(i.name)));
  const seen = new Set<string>();
  const newIngredients = (Array.isArray(ai.newIngredients) ? ai.newIngredients : [])
    .filter((n) => {
      const key = nameKey(str(n?.name, 60));
      if (!key || knownKeys.has(key) || !usedKeys.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((n) => {
      const unit = ["g", "ml", "piece"].includes(n.unit) ? n.unit : "g";
      const price = num(n.price, 0.01, unit === "piece" ? 100 : 500);
      const gramsPerPiece = num(n.gramsPerPiece, 1, 5000);
      return {
        name: str(n.name, 60),
        category: INGREDIENT_CATEGORIES.includes(n.category) ? n.category : "Autres",
        unit,
        ...(price ? { price, priceSource: "Estimation IA" } : {}),
        kcal: num(n.kcal, 0, 900),
        protein: num(n.protein, 0, 100),
        carbs: num(n.carbs, 0, 100),
        fat: num(n.fat, 0, 100),
        fiber: num(n.fiber, 0, 100),
        sugar: num(n.sugar, 0, 100),
        satFat: num(n.satFat, 0, 100),
        ...(gramsPerPiece ? { gramsPerPiece } : {}),
        diet: int(n.diet, 0, 3, 3)
      };
    });

  const v = ai.variants ?? ({} as AiRecipe["variants"]);
  const recipe = {
    ...(info.id ? { id: info.id } : {}),
    title: str(ai.title, 90) || "Recette sans titre",
    description: str(ai.description, 400),
    emoji: str(ai.emoji, 8) || "🍽️",
    category: RECIPE_CATEGORIES.includes(ai.category) ? ai.category : "Plat",
    tags: strList(ai.tags, 6, 30),
    servings: int(ai.servings, 1, 20, 4),
    prepMinutes: int(ai.prepMinutes, 0, 600, 15),
    cookMinutes: int(ai.cookMinutes, 0, 1440, 15),
    restMinutes: int(ai.restMinutes, 0, 2880, 0),
    difficulty: int(ai.difficulty, 1, 3, 1),
    ingredients,
    steps,
    source: info.source,
    ...(info.sourceUrl ? { sourceUrl: info.sourceUrl } : {}),
    equipment: strList(ai.equipment, 10, 60),
    storage: str(ai.storage, 300),
    makeAhead: str(ai.makeAhead, 300),
    tips: strList(ai.tips, 5, 200),
    mistakes: strList(ai.mistakes, 5, 200),
    sides: strList(ai.sides, 5, 120),
    variants: {
      vegetarian: str(v.vegetarian, 250),
      glutenFree: str(v.glutenFree, 250),
      cheaper: str(v.cheaper, 250),
      protein: str(v.protein, 250)
    }
  };
  return { version: 2, ingredients: newIngredients, recipes: [recipe] };
}
