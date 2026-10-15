#!/usr/bin/env python3
"""Orchestre la mise à jour quotidienne complète du dashboard BRVM Conseil
autonome : scraping -> moteur d'analyse -> reconstruction de index.html.

Conçu pour tourner aussi bien en local (`python3 update_daily.py`) que dans
une Action GitHub planifiée. Ne modifie `history.json`, `index.html` et
`archives/` que si les cours ont bougé depuis le dernier relevé (voir
page_session_date et unchanged_since_last_run). L'instantané de la séance est conservé dans
`archives/AAAA-MM-JJ.json` (voir archives.py).

Usage:
    python3 update_daily.py            # passage normal
    python3 update_daily.py --force    # retraite la séance même si rien n'a bougé
"""
import argparse
import datetime
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import ai_analysis
import archives
import backtest
import bonds

HERE = Path(__file__).resolve().parent

MOIS_FR = {
    "janvier": 1, "fevrier": 2, "février": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
    "juillet": 7, "aout": 8, "août": 8, "septembre": 9, "octobre": 10, "novembre": 11, "decembre": 12, "décembre": 12,
}
JOURS_FR = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
MOIS_LABEL = ["", "janvier", "février", "mars", "avril", "mai", "juin", "juillet",
              "aout", "septembre", "octobre", "novembre", "décembre"]


def run(cmd):
    print("+ " + " ".join(cmd), file=sys.stderr)
    subprocess.run(cmd, check=True, cwd=HERE)


def french_label(d):
    return f"{JOURS_FR[d.weekday()]} {d.day} {MOIS_LABEL[d.month]} {d.year}"


def _norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode("ascii")
    return s.lower()


def page_session_date(page_date_text):
    """Date de la séance affichée sur brvm.org (texte « Dernière mise à
    jour », ex. « Jeudi, 15 octobre, 2026 - 21:45 »), ou None si le texte est
    vide ou dans un format imprévu."""
    text = _norm(page_date_text)
    m = re.search(r"(\d{1,2})\s*,?\s*([a-z]+)\s*,?\s*(\d{4})", text)
    if not m:
        return None
    month = MOIS_FR.get(m.group(2))
    if month is None:
        return None
    try:
        return datetime.date(int(m.group(3)), month, int(m.group(1)))
    except ValueError:
        return None


def unchanged_since_last_run(history, stocks_path, date_iso):
    """Vrai si les cours ET volumes scrapés sont identiques, pour toutes les
    valeurs, au dernier point enregistré (celui de date_iso s'il existe déjà,
    sinon celui de la séance précédente) : rien de nouveau à publier. Évite
    d'enregistrer une fausse séance quand la page n'a pas bougé (jour férié,
    passage avant l'ouverture...)."""
    with open(stocks_path, encoding="utf-8") as f:
        rows = json.load(f)
    compared = 0
    for row in rows:
        pts = [p for p in history.get(row.get("symbole", "").strip(), [])
               if p.get("date", "") <= date_iso and p.get("date") != "veille"]
        if not pts:
            return False
        last = pts[-1]
        if _num(row.get("cours_cloture")) != last.get("cloture") or _num(row.get("volume")) != last.get("volume"):
            return False
        compared += 1
    return compared > 0


