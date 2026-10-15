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
      wrap.appendChild(el("div", { class: "method-body" }, [
        el("p", {}, ["Chaque valeur est notée à partir de plusieurs ingrédients calculés sur l'historique réellement observé depuis la mise en service de l'outil : le momentum (variation récente du cours), la volatilité (écart-type des variations journalières), la confirmation par le volume (volume du jour comparé à la moyenne récente), la ", el("b", {}, ["confirmation multi-horizon"]), " (le court terme — 5 séances —, le moyen terme — 30 séances — et le long terme — 90 séances — pointent-ils dans le même sens ?) et la ", el("b", {}, ["force relative"]), " par rapport à l'indice BRVM Composite (l'action fait-elle mieux ou moins bien que le marché dans son ensemble sur la même période ?)."]),
        el("p", {}, ["Une tendance de fond baissière confirmée sur plusieurs horizons neutralise toute conviction d'achat court terme, quel que soit le profil : l'outil ne recommande jamais de renforcer une valeur dont le moyen et le long terme restent clairement orientés à la baisse, même si le cours rebondit sur quelques séances."]),
        el("p", {}, ["Un filtre de liquidité s'applique en dernier lieu : si le volume échangé est nul, ou anormalement faible au regard d'un mouvement de prix marqué, le signal est forcé à ", el("b", {}, ["Surveiller"]), " — sur un marché aussi peu liquide que la BRVM pour une partie de ses valeurs, un mouvement de cours non confirmé par un vrai volume d'échange n'est pas un signal fiable."]),
        el("p", {}, ["Ces signaux sont pondérés différemment selon le profil : un profil ", el("b", {}, ["prudent"]), " amortit fortement la conviction d'achat tant que l'historique est court et ne recommande jamais d'acheter sur la foi d'une seule séance ; un profil ", el("b", {}, ["dynamique"]), " réagit plus vite au momentum et au volume, quitte à accepter plus de volatilité."]),
        el("p", {}, ["La vue « Concentration du portefeuille » (colonne de droite) complète l'analyse valeur par valeur : elle signale un risque de concentration sectorielle ou géographique excessive, indépendamment du signal de chaque ligne."]),
        el("p", {}, ["Les données proviennent des pages officielles et publiques de brvm.org (cours du jour et indices). L'historique se reconstitue séance après séance — plus l'outil est utilisé longtemps, plus les moyennes mobiles, la volatilité et la confirmation multi-horizon deviennent fiables. Un tracé intrajournalier (fenêtre des dernières séances) est aussi conservé pour visualiser le mouvement du jour, sans influencer le calcul des recommandations."]),
        el("p", {}, ["Ceci reste une analyse ", el("b", {}, ["technique"]), " (prix, volume, tendance), pas une analyse fondamentale : les résultats de l'entreprise, les dividendes ou le contexte macroéconomique de l'UEMOA ne sont pas pris en compte."]),
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
    { id: "claude-opus-5-5", label: "Claude Opus 5.5 — analyse la plus fine (≈ 0,10 $ / analyse)", fallbacks: true },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — bon compromis (≈ 0,05 $ / analyse)", fallbacks: true },
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

  var AI_SYSTEM_PROMPT = [
    "Tu es un analyste actions spécialisé sur la BRVM (Bourse Régionale des Valeurs Mobilières de l'UEMOA, Abidjan). Tu reçois les données d'une séance, produites par un outil d'analyse quantitative (indicateurs techniques et signaux calculés par des règles), et tu rédiges en français une analyse de la séance pour un investisseur particulier.",
    "",
    "Ta valeur ajoutée par rapport aux signaux automatiques : prendre du recul, relier les mouvements entre eux (secteurs, pays, indices, largeur du marché), distinguer ce qui est significatif de ce qui ne l'est pas, repérer les signaux automatiques fragiles ou contradictoires (volume faible, historique court, tendances divergentes selon l'horizon, changement de signal récent), et traduire tout cela en points d'attention concrets pour le profil de risque et le portefeuille de l'investisseur.",
    "",
    "Règles :",
    "- Appuie-toi uniquement sur les données fournies. Tu n'as accès ni à l'actualité, ni aux résultats des sociétés, ni aux dividendes : ne les invente pas. Si une explication fondamentale te paraît plausible, présente-la explicitement comme une hypothèse à vérifier.",
    "- Étaye chaque point par des chiffres précis tirés des données (variations, volumes, momentum, force relative).",
    "- Sur la BRVM, beaucoup de valeurs s'échangent peu : un mouvement de cours sans volume n'est pas un signal fiable, dis-le quand c'est le cas.",
    "- Ajuste ton niveau de confiance à la profondeur de l'historique disponible (nombre de séances).",
    "- Ce n'est pas un conseil en investissement réglementé : formule des points d'attention, des scénarios et des conditions à surveiller plutôt que des ordres d'achat ou de vente.",
    "",
    "Format : Markdown, titres de niveau 2, dans cet ordre :",
    "## L'essentiel en 3 points",
    "## Lecture du marché (indices, largeur, secteurs)",
    "## Valeurs à la loupe (4 à 8 valeurs réellement significatives)",
    "## Signaux à prendre avec prudence",
    "## Votre portefeuille et votre liste de suivi (seulement si fournis)",
    "## À surveiller lors des prochaines séances",
    "Sois dense et concret, environ 600 à 900 mots. Pas de tableau de plus de 8 lignes."
  ].join("\n");

  function numOrDash(x, d) { return x == null || isNaN(x) ? "—" : Number(x).toFixed(d == null ? 2 : d); }

  function buildAiPrompt(previous) {
    var m = state.market, s = m.stats || {}, profile = state.user.riskProfile;
    var out = [];
    out.push("Séance : " + (m.asOfLabel || m.asOfDate) + " (" + m.asOfDate + "), données relevées le " + (m.lastUpdate || "—") + ".");
    out.push("Profondeur de l'historique : " + (s.dataMaturityDays || 0) + " séance(s).");
    out.push("Profil de risque de l'investisseur : " + labelForProfile(profile) + ".");
    out.push("Largeur du marché : " + s.hausses + " hausses, " + s.baisses + " baisses, " + s.stables + " stables.");
    out.push("");
    out.push("### Indices (nom | catégorie | clôture | var. jour % | var. depuis le 1er janvier % | momentum 5 séances %)");
    if (!(m.indices || []).length) out.push("(indices non disponibles pour cette séance : ne commente pas les indices, appuie-toi sur la largeur du marché)");
    (m.indices || []).forEach(function (ix) {
      out.push([ix.nom, ix.categorie || "principal", numOrDash(ix.cloture), numOrDash(ix.variation_pct), numOrDash(ix.variation_ytd_pct),
        numOrDash((ix.indicateurs || {}).momentum_pct)].join(" | "));
    });
    out.push("");
    out.push("### Valeurs (symbole | nom | secteur | pays | cours FCFA | var. jour % | volume | volume/moyenne 10 séances | momentum 5j % | momentum 30j % | momentum 90j % | volatilité 30j % | force relative vs Composite % | tendance multi-horizon | liquidité | signaux prudent / équilibré / dynamique (score))");
    (m.stocks || []).forEach(function (st) {
      var ind = st.indicateurs || {}, r = st.recommandations || {};
      function sig(k) { return r[k] ? r[k].signal + " (" + numOrDash(r[k].score) + ")" : "—"; }
      out.push([st.symbole, st.nom, st.secteur, st.pays, numOrDash(st.cours_cloture, 0), numOrDash(st.variation_pct), numOrDash(st.volume, 0),
        numOrDash(ind.volume_ratio), numOrDash(ind.momentum_pct), numOrDash(ind.momentum_moyen_pct), numOrDash(ind.momentum_long_pct),
        numOrDash(ind.volatilite_pct), numOrDash(ind.force_relative_pct), ind.tendance_alignement || "—",
        ind.liquidite_insuffisante ? "INSUFFISANTE" : "ok", sig("prudent") + " / " + sig("equilibre") + " / " + sig("dynamique")].join(" | "));
    });

    if (previous && previous.stocks) {
      var prevBySymb = {};
      previous.stocks.forEach(function (p) { prevBySymb[p.symbole] = p; });
      var changes = [];
      (m.stocks || []).forEach(function (st) {
        var p = prevBySymb[st.symbole];
        var a = p && p.recommandations && p.recommandations[profile], b = st.recommandations && st.recommandations[profile];
        if (a && b && a.signal !== b.signal) changes.push(st.symbole + " : " + a.signal + " → " + b.signal);
      });
      out.push("");
      out.push("### Changements de signal (profil " + labelForProfile(profile).toLowerCase() + ") depuis la séance précédente (" + previous.asOfDate + ")");
      out.push(changes.length ? changes.join("\n") : "Aucun changement de signal.");
    }

    var settings = aiSettings();
    if (settings.includePortfolio) {
      var portfolio = state.user.portfolio || [], watch = state.user.watchlist || [];
      if (portfolio.length) {
        var b = concentrationBreakdown();
        out.push("");
        out.push("### Portefeuille de l'investisseur (symbole | quantité | PRU FCFA | cours FCFA | plus/moins-value % | poids % | signal du profil)");
        portfolio.forEach(function (pos) {
          var st = findStock(pos.symbole);
          var cours = st ? st.cours_cloture : null;
          var val = cours != null ? cours * pos.quantite : pos.prix_achat * pos.quantite;
          var pnlPct = cours != null && pos.prix_achat ? (cours / pos.prix_achat - 1) * 100 : null;
          out.push([pos.symbole, pos.quantite, pos.prix_achat, numOrDash(cours, 0), numOrDash(pnlPct), numOrDash(b.totalVal ? val / b.totalVal * 100 : null, 1),
            st ? st.recommandations[profile].signal : "—"].join(" | "));
        });
        out.push("Répartition sectorielle : " + b.secteurs.map(function (e) { return e.label + " " + e.pct.toFixed(0) + " %"; }).join(", ") + ".");
        out.push("Répartition par pays : " + b.pays.map(function (e) { return e.label + " " + e.pct.toFixed(0) + " %"; }).join(", ") + ".");
      }
      if (watch.length) {
        out.push("");
        out.push("### Liste de suivi de l'investisseur : " + watch.join(", "));
      }
      if (!portfolio.length && !watch.length) {
        out.push("");
        out.push("L'investisseur n'a renseigné ni portefeuille ni liste de suivi : omets la section correspondante.");
      }
    } else {
      out.push("");
      out.push("L'investisseur n'a pas souhaité partager son portefeuille : omets la section correspondante.");
    }
    out.push("");
    out.push("Rédige l'analyse de cette séance.");
    return out.join("\n");
  }

  function previousArchiveDate() {
    var cur = state.market.asOfDate;
    var prev = (state.archiveIndex || []).filter(function (e) { return e.date < cur; })[0];
    return prev ? prev.date : null;
  }

  function runAiAnalysis() {
    var settings = aiSettings();
    if (!settings.apiKey) { state.ai.settingsOpen = true; render(); return; }
    var model = AI_MODELS.filter(function (x) { return x.id === settings.model; })[0] || AI_MODELS[0];
    var forKey = aiCacheKey();
    state.ai = { running: true, text: "", status: "Préparation des données…", error: null, meta: null, settingsOpen: false };
    render();

    var prevDate = previousArchiveDate();
    var prevPromise = prevDate ? fetchArchive(prevDate).catch(function () { return null; }) : Promise.resolve(null);
    prevPromise.then(function (previous) {
      var body = {
        model: model.id,
        max_tokens: 16000,
        stream: true,
        system: AI_SYSTEM_PROMPT,
        output_config: { effort: "medium" },
        messages: [{ role: "user", content: buildAiPrompt(previous) }]
      };
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
      setAiStatus("L'IA analyse la séance…");
      return fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: headers, body: JSON.stringify(body) });
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          var msg = "";
          try { msg = JSON.parse(t).error.message; } catch (e) { msg = t.slice(0, 200); }
          if (resp.status === 401) msg = "Clé API refusée (401). Vérifiez-la dans les paramètres.";
          else if (resp.status === 429) msg = "Limite de débit atteinte (429), réessayez dans un instant. " + msg;
          else if (resp.status === 529 || resp.status >= 500) msg = "Service momentanément surchargé (" + resp.status + "), réessayez dans un instant.";
          throw new Error(msg);
        });
      }
      return readSse(resp.body, function (ev) {
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          state.ai.text += ev.delta.text;
          setAiStatus("Rédaction en cours…");
          scheduleAiOutputUpdate();
        } else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) {
          state.ai.stopReason = ev.delta.stop_reason;
        } else if (ev.type === "error") {
          throw new Error((ev.error && ev.error.message) || "Erreur pendant la génération.");
        }
      });
    }).then(function () {
      if (state.ai.stopReason === "refusal") throw new Error("Le modèle a refusé de traiter cette demande.");
      if (!state.ai.text) throw new Error("Réponse vide.");
      if (state.ai.stopReason === "max_tokens") state.ai.text += "\n\n*(Analyse tronquée : limite de longueur atteinte.)*";
      var meta = { model: model.id, at: new Date().toISOString(), date: state.market.asOfDate, profile: state.user.riskProfile };
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
      if (err instanceof TypeError) state.ai.error = "Impossible de joindre l'API Claude (réseau ou blocage du navigateur). " + state.ai.error;
      render();
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

  function renderAiPanel() {
    var settings = aiSettings();
    var ai = state.ai;
    var box = el("section", { class: "panel ai-panel" }, [
      el("div", { class: "ai-head" }, [
        el("h2", {}, ["Analyse IA de la séance"]),
        el("button", { class: "link-btn", onclick: function () { state.ai.settingsOpen = !state.ai.settingsOpen; render(); } },
          [settings.apiKey ? "Paramètres" : "Configurer"])
      ])
    ]);
    if (ai.settingsOpen || (!settings.apiKey && !ai.text)) {
      if (!ai.settingsOpen) {
        box.appendChild(el("p", { class: "muted small" }, [
          "Obtenez une lecture commentée de la séance : ce qui compte vraiment, les signaux automatiques à relativiser, et ce que cela implique pour votre profil et votre portefeuille."
        ]));
      }
      box.appendChild(renderAiSettings(settings));
      if (!ai.text) return box;
    }

    var portfolioToggle = el("input", { type: "checkbox", id: "ai-include-portfolio" });
    portfolioToggle.checked = settings.includePortfolio;
    portfolioToggle.addEventListener("change", function () { saveAiSettings({ includePortfolio: portfolioToggle.checked }); });
    box.appendChild(el("div", { class: "ai-actions" }, [
      el("button", { class: "btn", disabled: ai.running ? "disabled" : null, onclick: runAiAnalysis }, [
        ai.running ? "Analyse en cours…" : (ai.text ? "Relancer l'analyse" : "✦ Analyser la séance avec l'IA")
      ]),
      el("label", { class: "small ai-check", for: "ai-include-portfolio" }, [portfolioToggle, " Inclure mon portefeuille et ma liste de suivi"])
    ]));

    if (ai.running) box.appendChild(el("p", { class: "muted small ai-status", id: "ai-status" }, [ai.status]));
    if (ai.error) box.appendChild(el("p", { class: "small concentration-warning" }, ["⚠ " + ai.error]));
    if (ai.text) {
      box.appendChild(el("div", { class: "ai-output", id: "ai-output", html: renderMarkdown(ai.text) }));
      if (!ai.running && ai.meta) {
        var modelLabel = (AI_MODELS.filter(function (x) { return x.id === ai.meta.model; })[0] || { label: ai.meta.model }).label.split(" — ")[0];
        box.appendChild(el("div", { class: "ai-foot" }, [
          el("span", { class: "muted small" }, [
            "Générée le " + new Date(ai.meta.at).toLocaleString("fr-FR") + " par " + modelLabel + " (profil " + labelForProfile(ai.meta.profile).toLowerCase() + "). "
          ]),
          el("button", { class: "link-btn small", onclick: function () {
            downloadBlob("analyse-ia-brvm-" + ai.meta.date + ".md", "text/markdown;charset=utf-8", "# Analyse IA — " + (state.market.asOfLabel || ai.meta.date) + "\n\n" + ai.text);
          } }, ["Télécharger (.md)"])
        ]));
      }
      box.appendChild(el("p", { class: "disclaimer" }, [
        "Analyse générée automatiquement par une IA à partir des seules données affichées ici : elle peut contenir des erreurs et ne constitue pas un conseil en investissement."
      ]));
    } else if (!ai.running && !ai.error) {
      box.appendChild(el("p", { class: "muted small" }, [
        "Commentaire de la séance du " + (state.market.asOfLabel || "jour") + " pour le profil " + labelForProfile(state.user.riskProfile).toLowerCase() +
        " : faits marquants, signaux fragiles, points d'attention pour votre portefeuille."
      ]));
    }
    return box;
  }

  function renderRoot() {
    var root = document.getElementById("root");
    root.innerHTML = "";
    root.appendChild(renderHeader());
    var main = el("main", { class: "layout" });
    if (state.view.date) root.appendChild(renderArchiveBanner());
    var left = el("div", { class: "col-main" }, [renderSynthese(), renderAiPanel(), renderMethodology(), renderMarketTable()]);
    var right = el("div", { class: "col-side" }, [renderProfileSwitcher(), renderPortfolio(), renderConcentration(), renderWatchlist(), renderArchives()]);
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
      state.live = JSON.parse(document.getElementById("market-data").textContent);
    } catch (e) { state.live = { indices: [], stocks: [], history: {}, stats: {} }; }
    state.market = state.live;
    try {
      state.archiveIndex = JSON.parse(document.getElementById("archive-index").textContent) || [];
    } catch (e) { state.archiveIndex = []; }
    state.user = loadUserState();
    if (!state.user.riskProfile) state.user.riskProfile = "equilibre";
    if (!state.user.portfolio) state.user.portfolio = [];
    if (!state.user.watchlist) state.user.watchlist = [];
    loadCachedAi();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
