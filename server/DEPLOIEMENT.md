# Mettre en ligne EquilibreCuisine Premium

Ce document explique comment rendre actif l'abonnement Premium. La version gratuite de l'application n'en a pas besoin :
elle fonctionne entièrement sur le téléphone, sans serveur et sans aucun coût.

## Vue d'ensemble

```
 Téléphone (gratuit)          Téléphone (abonné)                       Services payants
 ───────────────────          ──────────────────                       ────────────────
 Room, recettes, courses      Google Play Billing ──achat──► Google Play
 → aucun appel serveur        │
                              └─ HTTPS + session ──► Worker Cloudflare ──► API Google Play (vérification)
                                                      │ D1 : abonnements,  ──► API Claude (photo)
                                                      │ sessions, quotas,
                                                      │ synchro, sauvegardes
```

- **Vérification sécurisée** : le serveur interroge l'API Google Play Developer (`purchases.subscriptionsv2`) pour
  chaque achat, et contrôle de nouveau l'abonnement à **chaque** appel payant. Une application modifiée ne peut
  donc rien obtenir sans abonnement valide. L'accusé de réception est fait par le serveur (et par le téléphone en secours).
- **Notifications Google** (RTDN) : résiliation, renouvellement et remboursement sont pris en compte en temps réel.
- **Identité** : aucun compte ni e-mail. L'application génère un identifiant aléatoire, que Google Play enregistre
  dans l'achat (`obfuscatedAccountId`). « Restaurer mes achats » le retrouve sur un nouveau téléphone, avec les données cloud.
- **Quota photo mensuel** par abonné : `QUOTA_PHOTO_MONTH = "5"` (wrangler.toml). Une analyse qui échoue est rendue ;
  le compteur repart de zéro le 1er de chaque mois (UTC). C'est la seule fonction qui utilise l'IA.

## 1. Google Play Console

1. L'application doit être publiée au moins en **test interne**, signée avec votre clé d'importation
   (`keystore.properties`, voir le README). Les achats ne fonctionnent pas avec un APK installé à la main.
2. **Monétiser > Produits > Abonnements > Créer un abonnement**
   - ID produit : `premium`
   - Formule de base `mensuel` : renouvellement automatique, période de **1 mois**, prix **3,99 €**
   - Formule de base `annuel` : renouvellement automatique, période de **1 an**, prix **29,99 €**
   - Activez les deux formules. Facultatif : une offre « essai gratuit » sur l'une ou l'autre (l'application l'affiche automatiquement).
3. **Paramètres > Test des licences** : ajoutez votre adresse Gmail pour acheter en mode test (aucun débit).

## 2. Compte de service Google (vérification des achats)

