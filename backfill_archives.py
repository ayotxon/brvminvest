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
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import archives

HERE = Path(__file__).resolve().parent
MARKET_RE = re.compile(r'<script id="market-data" type="application/json">(.*?)</script>', re.S)


def git(*args):
    return subprocess.run(["git", *args], cwd=HERE, check=True, capture_output=True, text=True).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="Réécrire les archives déjà présentes")
    args = ap.parse_args()

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
