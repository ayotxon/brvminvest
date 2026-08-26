#!/usr/bin/env python3
"""Assemble index.html pour la version autonome (hors claude.ai) du dashboard
BRVM Conseil : CSS + JS inlinés, pas de dépendance à window.claude, la
persistance des données utilisateur se fait via localStorage côté navigateur.

Usage:
    python3 build_standalone_html.py --market market_data.json --out index.html
"""
import argparse
import json


def safe_json_for_script(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


HEAD_TEMPLATE = """<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BRVM Conseil</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Public+Sans:wght@400;500;600;700&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
__CSS__
</style>
</head>"""


def build(market_data, css_text, app_js_text):
    head = HEAD_TEMPLATE.replace("__CSS__", css_text)
    default_user = {"riskProfile": "equilibre", "portfolio": [], "watchlist": []}
    doc = [
        "<!doctype html>",
        '<html lang="fr">',
        head,
        "<body>",
        '<div id="root"></div>',
        '<script id="market-data" type="application/json">' + safe_json_for_script(market_data) + "</script>",
        '<script id="user-data" type="application/json">' + safe_json_for_script(default_user) + "</script>",
        "<script>",
        app_js_text,
        "</script>",
        "</body></html>",
    ]
    return "\n".join(doc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", required=True)
    ap.add_argument("--css", default="style.css")
    ap.add_argument("--js", default="app_standalone.js")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.market, encoding="utf-8") as f:
        market_data = json.load(f)
    with open(args.css, encoding="utf-8") as f:
        css_text = f.read()
    with open(args.js, encoding="utf-8") as f:
        app_js_text = f.read()

    html = build(market_data, css_text, app_js_text)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"OK: {len(html)} caractères écrits dans {args.out}")


if __name__ == "__main__":
    main()
