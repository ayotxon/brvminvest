#!/usr/bin/env python3
"""Rejoue les moteurs d'analyse (v1 : momentum court terme ; v2 : classement
multifactoriel, en production) séance par séance sur l'historique réel
(history.json) pour mesurer la qualité des signaux, sans regarder le futur :
à chaque séance t, seuls les points jusqu'à t sont fournis au moteur.

Mesures, par profil :
  - IC moyen : corrélation de rang (Spearman) entre le score du jour et la
    performance des h séances suivantes, moyennée sur les séances. > 0 =
    le score classe les valeurs dans le bon ordre.
  - performance moyenne à h séances par famille de signal (achat / neutre /
    vente) et écart achat - vente.
  - rotation : part des signaux qui changent d'une séance à l'autre.

Usage:
    python3 backtest.py                # horizon 5 séances
    python3 backtest.py --horizon 3
"""
import argparse
import json
import statistics
from pathlib import Path

import analysis_engine as engine

HERE = Path(__file__).resolve().parent
FAMILY = {"ACHETER": "achat", "RENFORCER": "achat", "CONSERVER": "neutre", "SURVEILLER": "neutre",
          "ALLÉGER": "vente", "VENDRE": "vente"}


def rank(values):
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2.0
        i = j + 1
    return ranks


def spearman(xs, ys):
    if len(xs) < 5:
        return None
    rx, ry = rank(xs), rank(ys)
    try:
        return statistics.correlation(rx, ry)
    except (statistics.StatisticsError, AttributeError):
        mx, my = statistics.mean(rx), statistics.mean(ry)
        num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
        den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
        return num / den if den else None


def replay(history, horizon, min_points=6):
    """Renvoie {date: {symb: {"profiles": {p: reco}, "fwd": pct|None}}}."""
    stocks = {k: v for k, v in history.items() if not k.startswith("_IDX_")}
    dates = sorted({p["date"] for pts in stocks.values() for p in pts if p["date"] != "veille"})
    out = {}
    for symb, pts in stocks.items():
        idx_of = {p["date"]: i for i, p in enumerate(pts)}
        for d in dates:
            i = idx_of.get(d)
            if i is None or i + 1 < min_points:
                continue
            window = pts[: i + 1]
            prev, cur = window[-2]["cloture"], window[-1]["cloture"]
            variation = (cur - prev) / prev * 100.0 if prev else 0.0
            ind = engine.compute_indicators(window)
            ind["force_relative_pct"] = None
            illiquide, _ = engine.liquidity_flag(window[-1].get("volume"), ind, variation)
            ind["liquidite_insuffisante"] = illiquide
            recos = engine.recommend_all(window, variation, ind)
            fwd = None
            if i + horizon < len(pts):
                fwd = (pts[i + horizon]["cloture"] - cur) / cur * 100.0 if cur else None
            out.setdefault(d, {})[symb] = {"profiles": recos, "fwd": fwd}
    return out


def replay_v2(history, horizon):
    """Même chose avec le moteur v2 (classement multifactoriel), via le même
    code que la production (analysis_engine.rescore_session)."""
    stocks = {k: v for k, v in history.items() if not k.startswith("_IDX_")}
    dates = sorted({p["date"] for pts in stocks.values() for p in pts if p["date"] != "veille"})
    out = {}
    for d in dates:
        day = {}
        for symb, (_, recos) in engine.rescore_session(history, d).items():
            pts = stocks[symb]
            i = next(j for j, p in enumerate(pts) if p["date"] == d)
            cur = pts[i]["cloture"]
            fwd = (pts[i + horizon]["cloture"] - cur) / cur * 100.0 if i + horizon < len(pts) and cur else None
            day[symb] = {"profiles": recos, "fwd": fwd}
        if day:
            out[d] = day
    return out


def evaluate(results, profile, factor_only=False):
    """factor_only : ne compter que les valeurs notées par le modèle
    multifactoriel (historique suffisant), pour mesurer le v2 lui-même."""
    ics, by_family, changes, total = [], {"achat": [], "neutre": [], "vente": []}, 0, 0
    prev = None
    for d in sorted(results):
        day = results[d]
        if factor_only:
            day = {s: v for s, v in day.items() if "score_jour" in v["profiles"][profile]}
            if not day:
                continue
        scored = [(v["profiles"][profile]["score"], v["fwd"]) for v in day.values() if v["fwd"] is not None]
        if scored:
            ic = spearman([s for s, _ in scored], [f for _, f in scored])
            if ic is not None:
                ics.append(ic)
        for v in day.values():
            if v["fwd"] is not None:
                by_family[FAMILY[v["profiles"][profile]["signal"]]].append(v["fwd"])
        cur = {s: v["profiles"][profile]["signal"] for s, v in day.items()}
        if prev:
            common = [s for s in cur if s in prev]
            changes += sum(1 for s in common if cur[s] != prev[s])
            total += len(common)
        prev = cur
    mean = lambda xs: statistics.mean(xs) if xs else float("nan")
    return {
        "ic": mean(ics), "ic_n": len(ics),
        "ic_positive_share": sum(1 for x in ics if x > 0) / len(ics) if ics else float("nan"),
        "fwd": {k: (mean(v), len(v)) for k, v in by_family.items()},
        "spread": mean(by_family["achat"]) - mean(by_family["vente"]),
        "rotation": changes / total if total else float("nan"),
    }


def reliability_summary(history, horizon=5):
    """Fiabilité mesurée du moteur en production (v2), pour affichage dans le
    dashboard et pour éclairer l'analyse IA."""
    results = replay_v2(history, horizon)
    out = {"horizon_seances": horizon, "profils": {}}
    for profile in engine.PROFILE_PARAMS:
        r = evaluate(results, profile, factor_only=True)
        if not r["ic_n"]:
            continue
        out["profils"][profile] = {
            "ic": round(r["ic"], 3),
            "ic_positif_part": round(r["ic_positive_share"], 2),
            "seances": r["ic_n"],
            "ecart_achat_vente_pts": round(r["spread"], 2),
            "rotation": round(r["rotation"], 2),
            "perf_moyenne_pct": {k: round(v[0], 2) for k, v in r["fwd"].items() if v[1]},
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", default=str(HERE / "history.json"))
    ap.add_argument("--horizon", type=int, default=5)
    args = ap.parse_args()
    with open(args.history, encoding="utf-8") as f:
        history = json.load(f)
    v1, v2 = replay(history, args.horizon), replay_v2(history, args.horizon)
    # Comparaison sur les seules séances où le v2 émet des signaux factoriels.
    common = {d for d, day in v2.items()
              if any("tendance de fond" in r["profiles"]["equilibre"]["raison"] for r in day.values())}
    print(f"Backtest sur {len(common)} séances communes, horizon {args.horizon} séances.")
    for name, res in (("v1", v1), ("v2", v2)):
        res = {d: day for d, day in res.items() if d in common}
        for profile in engine.PROFILE_PARAMS:
            r = evaluate(res, profile)
            fam = ", ".join(f"{k} {v[0]:+.2f}% (n={v[1]})" for k, v in r["fwd"].items())
            print(f"  {name} {profile:10s} IC {r['ic']:+.3f} ({r['ic_positive_share']:.0%} des séances > 0, n={r['ic_n']}) | "
                  f"écart achat-vente {r['spread']:+.2f} pts | rotation {r['rotation']:.0%} | {fam}")


if __name__ == "__main__":
    main()
