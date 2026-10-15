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

Cela récupère les cours du moment, archive la séance et régénère
`index.html` (`--force` pour retraiter la séance même si les cours n'ont pas
bougé depuis le dernier relevé). Pour automatiser
sans GitHub Actions (ex. lancer depuis ton propre ordinateur ou un petit
serveur/VPS) :

- **macOS/Linux (cron)** : `crontab -e` puis ajoute par exemple
  `*/20 9-15 * * 1-5 cd /chemin/vers/brvm-conseil-standalone && /usr/bin/python3 update_daily.py`
  (les heures sont en UTC ; adapte si ton `cron` utilise l'heure locale).
- **Windows** : Planificateur de tâches → tâche répétée toutes les 20 min en
  semaine, action = lancer `python.exe update_daily.py` avec comme "dossier
  de démarrage" le dossier du projet.

## Archives des séances

Chaque séance traitée est conservée dans `archives/AAAA-MM-JJ.json` :
indices (principaux et sectoriels), synthèse, cours, indicateurs,
recommandations des trois profils, relevés intrajournaliers du jour et
relevés bruts scrapés sur brvm.org. L'archive du jour est réécrite à chaque
passage ; le dernier passage de la journée fige l'état de clôture.
`archives/index.json` liste les séances (la plus récente en premier).

Dans le dashboard, le panneau **Archives des séances** (colonne de droite)
permet de rouvrir n'importe quelle séance passée — tout le tableau de bord
(signaux, portefeuille valorisé à cette date, analyse IA) bascule alors sur
cette date — et de télécharger la séance affichée en CSV (format Excel
français) ou JSON.

Les archives sont chargées à la demande : il faut que la page soit servie
en http(s) (GitHub Pages, Netlify, ou `python3 -m http.server` en local
puis http://localhost:8000). En ouvrant `index.html` directement depuis le
disque, la liste s'affiche mais le navigateur bloque leur chargement.

Les séances antérieures à la mise en place de l'archivage ont été
reconstituées depuis l'historique git avec `python3 backfill_archives.py`
(à ne relancer qu'en cas de besoin, `--force` pour tout réécrire).

## Analyse IA de la séance

Le panneau **Analyse IA de la séance** a deux onglets.

**Analyse du jour** : rédigée automatiquement une fois par séance, après la
clôture, par Claude Opus 5.5 (API Anthropic), et **archivée avec la séance**.
Pour l'activer, ajoute ta clé API dans le dépôt GitHub : **Settings → Secrets
and variables → Actions → New repository secret**, nom `ANTHROPIC_API_KEY`
(clé créée sur https://console.anthropic.com ; environ 0,15 $ par jour, soit
~3 $ par mois). Sans ce secret, tout le reste fonctionne normalement.

**Mon analyse personnalisée** : le bouton envoie le même dossier, plus ton
profil de risque et (si la case est cochée) ton portefeuille et ta liste de
suivi, depuis ton navigateur avec ta propre clé API. La clé reste dans le
`localStorage` de ton navigateur et n'est envoyée qu'à `api.anthropic.com`.
Modèles proposés : Opus 5.5 (par défaut), Sonnet 5.5 ou Haiku 5.5 (le plus
économique). Chaque analyse est mémorisée par séance et par profil, et
téléchargeable en Markdown.

Le **dossier de séance** transmis à l'IA (`ai_analysis.py`, embarqué dans
la page et dans chaque archive) contient : indices principaux et sectoriels,
largeur du marché sur 10 séances, agrégats par secteur, chaque valeur avec
ses facteurs et leur rang, ses signaux pour les 3 profils, l'historique de
ses signaux sur 5 séances et ses 10 derniers cours, les changements de
signal depuis la veille, la fiabilité mesurée du modèle et l'analyse IA de
la veille (pour suivre ce qui se confirme ou s'invalide). L'IA ne voit pas
l'actualité ni les résultats des sociétés : c'est un commentaire éclairé,
pas un conseil en investissement.

## Mon portefeuille : registre d'opérations

Le portefeuille se tient par **opérations** : achat, vente, dividende, avec
la date, la quantité, le prix unitaire et les frais (courtage SGI, etc.).
Le dashboard en déduit automatiquement :

- les positions ouvertes et leur **PRU** (prix de revient unitaire, méthode
  du prix moyen pondéré, frais d'achat inclus) ;
- la **plus/moins-value latente** (au dernier cours) et **réalisée** (à
  chaque vente : produit net des frais − PRU × quantité vendue) ;
- les **dividendes encaissés** et le **résultat total** rapporté aux
  montants investis.

Une vente supérieure à la quantité détenue à sa date est refusée. En
consultant une séance archivée, seules les opérations antérieures sont
prises en compte (valorisation du portefeuille tel qu'il était). Le bouton
« Vendre » d'une ligne pré-remplit le formulaire. Les montants sont
indiqués avant impôts.

Les données restent dans le navigateur : **Sauvegarder mes données**
télécharge un fichier JSON (opérations, liste de suivi, recherches IA) que
**Restaurer une sauvegarde** permet de recharger, par exemple sur un autre
appareil. Les opérations s'exportent aussi en CSV pour Excel. Les positions
saisies avec l'ancienne version sont converties automatiquement en achats.

## Recherche IA : 2 valeurs à fort potentiel

Le bouton **Lancer la recherche** demande à l'IA (avec ta clé API) de mener
ses propres recherches sur le web — outils `web_search` et `web_fetch` de
l'API Claude : résultats publiés, dividendes et dates de détachement, notes
d'analystes et de SGI, presse spécialisée, actualité de l'UEMOA. Elle les
croise avec le dossier quantitatif du jour, ton profil, ton portefeuille et
tes documents, compare 5 à 8 candidates, puis retient **exactement 2
valeurs**, avec thèse, chiffres sourcés et datés, catalyseurs, consensus des
sources, risques, conditions d'entrée et d'invalidation, et niveau de
conviction. Les valeurs écartées et toutes les sources consultées sont
listées.

- Durée : quelques minutes. Coût indicatif : 0,50 à 2 $ par recherche avec
  Opus (recherches web + lecture des pages).
- La recherche web doit être autorisée pour ton organisation dans la console
  Anthropic (paramètres de confidentialité / web search) ; sinon l'erreur
  s'affiche.
- **Suivi des performances** : chaque recommandation est conservée avec le
  cours du jour ; le tableau « Suivi des recommandations passées » affiche
  ensuite sa performance réelle, comparée à la moyenne du marché sur la même
  période. C'est le meilleur moyen de juger, dans la durée, si ces
  recommandations méritent ta confiance.

## Onglet « Opportunités hors actions »

Un second onglet (lien direct : `index.html#opportunites`) rassemble les
autres placements du marché financier régional.

- **Obligations cotées à la BRVM** : cote du jour récupérée sur
  brvm.org/fr/cours-obligations (`bonds.py`), émissions échues retirées,
  classées par type (État, institution régionale, entreprise, titrisation
  FCTC, sukuk) et par pays, avec repérage des obligations durables, diaspora
  et à taux variable. Filtres par type, pays, échéance et recherche ; tri par
  taux facial, échéance ou cours. Seul le **taux facial** est indiqué : la
  cote ne publie ni le nominal restant ni le tableau d'amortissement (un
  cours de 4 000 FCFA reflète souvent un titre déjà remboursé aux 3/5, pas
  une décote), donc aucun rendement n'est calculé.
- **Recherche IA d'opportunités** : comme la recherche de valeurs, l'IA
  cherche sur le web les placements du moment — emprunts obligataires en
  souscription (taux, durée, période, minimum, SGI), introductions en bourse
  et augmentations de capital, sukuk, titres publics (UMOA-Titres), OPCVM —
  les croise avec la cote des obligations, ton profil et ton portefeuille,
  et présente jusqu'à 6 opportunités sourcées (offres clôturées signalées).
  Les recherches sont conservées (et incluses dans la sauvegarde).
- **Comprendre ces placements** : rappel des caractéristiques de chaque
  famille de placement.

## Mes documents d'analyse

Le panneau **Mes documents d'analyse** accepte tes propres sources : PDF
(rapports annuels, notes de SGI, bulletins officiels de la cote ; ≤ 22 Mo),
Word `.docx`, images (captures d'écran, graphiques), texte/CSV, et
enregistrements **audio ou vidéo** (conférences de résultats, interviews,
podcasts).

- Chaque document est lu **une fois** par l'IA (avec ta clé API), qui en
  tire une fiche structurée : titre, date, valeurs BRVM concernées, résumé,
  chiffres clés, dividende, perspectives, risques, impact estimé par valeur
  et fiabilité de la source.
- Ce sont ces fiches (compactes) qui sont jointes à **Mon analyse
  personnalisée** — case « Utiliser dans mes analyses » pour choisir
  lesquelles. Elles apparaissent aussi dans le détail de chaque valeur
  concernée du tableau du marché.
- L'audio et la vidéo sont **transcrits dans le navigateur** (Whisper,
  transformers.js) : le son n'est envoyé nulle part, seule la transcription
  est transmise à l'IA. Le modèle de transcription est téléchargé une seule
  fois (~80 Mo en qualité standard, ~250 Mo en haute qualité, recommandée
  pour les chiffres et les noms propres). Une heure d'audio peut prendre de
  longues minutes sur un ordinateur sans carte graphique récente.
- Les fichiers et leurs fiches restent dans le navigateur (IndexedDB) : ils
  ne sont pas synchronisés entre appareils et ne sont pas utilisés par
  l'analyse automatique du jour.
- Coût indicatif de lecture : quelques centimes pour une note de quelques
  pages, ~0,50 à 1 $ pour un rapport annuel de 100 pages avec Opus.

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
- `archives.py` — écriture des archives journalières et de leur index.
- `backfill_archives.py` — reconstitution des archives passées depuis
  l'historique git (usage ponctuel).
- `archives/` — une archive JSON par séance + `index.json`.
- `ai_analysis.py` — dossier de séance pour l'IA et analyse automatique.
- `bonds.py` — mise en forme de la cote des obligations.
- `backtest.py` — mesure de la fiabilité des signaux sur l'historique.
- `sectors.json` — table secteur/pays des ~47 valeurs BRVM.
- `history.json` — historique quotidien cumulé des cours (un point par
  séance, par valeur) ; grossit à chaque nouvelle séance détectée.
- `intraday.json` — fenêtre glissante des relevés intrajournaliers (les 5
  dernières séances), alimentée à chaque passage de l'Action ; sert au tracé
  "Aujourd'hui" par valeur, sans influencer les recommandations.
- `.github/workflows/daily-update.yml` — la tâche planifiée GitHub Actions.

## Comment sont calculées les recommandations

Chaque valeur reçoit un score qui la **classe par rapport aux autres valeurs
du marché** (en écarts-types), à partir de quatre facteurs :

| Facteur | Mesure | Pourquoi |
|---|---|---|
| Tendance de fond | performance sur ~25 séances, hors les 5 dernières (plafonnée à +1 écart-type) | la tendance qui persiste ; les envolées extrêmes s'essoufflent |
| Retour à la moyenne | mouvement des 5 dernières séances, en sens inverse | sur la BRVM, une hausse rapide tend à se corriger : on préfère acheter sur repli |
| Faible volatilité | écart-type des variations sur 20 séances | à tendance égale, les valeurs calmes font mieux |
| Liquidité | capitaux échangés en moyenne par séance | les valeurs liquides font mieux et leurs cours sont plus fiables |

Les facteurs sont pondérés selon le profil (prudent : calme et liquidité ;
dynamique : tendance), le score est lissé sur 3 séances, puis converti en
signal. Garde-fous : pas d'achat franc si la tendance de fond est négative,
pas de vente franche si elle est positive, pas d'achat contre une tendance
baissière confirmée sur tous les horizons, signal forcé à « Surveiller » si
le volume est nul ou anormalement faible.

### Fiabilité mesurée : `backtest.py`

`python3 backtest.py --horizon 5` rejoue le moteur séance par séance sur
l'historique réel, sans jamais regarder le futur, et compare l'ancien moteur
(v1, momentum court terme) au moteur actuel (v2). Sur les données disponibles
mi-octobre 2026 (18 à 23 séances évaluables) :

| | v1 (ancien) | v2 (actuel) |
|---|---|---|
| Corrélation score / performance à 5 séances | −0,09 (positive 22 % du temps) | +0,21 à +0,25 (positive 100 % du temps, profils prudent/équilibré) |
| Écart de performance achat − vente à 5 séances | −1,6 pt | +0,8 à +1,2 pt |
| Signaux qui changent d'une séance à l'autre | ~45 % | ~20 % |

Cette mesure est recalculée à chaque mise à jour et affichée dans le panneau
méthodologie du dashboard ; elle est aussi transmise à l'IA. L'historique
étant encore court, elle s'affinera avec le temps.

C'est un outil d'aide à la décision basé sur des règles quantitatives
transparentes — pas un conseil en investissement réglementé, et ça ne
remplace pas l'avis d'un conseiller agréé par l'AMF-UMOA (ex-CREPMF).

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
