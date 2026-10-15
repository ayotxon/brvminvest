/* BRVM Conseil — logique application (rendu, persistance, interactions,
   archives des séances, analyse IA). Ce fichier est inliné tel quel dans
   index.html par build_standalone_html.py. Il ne dépend d'aucune
   bibliothèque externe. */
(function () {
  "use strict";

  var SIGNAL_META = {
    ACHETER:   { label: "Acheter",   tone: "good",    order: 5 },
    RENFORCER: { label: "Renforcer", tone: "good-soft",order: 4 },
    CONSERVER: { label: "Conserver", tone: "neutral", order: 3 },
    SURVEILLER:{ label: "Surveiller",tone: "warning", order: 3 },
    "ALLÉGER": { label: "Alléger",   tone: "serious", order: 2 },
    VENDRE:    { label: "Vendre",    tone: "critical",order: 1 }
  };

  var ALIGNEMENT_META = {
    haussiere_confirmee: { label: "Haussière confirmée", detail: "court, moyen et long terme alignés à la hausse", tone: "good" },
    baissiere_confirmee: { label: "Baissière confirmée", detail: "court, moyen et long terme alignés à la baisse", tone: "critical" },
    mixte:               { label: "Mitigée",             detail: "les horizons ne racontent pas la même histoire", tone: "warning" },
    indeterminee:        { label: "Indéterminée",        detail: "historique encore insuffisant sur assez d'horizons", tone: "neutral" }
  };

  var PROFILES = [
    { key: "prudent", label: "Prudent", desc: "Priorité à la préservation du capital : ne pousse jamais à l'achat sur la foi d'une seule séance, réagit vite pour alléger en cas de baisse marquée." },
    { key: "equilibre", label: "Équilibré", desc: "Compromis entre momentum et volatilité : signaux modérés, sensibles à la confirmation par le volume." },
    { key: "dynamique", label: "Dynamique", desc: "Recherche la tendance et le momentum, tolère plus de volatilité, réagit dès qu'un mouvement se confirme par le volume." }
  ];

  var state = {
    market: null,      // données affichées (séance du jour ou séance archivée)
    live: null,        // données de la séance du jour embarquées dans la page
    archiveIndex: [],  // liste des séances archivées (archives/index.json)
    archiveCache: {},  // date -> archive déjà téléchargée
    view: { date: null, loading: null, error: null }, // date != null => mode archive
    user: null,
    ai: { running: false, text: "", status: "", error: null, meta: null, settingsOpen: false },
    ui: { search: "", secteur: "TOUS", signal: "TOUS", sort: "symbole", sortDir: 1, expanded: null, methodOpen: false, archivesShown: 10 }
  };

  // ---------------------------------------------------------------- utils
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (attrs[k] == null) continue;
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0 && typeof attrs[k] === "function") e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      if (typeof c === "string" || typeof c === "number") e.appendChild(document.createTextNode(String(c)));
      else e.appendChild(c);
    });
    return e;
  }

  function fmtNum(x, decimals) {
    if (x == null || isNaN(x)) return "—";
    var n = Number(x);
    var parts = n.toFixed(decimals == null ? 0 : decimals).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return parts.join(",");
  }
  function fmtFCFA(x) { return x == null ? "—" : fmtNum(x, 0) + " FCFA"; }
  function fmtPct(x) {
    if (x == null || isNaN(x)) return "—";
    var s = x > 0 ? "+" : "";
    return s + fmtNum(x, 2) + " %";
  }
  function pctClass(x) {
    if (x == null) return "muted";
    if (x > 0.001) return "up";
    if (x < -0.001) return "down";
    return "flat";
  }
  function todayIso() {
    // Date locale de l'utilisateur (et non UTC), pour les saisies du jour.
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function findStock(symb) {
    return (state.market.stocks || []).filter(function (s) { return s.symbole === symb; })[0] || null;
  }

  // ------------------------------------------------------------ rendering
  function signalBadge(sig) {
    var meta = SIGNAL_META[sig] || { label: sig, tone: "neutral" };
    return el("span", { class: "badge tone-" + meta.tone }, [meta.label]);
  }

  function sparkline(points) {
    if (!points || points.length < 2) return el("span", { class: "muted small" }, ["historique en cours"]);
    var closes = points.map(function (p) { return p.cloture; }).filter(function (v) { return v != null; });
    if (closes.length < 2) return el("span", { class: "muted small" }, ["—"]);
    var w = 92, h = 28, pad = 3;
    var min = Math.min.apply(null, closes), max = Math.max.apply(null, closes);
    var range = max - min || 1;
    var step = (w - pad * 2) / (closes.length - 1);
    var d = closes.map(function (v, i) {
      var x = pad + i * step;
      var y = h - pad - ((v - min) / range) * (h - pad * 2);
      return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    var last = closes[closes.length - 1], first = closes[0];
    var up = last >= first;
    var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" class="spark" aria-hidden="true">' +
      '<path d="' + d + '" fill="none" stroke="' + (up ? "var(--up)" : "var(--down)") + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    var wrap = el("span", { class: "spark-wrap", html: svg });
    return wrap;
  }

  // Tracé intrajournalier : contrairement à sparkline() (un point par
  // séance, historique long terme), celui-ci trace les relevés successifs
  // (toutes les ~20 min pendant les heures de bourse) de la fenêtre
  // glissante récente stockée dans intraday.json / market.intraday.
  function intradaySparkline(points, onlyDate) {
    var pts = (points || []).filter(function (p) { return !onlyDate || p.date === onlyDate; });
    if (pts.length < 2) {
      return el("p", { class: "muted small" }, [
        pts.length === 1
          ? "Un seul relevé aujourd'hui pour le moment — la courbe apparaîtra après les prochains passages."
          : "Pas encore de relevé intrajournalier pour aujourd'hui."
      ]);
    }
    var closes = pts.map(function (p) { return p.cours; }).filter(function (v) { return v != null; });
    var w = 260, h = 56, pad = 6;
    var min = Math.min.apply(null, closes), max = Math.max.apply(null, closes);
    var range = max - min || 1;
    var step = (w - pad * 2) / (closes.length - 1);
    var d = closes.map(function (v, i) {
      var x = pad + i * step;
      var y = h - pad - ((v - min) / range) * (h - pad * 2);
      return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    var up = closes[closes.length - 1] >= closes[0];
    var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" class="spark-intraday" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + d + '" fill="none" stroke="' + (up ? "var(--up)" : "var(--down)") + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    var first = pts[0], last = pts[pts.length - 1];
    var firstTime = first.ts ? new Date(first.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
    var lastTime = last.ts ? new Date(last.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
    return el("div", { class: "intraday-chart" }, [
      el("div", { html: svg }),
      el("div", { class: "intraday-legend muted small" }, [
        firstTime + " · " + fmtFCFA(closes[0]) + "  →  " + lastTime + " · " + fmtFCFA(closes[closes.length - 1]) +
        "  (" + pts.length + " relevé(s))"
      ])
    ]);
  }

  function renderHeader() {
    var m = state.market;
    var header = el("header", { class: "app-header" }, [
      el("div", { class: "brand" }, [
        el("span", { class: "brand-mark" }, ["BC"]),
        el("div", {}, [
          el("h1", {}, ["BRVM Conseil"]),
          el("p", { class: "tagline" }, ["Analyse quotidienne et recommandations sur les valeurs de la Bourse Régionale des Valeurs Mobilières"])
        ])
      ]),
      el("div", { class: "header-meta" }, [
        el("div", { class: "meta-line" }, [m.asOfLabel || "—"]),
        el("div", { class: "meta-line muted small" }, ["Mis à jour à " + (m.lastUpdate ? new Date(m.lastUpdate).toLocaleString("fr-FR") : "—")]),
        state.view.date ? el("span", { class: "ro-pill" }, ["Séance archivée"]) : null
      ])
    ]);
    return header;
  }

  function indexLabel(nom) {
    return nom.replace(/BRVM\s*[-–]\s*/, "BRVM ");
  }

  function renderIndices() {
    var all = state.market.indices || [];
    var principaux = all.filter(function (ix) { return !ix.categorie || ix.categorie === "principal"; });
    var sectoriels = all.filter(function (ix) { return ix.categorie === "sectoriel"; });
    var wrap = el("div", {});
    var row = el("div", { class: "indices-row" });
    principaux.forEach(function (ix) {
      row.appendChild(el("div", { class: "stat-tile" }, [
        el("div", { class: "stat-label" }, [indexLabel(ix.nom)]),
        el("div", { class: "stat-value" }, [fmtNum(ix.cloture, 2)]),
        el("div", { class: "stat-delta " + pctClass(ix.variation_pct) }, [
          fmtPct(ix.variation_pct),
          ix.variation_ytd_pct != null ? el("span", { class: "muted" }, ["  · " + fmtPct(ix.variation_ytd_pct) + " depuis janv."]) : null
        ])
      ]));
    });
    wrap.appendChild(row);
    if (sectoriels.length) {
      wrap.appendChild(el("div", { class: "sector-indices" }, [el("span", { class: "muted small" }, ["Indices sectoriels :"])].concat(
        sectoriels.slice().sort(function (a, b) { return (b.variation_pct || 0) - (a.variation_pct || 0); }).map(function (ix) {
          return el("span", { class: "sector-chip" }, [
            indexLabel(ix.nom).replace("BRVM ", "").toLowerCase(),
            el("b", { class: pctClass(ix.variation_pct) }, [" " + fmtPct(ix.variation_pct)])
          ]);
        })
      )));
    }
    return wrap;
  }

  function renderSynthese() {
    var s = state.market.stats || {};
    var box = el("section", { class: "panel synthese" }, [
      el("h2", {}, ["Synthèse du jour"]),
      renderIndices(),
      el("p", { class: "synthese-text" }, [state.market.syntheseDuJour || ""]),
      el("div", { class: "breadth-row" }, [
        el("span", { class: "breadth up" }, [s.hausses + " en hausse"]),
        el("span", { class: "breadth down" }, [s.baisses + " en baisse"]),
        el("span", { class: "breadth flat" }, [s.stables + " stable(s)"])
      ]),
      el("p", { class: "muted small" }, [
        "Maturité de l'historique : " + (s.dataMaturityDays || 0) + " séance(s) suivie(s). " +
        (s.dataMaturityDays < 20 ? "Les moyennes mobiles et la volatilité s'affinent chaque jour de bourse." : "Historique suffisant pour des moyennes mobiles fiables.")
      ])
    ]);
    return box;
  }

  function renderMethodology() {
    var wrap = el("section", { class: "panel method" });
    var btn = el("button", { class: "link-btn", onclick: function () { state.ui.methodOpen = !state.ui.methodOpen; render(); } },
      [state.ui.methodOpen ? "− Masquer la méthodologie" : "+ Comment sont calculées les recommandations ?"]);
    wrap.appendChild(btn);
    if (state.ui.methodOpen) {
      var fiab = ((state.market.moteur || {}).fiabilite || {});
      var fp = (fiab.profils || {})[state.user.riskProfile];
      wrap.appendChild(el("div", { class: "method-body" }, [
        el("p", {}, ["Chaque valeur reçoit un score qui la ", el("b", {}, ["classe par rapport aux autres valeurs du marché"]), " à partir de quatre facteurs, calculés sur l'historique réellement observé :"]),
        el("ul", { class: "method-list" }, [
          el("li", {}, [el("b", {}, ["Tendance de fond"]), " — performance sur environ 25 séances, en excluant les 5 dernières. C'est la tendance qui persiste ; au-delà d'un certain niveau, son effet est plafonné car les envolées tendent à s'essouffler."]),
          el("li", {}, [el("b", {}, ["Retour à la moyenne"]), " — sur la BRVM, une hausse marquée sur quelques séances tend à se corriger, et inversement : le modèle préfère acheter sur repli plutôt qu'après une envolée."]),
          el("li", {}, [el("b", {}, ["Faible volatilité"]), " — à tendance égale, les valeurs calmes ont mieux performé."]),
          el("li", {}, [el("b", {}, ["Liquidité"]), " — capitaux échangés en moyenne par séance : les valeurs liquides ont mieux performé et leurs cours sont plus fiables."])
        ]),
        el("p", {}, ["Les facteurs sont pondérés selon le profil (le profil ", el("b", {}, ["prudent"]), " privilégie calme et liquidité, le profil ", el("b", {}, ["dynamique"]), " la tendance), puis le score est ", el("b", {}, ["lissé sur 3 séances"]), " pour que les signaux ne changent pas au moindre à-coup."]),
        el("p", {}, ["Garde-fous : pas d'achat franc si la tendance de fond est négative, pas de vente franche si elle reste positive, pas d'achat contre une tendance baissière confirmée sur tous les horizons, et signal forcé à ", el("b", {}, ["Surveiller"]), " quand le volume échangé est nul ou anormalement faible."]),
        fp ? el("p", { class: "method-reliability" }, [
          el("b", {}, ["Fiabilité mesurée (profil " + labelForProfile(state.user.riskProfile).toLowerCase() + ") : "]),
          "sur " + fp.seances + " séances, le classement du score a correctement anticipé l'ordre des performances à " + fiab.horizon_seances + " séances " +
          Math.round(fp.ic_positif_part * 100) + " % du temps (corrélation de rang moyenne " + fmtNum(fp.ic, 2) + ") ; les valeurs à l'achat ont fait en moyenne " +
          fmtNum(fp.ecart_achat_vente_pts, 2) + " point(s) de mieux que celles à la vente ; " + Math.round(fp.rotation * 100) + " % des signaux changent d'une séance à l'autre. " +
          "Le score est relatif : dans un marché baissier, les valeurs à l'achat peuvent baisser aussi, mais moins."
        ]) : null,
        el("p", {}, ["Ce modèle a remplacé en octobre 2026 un premier moteur fondé sur le momentum court terme, dont le backtest (backtest.py) a montré qu'il était contre-productif sur la BRVM. L'historique étant encore court (quelques dizaines de séances), ces mesures s'affineront avec le temps."]),
        el("p", {}, ["Ceci reste une analyse ", el("b", {}, ["technique"]), " (prix, volume, tendance), pas une analyse fondamentale : les résultats de l'entreprise, les dividendes ou le contexte macroéconomique de l'UEMOA ne sont pas pris en compte."]),
        el("p", { class: "disclaimer" }, ["Ceci est un outil d'aide à la décision basé sur des règles quantitatives transparentes. Ce n'est pas un conseil en investissement réglementé et cela ne remplace pas l'avis d'un conseiller agréé par l'AMF-UMOA (ex-CREPMF). Les marchés actions comportent un risque de perte en capital."])
      ]));
    }
    return wrap;
  }

  function renderProfileSwitcher() {
    var box = el("section", { class: "panel profile-switcher" }, [
      el("h2", {}, ["Votre profil de risque"])
    ]);
    var row = el("div", { class: "profile-options" });
    PROFILES.forEach(function (p) {
      var active = state.user.riskProfile === p.key;
      row.appendChild(el("button", {
        class: "profile-btn" + (active ? " active" : ""),
        onclick: function () { setRiskProfile(p.key); }
      }, [p.label]));
    });
    box.appendChild(row);
    var cur = PROFILES.filter(function (p) { return p.key === state.user.riskProfile; })[0];
    box.appendChild(el("p", { class: "muted small profile-desc" }, [cur ? cur.desc : ""]));
    return box;
  }

  // ------------------------------------------------- portefeuille (registre)
  // Le portefeuille est tenu sous forme de registre d'opérations (achats,
  // ventes, dividendes). Les positions, le prix de revient unitaire (PRU)
  // et les plus/moins-values en sont déduits par la méthode du prix moyen
  // pondéré : les frais d'achat s'ajoutent au coût, les frais de vente se
  // déduisent du produit de cession. state.user.portfolio (positions
  // ouvertes) est recalculé à partir du registre et sert au reste de l'appli.
  var TX_TYPES = {
    achat: { label: "Achat", qty: "Quantité achetée", price: "Prix unitaire (FCFA)" },
    vente: { label: "Vente", qty: "Quantité vendue", price: "Prix unitaire (FCFA)" },
    dividende: { label: "Dividende", qty: "Nombre d'actions", price: "Dividende net par action (FCFA)" }
  };

  function sortedTransactions(upToDate) {
    return (state.user.transactions || [])
      .filter(function (t) { return !upToDate || t.date <= upToDate; })
      .slice().sort(function (a, b) { return a.date === b.date ? (a.seq || 0) - (b.seq || 0) : (a.date < b.date ? -1 : 1); });
  }

  function computeLedger(upToDate) {
    var pos = {}, rows = [];
    var totals = { realized: 0, dividends: 0, fees: 0, bought: 0, sold: 0 };
    sortedTransactions(upToDate).forEach(function (t) {
      var p = pos[t.symbole] || (pos[t.symbole] = { symbole: t.symbole, qty: 0, cost: 0, realized: 0, dividends: 0, firstBuy: null });
      var q = Number(t.quantite) || 0, px = Number(t.prix) || 0, fees = Number(t.frais) || 0;
      var row = { tx: t, montant: null, realized: null, warning: null };
      totals.fees += fees;
      if (t.type === "achat") {
        if (p.qty === 0) p.firstBuy = t.date;
        p.qty += q; p.cost += q * px + fees;
        row.montant = -(q * px + fees);
        totals.bought += q * px + fees;
      } else if (t.type === "vente") {
        var sellQty = Math.min(q, p.qty);
        if (sellQty < q) row.warning = "Vente supérieure à la quantité détenue à cette date (" + fmtNum(p.qty, 0) + ").";
        var pru = p.qty ? p.cost / p.qty : 0;
        var proceeds = sellQty * px - fees;
        row.realized = proceeds - pru * sellQty;
        row.montant = proceeds;
        p.realized += row.realized; totals.realized += row.realized; totals.sold += proceeds;
        p.cost -= pru * sellQty; p.qty -= sellQty;
        if (p.qty <= 1e-9) { p.qty = 0; p.cost = 0; }
      } else if (t.type === "dividende") {
        row.montant = q * px - fees;
        p.dividends += row.montant; totals.dividends += row.montant;
      }
      rows.push(row);
    });
    var positions = Object.keys(pos).map(function (k) { return pos[k]; });
    return { positions: positions, open: positions.filter(function (p) { return p.qty > 0; }), rows: rows, totals: totals };
  }

  // Positions ouvertes à la date de la séance affichée (une séance archivée
  // ne tient compte que des opérations antérieures).
  function syncPortfolio() {
    var ledger = computeLedger(state.view.date ? state.market.asOfDate : null);
    state.user.portfolio = ledger.open.map(function (p) {
      return { symbole: p.symbole, quantite: p.qty, prix_achat: p.cost / p.qty, date_achat: p.firstBuy };
    });
    state.ledger = ledger;
  }

  function addTransaction(t) {
    state.user.transactions = state.user.transactions || [];
    t.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    t.seq = Date.now();
    state.user.transactions.push(t);
    syncPortfolio(); render(); saveUserState();
  }
  function removeTransaction(t) {
    if (!confirm("Supprimer cette opération (" + TX_TYPES[t.type].label.toLowerCase() + " " + t.symbole + " du " + t.date + ") ?")) return;
    state.user.transactions = (state.user.transactions || []).filter(function (x) { return x !== t; });
    syncPortfolio(); render(); saveUserState();
  }

  function heldAt(symb, date) {
    var p = computeLedger(date).positions.filter(function (x) { return x.symbole === symb; })[0];
    return p ? p.qty : 0;
  }

  function signedFCFA(x) { return x == null ? "—" : (x >= 0 ? "+" : "") + fmtNum(x, 0) + " FCFA"; }

  function positionRow(p, totalVal) {
    var s = findStock(p.symbole);
    var cours = s ? s.cours_cloture : null;
    var valeur = cours != null ? cours * p.qty : null;
    var pnl = valeur != null ? valeur - p.cost : null;
    var pnlPct = pnl != null && p.cost ? (pnl / p.cost) * 100 : null;
    var reco = s ? s.recommandations[state.user.riskProfile] : null;
    return el("tr", {}, [
      el("td", { class: "mono" }, [p.symbole]),
      el("td", { class: "name-cell" }, [s ? s.nom : p.symbole]),
      el("td", { class: "num" }, [fmtNum(p.qty, 0)]),
      el("td", { class: "num" }, [fmtNum(p.cost / p.qty, 0)]),
      el("td", { class: "num" }, [fmtNum(cours, 0)]),
      el("td", { class: "num" }, [fmtNum(valeur, 0)]),
      el("td", { class: "num " + pctClass(pnl) }, [pnl == null ? "—" : (pnl >= 0 ? "+" : "") + fmtNum(pnl, 0) + " (" + fmtPct(pnlPct) + ")"]),
      el("td", { class: "num muted" }, [valeur != null && totalVal ? fmtNum(valeur / totalVal * 100, 0) + " %" : "—"]),
      el("td", {}, [reco ? signalBadge(reco.signal) : "—"]),
      el("td", {}, [state.view.date ? null : el("button", { class: "link-btn small", onclick: function () {
        state.ui.txForm = { type: "vente", symbole: p.symbole, date: todayIso(), quantite: String(p.qty), prix: cours != null ? String(cours) : "", frais: "" };
        render();
        var f = document.getElementById("tx-form"); if (f) f.scrollIntoView({ behavior: "smooth", block: "center" });
      } }, ["Vendre"])])
    ]);
  }

  function statTile(label, value, cls, sub) {
    return el("div", { class: "stat-tile" }, [
      el("div", { class: "stat-label" }, [label]),
      el("div", { class: "stat-value " + (cls || "") }, [value]),
      sub ? el("div", { class: "stat-delta " + (cls || "") }, [sub]) : null
    ]);
  }

  function renderPortfolio() {
    var ledger = state.ledger || computeLedger(null);
    var box = el("section", { class: "panel portfolio-panel" }, [el("h2", {}, ["Mon portefeuille"])]);
    var totalVal = 0, openCost = 0, missing = 0;
    ledger.open.forEach(function (p) {
      var s = findStock(p.symbole);
      openCost += p.cost;
      if (s && s.cours_cloture != null) totalVal += s.cours_cloture * p.qty; else missing++;
    });
    var latent = totalVal - openCost;
    var t = ledger.totals;
    var result = latent + t.realized + t.dividends;
    if (ledger.rows.length) {
      box.appendChild(el("div", { class: "portfolio-summary" }, [
        statTile("Valeur actuelle", fmtFCFA(totalVal), "", ledger.open.length + " ligne(s)"),
        statTile("Coût des positions", fmtFCFA(openCost)),
        statTile("+/- value latente", signedFCFA(latent), pctClass(latent), openCost ? fmtPct(latent / openCost * 100) : null),
        statTile("+/- value réalisée", signedFCFA(t.realized), pctClass(t.realized)),
        statTile("Dividendes encaissés", fmtFCFA(t.dividends)),
        statTile("Résultat total", signedFCFA(result), pctClass(result), t.bought ? fmtPct(result / t.bought * 100) + " des montants investis" : null)
      ]));
      if (missing) box.appendChild(el("p", { class: "muted small" }, [missing + " ligne(s) sans cours disponible ce jour, exclue(s) de la valeur actuelle."]));
    }
    if (ledger.open.length) {
      var tableWrap = el("div", { class: "table-scroll" });
      tableWrap.appendChild(el("table", { class: "data-table" }, [
        el("thead", {}, [el("tr", {}, ["Symbole", "Nom", "Qté", "PRU", "Cours", "Valorisation", "+/- latente", "Poids", "Signal", ""].map(function (h) { return el("th", {}, [h]); }))]),
        el("tbody", {}, ledger.open.map(function (p) { return positionRow(p, totalVal); }))
      ]));
      box.appendChild(tableWrap);
    } else {
      box.appendChild(el("p", { class: "muted small" }, [ledger.rows.length
        ? "Aucune position ouverte à cette date."
        : "Enregistrez vos opérations (achats, ventes, dividendes) : positions, prix de revient et plus/moins-values sont calculés automatiquement."]));
    }
    if (!state.view.date) box.appendChild(renderTxForm());
    if (ledger.rows.length) box.appendChild(renderTxHistory(ledger));
    box.appendChild(el("div", { class: "add-form portfolio-io" }, [
      ledger.rows.length ? el("button", { class: "btn btn-secondary", onclick: exportTransactionsCsv }, ["Exporter les opérations (CSV)"]) : null,
      el("button", { class: "btn btn-secondary", onclick: backupUserData }, ["Sauvegarder mes données"]),
      el("label", { class: "btn btn-secondary", for: "restore-input" }, ["Restaurer une sauvegarde"]),
      (function () {
        var input = el("input", { type: "file", accept: ".json,application/json", id: "restore-input", class: "visually-hidden" });
        input.addEventListener("change", function () { if (input.files[0]) restoreUserData(input.files[0]); input.value = ""; });
        return input;
      })()
    ]));
    box.appendChild(el("p", { class: "muted small" }, [
      "Calcul au prix moyen pondéré, frais inclus ; montants avant impôts. Vos données restent dans ce navigateur : pensez à les sauvegarder."
    ]));
    return box;
  }

  function renderTxForm() {
    var f = state.ui.txForm || (state.ui.txForm = { type: "achat", symbole: "", date: todayIso(), quantite: "", prix: "", frais: "" });
    var meta = TX_TYPES[f.type];
    function bind(input, key) {
      input.value = f[key] || "";
      input.addEventListener("input", function () { f[key] = input.value; });
      return input;
    }
    var typeSel = el("select", { class: "input", "aria-label": "Type d'opération" }, Object.keys(TX_TYPES).map(function (k) { return el("option", { value: k }, [TX_TYPES[k].label]); }));
    typeSel.value = f.type;
    typeSel.addEventListener("change", function () { f.type = typeSel.value; render(); });
    var symbSel = el("select", { class: "input", "aria-label": "Valeur" }, [el("option", { value: "" }, ["Valeur…"])].concat(symbolOptions()));
    symbSel.value = f.symbole;
    symbSel.addEventListener("change", function () {
      f.symbole = symbSel.value;
      var s = findStock(f.symbole);
      if (s && f.type !== "dividende" && !f.prix) f.prix = String(s.cours_cloture);
      if (f.type === "dividende" && s) f.quantite = String(heldAt(f.symbole, f.date || todayIso()) || "");
      render();
    });
    var dateInput = bind(el("input", { class: "input", type: "date", max: todayIso(), "aria-label": "Date" }), "date");
    var qtyInput = bind(el("input", { class: "input", type: "number", min: "1", step: "1", placeholder: meta.qty, "aria-label": meta.qty }), "quantite");
    var priceInput = bind(el("input", { class: "input", type: "number", min: "0", step: "any", placeholder: meta.price, "aria-label": meta.price }), "prix");
    var feesInput = bind(el("input", { class: "input", type: "number", min: "0", step: "any", placeholder: "Frais (FCFA, optionnel)", "aria-label": "Frais" }), "frais");
    var form = el("form", {
      class: "tx-form", id: "tx-form",
      onsubmit: function (ev) {
        ev.preventDefault();
        var q = parseFloat(f.quantite), px = parseFloat(f.prix), fees = parseFloat(f.frais) || 0;
        var err = null;
        if (!f.symbole) err = "Choisissez une valeur.";
        else if (!f.date) err = "Indiquez la date.";
        else if (f.date > todayIso()) err = "La date ne peut pas être dans le futur.";
        else if (!(q > 0)) err = "Quantité invalide.";
        else if (!(px > 0)) err = "Prix invalide.";
        else if (fees < 0) err = "Frais invalides.";
        else if (f.type === "vente") {
          var held = heldAt(f.symbole, f.date);
          if (q > held + 1e-9) err = "Vous ne détenez que " + fmtNum(held, 0) + " " + f.symbole + " au " + f.date + ".";
        }
        state.ui.txError = err;
        if (err) { render(); return; }
        addTransaction({ type: f.type, symbole: f.symbole, date: f.date, quantite: q, prix: px, frais: fees });
        state.ui.txForm = { type: f.type, symbole: "", date: f.date, quantite: "", prix: "", frais: "" };
        render();
      }
    }, [
      el("div", { class: "muted small tx-title" }, ["Nouvelle opération"]),
      el("div", { class: "add-form" }, [typeSel, symbSel, dateInput]),
      el("div", { class: "add-form" }, [qtyInput, priceInput, feesInput, el("button", { class: "btn", type: "submit" }, ["Enregistrer"])]),
      state.ui.txError ? el("p", { class: "small concentration-warning" }, ["⚠ " + state.ui.txError]) : null
    ]);
    return form;
  }

  function renderTxHistory(ledger) {
    var open = !!state.ui.txOpen;
    var wrap = el("div", { class: "tx-history" }, [
      el("button", { class: "link-btn", onclick: function () { state.ui.txOpen = !open; render(); } },
        [(open ? "− Masquer" : "+ Afficher") + " l'historique des opérations (" + ledger.rows.length + ")"])
    ]);
    if (!open) return wrap;
    var rows = ledger.rows.slice().reverse();
    var tableWrap = el("div", { class: "table-scroll" });
    tableWrap.appendChild(el("table", { class: "data-table" }, [
      el("thead", {}, [el("tr", {}, ["Date", "Opération", "Valeur", "Qté", "Prix", "Frais", "Montant", "+/- réalisée", ""].map(function (h) { return el("th", {}, [h]); }))]),
      el("tbody", {}, rows.map(function (r) {
        var t = r.tx;
        return el("tr", { title: r.warning || "" }, [
          el("td", { class: "num" }, [t.date.split("-").reverse().join("/")]),
          el("td", {}, [el("span", { class: "badge tone-" + (t.type === "achat" ? "neutral" : t.type === "vente" ? "warning" : "good-soft") }, [TX_TYPES[t.type].label]), r.warning ? " ⚠" : null]),
          el("td", { class: "mono" }, [t.symbole]),
          el("td", { class: "num" }, [fmtNum(t.quantite, 0)]),
          el("td", { class: "num" }, [fmtNum(t.prix, t.prix % 1 ? 2 : 0)]),
          el("td", { class: "num muted" }, [t.frais ? fmtNum(t.frais, 0) : "—"]),
          el("td", { class: "num " + (t.type === "achat" ? "muted" : pctClass(r.montant)) }, [signedFCFA(r.montant)]),
          el("td", { class: "num " + pctClass(r.realized) }, [r.realized == null ? "" : signedFCFA(r.realized)]),
          el("td", {}, [el("button", { class: "icon-btn", title: "Supprimer l'opération", onclick: function () { removeTransaction(t); } }, ["✕"])])
        ]);
      }))
    ]));
    wrap.appendChild(tableWrap);
    return wrap;
  }

  function exportTransactionsCsv() {
    var ledger = computeLedger(null);
    var lines = [["Date", "Opération", "Symbole", "Quantité", "Prix unitaire", "Frais", "Montant net", "Plus/moins-value réalisée"].join(";")];
    ledger.rows.forEach(function (r) {
      var t = r.tx;
      lines.push([t.date, TX_TYPES[t.type].label, t.symbole, t.quantite, t.prix, t.frais || 0,
        r.montant != null ? Math.round(r.montant) : "", r.realized != null ? Math.round(r.realized) : ""].map(csvCell).join(";"));
    });
    downloadBlob("brvm-operations-" + todayIso() + ".csv", "text/csv;charset=utf-8", "﻿" + lines.join("\r\n"));
  }

  function backupUserData() {
    var data = { format: "brvm-conseil-sauvegarde", version: 1, exportedAt: new Date().toISOString(),
      riskProfile: state.user.riskProfile, transactions: state.user.transactions || [], watchlist: state.user.watchlist || [],
      recherches: readJsonStorage(RESEARCH_KEY, []), opportunites: readJsonStorage(OPPS_KEY, []) };
    downloadBlob("brvm-conseil-sauvegarde-" + todayIso() + ".json", "application/json", JSON.stringify(data, null, 1));
  }

  function restoreUserData(file) {
    file.text().then(function (txt) {
      var d = JSON.parse(txt);
      if (d.format !== "brvm-conseil-sauvegarde" || !Array.isArray(d.transactions)) throw new Error("Ce fichier n'est pas une sauvegarde BRVM Conseil.");
      if (!confirm("Remplacer vos opérations (" + (state.user.transactions || []).length + ") et votre liste de suivi par celles de la sauvegarde du " +
        String(d.exportedAt).slice(0, 10) + " (" + d.transactions.length + " opérations) ?")) return;
      state.user.transactions = d.transactions;
      state.user.watchlist = d.watchlist || [];
      if (d.riskProfile) state.user.riskProfile = d.riskProfile;
      if (Array.isArray(d.recherches)) writeJsonStorage(RESEARCH_KEY, d.recherches);
      if (Array.isArray(d.opportunites)) writeJsonStorage(OPPS_KEY, d.opportunites);
      syncPortfolio(); loadCachedAi(); render(); saveUserState();
    }).catch(function (e) { alert("Restauration impossible : " + e.message); });
  }

  // Vue de risque de concentration : indépendante des signaux par valeur,
  // elle regarde le portefeuille dans son ensemble — un portefeuille très
  // concentré sur un secteur ou un pays est un risque en soi, même si
  // chaque ligne prise isolément a un bon signal.
  var CONCENTRATION_WARN_PCT = 50;

  function concentrationBreakdown() {
    var portfolio = state.user.portfolio || [];
    var totalVal = 0;
    var bySecteur = {}, byPays = {};
    portfolio.forEach(function (pos) {
      var s = findStock(pos.symbole);
      var val = (s && s.cours_cloture != null) ? s.cours_cloture * pos.quantite : pos.prix_achat * pos.quantite;
      totalVal += val;
      var sect = s ? s.secteur : "Non classé";
      var pays = s ? s.pays : "Non spécifié";
      bySecteur[sect] = (bySecteur[sect] || 0) + val;
      byPays[pays] = (byPays[pays] || 0) + val;
    });
    function toSorted(obj) {
      return Object.keys(obj).map(function (k) {
        return { label: k, val: obj[k], pct: totalVal ? (obj[k] / totalVal) * 100 : 0 };
      }).sort(function (a, b) { return b.val - a.val; });
    }
    return { totalVal: totalVal, secteurs: toSorted(bySecteur), pays: toSorted(byPays) };
  }

  function concentrationBars(title, entries) {
    var wrap = el("div", { class: "concentration-group" }, [el("div", { class: "muted small concentration-title" }, [title])]);
    entries.slice(0, 6).forEach(function (e) {
      wrap.appendChild(el("div", { class: "concentration-row" }, [
        el("span", { class: "concentration-label" }, [e.label]),
        el("div", { class: "concentration-bar-track" }, [
          el("div", { class: "concentration-bar-fill" + (e.pct >= CONCENTRATION_WARN_PCT ? " over" : ""), style: "width:" + Math.min(e.pct, 100).toFixed(0) + "%" })
        ]),
        el("span", { class: "concentration-pct num" }, [fmtNum(e.pct, 0) + " %"])
      ]));
    });
    return wrap;
  }

  function renderConcentration() {
    var portfolio = state.user.portfolio || [];
    if (!portfolio.length) return null;
    var b = concentrationBreakdown();
    var box = el("section", { class: "panel" }, [el("h2", {}, ["Concentration du portefeuille"])]);
    var topSecteur = b.secteurs[0], topPays = b.pays[0];
    var overSecteur = topSecteur && topSecteur.pct >= CONCENTRATION_WARN_PCT;
    var overPays = topPays && topPays.pct >= CONCENTRATION_WARN_PCT;
    if (overSecteur || overPays) {
      var bits = [];
      if (overSecteur) bits.push(topSecteur.label + " (" + fmtNum(topSecteur.pct, 0) + " % du portefeuille)");
      if (overPays) bits.push(topPays.label + " (" + fmtNum(topPays.pct, 0) + " % du portefeuille)");
      box.appendChild(el("p", { class: "muted small concentration-warning" }, [
        "⚠ Portefeuille concentré sur " + bits.join(" et ") + ". Une forte concentration sectorielle ou géographique est un risque en soi, indépendant du signal de chaque valeur prise isolément."
      ]));
    } else {
      box.appendChild(el("p", { class: "muted small" }, ["Répartition actuelle, à titre indicatif — aucun seuil de concentration (" + CONCENTRATION_WARN_PCT + " %) n'est dépassé."]));
    }
    box.appendChild(concentrationBars("Par secteur", b.secteurs));
    box.appendChild(concentrationBars("Par pays", b.pays));
    return box;
  }

  function symbolOptions(selectedFirst) {
    var syms = (state.market.stocks || []).slice().sort(function (a, b) { return a.symbole < b.symbole ? -1 : 1; });
    return syms.map(function (s) { return el("option", { value: s.symbole }, [s.symbole + " — " + s.nom]); });
  }

  function renderWatchlist() {
    var box = el("section", { class: "panel" }, [el("h2", {}, ["Ma liste de suivi"])]);
    var watch = state.user.watchlist || [];
    if (watch.length) {
      var tableWrap = el("div", { class: "table-scroll" });
      var table = el("table", { class: "data-table" }, [
        el("thead", {}, [el("tr", {}, ["Symbole", "Nom", "Cours", "Variation", "Signal", ""].map(function (h) { return el("th", {}, [h]); }))]),
        el("tbody", {}, watch.map(function (symb) {
          var s = findStock(symb);
          var reco = s ? s.recommandations[state.user.riskProfile] : null;
          return el("tr", {}, [
            el("td", { class: "mono" }, [symb]),
            el("td", { class: "name-cell" }, [s ? s.nom : symb]),
            el("td", { class: "num" }, [s ? fmtFCFA(s.cours_cloture) : "—"]),
            el("td", { class: "num " + (s ? pctClass(s.variation_pct) : "") }, [s ? fmtPct(s.variation_pct) : "—"]),
            el("td", {}, [reco ? signalBadge(reco.signal) : "—"]),
            el("td", {}, [el("button", { class: "icon-btn", title: "Retirer", onclick: function () { removeWatch(symb); } }, ["✕"])])
          ]);
        }))
      ]);
      tableWrap.appendChild(table);
      box.appendChild(tableWrap);
    } else {
      box.appendChild(el("p", { class: "muted small" }, ["Aucune valeur suivie. Ajoutez des actions à surveiller sans forcément les détenir."]));
    }
    var symbSel = el("select", { class: "input" }, symbolOptions());
    box.appendChild(el("form", {
      class: "add-form",
      onsubmit: function (ev) { ev.preventDefault(); addWatch(symbSel.value); }
    }, [symbSel, el("button", { class: "btn", type: "submit" }, ["Ajouter à la liste"])]));
    return box;
  }

  function renderMarketTable() {
    var box = el("section", { class: "panel market-panel" }, [
      el("h2", {}, ["Marché — toutes les valeurs (" + (state.market.stocks || []).length + ")"]),
      el("p", { class: "muted small", style: "margin:-8px 0 14px" }, ["Colonne Signal calculée pour le profil " + labelForProfile(state.user.riskProfile).toLowerCase() + "."])
    ]);

    var secteurs = Array.from(new Set((state.market.stocks || []).map(function (s) { return s.secteur; }))).sort();
    var searchInput = el("input", { class: "input", type: "search", placeholder: "Rechercher (symbole ou nom)…", value: state.ui.search });
    searchInput.addEventListener("input", debounce(function () { state.ui.search = searchInput.value; render(); }, 200));
    var secteurSel = el("select", { class: "input" }, [el("option", { value: "TOUS" }, ["Tous secteurs"])].concat(
      secteurs.map(function (s) { return el("option", { value: s, selected: s === state.ui.secteur ? "selected" : null }, [s]); })
    ));
    secteurSel.value = state.ui.secteur;
    secteurSel.addEventListener("change", function () { state.ui.secteur = secteurSel.value; render(); });
    var signalSel = el("select", { class: "input" }, [el("option", { value: "TOUS" }, ["Tous signaux"])].concat(
      Object.keys(SIGNAL_META).map(function (s) { return el("option", { value: s }, [SIGNAL_META[s].label]); })
    ));
    signalSel.value = state.ui.signal;
    signalSel.addEventListener("change", function () { state.ui.signal = signalSel.value; render(); });

    box.appendChild(el("div", { class: "filters-row" }, [searchInput, secteurSel, signalSel]));

    var rows = (state.market.stocks || []).filter(function (s) {
      if (state.ui.secteur !== "TOUS" && s.secteur !== state.ui.secteur) return false;
      if (state.ui.signal !== "TOUS") {
        var reco = s.recommandations[state.user.riskProfile];
        if (!reco || reco.signal !== state.ui.signal) return false;
      }
      if (state.ui.search) {
        var q = state.ui.search.toLowerCase();
        if (s.symbole.toLowerCase().indexOf(q) === -1 && s.nom.toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });

    var sortKey = state.ui.sort, dir = state.ui.sortDir;
    rows = rows.slice().sort(function (a, b) {
      var av, bv;
      if (sortKey === "variation_pct") { av = a.variation_pct; bv = b.variation_pct; }
      else if (sortKey === "signal") {
        av = (SIGNAL_META[a.recommandations[state.user.riskProfile].signal] || {}).order || 0;
        bv = (SIGNAL_META[b.recommandations[state.user.riskProfile].signal] || {}).order || 0;
      } else if (sortKey === "cours") { av = a.cours_cloture; bv = b.cours_cloture; }
      else { av = a.symbole; bv = b.symbole; }
      if (av == null) av = -Infinity; if (bv == null) bv = -Infinity;
      if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0;
    });

    function th(label, key) {
      var active = state.ui.sort === key;
      return el("th", {
        class: "sortable" + (active ? " active" : ""),
        onclick: function () {
          if (state.ui.sort === key) state.ui.sortDir *= -1; else { state.ui.sort = key; state.ui.sortDir = key === "variation_pct" || key === "signal" ? -1 : 1; }
          render();
        }
      }, [label + (active ? (dir === 1 ? " ▴" : " ▾") : "")]);
    }

    var tableWrap = el("div", { class: "table-scroll" });
    var table = el("table", { class: "data-table market-table" }, [
      el("thead", {}, [el("tr", {}, [
        th("Symbole", "symbole"), el("th", { class: "col-secteur" }, ["Secteur"]), th("Cours (FCFA)", "cours"), th("Var. jour", "variation_pct"),
        el("th", { class: "col-tendance" }, ["Tendance"]), th("Signal", "signal"), el("th", {}, [""])
      ])]),
      el("tbody", {}, rows.reduce(function (acc, s) { return acc.concat(marketRow(s)); }, []))
    ]);
    tableWrap.appendChild(table);
    box.appendChild(tableWrap);
    if (!rows.length) box.appendChild(el("p", { class: "muted small" }, ["Aucune valeur ne correspond à ces filtres."]));
    return box;
  }

  function labelForProfile(key) {
    var p = PROFILES.filter(function (p) { return p.key === key; })[0];
    return p ? p.label : key;
  }

  function marketRow(s) {
    var reco = s.recommandations[state.user.riskProfile];
    var expanded = state.ui.expanded === s.symbole;
    var rows = [el("tr", { class: "row-main", onclick: function () { state.ui.expanded = expanded ? null : s.symbole; render(); } }, [
      el("td", { class: "mono" }, [s.symbole]),
      el("td", { class: "small col-secteur" }, [s.secteur]),
      el("td", { class: "num" }, [fmtNum(s.cours_cloture, 0)]),
      el("td", { class: "num " + pctClass(s.variation_pct) }, [fmtPct(s.variation_pct)]),
      el("td", { class: "col-tendance" }, [sparkline(state.market.history[s.symbole])]),
      el("td", {}, [
        signalBadge(reco.signal),
        s.indicateurs.liquidite_insuffisante ? el("span", { class: "badge tone-warning liquidity-flag", title: "Volume insuffisant pour faire confiance au signal" }, ["⚠ liquidité"]) : null
      ]),
      el("td", { class: "expand-caret" }, [expanded ? "−" : "+"])
    ])];
    if (expanded) {
      var ind = s.indicateurs;
      var align = ALIGNEMENT_META[ind.tendance_alignement] || ALIGNEMENT_META.indeterminee;
      rows.push(el("tr", { class: "row-detail" }, [el("td", { colspan: "7" }, [
        el("div", { class: "detail-grid" }, [
          el("div", {}, [el("b", {}, [s.nom]), el("div", { class: "muted small" }, [s.pays])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Ouverture / Clôture"]), el("div", {}, [fmtFCFA(s.cours_ouverture) + " → " + fmtFCFA(s.cours_cloture)])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Volume"]), el("div", {}, [fmtNum(s.volume, 0)])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Momentum court (5j)"]), el("div", {}, [ind.momentum_pct != null ? fmtPct(ind.momentum_pct) + " (" + ind.momentum_fenetre + "j)" : "—"])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Momentum moyen (30j)"]), el("div", {}, [ind.momentum_moyen_pct != null ? fmtPct(ind.momentum_moyen_pct) + " (" + ind.momentum_moyen_fenetre + "j)" : "—"])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Momentum long (90j)"]), el("div", {}, [ind.momentum_long_pct != null ? fmtPct(ind.momentum_long_pct) + " (" + ind.momentum_long_fenetre + "j)" : "—"])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Volatilité"]), el("div", {}, [ind.volatilite_pct != null ? fmtNum(ind.volatilite_pct, 1) + " %" : "—"])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Volume vs moyenne"]), el("div", {}, [ind.volume_ratio != null ? fmtNum(ind.volume_ratio, 2) + "x" : "—"])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Force relative vs BRVM Composite"]), el("div", {}, [ind.force_relative_pct != null ? fmtPct(ind.force_relative_pct) : "n/d"])])
        ]),
        ind.facteurs ? renderFactors(ind.facteurs, reco) : null,
        renderLinkedDocs(s.symbole),
        el("div", { class: "alignment-row" }, [
          el("span", { class: "badge tone-" + align.tone }, [align.label]),
          el("span", { class: "muted small" }, [" " + align.detail])
        ]),
        ind.liquidite_insuffisante ? el("p", { class: "muted small liquidity-note" }, ["⚠ Volume d'échange trop faible aujourd'hui pour faire confiance au signal technique : il est forcé à Surveiller, quel que soit le profil."]) : null,
        el("div", { class: "intraday-block" }, [
          el("div", { class: "muted small", style: "margin:10px 0 4px" }, ["Évolution intrajournalière (aujourd'hui)"]),
          intradaySparkline((state.market.intraday || {})[s.symbole], state.market.asOfDate)
        ]),
        el("div", { class: "reco-all" }, PROFILES.map(function (p) {
          var r = s.recommandations[p.key];
          return el("div", { class: "reco-line" }, [el("b", {}, [p.label + " : "]), signalBadge(r.signal), el("span", { class: "muted small" }, [" " + r.raison])]);
        }))
      ])]));
    }
    return rows;
  }

  // ------------------------------------------------------------ archives
  // Chaque séance est conservée dans archives/AAAA-MM-JJ.json (écrit par
  // update_daily.py) ; la liste des séances est embarquée dans la page. Les
  // archives sont chargées à la demande via fetch(), ce qui suppose que la
  // page soit servie en http(s) (GitHub Pages, Netlify, python3 -m
  // http.server...) — en ouverture directe du fichier (file://) le
  // navigateur bloque ces requêtes.
  function fetchArchive(date) {
    if (state.archiveCache[date]) return Promise.resolve(state.archiveCache[date]);
    return fetch("archives/" + date + ".json", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      state.archiveCache[date] = data;
      return data;
    });
  }

  function archiveFetchErrorMessage(err) {
    if (location.protocol === "file:") {
      return "Les archives ne peuvent pas être chargées quand la page est ouverte directement depuis le disque (file://). " +
        "Ouvre-la via ton site GitHub Pages, ou lance « python3 -m http.server » dans le dossier du projet puis va sur http://localhost:8000.";
    }
    return "Archive indisponible (" + (err && err.message ? err.message : "erreur réseau") + ").";
  }

  function marketForArchive(archive) {
    // L'archive ne recopie pas l'historique : on le reprend de la séance du
    // jour en le tronquant à la date consultée, pour que les mini-courbes
    // reflètent ce qui était connu à cette date.
    var history = {};
    var liveHistory = state.live.history || {};
    Object.keys(liveHistory).forEach(function (k) {
      history[k] = liveHistory[k].filter(function (p) { return p.date === "veille" || p.date <= archive.asOfDate; });
    });
    var m = {};
    Object.keys(archive).forEach(function (k) { m[k] = archive[k]; });
    m.history = history;
    m.intraday = archive.intraday || {};
    return m;
  }

  function openArchive(date) {
    if (!date || date === state.live.asOfDate) { closeArchive(); return; }
    state.view.loading = date;
    state.view.error = null;
    render();
    fetchArchive(date).then(function (archive) {
      state.view = { date: date, loading: null, error: null };
      state.market = marketForArchive(archive);
      syncPortfolio();
      state.ui.expanded = null;
      loadCachedAi();
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }).catch(function (err) {
      state.view.loading = null;
      state.view.error = archiveFetchErrorMessage(err);
      render();
    });
  }

  function closeArchive() {
    state.view = { date: null, loading: null, error: null };
    state.market = state.live;
    syncPortfolio();
    state.ui.expanded = null;
    loadCachedAi();
    render();
  }

  function renderArchiveBanner() {
    return el("div", { class: "archive-banner" }, [
      el("span", {}, [
        "Vous consultez la séance archivée du ", el("b", {}, [state.market.asOfLabel || state.view.date]),
        ". Cours, signaux et valorisation du portefeuille sont ceux de cette date."
      ]),
      el("button", { class: "btn", onclick: closeArchive }, ["Revenir à la séance du jour"])
    ]);
  }

  function renderArchives() {
    var box = el("section", { class: "panel" }, [el("h2", {}, ["Archives des séances"])]);
    var entries = state.archiveIndex || [];
    if (!entries.length) {
      box.appendChild(el("p", { class: "muted small" }, ["Aucune séance archivée pour l'instant. Chaque séance traitée sera conservée dans le dossier archives/ du dépôt."]));
    } else {
      box.appendChild(el("p", { class: "muted small", style: "margin:-6px 0 10px" }, [
        entries.length + " séance(s) conservée(s). Cliquez sur une date pour la consulter."
      ]));
      var shown = entries.slice(0, state.ui.archivesShown);
      var tableWrap = el("div", { class: "table-scroll" });
      tableWrap.appendChild(el("table", { class: "data-table archive-table" }, [
        el("thead", {}, [el("tr", {}, ["Séance", "Hausses / baisses", "Composite"].map(function (h) { return el("th", {}, [h]); }))]),
        el("tbody", {}, shown.map(function (e) {
          var isLive = e.date === state.live.asOfDate;
          var current = (state.view.date || state.live.asOfDate) === e.date;
          return el("tr", { class: "row-main" + (current ? " current" : ""), onclick: function () { openArchive(e.date); } }, [
            el("td", {}, [
              e.date.split("-").reverse().join("/"),
              isLive ? el("span", { class: "muted small" }, [" (jour)"]) : null,
              state.view.loading === e.date ? el("span", { class: "muted small" }, [" chargement…"]) : null
            ]),
            el("td", { class: "num" }, [
              el("span", { class: "up" }, [String(e.hausses != null ? e.hausses : "—")]), " / ",
              el("span", { class: "down" }, [String(e.baisses != null ? e.baisses : "—")])
            ]),
            el("td", { class: "num " + pctClass(e.composite) }, [fmtPct(e.composite)])
          ]);
        }))
      ]));
      box.appendChild(tableWrap);
      if (entries.length > shown.length) {
        box.appendChild(el("button", { class: "link-btn", style: "margin-top:10px", onclick: function () { state.ui.archivesShown += 20; render(); } },
          ["Afficher plus de séances (" + (entries.length - shown.length) + " restantes)"]));
      }
    }
    if (state.view.error) box.appendChild(el("p", { class: "small concentration-warning" }, [state.view.error]));
    box.appendChild(el("div", { class: "add-form" }, [
      el("button", { class: "btn btn-secondary", onclick: downloadCsv }, ["Télécharger la séance (CSV)"]),
      el("button", { class: "btn btn-secondary", onclick: downloadJson }, ["Télécharger (JSON)"])
    ]));
    box.appendChild(el("p", { class: "muted small" }, ["Le téléchargement porte sur la séance affichée (" + (state.market.asOfLabel || "—") + ")."]));
    return box;
  }

  function downloadBlob(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function csvCell(v) {
    if (v == null) return "";
    if (typeof v === "number") return String(v).replace(".", ",");
    var s = String(v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // CSV au format « Excel français » : séparateur point-virgule, virgule
  // décimale, BOM UTF-8 pour que les accents s'affichent correctement.
  function downloadCsv() {
    var m = state.market;
    var cols = ["Date", "Symbole", "Nom", "Secteur", "Pays", "Cours veille", "Ouverture", "Clôture", "Volume", "Variation %",
      "Momentum 5j %", "Momentum 30j %", "Momentum 90j %", "Volatilité %", "Volume / moyenne", "Force relative %",
      "Tendance multi-horizon", "Liquidité insuffisante", "Signal prudent", "Signal équilibré", "Signal dynamique"];
    var lines = [cols.join(";")];
    (m.stocks || []).forEach(function (s) {
      var ind = s.indicateurs || {}, r = s.recommandations || {};
      lines.push([m.asOfDate, s.symbole, s.nom, s.secteur, s.pays, s.cours_veille, s.cours_ouverture, s.cours_cloture, s.volume, s.variation_pct,
        ind.momentum_pct, ind.momentum_moyen_pct, ind.momentum_long_pct, ind.volatilite_pct, ind.volume_ratio, ind.force_relative_pct,
        (ALIGNEMENT_META[ind.tendance_alignement] || {}).label, ind.liquidite_insuffisante ? "oui" : "non",
        (r.prudent || {}).signal, (r.equilibre || {}).signal, (r.dynamique || {}).signal].map(csvCell).join(";"));
    });
    downloadBlob("brvm-seance-" + m.asOfDate + ".csv", "text/csv;charset=utf-8", "﻿" + lines.join("\r\n"));
  }

  function downloadJson() {
    var m = state.market, out = {};
    Object.keys(m).forEach(function (k) { if (k !== "history") out[k] = m[k]; });
    downloadBlob("brvm-seance-" + m.asOfDate + ".json", "application/json", JSON.stringify(out, null, 1));
  }

  // ---------------------------------------------------------- analyse IA
  // Appel direct à l'API Claude depuis le navigateur, avec la clé API de
  // l'utilisateur (stockée uniquement dans le localStorage de son
  // navigateur, envoyée uniquement à api.anthropic.com). Le site restant
  // 100 % statique, il n'y a aucun serveur intermédiaire.
  var AI_SETTINGS_KEY = "brvm-conseil-ai-settings-v1";
  var AI_CACHE_KEY = "brvm-conseil-ai-cache-v1";
  var AI_CACHE_MAX = 40;
  var AI_MODELS = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5 — analyse la plus fine (≈ 0,15 $ / analyse)", fallbacks: true },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — bon compromis (≈ 0,07 $ / analyse)", fallbacks: true },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 — rapide et économique (< 0,01 $ / analyse)", fallbacks: false }
  ];

  function readJsonStorage(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function writeJsonStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* stockage indisponible */ }
  }
  function aiSettings() {
    var s = readJsonStorage(AI_SETTINGS_KEY, {});
    return { apiKey: s.apiKey || "", model: s.model || AI_MODELS[0].id, includePortfolio: s.includePortfolio !== false };
  }
  function saveAiSettings(patch) {
    var s = aiSettings();
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    writeJsonStorage(AI_SETTINGS_KEY, s);
  }
  function aiCacheKey() { return state.market.asOfDate + "|" + state.user.riskProfile; }

  function loadCachedAi() {
    if (state.ai.running) return;
    state.ai.tab = null;
    var hit = readJsonStorage(AI_CACHE_KEY, {})[aiCacheKey()];
    state.ai.text = hit ? hit.text : "";
    state.ai.meta = hit ? hit.meta : null;
    state.ai.error = null;
    state.ai.status = "";
  }
  function storeCachedAi(text, meta) {
    var cache = readJsonStorage(AI_CACHE_KEY, {});
    cache[aiCacheKey()] = { text: text, meta: meta };
    var keys = Object.keys(cache).sort(function (a, b) { return (cache[b].meta.at || "").localeCompare(cache[a].meta.at || ""); });
    keys.slice(AI_CACHE_MAX).forEach(function (k) { delete cache[k]; });
    writeJsonStorage(AI_CACHE_KEY, cache);
  }

  function numOrDash(x, d) { return x == null || isNaN(x) ? "—" : Number(x).toFixed(d == null ? 2 : d); }

  // Le dossier de la séance (contexte de marché + consignes) est construit
  // côté serveur par ai_analysis.py et embarqué dans la page / l'archive :
  // l'analyse personnalisée y ajoute seulement le profil et le portefeuille.
  function buildPersonalSection() {
    var profile = state.user.riskProfile;
    var cur = PROFILES.filter(function (p) { return p.key === profile; })[0];
    var out = ["", "## Investisseur", "Profil de risque : " + labelForProfile(profile) + (cur ? " — " + cur.desc : "")];
    var settings = aiSettings();
    var portfolio = state.user.portfolio || [], watch = state.user.watchlist || [];
    if (!settings.includePortfolio) {
      out.push("L'investisseur n'a pas souhaité partager son portefeuille : omets la section portefeuille mais adapte l'analyse à son profil.");
      return out.join("\n");
    }
    if (portfolio.length) {
      var b = concentrationBreakdown();
      out.push("", "### Portefeuille (symbole | quantité | PRU FCFA | date d'achat | cours FCFA | plus/moins-value % | poids % | signal du profil)");
      portfolio.forEach(function (pos) {
        var st = findStock(pos.symbole);
        var cours = st ? st.cours_cloture : null;
        var val = cours != null ? cours * pos.quantite : pos.prix_achat * pos.quantite;
        var pnlPct = cours != null && pos.prix_achat ? (cours / pos.prix_achat - 1) * 100 : null;
        out.push([pos.symbole, pos.quantite, pos.prix_achat, pos.date_achat || "—", numOrDash(cours, 0), numOrDash(pnlPct),
          numOrDash(b.totalVal ? val / b.totalVal * 100 : null, 1), st ? st.recommandations[profile].signal : "—"].join(" | "));
      });
      out.push("Valeur totale : " + Math.round(b.totalVal) + " FCFA.");
      out.push("Répartition sectorielle : " + b.secteurs.map(function (e) { return e.label + " " + e.pct.toFixed(0) + " %"; }).join(", ") + ".");
      out.push("Répartition par pays : " + b.pays.map(function (e) { return e.label + " " + e.pct.toFixed(0) + " %"; }).join(", ") + ".");
    }
    var ledger = state.ledger;
    if (ledger && ledger.rows.length) {
      out.push("Plus/moins-values réalisées : " + Math.round(ledger.totals.realized) + " FCFA ; dividendes encaissés : " + Math.round(ledger.totals.dividends) + " FCFA.");
      out.push("", "### Dernières opérations (date | type | valeur | quantité | prix)");
      ledger.rows.slice(-10).forEach(function (r) { out.push([r.tx.date, r.tx.type, r.tx.symbole, r.tx.quantite, r.tx.prix].join(" | ")); });
    }
    if (watch.length) out.push("", "### Liste de suivi : " + watch.join(", "));
    if (!portfolio.length && !watch.length) out.push("Ni portefeuille ni liste de suivi renseignés : omets cette section mais adapte l'analyse au profil.");
    return out.join("\n");
  }

  function runAiAnalysis() {
    var settings = aiSettings();
    if (!settings.apiKey) { state.ai.settingsOpen = true; render(); return; }
    var ctx = state.market.contexteIA;
    if (!ctx || !ctx.marche) {
      state.ai.error = "Le dossier d'analyse n'est pas disponible pour cette séance.";
      render();
      return;
    }
    var forKey = aiCacheKey();
    state.ai = { running: true, text: "", status: "L'IA analyse la séance…", error: null, meta: null, settingsOpen: false, tab: "perso" };
    render();

    var content = ctx.marche + "\n" + buildPersonalSection() + buildDocumentsSection() +
      "\n\nRédige l'analyse de cette séance pour cet investisseur.";
    callClaude({
      system: ctx.systeme,
      content: content,
      effort: "high",
      onText: function (t) {
        state.ai.text += t;
        setAiStatus("Rédaction en cours…");
        scheduleAiOutputUpdate();
      }
    }).then(function (res) {
      if (res.stopReason === "max_tokens") state.ai.text += "\n\n*(Analyse tronquée : limite de longueur atteinte.)*";
      var meta = { model: res.model, at: new Date().toISOString(), date: state.market.asOfDate, profile: state.user.riskProfile, documents: includedDocuments().length };
      if (aiCacheKey() === forKey) {
        storeCachedAi(state.ai.text, meta);
        state.ai.meta = meta;
      }
      state.ai.running = false;
      state.ai.status = "";
      render();
    }).catch(function (err) {
      state.ai.running = false;
      state.ai.status = "";
      state.ai.error = err && err.message ? err.message : String(err);
      render();
    });
  }

  // Appel à l'API Claude en streaming depuis le navigateur, avec la clé et le
  // modèle choisis par l'utilisateur. content : texte ou liste de blocs
  // (document PDF, image, texte). format : schéma JSON optionnel (sortie
  // structurée). Résout { text, stopReason, model }.
  function callClaude(opts) {
    var settings = aiSettings();
    if (!settings.apiKey) return Promise.reject(new Error("Configurez d'abord votre clé API (panneau Analyse IA)."));
    var model = AI_MODELS.filter(function (x) { return x.id === settings.model; })[0] || AI_MODELS[0];
    var body = {
      model: model.id,
      max_tokens: opts.maxTokens || 16000,
      stream: true,
      system: opts.system,
      output_config: { effort: opts.effort || "high" },
      messages: [{ role: "user", content: opts.content }]
    };
    if (opts.format) body.output_config.format = opts.format;
    var headers = {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
    if (model.fallbacks) {
      // En cas de refus par les filtres de sécurité, l'API relance
      // automatiquement la requête sur le modèle de repli recommandé.
      body.fallbacks = "default";
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    }
    var text = "", stopReason = null;
    return fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: headers, body: JSON.stringify(body) }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          var msg = "";
          try { msg = JSON.parse(t).error.message; } catch (e) { msg = t.slice(0, 200); }
          if (resp.status === 401) msg = "Clé API refusée (401). Vérifiez-la dans les paramètres.";
          else if (resp.status === 413) msg = "Document trop volumineux pour l'API (413). " + msg;
          else if (resp.status === 429) msg = "Limite de débit atteinte (429), réessayez dans un instant. " + msg;
          else if (resp.status === 529 || resp.status >= 500) msg = "Service momentanément surchargé (" + resp.status + "), réessayez dans un instant.";
          throw new Error(msg);
        });
      }
      return readSse(resp.body, function (ev) {
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          text += ev.delta.text;
          if (opts.onText) opts.onText(ev.delta.text);
        } else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) {
          stopReason = ev.delta.stop_reason;
        } else if (ev.type === "error") {
          throw new Error((ev.error && ev.error.message) || "Erreur pendant la génération.");
        }
      });
    }).then(function () {
      if (stopReason === "refusal") throw new Error("Le modèle a refusé de traiter cette demande.");
      if (!text) throw new Error("Réponse vide.");
      return { text: text, stopReason: stopReason, model: model.id };
    }, function (err) {
      if (err instanceof TypeError) throw new Error("Impossible de joindre l'API Claude (réseau ou blocage du navigateur). " + err.message);
      throw err;
    });
  }

  // Lecture d'un flux Server-Sent Events renvoyé par l'API (stream: true).
  function readSse(stream, onEvent) {
    var reader = stream.getReader(), decoder = new TextDecoder(), buffer = "";
    function handle(chunk) {
      var data = chunk.split("\n").filter(function (l) { return l.indexOf("data:") === 0; })
        .map(function (l) { return l.slice(5).trim(); }).join("");
      if (!data) return;
      var ev;
      try { ev = JSON.parse(data); } catch (e) { return; }
      onEvent(ev);
    }
    function pump() {
      return reader.read().then(function (res) {
        if (res.done) { if (buffer.trim()) handle(buffer); return; }
        buffer += decoder.decode(res.value, { stream: true }).replace(/\r\n/g, "\n");
        var parts = buffer.split("\n\n");
        buffer = parts.pop();
        parts.forEach(handle);
        return pump();
      });
    }
    return pump();
  }

  var aiFramePending = false;
  function scheduleAiOutputUpdate() {
    if (aiFramePending) return;
    aiFramePending = true;
    requestAnimationFrame(function () {
      aiFramePending = false;
      var node = document.getElementById("ai-output");
      if (node) node.innerHTML = renderMarkdown(state.ai.text);
    });
  }
  function setAiStatus(text) {
    state.ai.status = text;
    var node = document.getElementById("ai-status");
    if (node) node.textContent = text;
  }

  // Rendu Markdown minimal et sûr : tout le texte est échappé AVANT
  // d'appliquer la mise en forme, aucun HTML venant du modèle n'est
  // interprété et les liens ne sont pas rendus cliquables.
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function inlineMd(s) {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  function renderMarkdown(md) {
    var lines = md.split("\n"), html = [], list = null, para = [], i = 0;
    function flushPara() { if (para.length) { html.push("<p>" + para.map(inlineMd).join("<br>") + "</p>"); para = []; } }
    function closeList() { if (list) { html.push("</" + list + ">"); list = null; } }
    while (i < lines.length) {
      var line = lines[i], t = line.trim(), mm;
      if (!t) { flushPara(); closeList(); i++; continue; }
      if ((mm = t.match(/^(#{1,4})\s+(.*)$/))) {
        flushPara(); closeList();
        var lvl = Math.min(mm[1].length + 1, 4);
        html.push("<h" + lvl + ">" + inlineMd(mm[2]) + "</h" + lvl + ">");
        i++; continue;
      }
      if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        flushPara(); closeList();
        var row = function (r) { return r.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
        var head = row(t);
        var rows = [];
        i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(row(lines[i])); i++; }
        html.push('<div class="table-scroll"><table class="data-table"><thead><tr>' + head.map(function (c) { return "<th>" + inlineMd(c) + "</th>"; }).join("") +
          "</tr></thead><tbody>" + rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inlineMd(c) + "</td>"; }).join("") + "</tr>"; }).join("") +
          "</tbody></table></div>");
        continue;
      }
      if ((mm = t.match(/^[-*•]\s+(.*)$/)) || (mm = t.match(/^\d+[.)]\s+(.*)$/))) {
        flushPara();
        var kind = /^\d/.test(t) ? "ol" : "ul";
        if (list !== kind) { closeList(); html.push("<" + kind + ">"); list = kind; }
        html.push("<li>" + inlineMd(mm[1]) + "</li>");
        i++; continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(t)) { flushPara(); closeList(); html.push("<hr>"); i++; continue; }
      closeList();
      para.push(t);
      i++;
    }
    flushPara(); closeList();
    return html.join("");
  }

  function renderAiSettings(settings) {
    var keyInput = el("input", { class: "input", type: "password", autocomplete: "off", placeholder: "Clé API Anthropic (sk-ant-…)", value: settings.apiKey });
    var modelSel = el("select", { class: "input" }, AI_MODELS.map(function (x) { return el("option", { value: x.id }, [x.label]); }));
    modelSel.value = settings.model;
    var form = el("form", {
      class: "ai-settings",
      onsubmit: function (ev) {
        ev.preventDefault();
        saveAiSettings({ apiKey: keyInput.value.trim(), model: modelSel.value });
        state.ai.settingsOpen = false;
        render();
        // Documents déposés avant la configuration de la clé : on les traite.
        (state.docs.list || []).filter(function (d) { return d.status === "a_analyser"; }).reduce(function (pr, d) {
          return pr.then(function () { return processDocument(d); });
        }, Promise.resolve());
      }
    }, [
      el("p", { class: "muted small" }, [
        "L'analyse IA utilise l'API Claude d'Anthropic avec votre propre clé (créée sur console.anthropic.com, facturée à l'usage). ",
        "La clé est enregistrée uniquement dans ce navigateur et n'est envoyée qu'à api.anthropic.com. ",
        "Sur un appareil partagé, utilisez « Oublier la clé » après usage."
      ]),
      el("div", { class: "add-form", style: "margin-top:6px" }, [keyInput, modelSel]),
      el("div", { class: "add-form", style: "margin-top:8px" }, [
        el("button", { class: "btn", type: "submit" }, ["Enregistrer"]),
        settings.apiKey ? el("button", { class: "btn btn-secondary", type: "button", onclick: function () {
          saveAiSettings({ apiKey: "" }); state.ai.settingsOpen = false; render();
        } }, ["Oublier la clé"]) : null,
        el("button", { class: "btn btn-secondary", type: "button", onclick: function () { state.ai.settingsOpen = false; render(); } }, ["Annuler"])
      ])
    ]);
    return form;
  }

  function aiModelLabel(id) {
    var m = AI_MODELS.filter(function (x) { return x.id === id || (id || "").indexOf(x.id) === 0; })[0];
    return m ? m.label.split(" — ")[0] : id;
  }

  function renderAiDaily(box) {
    var a = state.market.analyseIA;
    if (!a || !a.texte) {
      box.appendChild(el("p", { class: "muted small" }, [
        "Pas d'analyse automatique pour cette séance. Elle est rédigée chaque jour après la clôture lorsque le secret ANTHROPIC_API_KEY est configuré dans le dépôt GitHub (voir README). ",
        "Vous pouvez en attendant lancer une analyse personnalisée."
      ]));
      return;
    }
    box.appendChild(el("div", { class: "ai-output", html: renderMarkdown(a.texte) }));
    box.appendChild(el("div", { class: "ai-foot" }, [
      el("span", { class: "muted small" }, ["Rédigée automatiquement le " + new Date(a.genereLe).toLocaleString("fr-FR") + " par " + aiModelLabel(a.modele) + ", pour l'ensemble des profils. "]),
      el("button", { class: "link-btn small", onclick: function () {
        downloadBlob("analyse-ia-brvm-" + state.market.asOfDate + ".md", "text/markdown;charset=utf-8", "# Analyse IA — " + (state.market.asOfLabel || state.market.asOfDate) + "\n\n" + a.texte);
      } }, ["Télécharger (.md)"])
    ]));
  }

  function renderAiPersonal(box, settings) {
    var ai = state.ai;
    if (ai.settingsOpen || !settings.apiKey) {
      if (!ai.settingsOpen) {
        box.appendChild(el("p", { class: "muted small" }, [
          "Analyse rédigée pour votre profil de risque et votre portefeuille : impact de la séance sur vos lignes, concentration, valeurs de votre liste de suivi."
        ]));
      }
      box.appendChild(renderAiSettings(settings));
      if (!ai.text) return;
    }
    if (settings.apiKey) {
      var portfolioToggle = el("input", { type: "checkbox", id: "ai-include-portfolio" });
      portfolioToggle.checked = settings.includePortfolio;
      portfolioToggle.addEventListener("change", function () { saveAiSettings({ includePortfolio: portfolioToggle.checked }); });
      box.appendChild(el("div", { class: "ai-actions" }, [
        el("button", { class: "btn", disabled: ai.running ? "disabled" : null, onclick: runAiAnalysis }, [
          ai.running ? "Analyse en cours…" : (ai.text ? "Relancer l'analyse" : "✦ Analyser la séance pour moi")
        ]),
        el("label", { class: "small ai-check", for: "ai-include-portfolio" }, [portfolioToggle, " Inclure mon portefeuille et ma liste de suivi"])
      ]));
    }
    if (ai.running) box.appendChild(el("p", { class: "muted small ai-status", id: "ai-status" }, [ai.status]));
    if (ai.error) box.appendChild(el("p", { class: "small concentration-warning" }, ["⚠ " + ai.error]));
    if (ai.text) {
      box.appendChild(el("div", { class: "ai-output", id: "ai-output", html: renderMarkdown(ai.text) }));
      if (!ai.running && ai.meta) {
        box.appendChild(el("div", { class: "ai-foot" }, [
          el("span", { class: "muted small" }, [
            "Générée le " + new Date(ai.meta.at).toLocaleString("fr-FR") + " par " + aiModelLabel(ai.meta.model) + " (profil " + labelForProfile(ai.meta.profile).toLowerCase() +
            (ai.meta.documents ? ", " + ai.meta.documents + " document(s) pris en compte" : "") + "). "
          ]),
          el("button", { class: "link-btn small", onclick: function () {
            downloadBlob("analyse-ia-perso-brvm-" + ai.meta.date + ".md", "text/markdown;charset=utf-8", "# Analyse IA personnalisée — " + (state.market.asOfLabel || ai.meta.date) + "\n\n" + ai.text);
          } }, ["Télécharger (.md)"])
        ]));
      }
    } else if (!ai.running && !ai.error && settings.apiKey) {
      box.appendChild(el("p", { class: "muted small" }, [
        "Analyse de la séance du " + (state.market.asOfLabel || "jour") + " pour le profil " + labelForProfile(state.user.riskProfile).toLowerCase() +
        " : impact sur vos positions, signaux fragiles, points d'attention."
      ]));
    }
  }

  function renderAiPanel() {
    var settings = aiSettings();
    var hasDaily = !!(state.market.analyseIA && state.market.analyseIA.texte);
    var tab = state.ai.tab || (state.ai.text || !hasDaily ? "perso" : "jour");
    var box = el("section", { class: "panel ai-panel" }, [
      el("div", { class: "ai-head" }, [
        el("h2", {}, ["Analyse IA de la séance"]),
        tab === "perso" ? el("button", { class: "link-btn", onclick: function () { state.ai.settingsOpen = !state.ai.settingsOpen; render(); } },
          [settings.apiKey ? "Paramètres" : "Configurer"]) : null
      ]),
      el("div", { class: "profile-options ai-tabs", role: "tablist" }, [["jour", "Analyse du jour"], ["perso", "Mon analyse personnalisée"]].map(function (t) {
        return el("button", { class: "profile-btn" + (tab === t[0] ? " active" : ""), role: "tab", "aria-selected": tab === t[0] ? "true" : "false",
          onclick: function () { state.ai.tab = t[0]; render(); } }, [t[1]]);
      }))
    ]);
    if (tab === "jour") renderAiDaily(box); else renderAiPersonal(box, settings);
    if (hasDaily || state.ai.text) {
      box.appendChild(el("p", { class: "disclaimer" }, [
        "Analyse générée par une IA à partir des seules données de l'outil : elle peut contenir des erreurs et ne constitue pas un conseil en investissement."
      ]));
    }
    return box;
  }

  // --------------------------------------------------------- recherche IA
  // L'IA mène ses propres recherches sur le web (outils serveur web_search /
  // web_fetch de l'API Claude) : résultats publiés, dividendes, notes
  // d'analystes, presse financière... puis croise ce qu'elle trouve avec le
  // dossier quantitatif de la séance et les documents de l'utilisateur pour
  // retenir 2 valeurs. Chaque recherche est conservée avec le cours du jour
  // de la recommandation, pour suivre ensuite sa performance réelle.
  var RESEARCH_KEY = "brvm-conseil-research-v1";
  var RESEARCH_MAX_TURNS = 6;

  var RESEARCH_SYSTEM = [
    "Tu es un analyste actions senior spécialisé sur la BRVM (Bourse Régionale des Valeurs Mobilières de l'UEMOA, Abidjan). Ta mission : identifier les 2 actions cotées à la BRVM qui présentent aujourd'hui le meilleur potentiel sur un horizon de 1 à 3 mois, en croisant :",
    "1. tes propres recherches sur le web (outils web_search et web_fetch) ;",
    "2. le dossier quantitatif de la séance fourni (facteurs, signaux, fiabilité mesurée du modèle) ;",
    "3. les fiches de documents fournis par l'investisseur, s'il y en a.",
    "",
    "Méthode :",
    "- Recherche d'abord largement : publications de résultats récentes (annuels, semestriels, trimestriels), dividendes annoncés et dates de détachement, notes et recommandations d'analystes, de SGI et de courtiers, presse financière régionale et sites spécialisés sur la BRVM, actualité sectorielle et macroéconomique de l'UEMOA. Privilégie les sources des 3 derniers mois et relève la date de chacune. Multiplie les sources : la convergence de plusieurs analyses indépendantes compte plus qu'un avis isolé.",
    "- Dresse une présélection de 5 à 8 valeurs, puis compare-les sur : dynamique des résultats, valorisation (PER, rendement du dividende quand tu trouves les chiffres), catalyseurs datés à venir, consensus des recommandations trouvées (combien de sources favorables, neutres, défavorables), signal et facteurs du dossier quantitatif, liquidité (capitaux échangés : écarte les valeurs trop peu échangées pour être achetées ou revendues facilement), risques.",
    "- Retiens exactement 2 valeurs. Tiens compte du profil et du portefeuille de l'investisseur s'ils sont fournis (éviter d'alourdir une concentration existante).",
    "",
    "Règles :",
    "- N'invente jamais un chiffre, une date ou une source. Chaque chiffre fondamental doit provenir d'une source consultée, citée avec sa date.",
    "- Distingue clairement les faits, les opinions d'analystes et ta propre interprétation.",
    "- Si les informations trouvées sont rares, anciennes ou contradictoires, dis-le et abaisse la conviction : mieux vaut une conviction « faible » honnête qu'un choix artificiellement assuré.",
    "- Le dossier quantitatif est un classement RELATIF entre valeurs, pas une prévision de hausse.",
    "- Pas de promesse de gain : ce sont des pistes d'investissement argumentées, pas un conseil en investissement réglementé.",
    "",
    "Format de la réponse finale (Markdown, en français) :",
    "## Les 2 valeurs retenues",
    "Un paragraphe de synthèse.",
    "## 1. NOM (SYMBOLE)",
    "Thèse d'investissement ; résultats et valorisation (chiffres sourcés) ; catalyseurs à venir ; consensus des sources consultées ; lecture du dossier quantitatif ; risques ; conditions d'entrée et signal d'invalidation ; conviction (forte, moyenne ou faible).",
    "## 2. NOM (SYMBOLE)",
    "Même structure.",
    "## Valeurs étudiées mais écartées",
    "Tableau : valeur, raison principale.",
    "## Sources consultées",
    "Liste : titre, site, date.",
    "",
    "Termine OBLIGATOIREMENT par un bloc de code json (et rien après) :",
    "```json",
    "{\"winners\": [{\"symbole\": \"XXXX\", \"nom\": \"...\", \"conviction\": \"forte|moyenne|faible\", \"these\": \"une phrase\"}, {\"symbole\": \"YYYY\", \"nom\": \"...\", \"conviction\": \"...\", \"these\": \"...\"}]}",
    "```"
  ].join("\n");

  state.research = { running: false, status: "", queries: [], error: null, openId: null, startedAt: null };

  function researchHistory() { return readJsonStorage(RESEARCH_KEY, []); }

  // Appel non streamé : la réponse complète (blocs de recherche, résultats,
  // signatures) est nécessaire pour reprendre un tour mis en pause
  // (stop_reason « pause_turn ») en renvoyant le contenu tel quel.
  function callClaudeOnce(body, model) {
    var settings = aiSettings();
    var headers = {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
    if (model.fallbacks) {
      body.fallbacks = "default";
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    }
    return fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: headers, body: JSON.stringify(body) }).then(function (resp) {
      return resp.text().then(function (t) {
        var data = null;
        try { data = JSON.parse(t); } catch (e) { /* réponse non JSON */ }
        if (!resp.ok) {
          var msg = data && data.error ? data.error.message : t.slice(0, 200);
          if (resp.status === 401) msg = "Clé API refusée (401). Vérifiez-la dans les paramètres.";
          else if (resp.status === 429) msg = "Limite de débit atteinte (429), réessayez dans un instant. " + msg;
          else if (resp.status === 529 || resp.status >= 500) msg = "Service momentanément surchargé (" + resp.status + "), réessayez dans un instant.";
          else if (/web.?(search|fetch)/i.test(msg)) msg += " (la recherche web doit être autorisée pour votre organisation dans la console Anthropic : Settings → Privacy / Web search).";
          throw new Error(msg);
        }
        return data;
      });
    }, function (err) {
      throw new Error("Impossible de joindre l'API Claude (réseau ou blocage du navigateur). " + err.message);
    });
  }

  function researchTools(model) {
    var dynamic = model.id !== "claude-haiku-5-5";
    return [
      { type: dynamic ? "web_search_20260209" : "web_search_20250305", name: "web_search", max_uses: 15,
        user_location: { type: "approximate", country: "CI", city: "Abidjan", timezone: "Africa/Abidjan" } },
      { type: dynamic ? "web_fetch_20260209" : "web_fetch_20250910", name: "web_fetch", max_uses: 10 }
    ];
  }

  // Boucle de recherche web générique (recherche de valeurs, opportunités) :
  // rs = objet d'état affiché (running, status, queries, startedAt), idPrefix =
  // préfixe des éléments DOM de progression. Résout { blocks, model, stopReason }.
  function webResearch(rs, idPrefix, system, userContent) {
    var settings = aiSettings();
    var model = AI_MODELS.filter(function (x) { return x.id === settings.model; })[0] || AI_MODELS[0];
    var assistantBlocks = [], turns = 0;
    rs.running = true; rs.status = "L'IA lance ses recherches…"; rs.queries = []; rs.error = null; rs.startedAt = Date.now();
    render();
    var timer = setInterval(function () {
      var node = document.getElementById(idPrefix + "-elapsed");
      if (node) node.textContent = Math.round((Date.now() - rs.startedAt) / 1000) + " s";
    }, 1000);

    function step() {
      turns++;
      var messages = [{ role: "user", content: userContent }];
      if (assistantBlocks.length) messages.push({ role: "assistant", content: assistantBlocks });
      return callClaudeOnce({
        model: model.id, max_tokens: 16000, system: system,
        output_config: { effort: "high" }, tools: researchTools(model), messages: messages
      }, model).then(function (resp) {
        assistantBlocks = assistantBlocks.concat((resp.content || []).filter(function (b) { return b.type !== "fallback"; }));
        (resp.content || []).forEach(function (b) {
          if (b.type === "server_tool_use" && b.input) {
            rs.queries.push(b.name === "web_fetch" ? "Lecture : " + b.input.url : "Recherche : « " + b.input.query + " »");
          }
        });
        rs.status = "Tour " + turns + " : " + rs.queries.length + " recherche(s)/lecture(s), " + countSources(assistantBlocks) + " source(s) trouvée(s)…";
        render();
        if (resp.stop_reason === "pause_turn" && turns < RESEARCH_MAX_TURNS) return step();
        if (resp.stop_reason === "refusal") throw new Error("Le modèle a refusé de traiter cette demande.");
        return { blocks: assistantBlocks, model: resp.model || model.id, stopReason: resp.stop_reason };
      });
    }
    return step().then(function (res) { clearInterval(timer); rs.running = false; return res; },
      function (e) { clearInterval(timer); rs.running = false; rs.error = e && e.message ? e.message : String(e); render(); throw e; });
  }

  function runResearch() {
    var settings = aiSettings();
    if (!settings.apiKey) { state.ai.tab = "perso"; state.ai.settingsOpen = true; render(); return; }
    var ctx = state.live.contexteIA;
    if (!ctx || !ctx.marche) { state.research.error = "Le dossier de la séance n'est pas disponible."; render(); return; }
    var userContent = "Date du jour : " + todayIso() + ". Dernière séance disponible : " + state.live.asOfDate + ".\n\n" +
      ctx.marche + (settings.includePortfolio ? "\n" + buildPersonalSection() : "") + buildDocumentsSection() +
      "\n\nMène tes recherches puis présente les 2 valeurs retenues.";
    state.research.openId = null;
    webResearch(state.research, "research", RESEARCH_SYSTEM, userContent).then(function (res) {
      var record = buildResearchRecord(res.blocks, res.model, res.stopReason);
      var hist = researchHistory();
      hist.unshift(record);
      writeJsonStorage(RESEARCH_KEY, hist.slice(0, 50));
      state.research.openId = record.id;
      render();
    }, function () { /* erreur déjà affichée */ });
  }

  function countSources(blocks) {
    var urls = {};
    blocks.forEach(function (b) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach(function (r) { if (r.url) urls[r.url] = 1; });
      if (b.type === "web_fetch_tool_result" && b.content && b.content.url) urls[b.content.url] = 1;
    });
    return Object.keys(urls).length;
  }

  // Rapport final (blocs texte après le dernier outil), bloc JSON de fin
  // extrait et retiré du texte, sources web et requêtes effectuées.
  function extractReport(blocks, stopReason) {
    var lastTool = -1;
    blocks.forEach(function (b, i) { if (/_tool_result$/.test(b.type) || b.type === "server_tool_use") lastTool = i; });
    var text = blocks.slice(lastTool + 1).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("");
    if (!text.trim()) text = blocks.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("");
    var json = null;
    var m = text.match(/```json\s*([\s\S]*?)```\s*$/) || text.match(/```json\s*([\s\S]*?)```/);
    if (m) {
      try { json = JSON.parse(m[1]); } catch (e) { json = null; }
      text = text.replace(m[0], "").trim();
    }
    if (stopReason === "max_tokens") text += "\n\n*(Rapport tronqué : limite de longueur atteinte.)*";
    else if (stopReason === "pause_turn") text += "\n\n*(Recherche interrompue après " + RESEARCH_MAX_TURNS + " tours : rapport possiblement incomplet.)*";
    var sources = {};
    blocks.forEach(function (b) {
      if (b.type === "text" && Array.isArray(b.citations)) b.citations.forEach(function (c) { if (c.url) sources[c.url] = { url: c.url, title: c.title || c.url, cite: true }; });
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach(function (r) {
        if (r.url && !sources[r.url]) sources[r.url] = { url: r.url, title: r.title || r.url, age: r.page_age || null };
      });
    });
    return {
      text: text, json: json,
      sources: Object.keys(sources).map(function (k) { return sources[k]; }).sort(function (a, b) { return (b.cite ? 1 : 0) - (a.cite ? 1 : 0); }),
      queries: blocks.filter(function (b) { return b.type === "server_tool_use" && b.input; }).map(function (b) { return b.name === "web_fetch" ? b.input.url : b.input.query; })
    };
  }

  function buildResearchRecord(blocks, model, stopReason) {
    var rep = extractReport(blocks, stopReason);
    var winners = ((rep.json && rep.json.winners) || []).slice(0, 2).map(function (w) {
      var s = (state.live.stocks || []).filter(function (x) { return x.symbole === w.symbole; })[0];
      return { symbole: w.symbole, nom: w.nom || (s && s.nom) || w.symbole, conviction: w.conviction, these: w.these, prix: s ? s.cours_cloture : null };
    });
    return {
      id: Date.now().toString(36), at: new Date().toISOString(), asOfDate: state.live.asOfDate, model: model,
      text: rep.text, winners: winners, sources: rep.sources, queries: rep.queries
    };
  }

  function renderSourcesList(record) {
    if (!record.sources.length) return null;
    return el("details", { class: "research-sources small" }, [
      el("summary", {}, [record.sources.length + " source(s) web consultée(s) · " + record.queries.length + " recherche(s)"]),
      el("ul", {}, record.sources.slice(0, 60).map(function (s) {
        var safe = /^https?:\/\//i.test(s.url);
        return el("li", {}, [safe ? el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, [s.title]) : s.title,
          s.cite ? el("span", { class: "muted" }, [" · citée"]) : null, s.age ? el("span", { class: "muted" }, [" · " + s.age]) : null]);
      }))
    ]);
  }

  function renderResearchProgress(rs, idPrefix) {
    var wrap = el("div", {}, [el("p", { class: "muted small ai-status" }, [el("span", { id: idPrefix + "-status" }, [rs.status]), " · ", el("span", { id: idPrefix + "-elapsed" }, [Math.round((Date.now() - rs.startedAt) / 1000) + " s"])])]);
    if (rs.queries.length) wrap.appendChild(el("ul", { class: "research-queries small muted" }, rs.queries.slice(-8).map(function (q) { return el("li", {}, [q]); })));
    return wrap;
  }

  // Performance moyenne des valeurs de la cote entre deux séances, comme
  // point de comparaison pour les recommandations.
  function marketAvgPerf(fromDate) {
    var hist = state.live.history || {}, ratios = [];
    Object.keys(hist).forEach(function (k) {
      if (k.indexOf("_IDX_") === 0) return;
      var pts = hist[k], from = null, last = pts[pts.length - 1];
      for (var i = 0; i < pts.length; i++) if (pts[i].date === fromDate) { from = pts[i]; break; }
      if (from && last && from.cloture) ratios.push(last.cloture / from.cloture - 1);
    });
    return ratios.length ? ratios.reduce(function (a, b) { return a + b; }, 0) / ratios.length * 100 : null;
  }

  function winnerPerf(w) {
    var s = (state.live.stocks || []).filter(function (x) { return x.symbole === w.symbole; })[0];
    return s && w.prix ? { cours: s.cours_cloture, perf: (s.cours_cloture / w.prix - 1) * 100 } : { cours: s ? s.cours_cloture : null, perf: null };
  }

  var CONVICTION_TONE = { forte: "good", moyenne: "good-soft", faible: "warning" };

  function renderWinnerCard(w, record) {
    var p = winnerPerf(w);
    var inWatch = (state.user.watchlist || []).indexOf(w.symbole) !== -1;
    return el("div", { class: "winner-card" }, [
      el("div", { class: "winner-head" }, [
        el("span", { class: "mono winner-symb" }, [w.symbole]),
        el("span", { class: "winner-name" }, [w.nom]),
        w.conviction ? el("span", { class: "badge tone-" + (CONVICTION_TONE[w.conviction] || "neutral") }, ["Conviction " + w.conviction]) : null
      ]),
      w.these ? el("p", { class: "small winner-these" }, [w.these]) : null,
      el("div", { class: "small muted" }, [
        "Cours le " + record.asOfDate.split("-").reverse().join("/") + " : " + fmtFCFA(w.prix) +
        (record.asOfDate !== state.live.asOfDate ? " · aujourd'hui : " + fmtFCFA(p.cours) + " " : ""),
        record.asOfDate !== state.live.asOfDate && p.perf != null ? el("b", { class: pctClass(p.perf) }, ["(" + fmtPct(p.perf) + ")"]) : null
      ]),
      inWatch ? el("span", { class: "muted small" }, ["✓ Dans votre liste de suivi"]) :
        el("button", { class: "link-btn small", onclick: function () { addWatch(w.symbole); } }, ["+ Ajouter à ma liste de suivi"])
    ]);
  }

  function renderResearchReport(record) {
    var wrap = el("div", { class: "research-report" }, [
      el("div", { class: "winners" }, record.winners.map(function (w) { return renderWinnerCard(w, record); })),
      record.winners.length ? null : el("p", { class: "small concentration-warning" }, ["Les 2 valeurs n'ont pas pu être extraites automatiquement : voir le rapport ci-dessous."]),
      el("div", { class: "ai-output", html: renderMarkdown(record.text) })
    ]);
    wrap.appendChild(renderSourcesList(record) || el("span"));
    wrap.appendChild(el("div", { class: "ai-foot" }, [
      el("span", { class: "muted small" }, ["Recherche du " + new Date(record.at).toLocaleString("fr-FR") + " par " + aiModelLabel(record.model) + ". "]),
      el("button", { class: "link-btn small", onclick: function () {
        downloadBlob("recherche-ia-brvm-" + record.at.slice(0, 10) + ".md", "text/markdown;charset=utf-8",
          "# Recherche IA — " + new Date(record.at).toLocaleDateString("fr-FR") + "\n\n" + record.text + "\n\n## Liens\n" + record.sources.map(function (s) { return "- [" + s.title + "](" + s.url + ")"; }).join("\n"));
      } }, ["Télécharger (.md)"])
    ]));
    return wrap;
  }

  function renderResearchHistory(hist) {
    var rows = hist.filter(function (r) { return r.winners && r.winners.length; });
    if (!rows.length) return null;
    var wrap = el("div", { class: "research-history" }, [el("div", { class: "muted small tx-title" }, ["Suivi des recommandations passées (performance depuis la recommandation, comparée à la moyenne du marché)"])]);
    var tableWrap = el("div", { class: "table-scroll" });
    tableWrap.appendChild(el("table", { class: "data-table" }, [
      el("thead", {}, [el("tr", {}, ["Date", "Valeur", "Cours reco", "Cours actuel", "Perf.", "Marché", "Écart", ""].map(function (h) { return el("th", {}, [h]); }))]),
      el("tbody", {}, rows.reduce(function (acc, r) {
        var mkt = r.asOfDate === state.live.asOfDate ? 0 : marketAvgPerf(r.asOfDate);
        return acc.concat(r.winners.map(function (w, i) {
          var p = winnerPerf(w);
          var diff = p.perf != null && mkt != null ? p.perf - mkt : null;
          return el("tr", {}, [
            el("td", { class: "num" }, [i === 0 ? r.asOfDate.split("-").reverse().join("/") : ""]),
            el("td", { class: "mono" }, [w.symbole]),
            el("td", { class: "num" }, [fmtNum(w.prix, 0)]),
            el("td", { class: "num" }, [fmtNum(p.cours, 0)]),
            el("td", { class: "num " + pctClass(p.perf) }, [fmtPct(p.perf)]),
            el("td", { class: "num muted" }, [fmtPct(mkt)]),
            el("td", { class: "num " + pctClass(diff) }, [diff == null ? "—" : (diff >= 0 ? "+" : "") + fmtNum(diff, 2) + " pt"]),
            el("td", {}, [i === 0 ? el("button", { class: "link-btn small", onclick: function () { state.research.openId = r.id; render(); } }, ["Rapport"]) : null])
          ]);
        }));
      }, []))
    ]));
    wrap.appendChild(tableWrap);
    return wrap;
  }

  function renderResearchPanel() {
    var settings = aiSettings(), rs = state.research, hist = researchHistory();
    var box = el("section", { class: "panel research-panel" }, [
      el("div", { class: "ai-head" }, [el("h2", {}, ["Recherche IA : 2 valeurs à fort potentiel"])]),
      el("p", { class: "muted small", style: "margin-top:-4px" }, [
        "L'IA mène ses propres recherches sur le web (résultats publiés, dividendes, notes d'analystes et de SGI, presse spécialisée), les croise avec l'analyse quantitative du jour et vos documents, puis retient 2 valeurs en citant ses sources. ",
        "Durée : quelques minutes. Coût indicatif : 0,50 à 2 $ par recherche avec Opus."
      ])
    ]);
    if (state.view.date) {
      box.appendChild(el("p", { class: "muted small" }, ["La recherche porte sur l'actualité : revenez à la séance du jour pour la lancer."]));
    } else {
      box.appendChild(el("div", { class: "ai-actions" }, [
        el("button", { class: "btn", disabled: rs.running ? "disabled" : null, onclick: runResearch }, [
          rs.running ? "Recherche en cours…" : (settings.apiKey ? "🔎 Lancer la recherche" : "Configurer la clé API pour lancer la recherche")
        ]),
        settings.apiKey ? el("span", { class: "muted small" }, ["Profil, portefeuille et documents cochés sont pris en compte."]) : null
      ]));
    }
    if (rs.running) box.appendChild(renderResearchProgress(rs, "research"));
    if (rs.error) box.appendChild(el("p", { class: "small concentration-warning" }, ["⚠ " + rs.error]));
    var shown = hist.filter(function (r) { return r.id === rs.openId; })[0] || (!rs.running && hist[0]);
    if (shown && !rs.running) {
      if (shown !== hist[0]) box.appendChild(el("p", { class: "muted small" }, ["Rapport du " + new Date(shown.at).toLocaleDateString("fr-FR") + " ", el("button", { class: "link-btn small", onclick: function () { state.research.openId = hist[0].id; render(); } }, ["revenir au plus récent"])]));
      box.appendChild(renderResearchReport(shown));
    }
    var h = renderResearchHistory(hist);
    if (h) box.appendChild(h);
    if (shown) box.appendChild(el("p", { class: "disclaimer" }, ["Pistes d'investissement générées par une IA à partir de sources web et des données de l'outil : vérifiez les sources, elles peuvent contenir des erreurs. Ce n'est pas un conseil en investissement."]));
    return box;
  }

  // ------------------------------------------- opportunités hors actions
  // Onglet dédié aux autres placements du marché financier régional :
  // obligations cotées à la BRVM (cote du jour), et recherche IA sur le web
  // des opportunités en cours (emprunts obligataires en souscription,
  // introductions en bourse, sukuk, titres publics, OPCVM...).
  var OPPS_KEY = "brvm-conseil-opportunities-v1";

  var OPPS_SYSTEM = [
    "Tu es conseiller en placements spécialisé sur le marché financier régional de l'UMOA : BRVM (actions, obligations), marché des titres publics (UMOA-Titres), OPCVM agréés par l'AMF-UMOA. Ta mission : identifier, à date, les meilleures opportunités d'investissement HORS ACTIONS déjà cotées, accessibles à un investisseur particulier via une SGI ou une banque.",
    "",
    "Catégories à couvrir par tes recherches web (outils web_search et web_fetch) :",
    "1. Emprunts obligataires par appel public à l'épargne en cours de souscription ou annoncés (États, institutions régionales, entreprises) : taux, durée, différé, mode d'amortissement, période de souscription, montant minimum, garanties, notation éventuelle, SGI chef de file.",
    "2. Obligations déjà cotées à la BRVM : la cote du jour est fournie (taux facial, échéance, cours). Repère les lignes intéressantes, en rappelant que beaucoup sont amortissables (le cours peut refléter un nominal partiellement remboursé) et que le marché secondaire est peu liquide.",
    "3. Introductions en bourse, augmentations de capital et offres publiques en cours ou annoncées à la BRVM.",
    "4. Sukuk et obligations durables (vertes, sociales).",
    "5. Titres publics (bons et obligations assimilables du Trésor) et leurs taux récents d'adjudication, avec les conditions d'accès pour un particulier.",
    "6. OPCVM (FCP, SICAV) agréés de la zone, avec leurs performances publiées.",
    "",
    "Méthode :",
    "- Privilégie les sources officielles et récentes (BRVM, AMF-UMOA, UMOA-Titres, BCEAO, émetteurs, SGI, presse financière régionale) ; relève la date de chacune.",
    "- Vérifie que chaque offre est encore ouverte : écarte ou signale clairement les souscriptions closes.",
    "- Compare au rendement attendu des actions (dividendes) et à l'inflation de la zone si tu trouves des chiffres sourcés.",
    "- Adapte la sélection au profil de risque et au portefeuille de l'investisseur s'ils sont fournis (diversification, horizon).",
    "",
    "Règles :",
    "- N'invente jamais un taux, une date, un montant ou une source. Toute donnée chiffrée doit venir d'une source citée et datée.",
    "- Explique les risques propres à chaque placement : risque de l'émetteur (souverain, régional, privé, titrisation), liquidité (revente difficile avant l'échéance), remboursement anticipé, taux variable. La fiscalité des revenus varie selon le pays : invite à la vérifier.",
    "- Ce sont des pistes argumentées, pas un conseil en investissement réglementé.",
    "",
    "Format de la réponse finale (Markdown, en français) :",
    "## En bref",
    "## Opportunités du moment",
    "Pour chacune (6 maximum, de la plus intéressante à la moins intéressante pour cet investisseur) : description, rendement et conditions sourcés, date limite éventuelle, risques, comment souscrire.",
    "## Obligations cotées à regarder",
    "## Ce qu'il faut savoir avant d'investir",
    "## Sources consultées",
    "",
    "Termine OBLIGATOIREMENT par un bloc de code json (et rien après) :",
    "```json",
    "{\"opportunites\": [{\"categorie\": \"Emprunt obligataire en souscription|Obligation cotée|Introduction en bourse|Augmentation de capital|Sukuk|Titre public|OPCVM|Autre\", \"nom\": \"...\", \"emetteur\": \"...\", \"rendement\": \"ex. 6,95 % brut par an\", \"duree\": \"...\", \"date_limite\": \"AAAA-MM-JJ ou chaîne vide\", \"montant_minimum\": \"...\", \"risque\": \"faible|modéré|élevé\", \"liquidite\": \"...\", \"pourquoi\": \"une phrase\", \"source\": \"url\"}]}",
    "```"
  ].join("\n");

  state.opps = { running: false, status: "", queries: [], error: null, openId: null, startedAt: null };
  state.ui.bonds = { search: "", type: "TOUS", pays: "TOUS", echeance: "TOUTES", sort: "taux", dir: -1, shown: 40 };

  function oppsHistory() { return readJsonStorage(OPPS_KEY, []); }

  function bondsAsText() {
    var o = state.live.obligations;
    if (!o || !o.lignes || !o.lignes.length) return "(cote des obligations indisponible)";
    return ["## Cote des obligations BRVM en vie (code | libellé | type | pays | taux facial % | échéance | cours FCFA | dernier coupon)"].concat(o.lignes.map(function (b) {
      return [b.code, b.nom, b.type, b.pays || "—", b.taux_facial_pct != null ? b.taux_facial_pct : "variable", b.annee_echeance || "—", b.cours, (b.dernier_coupon_date || "—") + " " + (b.dernier_coupon_valeur != null ? b.dernier_coupon_valeur : "")].join(" | ");
    })).join("\n");
  }

  function runOpportunities() {
    var settings = aiSettings();
    if (!settings.apiKey) { state.ui.page = "actions"; state.ai.tab = "perso"; state.ai.settingsOpen = true; render(); return; }
    var s = state.live.stats || {};
    var userContent = "Date du jour : " + todayIso() + ". Dernière séance BRVM : " + state.live.asOfDate +
      " (" + s.hausses + " hausses, " + s.baisses + " baisses ; " + (state.live.syntheseDuJour || "") + ").\n\n" +
      bondsAsText() + "\n" + (settings.includePortfolio ? buildPersonalSection() : "\n## Investisseur\nProfil de risque : " + labelForProfile(state.user.riskProfile) + ".") +
      buildDocumentsSection() + "\n\nMène tes recherches puis présente les opportunités du moment hors actions.";
    state.opps.openId = null;
    webResearch(state.opps, "opps", OPPS_SYSTEM, userContent).then(function (res) {
      var rep = extractReport(res.blocks, res.stopReason);
      var record = {
        id: Date.now().toString(36), at: new Date().toISOString(), asOfDate: state.live.asOfDate, model: res.model,
        text: rep.text, items: ((rep.json && rep.json.opportunites) || []).slice(0, 6), sources: rep.sources, queries: rep.queries
      };
      var hist = oppsHistory();
      hist.unshift(record);
      writeJsonStorage(OPPS_KEY, hist.slice(0, 30));
      state.opps.openId = record.id;
      render();
    }, function () { /* erreur déjà affichée */ });
  }

  var RISK_TONE = { faible: "good", "modéré": "warning", modere: "warning", "élevé": "critical", eleve: "critical" };

  function renderOppCard(o) {
    var expired = o.date_limite && /^\d{4}-\d{2}-\d{2}$/.test(o.date_limite) && o.date_limite < todayIso();
    var safe = o.source && /^https?:\/\//i.test(o.source);
    return el("div", { class: "winner-card opp-card" + (expired ? " doc-off" : "") }, [
      el("div", { class: "winner-head" }, [
        el("span", { class: "badge tone-neutral" }, [o.categorie || "Opportunité"]),
        o.risque ? el("span", { class: "badge tone-" + (RISK_TONE[o.risque] || "neutral") }, ["Risque " + o.risque]) : null
      ]),
      el("div", { class: "winner-name" }, [o.nom || "—"]),
      o.emetteur ? el("div", { class: "small muted" }, [o.emetteur]) : null,
      el("div", { class: "opp-facts small" }, [
        o.rendement ? el("span", {}, [el("b", {}, [o.rendement])]) : null,
        o.duree ? el("span", {}, ["Durée : " + o.duree]) : null,
        o.montant_minimum ? el("span", {}, ["Minimum : " + o.montant_minimum]) : null,
        o.date_limite ? el("span", { class: expired ? "down" : "" }, [(expired ? "Clôturée le " : "Jusqu'au ") + o.date_limite.split("-").reverse().join("/")]) : null
      ]),
      o.pourquoi ? el("p", { class: "small winner-these" }, [o.pourquoi]) : null,
      o.liquidite ? el("div", { class: "small muted" }, ["Liquidité : " + o.liquidite]) : null,
      safe ? el("a", { class: "small", href: o.source, target: "_blank", rel: "noopener noreferrer" }, ["Source"]) : null
    ]);
  }

  function renderOppsResearch() {
    var settings = aiSettings(), rs = state.opps, hist = oppsHistory();
    var box = el("section", { class: "panel research-panel" }, [
      el("div", { class: "ai-head" }, [el("h2", {}, ["Recherche IA : opportunités hors actions"])]),
      el("p", { class: "muted small", style: "margin-top:-4px" }, [
        "L'IA recherche sur le web les placements du moment : emprunts obligataires en souscription, obligations cotées, introductions en bourse et augmentations de capital, sukuk, titres publics, OPCVM. Elle les compare en tenant compte de votre profil et de votre portefeuille, et cite ses sources. ",
        "Durée : quelques minutes. Coût indicatif : 0,50 à 2 $ par recherche avec Opus."
      ]),
      el("div", { class: "ai-actions" }, [
        el("button", { class: "btn", disabled: rs.running ? "disabled" : null, onclick: runOpportunities }, [
          rs.running ? "Recherche en cours…" : (settings.apiKey ? "🔎 Rechercher les opportunités" : "Configurer la clé API pour lancer la recherche")
        ])
      ])
    ]);
    if (rs.running) box.appendChild(renderResearchProgress(rs, "opps"));
    if (rs.error) box.appendChild(el("p", { class: "small concentration-warning" }, ["⚠ " + rs.error]));
    var shown = hist.filter(function (r) { return r.id === rs.openId; })[0] || (!rs.running && hist[0]);
    if (shown && !rs.running) {
      if (shown.items.length) box.appendChild(el("div", { class: "winners" }, shown.items.map(renderOppCard)));
      box.appendChild(el("div", { class: "ai-output", html: renderMarkdown(shown.text) }));
      box.appendChild(renderSourcesList(shown) || el("span"));
      box.appendChild(el("div", { class: "ai-foot" }, [
        el("span", { class: "muted small" }, ["Recherche du " + new Date(shown.at).toLocaleString("fr-FR") + " par " + aiModelLabel(shown.model) + ". "]),
        el("button", { class: "link-btn small", onclick: function () {
          downloadBlob("opportunites-brvm-" + shown.at.slice(0, 10) + ".md", "text/markdown;charset=utf-8",
            "# Opportunités hors actions — " + new Date(shown.at).toLocaleDateString("fr-FR") + "\n\n" + shown.text + "\n\n## Liens\n" + shown.sources.map(function (s) { return "- [" + s.title + "](" + s.url + ")"; }).join("\n"));
        } }, ["Télécharger (.md)"])
      ]));
    }
    if (hist.length > 1) {
      box.appendChild(el("div", { class: "research-history" }, [el("div", { class: "muted small tx-title" }, ["Recherches précédentes"])].concat(
        hist.slice(0, 10).map(function (r) {
          return el("button", { class: "link-btn small opp-hist", onclick: function () { state.opps.openId = r.id; render(); } },
            [new Date(r.at).toLocaleDateString("fr-FR") + " — " + r.items.length + " opportunité(s)" + (shown && r.id === shown.id ? " (affichée)" : "")]);
        }))));
    }
    if (shown) box.appendChild(el("p", { class: "disclaimer" }, ["Informations collectées par une IA sur le web : vérifiez les conditions auprès de l'émetteur ou de votre SGI avant toute souscription (dates, taux, fiscalité). Ce n'est pas un conseil en investissement."]));
    return box;
  }

  function renderBonds() {
    // Les séances archivées avant l'ajout des obligations n'en ont pas : on
    // affiche alors la cote du jour, en le précisant.
    var src = state.market.obligations ? state.market : state.live;
    var o = src.obligations;
    var f = state.ui.bonds;
    var box = el("section", { class: "panel market-panel" }, [el("h2", {}, ["Obligations cotées à la BRVM" + (o ? " (" + o.lignes.length + " en vie)" : "")])]);
    if (!o || !o.lignes.length) {
      box.appendChild(el("p", { class: "muted small" }, ["La cote des obligations sera disponible après la prochaine mise à jour."]));
      return box;
    }
    box.appendChild(el("p", { class: "muted small", style: "margin:-8px 0 12px" }, [
      "Cote du " + (src.asOfLabel || "") + (src !== state.market ? " (pas de cote archivée pour la séance consultée)" : "") + ". Le taux affiché est le taux facial (coupon annuel en % du nominal). ",
      "Beaucoup d'obligations sont amortissables : un cours inférieur à 10 000 FCFA reflète souvent un nominal déjà partiellement remboursé, pas une décote. ",
      "Le rendement réel dépend du tableau d'amortissement (voir la note d'information) ; le marché secondaire est peu liquide."
    ]));
    var types = Array.from(new Set(o.lignes.map(function (b) { return b.type; }))).sort();
    var pays = Array.from(new Set(o.lignes.map(function (b) { return b.pays; }).filter(Boolean))).sort();
    var search = el("input", { class: "input", type: "search", placeholder: "Rechercher (code, émetteur)…", value: f.search });
    search.addEventListener("input", debounce(function () { f.search = search.value; f.shown = 40; render(); }, 200));
    function sel(key, options) {
      var s = el("select", { class: "input" }, options.map(function (x) { return el("option", { value: x[0] }, [x[1]]); }));
      s.value = f[key];
      s.addEventListener("change", function () { f[key] = s.value; f.shown = 40; render(); });
      return s;
    }
    var year = new Date().getFullYear();
    box.appendChild(el("div", { class: "filters-row" }, [
      search,
      sel("type", [["TOUS", "Tous types"]].concat(types.map(function (t) { return [t, t]; }))),
      sel("pays", [["TOUS", "Tous pays / émetteurs"]].concat(pays.map(function (p) { return [p, p]; }))),
      sel("echeance", [["TOUTES", "Toutes échéances"], [String(year + 1), "Jusqu'à " + (year + 1)], [String(year + 3), "Jusqu'à " + (year + 3)], [String(year + 5), "Jusqu'à " + (year + 5)], ["LONG", "Après " + (year + 5)]])
    ]));
    var rows = o.lignes.filter(function (b) {
      if (f.type !== "TOUS" && b.type !== f.type) return false;
      if (f.pays !== "TOUS" && b.pays !== f.pays) return false;
      if (f.echeance === "LONG") { if (!(b.annee_echeance > year + 5)) return false; }
      else if (f.echeance !== "TOUTES" && !(b.annee_echeance <= Number(f.echeance))) return false;
      if (f.search) {
        var q = f.search.toLowerCase();
        if ((b.code + " " + b.nom).toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });
    var key = f.sort, dir = f.dir;
    rows.sort(function (a, b) {
      var av = key === "taux" ? a.taux_facial_pct : key === "echeance" ? a.annee_echeance : key === "cours" ? a.cours : a.code;
      var bv = key === "taux" ? b.taux_facial_pct : key === "echeance" ? b.annee_echeance : key === "cours" ? b.cours : b.code;
      if (av == null) av = -Infinity; if (bv == null) bv = -Infinity;
      return av < bv ? -dir : av > bv ? dir : 0;
    });
    function th(label, k, cls) {
      var active = f.sort === k;
      return el("th", { class: "sortable" + (active ? " active" : "") + (cls ? " " + cls : ""), onclick: function () {
        if (f.sort === k) f.dir *= -1; else { f.sort = k; f.dir = k === "taux" ? -1 : 1; }
        render();
      } }, [label + (active ? (f.dir === 1 ? " ▴" : " ▾") : "")]);
    }
    var tableWrap = el("div", { class: "table-scroll" });
    tableWrap.appendChild(el("table", { class: "data-table bonds-table" }, [
      el("thead", {}, [el("tr", {}, [th("Code", "code"), el("th", {}, ["Libellé"]), el("th", { class: "col-secteur" }, ["Type"]),
        th("Taux", "taux"), th("Échéance", "echeance"), th("Cours", "cours"), el("th", { class: "col-tendance" }, ["Dernier coupon"])])]),
      el("tbody", {}, rows.slice(0, f.shown).map(function (b) {
        return el("tr", {}, [
          el("td", { class: "mono" }, [b.code]),
          el("td", { class: "bond-name" }, [b.nom].concat(b.labels.map(function (l) { return el("span", { class: "badge tone-good-soft bond-label" }, [l]); }))),
          el("td", { class: "small col-secteur" }, [b.type + (b.pays ? " · " + b.pays : "")]),
          el("td", { class: "num" }, [b.taux_facial_pct != null ? fmtNum(b.taux_facial_pct, 2) + " %" : "variable"]),
          el("td", { class: "num" }, [b.annee_echeance || "—"]),
          el("td", { class: "num" }, [fmtNum(b.cours, 0)]),
          el("td", { class: "num small muted col-tendance" }, [b.dernier_coupon_date ? b.dernier_coupon_date + " · " + fmtNum(b.dernier_coupon_valeur, 2) : "—"])
        ]);
      }))
    ]));
    box.appendChild(tableWrap);
    if (!rows.length) box.appendChild(el("p", { class: "muted small" }, ["Aucune obligation ne correspond à ces filtres."]));
    if (rows.length > f.shown) box.appendChild(el("button", { class: "link-btn", style: "margin-top:10px", onclick: function () { f.shown += 60; render(); } },
      ["Afficher plus (" + (rows.length - f.shown) + " restantes)"]));
    box.appendChild(el("p", { class: "muted small" }, [o.echues + " obligation(s) échue(s) non affichée(s). Source : brvm.org, cote des obligations."]));
    return box;
  }

  function renderOppsGuide() {
    var items = [
      ["Emprunts obligataires (APE)", "Les États, institutions régionales et entreprises lèvent régulièrement des fonds par appel public à l'épargne : souscription auprès d'une SGI pendant une période donnée, coupon fixe, puis cotation à la BRVM."],
      ["Obligations cotées", "Achetables à la BRVM via une SGI. Coupons réguliers, souvent amortissables. Le marché secondaire est peu liquide : prévoir de les conserver."],
      ["Introductions en bourse", "Une société entre en bourse ou augmente son capital : souscription des actions nouvelles pendant l'offre, souvent avec un prix fixé à l'avance."],
      ["Sukuk", "Titres conformes à la finance islamique, adossés à des actifs ; émis notamment par des États de la zone."],
      ["Titres publics", "Bons et obligations du Trésor émis par adjudication (UMOA-Titres) ; accessibles aux particuliers via une banque ou une SGI, généralement avec des montants minimum plus élevés."],
      ["OPCVM (FCP, SICAV)", "Fonds gérés par des sociétés de gestion agréées par l'AMF-UMOA : diversification immédiate, adaptés aux petits montants ; frais de gestion à comparer."]
    ];
    return el("section", { class: "panel" }, [
      el("h2", {}, ["Comprendre ces placements"]),
      el("div", { class: "guide-list" }, items.map(function (it) { return el("div", {}, [el("b", { class: "small" }, [it[0]]), el("p", { class: "small muted" }, [it[1]])]); })),
      el("p", { class: "disclaimer" }, ["Avant toute souscription : lire la note d'information visée par l'AMF-UMOA, vérifier la fiscalité applicable dans votre pays et les frais de votre SGI."])
    ]);
  }

  function renderNav() {
    var pages = [["actions", "Actions & portefeuille"], ["opportunites", "Opportunités hors actions"]];
    return el("nav", { class: "page-tabs", role: "tablist" }, pages.map(function (p) {
      var active = state.ui.page === p[0];
      return el("button", { class: "page-tab" + (active ? " active" : ""), role: "tab", "aria-selected": active ? "true" : "false", onclick: function () {
        state.ui.page = p[0];
        try { history.replaceState(null, "", p[0] === "actions" ? location.pathname + location.search : "#" + p[0]); } catch (e) { /* ignore */ }
        render();
        window.scrollTo({ top: 0 });
      } }, [p[1]]);
    }));
  }

  // ---------------------------------------------------- documents d'analyse
  // L'utilisateur dépose ses propres sources (rapports annuels, notes de
  // recherche, communiqués, captures, enregistrements audio...). Chaque
  // document est conservé dans le navigateur (IndexedDB) et lu UNE fois par
  // l'IA, qui en tire une fiche structurée (chiffres clés, valeurs
  // concernées, impact) ; ce sont ces fiches, compactes, qui sont ensuite
  // jointes aux analyses personnalisées. Les fichiers audio/vidéo sont
  // transcrits localement dans le navigateur (Whisper), sans envoi du son.
  var DOCS_DB = "brvm-conseil-docs", DOCS_STORE = "documents";
  var PDF_MAX_BYTES = 22 * 1024 * 1024;     // ~32 Mo par requête une fois encodé en base64
  var IMAGE_MAX_SIDE = 2000;
  var TEXT_MAX_CHARS = 600000;              // au-delà, découper le document
  var TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";
  var MAMMOTH_URL = "https://cdn.jsdelivr.net/npm/mammoth@1.12.3/mammoth.browser.min.js";
  var WHISPER_MODELS = {
    standard: { id: "onnx-community/whisper-base", label: "Standard (rapide, ~80 Mo à télécharger une fois)" },
    haute: { id: "onnx-community/whisper-small", label: "Haute (plus lente, ~250 Mo à télécharger une fois)" }
  };

  state.docs = { list: [], progress: {}, openId: null, dragOver: false, loaded: false };

  function docKind(file) {
    var t = (file.type || "").toLowerCase(), n = file.name.toLowerCase();
    if (t === "application/pdf" || /\.pdf$/.test(n)) return "pdf";
    if (/^image\/(png|jpe?g|gif|webp)$/.test(t) || /\.(png|jpe?g|gif|webp)$/.test(n)) return "image";
    if (/^(audio|video)\//.test(t) || /\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|webm|mp4|mov)$/.test(n)) return "audio";
    if (/\.docx$/.test(n) || t === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "word";
    if (/^text\//.test(t) || /\.(txt|md|csv|json|tsv)$/.test(n)) return "texte";
    return null;
  }
  var KIND_LABEL = { pdf: "PDF", image: "Image", audio: "Audio", word: "Word", texte: "Texte" };

  function openDocsDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("Stockage local indisponible dans ce navigateur.")); return; }
      var req = indexedDB.open(DOCS_DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(DOCS_STORE, { keyPath: "id" }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function docsTx(mode, fn) {
    return openDocsDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DOCS_STORE, mode);
        var out = fn(tx.objectStore(DOCS_STORE));
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function saveDoc(doc) { return docsTx("readwrite", function (st) { st.put(doc); }); }
  function deleteDocFromDb(id) { return docsTx("readwrite", function (st) { st.delete(id); }); }

  function loadDocs() {
    return docsTx("readonly", function (st) { return st.getAll(); }).then(function (all) {
      state.docs.list = (all || []).sort(function (a, b) { return (b.addedAt || "").localeCompare(a.addedAt || ""); });
      // Un traitement interrompu (page fermée) est remis à « à analyser ».
      state.docs.list.forEach(function (d) { if (d.status === "en_cours") d.status = "a_analyser"; });
      state.docs.loaded = true;
      render();
    }).catch(function (e) {
      state.docs.loaded = true;
      state.docs.error = e.message;
      render();
    });
  }

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var added = [];
    files.forEach(function (file) {
      var kind = docKind(file);
      var doc = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name: file.name, mime: file.type, size: file.size, kind: kind,
        addedAt: new Date().toISOString(), blob: file, include: true,
        status: kind ? "a_analyser" : "erreur",
        error: kind ? null : "Format non pris en charge (PDF, Word .docx, images, texte/CSV, audio ou vidéo).",
        fiche: null, transcript: null
      };
      state.docs.list.unshift(doc);
      added.push(doc);
    });
    render();
    Promise.all(added.map(saveDoc)).then(function () {
      if (!aiSettings().apiKey) return;
      // Traitement séquentiel : un document à la fois (transcription et API).
      added.filter(function (d) { return d.status === "a_analyser"; }).reduce(function (p, d) {
        return p.then(function () { return processDocument(d); });
      }, Promise.resolve());
    }).catch(function (e) { state.docs.error = "Enregistrement local impossible : " + e.message; render(); });
  }

  function setDocProgress(doc, text) {
    state.docs.progress[doc.id] = text;
    var node = document.getElementById("doc-progress-" + doc.id);
    if (node) node.textContent = text; else render();
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1]); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  // Les images trop grandes sont réduites (JPEG) avant envoi : au-delà, l'API
  // les redimensionne de toute façon et la requête serait inutilement lourde.
  function prepareImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(img.width, img.height));
        var okType = /^image\/(png|jpeg|gif|webp)$/.test(blob.type);
        if (scale === 1 && okType && blob.size < 4.5 * 1024 * 1024) {
          blobToBase64(blob).then(function (b64) { resolve({ media_type: blob.type, data: b64 }); }, reject);
          return;
        }
        var c = document.createElement("canvas");
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve({ media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.88).split(",")[1] });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Image illisible.")); };
      img.src = url;
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src; s.onload = resolve;
      s.onerror = function () { reject(new Error("Chargement impossible : " + src)); };
      document.head.appendChild(s);
    });
  }

  function extractWordText(blob) {
    var ready = window.mammoth ? Promise.resolve() : loadScript(MAMMOTH_URL);
    return ready.then(function () { return blob.arrayBuffer(); })
      .then(function (buf) { return window.mammoth.extractRawText({ arrayBuffer: buf }); })
      .then(function (r) { return r.value; });
  }

  // Décodage audio (y compris piste son d'une vidéo) en mono 16 kHz, le
  // format attendu par Whisper.
  function decodeAudio16k(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      var ctx = new Ctx(1, 1, 16000);
      return ctx.decodeAudioData(buf);
    }).then(function (audio) {
      if (audio.numberOfChannels === 1) return audio.getChannelData(0);
      var a = audio.getChannelData(0), b = audio.getChannelData(1), out = new Float32Array(a.length);
      for (var i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
      return out;
    }, function () { throw new Error("Impossible de décoder ce fichier audio/vidéo dans le navigateur."); });
  }

  var asrPipelines = {};
  function transcribe(doc, onProgress) {
    var quality = readJsonStorage(AI_SETTINGS_KEY, {}).asrQuality || (navigator.gpu ? "haute" : "standard");
    var model = WHISPER_MODELS[quality] || WHISPER_MODELS.standard;
    var device = navigator.gpu ? "webgpu" : "wasm";
    var files = {};
    if (!asrPipelines[model.id]) {
      asrPipelines[model.id] = import(TRANSFORMERS_URL).then(function (tf) {
        return tf.pipeline("automatic-speech-recognition", model.id, {
          device: device,
          dtype: device === "webgpu" ? "fp32" : "q8",
          progress_callback: function (p) {
            if (p.status === "progress" && p.total) {
              files[p.file] = [p.loaded, p.total];
              var loaded = 0, total = 0;
              Object.keys(files).forEach(function (k) { loaded += files[k][0]; total += files[k][1]; });
              onProgress("Téléchargement du modèle de transcription (une seule fois) : " + Math.round(loaded / total * 100) + " %");
            }
          }
        });
      });
      asrPipelines[model.id].catch(function () { delete asrPipelines[model.id]; });
    }
    var audioP = decodeAudio16k(doc.blob);
    return Promise.all([asrPipelines[model.id], audioP]).then(function (r) {
      var asr = r[0], audio = r[1];
      var minutes = audio.length / 16000 / 60;
      var started = Date.now();
      onProgress("Transcription locale de " + (minutes < 1 ? Math.round(minutes * 60) + " s" : minutes.toFixed(1).replace(".", ",") + " min") +
        " d'audio en cours (" + (device === "webgpu" ? "carte graphique" : "processeur") + ")… cela peut prendre plusieurs minutes.");
      var timer = setInterval(function () {
        onProgress("Transcription locale en cours… " + Math.round((Date.now() - started) / 1000) + " s écoulées pour " +
          minutes.toFixed(1).replace(".", ",") + " min d'audio.");
      }, 5000);
      return asr(audio, { language: "french", task: "transcribe", chunk_length_s: 30, stride_length_s: 5 })
        .then(function (out) { clearInterval(timer); return (out && out.text || "").trim(); },
              function (e) { clearInterval(timer); throw e; });
    });
  }

  var FICHE_SCHEMA = {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        titre: { type: "string" },
        type_document: { type: "string" },
        date_document: { type: "string" },
        source: { type: "string" },
        valeurs: { type: "array", items: { type: "string" } },
        resume: { type: "string" },
        chiffres_cles: { type: "array", items: { type: "object", properties: {
          libelle: { type: "string" }, valeur: { type: "string" }, periode: { type: "string" }
        }, required: ["libelle", "valeur", "periode"], additionalProperties: false } },
        dividende: { type: "string" },
        perspectives: { type: "string" },
        risques: { type: "array", items: { type: "string" } },
        impact: { type: "array", items: { type: "object", properties: {
          symbole: { type: "string" },
          sens: { type: "string", enum: ["positif", "negatif", "neutre", "incertain"] },
          justification: { type: "string" }
        }, required: ["symbole", "sens", "justification"], additionalProperties: false } },
        fiabilite: { type: "string" }
      },
      required: ["titre", "type_document", "date_document", "source", "valeurs", "resume", "chiffres_cles", "dividende", "perspectives", "risques", "impact", "fiabilite"],
      additionalProperties: false
    }
  };

  function ficheSystemPrompt() {
    var list = (state.live.stocks || []).map(function (s) { return s.symbole + " — " + s.nom + " (" + s.secteur + ", " + s.pays + ")"; }).join("\n");
    return [
      "Tu es analyste financier spécialisé sur la BRVM (Bourse Régionale des Valeurs Mobilières, UEMOA). Un investisseur te transmet un document (rapport, note de recherche, communiqué, capture d'écran, transcription d'un enregistrement audio...). Produis une fiche d'analyse factuelle et fidèle, en français, qui servira ensuite de source à des analyses de marché.",
      "",
      "Règles :",
      "- N'invente rien : uniquement ce que contient le document. Champ texte sans information : chaîne vide ; liste sans information : liste vide.",
      "- valeurs : symboles BRVM concernés, choisis UNIQUEMENT dans la liste ci-dessous ; « MARCHE » si le document porte sur le marché dans son ensemble ou l'économie de la zone.",
      "- date_document : AAAA-MM-JJ si elle figure dans le document (sinon AAAA-MM ou AAAA, sinon chaîne vide).",
      "- chiffres_cles : 5 à 15 chiffres les plus utiles à un investisseur (chiffre d'affaires, résultat net, marges, dividende par action, endettement, objectifs de cours, volumes...), avec la période concernée.",
      "- impact : pour chaque valeur concernée, l'effet probable de ce document sur l'appréciation de la valeur, justifié en une phrase.",
      "- fiabilite : nature de la source (document officiel de l'émetteur, opinion d'analyste, article de presse, rumeur, transcription automatique pouvant contenir des erreurs...) et limites.",
      "- resume : 5 à 10 phrases, denses et chiffrées.",
      "",
      "Valeurs cotées à la BRVM :",
      list
    ].join("\n");
  }

  function documentContent(doc, onProgress) {
    var intro = "Document « " + doc.name + " » (" + KIND_LABEL[doc.kind] + ", ajouté le " + doc.addedAt.slice(0, 10) + ").";
    if (doc.kind === "pdf") {
      if (doc.size > PDF_MAX_BYTES) return Promise.reject(new Error("PDF trop volumineux (" + Math.round(doc.size / 1048576) + " Mo, maximum ~22 Mo) : découpez-le en plusieurs fichiers."));
      onProgress("Lecture du PDF…");
      return blobToBase64(doc.blob).then(function (b64) {
        return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }, { type: "text", text: intro + " Rédige sa fiche." }];
      });
    }
    if (doc.kind === "image") {
      onProgress("Préparation de l'image…");
      return prepareImage(doc.blob).then(function (img) {
        return [{ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } }, { type: "text", text: intro + " Rédige sa fiche." }];
      });
    }
    var textP;
    if (doc.kind === "audio") {
      textP = doc.transcript ? Promise.resolve(doc.transcript) : transcribe(doc, onProgress).then(function (t) {
        if (!t) throw new Error("Aucune parole détectée dans l'enregistrement.");
        doc.transcript = t;
        return saveDoc(doc).then(function () { return t; });
      });
      intro += " Transcription automatique (peut contenir des erreurs de reconnaissance, notamment sur les noms propres et les chiffres) :";
    } else if (doc.kind === "word") {
      onProgress("Extraction du texte Word…");
      textP = extractWordText(doc.blob);
    } else {
      textP = doc.blob.text();
    }
    return textP.then(function (t) {
      if (t.length > TEXT_MAX_CHARS) throw new Error("Texte trop long (" + Math.round(t.length / 1000) + " k caractères, maximum " + TEXT_MAX_CHARS / 1000 + " k) : découpez le document.");
      return intro + "\n\n<document>\n" + t + "\n</document>\n\nRédige sa fiche.";
    });
  }

  function processDocument(doc) {
    if (!aiSettings().apiKey) { state.ai.tab = "perso"; state.ai.settingsOpen = true; render(); return Promise.resolve(); }
    doc.status = "en_cours"; doc.error = null;
    setDocProgress(doc, "Préparation…");
    return documentContent(doc, function (t) { setDocProgress(doc, t); }).then(function (content) {
      setDocProgress(doc, "L'IA lit le document et rédige sa fiche…");
      return callClaude({ system: ficheSystemPrompt(), content: content, format: FICHE_SCHEMA, effort: "medium" });
    }).then(function (res) {
      doc.fiche = JSON.parse(res.text);
      doc.ficheModel = res.model;
      doc.ficheAt = new Date().toISOString();
      doc.status = "pret";
    }).catch(function (e) {
      doc.status = "erreur";
      doc.error = e && e.message ? e.message : String(e);
    }).then(function () {
      delete state.docs.progress[doc.id];
      return saveDoc(doc).catch(function () {});
    }).then(render);
  }

  function removeDoc(doc) {
    if (!confirm("Supprimer « " + doc.name + " » et sa fiche ?")) return;
    state.docs.list = state.docs.list.filter(function (d) { return d !== doc; });
    deleteDocFromDb(doc.id).then(render, render);
  }

  function includedDocuments() {
    return (state.docs.list || []).filter(function (d) { return d.include && d.status === "pret" && d.fiche; });
  }

  function ficheAsText(doc) {
    var f = doc.fiche;
    var out = ["### « " + (f.titre || doc.name) + " » — " + (f.type_document || KIND_LABEL[doc.kind]) +
      (f.date_document ? ", daté du " + f.date_document : ", date inconnue") + (f.source ? ", source : " + f.source : "")];
    out.push("Valeurs concernées : " + (f.valeurs.length ? f.valeurs.join(", ") : "—") + ". Fiabilité : " + (f.fiabilite || "—"));
    out.push("Résumé : " + f.resume);
    if (f.chiffres_cles.length) out.push("Chiffres clés : " + f.chiffres_cles.map(function (c) { return c.libelle + " = " + c.valeur + (c.periode ? " (" + c.periode + ")" : ""); }).join(" ; "));
    if (f.dividende) out.push("Dividende : " + f.dividende);
    if (f.perspectives) out.push("Perspectives : " + f.perspectives);
    if (f.risques.length) out.push("Risques : " + f.risques.join(" ; "));
    if (f.impact.length) out.push("Impact estimé : " + f.impact.map(function (i) { return i.symbole + " " + i.sens + " (" + i.justification + ")"; }).join(" ; "));
    return out.join("\n");
  }

  function buildDocumentsSection() {
    var docs = includedDocuments();
    if (!docs.length) return "";
    return "\n\n## Documents fournis par l'investisseur (fiches de lecture)\n" +
      "Ces fiches résument des sources externes transmises par l'investisseur. Utilise-les comme éclairage fondamental : cite-les (titre, date), tiens compte de leur ancienneté et de leur fiabilité, et signale toute contradiction avec les données de marché du dossier.\n\n" +
      docs.map(ficheAsText).join("\n\n");
  }

  function docsForSymbol(symb) {
    return includedDocuments().filter(function (d) { return d.fiche.valeurs.indexOf(symb) !== -1; });
  }

  var IMPACT_TONE = { positif: "good", negatif: "critical", neutre: "neutral", incertain: "warning" };
  var IMPACT_LABEL = { positif: "positif", negatif: "négatif", neutre: "neutre", incertain: "incertain" };

  function fmtSize(b) { return b >= 1048576 ? fmtNum(b / 1048576, 1) + " Mo" : Math.max(1, Math.round(b / 1024)) + " Ko"; }

  function renderDocCard(doc) {
    var f = doc.fiche, open = state.docs.openId === doc.id;
    var statusEl;
    if (doc.status === "en_cours") statusEl = el("p", { class: "muted small ai-status", id: "doc-progress-" + doc.id }, [state.docs.progress[doc.id] || "Traitement…"]);
    else if (doc.status === "erreur") statusEl = el("p", { class: "small concentration-warning" }, ["⚠ " + doc.error]);
    else if (doc.status === "a_analyser") statusEl = el("p", { class: "muted small" }, [aiSettings().apiKey ? "En attente d'analyse." : "À analyser : configurez votre clé API dans le panneau Analyse IA."]);

    var head = el("div", { class: "doc-head" }, [
      el("span", { class: "badge tone-neutral" }, [KIND_LABEL[doc.kind] || "?"]),
      el("div", { class: "doc-title" }, [
        el("b", {}, [f ? f.titre || doc.name : doc.name]),
        el("div", { class: "muted small" }, [
          (f && f.titre ? doc.name + " · " : "") + fmtSize(doc.size) + " · ajouté le " + new Date(doc.addedAt).toLocaleDateString("fr-FR") +
          (f && f.date_document ? " · document du " + f.date_document : "")
        ])
      ])
    ]);
    var card = el("div", { class: "doc-card" + (doc.include && f ? "" : " doc-off") }, [head]);
    if (f) {
      card.appendChild(el("div", { class: "doc-tags" }, f.impact.length ? f.impact.map(function (i) {
        return el("span", { class: "badge tone-" + (IMPACT_TONE[i.sens] || "neutral"), title: i.justification }, [i.symbole + " · " + IMPACT_LABEL[i.sens]]);
      }) : f.valeurs.map(function (v) { return el("span", { class: "badge tone-neutral" }, [v]); })));
      card.appendChild(el("p", { class: "small doc-resume" }, [open ? f.resume : (f.resume.length > 220 ? f.resume.slice(0, 220) + "…" : f.resume)]));
      if (open) {
        var details = el("div", { class: "doc-details small" }, [
          f.chiffres_cles.length ? el("div", {}, [el("b", {}, ["Chiffres clés"]), el("ul", {}, f.chiffres_cles.map(function (c) {
            return el("li", {}, [c.libelle + " : ", el("b", {}, [c.valeur]), c.periode ? " (" + c.periode + ")" : ""]);
          }))]) : null,
          f.dividende ? el("p", {}, [el("b", {}, ["Dividende : "]), f.dividende]) : null,
          f.perspectives ? el("p", {}, [el("b", {}, ["Perspectives : "]), f.perspectives]) : null,
          f.risques.length ? el("div", {}, [el("b", {}, ["Risques"]), el("ul", {}, f.risques.map(function (r) { return el("li", {}, [r]); }))]) : null,
          f.impact.length ? el("div", {}, [el("b", {}, ["Impact estimé"]), el("ul", {}, f.impact.map(function (i) { return el("li", {}, [i.symbole + " (" + IMPACT_LABEL[i.sens] + ") : " + i.justification]); }))]) : null,
          el("p", { class: "muted" }, ["Fiabilité de la source : " + (f.fiabilite || "—")]),
          el("p", { class: "muted" }, ["Fiche rédigée le " + new Date(doc.ficheAt).toLocaleString("fr-FR") + " par " + aiModelLabel(doc.ficheModel) + "."]),
          doc.transcript ? el("details", {}, [el("summary", {}, ["Transcription (" + Math.round(doc.transcript.length / 1000) + " k caractères)"]), el("p", { class: "doc-transcript" }, [doc.transcript])]) : null
        ]);
        card.appendChild(details);
      }
    }
    if (statusEl) card.appendChild(statusEl);

    var include = el("input", { type: "checkbox", id: "doc-inc-" + doc.id });
    include.checked = !!doc.include;
    include.addEventListener("change", function () { doc.include = include.checked; saveDoc(doc); render(); });
    card.appendChild(el("div", { class: "doc-actions" }, [
      f ? el("label", { class: "small ai-check", for: "doc-inc-" + doc.id }, [include, " Utiliser dans mes analyses"]) : null,
      f ? el("button", { class: "link-btn small", onclick: function () { state.docs.openId = open ? null : doc.id; render(); } }, [open ? "Réduire" : "Voir la fiche"]) : null,
      doc.kind && doc.status !== "en_cours" ? el("button", { class: "link-btn small", onclick: function () { processDocument(doc); } }, [f ? "Réanalyser" : "Analyser"]) : null,
      doc.status !== "en_cours" ? el("button", { class: "link-btn small doc-delete", onclick: function () { removeDoc(doc); } }, ["Supprimer"]) : null
    ]));
    return card;
  }

  function renderDocuments() {
    var docs = state.docs.list || [];
    var used = includedDocuments().length;
    var box = el("section", { class: "panel docs-panel" }, [
      el("div", { class: "ai-head" }, [
        el("h2", {}, ["Mes documents d'analyse"]),
        used ? el("span", { class: "muted small" }, [used + " utilisé(s) dans l'analyse personnalisée"]) : null
      ]),
      el("p", { class: "muted small", style: "margin-top:-4px" }, [
        "Ajoutez vos sources (rapports annuels, notes de SGI, communiqués, captures, enregistrements audio ou vidéo de conférences...). ",
        "L'IA rédige une fiche par document (chiffres clés, valeurs concernées, impact), jointe ensuite à vos analyses personnalisées. ",
        "Les fichiers restent dans ce navigateur ; ils ne sont envoyés qu'à l'API Claude pour la lecture, et l'audio est transcrit localement."
      ])
    ]);
    var input = el("input", { type: "file", multiple: "multiple", class: "visually-hidden", id: "doc-input",
      accept: ".pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.gif,.webp,audio/*,video/*,.mp3,.m4a,.wav,.ogg,.opus,.webm,.mp4,.mov" });
    input.addEventListener("change", function () { addFiles(input.files); input.value = ""; });
    var zone = el("div", {
      class: "drop-zone" + (state.docs.dragOver ? " over" : ""),
      ondragover: function (ev) { ev.preventDefault(); if (!state.docs.dragOver) { state.docs.dragOver = true; zone.classList.add("over"); } },
      ondragleave: function () { state.docs.dragOver = false; zone.classList.remove("over"); },
      ondrop: function (ev) { ev.preventDefault(); state.docs.dragOver = false; addFiles(ev.dataTransfer.files); }
    }, [
      el("p", {}, [el("b", {}, ["Déposez vos fichiers ici"]), " ou ", el("label", { for: "doc-input", class: "link-btn" }, ["choisissez-les"])]),
      el("p", { class: "muted small" }, ["PDF (≤ 22 Mo), Word .docx, images, texte/CSV, audio et vidéo (mp3, m4a, wav, mp4...)"]),
      input
    ]);
    box.appendChild(zone);

    var asrSel = el("select", { class: "input" }, Object.keys(WHISPER_MODELS).map(function (k) { return el("option", { value: k }, [WHISPER_MODELS[k].label]); }));
    asrSel.value = readJsonStorage(AI_SETTINGS_KEY, {}).asrQuality || (navigator.gpu ? "haute" : "standard");
    asrSel.addEventListener("change", function () { saveAiSettings({ asrQuality: asrSel.value }); });
    box.appendChild(el("div", { class: "asr-row small" }, [el("span", { class: "muted" }, ["Transcription audio :"]), asrSel]));

    if (state.docs.error) box.appendChild(el("p", { class: "small concentration-warning" }, ["⚠ " + state.docs.error]));
    if (!state.docs.loaded) box.appendChild(el("p", { class: "muted small" }, ["Chargement…"]));
    docs.forEach(function (d) { box.appendChild(renderDocCard(d)); });
    return box;
  }

  // Les 4 facteurs du score v2, avec le rang de la valeur dans le marché
  // (0 = la moins bien placée, 1 = la mieux placée sur ce critère).
  function renderFactors(f, reco) {
    var items = [
      ["Tendance de fond (" + f.tendance_fenetre + " séances hors 5 dern.)", fmtPct(f.tendance_pct), f.rang.tendance],
      ["5 dernières séances", fmtPct(f.court_pct), f.rang.repli],
      ["Volatilité / séance", fmtNum(f.volatilite_pct, 1) + " %", f.rang.calme],
      ["Capitaux échangés / séance", fmtNum(f.capitaux_moyens_fcfa / 1e6, 1) + " M FCFA", f.rang.liquidite]
    ];
    return el("div", { class: "factors" }, [
      el("div", { class: "muted small factors-title" }, [
        "Facteurs du score (barre = position dans le marché, à droite = favorable)" + (reco && reco.score != null ? " — score " + (reco.score > 0 ? "+" : "") + fmtNum(reco.score, 2) : "")
      ])
    ].concat(items.map(function (it) {
      return el("div", { class: "factor-row" }, [
        el("span", { class: "factor-label small" }, [it[0]]),
        el("span", { class: "factor-value small num" }, [it[1]]),
        el("div", { class: "concentration-bar-track factor-track" }, [
          el("div", { class: "factor-dot", style: "left:calc(" + Math.round(it[2] * 100) + "% - 5px)" })
        ])
      ]);
    })));
  }

  function renderLinkedDocs(symb) {
    var docs = docsForSymbol(symb);
    if (!docs.length) return null;
    return el("div", { class: "linked-docs small" }, [el("span", { class: "muted" }, ["Vos documents : "])].concat(docs.map(function (d) {
      var imp = d.fiche.impact.filter(function (i) { return i.symbole === symb; })[0];
      return el("span", { class: "badge tone-" + (imp ? IMPACT_TONE[imp.sens] || "neutral" : "neutral"), title: imp ? imp.justification : d.fiche.resume },
        [(d.fiche.titre || d.name).slice(0, 50) + (imp ? " · " + IMPACT_LABEL[imp.sens] : "")]);
    })));
  }

  function renderRoot() {
    var root = document.getElementById("root");
    root.innerHTML = "";
    root.appendChild(renderHeader());
    var main = el("main", { class: "layout" });
    if (state.view.date) root.appendChild(renderArchiveBanner());
    root.appendChild(renderNav());
    var left, right;
    if (state.ui.page === "opportunites") {
      left = el("div", { class: "col-main" }, [renderOppsResearch(), renderBonds()]);
      right = el("div", { class: "col-side" }, [renderProfileSwitcher(), renderOppsGuide(), renderDocuments()]);
    } else {
      left = el("div", { class: "col-main" }, [renderSynthese(), renderPortfolio(), renderAiPanel(), renderResearchPanel(), renderDocuments(), renderMethodology(), renderMarketTable()]);
      right = el("div", { class: "col-side" }, [renderProfileSwitcher(), renderConcentration(), renderWatchlist(), renderArchives()]);
    }
    main.appendChild(left);
    main.appendChild(right);
    root.appendChild(main);
    root.appendChild(el("footer", { class: "app-footer" }, [
      el("p", {}, ["Source des données : pages publiques brvm.org (cours du jour, indices), mises à jour après la clôture de chaque séance de bourse."]),
      el("p", { class: "disclaimer" }, ["Outil d'aide à la décision à titre informatif, ne constituant pas un conseil en investissement financier réglementé. Investir en actions comporte un risque de perte en capital."])
    ]));
  }

  function render() { renderRoot(); }

  // -------------------------------------------------------- state mutators
  function setRiskProfile(key) { state.user.riskProfile = key; loadCachedAi(); render(); saveUserState(); }
  function addWatch(symb) {
    if (!symb) return;
    state.user.watchlist = state.user.watchlist || [];
    if (state.user.watchlist.indexOf(symb) === -1) state.user.watchlist.push(symb);
    render(); saveUserState();
  }
  function removeWatch(symb) {
    state.user.watchlist = (state.user.watchlist || []).filter(function (s) { return s !== symb; });
    render(); saveUserState();
  }

  // ------------------------------------------------- persistance locale
  // Version autonome (hors claude.ai) : le profil/portefeuille/watchlist
  // sont sauvegardés dans le localStorage du navigateur. Comme cette
  // sauvegarde vit dans le navigateur (pas dans la page), elle survit
  // automatiquement à la reconstruction quotidienne de index.html par la
  // tâche planifiée (GitHub Actions) — au chargement, on préfère toujours
  // la version localStorage si elle existe, aux données par défaut
  // embarquées dans la page.
  var STORAGE_KEY = "brvm-conseil-user-v1";
  var saveUserState = debounce(function () {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.user));
    } catch (e) {
      // Stockage indisponible (navigation privée, quota, etc.) : l'appli
      // continue de fonctionner pour la session en cours, simplement sans
      // persistance entre deux visites.
    }
  }, 300);

  function loadUserState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore et retombe sur les données par défaut */ }
    try {
      return JSON.parse(document.getElementById("user-data").textContent);
    } catch (e) {
      return { riskProfile: "equilibre", portfolio: [], watchlist: [] };
    }
  }

  // ---------------------------------------------------------------- init
  function init() {
    try {
      state.live = JSON.parse(document.getElementById("market-data").textContent);
    } catch (e) { state.live = { indices: [], stocks: [], history: {}, stats: {} }; }
    state.market = state.live;
    try {
      state.archiveIndex = JSON.parse(document.getElementById("archive-index").textContent) || [];
    } catch (e) { state.archiveIndex = []; }
    state.ui.page = location.hash === "#opportunites" ? "opportunites" : "actions";
    state.user = loadUserState();
    if (!state.user.riskProfile) state.user.riskProfile = "equilibre";
    if (!state.user.portfolio) state.user.portfolio = [];
    if (!state.user.watchlist) state.user.watchlist = [];
    if (!state.user.transactions) {
      // Migration : les positions saisies avant le registre d'opérations
      // deviennent des achats à leur date d'achat.
      state.user.transactions = state.user.portfolio.map(function (p, i) {
        return { id: "m" + i, seq: i, type: "achat", symbole: p.symbole, date: p.date_achat || todayIso(), quantite: p.quantite, prix: p.prix_achat, frais: 0 };
      });
      if (state.user.transactions.length) saveUserState();
    }
    syncPortfolio();
    loadCachedAi();
    render();
    loadDocs();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
