import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSubscription, planOf } from "../src/entitlement.ts";
import { toLibrary, nameKey, type AiRecipe } from "../src/recipe.ts";
import { describeJsonLd, extractJsonLdRecipe, isoMinutes, validatePublicUrl, visibleText } from "../src/urlImport.ts";
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

const aiRecipe: AiRecipe = {
  title: "Curry de pois chiches",
  description: "Un curry doux et économique.",
  emoji: "🍛",
  category: "Plat",
  tags: ["végétarien", "économique"],
  servings: 4,
  prepMinutes: 15,
  cookMinutes: 25,
  restMinutes: 0,
  difficulty: 1,
  ingredients: [
    { name: "Pois chiches", quantity: 400, unit: "g" },
    { name: "Lait de coco", quantity: 400, unit: "ml" },
    { name: "Oignon jaune", quantity: 1, unit: "pièce" },
    { name: "Curcuma", quantity: 1, unit: "unité inventée" }
  ],
  steps: [
    { text: "Émince l'oignon.", minutes: 0, heat: "", temperature: 0, utensil: "Couteau", cue: "" },
    { text: "Fais revenir 5 min.", minutes: 5, heat: "Feu moyen", temperature: 0, utensil: "Sauteuse", cue: "Oignon translucide" },
    { text: "", minutes: 3, heat: "", temperature: 0, utensil: "", cue: "" }
  ],
  equipment: ["Sauteuse"],
  storage: "3 jours au frais.",
  makeAhead: "",
  tips: ["Ajoute du citron."],
  mistakes: [],
  sides: ["Riz basmati"],
  variants: { vegetarian: "", glutenFree: "", cheaper: "", protein: "" },
  newIngredients: [
    { name: "Lait de coco", category: "Liquides & bouillons", unit: "ml", price: 4.2, kcal: 180, protein: 2, carbs: 3, fat: 18, fiber: 0, sugar: 2, satFat: 16, gramsPerPiece: 0, diet: 0 },
    { name: "Oignon jaune", category: "Légumes", unit: "piece", price: 0, kcal: 40, protein: 1, carbs: 9, fat: 0, fiber: 2, sugar: 4, satFat: 0, gramsPerPiece: 120, diet: 0 },
    { name: "Pois chiches", category: "Légumineuses", unit: "g", price: 3, kcal: 120, protein: 7, carbs: 18, fat: 2, fiber: 5, sugar: 1, satFat: 0, gramsPerPiece: 0, diet: 0 },
    { name: "Ingrédient fantôme", category: "Autres", unit: "g", price: 10, kcal: 1, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, satFat: 0, gramsPerPiece: 0, diet: 0 }
  ]
};

test("conversion IA → bibliothèque : bornes, unités, ingrédients connus préservés, jamais de prix nul", () => {
  const lib = toLibrary(aiRecipe, ["pois CHICHES"], { source: "Créée avec l'IA" }) as any;
  const r = lib.recipes[0];
  assert.equal(r.title, "Curry de pois chiches");
  assert.equal(r.ingredients[3].unit, "g", "unité inconnue → g");
  assert.equal(r.steps.length, 2, "étape vide retirée");
  assert.equal(r.steps[0].minutes, undefined, "0 min = pas de minuteur");
  assert.equal(r.steps[1].heat, "Feu moyen");
  const names = lib.ingredients.map((i: any) => i.name);
  assert.deepEqual(names, ["Lait de coco", "Oignon jaune"], "connu et fantôme exclus");
  const onion = lib.ingredients[1];
  assert.equal(onion.price, undefined, "prix 0 → absent (affiché « — »)");
  assert.equal(onion.gramsPerPiece, 120);
  assert.equal(lib.ingredients[0].priceSource, "Estimation IA");
});

test("recette sans ingrédient : refusée", () => {
  assert.throws(() => toLibrary({ ...aiRecipe, ingredients: [] }, [], { source: "x" }));
});

test("nameKey : accents et casse ignorés", () => {
  assert.equal(nameKey("Crème fraîche "), nameKey("creme FRAICHE"));
});

const page = `<!doctype html><html><head><title>Quiche lorraine</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},
{"@type":["Recipe"],"name":"Quiche lorraine &amp; salade","recipeYield":"6 personnes","prepTime":"PT20M","cookTime":"PT1H5M",
"recipeIngredient":["200 g de lardons","3 œufs","20 cl de crème"],
"recipeInstructions":[{"@type":"HowToSection","name":"Pâte","itemListElement":[{"@type":"HowToStep","text":"Étale la pâte."}]},
{"@type":"HowToStep","text":"Fais cuire 40 min à 180 °C."}]}]}</script></head>
<body><nav>Menu</nav><p>Bonjour</p><script>var x=1</script></body></html>`;

test("JSON-LD schema.org Recipe extrait (graphe, sections, entités, durées ISO)", () => {
  const r = extractJsonLdRecipe(page);
  assert.ok(r);
  const text = describeJsonLd(r!);
  assert.match(text, /Titre : Quiche lorraine & salade/);
  assert.match(text, /cuisson 65 min/);
  assert.match(text, /- 3 œufs/);
  assert.match(text, /— Pâte —/);
  assert.match(text, /Fais cuire 40 min/);
  assert.equal(isoMinutes("PT1H30M"), 90);
  assert.equal(isoMinutes("P1DT2H"), 1560);
  assert.equal(isoMinutes("n'importe quoi"), 0);
});

test("texte visible : scripts et menus retirés", () => {
  const t = visibleText(page);
  assert.match(t, /Bonjour/);
  assert.doesNotMatch(t, /var x/);
  assert.doesNotMatch(t, /Menu/);
});

test("adresses refusées (SSRF) et acceptées", () => {
  for (const bad of ["ftp://site.fr/x", "http://localhost/x", "http://127.0.0.1/", "http://192.168.1.2/", "http://10.0.0.1/",
    "http://[::1]/", "http://intranet/", "https://site.fr:8080/", "https://user:pw@site.fr/", "pas une url", "http://172.20.1.1/"]) {
    assert.throws(() => validatePublicUrl(bad), bad);
  }
  assert.equal(validatePublicUrl("https://www.marmiton.org/recettes/x.aspx#avis").toString(), "https://www.marmiton.org/recettes/x.aspx");
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
