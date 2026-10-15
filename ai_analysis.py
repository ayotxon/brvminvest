#!/usr/bin/env python3
"""Analyse IA de la séance (API Claude d'Anthropic).

Deux usages, un seul contexte :
  - build_context() construit le dossier de la séance (indices, régime de
    marché sur 10 séances, secteurs, chaque valeur avec ses facteurs, ses
    10 derniers cours et l'historique de ses signaux, fiabilité mesurée du
    moteur, analyse IA de la veille). Il est embarqué dans la page et dans
    l'archive : le bouton « analyse personnalisée » du dashboard y ajoute
    seulement le profil et le portefeuille de l'utilisateur.
  - generate() rédige l'analyse « marché » du jour côté serveur (GitHub
    Actions), une fois par séance après la clôture, si la variable
    d'environnement ANTHROPIC_API_KEY est définie. Elle est archivée avec la
    séance.
"""
import datetime
import os
import statistics
import sys

MODEL = "claude-opus-5-5"
EFFORT = "high"
MAX_TOKENS = 16000
# La BRVM clôture à 15h00 GMT ; on laisse le temps à brvm.org de publier.
GENERATE_AFTER_UTC = datetime.time(15, 30)

SYSTEM_PROMPT = """Tu es un analyste actions senior spécialisé sur la BRVM (Bourse Régionale des Valeurs Mobilières de l'UEMOA, Abidjan). Tu reçois le dossier complet d'une séance, produit par un outil d'analyse quantitative, et tu rédiges en français une analyse de la séance pour un investisseur particulier averti.

Ce que contient le dossier :
- les indices (principaux et sectoriels), la largeur du marché et son évolution sur les dernières séances ;
- pour chaque valeur : cours, variation, volume, les quatre facteurs du modèle (tendance de fond sur ~25 séances hors les 5 dernières, mouvement des 5 dernières séances, volatilité, capitaux échangés), leur rang dans le marché, les signaux des trois profils de risque, l'historique récent des signaux et les derniers cours ;
- la fiabilité MESURÉE du modèle sur l'historique (corrélation de rang entre score et performance à 5 séances, écart de performance entre signaux d'achat et de vente) ;
- éventuellement l'analyse IA de la séance précédente.

Comment fonctionne le modèle (pour l'interpréter correctement) :
- le score est RELATIF : il classe les valeurs entre elles (en écarts-types par rapport au marché), il ne prédit pas la direction du marché ; dans un marché baissier, même les valeurs « à l'achat » peuvent baisser, mais moins que les autres ;
- sur la BRVM, une hausse récente sur quelques séances tend à se corriger (retour à la moyenne) : le modèle préfère acheter sur repli dans une tendance de fond solide plutôt qu'après une envolée ;
- les valeurs calmes et liquides ont historiquement mieux performé ;
- le score est lissé sur 3 séances pour éviter les retournements au moindre à-coup ; un signal stable depuis plusieurs séances est plus solide qu'un signal qui vient d'apparaître ;
- une valeur sans échange ou au volume anormalement faible est forcée à « Surveiller ».

Ta valeur ajoutée : prendre du recul sur ces signaux automatiques, relier les mouvements entre eux (secteurs, pays, indices, largeur), distinguer ce qui est significatif du bruit, repérer les signaux fragiles (volume faible, signal tout récent, facteurs contradictoires) et ceux qui sont solides (facteurs alignés, signal stable), et traduire cela en points d'attention concrets.

Règles :
- Appuie-toi uniquement sur le dossier et, s'il y en a, sur les fiches de documents fournis par l'investisseur. En dehors de ces fiches, tu n'as accès ni à l'actualité, ni aux résultats des sociétés, ni aux dividendes, ni aux annonces : ne les invente pas. Une explication fondamentale plausible doit être présentée explicitement comme une hypothèse à vérifier.
- Quand tu t'appuies sur une fiche de document, cite-la (titre, date), tiens compte de son ancienneté et de sa nature (document officiel, opinion d'analyste, transcription automatique pouvant contenir des erreurs), et signale toute contradiction entre ce document et les données de marché.
- Étaye chaque affirmation par des chiffres du dossier.
- Calibre ta confiance sur la fiabilité mesurée du modèle et sur la profondeur de l'historique ; dis clairement quand un constat repose sur peu de données.
- Si une analyse de la séance précédente est fournie, signale ce qui a changé depuis (confirmation, invalidation) au lieu de la répéter.
- Ce n'est pas un conseil en investissement réglementé : formule des points d'attention, des scénarios et des conditions à surveiller, pas des ordres.

Format : Markdown, titres de niveau 2, dans cet ordre :
## L'essentiel en 3 points
## Lecture du marché
## Ce qui a changé depuis la séance précédente
## Valeurs à la loupe
## Signaux à prendre avec prudence
## À surveiller lors des prochaines séances
Si un profil et un portefeuille d'investisseur sont fournis, insère avant « À surveiller » une section « ## Votre portefeuille et votre liste de suivi » et adapte toute l'analyse à ce profil ; sinon, écris pour les trois profils sans section portefeuille.
Sois dense, précis et concret : environ 700 à 1000 mots, tableaux de 8 lignes maximum."""

