/* =========================================================================
   DRILLS - Oriol's own library of exercises (27/11/2026: "una nueva sección que solamente veo yo que se llama
   drills... quiero poder subir de manera rápida drills, manual o de manera automática, por ahora solo drills de
   tiro. Es una biblioteca de ejercicios que arriba hay unos botones que permiten seleccionar el tipo de ejercicio
   que busco con diferentes clasificaciones... ir metiendo allí para rescatarlos cuando los necesite").

   Three ways in:
   - by hand, in the editor;
   - by pasting a link or a drill's text: the title, the description, the links, the minutes, the players and the
     classification are filled from it, to be checked and saved (several drills pasted at once can go in together);
   - from the session sheets in Drive (folder practicedoc): every sheet is read the way Planning's "Import PDF"
     reads one (_sheetBlocks), and its shooting blocks are offered, day by day, to be ticked in.

   Only the admin sees it (canView in index.html). One document on the server, "oriol:drills:v1"
   ({ v, list:[drill], sheets:{ fileId:{ d, n, at } } }), read again just before every write so nothing written
   from another device is lost; a drill's picture is a document of its own, "oriol:drills:img:<id>", read when
   the drill is on screen.
   A drill: { id, t, d, cat:"shoot", tg:{ type:[], zone:[], org:[], def:[] }, pl, min, links:[], img, fav,
   src:{ k:"hand"|"paste"|"sheet", file, date, key }, used:[dates], at, up }
   ========================================================================= */
