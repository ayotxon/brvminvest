# BRVM Conseil — version autonome (sans Claude)

Version indépendante de claude.ai du dashboard BRVM Conseil : mêmes analyses et
recommandations quotidiennes, mais hébergeable n'importe où (GitHub Pages,
Netlify, Vercel, ton propre serveur) avec une mise à jour automatique via
GitHub Actions.

## Ce qui change par rapport à la version claude.ai

| | Version claude.ai (Artifact) | Version autonome (ce dossier) |
|---|---|---|
| Récupération des cours | `WebFetch` (outil Claude) | `scrape_brvm.py` (requests + BeautifulSoup, accès direct à brvm.org) |
| Sauvegarde profil/portefeuille/watchlist | republication de la page via `claude.use("artifact")` | `localStorage` du navigateur (par appareil/navigateur) |
| Mise à jour quotidienne | tâche planifiée Claude | GitHub Actions (`.github/workflows/daily-update.yml`) |
| Moteur d'analyse | identique | identique (`analysis_engine.py`, aucune dépendance) |

Le profil/portefeuille/watchlist étant stockés dans le navigateur, ils sont
propres à chaque appareil/navigateur (pas de synchronisation multi-appareils
sans base de données — voir "Aller plus loin" en bas de page).

## Déploiement en 5 minutes (GitHub Pages)

1. Crée un nouveau dépôt GitHub (public ou privé) et pousse-y tout le contenu
   de ce dossier :

   ```bash
   cd brvm-conseil-standalone
   git init
   git add .
   git commit -m "Initial commit — BRVM Conseil autonome"
   git branch -M main
   git remote add origin https://github.com/<ton-compte>/<ton-repo>.git
   git push -u origin main
   ```

2. Dans le dépôt GitHub : **Settings → Pages → Build and deployment → Source :
   Deploy from a branch**, puis choisis la branche `main` et le dossier `/
   (root)`. Après une minute, ton dashboard est en ligne à
   `https://<ton-compte>.github.io/<ton-repo>/`.

3. Dans **Settings → Actions → General → Workflow permissions**, sélectionne
   **"Read and write permissions"** (nécessaire pour que la tâche quotidienne
   puisse pousser ses mises à jour). C'est la seule configuration
   supplémentaire à faire.

4. C'est tout. Chaque jour ouvré à 17h UTC, l'Action `daily-update.yml` :
   récupère les nouveaux cours, met à jour `history.json`, régénère
   `index.html`, et republie automatiquement (GitHub Pages se redéploie tout
   seul à chaque push).

5. Pour tester tout de suite sans attendre demain : onglet **Actions** du
   dépôt → "Mise à jour quotidienne BRVM Conseil" → **Run workflow**.

## Déploiement sur Netlify ou Vercel

Les deux fonctionnent en mode "site statique", sans commande de build :

- **Netlify** : "Add new site" → "Import an existing project" → connecte le
  dépôt GitHub → *Build command* : (laisser vide) → *Publish directory* : `.`
  (racine). L'automatisation reste sur GitHub Actions (qui pousse dans le
  dépôt) ; Netlify se redéploie automatiquement à chaque push, comme GitHub
  Pages.
- **Vercel** : "Add New Project" → importe le dépôt → *Framework preset* :
  "Other" → *Build command* : vide → *Output directory* : `.`. Même principe.

## Utilisation en local (sans rien héberger)

Ouvre simplement `index.html` dans ton navigateur (double-clic, ou
`open index.html` / `start index.html`). Tout fonctionne (tableau, profils,
portefeuille, watchlist), sauvegardé dans le stockage local de TON
navigateur.

Pour mettre à jour les données toi-même quand tu veux :

```bash
python3 -m venv .venv && source .venv/bin/activate   # optionnel mais recommandé
pip install -r requirements.txt
python3 update_daily.py
```

Cela régénère `index.html` avec les cours du jour. Pour automatiser sans
GitHub Actions (ex. lancer chaque soir depuis ton propre ordinateur ou un
petit serveur/VPS) :

- **macOS/Linux (cron)** : `crontab -e` puis ajoute par exemple
  `0 19 * * 1-5 cd /chemin/vers/brvm-conseil-standalone && /usr/bin/python3 update_daily.py`
  (adapter l'heure à ton fuseau — 19h locale ≈ 17h UTC en été).
- **Windows** : Planificateur de tâches → tâche quotidienne en semaine,
  action = lancer `python.exe update_daily.py` avec comme "dossier de
  démarrage" ce répertoire.

## Fichiers du projet

- `index.html` — le dashboard généré (ce que tu déploies/ouvres).
- `app_standalone.js`, `style.css` — logique cliente et style, inlinés dans
  `index.html` par `build_standalone_html.py`. Modifie ces fichiers sources
  puis relance le build, ne modifie pas `index.html` à la main.
- `analysis_engine.py` — moteur d'analyse (indicateurs + recommandations par
  profil de risque). Pure bibliothèque standard Python, aucune dépendance.
- `scrape_brvm.py` — récupère les cours et indices depuis brvm.org.
- `sectors.json` — table secteur/pays des valeurs BRVM (statique).
- `history.json` — historique cumulé des cours (grossit chaque jour ouvré ;
  c'est ce qui permet les moyennes mobiles et la volatilité). Ne pas éditer
  à la main.
- `update_daily.py` — orchestre scraping → analyse → reconstruction de la
  page. C'est le script que la tâche planifiée (ou toi) lance chaque jour.
- `build_standalone_html.py` — assemble `index.html` à partir des sources.
- `.github/workflows/daily-update.yml` — automatisation GitHub Actions.

## Si le scraper casse

`scrape_brvm.py` repère les tableaux par le **texte** de leurs en-têtes
("Symbole", "Clôture", "Variation", etc.) plutôt que par des classes CSS —
plus robuste aux changements mineurs de mise en page. Si BRVM refond son
site plus en profondeur, le script s'arrêtera avec un message d'erreur
explicite (`RuntimeError`) plutôt que de publier des données fausses ou
incomplètes ; l'Action GitHub échouera visiblement (tu recevras un e-mail de
GitHub) au lieu de publier silencieusement du contenu cassé.

Pour diagnostiquer : lance `python3 scrape_brvm.py --stocks-out /tmp/s.json
--indices-out /tmp/i.json` en local, lis le message d'erreur (il liste les
en-têtes de tableaux trouvés sur la page), puis ajuste les mots-clés dans
`HEADER_MAP`/`map_columns()` en fonction de ce que BRVM affiche désormais.

## Aller plus loin (optionnel)

- **Synchroniser le profil/portefeuille entre appareils** : il faudrait un
  petit backend (une base de données + authentification) au lieu du
  `localStorage` — hors du périmètre de ce générateur statique, mais
  `app_standalone.js` est un point de départ simple si tu veux ajouter ça
  toi-même (remplacer `saveUserState`/`loadUserState` par des appels à une
  API).
- **Alerte quotidienne par e-mail/Slack** : ajoute une étape dans
  `daily-update.yml` après `update_daily.py` qui lit `history.json` /
  `market_data.json` et envoie un message (webhook Slack, action GitHub
  `dawidd6/action-send-mail`, etc.) avec la synthèse du jour.

## Avertissement

Comme la version claude.ai : outil d'aide à la décision basé sur des règles
quantitatives transparentes, pas un conseil en investissement réglementé, ne
remplace pas l'avis d'un conseiller agréé auprès du CREPMF. Les marchés
actions comportent un risque de perte en capital.
