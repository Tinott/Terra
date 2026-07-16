# TERRA — Criblage foncier

Outil de faisabilité grossière pour promoteurs. Il collecte les données publiques
d'une parcelle (cadastre, zonage, servitudes, risques), lit les règles du PLU,
calcule une enveloppe constructible et remonte la **charge foncière admissible**
pour une marge cible — en fourchette, jamais en chiffre unique.

C'est un outil de **tri**, pas une étude. Il dit non vite, et il dit pourquoi.

---

## Déploiement sur Netlify (2 façons)

### A. Glisser-déposer (le plus simple, mais SANS les fonctions serveur)
Le drag-and-drop de Netlify ne construit pas le projet ni les fonctions.
Pour cette voie, il faut d'abord builder en local :

```bash
npm install
npm run build
```

Puis glisser le dossier **`dist/`** sur https://app.netlify.com/drop.
⚠️ Les fonctions serverless (proxy + extraction PLU) ne seront PAS actives.
La récupération auto des données échouera → l'app bascule en saisie manuelle.
Utile pour montrer l'interface, pas pour le pipeline complet.

### B. Depuis Git (recommandé — tout fonctionne)
1. Pousse ce dossier sur un dépôt GitHub.
2. Sur Netlify : **Add new site → Import an existing project** → choisis le dépôt.
3. Netlify lit `netlify.toml` tout seul (build `npm run build`, publish `dist`,
   functions `netlify/functions`). Laisse les valeurs par défaut.
4. **Variables d'environnement** → ajoute :
   - `ANTHROPIC_API_KEY` = ta clé API Anthropic (pour l'extraction PLU).
     Sans elle, tout marche sauf la lecture automatique des règlements texte.
5. Déploie. Le proxy CORS et l'extraction PLU sont actifs.

---

## Ce qui marche

- **Interface complète** : ajout de terrains (adresse, référence cadastrale, lot CSV),
  liste triée en 3 piles (à creuser / marginal / écarté), filtres.
- **Calcul complet** : enveloppe constructible, bilan promoteur inversé,
  Monte-Carlo (fourchette P10–P90), verdict à seuils asymétriques.
- **Hypothèses éditables** : presets régionaux, tout modifiable, versionné.
- **Deux voies pour le PLU** :
  - *PLU classiques* → extraction du règlement texte par IA (citation + confiance).
  - *PLU à étiquettes* (Toulouse Métropole…) → lecture/saisie de l'étiquette
    `HF · HV · CES · CEPT`, avec bande de constructibilité 15,5 m appliquée.

## Ce qui dépend des fonctions serveur (voie B)

- Récupération automatique cadastre / zonage / servitudes / risques (via proxy).
- Lecture automatique de l'étiquette Toulouse (si la donnée est exposée).
- Extraction IA des règles de PLU (via clé Anthropic).

## Limites assumées

- Les **hypothèses de coût** sont des ordres de grandeur : à recalibrer sur vos
  opérations réelles. Elles sont fausses tant qu'un promoteur ne les a pas validées.
- L'**enveloppe constructible** est une approximation (pas un projet d'architecte).
- Les **servitudes de droit privé**, la **capacité des réseaux** et la **pollution
  réelle** ne sont dans aucune base publique : l'app le signale, ne les invente pas.
- Une **donnée absente n'est jamais traitée comme une contrainte absente**.

## Développement local

```bash
npm install
npm run dev        # front sur http://localhost:5173
```

Pour tester les fonctions en local, installe la CLI Netlify puis :

```bash
npm i -g netlify-cli
netlify dev        # sert le front + les fonctions ensemble
```
