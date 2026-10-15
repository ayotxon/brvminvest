#!/usr/bin/env python3
"""Obligations cotées à la BRVM : mise en forme de la cote scrapée sur
brvm.org/fr/cours-obligations.

La cote publiée donne pour chaque ligne le code, le libellé (qui contient le
taux facial et les années d'émission/échéance, ex. « ETAT DU MALI 6,35 %
2024-2029 »), la date d'émission, le cours (en FCFA par titre), le coupon
couru et le dernier coupon payé. Elle ne donne ni le nominal restant (de
nombreuses obligations BRVM sont amortissables : un cours de 4 000 FCFA peut
refléter un nominal remboursé aux 3/5 et non une décote), ni le tableau
d'amortissement, ni les volumes : aucun rendement actuariel n'est donc
calculé ici, seul le taux facial est indiqué.
"""
import re
import unicodedata


def _norm(s):
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode("ascii").upper()


def _number(s):
    s = (s or "").replace("\xa0", "").replace(" ", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


ETATS = {
    "TPCI": "Côte d'Ivoire", "COTE D'IVOIRE": "Côte d'Ivoire", "TPBF": "Burkina Faso", "BURKINA": "Burkina Faso",
    "TPBJ": "Bénin", "BENIN": "Bénin", "MALI": "Mali", "EOM": "Mali", "SENEGAL": "Sénégal", "EOS": "Sénégal",
    "NIGER": "Niger", "TPNE": "Niger", "TPTG": "Togo", "TOGO": "Togo", "GUINEE-BISSAU": "Guinée-Bissau", "TPGB": "Guinée-Bissau",
}
INSTITUTIONS = ("BOAD", "BIDC", "CRRH", "BCEAO", "FAGACE", "SHELTER")


def classify(code, nom):
    n = _norm(nom)
    c = _norm(code)
    if "SUKUK" in n or ".S" in c:
        kind = "Sukuk"
    elif any(k in n for k in ("TRESOR", "ETAT DU", "ETAT DE")) or c.startswith(("TP", "EOM", "EOS")):
        kind = "État"
    elif n.startswith("FCTC") or " FCTC " in n:
        kind = "Titrisation (FCTC)"
    elif any(k in n or c.startswith(k) for k in INSTITUTIONS):
        kind = "Institution régionale"
    else:
        kind = "Entreprise"
    pays = None
    if kind in ("État", "Sukuk"):
        for k, v in ETATS.items():
            if k in n or c.startswith(k):
                pays = v
                break
    labels = []
    if any(k in n for k in ("GSS", "GREEN", "VERT", "SOCIAL", "DURABLE", "SUSTAINABLE", "BLEU", "GENDER")):
        labels.append("durable")
    if "DIASPORA" in n:
        labels.append("diaspora")
    if "SPREAD" in n or "VARIABLE" in n:
        labels.append("taux variable")
    return kind, pays, labels


def parse_bond(row, current_year):
    nom = row.get("nom", "")
    n = _norm(nom)
    taux = None
    m = re.search(r"(\d{1,2}(?:[.,]\d{1,3})?)\s*%", nom)
    if m:
        taux = _number(m.group(1))
    years = [int(y) for y in re.findall(r"(?<!\d)(20\d{2}|19\d{2})(?!\d)", nom)]
    debut, fin = (years[0], years[-1]) if len(years) >= 2 else (years[0] if years else None, None)
    kind, pays, labels = classify(row.get("code", ""), nom)
    cours = _number(row.get("cours"))
    # « 24/04/2026 / 320,48 » : date et valeur séparées par « / » entouré d'espaces.
    m_paie = re.match(r"\s*(\d{2}/\d{2}/\d{4})\s*/\s*([\d\s.,]+)", row.get("dernier_paiement") or "")
    dernier_date = m_paie.group(1) if m_paie else ""
    dernier_val = _number(m_paie.group(2)) if m_paie else None
    if fin is None:
        statut = "inconnu"
    elif fin < current_year:
        statut = "échue"
    else:
        statut = "en vie"
    return {
        "code": row.get("code"),
        "nom": re.sub(r"\s+", " ", nom).strip(),
        "type": kind,
        "pays": pays,
        "labels": labels,
        "taux_facial_pct": taux,
        "annee_emission": debut,
        "annee_echeance": fin,
        "date_emission": row.get("date_emission") or None,
        "cours": cours,
        "coupon_couru": _number(row.get("coupon_couru")),
        "dernier_coupon_date": dernier_date or None,
        "dernier_coupon_valeur": dernier_val,
        "statut": statut,
        "taux_variable": "taux variable" in labels or ("SPREAD" in n and taux is None),
    }


def build_bonds(raw_rows, current_year):
    """Renvoie {"lignes": [...obligations en vie...], "echues": n, "total": n}."""
    parsed = [parse_bond(r, current_year) for r in raw_rows or []]
    alive = [b for b in parsed if b["statut"] != "échue" and (b["cours"] or 0) > 0]
    alive.sort(key=lambda b: (b["annee_echeance"] or 9999, b["code"] or ""))
    return {"lignes": alive, "echues": sum(1 for b in parsed if b["statut"] == "échue"), "total": len(parsed)}
