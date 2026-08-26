#!/usr/bin/env python3
"""
Moteur d'analyse BRVM — calcule indicateurs de tendance et recommandations
par profil de risque (prudent / equilibre / dynamique) à partir :
  - de l'historique déjà accumulé (par symbole)
  - du relevé du jour (cours_veille, cours_ouverture, cours_cloture, volume, variation_pct)

Ce script est conçu pour être ré-exécutable chaque jour, y compris par une
session fraîche qui n'a comme contexte que le HTML de l'artefact publié la
veille (d'où l'absence de dépendances externes non-standard : uniquement la
bibliothèque standard Python).

Usage :
    python3 analysis_engine.py --history history.json --today today_stocks.json \
        --indices today_indices.json --sectors sectors.json --out market_data.json \
        --date 2026-08-25 --label "Mardi 25 août 2026" --updated "2026-08-25T13:04:00+00:00"

Formats d'entrée attendus (voir README embarqué dans le dashboard) :
  history.json : { "SYMB": [ {"date": "2026-08-24", "cloture": 1234.0, "volume": 5678}, ... ], ... }
                 (peut être {} au tout premier lancement)
  today_stocks.json : liste d'objets bruts scrapés depuis brvm.org/fr/cours-actions/0
                 [{"symbole","nom","volume","cours_veille","cours_ouverture","cours_cloture","variation_pct"}, ...]
                 (nombres en chaînes avec formatage FR, ex "1 234", "7,46" -> gérés ici)
  today_indices.json : liste d'objets [{"nom_indice","cloture","variation_pct",...}, ...]
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


# ---------------------------------------------------------------------------
# Indicateurs techniques
# ---------------------------------------------------------------------------
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

    ma5, ma5_n = windowed_mean(closes, 5)
    ma20, ma20_n = windowed_mean(closes, 20)

    momentum_pct = None
    momentum_window = 0
    if n >= 2:
        w = min(n - 1, 5)
        base = closes[-1 - w]
        if base:
            momentum_pct = (closes[-1] - base) / base * 100.0
            momentum_window = w

    volatilite_pct = None
    if n >= 3:
        rets = []
        for i in range(1, n):
            prev = closes[i - 1]
            if prev:
                rets.append((closes[i] - prev) / prev * 100.0)
        if len(rets) >= 2:
            volatilite_pct = statistics.pstdev(rets)

    volumes = [p["volume"] for p in history_points if p.get("volume") is not None]
    volume_ratio = None
    if len(volumes) >= 2:
        prior = volumes[:-1][-10:]  # jusqu'à 10 derniers jours hors aujourd'hui
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

    return {
        "ma5": round(ma5, 2) if ma5 is not None else None,
        "ma5_fenetre": ma5_n,
        "ma20": round(ma20, 2) if ma20 is not None else None,
        "ma20_fenetre": ma20_n,
        "momentum_pct": round(momentum_pct, 2) if momentum_pct is not None else None,
        "momentum_fenetre": momentum_window,
        "volatilite_pct": round(volatilite_pct, 2) if volatilite_pct is not None else None,
        "volume_ratio": round(volume_ratio, 2) if volume_ratio is not None else None,
        "n_points": n,
        "confiance": confiance,
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
    args = ap.parse_args()

    with open(args.history, encoding="utf-8") as f:
        history = json.load(f)
    with open(args.today, encoding="utf-8") as f:
        today_raw = json.load(f)
    with open(args.indices, encoding="utf-8") as f:
        indices_raw = json.load(f)
    with open(args.sectors, encoding="utf-8") as f:
        sectors = json.load(f)

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

        recos = {
            profile: recommend_for_profile(profile, variation, ind)
            for profile in PROFILE_PARAMS
        }

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
            "recommandations": recos,
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

    # Purge de l'historique au-delà de 260 séances par valeur (~1 an) pour borner la taille
    for symb in list(history.keys()):
        if len(history[symb]) > 260:
            history[symb] = history[symb][-260:]

    indices_out = []
    for row in indices_raw:
        nom = row.get("nom_indice", "").strip()
        cloture = to_number(row.get("cloture"))
        variation = to_number(row.get("variation_pct"))
        if not nom or cloture is None:
            continue
        indices_out.append({"nom": nom, "cloture": cloture, "variation_pct": variation})

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
        "stocks": sorted(stocks_out, key=lambda s: s["symbole"]),
        "history": history,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(market_data, f, ensure_ascii=False, indent=None, separators=(",", ":"))

    print(f"OK: {len(stocks_out)} valeurs traitées, historique {sum(len(v) for v in history.values())} points cumulés.", file=sys.stderr)


if __name__ == "__main__":
    main()
