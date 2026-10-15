#!/usr/bin/env python3
"""
Moteur d'analyse BRVM — calcule indicateurs de tendance et recommandations
par profil de risque (prudent / equilibre / dynamique) à partir :
  - de l'historique déjà accumulé (par symbole, et pour les indices)
  - du relevé du jour (cours_veille, cours_ouverture, cours_cloture, volume, variation_pct)

Ce script est conçu pour être ré-exécutable chaque jour (et même plusieurs
fois par jour, en cadence intrajournalière), y compris par une session
fraîche qui n'a comme contexte que le HTML de l'artefact publié la veille
(d'où l'absence de dépendances externes non-standard : uniquement la
bibliothèque standard Python).

Usage :
    python3 analysis_engine.py --history history.json --today today_stocks.json \
        --indices today_indices.json --sectors sectors.json --out market_data.json \
        --date 2026-08-25 --label "Mardi 25 août 2026" --updated "2026-08-25T13:04:00+00:00" \
        --intraday intraday.json

Formats d'entrée attendus (voir README embarqué dans le dashboard) :
  history.json : { "SYMB": [ {"date": "2026-08-24", "cloture": 1234.0, "volume": 5678}, ... ], ...,
                    "_IDX_<nom indice>": [ {"date": ..., "cloture": ..., "volume": null}, ... ] }
                 (peut être {} au tout premier lancement ; les entrées "_IDX_..."
                  portent l'historique des indices, dans le même fichier et le
                  même format que les actions pour rester purgeables/simples)
  today_stocks.json : liste d'objets bruts scrapés depuis brvm.org/fr/cours-actions/0
                 [{"symbole","nom","volume","cours_veille","cours_ouverture","cours_cloture","variation_pct"}, ...]
                 (nombres en chaînes avec formatage FR, ex "1 234", "7,46" -> gérés ici)
  today_indices.json : liste d'objets [{"nom_indice","cloture","variation_pct",...}, ...]
  intraday.json (optionnel) : { "SYMB": [ {"ts","date","cours","variation_pct"}, ... ], ... }
                 fenêtre glissante (par défaut les 5 dernières séances), alimentée
                 à CHAQUE passage (pas dédupliquée par date, contrairement à history.json)
                 pour permettre un tracé "aujourd'hui" / "derniers jours" par valeur.
"""
import json
import argparse
import statistics
import sys


