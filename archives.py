#!/usr/bin/env python3
"""Archivage des séances : un fichier JSON par jour de bourse dans
`archives/AAAA-MM-JJ.json`, plus un index `archives/index.json` (liste des
séances archivées, la plus récente en premier) que le dashboard embarque pour
proposer la consultation des jours passés.

Chaque archive est un instantané autonome de la séance (indices, synthèse,
cours, indicateurs, recommandations des trois profils, relevés
intrajournaliers du jour, et — quand ils sont disponibles — les relevés bruts
scrapés sur brvm.org). L'historique cumulé (history.json) n'y est pas recopié :
il reste la source unique pour les calculs de tendance.

L'archive du jour est réécrite à chaque passage de la tâche planifiée ; le
dernier passage de la journée (17h UTC, après la clôture) fige donc l'état de
clôture de la séance.
"""
import json
from pathlib import Path

ARCHIVE_SCHEMA = 1


def build_snapshot(market_data, raw_stocks=None, raw_indices=None, page_date=None):
    date_iso = market_data["asOfDate"]
    intraday_today = {
        symb: [p for p in pts if p.get("date") == date_iso]
        for symb, pts in (market_data.get("intraday") or {}).items()
    }
    snapshot = {
        "schema": ARCHIVE_SCHEMA,
        "asOfDate": date_iso,
        "asOfLabel": market_data.get("asOfLabel"),
        "lastUpdate": market_data.get("lastUpdate"),
        "indices": market_data.get("indices", []),
        "syntheseDuJour": market_data.get("syntheseDuJour", ""),
        "stats": market_data.get("stats", {}),
        "moteur": market_data.get("moteur"),
        "stocks": market_data.get("stocks", []),
        "intraday": {k: v for k, v in intraday_today.items() if v},
    }
    for key in ("contexteIA", "analyseIA"):
        if market_data.get(key):
            snapshot[key] = market_data[key]
    if raw_stocks is not None or raw_indices is not None:
        snapshot["raw"] = {"stocks": raw_stocks, "indices": raw_indices, "pageDate": page_date}
    return snapshot


def index_entry(snapshot):
    stats = snapshot.get("stats") or {}
    composite = next(
        (ix for ix in snapshot.get("indices", []) if "composite" in (ix.get("nom") or "").lower()),
        None,
    )
    return {
        "date": snapshot["asOfDate"],
        "label": snapshot.get("asOfLabel"),
        "lastUpdate": snapshot.get("lastUpdate"),
        "hausses": stats.get("hausses"),
        "baisses": stats.get("baisses"),
        "stables": stats.get("stables"),
        "composite": composite.get("variation_pct") if composite else None,
        "nStocks": len(snapshot.get("stocks", [])),
    }


def load_index(archive_dir):
    path = Path(archive_dir) / "index.json"
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_snapshot(archive_dir, snapshot):
    """Écrit l'archive de la séance et met à jour l'index. Renvoie le chemin écrit."""
    archive_dir = Path(archive_dir)
    archive_dir.mkdir(parents=True, exist_ok=True)
    path = archive_dir / f"{snapshot['asOfDate']}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, separators=(",", ":"))

    entries = [e for e in load_index(archive_dir) if e.get("date") != snapshot["asOfDate"]]
    entries.append(index_entry(snapshot))
    entries.sort(key=lambda e: e["date"], reverse=True)
    with open(archive_dir / "index.json", "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=1)
    return path
