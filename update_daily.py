#!/usr/bin/env python3
"""Orchestre la mise à jour quotidienne complète du dashboard BRVM Conseil
autonome : scraping -> moteur d'analyse -> reconstruction de index.html.

Conçu pour tourner aussi bien en local (`python3 update_daily.py`) que dans
une Action GitHub planifiée. Ne modifie `history.json` et `index.html` que
si une nouvelle séance de bourse est détectée (voir _market_traded_today).

Usage:
    python3 update_daily.py
"""
import datetime
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

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


def market_traded_today(page_date_text, today):
    """Heuristique : compare le jour/mois/année dans le texte "Dernière mise
    à jour" de la page à la date du jour. Renvoie True si ça correspond (ou
    si le texte est vide/imprévu : dans le doute on tente quand même la mise
    à jour plutôt que de bloquer indéfiniment)."""
    if not page_date_text:
        return True
    text = _norm(page_date_text)
    m = re.search(r"(\d{1,2})\s+([a-z]+)\s+(\d{4})", text)
    if not m:
        return True
    day, month_name, year = int(m.group(1)), m.group(2), int(m.group(3))
    month = MOIS_FR.get(month_name)
    if month is None:
        return True
    return (day, month, year) == (today.day, today.month, today.year)


def main():
    today = datetime.date.today()
    date_iso = today.isoformat()
    label = french_label(today)
    now_iso = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    stocks_path = HERE / "today_stocks.json"
    indices_path = HERE / "today_indices.json"
    page_date_path = HERE / "page_date.txt"

    run([sys.executable, str(HERE / "scrape_brvm.py"),
         "--stocks-out", str(stocks_path), "--indices-out", str(indices_path),
         "--page-date-out", str(page_date_path)])

    page_date_text = page_date_path.read_text(encoding="utf-8") if page_date_path.exists() else ""
    if not market_traded_today(page_date_text, today):
        print(f"Marché fermé aujourd'hui ({label}) — dernière mise à jour BRVM : {page_date_text!r}. "
              "Aucun changement.", file=sys.stderr)
        return

    history_path = HERE / "history.json"
    if not history_path.exists():
        history_path.write_text("{}", encoding="utf-8")

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
    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(market_data["history"], f, ensure_ascii=False)
    with open(intraday_path, "w", encoding="utf-8") as f:
        json.dump(market_data["intraday"], f, ensure_ascii=False)

    run([sys.executable, str(HERE / "build_standalone_html.py"),
         "--market", str(new_market_path), "--out", str(HERE / "index.html")])

    print(f"Mise à jour terminée pour {label}. {market_data['syntheseDuJour']}", file=sys.stderr)


if __name__ == "__main__":
    main()
