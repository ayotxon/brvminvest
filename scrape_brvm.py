#!/usr/bin/env python3
"""Scraper autonome (sans Claude/WebFetch) pour les pages publiques BRVM.

Utilise requests + BeautifulSoup en repérant les tableaux par le TEXTE de
leurs en-têtes plutôt que par des classes CSS figées (plus robuste si BRVM
change son thème/sa mise en page ; seuls les libellés français des colonnes
sont supposés stables).

Si BRVM modifie substantiellement la structure de la page et que ce script
ne trouve plus les tableaux attendus, il s'arrête avec un message clair
(voir README.md, section "Si le scraper casse") plutôt que d'écrire des
données silencieusement erronées.

Usage:
    python3 scrape_brvm.py --stocks-out today_stocks.json --indices-out today_indices.json
"""
import argparse
import json
import re
import sys
import unicodedata

import requests
from bs4 import BeautifulSoup

STOCKS_URL = "https://www.brvm.org/fr/cours-actions/0"
INDICES_URL = "https://www.brvm.org/fr/indices"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
}


def norm(text):
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", text).strip().lower()


def fetch(url):
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser")


def header_cells(table):
    thead = table.find("thead")
    row = None
    if thead:
        row = thead.find("tr")
    if row is None:
        row = table.find("tr")
    if row is None:
        return []
    cells = row.find_all(["th", "td"])
    return [norm(c.get_text(" ", strip=True)) for c in cells]


def find_table(soup, required_keywords):
    """Renvoie la première <table> dont la ligne d'en-tête contient TOUS les
    mots-clés donnés (recherche insensible aux accents/casse)."""
    for table in soup.find_all("table"):
        headers = header_cells(table)
        joined = " | ".join(headers)
        if all(any(kw in h for h in headers) or kw in joined for kw in required_keywords):
            return table, headers
    return None, None


def map_columns(headers, keyword_map):
    """keyword_map: {output_key: [candidate substrings]}. Renvoie
    {output_key: column_index} pour chaque clé trouvée."""
    result = {}
    for key, candidates in keyword_map.items():
        for i, h in enumerate(headers):
            if any(c in h for c in candidates):
                result[key] = i
                break
    return result


def data_rows(table):
    tbody = table.find("tbody")
    rows = tbody.find_all("tr") if tbody else table.find_all("tr")[1:]
    return rows


def cell_text(cells, idx):
    if idx is None or idx >= len(cells):
        return ""
    return cells[idx].get_text(" ", strip=True)


def scrape_stocks():
    soup = fetch(STOCKS_URL)
    table, headers = find_table(soup, ["symbole", "cloture"])
    if table is None:
        # tente sans l'accent normalisé de "clôture" au cas où norm() diffère
        table, headers = find_table(soup, ["symbole"])
    if table is None:
        raise RuntimeError(
            "Impossible de trouver le tableau des cours sur " + STOCKS_URL +
            " — la structure de la page a peut-être changé. "
            "Tables trouvées et leurs en-têtes : " +
            repr([header_cells(t) for t in soup.find_all("table")][:5])
        )

    col_map = map_columns(headers, {
        "symbole": ["symbole"],
        "nom": ["nom"],
        "volume": ["volume"],
        "cours_veille": ["veille"],
        "cours_ouverture": ["ouverture"],
        "cours_cloture": ["cloture", "cl ture"],
        "variation_pct": ["variation"],
    })
    missing = [k for k in ("symbole", "cours_cloture") if k not in col_map]
    if missing:
        raise RuntimeError(
            f"Colonnes essentielles introuvables dans l'en-tête du tableau des cours : {missing}. "
            f"En-têtes détectés : {headers}"
        )

    rows_out = []
    for tr in data_rows(table):
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue
        symbole = cell_text(cells, col_map.get("symbole"))
        if not symbole or len(symbole) > 12:
            continue
        rows_out.append({
            "symbole": symbole,
            "nom": cell_text(cells, col_map.get("nom")) or symbole,
            "volume": cell_text(cells, col_map.get("volume")),
            "cours_veille": cell_text(cells, col_map.get("cours_veille")),
            "cours_ouverture": cell_text(cells, col_map.get("cours_ouverture")),
            "cours_cloture": cell_text(cells, col_map.get("cours_cloture")),
            "variation_pct": cell_text(cells, col_map.get("variation_pct")),
        })

    if len(rows_out) < 20:
        raise RuntimeError(
            f"Seulement {len(rows_out)} valeurs trouvées (≈45-48 attendues) — "
            "la page a probablement changé de structure, ou le scraping est bloqué. "
            "Arrêt par précaution plutôt que publier des données incomplètes."
        )

    # Date/heure de dernière mise à jour affichée sur la page (best-effort)
    page_text = soup.get_text(" ", strip=True)
    m = re.search(r"Derni[eè]re mise [aà] jour\s*:?\s*([^|]{0,60})", page_text, re.IGNORECASE)
    page_date = m.group(1).strip() if m else None

    return rows_out, page_date


def scrape_indices():
    soup = fetch(INDICES_URL)
    table, headers = find_table(soup, ["cloture"])
    if table is None:
        table, headers = find_table(soup, ["variation"])
    if table is None:
        raise RuntimeError(
            "Impossible de trouver le tableau des indices sur " + INDICES_URL +
            " — en-têtes des tableaux trouvés : " +
            repr([header_cells(t) for t in soup.find_all("table")][:5])
        )

    col_map = map_columns(headers, {
        "ouverture": ["ouverture"],
        "plus_haut": ["haut"],
        "plus_bas": ["bas"],
        "cloture": ["cloture", "cl ture"],
        "variation_pct": ["variation"],
    })

    rows_out = []
    for tr in data_rows(table):
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue
        # Le nom de l'indice est généralement en première cellule (souvent un <th>)
        nom = cell_text(cells, 0)
        if not nom:
            continue
        rows_out.append({
            "nom_indice": nom,
            "ouverture": cell_text(cells, col_map.get("ouverture")),
            "plus_haut": cell_text(cells, col_map.get("plus_haut")),
            "plus_bas": cell_text(cells, col_map.get("plus_bas")),
            "cloture": cell_text(cells, col_map.get("cloture")),
            "variation_pct": cell_text(cells, col_map.get("variation_pct")),
        })

    if not rows_out:
        raise RuntimeError("Aucun indice trouvé sur " + INDICES_URL + " — en-têtes : " + repr(headers))

    return rows_out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stocks-out", required=True)
    ap.add_argument("--indices-out", required=True)
    ap.add_argument("--page-date-out", default=None, help="Fichier texte où écrire la date affichée sur la page (optionnel)")
    args = ap.parse_args()

    stocks, page_date = scrape_stocks()
    with open(args.stocks_out, "w", encoding="utf-8") as f:
        json.dump(stocks, f, ensure_ascii=False)
    print(f"OK: {len(stocks)} valeurs écrites dans {args.stocks_out}", file=sys.stderr)

    indices = scrape_indices()
    with open(args.indices_out, "w", encoding="utf-8") as f:
        json.dump(indices, f, ensure_ascii=False)
    print(f"OK: {len(indices)} indices écrits dans {args.indices_out}", file=sys.stderr)

    if args.page_date_out:
        with open(args.page_date_out, "w", encoding="utf-8") as f:
            f.write(page_date or "")
        print(f"Date affichée sur la page : {page_date!r}", file=sys.stderr)


if __name__ == "__main__":
    main()
