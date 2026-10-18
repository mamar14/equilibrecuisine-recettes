/**
 * Test de bout en bout : le Worker tourne localement (wrangler dev, D1 locale) et Google Play + Claude
 * sont simulés par un petit serveur. Lancer avec `npm run test:e2e`.
 */
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const MOCK_PORT = 18788;
const WORKER_PORT = 18787;
const W = `http://127.0.0.1:${WORKER_PORT}`;
const future = new Date(Date.now() + 30 * 86400_000).toISOString();
const past = new Date(Date.now() - 86400_000).toISOString();
const ACCOUNT = "6b0e2f4c-2f0a-4a8e-9a55-0123456789ab";

const calls = { ack: 0, claude: [] };
const subs = {
  "token-annuel-valide-000001": { state: "SUBSCRIPTION_STATE_ACTIVE", expiry: future, plan: "annuel", ack: "ACKNOWLEDGEMENT_STATE_PENDING" },
  "token-expire-000000000001": { state: "SUBSCRIPTION_STATE_EXPIRED", expiry: past, plan: "mensuel", ack: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }
};

const recipe = {
  title: "Soupe de potiron", description: "Douce et onctueuse.", emoji: "🎃", category: "Entrée", tags: ["automne"],
  servings: 4, prepMinutes: 15, cookMinutes: 25, restMinutes: 0, difficulty: 1,
  ingredients: [{ name: "Potiron", quantity: 800, unit: "g" }, { name: "Oignon jaune", quantity: 1, unit: "pièce" }],
  steps: [{ text: "Coupe le potiron en cubes.", minutes: 0, heat: "", temperature: 0, utensil: "Couteau", cue: "" },
    { text: "Fais cuire 25 min.", minutes: 25, heat: "Feu moyen", temperature: 0, utensil: "Faitout", cue: "Potiron tendre" }],
  equipment: ["Faitout"], storage: "3 jours", makeAhead: "", tips: [], mistakes: [], sides: [],
  variants: { vegetarian: "", glutenFree: "", cheaper: "", protein: "" },
  newIngredients: [{ name: "Potiron", category: "Légumes", unit: "g", price: 2.5, kcal: 26, protein: 1, carbs: 6, fat: 0, fiber: 1, sugar: 3, satFat: 0, gramsPerPiece: 0, diet: 0 }]
};

const mock = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (req.url === "/token") return send(200, { access_token: "jeton-google", expires_in: 3600 });
  const m = /subscriptionsv2\/tokens\/([^/?]+)$/.exec(req.url);
  if (m) {
    assert.equal(req.headers.authorization, "Bearer jeton-google");
    const s = subs[decodeURIComponent(m[1])];
    if (!s) return send(404, { error: { code: 404 } });
    return send(200, {
      subscriptionState: s.state, acknowledgementState: s.ack,
      externalAccountIdentifiers: { obfuscatedExternalAccountId: ACCOUNT },
      lineItems: [{ productId: "premium", expiryTime: s.expiry, autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { basePlanId: s.plan } }]
    });
  }
  if (req.url.endsWith(":acknowledge")) { calls.ack++; return send(200, {}); }
  if (req.url === "/v1/messages") {
    const r = JSON.parse(body);
    calls.claude.push(r);
    assert.equal(req.headers["x-api-key"], "cle-test");
    assert.equal(r.output_config.format.type, "json_schema");
    let out;
    if (r.system.includes("analyser la photo")) {
      out = { isFood: true, dishName: "Soupe de potiron", confidence: 0.8, observations: "Velouté orange.", perPortion: { grams: 300, kcal: 120, protein: 3, carbs: 18, fat: 4 }, recipe };
    } else if (r.system.includes("nutritionniste français bienveillant")) {
      out = { summary: "Voici mes idées.", picks: [{ id: 2, reason: "Rapide" }, { id: 999, reason: "inexistant" }, { id: 2, reason: "doublon" }], ideas: [{ title: "Gratin", pitch: "Réconfortant" }] };
    } else {
      out = recipe;
    }
    return send(200, { content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn" });
  }
  send(404, {});
});

