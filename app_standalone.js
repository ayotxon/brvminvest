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
    var left = el("div", { class: "col-main" }, [renderSynthese(), renderAiPanel(), renderDocuments(), renderMethodology(), renderMarketTable()]);
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
    loadDocs();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
