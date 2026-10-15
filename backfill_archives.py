#!/usr/bin/env python3
"""Reconstitue les archives journalières des séances passées à partir de
l'historique git : chaque commit de la tâche planifiée contient un
index.html qui embarque les données complètes de la séance. Pour chaque date
de séance (asOfDate), on garde la version du DERNIER commit de la journée,
c'est-à-dire l'état de clôture.

À lancer une seule fois (les archives des séances suivantes sont écrites
automatiquement par update_daily.py) :

    python3 backfill_archives.py            # n'écrase pas les archives existantes
    python3 backfill_archives.py --force    # réécrit tout
    python3 backfill_archives.py --rescore  # recalcule les signaux des archives
                                            # avec le moteur actuel et ajoute
                                            # le dossier IA manquant

Le recalcul (--rescore) n'utilise pour chaque séance que l'historique connu
à cette date. Les signaux d'origine sont conservés dans
« signaux_origine » pour mémoire.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import ai_analysis
import analysis_engine
import archives
import backtest

HERE = Path(__file__).resolve().parent
MARKET_RE = re.compile(r'<script id="market-data" type="application/json">(.*?)</script>', re.S)


def git(*args):
    return subprocess.run(["git", *args], cwd=HERE, check=True, capture_output=True, text=True).stdout


def rescore(archive_dir):
    with open(HERE / "history.json", encoding="utf-8") as f:
        history = json.load(f)
    version = 2
    n = 0
    for entry in archives.load_index(archive_dir):
        path = Path(archive_dir) / f"{entry['date']}.json"
        with open(path, encoding="utf-8") as f:
            snap = json.load(f)
        if (snap.get("moteur") or {}).get("version") == version:
            continue
        rescored = analysis_engine.rescore_session(history, snap["asOfDate"])
        for st in snap.get("stocks", []):
            if st["symbole"] not in rescored:
                continue
            ind, recos = rescored[st["symbole"]]
            st.setdefault("signaux_origine", {p: r["signal"] for p, r in (st.get("recommandations") or {}).items()})
            st["recommandations"] = recos
            if "facteurs" in ind:
                st["indicateurs"]["facteurs"] = ind["facteurs"]
            st["indicateurs"]["volatilite_pct"] = ind["volatilite_pct"]
        snap["moteur"] = {"version": version, "recalcule": True}
        archives.write_snapshot(archive_dir, snap)
        n += 1
    print(f"{n} archive(s) recalculée(s) avec le moteur v{version}.", file=sys.stderr)


def build_contexts(archive_dir):
    """Ajoute le dossier IA (contexteIA) aux archives qui n'en ont pas, avec
    la fiabilité du moteur mesurée sur l'historique connu à chaque date."""
    with open(HERE / "history.json", encoding="utf-8") as f:
        history = json.load(f)
    with open(HERE / "sectors.json", encoding="utf-8") as f:
        sectors = json.load(f)
    index = archives.load_index(archive_dir)
    loaded = {}

    def load(date_iso):
        if date_iso not in loaded:
            with open(Path(archive_dir) / f"{date_iso}.json", encoding="utf-8") as f:
                loaded[date_iso] = json.load(f)
        return loaded[date_iso]

    n = 0
    for pos, entry in enumerate(index):
        snap = load(entry["date"])
        if snap.get("contexteIA"):
            continue
        for st in snap.get("stocks", []):
            if st.get("secteur") == "Non classé" and st["symbole"] in sectors:
                st["secteur"], st["pays"] = sectors[st["symbole"]]["secteur"], sectors[st["symbole"]]["pays"]
        known = {k: [p for p in v if p.get("date") == "veille" or p.get("date", "") <= snap["asOfDate"]]
                 for k, v in history.items()}
        snap.setdefault("moteur", {})["fiabilite"] = backtest.reliability_summary(known)
        previous = [load(e["date"]) for e in index[pos + 1:pos + 6]]
        context = ai_analysis.build_context(snap, history, previous, index[pos:])
        snap["contexteIA"] = {"systeme": ai_analysis.SYSTEM_PROMPT, "marche": context}
        archives.write_snapshot(archive_dir, snap)
        n += 1
    print(f"Dossier IA ajouté à {n} archive(s).", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="Réécrire les archives déjà présentes")
    ap.add_argument("--rescore", action="store_true", help="Recalculer les signaux des archives avec le moteur actuel")
    args = ap.parse_args()
    if args.rescore:
        rescore(HERE / "archives")
        build_contexts(HERE / "archives")
        return

    archive_dir = HERE / "archives"
    commits = git("log", "--reverse", "--format=%H", "--", "index.html").split()
    by_date = {}
    for sha in commits:
        try:
            html = git("show", f"{sha}:index.html")
        except subprocess.CalledProcessError:
            continue
        m = MARKET_RE.search(html)
        if not m:
            continue
        try:
            market = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        if market.get("asOfDate") and market.get("stocks"):
            by_date[market["asOfDate"]] = market  # le commit le plus récent l'emporte

    written = 0
    for date_iso in sorted(by_date):
        if not args.force and (archive_dir / f"{date_iso}.json").exists():
            continue
        archives.write_snapshot(archive_dir, archives.build_snapshot(by_date[date_iso]))
        written += 1
    print(f"{len(by_date)} séance(s) trouvée(s) dans l'historique git, {written} archive(s) écrite(s).", file=sys.stderr)


if __name__ == "__main__":
    main()