const dir = mkdtempSync(join(tmpdir(), "ec-e2e-"));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = { client_email: "play@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: `http://127.0.0.1:${MOCK_PORT}/token` };
writeFileSync(".dev.vars", [
  `ANTHROPIC_API_KEY="cle-test"`,
  `GOOGLE_SERVICE_ACCOUNT="${Buffer.from(JSON.stringify(sa)).toString("base64")}"`,
  `RTDN_TOKEN="secret-rtdn-test"`,
  `GOOGLE_API_BASE="http://127.0.0.1:${MOCK_PORT}"`,
  `ANTHROPIC_API_BASE="http://127.0.0.1:${MOCK_PORT}"`,
  `QUOTA_PHOTO="2"`,
  // Code de test « TEST-CODE-ACCES-1 » (le vrai code n'est jamais dans le dépôt)
  `ACCESS_CODE_SHA256="${createHash("sha256").update("TEST-CODE-ACCES-1").digest("hex")}"`
].join("\n"));

let worker;
let log = "";
async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  execFileSync("npx", ["wrangler", "d1", "execute", "equilibrecuisine", "--local", "--persist-to", dir, "--file=schema.sql"], { stdio: "pipe" });
  worker = spawn("npx", ["wrangler", "dev", "--port", String(WORKER_PORT), "--ip", "127.0.0.1", "--persist-to", dir, "--show-interactive-dev-session=false"], { stdio: ["ignore", "pipe", "pipe"], detached: true });

  worker.stdout.on("data", (d) => { log += d; });
  worker.stderr.on("data", (d) => { log += d; });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${W}/v1/health`)).ok) break; } catch {}
    if (i > 120) throw new Error("wrangler dev ne démarre pas\n" + log);
    await new Promise((r) => setTimeout(r, 500));
  }

  const call = async (method, path, body, token) => {
    const res = await fetch(W + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const step = (name) => console.log("✓", name);

  // Sans session : refusé
  assert.equal((await call("POST", "/v1/ai/recipe", { prompt: "soupe" })).status, 401);
  step("route IA sans session → 401");

  // Faux achat, mauvais produit, abonnement expiré
  const fake = await call("POST", "/v1/purchases/verify", { purchaseToken: "faux-jeton-inconnu-123", productId: "premium" });
  assert.equal(fake.status, 400, JSON.stringify(fake.body) + log.slice(-3000));
  assert.equal((await call("POST", "/v1/purchases/verify", { purchaseToken: "token-annuel-valide-000001", productId: "autre" })).status, 400);
  const expired = await call("POST", "/v1/purchases/verify", { purchaseToken: "token-expire-000000000001", productId: "premium" });
  assert.equal(expired.status, 200);
  assert.equal(expired.body.premium, false);
  assert.equal(expired.body.sessionToken, undefined);
  step("faux achat / autre produit / expiré → pas de session");

  // Achat valide
  const ok = await call("POST", "/v1/purchases/verify", { purchaseToken: "token-annuel-valide-000001", productId: "premium" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.premium, true);
  assert.equal(ok.body.plan, "yearly");
  assert.equal(ok.body.acknowledged, true);
  assert.equal(calls.ack, 1);
  const token = ok.body.sessionToken;
  assert.ok(token.length > 30);
  step("achat annuel vérifié, acquitté, session créée");

  const me = await call("GET", "/v1/me", undefined, token);
  assert.equal(me.body.premium, true);
  assert.equal(me.body.usage.photo.limit, 2);
  step("/v1/me");

  // Code d'accès des examinateurs
  assert.equal((await call("POST", "/v1/access-code", { code: "MAUVAIS-CODE-000", accountId: "acc-review-0001" })).status, 403);
  const rc = await call("POST", "/v1/access-code", { code: " test-code-acces-1 ", accountId: "acc-review-0001" });
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  assert.equal(rc.body.premium, true);
  const reviewMe = await call("GET", "/v1/me", undefined, rc.body.sessionToken);
  assert.equal(reviewMe.body.premium, true);
  const reviewSync = await call("GET", "/v1/sync", undefined, rc.body.sessionToken);
  assert.equal(reviewSync.status, 200, JSON.stringify(reviewSync.body));
  step("code d'accès : mauvais code refusé, bon code → Premium");

  const gen = await call("POST", "/v1/ai/recipe", { prompt: "soupe d'automne", servings: 4, knownIngredients: ["Oignon jaune"] }, token);
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  assert.equal(gen.body.library.recipes[0].title, "Soupe de potiron");
  assert.equal(gen.body.library.recipes[0].source, "Créée avec l'IA");
  assert.deepEqual(gen.body.library.ingredients.map((i) => i.name), ["Potiron"]);
  assert.equal(gen.body.usage.used, 1);
  assert.equal(calls.claude.at(-1).model, "claude-haiku-5-5");
  assert.match(calls.claude.at(-1).system, /Oignon jaune/);
  step("génération IA");

  const photo = await call("POST", "/v1/ai/photo", { image: "A".repeat(400), mediaType: "image/jpeg" }, token);
  assert.equal(photo.status, 200, JSON.stringify(photo.body));
  assert.equal(photo.body.dish.name, "Soupe de potiron");
  assert.equal(calls.claude.at(-1).messages[0].content[0].type, "image");
  await call("POST", "/v1/ai/photo", { image: "A".repeat(400), mediaType: "image/jpeg" }, token);
  const third = await call("POST", "/v1/ai/photo", { image: "A".repeat(400), mediaType: "image/jpeg" }, token);
  assert.equal(third.status, 429);
  assert.equal(third.body.error, "quota");
  step("analyse photo + quota quotidien (429)");

  const badImg = await call("POST", "/v1/ai/photo", { image: "A".repeat(400), mediaType: "image/gif" }, token);
  assert.equal(badImg.status, 400);

  const sug = await call("POST", "/v1/ai/suggestions", {
    profile: { householdSize: 2, calorieTarget: 2000, dailyBudget: 15 },
    favorites: ["Soupe"], recipes: [{ id: 1, title: "Gratin", category: "Plat", kcal: 500, cost: 1.2, minutes: 40 }, { id: 2, title: "Salade", category: "Entrée", kcal: 200, cost: 0.8, minutes: 10 }]
  }, token);
  assert.equal(sug.status, 200, JSON.stringify(sug.body));
  assert.deepEqual(sug.body.picks.map((p) => p.id), [2], "id inexistant et doublon filtrés");
  step("suggestions personnalisées");

  const ssrf = await call("POST", "/v1/ai/import-url", { url: "http://127.0.0.1:8080/admin" }, token);
  assert.equal(ssrf.status, 400);
  assert.equal((await call("GET", "/v1/me", undefined, token)).body.usage.import.used, 0, "erreur = quota rendu");
  step("import URL : adresse interne refusée, quota rendu");

  // Synchronisation
  const lib = { version: 2, ingredients: [], recipes: [{ title: "A", ingredients: [] }], favorites: ["A"], mealPlan: [] };
  assert.equal((await call("GET", "/v1/sync", undefined, token)).body.version, 0);
  const put1 = await call("PUT", "/v1/sync", { baseVersion: 0, device: "Pixel 8", data: lib }, token);
  assert.equal(put1.status, 200, JSON.stringify(put1.body));
  assert.equal(put1.body.version, 1);
  const stale = await call("PUT", "/v1/sync", { baseVersion: 0, device: "Tablette", data: lib }, token);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.version, 1);
  const pulled = await call("GET", "/v1/sync", undefined, token);
  assert.deepEqual(pulled.body.data, lib);
  assert.equal(pulled.body.device, "Pixel 8");
  step("synchronisation versionnée (409 si périmée), données intactes après gzip");

  // Sauvegardes
  const b1 = await call("POST", "/v1/backups", { device: "Pixel 8", auto: true, data: lib }, token);
  assert.equal(b1.body.skipped, false);
  const b2 = await call("POST", "/v1/backups", { device: "Pixel 8", auto: true, data: lib }, token);
  assert.equal(b2.body.skipped, true, "une sauvegarde automatique par jour");
  const b3 = await call("POST", "/v1/backups", { device: "Pixel 8", auto: false, data: lib }, token);
  assert.equal(b3.body.backups.length, 2);
  const one = await call("GET", `/v1/backups/${b1.body.id}`, undefined, token);
  assert.deepEqual(one.body.data, lib);
  const del = await call("DELETE", `/v1/backups/${b1.body.id}`, undefined, token);
  assert.equal(del.body.backups.length, 1);
  step("sauvegardes : création, limite auto, lecture, suppression");

  // Notification Google : mauvais secret refusé ; résiliation + expiration → accès coupé
  assert.equal((await call("POST", "/v1/rtdn?token=mauvais", { message: { data: "" } })).status, 403);
  subs["token-annuel-valide-000001"] = { state: "SUBSCRIPTION_STATE_EXPIRED", expiry: past, plan: "annuel", ack: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" };
  const data = Buffer.from(JSON.stringify({ packageName: "com.equilibrecuisine.app", subscriptionNotification: { notificationType: 13, purchaseToken: "token-annuel-valide-000001", subscriptionId: "premium" } })).toString("base64");
  assert.equal((await call("POST", "/v1/rtdn?token=secret-rtdn-test", { message: { data } })).status, 204);
  const after = await call("POST", "/v1/ai/recipe", { prompt: "soupe" }, token);
  assert.equal(after.status, 402);
  assert.equal(after.body.error, "premium_required");
  assert.equal((await call("GET", "/v1/me", undefined, token)).body.premium, false);
  step("notification d'expiration → fonctions payantes bloquées (402)");

  assert.equal((await call("DELETE", "/v1/me/data", undefined, token)).body.deleted, true);
  step("effacement des données cloud");
  console.log("\nTous les tests de bout en bout sont passés.");
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((e) => { console.error(e); console.error(log.split("\n").slice(-40).join("\n")); cleanup(); process.exit(1); });

function cleanup() {
  // Arrête wrangler ET workerd (groupe de processus).
  if (worker?.pid) { try { process.kill(-worker.pid, "SIGTERM"); } catch {} }
  mock.close();
  rmSync(".dev.vars", { force: true });
  rmSync(dir, { recursive: true, force: true });
}