# ---------------------------------------------------------------------------
# Utilitaires de parsing des nombres au format FR renvoyés par le scraping
# ---------------------------------------------------------------------------
def to_number(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).strip()
    if s == "" or s.lower() in ("na", "n/a", "-", "non spécifié"):
        return None
    s = s.replace("\xa0", " ").replace(" ", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def norm_name(s):
    return (s or "").strip().lower()


# ---------------------------------------------------------------------------
# Indicateurs techniques
# ---------------------------------------------------------------------------
# Fenêtres de momentum utilisées pour la confirmation multi-horizon : un
# signal appuyé uniquement sur le court terme (5 séances) est bien moins
# solide qu'un signal où court, moyen et long terme sont alignés.
MOMENTUM_WINDOWS = {"court": 5, "moyen": 30, "long": 90}
MA_WINDOWS = [5, 20, 30, 60, 90]
VOLATILITY_WINDOW = 30

# Nombre minimal de points requis sur chaque horizon pour que celui-ci
# compte dans le calcul d'alignement de tendance (on ne réclame pas un
# horizon "confirmé" sur la foi de 2-3 points épars).
MOMENTUM_MIN_POINTS = {"court": 3, "moyen": 15, "long": 45}


def compute_indicators(history_points):
    """history_points: liste triée par date croissante de {date, cloture, volume}
    (le point du jour est déjà inclus en dernière position par l'appelant)."""
    closes = [p["cloture"] for p in history_points if p.get("cloture") is not None]
    n = len(closes)

    def windowed_mean(vals, w):
        if not vals:
            return None, 0
        w = min(w, len(vals))
        if w == 0:
            return None, 0
        return statistics.mean(vals[-w:]), w

    mas = {}
    for w in MA_WINDOWS:
        val, used = windowed_mean(closes, w)
        mas[w] = round(val, 2) if val is not None else None

    def momentum_over(w):
        if n < 2:
            return None, 0
        win = min(n - 1, w)
        base = closes[-1 - win]
        if not base:
            return None, win
        return (closes[-1] - base) / base * 100.0, win

    momentum = {}
    for key, w in MOMENTUM_WINDOWS.items():
        pct, used = momentum_over(w)
        momentum[key] = {"pct": round(pct, 2) if pct is not None else None, "fenetre": used}

    # Volatilité « récente » : écart-type des variations journalières sur
    # les VOLATILITY_WINDOW dernières séances seulement (et non sur tout
    # l'historique, qui peut couvrir jusqu'à un an et diluer un regain
    # récent de volatilité).
    volatilite_pct = None
    if n >= 3:
        rets = []
        for i in range(max(1, n - VOLATILITY_WINDOW), n):
            prev = closes[i - 1]
            if prev:
                rets.append((closes[i] - prev) / prev * 100.0)
        if len(rets) >= 2:
            volatilite_pct = statistics.pstdev(rets)

    volumes = [p["volume"] for p in history_points if p.get("volume") is not None]
    volume_ratio = None
    if len(volumes) >= 2:
        prior = volumes[:-1][-10:]  # jusqu'à 10 derniers relevés hors aujourd'hui
        prior = [v for v in prior if v is not None and v > 0]
        if prior:
            avg_prior = statistics.mean(prior)
            if avg_prior > 0:
                volume_ratio = volumes[-1] / avg_prior

    if n == 0:
        confiance = "aucune"
    elif n < 5:
        confiance = "faible"
    elif n < 20:
        confiance = "moyenne"
    else:
        confiance = "elevee"

    # Alignement de tendance multi-horizon : on ne retient un horizon que
    # s'il dispose d'assez de points, puis on regarde si tous les horizons
    # disponibles pointent dans le même sens.
    aligned_vals = []
    for key, w in MOMENTUM_WINDOWS.items():
        m = momentum[key]
        if m["pct"] is not None and m["fenetre"] >= MOMENTUM_MIN_POINTS[key]:
            aligned_vals.append(m["pct"])
    if len(aligned_vals) < 2:
        tendance_alignement = "indeterminee"
    elif all(v > 0.3 for v in aligned_vals):
        tendance_alignement = "haussiere_confirmee"
    elif all(v < -0.3 for v in aligned_vals):
        tendance_alignement = "baissiere_confirmee"
    else:
        tendance_alignement = "mixte"

    return {
        "ma5": mas[5],
        "ma5_fenetre": min(5, n),
        "ma20": mas[20],
        "ma20_fenetre": min(20, n),
        "ma30": mas[30],
        "ma60": mas[60],
        "ma90": mas[90],
        "momentum_pct": momentum["court"]["pct"],
        "momentum_fenetre": momentum["court"]["fenetre"],
        "momentum_moyen_pct": momentum["moyen"]["pct"],
        "momentum_moyen_fenetre": momentum["moyen"]["fenetre"],
        "momentum_long_pct": momentum["long"]["pct"],
        "momentum_long_fenetre": momentum["long"]["fenetre"],
        "volatilite_pct": round(volatilite_pct, 2) if volatilite_pct is not None else None,
        "volume_ratio": round(volume_ratio, 2) if volume_ratio is not None else None,
        "n_points": n,
        "confiance": confiance,
        "tendance_alignement": tendance_alignement,
    }


# ---------------------------------------------------------------------------
# Moteur de recommandation (règles transparentes, pondérées par profil)
# ---------------------------------------------------------------------------
PROFILE_PARAMS = {
    "prudent": {
        "label": "Prudent",
        "w_momentum": 0.5,
        "w_volatility_penalty": 1.6,
        "w_volume_confirm": 0.3,
        "buy_threshold": 3.2,
        "reinforce_threshold": 1.2,
        "sell_threshold": -4.0,
        "reduce_threshold": -2.2,
        "vol_penalty_cap": 8.0,
    },
    "equilibre": {
        "label": "Équilibré",
        "w_momentum": 1.0,
        "w_volatility_penalty": 0.9,
        "w_volume_confirm": 0.5,
        "buy_threshold": 2.2,
        "reinforce_threshold": 0.8,
        "sell_threshold": -2.8,
        "reduce_threshold": -1.4,
        "vol_penalty_cap": 12.0,
    },
    "dynamique": {
        "label": "Dynamique",
        "w_momentum": 1.5,
        "w_volatility_penalty": 0.35,
        "w_volume_confirm": 0.8,
        "buy_threshold": 1.4,
        "reinforce_threshold": 0.5,
        "sell_threshold": -1.8,
        "reduce_threshold": -0.8,
        "vol_penalty_cap": 20.0,
    },
}


def fmt_pct(x):
    if x is None:
        return "n/d"
    sign = "+" if x > 0 else ""
    return f"{sign}{x:.2f}%".replace(".", ",")


CONFIDENCE_FACTOR = {"aucune": 0.3, "faible": 0.5, "moyenne": 0.8, "elevee": 1.0}

BUY_SIGNAL_RANK = ["CONSERVER", "RENFORCER", "ACHETER"]

# Seuils du filtre de liquidité : en dessous, on ne fait plus confiance au
# signal technique, quel que soit le score, car le mouvement de prix observé
# n'est pas confirmé par un volume d'échange crédible (marché BRVM peu
# liquide sur une partie des ~47 valeurs).
LIQUIDITY_WEAK_RATIO = 0.2
LIQUIDITY_WEAK_MOVE_PCT = 3.0


def liquidity_flag(volume, ind, variation_pct):
    """Renvoie (illiquide: bool, motif: str|None)."""
    if volume is None or volume <= 0:
        return True, "aucun échange constaté sur cette valeur au dernier relevé (volume nul) — signal jugé non fiable"
    vr = ind.get("volume_ratio")
    if vr is not None and vr < LIQUIDITY_WEAK_RATIO and abs(variation_pct) >= LIQUIDITY_WEAK_MOVE_PCT:
        return True, (
            f"volume très faible ({vr:.2f}x la moyenne récente) pour un mouvement de {fmt_pct(variation_pct)} "
            "— signal jugé non fiable sur une valeur aussi peu échangée"
        )
    return False, None


def recommend_for_profile(profile_key, variation_pct, ind):
    p = PROFILE_PARAMS[profile_key]
    momentum = ind["momentum_pct"] if ind["momentum_pct"] is not None else variation_pct
    volat = ind["volatilite_pct"] if ind["volatilite_pct"] is not None else abs(variation_pct) * 0.6
    vol_ratio = ind["volume_ratio"]
    conf_factor = CONFIDENCE_FACTOR[ind["confiance"]]
    vol_bonus = 0.0
    vol_note = ""
    if vol_ratio is not None:
        if vol_ratio >= 1.3:
            vol_bonus = p["w_volume_confirm"] * min(vol_ratio - 1.0, 2.0)
            vol_note = f"volume {vol_ratio:.1f}x la moyenne récente (confirme le mouvement)"
        elif vol_ratio <= 0.6:
            vol_bonus = -p["w_volume_confirm"] * 0.4
            vol_note = f"volume faible ({vol_ratio:.1f}x la moyenne), mouvement peu confirmé"

    # La conviction "achat" est amortie quand l'historique est court (on ne
    # pousse pas à l'achat sur la foi d'une seule séance) ; la conviction
    # "vente" ne l'est pas autant, car réduire l'exposition en cas de doute
    # reste une posture prudente en soi.
    buy_component = max(momentum, 0) * p["w_momentum"] * conf_factor
    sell_component = min(momentum, 0) * p["w_momentum"]
    score = buy_component + sell_component - volat * p["w_volatility_penalty"] * 0.15 + vol_bonus * conf_factor

    reasons = []
    reasons.append(f"variation du jour {fmt_pct(variation_pct)}")
    if ind["momentum_pct"] is not None and ind["momentum_fenetre"] >= 2:
        reasons.append(f"momentum {fmt_pct(ind['momentum_pct'])} sur {ind['momentum_fenetre']} séance(s)")
    if ind["volatilite_pct"] is not None:
        reasons.append(f"volatilité récente {ind['volatilite_pct']:.1f}%".replace(".", ","))
    if vol_note:
        reasons.append(vol_note)
    if ind["confiance"] in ("aucune", "faible"):
        reasons.append("historique encore court : conviction d'achat volontairement limitée tant que l'historique s'étoffe")

    # --- Confirmation multi-horizon (court/moyen/long terme) -------------
    align = ind.get("tendance_alignement", "indeterminee")
    if align == "haussiere_confirmee":
        score += 0.5 * conf_factor
        reasons.append("tendance haussière confirmée sur plusieurs horizons (court, moyen et long terme alignés)")
    elif align == "baissiere_confirmee":
        score -= 0.6
        reasons.append("tendance baissière confirmée sur plusieurs horizons (court, moyen et long terme alignés)")
    elif align == "mixte":
        reasons.append("tendances divergentes selon l'horizon (le court terme ne confirme pas le moyen/long terme) : signal à interpréter avec prudence")

    # --- Force relative vs indice BRVM Composite --------------------------
    rp = ind.get("force_relative_pct")
    if rp is not None:
        if rp >= 2.0:
            score += 0.3 * conf_factor
            reasons.append(f"surperforme l'indice BRVM Composite (écart de {fmt_pct(rp)} sur la même période)")
        elif rp <= -2.0:
            score -= 0.3
            reasons.append(f"sous-performe l'indice BRVM Composite (écart de {fmt_pct(rp)} sur la même période)")

    if score >= p["buy_threshold"]:
        signal = "ACHETER"
    elif score >= p["reinforce_threshold"]:
        signal = "RENFORCER"
    elif score <= p["sell_threshold"]:
        signal = "VENDRE"
    elif score <= p["reduce_threshold"]:
        signal = "ALLÉGER"
    else:
        signal = "CONSERVER"

    # Une tendance de fond baissière confirmée sur plusieurs horizons
    # neutralise toute conviction d'achat court terme, quel que soit le
    # profil : on ne recommande pas de renforcer/acheter une valeur dont le
    # moyen et le long terme restent clairement orientés à la baisse.
    if align == "baissiere_confirmee" and signal in ("ACHETER", "RENFORCER"):
        signal = "CONSERVER"
        reasons.append("conviction d'achat neutralisée : la tendance de fond (moyen/long terme) reste baissière malgré le signal court terme")

    # Pour un profil prudent avec peu d'historique, on plafonne la conviction
    # d'achat (jamais d'ACHETER franc sur une seule séance), sans plafonner
    # les signaux de vente/allègement (protection du capital).
    if profile_key == "prudent" and ind["confiance"] in ("aucune", "faible") and signal in BUY_SIGNAL_RANK:
        capped_rank = BUY_SIGNAL_RANK.index("RENFORCER")
        if BUY_SIGNAL_RANK.index(signal) > capped_rank:
            signal = "RENFORCER"

    if ind["confiance"] == "aucune" and abs(variation_pct) < 5:
        signal = "SURVEILLER"

    raison = "Signal " + signal.lower() + " (" + p["label"].lower() + ") : " + "; ".join(reasons) + "."
    return {"signal": signal, "score": round(score, 2), "raison": raison}


def recommend_all(history_points, variation_pct, ind):
    """Moteur v1 (momentum court terme), conservé comme référence pour
    backtest.py : recommandations des trois profils pour une valeur, filtre
    de liquidité compris."""
    recos = {profile: recommend_for_profile(profile, variation_pct, ind) for profile in PROFILE_PARAMS}
    if ind.get("liquidite_insuffisante"):
        _, note = liquidity_flag(history_points[-1].get("volume") if history_points else None, ind, variation_pct)
        for reco in recos.values():
            if reco["signal"] != "SURVEILLER":
                reco["signal"] = "SURVEILLER"
                reco["raison"] += " Signal forcé à SURVEILLER : " + (note or "liquidité insuffisante") + "."
    return recos


# ---------------------------------------------------------------------------
# Modèle multifactoriel (v2) — classement relatif des valeurs entre elles
# ---------------------------------------------------------------------------
# Un backtest sur l'historique réel (backtest.py) a montré que le score v1,
# fondé sur le momentum court terme (5 séances), était CONTRE-productif sur
# la BRVM : les valeurs qui viennent de monter ont tendance à se replier
# (retour à la moyenne sur un marché peu liquide), et les signaux
# changeaient pour près de la moitié des valeurs chaque jour.
#
# Le score v2 combine quatre facteurs, chacun documenté dans la littérature
# et confirmé (même signe, de façon stable) sur l'historique BRVM :
#   - tendance de fond : performance sur ~30 séances en EXCLUANT les 5
#     dernières (le « momentum » qui persiste) ;
#   - retour à la moyenne : un repli récent (5 séances) est un meilleur point
#     d'entrée qu'une hausse récente, et inversement ;
#   - faible volatilité : à tendance égale, les valeurs calmes font mieux ;
#   - liquidité : capitaux échangés en moyenne par séance.
# Chaque facteur est converti en z-score par rapport à l'ensemble des
# valeurs de la séance (le score est donc RELATIF : « mieux placée que la
# moyenne du marché »), pondéré selon le profil, puis lissé sur les
# dernières séances pour éviter que les signaux ne changent au moindre
# à-coup.
FACTOR_MIN_POINTS = 15
FACTOR_TREND_WINDOW = 30
FACTOR_SKIP = 5
FACTOR_VOL_WINDOW = 20
FACTOR_LIQ_WINDOW = 20
SCORE_SMOOTHING_SESSIONS = 3
# Rendements décroissants de la tendance : au-delà de +1 écart-type, une
# hausse de fond très forte tend à s'essouffler (constaté sur l'historique
# BRVM) ; la tendance sert surtout à écarter les valeurs les plus faibles.
TREND_Z_CAP = 1.0

FACTOR_LABELS = {
    "tendance": "tendance de fond",
    "repli": "retour à la moyenne",
    "calme": "faible volatilité",
    "liquidite": "liquidité",
}

PROFILE_FACTOR_WEIGHTS = {
    "prudent":   {"tendance": 0.8, "repli": 0.4, "calme": 0.8, "liquidite": 0.6},
    "equilibre": {"tendance": 1.0, "repli": 0.5, "calme": 0.5, "liquidite": 0.4},
    "dynamique": {"tendance": 1.3, "repli": 0.5, "calme": 0.2, "liquidite": 0.2},
}

# Seuils sur le score composite (en écarts-types par rapport au marché).
PROFILE_SCORE_THRESHOLDS = {
    "prudent":   {"acheter": 0.75, "renforcer": 0.35, "alleger": -0.30, "vendre": -0.65},
    "equilibre": {"acheter": 0.65, "renforcer": 0.30, "alleger": -0.35, "vendre": -0.70},
    "dynamique": {"acheter": 0.55, "renforcer": 0.25, "alleger": -0.40, "vendre": -0.75},
}


def _clean_points(points):
    return [p for p in points if p.get("date") != "veille" and p.get("cloture")]


def stock_factors(points):
    """Facteurs bruts d'une valeur à partir de ses points (triés, séance
    analysée en dernier). None si l'historique est trop court."""
    pts = _clean_points(points)
    n = len(pts)
    if n < FACTOR_MIN_POINTS:
        return None
    closes = [p["cloture"] for p in pts]
    look = min(FACTOR_TREND_WINDOW, n - 1)
    tendance = (closes[-1 - FACTOR_SKIP] / closes[-1 - look] - 1) * 100.0
    court = (closes[-1] / closes[-1 - FACTOR_SKIP] - 1) * 100.0
    rets = [(closes[i] / closes[i - 1] - 1) * 100.0 for i in range(max(1, n - FACTOR_VOL_WINDOW), n)]
    vol = statistics.pstdev(rets) if len(rets) >= 2 else None
    traded = [(p.get("volume") or 0) * p["cloture"] for p in pts[-FACTOR_LIQ_WINDOW:]]
    liq = statistics.mean(traded) if traded else 0.0
    return {
        "tendance_pct": tendance,
        "tendance_fenetre": look - FACTOR_SKIP,
        "court_pct": court,
        "volatilite_pct": vol,
        "capitaux_moyens_fcfa": liq,
    }


def _zscores(values):
    """z-scores winsorisés (5e-95e centiles), bornés à ±3."""
    xs = sorted(values.values())
    if len(xs) < 5:
        return {k: 0.0 for k in values}
    lo, hi = xs[int(0.05 * (len(xs) - 1))], xs[int(0.95 * (len(xs) - 1))]
    clipped = {k: min(max(v, lo), hi) for k, v in values.items()}
    m = statistics.mean(clipped.values())
    sd = statistics.pstdev(clipped.values()) or 1.0
    return {k: max(-3.0, min(3.0, (v - m) / sd)) for k, v in clipped.items()}


def _percentiles(values):
    keys = sorted(values, key=lambda k: values[k])
    n = len(keys)
    return {k: (i / (n - 1) if n > 1 else 0.5) for i, k in enumerate(keys)}


def universe_factor_scores(history, date_iso):
    """Scores du jour date_iso pour toutes les valeurs ayant assez
    d'historique : {symb: {"facteurs", "z", "rang", "composite": {profil}}}."""
    raw = {}
    for symb, pts in history.items():
        if symb.startswith("_IDX_"):
            continue
        upto = [p for p in pts if p.get("date") == "veille" or p.get("date", "") <= date_iso]
        if not upto or upto[-1].get("date") != date_iso:
            continue
        f = stock_factors(upto)
        if f and f["volatilite_pct"] is not None:
            raw[symb] = f
    if len(raw) < 5:
        return {}
    import math
    series = {
        "tendance": {k: v["tendance_pct"] for k, v in raw.items()},
        "repli": {k: -v["court_pct"] for k, v in raw.items()},
        "calme": {k: -v["volatilite_pct"] for k, v in raw.items()},
        "liquidite": {k: math.log1p(v["capitaux_moyens_fcfa"]) for k, v in raw.items()},
    }
    z = {name: _zscores(vals) for name, vals in series.items()}
    rang = {name: _percentiles(vals) for name, vals in series.items()}
    out = {}
    for symb in raw:
        zs = {name: z[name][symb] for name in series}
        zs["tendance"] = min(zs["tendance"], TREND_Z_CAP)
        composite = {}
        for profile, weights in PROFILE_FACTOR_WEIGHTS.items():
            composite[profile] = sum(weights[n] * zs[n] for n in weights) / sum(weights.values())
        out[symb] = {
            "facteurs": raw[symb],
            "z": zs,
            "rang": {name: rang[name][symb] for name in series},
            "composite": composite,
        }
    return out


def smoothed_universe_scores(history, date_iso, sessions=SCORE_SMOOTHING_SESSIONS):
    """Scores du jour + composite lissé sur les `sessions` dernières séances
    (moyenne des composites de chaque séance, calculés avec les seules
    données connues à cette date)."""
    dates = sorted({p["date"] for k, pts in history.items() if not k.startswith("_IDX_")
                    for p in pts if p.get("date") not in (None, "veille") and p["date"] <= date_iso})
    today = universe_factor_scores(history, date_iso)
    past = [universe_factor_scores(history, d) for d in dates[-sessions:-1]] if sessions > 1 else []
    for symb, sc in today.items():
        sc["composite_jour"] = dict(sc["composite"])
        for profile in sc["composite"]:
            vals = [sc["composite"][profile]] + [p[symb]["composite"][profile] for p in past if symb in p]
            sc["composite"][profile] = statistics.mean(vals)
    return today


def _rank_word(r, high, low):
    if r >= 0.8:
        return high
    if r <= 0.2:
        return low
    return None


def recommend_from_factors(profile_key, sc, ind, variation_pct):
    """Signal v2 d'une valeur pour un profil à partir de ses scores
    factoriels (sc = entrée de smoothed_universe_scores)."""
    th = PROFILE_SCORE_THRESHOLDS[profile_key]
    label = PROFILE_PARAMS[profile_key]["label"].lower()
    score = sc["composite"][profile_key]
    f, rang = sc["facteurs"], sc["rang"]

    if score >= th["acheter"]:
        signal = "ACHETER"
    elif score >= th["renforcer"]:
        signal = "RENFORCER"
    elif score <= th["vendre"]:
        signal = "VENDRE"
    elif score <= th["alleger"]:
        signal = "ALLÉGER"
    else:
        signal = "CONSERVER"

    reasons = [f"score {score:+.2f} (écarts-types vs marché, lissé sur {SCORE_SMOOTHING_SESSIONS} séances)".replace(".", ",")]
    trend_word = _rank_word(rang["tendance"], "parmi les meilleures du marché", "parmi les plus faibles du marché")
    reasons.append(f"tendance de fond {fmt_pct(round(f['tendance_pct'], 2))} sur {f['tendance_fenetre']} séances (hors 5 dernières)"
                   + (f", {trend_word}" if trend_word else ""))
    if rang["repli"] >= 0.8:
        reasons.append(f"repli récent de {fmt_pct(round(f['court_pct'], 2))} sur 5 séances : historiquement un meilleur point d'entrée qu'après une hausse")
    elif rang["repli"] <= 0.2:
        reasons.append(f"forte hausse récente ({fmt_pct(round(f['court_pct'], 2))} sur 5 séances) : risque de repli à court terme, mieux vaut ne pas courir après")
    vol_word = _rank_word(rang["calme"], "parmi les plus calmes", "parmi les plus agitées")
    if vol_word:
        reasons.append(f"volatilité {f['volatilite_pct']:.1f}% par séance, {vol_word}".replace(".", ","))
    liq_word = _rank_word(rang["liquidite"], "valeur parmi les plus liquides", "valeur peu liquide")
    if liq_word:
        reasons.append(f"{liq_word} (≈ {f['capitaux_moyens_fcfa'] / 1e6:.1f} M FCFA échangés par séance)".replace(".", ","))

    # Garde-fous absolus (le score est relatif au marché) :
    # - pas d'achat franc si la tendance de fond est elle-même négative ;
    # - pas de vente franche si la tendance de fond reste positive ;
    # - pas d'achat contre une tendance baissière confirmée sur tous les horizons.
    if signal == "ACHETER" and f["tendance_pct"] <= 0:
        signal = "RENFORCER"
        reasons.append("achat franc limité : la tendance de fond n'est pas positive en valeur absolue")
    if signal == "VENDRE" and f["tendance_pct"] > 0:
        signal = "ALLÉGER"
        reasons.append("vente franche évitée : la tendance de fond reste positive en valeur absolue")
    if ind.get("tendance_alignement") == "baissiere_confirmee" and signal in ("ACHETER", "RENFORCER"):
        signal = "CONSERVER"
        reasons.append("conviction d'achat neutralisée : tendance baissière confirmée sur tous les horizons")

    raison = "Signal " + signal.lower() + " (" + label + ") : " + "; ".join(reasons) + "."
    return {"signal": signal, "score": round(score, 2), "score_jour": round(sc["composite_jour"][profile_key], 2), "raison": raison}


def recommend_universe(history, date_iso, inds, variations, volumes):
    """Recommandations v2 de toutes les valeurs de la séance. Les valeurs dont
    l'historique est encore trop court retombent sur le moteur v1 (signal
    plafonné à SURVEILLER/CONSERVER par sa propre gestion de confiance).
    inds/variations/volumes : {symb: ...} pour la séance date_iso."""
    scores = smoothed_universe_scores(history, date_iso)
    out = {}
    for symb, ind in inds.items():
        variation = variations.get(symb, 0.0)
        sc = scores.get(symb)
        if sc is None:
            recos = {p: recommend_for_profile(p, variation, ind) for p in PROFILE_PARAMS}
            for r in recos.values():
                if r["signal"] in ("ACHETER", "RENFORCER", "ALLÉGER", "VENDRE"):
                    r["signal"] = "SURVEILLER"
                    r["raison"] += f" Historique inférieur à {FACTOR_MIN_POINTS} séances : signal limité à SURVEILLER."
        else:
            recos = {p: recommend_from_factors(p, sc, ind, variation) for p in PROFILE_PARAMS}
            ind["facteurs"] = {
                "tendance_pct": round(sc["facteurs"]["tendance_pct"], 2),
                "tendance_fenetre": sc["facteurs"]["tendance_fenetre"],
                "court_pct": round(sc["facteurs"]["court_pct"], 2),
                "volatilite_pct": round(sc["facteurs"]["volatilite_pct"], 2),
                "capitaux_moyens_fcfa": round(sc["facteurs"]["capitaux_moyens_fcfa"]),
                "rang": {k: round(v, 2) for k, v in sc["rang"].items()},
            }
        if ind.get("liquidite_insuffisante"):
            _, note = liquidity_flag(volumes.get(symb), ind, variation)
            for r in recos.values():
                if r["signal"] != "SURVEILLER":
                    r["signal"] = "SURVEILLER"
                    r["raison"] += " Signal forcé à SURVEILLER : " + (note or "liquidité insuffisante") + "."
        out[symb] = recos
    return out


def rescore_session(history, date_iso):
    """Recalcule indicateurs et recommandations v2 de la séance date_iso à
    partir de l'historique, en n'utilisant que les points connus à cette date
    (backtest, recalcul des archives). Renvoie {symb: (ind, recos)}."""
    inds, variations, volumes = {}, {}, {}
    for symb, pts in history.items():
        if symb.startswith("_IDX_"):
            continue
        window = [p for p in pts if p.get("date") == "veille" or p.get("date", "") <= date_iso]
        if len(window) < 2 or window[-1].get("date") != date_iso:
            continue
        prev, cur = window[-2]["cloture"], window[-1]["cloture"]
        variation = (cur - prev) / prev * 100.0 if prev else 0.0
        ind = compute_indicators(window)
        ind["force_relative_pct"] = None
        ind["liquidite_insuffisante"], _ = liquidity_flag(window[-1].get("volume"), ind, variation)
        inds[symb], variations[symb], volumes[symb] = ind, variation, window[-1].get("volume")
    recos = recommend_universe(history, date_iso, inds, variations, volumes) if inds else {}
    return {symb: (inds[symb], recos[symb]) for symb in inds}


def trend_label(variation_pct, ind):
    if ind["momentum_pct"] is not None and ind["momentum_fenetre"] >= 3:
        m = ind["momentum_pct"]
        if m >= 3:
            return "hausse_soutenue"
        if m >= 0.5:
            return "hausse_moderee"
        if m <= -3:
            return "baisse_soutenue"
        if m <= -0.5:
            return "baisse_moderee"
        return "stable"
    if variation_pct >= 3:
        return "hausse_du_jour"
    if variation_pct <= -3:
        return "baisse_du_jour"
    return "stable_du_jour"


# ---------------------------------------------------------------------------
# Historique intraday (fenêtre glissante, non dédupliqué par date)
# ---------------------------------------------------------------------------
DEFAULT_INTRADAY_WINDOW_DATES = 5


def update_intraday(intraday, stocks_out, date_iso, updated_iso, window_dates):
    for s in stocks_out:
        if s["cours_cloture"] is None:
            continue
        symb = s["symbole"]
        pts = list(intraday.get(symb, []))
        pts.append({
            "ts": updated_iso,
            "date": date_iso,
            "cours": s["cours_cloture"],
            "variation_pct": s["variation_pct"],
        })
        dates_present = sorted(set(p["date"] for p in pts))
        keep_dates = set(dates_present[-window_dates:])
        intraday[symb] = [p for p in pts if p["date"] in keep_dates]
    return intraday


# ---------------------------------------------------------------------------
# Programme principal
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", required=True)
    ap.add_argument("--today", required=True)
    ap.add_argument("--indices", required=True)
    ap.add_argument("--sectors", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--date", required=True, help="YYYY-MM-DD de la séance traitée")
    ap.add_argument("--label", required=True, help="Libellé humain de la date, ex 'Mardi 25 août 2026'")
    ap.add_argument("--updated", required=True, help="Horodatage ISO de mise à jour")
    ap.add_argument("--intraday", default=None, help="Fichier intraday.json existant (optionnel)")
    ap.add_argument("--intraday-window-dates", type=int, default=DEFAULT_INTRADAY_WINDOW_DATES,
                     help="Nombre de séances récentes conservées en résolution intrajournalière")
    args = ap.parse_args()

    with open(args.history, encoding="utf-8") as f:
        history = json.load(f)
    with open(args.today, encoding="utf-8") as f:
        today_raw = json.load(f)
    with open(args.indices, encoding="utf-8") as f:
        indices_raw = json.load(f)
    with open(args.sectors, encoding="utf-8") as f:
        sectors = json.load(f)

    intraday = {}
    if args.intraday:
        try:
            with open(args.intraday, encoding="utf-8") as f:
                intraday = json.load(f)
        except FileNotFoundError:
            intraday = {}

    # --- 1) Indices : mise à jour de leur propre historique AVANT la boucle
    # sur les actions, pour pouvoir calculer la force relative de chaque
    # action par rapport à l'indice BRVM Composite dans la même passe. ------
    indices_out = []
    composite_ind = None
    for row in indices_raw:
        nom = row.get("nom_indice", "").strip()
        cloture = to_number(row.get("cloture"))
        variation = to_number(row.get("variation_pct"))
        precedente = to_number(row.get("precedente"))
        if not nom or cloture is None:
            continue
        if variation is None and precedente:
            variation = (cloture - precedente) / precedente * 100.0
        idx_key = "_IDX_" + nom
        idx_points = list(history.get(idx_key, []))
        if not idx_points and precedente is not None:
            # Amorçage : la clôture précédente publiée sert de premier point.
            idx_points.append({"date": "veille", "cloture": precedente, "volume": None})
        idx_points = [p for p in idx_points if p.get("date") != args.date]
        idx_points.append({"date": args.date, "cloture": cloture, "volume": None})
        history[idx_key] = idx_points
        idx_ind = compute_indicators(idx_points)
        indices_out.append({
            "nom": nom,
            "categorie": row.get("categorie") or "principal",
            "cloture": cloture,
            "variation_pct": round(variation, 2) if variation is not None else None,
            "variation_ytd_pct": to_number(row.get("variation_ytd_pct")),
            "indicateurs": idx_ind,
        })
        # « BRVM - COMPOSITE TOTAL RETURN » contient aussi « composite » :
        # on ne retient que l'indice de prix, référence de la force relative.
        if "composite" in norm_name(nom) and "total return" not in norm_name(nom) and composite_ind is None:
            composite_ind = idx_ind

    stocks_out = []
    hausses, baisses, stables = 0, 0, 0
    biggest_gain, biggest_loss = None, None

    for row in today_raw:
        symb = row.get("symbole", "").strip()
        if not symb:
            continue
        veille = to_number(row.get("cours_veille"))
        ouverture = to_number(row.get("cours_ouverture"))
        cloture = to_number(row.get("cours_cloture"))
        volume = to_number(row.get("volume"))
        variation = to_number(row.get("variation_pct"))
        if variation is None and veille and cloture:
            variation = (cloture - veille) / veille * 100.0
        if variation is None:
            variation = 0.0

        # Historique existant pour ce symbole
        hist_points = list(history.get(symb, []))
        if not hist_points and cloture is not None:
            # Amorçage jour 1 : on reconstruit un point de départ synthétique
            # cohérent avec la variation officielle du jour (plutôt que le
            # "cours veille" affiché, qui peut différer légèrement du cours
            # de référence réel en cas de suspension/reprise de cotation).
            implied_prev = None
            if variation is not None and (1 + variation / 100.0) != 0:
                implied_prev = cloture / (1 + variation / 100.0)
            elif veille is not None:
                implied_prev = veille
            if implied_prev is not None:
                hist_points.append({"date": "veille", "cloture": round(implied_prev, 4), "volume": None})
        if cloture is not None:
            # Évite le doublon si le script est relancé pour la même date
            hist_points = [p for p in hist_points if p.get("date") != args.date]
            hist_points.append({"date": args.date, "cloture": cloture, "volume": volume})

        ind = compute_indicators(hist_points)

        # Force relative vs BRVM Composite (même fenêtre "court terme" que
        # le momentum principal, 5 séances) : ce qui compte n'est pas
        # "l'action monte", mais "l'action monte plus ou moins vite que le
        # marché dans son ensemble".
        ind["force_relative_pct"] = None
        if (
            composite_ind is not None
            and ind["momentum_pct"] is not None and ind["momentum_fenetre"] >= 3
            and composite_ind["momentum_pct"] is not None and composite_ind["momentum_fenetre"] >= 3
        ):
            ind["force_relative_pct"] = round(ind["momentum_pct"] - composite_ind["momentum_pct"], 2)

        # Filtre de liquidité : override strict, appliqué après le calcul
        # des recommandations ci-dessous.
        illiquide, _ = liquidity_flag(volume, ind, variation)
        ind["liquidite_insuffisante"] = illiquide

        sect = sectors.get(symb, {"secteur": "Non classé", "pays": "Non spécifié"})

        stocks_out.append({
            "symbole": symb,
            "nom": row.get("nom", symb),
            "secteur": sect["secteur"],
            "pays": sect["pays"],
            "cours_veille": veille,
            "cours_ouverture": ouverture,
            "cours_cloture": cloture,
            "volume": volume,
            "variation_pct": round(variation, 2),
            "indicateurs": ind,
            "tendance": trend_label(variation, ind),
            "recommandations": None,  # calculées après la boucle (classement relatif)
        })

        history[symb] = hist_points

        if variation > 0.05:
            hausses += 1
        elif variation < -0.05:
            baisses += 1
        else:
            stables += 1
        if biggest_gain is None or variation > biggest_gain["variation_pct"]:
            biggest_gain = {"symbole": symb, "nom": row.get("nom", symb), "variation_pct": round(variation, 2)}
        if biggest_loss is None or variation < biggest_loss["variation_pct"]:
            biggest_loss = {"symbole": symb, "nom": row.get("nom", symb), "variation_pct": round(variation, 2)}

    # Recommandations v2 : le score étant un classement relatif des valeurs
    # entre elles, il se calcule une fois toutes les valeurs mises à jour.
    recos_all = recommend_universe(
        history, args.date,
        {s["symbole"]: s["indicateurs"] for s in stocks_out},
        {s["symbole"]: s["variation_pct"] for s in stocks_out},
        {s["symbole"]: s["volume"] for s in stocks_out},
    )
    for s in stocks_out:
        s["recommandations"] = recos_all[s["symbole"]]

    # Purge de l'historique au-delà de 260 séances par entrée (~1 an) pour
    # borner la taille — s'applique uniformément aux actions et aux indices
    # (clés "_IDX_...") puisqu'ils partagent le même format de points.
    for key in list(history.keys()):
        if len(history[key]) > 260:
            history[key] = history[key][-260:]

    # Historique intraday : fenêtre glissante mise à jour à CHAQUE passage.
    intraday = update_intraday(intraday, stocks_out, args.date, args.updated, args.intraday_window_dates)

    total_n_points = [s["indicateurs"]["n_points"] for s in stocks_out] or [0]
    data_maturity_days = max(total_n_points)

    synthese = (
        f"{hausses} valeur(s) en hausse, {baisses} en baisse, {stables} stable(s) sur {len(stocks_out)} suivies. "
    )
    if biggest_gain:
        synthese += f"Plus forte hausse : {biggest_gain['nom']} ({biggest_gain['symbole']}) {fmt_pct(biggest_gain['variation_pct'])}. "
    if biggest_loss:
        synthese += f"Plus forte baisse : {biggest_loss['nom']} ({biggest_loss['symbole']}) {fmt_pct(biggest_loss['variation_pct'])}."

    market_data = {
        "lastUpdate": args.updated,
        "asOfDate": args.date,
        "asOfLabel": args.label,
        "indices": indices_out,
        "syntheseDuJour": synthese,
        "stats": {
            "hausses": hausses,
            "baisses": baisses,
            "stables": stables,
            "plusForteHausse": biggest_gain,
            "plusForteBaisse": biggest_loss,
            "dataMaturityDays": data_maturity_days,
        },
        "moteur": {"version": 2, "lissage_seances": SCORE_SMOOTHING_SESSIONS,
                   "facteurs": FACTOR_LABELS, "ponderations": PROFILE_FACTOR_WEIGHTS},
        "stocks": sorted(stocks_out, key=lambda s: s["symbole"]),
        "history": history,
        "intraday": intraday,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(market_data, f, ensure_ascii=False, indent=None, separators=(",", ":"))

    print(
        f"OK: {len(stocks_out)} valeurs traitées, historique {sum(len(v) for k, v in history.items() if not k.startswith('_IDX_'))} "
        f"points cumulés (actions), intraday {sum(len(v) for v in intraday.values())} points (fenêtre {args.intraday_window_dates} séances).",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