(function () {
  "use strict";
  var DOC = "oriol:drills:v1", IMG = "oriol:drills:img:";

  /* ------------------------------------------------------------ the classification */
  /* each option: key, label, the words that give it away (English, Spanish, German - the way the staff write) */
  var GROUPS = [
    { k: "type", l: "Shot type", o: [
      ["cs", "Catch & shoot", /\bcatch\b|\bc\s*&\s*s\b|spot.?ups?\b|kick.?outs?|drive (and|&|n) kick|recepci[oó]n|pass(ing)? and shoot/i],
      ["drib", "Off the dribble", /off the dribble|pull.?ups?|step.?backs?|side.?steps?|\bdribble|\bbote\b|\b1\s*(on|x|v|vs)\s*1\b/i],
      ["scr", "Off screens", /off (the )?(scr|sc)\b|off screens?|pin.?downs?|\bflares?\b|\bcurls?\b|staggers?|floppy|\bflash\b|\bdho|hand.?offs?|indirect|bloqueo indirecto/i],
      ["pnr", "Pick & roll", /pick.?(and|&|n)?.?(roll|pop)|\bp\s*&\s*r\b|\bpnr\b|ball screens?|bloqueo directo|\bp\s*and\s*c\b|pandc/i],
      ["fin", "Finishing", /lay.?ups?|finish|mikan|euro.?step|floaters?|bandeja|reverse lay/i],
      ["ft", "Free throws", /free throws?|tiros? libres?|\bft\b|foul shots?|freiw/i]] },
    { k: "zone", l: "Zone", o: [
      ["rim", "Rim", /\brim\b|lay.?ups?|\bpaint\b|\baro\b|finish|mikan|close range/i],
      ["mid", "Mid-range", /mid.?range|\bmid\b|elbows?|\bcodos?\b|media distancia|short corner|jumpers?|\b2\s*-?\s*pt/i],
      ["c3", "Corner 3", /corners?|esquinas?|\becke/i],
      ["w3", "Wing 3", /\bwings?\b|\b45\b|\balas?\b|\bslots?\b/i],
      ["t3", "Top 3", /\btop\b|frontal|top of the key/i]] },
    { k: "org", l: "Organization", o: [
      ["ind", "Individual", /individual|\b1 player|\balone\b|\bsolo\b|on his own|by himself/i],
      ["pair", "Pairs", /\bpairs?\b|partners?|\b2 players|parejas|in 2s|two players|passer and shooter/i],
      ["grp", "Small groups", /\bgroups?\b|grupos|\b[34] players|\blines\b|filas|\btrios?\b|in 3s|teams of [34]/i],
      ["team", "Whole team", /whole team|full team|all players|todo el equipo|full squad|\b5\s*on\s*[05]\b|team shooting/i],
      ["mach", "Machine", /machine|\bgun\b|m[aá]quina|rebounder/i]] },
    { k: "def", l: "Defense & intensity", o: [
      ["warm", "Warm-up", /warm.?up|calentamiento|form shooting|activation/i],
      ["nod", "No defense", /no def|without def|unguarded|sin defensa|\b[0-5]\s*(on|v|vs|x)\s*0\b|\bvs\.? ?0\b/i],
      ["clo", "Closeout", /close.?outs?|contest|cierres?\b/i],
      ["con", "Contact", /contact|\bbump|\bpads?\b|contacto|physical|chuck/i],
      ["comp", "Competitive", /compet|\bgame\b|points?\b|\bscore|\brace\b|\bbeat\b|in a row|consecutive|objetivo|\breto\b|challenge|winner|loser|makes? in \d|\bvs\.? (the )?clock/i]] }
  ];
  var THREE = /\b3\s*-?\s*(pt|point|pointers?)s?\b|\bthrees?\b|\btriples?\b|\b3s\b|dreier/i;
  /* a block of a session sheet that is a shooting drill - the title decides it, "5on5 FT" is not one */
  var SHOOT = /shoot|\btiro|\bwurf|\bthrees?\b|\b3\s*pt|free throws?|catch (and|&) shoot|spot.?up|lay.?ups?|finishing/i;

  function optLabel(g, k) { for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].k === g) for (var j = 0; j < GROUPS[i].o.length; j++) if (GROUPS[i].o[j][0] === k) return GROUPS[i].o[j][1]; return k; }
  function classify(text) {
    var s = String(text || ""), tg = {};
    GROUPS.forEach(function (g) { tg[g.k] = g.o.filter(function (o) { return o[2].test(s); }).map(function (o) { return o[0]; }); });
    /* a three with no spot named is the whole arc */
    if (THREE.test(s) && !tg.zone.some(function (z) { return /3$/.test(z); })) tg.zone = tg.zone.concat(["c3", "w3", "t3"]);
    return tg;
  }

  /* ------------------------------------------------------------ reading what was pasted */
  var URL_RE = /https?:\/\/[^\s<>"')]+/gi;
  function ytId(u) {
    var m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([A-Za-z0-9_-]{11})/.exec(String(u || ""));
    return m ? m[1] : "";
  }
  function firstYt(links) { for (var i = 0; i < (links || []).length; i++) { var y = ytId(links[i]); if (y) return y; } return ""; }
  function cleanLine(s) { return String(s || "").replace(/^\s*(?:[-–•*·]|\d{1,2}[.)])\s*/, "").replace(/\s+/g, " ").trim(); }
  /* one drill out of a piece of text: { t, d, links, min, pl, tg } */
  function fromText(txt) {
    var s = String(txt || "").replace(/\r/g, "");
    var links = (s.match(URL_RE) || []).filter(function (u, i, a) { return a.indexOf(u) === i; });
    var lines = s.split("\n").map(function (l) { return l.replace(URL_RE, "").trim(); }).filter(function (l) { return l && !/^[-–•*·]+$/.test(l); });
    var t = "", rest = lines.slice();
    if (lines.length) {
      var f = cleanLine(lines[0]);
      if (f.length <= 80) { t = f; rest = lines.slice(1); }
      else { var m = /^(.{8,70}?[.!?:])\s/.exec(f); t = m ? m[1].replace(/[.:]$/, "") : f.slice(0, 60).replace(/\s+\S*$/, "") + "…"; }
    }
    var mm = /(\d{1,3})\s*(?:min\b|mins\b|minutes|minutos|minuten|['´’])/i.exec(s);
    var pp = /(\d{1,2})\s*(?:players|jugadores|spieler|guys|shooters)\b/i.exec(s);
    return { t: t, d: rest.join("\n"), links: links, min: mm ? +mm[1] : null, pl: pp ? pp[1] + " players" : "", tg: classify(s) };
  }
  /* several drills pasted at once: blank lines between them, or a numbered list */
  function splitDrills(txt) {
    var s = String(txt || "").replace(/\r/g, "").trim();
    if (!s) return [];
    var parts = s.split(/\n\s*\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length < 2) {
      var num = s.split(/\n(?=\s*\d{1,2}[.)]\s+\S)/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (num.length >= 2 && /^\s*\d{1,2}[.)]\s/.test(num[0])) parts = num;
    }
    return parts.length >= 2 ? parts : [];
  }

  /* ------------------------------------------------------------ the server */
  var KIND = (typeof CLUB_DOC_KIND !== "undefined") ? CLUB_DOC_KIND : "settings";
  var D = { doc: null, at: 0, busy: null, err: "", img: {}, imgBusy: {} };
  function normDoc(d) {
    d = (d && typeof d === "object") ? d : {};
    return { v: 1, list: Array.isArray(d.list) ? d.list.filter(Boolean) : [], sheets: (d.sheets && typeof d.sheets === "object") ? d.sheets : {} };
  }
  function getRaw(key) {
    return _sbRaw("get_report", { p_token: SB_TOKEN, p_key: key }).then(function (t) {
      var r = JSON.parse(t);
      /* only a clear answer is an answer: a library that could not be read is never taken for an empty one */
      if (!r || r.ok !== true) throw new Error((r && r.error) || "the server did not answer");
      return r.report ? r.report.data : null;
    });
  }
  function putRaw(key, data) {
    return _sbRaw("save_report", { p_token: SB_TOKEN, p_key: key, p_kind: KIND, p_opponent: "", p_date: null, p_data: data, p_html: null }).then(function (t) {
      var w = JSON.parse(t);
      if (!w || w.ok !== true) throw new Error((w && w.error) || "the server did not keep it");
      return true;
    });
  }
  function read() { return getRaw(DOC).then(normDoc); }
  function edit(fn) {
    return read().then(function (doc) { fn(doc); return putRaw(DOC, doc).then(function () { return doc; }); })
      .then(function (doc) { D.doc = doc; D.at = Date.now(); D.err = ""; return doc; });
  }
  function load(force) {
    if (!SB_TOKEN) return Promise.resolve(false);
    if (D.busy) return D.busy;
    if (!force && D.doc && Date.now() - D.at < 30000) return Promise.resolve(false);
    D.busy = read().then(function (doc) { D.doc = doc; D.at = Date.now(); D.err = ""; return true; },
      function (e) { D.err = (e && e.message) || String(e); return false; })
      .then(function (x) { D.busy = null; return x; });
    return D.busy;
  }
  function getImg(id) {
    if (D.img[id] !== undefined) return Promise.resolve(D.img[id]);
    if (D.imgBusy[id]) return D.imgBusy[id];
    D.imgBusy[id] = getRaw(IMG + id).then(function (d) { D.img[id] = (d && d.img) || null; return D.img[id]; },
      function () { return null; }).then(function (x) { delete D.imgBusy[id]; return x; });
    return D.imgBusy[id];
  }
  function putImg(id, data) { D.img[id] = data || null; return putRaw(IMG + id, { img: data || null, at: new Date().toISOString() }); }

  /* ------------------------------------------------------------ small helpers */
  function el(t, p) { return h.apply(null, arguments); }
  function nrm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(); }
  function day(iso) { try { return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }); } catch (e) { return iso || ""; } }
  function dayLong(iso) { try { return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); } catch (e) { return iso || ""; } }
  function busyBtn(b, txt) { if (!b) return function () {}; var was = b.textContent; b.disabled = true; b.textContent = txt; return function () { b.disabled = false; b.textContent = was; }; }
  function F() {
    var f = state.ui.drf = state.ui.drf || {};
    f.q = f.q || ""; f.tg = f.tg || {}; f.sort = f.sort || "new";
    GROUPS.forEach(function (g) { f.tg[g.k] = Array.isArray(f.tg[g.k]) ? f.tg[g.k] : []; });
    return f;
  }
  function tagsOf(x) { var tg = x.tg || {}; return GROUPS.map(function (g) { return { g: g.k, o: (tg[g.k] || []) }; }); }
  /* a drill passes the filters; skip names a group whose own buttons are left out (to count them) */
  function passes(x, f, skip) {
    if (f.fav && !x.fav) return false;
    for (var i = 0; i < GROUPS.length; i++) {
      var g = GROUPS[i].k, sel = f.tg[g]; if (g === skip || !sel.length) continue;
      var have = (x.tg && x.tg[g]) || [];
      if (!sel.some(function (k) { return have.indexOf(k) >= 0; })) return false;
    }
    if (f.q) {
      var hay = nrm([x.t, x.d, x.pl, (x.links || []).join(" "), tagsOf(x).map(function (t) { return t.o.map(function (k) { return optLabel(t.g, k); }).join(" "); }).join(" ")].join(" "));
      var ok = nrm(f.q).split(" ").every(function (w) { return hay.indexOf(w) >= 0; });
      if (!ok) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------ the screen */
  var ROOT = null;
  function render(root) {
    ROOT = root || ROOT || document.getElementById("viewDrills");
    if (!ROOT) return;
    ROOT.innerHTML = "";
    var wrap = el("div", { class: "drl" }); ROOT.appendChild(wrap);
    if (typeof isAdmin !== "function" || !isAdmin()) { wrap.appendChild(el("div", { class: "drl-empty" }, "This section is Oriol's own.")); return; }
    var f = F();
    var list = (D.doc && D.doc.list) || [];

    /* the head: the name, how many, the three ways in */
    var add = el("button", { class: "btn primary", type: "button", onclick: function () { openEditor(null, null); } }, "＋ New drill");
    var sh = el("button", { class: "btn", type: "button", onclick: openSheets }, "From the session sheets");
    wrap.appendChild(el("div", { class: "drl-head" },
      el("div", { class: "drl-title" }, el("h2", {}, "Drills"), el("span", { class: "drl-cat" }, "Shooting"),
        el("span", { class: "drl-n" }, D.doc ? (list.length + " drill" + (list.length === 1 ? "" : "s")) : "")),
      el("div", { class: "drl-acts" }, sh, add)));

    /* the quickest way in: paste a link or a drill's text, the editor opens filled */
    var qi = el("textarea", { class: "drl-quick-in", rows: "1", placeholder: "Paste a YouTube link or a drill's text here - the title, the description and the classification fill themselves" });
    var go = function () { var v = qi.value.trim(); if (!v) return; qi.value = ""; openEditor(null, v); };
    qi.addEventListener("paste", function () { setTimeout(go, 0); });
    qi.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });
    wrap.appendChild(el("div", { class: "drl-quick" }, el("span", { class: "drl-quick-k" }, "Quick add"), qi,
      el("button", { class: "btn", type: "button", onclick: go }, "Fill a drill")));

    if (!D.doc) {
      if (D.err) {
        wrap.appendChild(el("div", { class: "drl-empty err" }, "The library could not be read: " + D.err + " ",
          el("button", { class: "btn sm", type: "button", onclick: function () { D.err = ""; load(true).then(function () { render(); }); } }, "Try again")));
      } else {
        wrap.appendChild(el("div", { class: "ld" }, "Reading the library…", el("span", { class: "ld-bar" })));
        load(false).then(function () { if (state.ui.view === "drills") render(); });
      }
      return;
    }

    /* the buttons that choose: a search, then one row a classification, each button with how many it would leave */
    var bar = el("div", { class: "drl-filt" });
    var q = el("input", { type: "search", class: "drl-q", placeholder: "Search a word…", value: f.q });
    var qT = 0;
    q.addEventListener("input", function () { clearTimeout(qT); qT = setTimeout(function () { f.q = q.value; persist(); draw(); }, 160); });
    var favB = el("button", { type: "button", class: "drl-chip fav" + (f.fav ? " on" : ""), onclick: function () { f.fav = !f.fav; persist(); render(); } }, "★ Favourites");
    var sortS = el("select", { class: "drl-sort", onchange: function () { f.sort = sortS.value; persist(); draw(); } },
      el("option", { value: "new" }, "Newest first"), el("option", { value: "az" }, "A – Z"), el("option", { value: "used" }, "Most used"));
    sortS.value = f.sort;
    var anyOn = f.fav || f.q || GROUPS.some(function (g) { return f.tg[g.k].length; });
    var clr = el("button", { type: "button", class: "drl-clear", onclick: function () { f.q = ""; f.fav = false; GROUPS.forEach(function (g) { f.tg[g.k] = []; }); persist(); render(); } }, "Clear all");
    if (!anyOn) clr.style.visibility = "hidden";
    /* cards or a list - the same drills, the same order */
    var viewSeg = el("div", { class: "drl-seg", role: "group", "aria-label": "Show as" });
    [["cards", "▦ Cards"], ["list", "☰ List"]].forEach(function (v) {
      viewSeg.appendChild(el("button", { type: "button", class: (f.view || "cards") === v[0] ? "on" : "", onclick: function () { f.view = v[0]; persist(); render(); } }, v[1])); });
    bar.appendChild(el("div", { class: "drl-frow top" }, q, favB, sortS, viewSeg, clr));
    GROUPS.forEach(function (g) {
      var row = el("div", { class: "drl-frow" }, el("span", { class: "drl-fk" }, g.l));
      var sel = f.tg[g.k];
      g.o.forEach(function (o) {
        var n = list.filter(function (x) { return passes(x, f, g.k) && ((x.tg && x.tg[g.k]) || []).indexOf(o[0]) >= 0; }).length;
        var on = sel.indexOf(o[0]) >= 0;
        row.appendChild(el("button", { type: "button", class: "drl-chip" + (on ? " on" : "") + (!n && !on ? " zero" : ""),
          onclick: function () { var i = sel.indexOf(o[0]); if (i >= 0) sel.splice(i, 1); else sel.push(o[0]); persist(); render(); } },
          o[1], el("em", {}, String(n))));
      });
      bar.appendChild(row);
    });
    wrap.appendChild(bar);

    var asList = f.view === "list";
    var grid = el("div", { class: asList ? "drl-list" : "drl-grid" }), note = el("div", { class: "drl-count" });
    wrap.appendChild(note); wrap.appendChild(grid);
    function draw() {
      var rows = list.filter(function (x) { return passes(x, f, null); });
      if (f.sort === "az") rows.sort(function (a, b) { return nrm(a.t).localeCompare(nrm(b.t)); });
      else if (f.sort === "used") rows.sort(function (a, b) { return ((b.used || []).length - (a.used || []).length) || String(b.at || "").localeCompare(String(a.at || "")); });
      else rows.sort(function (a, b) { return String(b.at || "").localeCompare(String(a.at || "")); });
      grid.innerHTML = "";
      note.textContent = list.length ? (rows.length === list.length ? "" : rows.length + " of " + list.length) : "";
      if (!list.length) {
        grid.appendChild(el("div", { class: "drl-empty" },
          el("b", {}, "The library is empty."),
          el("span", {}, " Paste a link or a drill's text above, write one with ＋ New drill, or take the shooting blocks of the session sheets with From the session sheets.")));
        return;
      }
      if (!rows.length) { grid.appendChild(el("div", { class: "drl-empty" }, "No drill has all of that. Take a button off or clear them all.")); return; }
      if (asList) {
        var hd = el("div", { class: "drl-row drl-rh" });
        ["", "Drill", "Classification", "Min", "Players", "Used", "", ""].forEach(function (t) { hd.appendChild(el("span", {}, t)); });
        grid.appendChild(hd);
        rows.forEach(function (x) { grid.appendChild(row(x)); });
      } else rows.forEach(function (x) { grid.appendChild(card(x)); });
    }
    draw();
  }

  /* the court a drill without a picture shows, in the page's own colours */
  function courtSvg() {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 160 90"); s.setAttribute("class", "drl-court"); s.setAttribute("aria-hidden", "true");
    s.innerHTML = '<rect x="58" y="0" width="44" height="52" /><circle cx="80" cy="52" r="14" /><path d="M14 0 V22 A68 68 0 0 0 146 22 V0" /><circle cx="80" cy="9" r="3.5" /><line x1="72" y1="4" x2="88" y2="4" />';
    return s;
  }
  function media(x, big) {
    var box = el("div", { class: "drl-media" + (big ? " big" : "") });
    var y = firstYt(x.links);
    if (y) {
      box.classList.add("yt");
      box.appendChild(el("img", { src: "https://i.ytimg.com/vi/" + y + "/mqdefault.jpg", alt: "", loading: "lazy" }));
      box.appendChild(el("span", { class: "drl-play", "aria-hidden": "true" }, "▶"));
    } else if (x.img) {
      box.appendChild(courtSvg());
      getImg(x.id).then(function (src) { if (src) { box.innerHTML = ""; box.appendChild(el("img", { src: src, alt: "" })); } });
    } else if (!big && x.d) {
      /* no picture: the first lines of how it is done, which is what is looked for when choosing one */
      box.classList.add("txt");
      box.appendChild(el("p", { class: "drl-ex" }, x.d));
    } else box.appendChild(courtSvg());
    return box;
  }
  function chipsOf(x, max) {
    var out = el("div", { class: "drl-tags" }), n = 0, all = [];
    tagsOf(x).forEach(function (t) { t.o.forEach(function (k) { all.push([t.g, k]); }); });
    all.forEach(function (p) { if (max && n >= max) return; n++; out.appendChild(el("span", { class: "drl-tag g-" + p[0] }, optLabel(p[0], p[1]))); });
    if (max && all.length > max) out.appendChild(el("span", { class: "drl-tag more" }, "+" + (all.length - max)));
    return out;
  }
  function metaOf(x) {
    var bits = [];
    if (x.min) bits.push(x.min + " min");
    if (x.pl) bits.push(x.pl);
    if ((x.used || []).length) bits.push("used " + x.used.length + "×");
    return bits.join(" · ");
  }
  function srcWord(x) {
    var s = x.src || {};
    if (s.k === "sheet") return "Session sheet " + (s.date ? day(s.date) : "");
    if (s.k === "paste") return firstYt(x.links) ? "From a video" : "Pasted";
    return "";
  }
  /* THE DRILL AS A SMALL CARD (Oriol, 28/11/2026: "quiero fichas muy compactas, y diferentes formatos, lista o por
     fichas. En un futuro quisiera poder usar estas fichas para montar las sesiones de entrenamiento en una pantalla
     drag and drop"): the way the game cards are drawn - a badge of its kind of shot in its colour, the name, the
     minutes and the players, its tags on one line, the first line of how it is done. Every card and every row can
     be picked up and dropped: it carries { id, t, min } as "application/x-lowen-drill", which is what a session
     builder will take. */
  var TYPE_BADGE = { cs: ["C&S", "#2f6cc0"], drib: ["DRB", "#b8892f"], scr: ["SCR", "#2a8f8f"], pnr: ["PNR", "#7a5cc2"], fin: ["FIN", "#d9823b"], ft: ["FT", "#5b6472"] };
  function badge(x) {
    var k = ((x.tg && x.tg.type) || [])[0], b = TYPE_BADGE[k] || ["SHT", "#8a93a2"];
    var s = el("span", { class: "drl-bdg", title: k ? optLabel("type", k) : "Shooting" }, b[0]); s.style.background = b[1];
    return s;
  }
  function draggable(node, x) {
    node.setAttribute("draggable", "true");
    node.addEventListener("dragstart", function (e) {
      try {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/x-lowen-drill", JSON.stringify({ id: x.id, t: x.t || "", min: x.min || null }));
        e.dataTransfer.setData("text/plain", (x.t || "Drill") + (x.min ? " · " + x.min + " min" : ""));
      } catch (er) {}
      node.classList.add("drag");
    });
    node.addEventListener("dragend", function () { node.classList.remove("drag"); });
    return node;
  }
  function star(x) {
    return el("button", { type: "button", class: "drl-star" + (x.fav ? " on" : ""), title: x.fav ? "Favourite - take it off" : "Mark as favourite", "aria-label": "Favourite",
      onclick: function (e) { e.stopPropagation(); toggleFav(x.id); } }, "★");
  }
  function firstLine(x) { var d = String(x.d || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean); return d[0] || ""; }
  function card(x) {
    var c = el("article", { class: "drl-card", tabindex: "0", onclick: function () { openDrill(x.id); },
      onkeydown: function (e) { if (e.key === "Enter") openDrill(x.id); } });
    var y = firstYt(x.links);
    var top = el("div", { class: "drl-ctop" }, badge(x), el("h3", { class: "drl-ct" }, x.t || "Untitled drill"), star(x));
    c.appendChild(top);
    var m = metaOf(x), sw = srcWord(x);
    var meta = el("div", { class: "drl-meta" }, m || "", sw ? el("span", { class: "drl-src" }, sw) : null);
    if (y) meta.appendChild(el("span", { class: "drl-vid", title: "Has a video" }, "▶ video"));
    else if (x.img) meta.appendChild(el("span", { class: "drl-vid", title: "Has a picture" }, "▣ picture"));
    c.appendChild(meta);
    c.appendChild(chipsOf(x, 4));
    var fl = firstLine(x); if (fl) c.appendChild(el("p", { class: "drl-fl" }, fl));
    return draggable(c, x);
  }
  /* the same drill as one line of the list */
  function row(x) {
    var r = el("div", { class: "drl-row", tabindex: "0", onclick: function () { openDrill(x.id); },
      onkeydown: function (e) { if (e.key === "Enter") openDrill(x.id); } });
    r.appendChild(badge(x));
    r.appendChild(el("span", { class: "drl-rt" }, el("b", {}, x.t || "Untitled drill"), firstLine(x) ? el("i", {}, firstLine(x)) : null));
    r.appendChild(chipsOf(x, 3));
    r.appendChild(el("span", { class: "drl-rn" }, x.min ? x.min + "′" : "—"));
    r.appendChild(el("span", { class: "drl-rp" }, x.pl || "—"));
    r.appendChild(el("span", { class: "drl-rn" }, (x.used || []).length ? (x.used.length + "×") : "—"));
    r.appendChild(el("span", { class: "drl-rs" }, firstYt(x.links) ? "▶" : x.img ? "▣" : ""));
    r.appendChild(star(x));
    return draggable(r, x);
  }
  function byId(id) { return ((D.doc && D.doc.list) || []).filter(function (x) { return x.id === id; })[0] || null; }
  function toggleFav(id) {
    edit(function (doc) { doc.list.forEach(function (x) { if (x.id === id) x.fav = !x.fav; }); })
      .then(function () { render(); }, function (e) { toast("Not saved: " + ((e && e.message) || e)); });
  }

  /* ------------------------------------------------------------ one drill, open */
  function openDrill(id) {
    var x = byId(id); if (!x) return;
    var box = el("div", { class: "drl-dlg drl-view" });
    var y = firstYt(x.links);
    var head = el("div", { class: "drl-vh" }, el("h3", {}, x.t || "Untitled drill"),
      el("button", { type: "button", class: "drl-star big" + (x.fav ? " on" : ""), title: "Favourite", onclick: function () { toggleFav(x.id); closeDialog(); } }, "★"));
    box.appendChild(head);
    var m = metaOf(x); if (m) box.appendChild(el("div", { class: "drl-meta" }, m));
    box.appendChild(chipsOf(x, 0));
    if (y) {
      box.appendChild(el("div", { class: "drl-video" }, el("iframe", { src: "https://www.youtube.com/embed/" + y + "?rel=0", title: x.t || "Video", allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture", allowfullscreen: "true", loading: "lazy" })));
    } else if (x.img) {
      var pic = el("div", { class: "drl-pic" }, el("div", { class: "ld" }, "Loading the picture…"));
      box.appendChild(pic);
      getImg(x.id).then(function (src) { pic.innerHTML = ""; if (src) pic.appendChild(el("img", { src: src, alt: x.t || "" })); });
    }
    if (x.d) box.appendChild(el("div", { class: "drl-desc" }, x.d));
    if ((x.links || []).length) {
      var ls = el("div", { class: "drl-links" });
      x.links.forEach(function (u) { ls.appendChild(el("a", { href: u, target: "_blank", rel: "noopener" }, (ytId(u) ? "Open in YouTube ↗" : u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60) + " ↗"))); });
      box.appendChild(ls);
    }
    var s = x.src || {};
    var hist = [];
    if (s.k === "sheet") hist.push("From the session sheet of " + dayLong(s.date) + (s.coach ? " · " + s.coach : ""));
    if ((x.used || []).length > 1 || (x.used || []).length && s.k !== "sheet") hist.push("Worked on " + x.used.slice().sort().reverse().map(day).join(", "));
    if (x.at) hist.push("In the library since " + dayLong(String(x.at).slice(0, 10)));
    if (hist.length) box.appendChild(el("div", { class: "drl-hist" }, hist.join(" · ")));
    var del = el("button", { type: "button", class: "drl-del", onclick: function () {
      confirmDialog("Delete this drill?", "“" + (x.t || "Untitled drill") + "” leaves the library for good, its picture with it.", "Delete", function () {
        edit(function (doc) { doc.list = doc.list.filter(function (z) { return z.id !== x.id; }); })
          .then(function () { if (x.img) putImg(x.id, null).catch(function () {}); toast("Deleted"); render(); },
            function (e) { toast("Not deleted: " + ((e && e.message) || e)); });
      }, true); } }, "Delete");
    box.appendChild(el("div", { class: "dialog-foot" }, del, el("div", { class: "spacer" }),
      el("button", { type: "button", class: "btn", onclick: closeDialog }, "Close"),
      el("button", { type: "button", class: "btn primary", onclick: function () { openEditor(x, null); } }, "Edit")));
    openDialog(box);
  }

  /* ------------------------------------------------------------ the editor: by hand, or filled from what was pasted */
  function openEditor(x, pasted) {
    var isNew = !x;
    var dr = x ? JSON.parse(JSON.stringify(x)) : { id: uid(), t: "", d: "", cat: "shoot", tg: {}, pl: "", min: null, links: [], img: false, fav: false, src: { k: "hand" }, used: [] };
    GROUPS.forEach(function (g) { dr.tg[g.k] = Array.isArray(dr.tg[g.k]) ? dr.tg[g.k] : []; });
    var pic = { data: undefined, changed: false };   /* undefined: as it is; null: taken off */
    var dirty = {};
    var box = el("div", { class: "drl-dlg drl-ed" });
    box.appendChild(el("h3", {}, isNew ? "New drill" : "Edit drill"));

    /* what was pasted */
    var pin = el("textarea", { class: "drl-paste", rows: "3", placeholder: "Paste a YouTube or Instagram link, or the drill's text - from WhatsApp, a PDF, an email. It fills the fields below; check them and save." });
    var pnote = el("div", { class: "drl-pnote" });
    var splitBox = el("div", { class: "drl-split" });
    box.appendChild(el("div", { class: "drl-pbox" }, el("label", { class: "drl-lab" }, "Paste and it fills itself"), pin, pnote, splitBox));

    var tI = el("input", { type: "text", class: "drl-in", value: dr.t, placeholder: "Name of the drill" });
    tI.addEventListener("input", function () { dirty.t = 1; });
    box.appendChild(el("label", { class: "drl-lab" }, "Title"));
    box.appendChild(tI);

    var tagBox = el("div", { class: "drl-edtags" });
    function drawTags() {
      tagBox.innerHTML = "";
      GROUPS.forEach(function (g) {
        var row = el("div", { class: "drl-frow" }, el("span", { class: "drl-fk" }, g.l));
        g.o.forEach(function (o) {
          var on = dr.tg[g.k].indexOf(o[0]) >= 0;
          row.appendChild(el("button", { type: "button", class: "drl-chip" + (on ? " on" : ""), onclick: function () {
            var a = dr.tg[g.k], i = a.indexOf(o[0]); if (i >= 0) a.splice(i, 1); else a.push(o[0]); drawTags(); } }, o[1]));
        });
        tagBox.appendChild(row);
      });
    }
    drawTags();
    box.appendChild(el("label", { class: "drl-lab" }, "Classification"));
    box.appendChild(tagBox);

    var plI = el("input", { type: "text", class: "drl-in", value: dr.pl || "", placeholder: "e.g. 3 players, 2 balls" });
    var mnI = el("input", { type: "number", min: "0", max: "200", class: "drl-in", value: dr.min == null ? "" : String(dr.min), placeholder: "min" });
    plI.addEventListener("input", function () { dirty.pl = 1; }); mnI.addEventListener("input", function () { dirty.min = 1; });
    box.appendChild(el("div", { class: "drl-two" },
      el("div", {}, el("label", { class: "drl-lab" }, "Players"), plI),
      el("div", {}, el("label", { class: "drl-lab" }, "Minutes"), mnI)));

    var dI = el("textarea", { class: "drl-in", rows: "6", placeholder: "How it works: the spots, the passes, the rules, the score that wins it" });
    dI.value = dr.d || "";
    dI.addEventListener("input", function () { dirty.d = 1; });
    box.appendChild(el("label", { class: "drl-lab" }, "Description"));
    box.appendChild(dI);

    var lI = el("textarea", { class: "drl-in", rows: "2", placeholder: "One link a line" });
    lI.value = (dr.links || []).join("\n");
    lI.addEventListener("input", function () { dirty.links = 1; });
    box.appendChild(el("label", { class: "drl-lab" }, "Links"));
    box.appendChild(lI);

    /* the picture: pasted, dropped or chosen - a drawing of the drill, a screenshot */
    var pv = el("div", { class: "drl-pv" });
    var fileI = el("input", { type: "file", accept: "image/*", style: "display:none" });
    var drop = el("div", { class: "drl-drop", tabindex: "0" }, pv);
    function drawPic() {
      pv.innerHTML = "";
      var src = pic.data !== undefined ? pic.data : (dr.img ? D.img[dr.id] : null);
      if (src) {
        pv.appendChild(el("img", { src: src, alt: "" }));
        pv.appendChild(el("button", { type: "button", class: "btn sm", onclick: function (e) { e.stopPropagation(); pic.data = null; pic.changed = true; drawPic(); } }, "Take the picture off"));
      } else pv.appendChild(el("span", {}, "Paste a picture here (Ctrl+V), drop one, or ", el("u", {}, "choose a file")));
    }
    function takeFile(file) {
      if (!file || !/^image\//.test(file.type || "")) return;
      pv.innerHTML = ""; pv.appendChild(el("span", {}, "Reading the picture…"));
      _rtImageData(file).then(function (data) { pic.data = data; pic.changed = true; drawPic(); }, function (e) { toast((e && e.message) || "The picture could not be read"); drawPic(); });
    }
    drop.addEventListener("click", function () { fileI.click(); });
    fileI.addEventListener("change", function () { takeFile(fileI.files && fileI.files[0]); fileI.value = ""; });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
    drop.addEventListener("drop", function (e) { e.preventDefault(); drop.classList.remove("over"); takeFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });
    box.addEventListener("paste", function (e) {
      var it = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
      if (it && /^image\//.test(it.type || "")) { e.preventDefault(); takeFile(it); }
    });
    if (dr.img && D.img[dr.id] === undefined) getImg(dr.id).then(drawPic);
    drawPic();
    box.appendChild(el("label", { class: "drl-lab" }, "Picture"));
    box.appendChild(drop); box.appendChild(fileI);

    /* fill from what was pasted: what the coach has typed himself is never overwritten */
    function fillFrom(txt) {
      var r = fromText(txt);
      if (!dirty.t && r.t) tI.value = r.t;
      if (!dirty.d && r.d) dI.value = r.d;
      if (!dirty.links && r.links.length) lI.value = r.links.join("\n");
      if (!dirty.min && r.min != null) mnI.value = String(r.min);
      if (!dirty.pl && r.pl) plI.value = r.pl;
      GROUPS.forEach(function (g) { (r.tg[g.k] || []).forEach(function (k) { if (dr.tg[g.k].indexOf(k) < 0) dr.tg[g.k].push(k); }); });
      drawTags();
      if (isNew) dr.src = { k: "paste" };
      var n = GROUPS.reduce(function (a, g) { return a + (r.tg[g.k] || []).length; }, 0);
      pnote.textContent = "Filled from what you pasted · " + n + " classification" + (n === 1 ? "" : "s") + " found · check it and save";
      /* a video: its own title, if the field is still the pasted text's */
      var y = firstYt(r.links);
      if (y && !dirty.t) {
        fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + y))
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (j) { if (j && j.title && !dirty.t && (!r.t || r.t === tI.value)) { tI.value = j.title; if (!r.t || !dI.value) { var c = classify(j.title); GROUPS.forEach(function (g) { (c[g.k] || []).forEach(function (k) { if (dr.tg[g.k].indexOf(k) < 0) dr.tg[g.k].push(k); }); }); drawTags(); } } })
          .catch(function () {});
      }
      /* several drills in one paste */
      splitBox.innerHTML = "";
      var parts = isNew ? splitDrills(txt) : [];
      if (parts.length >= 2) {
        var b = el("button", { type: "button", class: "btn", onclick: function () { saveMany(parts, b); } }, "Add them as " + parts.length + " drills");
        splitBox.appendChild(el("span", {}, "This looks like " + parts.length + " drills, not one. "));
        splitBox.appendChild(b);
      }
    }
    var pT = 0;
    pin.addEventListener("input", function () { clearTimeout(pT); pT = setTimeout(function () { if (pin.value.trim()) fillFrom(pin.value); }, 250); });

    var saveB = el("button", { type: "button", class: "btn primary" }, isNew ? "Save drill" : "Save");
    var msg = el("span", { class: "drl-msg" });
    saveB.onclick = function () {
      dr.t = tI.value.trim(); dr.d = dI.value.trim(); dr.pl = plI.value.trim();
      dr.min = mnI.value === "" ? null : Math.max(0, Math.round(+mnI.value || 0)) || null;
      dr.links = lI.value.split(/\s*\n\s*/).map(function (u) { return u.trim(); }).filter(function (u) { return /^https?:\/\//i.test(u); });
      if (!dr.t) { msg.textContent = "Give it a name first."; tI.focus(); return; }
      var done = busyBtn(saveB, "Saving…"); msg.textContent = "";
      var now = new Date().toISOString();
      var first = pic.changed ? putImg(dr.id, pic.data) : Promise.resolve(true);
      if (pic.changed) dr.img = !!pic.data;
      first.then(function () {
        return edit(function (doc) {
          if (isNew) { dr.at = now; dr.up = now; doc.list.unshift(dr); }
          else { dr.up = now; doc.list = doc.list.map(function (z) { return z.id === dr.id ? dr : z; }); }
        });
      }).then(function () { closeDialog(); toast(isNew ? "Drill saved" : "Saved"); render(); },
        function (e) { done(); msg.textContent = "Not saved: " + ((e && e.message) || e); });
    };
    box.appendChild(el("div", { class: "dialog-foot" }, msg, el("div", { class: "spacer" }),
      el("button", { type: "button", class: "btn", onclick: closeDialog }, "Cancel"), saveB));
    openDialog(box);
    if (pasted) { pin.value = pasted; fillFrom(pasted); }
    setTimeout(function () { try { (isNew && !pasted ? pin : tI).focus(); } catch (e) {} }, 60);
  }
  /* several pasted drills, each filled and classified the same way, in one write */
  function saveMany(parts, btn) {
    var done = busyBtn(btn, "Saving…"), now = new Date().toISOString();
    var drills = parts.map(function (p, i) {
      var r = fromText(p);
      return { id: uid(), t: r.t || ("Drill " + (i + 1)), d: r.d, cat: "shoot", tg: r.tg, pl: r.pl, min: r.min, links: r.links, img: false, fav: false, src: { k: "paste" }, used: [], at: now, up: now };
    });
    edit(function (doc) { doc.list = drills.concat(doc.list); })
      .then(function () { closeDialog(); toast(drills.length + " drills saved"); render(); },
        function (e) { done(); toast("Not saved: " + ((e && e.message) || e)); });
  }

  /* ------------------------------------------------------------ from the session sheets */
  var STAFF = null;
  function staffWords() {
    if (STAFF) return STAFF;
    var w = (typeof USERS !== "undefined" ? USERS : []).concat(["Jan", "Ramón", "Marc", "Jonas", "Leo"]);
    STAFF = w.map(nrm).filter(Boolean); return STAFF;
  }
  /* the lines of a block that say how it is done - not who runs it, not who is in which group */
  function drillLines(items) {
    var st = staffWords();
    return (items || []).map(function (it) { return String((it && it.t) || "").trim(); }).filter(function (t) {
      if (!t || t.length < 3) return false;
      if (/^g\d+[a-z]?\s*=/i.test(t)) return false;
      var parts = nrm(t).split(/\s*[\/,&+]\s*|\s+and\s+/).filter(Boolean);
      return !parts.every(function (p) { return st.indexOf(p) >= 0 || /^\d+\s*[´'`]?$/.test(p); });
    });
  }
  function sheetKey(title, lines) { return nrm(title) + "|" + nrm(lines.join(" ")); }
  function sheetFiles() {
    var Dd = (typeof docsState === "function") ? docsState() : { files: {} };
    return Object.keys(Dd.files || {}).map(function (k) { return Dd.files[k]; })
      .filter(function (f) { return f && f.folder === "practicedoc" && !/^c[oò]pia de|^copy of/i.test(f.name || ""); })
      .map(function (f) { return { id: f.id, name: f.name, date: f.date || ((typeof _docDateInName === "function") ? _docDateInName(f.name) : "") || "" }; })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  }
  function readSheet(f) {
    var get = window.LowenDriveFetch || driveFetch;
    return get(DOCS_FN + "?file=" + encodeURIComponent(f.id), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("status " + r.status); return r.arrayBuffer(); })
      .then(function (buf) {
        var head = new Uint8Array(buf.slice(0, 5)); if (String.fromCharCode.apply(null, head) !== "%PDF-") throw new Error("not a PDF");
        return pdfjsLib.getDocument({ data: buf }).promise;
      })
      .then(function (pdf) { return _sheetBlocks(pdf); });
  }
  function openSheets() {
    if (!window.pdfjsLib) { toast("The PDF reader is still loading - try again in a second"); return; }
    var box = el("div", { class: "drl-dlg drl-sh" });
    box.appendChild(el("h3", {}, "From the session sheets"));
    var intro = el("p", { class: "drl-sub" }, "Every session sheet in Drive is read the way Planning's Import PDF reads one. Its shooting blocks come out ticked, day by day; tick in or out what you want and add them. A sheet read once is not read again unless you ask.");
    box.appendChild(intro);
    var stat = el("div", { class: "drl-shstat" }), out = el("div", { class: "drl-shlist" });
    var allB = el("label", { class: "drl-shall" }, el("input", { type: "checkbox" }), " Read the sheets already read too");
    var goB = el("button", { type: "button", class: "btn primary" }, "Read the sheets");
    var addB = el("button", { type: "button", class: "btn primary", style: "display:none" }, "Add");
    var otherB = el("label", { class: "drl-shall", style: "display:none" }, el("input", { type: "checkbox" }), " Show the other blocks too");
    box.appendChild(el("div", { class: "drl-shbar" }, goB, allB, otherB, stat));
    box.appendChild(out);
    var stop = false, found = [], readIds = [];
    box.appendChild(el("div", { class: "dialog-foot" }, el("div", { class: "spacer" }),
      el("button", { type: "button", class: "btn", onclick: function () { stop = true; closeDialog(); } }, "Close"), addB));
    openDialog(box);
    function count() { var n = found.filter(function (c) { return c.on; }).length; addB.textContent = n ? "Add " + n + " drill" + (n === 1 ? "" : "s") : "Nothing ticked"; addB.disabled = !n; }
    function drawFound() {
      out.innerHTML = "";
      var showOther = otherB.querySelector("input").checked;
      var byDay = {};
      found.forEach(function (c) { if (!c.shoot && !showOther && !c.on) return; (byDay[c.date || ""] = byDay[c.date || ""] || []).push(c); });
      var days = Object.keys(byDay).sort().reverse();
      if (!days.length) { out.appendChild(el("div", { class: "drl-empty" }, found.length ? "No shooting block in these sheets - tick Show the other blocks to see the rest." : "Nothing new in the sheets.")); count(); return; }
      days.forEach(function (d) {
        out.appendChild(el("div", { class: "drl-shday" }, d ? dayLong(d) : "No date"));
        byDay[d].forEach(function (c) {
          var cb = el("input", { type: "checkbox" }); cb.checked = !!c.on;
          cb.addEventListener("change", function () { c.on = cb.checked; count(); });
          out.appendChild(el("label", { class: "drl-shrow" + (c.shoot ? "" : " other") }, cb,
            el("div", {}, el("b", {}, c.t), el("span", { class: "drl-shmeta" }, [c.min ? c.min + " min" : "", c.coach || ""].filter(Boolean).join(" · ")),
              c.lines.length ? el("div", { class: "drl-shd" }, c.lines.join(" · ")) : null)));
        });
      });
      count();
    }
    otherB.querySelector("input").addEventListener("change", drawFound);
    goB.onclick = function () {
      stop = false; found = []; readIds = []; out.innerHTML = "";
      var force = allB.querySelector("input").checked;
      var done = busyBtn(goB, "Reading…");
      stat.textContent = "Looking at the folder…";
      Promise.resolve(typeof syncDocs === "function" ? syncDocs(false) : null).catch(function () {}).then(function () {
        return load(true);
      }).then(function () {
        var doc = D.doc || { list: [], sheets: {} };
        var have = {}; doc.list.forEach(function (x) { if (x.src && x.src.key) have[x.src.key] = 1; });
        var files = sheetFiles().filter(function (f) { return force || !doc.sheets[f.id]; });
        if (!files.length) { stat.textContent = "Every sheet in the folder has been read already (" + sheetFiles().length + ")."; done(); drawFound(); return; }
        var i = 0, ok = 0, bad = 0, seen = {};
        stat.textContent = "Reading 0 of " + files.length + "…";
        function next() {
          if (stop) return Promise.resolve();
          var f = files[i++]; if (!f) return Promise.resolve();
          return readSheet(f).then(function (SB) {
            ok++; readIds.push({ id: f.id, d: f.date, n: (SB.blocks || []).length });
            (SB.blocks || []).forEach(function (b) {
              var t = String(b.title || "").trim(); if (!t || /^(water ?break|relax|hello|film|prevention|strength)\b/i.test(t)) return;
              var lines = drillLines(b.items), key = sheetKey(t, lines);
              if (have[key] || seen[key]) return; seen[key] = 1;
              var shoot = SHOOT.test(t);
              found.push({ t: t, lines: lines, min: b.min || null, coach: b.coach || "", date: f.date, file: f.id, key: key, shoot: shoot, on: shoot });
            });
          }, function () { bad++; readIds.push({ id: f.id, d: f.date, n: 0, bad: 1 }); })
            .then(function () { stat.textContent = "Read " + (ok + bad) + " of " + files.length + (bad ? " · " + bad + " could not be read" : "") + "…"; })
            .then(next);
        }
        return Promise.all([next(), next(), next()]).then(function () {
          done();
          if (stop) return;
          var nS = found.filter(function (c) { return c.shoot; }).length;
          stat.textContent = (ok + bad) + " sheet" + (ok + bad === 1 ? "" : "s") + " read" + (bad ? " (" + bad + " could not be)" : "") + " · " + nS + " shooting block" + (nS === 1 ? "" : "s") + " · " + (found.length - nS) + " other";
          addB.style.display = ""; otherB.style.display = "";
          drawFound();
        });
      }).catch(function (e) { done(); stat.textContent = "Could not read the sheets: " + ((e && e.message) || e); });
    };
    addB.onclick = function () {
      var pick = found.filter(function (c) { return c.on; }); if (!pick.length) return;
      var done = busyBtn(addB, "Saving…"), now = new Date().toISOString();
      var drills = pick.map(function (c) {
        var text = c.t + "\n" + c.lines.join("\n");
        return { id: uid(), t: c.t, d: c.lines.join("\n"), cat: "shoot", tg: classify(text), pl: "", min: c.min, links: [], img: false, fav: false,
          src: { k: "sheet", file: c.file, date: c.date, key: c.key, coach: c.coach }, used: c.date ? [c.date] : [], at: now, up: now };
      });
      edit(function (doc) {
        doc.list = drills.concat(doc.list);
        readIds.forEach(function (r) { if (!r.bad) doc.sheets[r.id] = { d: r.d, n: r.n, at: now }; });
      }).then(function () { closeDialog(); toast(drills.length + " drill" + (drills.length === 1 ? "" : "s") + " added from the sheets"); render(); },
        function (e) { done(); toast("Not saved: " + ((e && e.message) || e)); });
    };
  }

  /* ------------------------------------------------------------ the look */
  var CSS = [
    ".drl{max-width:1500px;margin:0 auto;padding:6px 0 40px;display:grid;gap:14px}",
    ".drl > *{min-width:0}.drl-filt > *{min-width:0}",
    ".drl-del{border:0;background:none;padding:6px 4px;font:600 13px 'Inter',sans-serif;color:#c53727;cursor:pointer;text-decoration:underline}body.dark .drl-del{color:#ff8f85}",
    ".drl-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}",
    ".drl-title{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}",
    ".drl-title h2{margin:0;font:700 26px/1 'Oswald',sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--ink,#141821)}",
    ".drl-cat{font:700 11px 'Oswald',sans-serif;letter-spacing:.12em;text-transform:uppercase;padding:3px 9px;border-radius:999px;background:rgba(198,161,91,.18);color:#8a6414}",
    ".drl-n{font:600 12px 'IBM Plex Mono',monospace;color:var(--ink-faint,#8a93a2)}",
    ".drl-acts{display:flex;gap:8px;flex-wrap:wrap}",
    ".drl-quick{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px dashed rgba(198,161,91,.8);border-radius:12px;background:rgba(198,161,91,.07)}",
    ".drl-quick-k{font:700 11px 'Oswald',sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#8a6414;white-space:nowrap}",
    ".drl-quick-in{flex:1;min-width:0;resize:none;border:1px solid var(--line,#e4e7ec);border-radius:8px;padding:8px 10px;font:400 13px 'Inter',sans-serif;background:var(--panel,#fff);color:var(--ink,#141821);height:36px;box-sizing:border-box}",
    ".drl-filt{border:1px solid var(--line,#e4e7ec);border-radius:12px;background:var(--panel,#fff);padding:10px 12px;display:grid;gap:8px;box-shadow:0 1px 2px rgba(16,24,40,.05)}",
    ".drl-frow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
    ".drl-frow.top{gap:8px;padding-bottom:8px;border-bottom:1px solid var(--line-soft,#eef0f3)}",
    ".drl-fk{width:150px;flex:none;font:700 11px 'Oswald',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft,#5b6472)}",
    ".drl-q{flex:1;min-width:180px;max-width:420px;border:1px solid var(--line,#e4e7ec);border-radius:8px;padding:7px 10px;font:400 13px 'Inter',sans-serif;background:var(--panel,#fff);color:var(--ink,#141821)}",
    ".drl-sort{border:1px solid var(--line,#e4e7ec);border-radius:8px;padding:6px 8px;font:500 12px 'Inter',sans-serif;background:var(--panel,#fff);color:var(--ink,#141821)}",
    ".drl-clear{margin-left:auto;border:0;background:none;font:600 12px 'Inter',sans-serif;color:var(--ink-soft,#5b6472);cursor:pointer;text-decoration:underline}",
    ".drl-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line,#e4e7ec);background:var(--panel,#fff);color:var(--ink,#141821);border-radius:999px;padding:5px 11px;font:600 12px 'Inter',sans-serif;cursor:pointer;transition:background .12s,border-color .12s}",
    ".drl-chip:hover{border-color:var(--ink-faint,#8a93a2)}",
    ".drl-chip em{font:600 10.5px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-faint,#8a93a2)}",
    ".drl-chip.on{background:var(--ink,#141821);border-color:var(--ink,#141821);color:var(--panel,#fff)}.drl-chip.on em{color:inherit;opacity:.7}",
    ".drl-chip.zero{opacity:.45}",
    ".drl-chip.fav.on{background:#c6a15b;border-color:#c6a15b;color:#1b1406}",
    ".drl-count{font:600 12px 'IBM Plex Mono',monospace;color:var(--ink-faint,#8a93a2);min-height:0}",
    ".drl-count:empty{display:none}",
    ".drl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}",
    /* the compact card (28/11/2026) */
    ".drl-ctop{display:flex;align-items:flex-start;gap:8px;min-width:0}",
    ".drl-bdg{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:20px;padding:0 5px;border-radius:5px;color:#fff;font:700 10px 'IBM Plex Mono',monospace;letter-spacing:.02em;margin-top:1px}",
    ".drl-ctop .drl-ct{flex:1;min-width:0}",
    ".drl-ctop .drl-star,.drl-row .drl-star{position:static;width:auto;height:auto;background:none;padding:0 2px;font-size:15px;flex:none}",
    ".drl-fl{margin:0;font:400 12px/1.45 'Inter',sans-serif;color:var(--ink-soft,#5b6472);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".drl-vid{font:600 10.5px 'Inter',sans-serif;color:#2f6cc0}",
    ".drl-card.drag,.drl-row.drag{opacity:.45}",
    ".drl-seg{display:inline-flex;border:1px solid var(--line,#e4e7ec);border-radius:8px;overflow:hidden}",
    ".drl-seg button{border:0;background:var(--panel,#fff);color:var(--ink-soft,#5b6472);font:600 12px 'Inter',sans-serif;padding:6px 11px;cursor:pointer}",
    ".drl-seg button.on{background:var(--ink,#141821);color:var(--panel,#fff)}",
    /* the list */
    ".drl-list{display:grid;border:1px solid var(--line,#e4e7ec);border-radius:12px;background:var(--panel,#fff);overflow:hidden}",
    ".drl-row{display:grid;grid-template-columns:42px minmax(0,2.2fr) minmax(0,2fr) 44px minmax(70px,.8fr) 44px 22px 26px;gap:10px;align-items:center;padding:7px 12px;border-top:1px solid var(--line-soft,#eef0f3);cursor:pointer;font-size:12.5px}",
    ".drl-row:hover,.drl-row:focus-visible{background:var(--panel-2,#f4f5f7);outline:none}",
    ".drl-rh{cursor:default;border-top:0;font:600 9.5px 'IBM Plex Mono',monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint,#8a93a2);background:var(--panel-2,#f4f5f7)}",
    ".drl-rh:hover{background:var(--panel-2,#f4f5f7)}",
    ".drl-rt{display:grid;min-width:0}.drl-rt b{font:700 13px 'Inter',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".drl-rt i{font-style:normal;font-size:11.5px;color:var(--ink-faint,#8a93a2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".drl-row .drl-tags,.drl-card .drl-tags{flex-wrap:nowrap;overflow:hidden}.drl-row .drl-tags > *,.drl-card .drl-tags > *{flex:none;white-space:nowrap}",
    ".drl-rn{font:600 12px 'IBM Plex Mono',monospace;text-align:right;color:var(--ink-soft,#5b6472)}",
    ".drl-rp{font-size:12px;color:var(--ink-soft,#5b6472);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".drl-rs{color:#2f6cc0;text-align:center}",
    "@media (max-width:760px){.drl-row{grid-template-columns:42px minmax(0,1fr) 40px 26px}.drl-row > .drl-tags,.drl-row > .drl-rp,.drl-row > .drl-rn:nth-of-type(2),.drl-row > .drl-rs,.drl-rh > span:nth-child(3),.drl-rh > span:nth-child(5),.drl-rh > span:nth-child(6),.drl-rh > span:nth-child(7){display:none}}",
    ".drl-card{position:relative;border:1px solid var(--line,#e4e7ec);border-radius:10px;background:var(--panel,#fff);cursor:pointer;display:grid;gap:6px;align-content:start;padding:10px 12px;min-width:0;box-shadow:0 1px 2px rgba(16,24,40,.05);transition:box-shadow .15s,transform .15s}",
    ".drl-card:hover,.drl-card:focus-visible{box-shadow:0 6px 18px rgba(16,24,40,.12);transform:translateY(-1px);outline:none}",
    ".drl-media{position:relative;aspect-ratio:16/9;background:var(--panel-2,#f4f5f7);display:flex;align-items:center;justify-content:center;overflow:hidden;max-width:100%}",
    ".drl-media img{width:100%;height:100%;object-fit:cover;display:block}",
    ".drl-play{position:absolute;width:42px;height:42px;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;padding-left:3px;box-sizing:border-box}",
    ".drl-court{width:62%;height:auto;fill:none;stroke:var(--ink-faint,#8a93a2);stroke-width:1.4;opacity:.55}",
    ".drl-media.txt{align-items:flex-start;justify-content:flex-start;padding:14px 46px 14px 16px;box-sizing:border-box;background:linear-gradient(180deg,var(--panel-2,#f4f5f7),var(--panel,#fff));border-bottom:1px solid var(--line-soft,#eef0f3)}",
    ".drl-ex{margin:0;font:400 12.5px/1.55 'Inter',sans-serif;color:var(--ink-soft,#5b6472);white-space:pre-line;overflow:hidden;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical}",
    ".drl-star{position:absolute;top:8px;right:8px;width:30px;height:30px;border-radius:50%;border:0;background:rgba(255,255,255,.88);color:#b9bfc9;font-size:16px;cursor:pointer;line-height:1}",
    ".drl-star.on{color:#c6a15b}",
    ".drl-star.big{position:static;background:none;font-size:24px;width:auto;height:auto}",
    ".drl-cb{padding:10px 12px 12px;display:grid;gap:6px;align-content:start}",
    ".drl-ct{margin:0;font:700 14px/1.3 'Inter',sans-serif;color:var(--ink,#141821);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}",
    ".drl-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font:500 11.5px 'Inter',sans-serif;color:var(--ink-faint,#8a93a2)}",
    ".drl-src{font:600 10px 'IBM Plex Mono',monospace;letter-spacing:.04em;text-transform:uppercase;padding:1px 6px;border-radius:4px;background:var(--panel-2,#f4f5f7);color:var(--ink-soft,#5b6472)}",
    ".drl-tags{display:flex;flex-wrap:wrap;gap:4px}",
    ".drl-tag{font:600 10.5px 'Inter',sans-serif;padding:2px 7px;border-radius:5px;background:var(--panel-2,#f4f5f7);color:var(--ink-soft,#5b6472)}",
    ".drl-tag.g-type{background:rgba(47,108,192,.12);color:#2f5f9e}.drl-tag.g-zone{background:rgba(198,161,91,.18);color:#86621a}",
    ".drl-tag.g-def{background:rgba(138,47,43,.10);color:#8a2f2b}.drl-tag.more{background:none}",
    ".drl-empty{padding:28px;border:1px dashed var(--line,#e4e7ec);border-radius:12px;color:var(--ink-soft,#5b6472);font:400 13px/1.55 'Inter',sans-serif;grid-column:1/-1;text-align:center}",
    ".drl-empty b{color:var(--ink,#141821)}.drl-empty.err{color:#c53727}",
    /* the dialogs */
    "#dialogCard:has(.drl-dlg){max-width:min(860px,calc(100vw - 32px))!important;width:100%}",
    ".drl-dlg h3{margin:0 0 10px;font:700 20px 'Oswald',sans-serif;letter-spacing:.06em;text-transform:uppercase}",
    ".drl-lab{display:block;margin:14px 0 5px;font:700 11px 'Oswald',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft,#5b6472)}",
    ".drl-in{width:100%;box-sizing:border-box;border:1px solid var(--line,#e4e7ec);border-radius:8px;padding:8px 10px;font:400 13.5px/1.5 'Inter',sans-serif;background:var(--panel,#fff);color:var(--ink,#141821)}",
    "textarea.drl-in{resize:vertical}",
    ".drl-two{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:12px}",
    ".drl-pbox{padding:10px 12px 12px;border:1px dashed rgba(198,161,91,.8);border-radius:10px;background:rgba(198,161,91,.07)}",
    ".drl-pbox .drl-lab{margin-top:0;color:#8a6414}",
    ".drl-paste{width:100%;box-sizing:border-box;border:1px solid var(--line,#e4e7ec);border-radius:8px;padding:8px 10px;font:400 13px/1.5 'Inter',sans-serif;background:var(--panel,#fff);color:var(--ink,#141821);resize:vertical}",
    ".drl-pnote{font:600 11.5px 'Inter',sans-serif;color:#17805a;margin-top:6px}.drl-pnote:empty{display:none}",
    ".drl-split{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;font:500 12.5px 'Inter',sans-serif}.drl-split:empty{display:none}",
    ".drl-edtags{display:grid;gap:6px;padding:10px 12px;border:1px solid var(--line,#e4e7ec);border-radius:10px}",
    ".drl-drop{border:1px dashed var(--line-strong,#cfd4dc);border-radius:10px;padding:12px;cursor:pointer;text-align:center;color:var(--ink-faint,#8a93a2);font:500 12.5px 'Inter',sans-serif}",
    ".drl-drop.over{border-color:#c6a15b;background:rgba(198,161,91,.08)}",
    ".drl-pv{display:grid;gap:8px;justify-items:center}.drl-pv img{max-width:100%;max-height:320px;border-radius:8px}",
    ".drl-msg{font:600 12px 'Inter',sans-serif;color:#c53727}",
    ".drl-view .drl-vh{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}",
    ".drl-view > .drl-meta,.drl-view > .drl-tags{margin-bottom:10px}",
    ".drl-video{position:relative;aspect-ratio:16/9;max-width:100%;border-radius:10px;overflow:hidden;background:#000;margin:6px 0 12px}.drl-video iframe{position:absolute;inset:0;width:100%;height:100%;border:0}",
    ".drl-pic{margin:6px 0 12px}.drl-pic img{max-width:100%;border-radius:10px;display:block}",
    ".drl-desc{white-space:pre-wrap;font:400 14px/1.6 'Inter',sans-serif;color:var(--ink,#141821);padding:12px 14px;border-radius:10px;background:var(--panel-2,#f4f5f7)}",
    ".drl-links{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font:600 12.5px 'Inter',sans-serif}",
    ".drl-hist{margin-top:12px;font:500 11.5px 'Inter',sans-serif;color:var(--ink-faint,#8a93a2)}",
    ".drl-sub{margin:0 0 10px;font:400 13px/1.55 'Inter',sans-serif;color:var(--ink-soft,#5b6472)}",
    ".drl-shbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
    ".drl-shall{display:inline-flex;align-items:center;gap:5px;font:500 12.5px 'Inter',sans-serif;color:var(--ink-soft,#5b6472)}",
    ".drl-shstat{font:600 12px 'IBM Plex Mono',monospace;color:var(--ink-soft,#5b6472)}",
    ".drl-shlist{max-height:min(56vh,560px);overflow:auto;margin-top:12px;display:grid;gap:4px}",
    ".drl-shday{position:sticky;top:0;background:var(--panel,#fff);padding:8px 0 4px;font:700 12px 'Oswald',sans-serif;letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--line,#e4e7ec);z-index:1}",
    ".drl-shrow{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;align-items:start;padding:7px 4px;border-radius:8px;cursor:pointer}",
    ".drl-shrow:hover{background:var(--panel-2,#f4f5f7)}.drl-shrow input{margin-top:3px}",
    ".drl-shrow b{font:700 13px 'Inter',sans-serif;margin-right:8px}.drl-shrow.other b{font-weight:500;color:var(--ink-soft,#5b6472)}",
    ".drl-shmeta{font:500 11.5px 'Inter',sans-serif;color:var(--ink-faint,#8a93a2)}",
    ".drl-shd{font:400 12px/1.45 'Inter',sans-serif;color:var(--ink-soft,#5b6472);margin-top:2px}",
    "body.dark .drl-star{background:rgba(20,24,33,.75)}body.dark .drl-cat,body.dark .drl-quick-k,body.dark .drl-pbox .drl-lab{color:#e3c47e}",
    "body.dark .drl-tag.g-type{color:#8fb6ec}body.dark .drl-tag.g-zone{color:#e3c47e}body.dark .drl-tag.g-def{color:#f0a39b}",
    "@media (max-width:700px){.drl-fk{width:100%}.drl-quick{flex-wrap:wrap}.drl-two{grid-template-columns:minmax(0,1fr) 90px}}"
  ].join("\n");
  function css() { if (document.getElementById("drlCss")) return; var s = document.createElement("style"); s.id = "drlCss"; s.textContent = CSS; document.head.appendChild(s);
    try { var ts = document.getElementById("typeSys"); if (ts) document.head.appendChild(ts); } catch (e) {} }

  window.Drills = { render: function (root) { css(); render(root); }, classify: classify, fromText: fromText, splitDrills: splitDrills, _D: D };
})();
