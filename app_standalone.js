/* BRVM Conseil — logique application (rendu, persistance, interactions).
   Ce fichier est injecté tel quel dans un <script type="text/plain" id="app-src">
   et exécuté via new Function() par le petit script d'amorçage. Il ne dépend
   d'aucune bibliothèque externe. */
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

  var PROFILES = [
    { key: "prudent", label: "Prudent", desc: "Priorité à la préservation du capital : ne pousse jamais à l'achat sur la foi d'une seule séance, réagit vite pour alléger en cas de baisse marquée." },
    { key: "equilibre", label: "Équilibré", desc: "Compromis entre momentum et volatilité : signaux modérés, sensibles à la confirmation par le volume." },
    { key: "dynamique", label: "Dynamique", desc: "Recherche la tendance et le momentum, tolère plus de volatilité, réagit dès qu'un mouvement se confirme par le volume." }
  ];

  var state = {
    market: null,
    user: null,
    ui: { search: "", secteur: "TOUS", signal: "TOUS", sort: "symbole", sortDir: 1, expanded: null, methodOpen: false }
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
      if (typeof c === "string") e.appendChild(document.createTextNode(c));
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
    var d = new Date();
    return d.toISOString().slice(0, 10);
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
        el("div", { class: "meta-line muted small" }, ["Mis à jour à " + (m.lastUpdate ? new Date(m.lastUpdate).toLocaleString("fr-FR") : "—")])
      ])
    ]);
    return header;
  }

  function renderIndices() {
    var wrap = el("div", { class: "indices-row" });
    (state.market.indices || []).forEach(function (ix) {
      wrap.appendChild(el("div", { class: "stat-tile" }, [
        el("div", { class: "stat-label" }, [ix.nom.replace("BRVM - ", "BRVM ").replace("BRVM-", "BRVM ")]),
        el("div", { class: "stat-value" }, [fmtNum(ix.cloture, 2)]),
        el("div", { class: "stat-delta " + pctClass(ix.variation_pct) }, [fmtPct(ix.variation_pct)])
      ]));
    });
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
      wrap.appendChild(el("div", { class: "method-body" }, [
        el("p", {}, ["Chaque valeur est notée à partir de trois ingrédients calculés sur l'historique réellement observé depuis la mise en service de l'outil : le momentum (variation récente du cours), la volatilité (écart-type des variations journalières) et la confirmation par le volume (volume du jour comparé à la moyenne récente)."]),
        el("p", {}, ["Ces trois signaux sont pondérés différemment selon le profil : un profil ", el("b", {}, ["prudent"]), " amortit fortement la conviction d'achat tant que l'historique est court et ne recommande jamais d'acheter sur la foi d'une seule séance ; un profil ", el("b", {}, ["dynamique"]), " réagit plus vite au momentum et au volume, quitte à accepter plus de volatilité."]),
        el("p", {}, ["Les données proviennent des pages officielles et publiques de brvm.org (cours du jour et indices), récupérées après la clôture de chaque séance. L'historique se reconstitue jour après jour — plus l'outil est utilisé longtemps, plus les moyennes mobiles et la volatilité deviennent fiables."]),
        el("p", { class: "disclaimer" }, ["Ceci est un outil d'aide à la décision basé sur des règles quantitatives transparentes. Ce n'est pas un conseil en investissement réglementé et cela ne remplace pas l'avis d'un conseiller agréé auprès du CREPMF. Les marchés actions comportent un risque de perte en capital."])
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

  function positionRow(pos) {
    var s = findStock(pos.symbole);
    var cours = s ? s.cours_cloture : null;
    var valeur = cours != null ? cours * pos.quantite : null;
    var cout = pos.prix_achat * pos.quantite;
    var pnl = valeur != null ? valeur - cout : null;
    var pnlPct = pnl != null && cout ? (pnl / cout) * 100 : null;
    var reco = s ? s.recommandations[state.user.riskProfile] : null;
    return el("tr", {}, [
      el("td", { class: "mono" }, [pos.symbole]),
      el("td", { class: "name-cell" }, [s ? s.nom : pos.symbole]),
      el("td", { class: "num" }, [fmtNum(pos.quantite, 0)]),
      el("td", { class: "num" }, [fmtFCFA(pos.prix_achat)]),
      el("td", { class: "num" }, [fmtFCFA(cours)]),
      el("td", { class: "num" }, [fmtFCFA(valeur)]),
      el("td", { class: "num " + pctClass(pnl) }, [pnl == null ? "—" : (pnl >= 0 ? "+" : "") + fmtNum(pnl, 0) + " (" + fmtPct(pnlPct) + ")"]),
      el("td", {}, [reco ? signalBadge(reco.signal) : "—"]),
      el("td", {}, [el("button", { class: "icon-btn", title: "Retirer", onclick: function () { removePosition(pos); } }, ["✕"])])
    ]);
  }
  
  function renderPortfolio() {
    var box = el("section", { class: "panel" }, [el("h2", {}, ["Mon portefeuille"])]);
    var portfolio = state.user.portfolio || [];
    if (portfolio.length) {
      var totalCout = 0, totalVal = 0;
      portfolio.forEach(function (pos) {
        var s = findStock(pos.symbole);
        totalCout += pos.prix_achat * pos.quantite;
        if (s && s.cours_cloture != null) totalVal += s.cours_cloture * pos.quantite;
      });
      var totalPnl = totalVal - totalCout;
      var totalPnlPct = totalCout ? (totalPnl / totalCout) * 100 : null;
      box.appendChild(el("div", { class: "portfolio-summary" }, [
        el("div", { class: "stat-tile" }, [el("div", { class: "stat-label" }, ["Valeur totale"]), el("div", { class: "stat-value" }, [fmtFCFA(totalVal)])]),
        el("div", { class: "stat-tile" }, [el("div", { class: "stat-label" }, ["Coût d'acquisition"]), el("div", { class: "stat-value" }, [fmtFCFA(totalCout)])]),
        el("div", { class: "stat-tile" }, [el("div", { class: "stat-label" }, ["Plus/moins-value"]), el("div", { class: "stat-value " + pctClass(totalPnl) }, [(totalPnl >= 0 ? "+" : "") + fmtNum(totalPnl, 0) + " FCFA (" + fmtPct(totalPnlPct) + ")"])])
      ]));
      var tableWrap = el("div", { class: "table-scroll" });
      var table = el("table", { class: "data-table" }, [
        el("thead", {}, [el("tr", {}, ["Symbole", "Nom", "Qté", "PRU", "Cours", "Valorisation", "+/- value", "Signal", ""].map(function (h) { return el("th", {}, [h]); }))]),
        el("tbody", {}, portfolio.map(positionRow))
      ]);
      tableWrap.appendChild(table);
      box.appendChild(tableWrap);
    } else {
      box.appendChild(el("p", { class: "muted small" }, ["Aucune position enregistrée. Ajoutez vos actions détenues pour suivre votre plus/moins-value et recevoir des signaux personnalisés."]));
    }
    box.appendChild(renderAddPositionForm());
    return box;
  }

  function symbolOptions(selectedFirst) {
    var syms = (state.market.stocks || []).slice().sort(function (a, b) { return a.symbole < b.symbole ? -1 : 1; });
    return syms.map(function (s) { return el("option", { value: s.symbole }, [s.symbole + " — " + s.nom]); });
  }

  function renderAddPositionForm() {
    var symbSel = el("select", { class: "input" }, symbolOptions());
    var qtyInput = el("input", { class: "input", type: "number", min: "1", step: "1", placeholder: "Quantité" });
    var priceInput = el("input", { class: "input", type: "number", min: "0", step: "1", placeholder: "Prix d'achat (FCFA)" });
    var dateInput = el("input", { class: "input", type: "date", value: todayIso() });
    var form = el("form", {
      class: "add-form",
      onsubmit: function (ev) {
        ev.preventDefault();
        var symb = symbSel.value;
        var qty = parseFloat(qtyInput.value);
        var price = parseFloat(priceInput.value);
        if (!symb || !qty || qty <= 0 || !price || price <= 0) return;
        addPosition({ symbole: symb, quantite: qty, prix_achat: price, date_achat: dateInput.value || todayIso() });
        qtyInput.value = ""; priceInput.value = "";
      }
    }, [
      symbSel, qtyInput, priceInput, dateInput,
      el("button", { class: "btn", type: "submit" }, ["Ajouter la position"])
    ]);
    return form;
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
      el("td", {}, [signalBadge(reco.signal)]),
      el("td", { class: "expand-caret" }, [expanded ? "−" : "+"])
    ])];
    if (expanded) {
      var ind = s.indicateurs;
      rows.push(el("tr", { class: "row-detail" }, [el("td", { colspan: "7" }, [
        el("div", { class: "detail-grid" }, [
          el("div", {}, [el("b", {}, [s.nom]), el("div", { class: "muted small" }, [s.pays])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Ouverture / Clôture"]), el("div", {}, [fmtFCFA(s.cours_ouverture) + " → " + fmtFCFA(s.cours_cloture)])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Volume"]), el("div", {}, [fmtNum(s.volume, 0)])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Momentum"]), el("div", {}, [ind.momentum_pct != null ? fmtPct(ind.momentum_pct) + " (" + ind.momentum_fenetre + "j)" : "—"])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Volatilité"]), el("div", {}, [ind.volatilite_pct != null ? fmtNum(ind.volatilite_pct, 1) + " %" : "—"])]),
          el("div", {}, [el("div", { class: "muted small" }, ["Volume vs moyenne"]), el("div", {}, [ind.volume_ratio != null ? fmtNum(ind.volume_ratio, 2) + "x" : "—"])])
        ]),
        el("div", { class: "reco-all" }, PROFILES.map(function (p) {
          var r = s.recommandations[p.key];
          return el("div", { class: "reco-line" }, [el("b", {}, [p.label + " : "]), signalBadge(r.signal), el("span", { class: "muted small" }, [" " + r.raison])]);
        }))
      ])]));
    }
    return rows;
  }

  function renderRoot() {
    var root = document.getElementById("root");
    root.innerHTML = "";
    root.appendChild(renderHeader());
    var main = el("main", { class: "layout" });
    var left = el("div", { class: "col-main" }, [renderSynthese(), renderMethodology(), renderMarketTable()]);
    var right = el("div", { class: "col-side" }, [renderProfileSwitcher(), renderPortfolio(), renderWatchlist()]);
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
  function setRiskProfile(key) { state.user.riskProfile = key; render(); saveUserState(); }
  function addPosition(pos) {
    state.user.portfolio = state.user.portfolio || [];
    state.user.portfolio.push(pos);
    render(); saveUserState();
  }
  function removePosition(pos) {
    state.user.portfolio = (state.user.portfolio || []).filter(function (p) { return p !== pos; });
    render(); saveUserState();
  }
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
      state.market = JSON.parse(document.getElementById("market-data").textContent);
    } catch (e) { state.market = { indices: [], stocks: [], history: {}, stats: {} }; }
    state.user = loadUserState();
    if (!state.user.riskProfile) state.user.riskProfile = "equilibre";
    if (!state.user.portfolio) state.user.portfolio = [];
    if (!state.user.watchlist) state.user.watchlist = [];
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