PROFILES = [("prudent", "P"), ("equilibre", "E"), ("dynamique", "D")]
SIGNAL_ABBR = {"ACHETER": "ACH", "RENFORCER": "REN", "CONSERVER": "CON", "SURVEILLER": "SUR",
               "ALLÉGER": "ALL", "VENDRE": "VEN"}


def _n(x, d=2, sign=False):
    if x is None:
        return "—"
    s = f"{x:+.{d}f}" if sign else f"{x:.{d}f}"
    return s


def _closes(history, symb, date_iso, k=10):
    pts = [p for p in history.get(symb, []) if p.get("date") not in (None, "veille") and p["date"] <= date_iso]
    return [p["cloture"] for p in pts[-k:]]


def build_context(market, history, previous_archives, archive_index):
    """market : market_data du jour ; previous_archives : archives des
    séances précédentes, la plus récente en premier ; archive_index : entrées
    de archives/index.json."""
    date_iso = market["asOfDate"]
    stats = market.get("stats") or {}
    moteur = market.get("moteur") or {}
    out = []
    out.append(f"# Dossier de la séance du {market.get('asOfLabel') or date_iso} ({date_iso})")
    out.append(f"Données relevées le {market.get('lastUpdate')}. Profondeur de l'historique : {stats.get('dataMaturityDays', 0)} séances.")

    fiab = (moteur.get("fiabilite") or {}).get("profils") or {}
    if fiab:
        out.append("")
        out.append(f"## Fiabilité mesurée du modèle (performance à {(moteur.get('fiabilite') or {}).get('horizon_seances', 5)} séances, sur l'historique disponible)")
        for profile, abbr in PROFILES:
            f = fiab.get(profile)
            if not f:
                continue
            perf = f.get("perf_moyenne_pct", {})
            out.append(
                f"- {profile} : corrélation de rang score/performance {f['ic']:+.2f} (positive sur {f['ic_positif_part']:.0%} de {f['seances']} séances) ; "
                f"perf. moyenne achat {_n(perf.get('achat'), sign=True)} %, neutre {_n(perf.get('neutre'), sign=True)} %, vente {_n(perf.get('vente'), sign=True)} % "
                f"(écart achat-vente {f['ecart_achat_vente_pts']:+.2f} pts) ; {f['rotation']:.0%} des signaux changent d'une séance à l'autre."
            )
        out.append("Rappel : la catégorie « neutre » inclut les valeurs illiquides forcées à Surveiller, qui bougent peu.")

    out.append("")
    out.append("## Régime de marché — dernières séances (date | hausses | baisses | stables | var. BRVM Composite %)")
    for e in [e for e in archive_index if e["date"] <= date_iso][:10]:
        out.append(f"{e['date']} | {e.get('hausses')} | {e.get('baisses')} | {e.get('stables')} | {_n(e.get('composite'), sign=True)}")

    out.append("")
    out.append("## Indices du jour (nom | catégorie | clôture | var. jour % | var. depuis le 1er janvier %)")
    if not market.get("indices"):
        out.append("(non disponibles pour cette séance)")
    for ix in market.get("indices", []):
        out.append(f"{ix['nom']} | {ix.get('categorie') or 'principal'} | {_n(ix.get('cloture'))} | {_n(ix.get('variation_pct'), sign=True)} | {_n(ix.get('variation_ytd_pct'), sign=True)}")

    stocks = market.get("stocks", [])
    by_sector = {}
    for s in stocks:
        by_sector.setdefault(s["secteur"].split(" - ")[0], []).append(s)
    out.append("")
    out.append("## Secteurs (secteur | nb valeurs | var. moyenne du jour % | hausses/baisses | tendance de fond moyenne %)")
    for sect, ss in sorted(by_sector.items(), key=lambda kv: -statistics.mean(x["variation_pct"] for x in kv[1])):
        trends = [x["indicateurs"]["facteurs"]["tendance_pct"] for x in ss if (x.get("indicateurs") or {}).get("facteurs")]
        out.append(f"{sect} | {len(ss)} | {statistics.mean(x['variation_pct'] for x in ss):+.2f} | "
                   f"{sum(x['variation_pct'] > 0.05 for x in ss)}/{sum(x['variation_pct'] < -0.05 for x in ss)} | "
                   f"{_n(statistics.mean(trends), sign=True) if trends else '—'}")

    prev_signals = []
    for a in previous_archives[:5]:
        prev_signals.append({s["symbole"]: s.get("recommandations") or {} for s in a.get("stocks", [])})

    out.append("")
    out.append("## Valeurs")
    out.append("Colonnes : symbole | nom | secteur | pays | cours FCFA | var. jour % | volume | capitaux moyens/séance (M FCFA) | "
               "tendance de fond % (rang 0-1) | 5 dernières séances % (rang repli 0-1) | volatilité % (rang calme 0-1) | "
               "signaux P/E/D | score E lissé (score E du jour) | signaux E des séances précédentes (plus récente d'abord) | "
               "liquidité | 10 derniers cours")
    for s in stocks:
        ind = s.get("indicateurs") or {}
        fac = ind.get("facteurs") or {}
        rang = fac.get("rang") or {}
        recos = s.get("recommandations") or {}
        sig = "/".join(SIGNAL_ABBR.get((recos.get(p) or {}).get("signal"), "—") for p, _ in PROFILES)
        e = recos.get("equilibre") or {}
        hist_e = ",".join(SIGNAL_ABBR.get(((ps.get(s["symbole"]) or {}).get("equilibre") or {}).get("signal"), "—") for ps in prev_signals) or "—"
        closes = " ".join(f"{c:g}" for c in _closes(history, s["symbole"], date_iso))
        out.append(" | ".join([
            s["symbole"], s["nom"], s["secteur"], s["pays"], _n(s.get("cours_cloture"), 0), _n(s.get("variation_pct"), sign=True),
            _n(s.get("volume"), 0),
            _n(fac["capitaux_moyens_fcfa"] / 1e6, 1) if fac else "—",
            f"{_n(fac.get('tendance_pct'), sign=True)} ({_n(rang.get('tendance'))})" if fac else "—",
            f"{_n(fac.get('court_pct'), sign=True)} ({_n(rang.get('repli'))})" if fac else "—",
            f"{_n(fac.get('volatilite_pct'))} ({_n(rang.get('calme'))})" if fac else "—",
            sig,
            f"{_n(e.get('score'), sign=True)} ({_n(e.get('score_jour'), sign=True)})",
            hist_e,
            "INSUFFISANTE" if ind.get("liquidite_insuffisante") else "ok",
            closes,
        ]))
    out.append("Abréviations des signaux : ACH acheter, REN renforcer, CON conserver, SUR surveiller, ALL alléger, VEN vendre.")

    if previous_archives:
        prev = previous_archives[0]
        changes = []
        prev_by = {s["symbole"]: s.get("recommandations") or {} for s in prev.get("stocks", [])}
        for s in stocks:
            pr = prev_by.get(s["symbole"])
            if not pr:
                continue
            diffs = [f"{abbr} {SIGNAL_ABBR.get((pr.get(p) or {}).get('signal'), '—')}→{SIGNAL_ABBR.get((s['recommandations'].get(p) or {}).get('signal'), '—')}"
                     for p, abbr in PROFILES
                     if (pr.get(p) or {}).get("signal") != (s["recommandations"].get(p) or {}).get("signal")]
            if diffs:
                changes.append(f"{s['symbole']} : " + ", ".join(diffs))
        out.append("")
        out.append(f"## Changements de signal depuis la séance précédente ({prev.get('asOfDate')})")
        out.append("\n".join(changes) if changes else "Aucun changement de signal.")
        prev_ai = (prev.get("analyseIA") or {}).get("texte")
        if prev_ai:
            out.append("")
            out.append(f"## Analyse IA de la séance précédente ({prev.get('asOfDate')}), pour continuité")
            out.append(prev_ai)

    return "\n".join(out)