def _num(x):
    s = str(x or "").replace("\xa0", "").replace(" ", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="Retraiter la séance même si les cours n'ont pas bougé depuis le dernier relevé")
    args = ap.parse_args()

    # La BRVM (Abidjan) vit en GMT/UTC toute l'année : on raisonne en UTC.
    now = datetime.datetime.now(datetime.timezone.utc)
    today = now.date()
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    stocks_path = HERE / "today_stocks.json"
    indices_path = HERE / "today_indices.json"
    page_date_path = HERE / "page_date.txt"
    bonds_path = HERE / "today_bonds.json"

    run([sys.executable, str(HERE / "scrape_brvm.py"),
         "--stocks-out", str(stocks_path), "--indices-out", str(indices_path),
         "--page-date-out", str(page_date_path), "--bonds-out", str(bonds_path)])

    # La séance traitée est celle qu'affiche brvm.org, pas la date de
    # l'horloge : les passages planifiés de GitHub Actions peuvent avoir
    # plusieurs heures de retard (jusqu'après minuit), et doivent alors mettre
    # à jour la séance de la veille au lieu d'en inventer une nouvelle.
    page_date_text = page_date_path.read_text(encoding="utf-8") if page_date_path.exists() else ""
    session = page_session_date(page_date_text)
    if session is None or session > today:
        session = today
        if session.weekday() >= 5:
            print(f"Week-end et date de la page illisible ({page_date_text!r}) — aucun changement.", file=sys.stderr)
            return
    date_iso = session.isoformat()
    label = french_label(session)

    history_path = HERE / "history.json"
    if not history_path.exists():
        history_path.write_text("{}", encoding="utf-8")
    with open(history_path, encoding="utf-8") as f:
        if not args.force and unchanged_since_last_run(json.load(f), stocks_path, date_iso):
            print(f"Cours identiques au dernier relevé enregistré ({label}) — rien de nouveau. "
                  "Aucun changement.", file=sys.stderr)
            return

    intraday_path = HERE / "intraday.json"
    if not intraday_path.exists():
        intraday_path.write_text("{}", encoding="utf-8")

    new_market_path = HERE / "market_data.json"
    run([sys.executable, str(HERE / "analysis_engine.py"),
         "--history", str(history_path), "--today", str(stocks_path),
         "--indices", str(indices_path), "--sectors", str(HERE / "sectors.json"),
         "--out", str(new_market_path),
         "--date", date_iso, "--label", label, "--updated", now_iso,
         "--intraday", str(intraday_path), "--intraday-window-dates", "5"])

    with open(new_market_path, encoding="utf-8") as f:
        market_data = json.load(f)
    try:
        market_data.setdefault("moteur", {})["fiabilite"] = backtest.reliability_summary(market_data["history"])
    except Exception as e:  # la mesure de fiabilité ne doit jamais bloquer la mise à jour
        print(f"Mesure de fiabilité impossible : {e}", file=sys.stderr)
    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(market_data["history"], f, ensure_ascii=False)
    with open(intraday_path, "w", encoding="utf-8") as f:
        json.dump(market_data["intraday"], f, ensure_ascii=False)

    # Obligations cotées (onglet Opportunités).
    try:
        with open(bonds_path, encoding="utf-8") as f:
            market_data["obligations"] = bonds.build_bonds(json.load(f), session.year)
    except (OSError, ValueError) as e:
        print(f"Obligations ignorées : {e}", file=sys.stderr)

    # Dossier de séance pour l'IA (embarqué dans la page et l'archive) et
    # analyse IA automatique, une fois par séance après la clôture.
    archive_dir = HERE / "archives"
    index = [e for e in archives.load_index(archive_dir) if e["date"] < date_iso]
    previous = []
    for e in index[:5]:
        try:
            with open(archive_dir / f"{e['date']}.json", encoding="utf-8") as f:
                previous.append(json.load(f))
        except (OSError, ValueError):
            pass
    existing = None
    try:
        with open(archive_dir / f"{date_iso}.json", encoding="utf-8") as f:
            existing = json.load(f).get("analyseIA")
    except (OSError, ValueError):
        pass
    context = ai_analysis.build_context(market_data, market_data["history"], previous,
                                        [archives.index_entry(market_data)] + index)
    market_data["contexteIA"] = {"systeme": ai_analysis.SYSTEM_PROMPT, "marche": context}
    analysis = existing
    if ai_analysis.should_generate(now, session, existing):
        analysis = ai_analysis.generate(context) or existing
        if analysis is not existing:
            print(f"Analyse IA générée ({analysis['modele']}).", file=sys.stderr)
    if analysis:
        market_data["analyseIA"] = analysis
    with open(new_market_path, "w", encoding="utf-8") as f:
        json.dump(market_data, f, ensure_ascii=False, separators=(",", ":"))

    with open(stocks_path, encoding="utf-8") as f:
        raw_stocks = json.load(f)
    with open(indices_path, encoding="utf-8") as f:
        raw_indices = json.load(f)
    snapshot = archives.build_snapshot(market_data, raw_stocks, raw_indices, page_date_text or None)
    archive_path = archives.write_snapshot(HERE / "archives", snapshot)
    print(f"Séance archivée dans {archive_path.relative_to(HERE)}", file=sys.stderr)

    run([sys.executable, str(HERE / "build_standalone_html.py"),
         "--market", str(new_market_path), "--archives", str(HERE / "archives"),
         "--out", str(HERE / "index.html")])

    print(f"Mise à jour terminée pour {label}. {market_data['syntheseDuJour']}", file=sys.stderr)


if __name__ == "__main__":
    main()
