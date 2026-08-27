# BRVM Conseil — version autonome (sans claude.ai)

Tableau de bord d'analyse quotidienne et de recommandations personnalisées
(achat / renforcer / conserver / surveiller / alléger / vendre) sur les
valeurs de la BRVM (Bourse Régionale des Valeurs Mobilières, Abidjan),
déployable gratuitement sur GitHub Pages, Netlify ou Vercel — ou simplement
en local sur ton poste.

C'est la version « portable » du dashboard : mêmes données, même moteur
d'analyse, mais sans dépendance à claude.ai — la persistance de ton profil,
ton portefeuille et ta liste de suivi se fait dans le `localStorage` de ton
navigateur au lieu d'être sauvegardée dans la page elle-même.

| | |
|---|---|
| Récupération des cours | scraping direct de brvm.org (`scrape_brvm.py`, requests + BeautifulSoup) |
| Mise à jour automatique | GitHub Actions (`.github/workflows/daily-update.yml`) |
| Persistance profil/portefeuille/watchlist | `localStorage` du navigateur |
| Hébergement | GitHub Pages / Netlify / Vercel (site 100% statique) |

## Déploiement sur GitHub Pages

1. Crée un dépôt GitHub (public ou privé) et pousses-y le contenu de ce
   dossier :
   ```bash
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
   **"Read and write permissions"** (nécessaire pour que la tâche
   automatique puisse pousser ses mises à jour). C'est la seule configuration
   supplémentaire à faire.

4. C'est tout. Toutes les 20 minutes pendant les heures de bourse (9h-15h40
   UTC/GMT, lundi-vendredi), plus un dernier passage de sécurité à 17h UTC,
   l'Action `daily-update.yml` : récupère les cours du moment, met à jour
   `history.json` et `intraday.json`, régénère `index.html`, et republie
   automatiquement (GitHub Pages se redéploie tout seul à chaque push). Les
   recommandations reflètent donc les cours avec seulement ~15-35 minutes de
   retard (le délai de publication de brvm.org + le prochain passage de
   l'Action), au lieu d'une fois par jour.

   Astuce : pour changer la fréquence, modifie la ligne `cron: "*/20 9-15 *
   * 1-5"` dans `.github/workflows/daily-update.yml` — par exemple `*/15
   9-15 * * 1-5` (toutes les 15 min) ou `*/30 9-15 * * 1-5` (toutes les 30
   min). Un run qui ne trouve rien de nouveau à publier (marché pas encore
   ouvert, cours inchangés) ne fait rien — augmenter la fréquence ne fait
   donc pas grossir les fichiers plus vite que nécessaire.

5. Pour tester tout de suite sans attendre le prochain passage : onglet
   **Actions** du dépôt → "Mise à jour quotidienne BRVM Conseil" → **Run
   workflow**.

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

Cela récupère les cours du moment et régénère `index.html`. Pour automatiser
sans GitHub Actions (ex. lancer depuis ton propre ordinateur ou un petit
serveur/VPS) :

- **macOS/Linux (cron)** : `crontab -e` puis ajoute par exemple
  `*/20 9-15 * * 1-5 cd /chemin/vers/brvm-conseil-standalone && /usr/bin/python3 update_daily.py`
  (les heures sont en UTC ; adapte si ton `cron` utilise l'heure locale).
- **Windows** : Planificateur de tâches → tâche répétée toutes les 20 min en
  semaine, action = lancer `python.exe update_daily.py` avec comme "dossier
  de démarrage" le dossier du projet.

## Fichiers du projet

- `index.html` — le dashboard complet (HTML + CSS + JS inlinés), c'est le
  seul fichier que le navigateur charge.
- `app_standalone.js` — logique de rendu et d'interaction (source, injectée
  dans `index.html` par `build_standalone_html.py`).
- `style.css` — feuille de style (thème clair/sombre automatique).
- `analysis_engine.py` — le moteur d'analyse (indicateurs + recommandations
  par profil de risque), en Python standard, sans dépendance externe.
- `scrape_brvm.py` — scraper des pages publiques brvm.org (cours du jour,
  indices), avec repérage des tableaux par le texte de leurs en-têtes pour
  rester robuste aux changements mineurs de mise en page.
- `update_daily.py` — orchestrateur : scraping → moteur d'analyse →
  reconstruction de `index.html`. C'est ce que la tâche planifiée (ou toi)
  lance à chaque passage.
- `build_standalone_html.py` — assemble `index.html` à partir des données de
  marché, du CSS et du JS.
- `sectors.json` — table secteur/pays des ~47 valeurs BRVM.
- `history.json` — historique quotidien cumulé des cours (un point par
  séance, par valeur) ; grossit à chaque nouvelle séance détectée.
- `intraday.json` — fenêtre glissante des relevés intrajournaliers (les 5
  dernières séances), alimentée à chaque passage de l'Action ; sert au tracé
  "Aujourd'hui" par valeur, sans influencer les recommandations.
- `.github/workflows/daily-update.yml` — la tâche planifiée GitHub Actions.

## Comment sont calculées les recommandations

Pour chaque valeur : momentum (court terme 5 séances, moyen terme 30
séances, long terme 90 séances), volatilité (écart-type des variations
journalières), confirmation par le volume, force relative par rapport à
l'indice BRVM Composite, et un filtre de liquidité qui force le signal à
"Surveiller" quand le volume échangé est nul ou anormalement faible pour un
mouvement de prix marqué. Une tendance de fond baissière confirmée sur
plusieurs horizons neutralise toute conviction d'achat court terme, quel que
soit le profil. Le détail complet est expliqué dans le panneau
"Comment sont calculées les recommandations ?" du dashboard lui-même.

C'est un outil d'aide à la décision basé sur des règles quantitatives
transparentes — pas un conseil en investissement réglementé, et ça ne
remplace pas l'avis d'un conseiller agréé auprès du CREPMF.

## Si le scraper casse

`scrape_brvm.py` repère les tableaux par le texte de leurs en-têtes
(symbole, clôture, variation…) plutôt que par des classes CSS, pour rester
robuste aux petits changements de mise en page de brvm.org. S'il ne trouve
plus les tableaux attendus, il s'arrête avec une erreur explicite (affichant
les en-têtes de tableaux qu'il a trouvés) plutôt que d'écrire des données
fausses ou incomplètes — regarde les logs du run GitHub Actions concerné
pour voir précisément ce qui a changé sur la page.

## Aller plus loin

- Ajouter une alerte e-mail/Slack : une étape supplémentaire dans le
  workflow, après `update_daily.py`, qui notifie si un signal VENDRE ou
  ALLÉGER apparaît sur une valeur de ton portefeuille.
- Historiser plus de 90 jours : `analysis_engine.py` calcule déjà des
  indicateurs sur 5/30/90 séances ; l'historique s'allonge naturellement à
  chaque séance traitée (aucune limite avant 260 séances, environ un an).
- Rétro-remplir l'historique à partir d'une source tierce si tu en trouves
  une fiable, pour ne pas attendre plusieurs mois avant d'avoir un vrai recul
  de 90 jours.