def should_generate(now_utc, session_date, existing):
    """Une analyse par séance, après la clôture (ou lors d'un passage tardif)."""
    if existing and existing.get("texte"):
        return False
    if session_date < now_utc.date():
        return True
    return now_utc.time() >= GENERATE_AFTER_UTC


def generate(context):
    """Rédige l'analyse « marché » de la séance. Renvoie le dict archivé ou
    None (clé absente, SDK indisponible, erreur : jamais bloquant)."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
    except ImportError:
        print("SDK anthropic non installé (Python >= 3.10 requis) — analyse IA ignorée.", file=sys.stderr)
        return None

    client = anthropic.Anthropic()
    try:
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            output_config={"effort": EFFORT},
            # Si les filtres de sécurité déclinent la requête, l'API la relance
            # automatiquement sur le modèle de repli recommandé.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": context + "\n\nRédige l'analyse de cette séance."}],
        ) as stream:
            message = stream.get_final_message()
    except anthropic.AuthenticationError:
        print("Analyse IA : clé ANTHROPIC_API_KEY refusée.", file=sys.stderr)
        return None
    except anthropic.RateLimitError:
        print("Analyse IA : limite de débit atteinte, nouvel essai au prochain passage.", file=sys.stderr)
        return None
    except anthropic.APIStatusError as e:
        print(f"Analyse IA : erreur API {e.status_code} ({e.message}), nouvel essai au prochain passage.", file=sys.stderr)
        return None
    except anthropic.APIConnectionError:
        print("Analyse IA : API injoignable, nouvel essai au prochain passage.", file=sys.stderr)
        return None

    if message.stop_reason == "refusal":
        print("Analyse IA : requête déclinée par le modèle.", file=sys.stderr)
        return None
    text = "".join(b.text for b in message.content if b.type == "text").strip()
    if not text:
        return None
    if message.stop_reason == "max_tokens":
        text += "\n\n*(Analyse tronquée : limite de longueur atteinte.)*"
    return {
        "texte": text,
        "modele": message.model,
        "genereLe": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "jetons": {"entree": message.usage.input_tokens, "sortie": message.usage.output_tokens},
    }
