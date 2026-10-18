# Flux de recettes EquilibreCuisine

Nouvelles recettes hebdomadaires de l'application Android EquilibreCuisine, publiées via GitHub Pages.

- `index.json` : liste des semaines (id, date de publication, fichier).
- `weeks/AAAA-Wnn.json` : 10 recettes détaillées par semaine (format décrit dans `docs/FORMATS.md` du projet).

Adresse lue par l'application : https://mamar14.github.io/equilibrecuisine-recettes/index.json

## Site de l'application
- `index.html` : page de présentation et téléchargement de l'APK (`app/EquilibreCuisine.apk`) — https://mamar14.github.io/equilibrecuisine-recettes/
- `confidentialite.html` : politique de confidentialité (lien à indiquer dans la Play Console) — https://mamar14.github.io/equilibrecuisine-recettes/confidentialite.html

## Serveur Premium
- `server/` : Worker Cloudflare (abonnements Google Play, IA Claude, synchronisation, sauvegardes).
- Déploiement automatique : onglet Actions › « Déployer le serveur Premium » (voir `server/DEPLOIEMENT.md`).