1. Dans [Google Cloud Console](https://console.cloud.google.com/), créez un projet (ou utilisez celui lié à la Play Console).
2. Activez **Google Play Android Developer API**.
3. **IAM > Comptes de service > Créer** (aucun rôle Cloud nécessaire), puis **Clés > Ajouter une clé > JSON** :
   un fichier `.json` est téléchargé. Gardez-le secret.
4. Dans la Play Console, **Utilisateurs et autorisations > Inviter** l'adresse du compte de service
   (`…@….iam.gserviceaccount.com`) avec, pour cette application :
   « Afficher les informations financières » et « Gérer les commandes et les abonnements ».
   Prévoyez jusqu'à 24 h avant que l'accès soit effectif.

## 3. Clé API Claude

Créez une clé sur [console.anthropic.com](https://console.anthropic.com/) et ajoutez un moyen de paiement.
Fixez une limite de dépense mensuelle dans la console pour une sécurité supplémentaire.

## 4. Cloudflare (le serveur)

### Méthode simple : déploiement automatique par GitHub (recommandé)

Le dépôt `mamar14/equilibrecuisine-recettes` contient le serveur (`server/`) et l'action
« Déployer le serveur Premium » (`.github/workflows/deploy-premium.yml`). Elle crée la base D1, applique le schéma,
déploie le Worker, installe ses secrets et vérifie qu'il répond. Il n'y a rien à installer sur votre ordinateur.

1. Créez un compte gratuit sur [dash.cloudflare.com](https://dash.cloudflare.com/sign-up), puis ouvrez une fois
   **Workers & Pages** et choisissez votre sous-domaine `….workers.dev`.
2. **Identifiant de compte** : Workers & Pages › colonne de droite « Account ID » (copiez-le).
3. **Jeton d'API** : Mon profil › Jetons d'API › Créer un jeton › modèle **« Modifier les Workers Cloudflare »**,
   puis ajoutez la permission **Compte › D1 › Modifier**. Créez le jeton et copiez-le.
4. Sur GitHub : dépôt `equilibrecuisine-recettes` › **Settings › Secrets and variables › Actions › New repository secret**.
   Créez les secrets suivants :

   | Nom | Valeur |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | le jeton de l'étape 3 |
   | `CLOUDFLARE_ACCOUNT_ID` | facultatif : déjà dans `wrangler.toml` |
   | `ANTHROPIC_API_KEY` | votre clé Claude (section 3) |
   | `RTDN_TOKEN` | une longue chaîne aléatoire de votre choix (section 5) |
   | `GOOGLE_SERVICE_ACCOUNT` | *plus tard* : tout le contenu du fichier JSON du compte de service (section 2) |

5. Onglet **Actions › Déployer le serveur Premium › Run workflow**. Au bout d'environ 2 minutes, le résumé affiche
   l'adresse du serveur (`https://equilibrecuisine-premium.<sous-domaine>.workers.dev`).

L'action se relance à chaque modification de `server/` et chaque fois que vous cliquez sur « Run workflow »,
par exemple après avoir ajouté `GOOGLE_SERVICE_ACCOUNT`.

### Méthode manuelle (ligne de commande)

Prérequis : Node.js 20 ou plus, un compte Cloudflare gratuit.

```bash
cd server
npm install
npx wrangler login                              # ouvre le navigateur
npx wrangler d1 create equilibrecuisine         # copiez le database_id affiché dans wrangler.toml
npm run db:init                                 # crée les tables (schema.sql)

npx wrangler secret put ANTHROPIC_API_KEY       # collez la clé Claude
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < chemin/vers/compte-de-service.json
npx wrangler secret put RTDN_TOKEN              # une longue chaîne aléatoire, ex. : openssl rand -hex 24

npm run deploy
```

L'adresse du serveur s'affiche, par exemple `https://equilibrecuisine-premium.<compte>.workers.dev`.
Vérifiez : `https://…workers.dev/v1/health` doit répondre `{"ok":true}`.

## 5. Notifications en temps réel (recommandé)

1. Google Cloud Console > **Pub/Sub > Créer un sujet**, par exemple `play-premium`.
2. Sur ce sujet, donnez le rôle **Éditeur Pub/Sub** à `google-play-developer-notifications@system.gserviceaccount.com`.
3. Créez un **abonnement push** vers `https://…workers.dev/v1/rtdn?token=VOTRE_RTDN_TOKEN`.
4. Play Console > **Monétiser > Configuration de la monétisation** : nom complet du sujet
   (`projects/<projet>/topics/play-premium`), puis « Envoyer une notification de test ».

## 6. Construire l'application avec l'adresse du serveur

```bash
./gradlew -PpremiumApiUrl=https://equilibrecuisine-premium.<compte>.workers.dev/ bundleRelease
```

Importez le fichier `.aab` dans la Play Console (test interne), installez l'application depuis le lien de test,
puis achetez avec un compte testeur. Sans `-PpremiumApiUrl`, l'abonnement fonctionne mais l'analyse photo et le cloud
affichent « Service Premium pas encore en ligne ».

Les recettes de la semaine n'utilisent pas ce serveur : l'application interroge directement TheMealDB. Pour une
application publiée, ajoutez votre clé TheMealDB (abonnement Patreon du site) : `-PmealDbKey=<clé>`.

## Coûts (ordre de grandeur, tarifs publiés en octobre 2026)

| Poste | Gratuit jusqu'à | Au-delà |
|---|---|---|
| Utilisateurs gratuits | — | **0 €** : aucun appel serveur |
| Cloudflare Workers | 100 000 requêtes / jour | 5 $/mois (forfait payant) |
| Cloudflare D1 | 5 Go, 5 millions de lectures / jour | à l'usage |
| Claude Haiku 5.5 | — | une analyse photo ≈ 1 600 jetons en entrée et 300 en sortie, soit moins de 0,1 centime |
| Google Play | — | commission de 15 % sur les abonnements |

Pour un abonné à 3,99 €/mois, la commission Google laisse environ 3,39 € ; les 5 analyses photo du mois coûtent moins
d'un demi-centime avec Haiku. La traduction des recettes se fait sur le téléphone (ML Kit) : aucun coût serveur.

## Tests

```bash
npm test          # logique pure : états Google, quota mensuel, validation photo, signature JWT
npm run test:e2e  # Worker réel en local (wrangler dev + D1 locale), Google Play et Claude simulés
npm run typecheck
```

## Points d'API

| Méthode | Chemin | Rôle | Abonnement requis |
|---|---|---|---|
| POST | `/v1/purchases/verify` | vérifie un achat auprès de Google, crée une session | — (jeton d'achat) |
| POST | `/v1/rtdn?token=…` | notifications Google Play | — (secret) |
| GET | `/v1/me` | état, analyses photo du mois, synchro, sauvegardes | session |
| DELETE | `/v1/me/data` | efface les données cloud (RGPD) | session |
| POST | `/v1/ai/photo` | analyse d'une photo (5 par mois) | oui |
| GET, PUT | `/v1/sync` | copie synchronisée (versionnée, 409 si périmée) | oui |
| GET, POST | `/v1/backups` | liste, création (10 conservées, 1 automatique par jour) | oui |
| GET, DELETE | `/v1/backups/{id}` | lecture, suppression | oui |

Codes d'erreur : 401 session expirée, 402 abonnement requis, 409 conflit de synchronisation, 422 contenu non
exploitable, 429 quota photo du mois atteint (`limit`, `period`, `resetsAt`). Le champ `message` est en français et s'affiche tel quel dans l'application.
