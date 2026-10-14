/* =========================================================================
   PLAYER DEVELOPMENT
   One page for the season of each of our players: what he is working on, the numbers
   that say whether it is working, and how he and the team around him are going.

   Nothing here is a second statistics engine. The numbers are the league's own:
     - the box score and the play by play of every game we played, read once by Trends
       (_trgRead -> one line per player per game, with what the team did while he was on
       the floor: points and possessions of both sides, the rebounds there were to take);
     - the season on/off the league feed already computes (L.players[club].onoff).
   What the feed cannot say - catch & shoot against pull-up, shot selection, effort,
   individual defensive quality - is never derived from it: those are staff ratings,
   entered by hand, marked as such.

   The goals, the chosen measures and the ratings are one document on the server
   ("pdev:v1"), written through the store the reports use. A goal is never deleted: it is
   finished or replaced, and every change is appended to a log, so the work of October is
   still there in March.
   ========================================================================= */
(function () {
  "use strict";
  var DOC = "pdev:v1";

  /* ------------------------------------------------------------ the measures */
  /* t: "count" is scaled by the view (per game, per 40, per 100 possessions on the floor,
     totals); "rate" is what it is. need: the denominator below which the number is shown
     as a small sample. */
  var M = [
    { k: "min", l: "Minutes", g: "Volume", t: "count", hi: true, raw: function (S) { return S.s / 60; }, f: 1 },
    { k: "pts", l: "Points", g: "Scoring", t: "count", hi: true, raw: function (S) { return S.p; }, f: 1 },
    { k: "fga", l: "FGA", g: "Shooting", t: "count", hi: null, raw: function (S) { return S.fa; }, f: 1 },
    { k: "p3a", l: "3PA", g: "Shooting", t: "count", hi: null, raw: function (S) { return S.ta; }, f: 1 },
    { k: "fta", l: "FTA", g: "Shooting", t: "count", hi: true, raw: function (S) { return S.fta; }, f: 1 },
    { k: "fgp", l: "FG%", g: "Shooting", t: "rate", hi: true, pct: true, v: function (S) { return S.fa ? 100 * S.fm / S.fa : null; }, need: function (S) { return S.fa >= 10; } },
    { k: "p2p", l: "2P%", g: "Shooting", t: "rate", hi: true, pct: true, v: function (S) { var a = S.fa - S.ta; return a ? 100 * (S.fm - S.tm) / a : null; }, need: function (S) { return (S.fa - S.ta) >= 8; } },
    { k: "p3p", l: "3P%", g: "Shooting", t: "rate", hi: true, pct: true, v: function (S) { return S.ta ? 100 * S.tm / S.ta : null; }, need: function (S) { return S.ta >= 10; } },
    { k: "ftp", l: "FT%", g: "Shooting", t: "rate", hi: true, pct: true, v: function (S) { return S.fta ? 100 * S.f1 / S.fta : null; }, need: function (S) { return S.fta >= 8; } },
    { k: "ts", l: "TS%", g: "Shooting", t: "rate", hi: true, pct: true, v: function (S) { var a = S.fa + 0.44 * S.fta; return a ? 100 * S.p / (2 * a) : null; }, need: function (S) { return S.fa >= 10; } },
    { k: "efg", l: "eFG%", g: "Shooting", t: "rate", hi: true, pct: true, v: function (S) { return S.fa ? 100 * (S.fm + 0.5 * S.tm) / S.fa : null; }, need: function (S) { return S.fa >= 10; } },
    { k: "p3r", l: "3PA rate", g: "Shooting", t: "rate", hi: null, pct: true, v: function (S) { return S.fa ? 100 * S.ta / S.fa : null; }, need: function (S) { return S.fa >= 10; } },
    { k: "ast", l: "Assists", g: "Creation", t: "count", hi: true, raw: function (S) { return S.a; }, f: 1 },
    { k: "tov", l: "Turnovers", g: "Creation", t: "count", hi: false, raw: function (S) { return S.t; }, f: 1 },
    { k: "astto", l: "AST/TO", g: "Creation", t: "rate", hi: true, f: 2, v: function (S) { return S.t ? S.a / S.t : (S.a ? S.a : null); }, need: function (S) { return S.a + S.t >= 6; } },
    { k: "usg", l: "Usage", g: "Creation", t: "rate", hi: null, pct: true, v: function (S) { return S.uposs ? 100 * (S.fa + 0.44 * S.fta + S.t) / S.uposs : null; }, need: function (S) { return S.uposs >= 40; }, note: "share of our possessions on the floor that he finishes (shot, free throws or turnover)" },
    { k: "reb", l: "Rebounds", g: "Rebounding", t: "count", hi: true, raw: function (S) { return S.or + S.dr; }, f: 1 },
    { k: "or", l: "Off. rebounds", g: "Rebounding", t: "count", hi: true, raw: function (S) { return S.or; }, f: 1 },
    { k: "dr", l: "Def. rebounds", g: "Rebounding", t: "count", hi: true, raw: function (S) { return S.dr; }, f: 1 },
    { k: "orbp", l: "ORB%", g: "Rebounding", t: "rate", hi: true, pct: true, v: function (S) { var o = S.uor + S.tdr; return o ? 100 * S.or / o : null; }, need: function (S) { return S.uor + S.tdr >= 15; }, note: "his offensive rebounds of all the offensive rebounds there were while he was on" },
    { k: "drbp", l: "DRB%", g: "Rebounding", t: "rate", hi: true, pct: true, v: function (S) { var o = S.udr + S.tor; return o ? 100 * S.dr / o : null; }, need: function (S) { return S.udr + S.tor >= 15; }, note: "his defensive rebounds of all the defensive rebounds there were while he was on" },
    { k: "torb", l: "Team ORB% on", g: "Impact", t: "rate", hi: true, pct: true, v: function (S) { var o = S.uor + S.tdr; return o ? 100 * S.uor / o : null; }, need: function (S) { return S.uor + S.tdr >= 15; }, note: "the team's offensive rebounding with him on the floor" },
    { k: "tdrb", l: "Team DRB% on", g: "Impact", t: "rate", hi: true, pct: true, v: function (S) { var o = S.udr + S.tor; return o ? 100 * S.udr / o : null; }, need: function (S) { return S.udr + S.tor >= 15; }, note: "the team's defensive rebounding with him on the floor" },
    { k: "stl", l: "Steals", g: "Defense", t: "count", hi: true, raw: function (S) { return S.stl; }, f: 1 },
    { k: "blk", l: "Blocks", g: "Defense", t: "count", hi: true, raw: function (S) { return S.blk; }, f: 1 },
    { k: "pf", l: "Fouls", g: "Defense", t: "count", hi: false, raw: function (S) { return S.pf; }, f: 1 },
    { k: "fd", l: "Fouls drawn", g: "Scoring", t: "count", hi: true, raw: function (S) { return S.fd; }, f: 1 },
    { k: "pir", l: "PIR", g: "Overall", t: "count", hi: true, raw: function (S) { return S.pir; }, f: 1 },
    { k: "pm", l: "+/-", g: "Impact", t: "count", hi: true, raw: function (S) { return S.pm; }, f: 1, sign: true },
    { k: "ortg", l: "ORtg on", g: "Impact", t: "rate", hi: true, f: 1, v: function (S) { return S.uposs ? 100 * S.up / S.uposs : null; }, need: function (S) { return S.uposs >= 40; }, note: "team points per 100 possessions with him on the floor" },
    { k: "drtg", l: "DRtg on", g: "Impact", t: "rate", hi: false, f: 1, v: function (S) { return S.tposs ? 100 * S.tp / S.tposs : null; }, need: function (S) { return S.tposs >= 40; }, note: "opponent points per 100 possessions with him on the floor - the team's defense, not his alone" },
    { k: "net", l: "Net on", g: "Impact", t: "rate", hi: true, f: 1, sign: true, v: function (S) { return (S.uposs && S.tposs) ? 100 * S.up / S.uposs - 100 * S.tp / S.tposs : null; }, need: function (S) { return S.uposs >= 40; }, note: "net rating of the team with him on the floor" }
  ];
  var MK = {}; M.forEach(function (m) { MK[m.k] = m; });
  var VIEWS = [
    ["goals", "By his goals", null],
    ["over", "Overview", ["min", "pts", "ts", "ast", "reb", "pir", "net"]],
    ["shoot", "Shooting", ["fga", "fgp", "p3a", "p3p", "ftp", "ts", "efg"]],
    ["create", "Creation", ["ast", "tov", "astto", "usg", "pts", "ts"]],
    ["impact", "Impact", ["net", "ortg", "drtg", "pm", "torb", "tdrb"]],
    ["reb", "Rebounding", ["reb", "or", "dr", "orbp", "drbp", "torb"]],
    ["mine", "Each player's own", null]
  ];
  var MODES = [["pg", "Per game"], ["p40", "Per 40"], ["p100", "Per 100 poss."], ["tot", "Totals"]];
  var PERIODS = [["all", "Season"], ["10", "Last 10"], ["5", "Last 5"], ["3", "Last 3"]];
  /* what only the staff can judge: entered by hand, 1 to 5 */
  var RATINGS = [["effort", "Energy and effort"], ["shotsel", "Shot selection"], ["decisions", "Decision making"],
    ["defsolid", "Defensive solidity"], ["catchshoot", "Catch & shoot (video)"], ["pullup", "Pull-up (video)"]];

  /* ------------------------------------------------------------ the people */
  /* the names the staff uses, matched to the league's roster */
  var MAIN = [
    { nm: "Chip Flanigan", m: /flanigan/i }, { nm: "Tajh Green", m: /tajh|\bgreen\b/i }, { nm: "Sheldon Edwards", m: /sheldon|edwards/i },
    { nm: "Ferdinand Zylka", m: /zylka/i }, { nm: "Gian Aydinoglu", m: /aydinoglu/i }, { nm: "De'Jour Reaves", m: /reaves/i },
    { nm: "Devin Askew", m: /askew/i }, { nm: "Benjamin Schröder", m: /schr[oö]der/i }, { nm: "Felipe Haase Thiers", m: /haase|thiers/i },
    { nm: "Zaba Bangala", m: /bangala/i }
  ];
  var DL = [
    { nm: "Noah Eklou", m: /eklou/i }, { nm: "Esli Edigin", m: /esli/i }, { nm: "Liam", m: /^liam\b/i, missing: true },
    { nm: "Cavit Gürbüzer", m: /g[uü]rb[uü]zer/i }, { nm: "Leonhard Laar", m: /laar/i }, { nm: "Christopher Wahren", m: /wahren/i }
  ];
  /* the goals the staff set at the start - written once into the document, editable after */
  var SEED_START = "2026-08-01";   /* the start of the season: every game counts until the staff dates a goal itself */
  function seedFor(nm) {
    var G = function (name, desc, metrics, ratings) { return { name: name, desc: desc, metrics: metrics, ratings: ratings || [] }; };
    var S = {
      "Chip Flanigan": [G("Three-point shooting", "Percentage, volume and attempts per game. Catch & shoot and pull-up need the video: the feed does not tell them apart.", ["p3p", "p3a", "p3r", "ts"], ["catchshoot", "pullup"])],
      "Tajh Green": [G("Three-point shooting", "Percentage, volume and efficiency through the season.", ["p3p", "p3a", "p3r", "ts"])],
      "Sheldon Edwards": [G("Shooting", "Efficiency and volume of his shot.", ["fgp", "p3p", "ts", "fga"]),
        G("Defensive solidity", "Fouls, steals and the team's defense with him on. The team number is collective; his own defending is rated by the staff.", ["pf", "stl", "drtg", "tdrb"], ["defsolid"])],
      "Ferdinand Zylka": [G("Shooting and scoring", "Volume and efficiency of his scoring.", ["pts", "ts", "fga", "p3p"]),
        G("Creating and passing", "Assists, assists per turnover and how much he runs the ball.", ["ast", "astto", "tov", "usg"])],
      "Gian Aydinoglu": [G("Running the team", "His own creation and the team with him on the floor, kept apart.", ["ast", "tov", "astto", "net", "ortg", "drtg"]),
        G("Scoring", "Scoring and efficiency.", ["pts", "ts", "fga"])],
      "De'Jour Reaves": [G("Running the team", "His own creation and the team with him on the floor, kept apart.", ["ast", "tov", "astto", "net", "ortg", "drtg"]),
        G("Scoring", "Scoring and efficiency.", ["pts", "ts", "fga"])],
      "Devin Askew": [G("Combo guard: creation", "The same direction measures as the point guards.", ["ast", "tov", "astto", "usg"]),
        G("Combo guard: scoring", "Efficiency, volume and his percentages.", ["pts", "ts", "fga", "p3p", "p2p"]),
        G("Team impact", "The team with him on the floor.", ["net", "ortg", "drtg"])],
      "Benjamin Schröder": [G("Shot selection and decisions", "Contribute without forcing. Shot selection and forced decisions are not in the box score: rated by the staff.", ["tov", "fga", "ts", "efg"], ["shotsel", "decisions"]),
        G("Shooting", "Percentages and the volume they come on.", ["fgp", "p3p", "p3a"])],
      "Felipe Haase Thiers": [G("Shooting", "Efficiency and volume.", ["fgp", "p3p", "fga", "ts"]),
        G("Defensive impact", "The team's defense and defensive rebounding with him on.", ["drtg", "dr", "drbp", "tdrb"], ["defsolid"])],
      "Zaba Bangala": [G("Energy and rebounding", "Rebounds as a share of the chances there were, not only the count; the team's rebounding with him on. Effort is rated by the staff.", ["orbp", "drbp", "or", "dr", "torb", "tdrb", "stl"], ["effort"]),
        G("Team impact", "The team with him on the floor, at both ends.", ["net", "ortg", "drtg"])]
    };
    return S[nm] || [];
  }

  /* ------------------------------------------------------------ helpers */
  function el(tag, props) { var a = [].slice.call(arguments, 2); return h.apply(null, [tag, props || {}].concat(a)); }
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, ""); }
  function today() { try { return todayISO(); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  function fmt(m, v) {
    if (v == null || !isFinite(v)) return "—";
    if (m.pct) return Math.round(v) + "%";
    var s = v.toFixed(m.f == null ? 1 : m.f);
    return (m.sign && v > 0 ? "+" : "") + s;
  }
  function ddmm(iso) { return String(iso || "").slice(8, 10) + "/" + String(iso || "").slice(5, 7); }

  /* the lines of one player added up - every rate is a ratio of sums, never an average of
     per-game rates, so a 1/1 night does not count as much as a 6/9 one */
  function sum(lines) {
    var S = { gp: 0, s: 0, p: 0, r: 0, a: 0, t: 0, pm: 0, pir: 0, fm: 0, fa: 0, tm: 0, ta: 0, f1: 0, fta: 0, or: 0, dr: 0, stl: 0, blk: 0, pf: 0, fd: 0,
      up: 0, tp: 0, uposs: 0, tposs: 0, uor: 0, udr: 0, tor: 0, tdr: 0 };
    lines.forEach(function (x) { var l = x.l; if (!l) return;
      S.gp++; ["s", "p", "r", "a", "t", "pm", "pir", "fm", "fa", "tm", "ta", "f1", "fta", "or", "dr", "stl", "blk", "pf", "fd"].forEach(function (k) { S[k] += (+l[k] || 0); });
      var o = l.on; if (o) { ["up", "tp", "uposs", "tposs", "uor", "udr", "tor", "tdr"].forEach(function (k) { S[k] += (+o[k] || 0); }); } });
    return S;
  }
  function value(m, S, mode) {
    if (!S || !S.gp) return null;
    if (m.t === "rate") return m.v(S);
    var raw = m.raw(S);
    if (m.k === "min") return mode === "tot" ? raw : raw / S.gp;
    if (mode === "tot") return raw;
    if (mode === "p40") return S.s ? raw * 2400 / S.s : null;
    if (mode === "p100") return S.uposs ? raw * 100 / S.uposs : null;
    return raw / S.gp;
  }
  function small(m, S) { if (!S || !S.gp) return true; if (m.need) return !m.need(S); return S.s < 30 * 60; }

  /* ------------------------------------------------------------ data */
  var D = { R: null, doc: null, err: "", busy: false };
  function ourId() { var L = leagueState(); var t = (L.teams || []).filter(function (x) { return _lgOurs(x.name); })[0]; return t ? t.id : ""; }
  function load(done) {
    if (D.busy) return; D.busy = true;
    Promise.all([
      _trgRead().catch(function (e) { D.err = (e && e.message) || "the league's games could not be read"; return null; }),
      _clubDocGet(DOC).catch(function () { return null; })
    ]).then(function (r) {
      D.R = r[0]; D.doc = r[1] || { players: {}, log: [] }; D.busy = false;
      D.doc.players = D.doc.players || {}; D.doc.log = D.doc.log || [];
      try { var tid = ourId(); if (tid && !(leagueState().roster || {})[tid]) syncRoster(tid, false); } catch (e) { }
      done();
    });
  }
  /* every player: his name, his key in the document, and his lines game by game */
  function people() {
    var R = D.R, L = leagueState(), tid = ourId();
    var lines = {};   /* league game id -> name -> lines */
    var byName = {};
    ((R && R.games) || []).forEach(function (gm) {
      (gm.pl || []).forEach(function (p) { if (!(p.s > 0)) return;
        var k = norm(p.nm); var e = byName[k] || (byName[k] = { nm: p.nm, num: p.n, id: p.i, lines: [] });
        e.lines.push({ d: gm.g.date, opp: gm.opp, code: gm.code, home: gm.home, us: gm.hs != null ? (gm.home ? gm.hs : gm.as) : null, them: gm.hs != null ? (gm.home ? gm.as : gm.hs) : null, l: p }); });
    });
    var ros = ((L.roster || {})[tid] || {}).players || [];
    var used = {};
    var pick = function (def) {
      var found = null;
      Object.keys(byName).forEach(function (k) { if (!found && def.m.test(byName[k].nm)) found = byName[k]; });
      var rr = ros.filter(function (x) { return def.m.test(x.name || ((x.first || "") + " " + (x.last || ""))); })[0] || null;
      var nm = (found && found.nm) || (rr && rr.name) || def.nm;
      if (found) used[norm(found.nm)] = 1;
      if (rr) used["r" + norm(rr.name)] = 1;
      return { key: norm(def.nm), nm: def.nm, league: nm, num: (found && found.num) || (rr && rr.num) || "", id: found && found.id, pos: rr ? (rr.pos || "") : "",
        lines: found ? found.lines.slice().sort(function (a, b) { return String(a.d).localeCompare(String(b.d)); }) : [], missing: !found && !rr && def.missing };
    };
    var main = MAIN.map(pick);
    var dl = DL.map(pick);
    /* anyone else who has played minutes for us goes with the rest of the roster, below */
    Object.keys(byName).forEach(function (k) { if (used[k]) return; var e = byName[k];
      dl.push({ key: norm(e.nm), nm: e.nm, league: e.nm, num: e.num, id: e.id, pos: "", other: true, lines: e.lines.slice().sort(function (a, b) { return String(a.d).localeCompare(String(b.d)); }) }); used[k] = 1; });
    ros.forEach(function (x) { var n = x.name || ""; if (used["r" + norm(n)] || used[norm(n)]) return;
      if (main.concat(dl).some(function (p) { return norm(p.league) === norm(n); })) return;
      dl.push({ key: norm(n), nm: n, league: n, num: x.num || "", pos: x.pos || "", lines: [], other: true }); });
    return { main: main, dl: dl };
  }
  function rec(key) {
    var P = D.doc.players[key];
    if (!P) {
      P = D.doc.players[key] = { metrics: null, goals: [], ratings: [] };
    }
    return P;
  }
  /* the document as it is on the server, with one change applied to it, written back;
     a second person's change made in between is not lost */
  function commit(what, fn) {
    var by = (typeof currentUser !== "undefined" && currentUser) || "";
    return _clubDocGet(DOC).then(function (srv) {
      var doc = srv || { players: {}, log: [] }; doc.players = doc.players || {}; doc.log = doc.log || [];
      fn(doc, by);
      doc.log.push({ at: new Date().toISOString(), by: by, what: what });
      if (doc.log.length > 800) doc.log = doc.log.slice(-800);
      return _clubDocPut(DOC, doc).then(function (ok) { if (ok) D.doc = doc; return ok; });
    });
  }
  function canEd() { try { return canEdit("playerdev"); } catch (e) { return false; } }
  /* the starting goals, written once per player who has none and was never seeded */
  function seedOnce(list) {
    var todo = list.filter(function (p) { var r = D.doc.players[p.key]; return !(r && r.seeded) && seedFor(p.nm).length; });
    if (!todo.length) return;
    /* shown at once, whoever is looking; written to the server once, by someone who may */
    var apply = function (doc, by) {
      todo.forEach(function (p) { var r = doc.players[p.key] || (doc.players[p.key] = { metrics: null, goals: [], ratings: [] });
        if (r.seeded) return; r.seeded = true;
        seedFor(p.nm).forEach(function (g) { r.goals.push({ id: uid(), name: g.name, desc: g.desc, metrics: g.metrics, ratings: g.ratings, start: SEED_START, end: "", status: "active", notes: [], createdAt: new Date().toISOString(), by: by }); });
        if (!r.metrics) { var ms = []; seedFor(p.nm).forEach(function (g) { g.metrics.forEach(function (k) { if (ms.indexOf(k) < 0) ms.push(k); }); }); r.metrics = ms.slice(0, 7); } });
    };
    apply(D.doc, (typeof currentUser !== "undefined" && currentUser) || "");
    if (!canEd() || D.seedTried) return;
    D.seedTried = true;
    commit("first goals of the season", apply);
  }

  /* ------------------------------------------------------------ small charts */
  function svg(tag, attrs) { var n = document.createElementNS("http://www.w3.org/2000/svg", tag); Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); }); return n; }
  /* a line of values, a dashed line at the season, a marker where a goal began */
  function spark(vals, opts) {
    opts = opts || {}; var W = opts.w || 110, H = opts.h || 26, P = 2;
    var pts = vals.map(function (v, i) { return { i: i, v: v }; }).filter(function (x) { return x.v != null && isFinite(x.v); });
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, class: "pd-spark" });
    if (pts.length < 2) return s;
    var lo = Math.min.apply(null, pts.map(function (x) { return x.v; }).concat(opts.ref != null ? [opts.ref] : [])),
        hi = Math.max.apply(null, pts.map(function (x) { return x.v; }).concat(opts.ref != null ? [opts.ref] : []));
    if (hi === lo) { hi += 1; lo -= 1; }
    var X = function (i) { return P + (W - 2 * P) * i / Math.max(1, vals.length - 1); }, Y = function (v) { return H - P - (H - 2 * P) * (v - lo) / (hi - lo); };
    if (opts.mark != null && opts.mark >= 0) s.appendChild(svg("line", { x1: X(opts.mark), x2: X(opts.mark), y1: 0, y2: H, class: "mk" }));
    if (opts.ref != null) s.appendChild(svg("line", { x1: P, x2: W - P, y1: Y(opts.ref), y2: Y(opts.ref), class: "ref" }));
    s.appendChild(svg("polyline", { points: pts.map(function (x) { return X(x.i).toFixed(1) + "," + Y(x.v).toFixed(1); }).join(" "), class: "ln " + (opts.tone || "") }));
    var last = pts[pts.length - 1]; s.appendChild(svg("circle", { cx: X(last.i), cy: Y(last.v), r: 2.4, class: "dot " + (opts.tone || "") }));
    return s;
  }
  /* a bigger chart: each game as a dot, the three-game rolling value as the line, the
     season as the dashed line, and the start of each goal as a vertical marker */
  function chart(m, lines, mode, marks, lv) {
    var W = 520, H = 150, L = 34, Rr = 8, T = 10, B = 22;
    var per = lines.map(function (x) { return value(m, sum([x]), mode); });
    var roll = lines.map(function (x, i) { return value(m, sum(lines.slice(Math.max(0, i - 2), i + 1)), mode); });
    var season = lv ? null : value(m, sum(lines), mode);
    var all = per.concat(roll).concat([season]).concat(lv ? [lv.b, lv.n] : []).filter(function (v) { return v != null && isFinite(v); });
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H, class: "pd-chart", preserveAspectRatio: "none" });
    if (all.length < 2) return s;
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all); if (hi === lo) { hi += 1; lo -= 1; }
    var pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    var X = function (i) { return L + (W - L - Rr) * (lines.length > 1 ? i / (lines.length - 1) : 0.5); }, Y = function (v) { return T + (H - T - B) * (hi - v) / (hi - lo); };
    [lo + pad, (lo + hi) / 2, hi - pad].forEach(function (v) {
      s.appendChild(svg("line", { x1: L, x2: W - Rr, y1: Y(v), y2: Y(v), class: "grid" }));
      var t = svg("text", { x: L - 4, y: Y(v) + 3, class: "ax", "text-anchor": "end" }); t.textContent = fmt(m, v); s.appendChild(t); });
    (marks || []).forEach(function (mk) { if (mk.i < 0) return; s.appendChild(svg("line", { x1: X(mk.i), x2: X(mk.i), y1: T, y2: H - B, class: "mk" }));
      var t = svg("text", { x: X(mk.i) + 3, y: T + 8, class: "mkt" }); t.textContent = mk.t; s.appendChild(t); });
    if (season != null) s.appendChild(svg("line", { x1: L, x2: W - Rr, y1: Y(season), y2: Y(season), class: "ref" }));
    /* the two levels a goal is judged on: the average before, and the average now */
    if (lv && lv.gi > 0) {
      if (lv.b != null) s.appendChild(svg("line", { x1: X(0), x2: X(lv.gi - 1), y1: Y(lv.b), y2: Y(lv.b), class: "lvb" }));
      if (lv.n != null) s.appendChild(svg("line", { x1: X(lv.gi), x2: X(lines.length - 1), y1: Y(lv.n), y2: Y(lv.n), class: "lvn " + (lv.tone || "") }));
      s.appendChild(svg("rect", { x: X(lv.gi) - 4, y: T, width: W - Rr - X(lv.gi) + 4, height: H - T - B, class: "now" }));
    }
    var rp = roll.map(function (v, i) { return v == null ? null : X(i).toFixed(1) + "," + Y(v).toFixed(1); }).filter(Boolean);
    if (rp.length > 1) s.appendChild(svg("polyline", { points: rp.join(" "), class: "roll" }));
    per.forEach(function (v, i) { if (v == null || !isFinite(v)) return; var c = svg("circle", { cx: X(i), cy: Y(v), r: 3, class: "gm" });
      var tt = svg("title", {}); tt.textContent = ddmm(lines[i].d) + " " + (lines[i].home ? "vs " : "@ ") + lines[i].opp + ": " + fmt(m, v); c.appendChild(tt); s.appendChild(c); });
    lines.forEach(function (x, i) { if (lines.length > 12 && i % 2) return; var t = svg("text", { x: X(i), y: H - 6, class: "ax", "text-anchor": "middle" }); t.textContent = x.code || ddmm(x.d); s.appendChild(t); });
    return s;
  }

  /* ------------------------------------------------------------ state of the page */
  var UI = { view: "goals", mode: "pg", period: "3", open: null, sel: null };
  try { var sv0 = JSON.parse(localStorage.getItem("lowen-pdev2") || "{}"); if (sv0 && sv0.view) { UI.view = sv0.view; UI.mode = sv0.mode || "pg"; UI.period = sv0.period || "3"; } } catch (e) { }
  function saveUI() { try { localStorage.setItem("lowen-pdev2", JSON.stringify({ view: UI.view, mode: UI.mode, period: UI.period })); } catch (e) { } }
  var ROOT = null;
  function seg(opts, cur, on) { return el("div", { class: "pd-seg" }, opts.map(function (o) { return el("button", { type: "button", class: o[0] === cur ? "on" : "", onclick: function () { on(o[0]); saveUI(); draw(); } }, o[1]); })); }
  function windowOf(lines, period) { if (period === "all") return lines; var n = +period; return lines.slice(-n); }
  /* a trend is the window against the season, said only when the window can carry it */
  /* the trend is the recent games against the games BEFORE them - his own season up to
     then - so a change is not hidden inside an average that already contains it */
  function trend(m, lines, period, mode) {
    var all = sum(lines), wl = windowOf(lines, period), win = sum(wl);
    var prev = lines.slice(0, Math.max(0, lines.length - wl.length));
    var v = value(m, period === "all" ? all : win, mode), base = value(m, (period === "all" || !prev.length) ? all : sum(prev), mode);
    if (period !== "all" && !prev.length) base = null;
    var sm = small(m, period === "all" ? all : win);
    var d = (period === "all" || v == null || base == null) ? null : v - base;
    var th = m.pct ? 3 : (m.k === "ortg" || m.k === "drtg" || m.k === "net") ? 4 : Math.max(0.3, Math.abs(base || 0) * 0.12);
    var tone = (d == null || Math.abs(d) < th || m.hi == null || sm) ? "" : ((d > 0) === m.hi ? "up" : "dn");
    return { v: v, base: base, d: d, tone: tone, small: sm };
  }

  /* ------------------------------------------------------------ the overview */
  function overview(root) {
    var P = people();
    seedOnce(P.main);
    var head = el("div", { class: "pd-head" },
      el("div", { class: "pd-title" }, el("b", {}, "Player development"), el("span", {}, ((D.R && D.R.games) || []).length + " games read from the league")),
      el("div", { class: "pd-tools" }, seg(VIEWS.map(function (v) { return [v[0], v[1]]; }), UI.view, function (v) { UI.view = v; }),
        seg(PERIODS, UI.period, function (v) { UI.period = v; }), seg(MODES, UI.mode, function (v) { UI.mode = v; })));
    root.appendChild(head);
    if (UI.view === "goals") return goalsView(root, P);
    var vw = VIEWS.filter(function (v) { return v[0] === UI.view; })[0] || VIEWS[0];
    var tbl = el("div", { class: "pd-tbl" });
    var cols = vw[2];
    var hd = el("div", { class: "pd-row hd" + (cols ? "" : " mine") }, el("span", {}, "Player"), el("span", {}, "Working on"));
    if (cols) cols.forEach(function (k) { hd.appendChild(el("span", { class: "c", title: MK[k].note || "" }, MK[k].l)); });
    else hd.appendChild(el("span", { class: "c wide" }, "His own measures"));
    tbl.appendChild(hd);
    var row = function (p, dl) {
      var r = rec(p.key), act = (r.goals || []).filter(function (g) { return g.status === "active"; });
      var lines = p.lines, gp = lines.length;
      var tr = el("button", { type: "button", class: "pd-row" + (dl ? " dl" : "") + (cols ? "" : " mine"), onclick: function () { UI.open = p.key; draw(); } },
        el("span", { class: "pl" }, el("u", {}, p.num ? "#" + p.num : ""), el("b", {}, p.nm), el("i", {}, gp ? gp + " GP · " + (sum(lines).s / 60 / gp).toFixed(1) + " min" : (p.missing ? "not on the league roster" : dl ? "no stats yet (ProB)" : "no games yet"))),
        el("span", { class: "wk" }, act.length ? act.map(function (g) { return el("em", {}, g.name); }) : el("i", {}, dl ? "" : "—")));
      var ks = cols || (r.metrics && r.metrics.length ? r.metrics : ["min", "pts", "ts", "pir"]);
      if (!gp) { tr.appendChild(el("span", { class: "c wide none" }, dl ? "Stats arrive with the ProB feed" : "—")); return tr; }
      var box = cols ? tr : el("span", { class: "c wide mm" });
      ks.forEach(function (k) { var m = MK[k]; if (!m) return; var t = trend(m, lines, UI.period, UI.mode);
        var series = lines.map(function (x, i) { return value(m, sum(lines.slice(Math.max(0, i - 2), i + 1)), UI.mode); });
        box.appendChild(el("span", { class: "c " + t.tone + (t.small ? " sm" : ""), title: m.l + ": " + fmt(m, t.v) + (t.d != null ? " · season " + fmt(m, t.base) : "") + (t.small ? " · small sample" : "") },
          cols ? null : el("small", {}, m.l),
          el("b", {}, fmt(m, t.v)), t.d != null && t.tone ? el("i", {}, (t.tone === "up" ? "▲ " : "▼ ") + fmt(Object.assign({}, m, { sign: true }), t.d)) : null,
          spark(series, { ref: t.base, tone: t.tone, w: cols ? 70 : 60, h: 18 }))); });
      if (!cols) tr.appendChild(box);
      return tr;
    };
    P.main.forEach(function (p) { tbl.appendChild(row(p, false)); });
    tbl.appendChild(el("div", { class: "pd-sep" }, "Double licence and the rest of the roster"));
    P.dl.forEach(function (p) { tbl.appendChild(row(p, true)); });
    root.appendChild(tbl);
    root.appendChild(el("div", { class: "pd-foot" },
      "Each figure is for the period chosen; the arrow is against his own season when the period is shorter, and only when the sample carries it (pale = small sample). " +
      "The little line is the three-game rolling value, the dashed one his season. On-floor measures are the team's, with him on - not his alone."));
  }

  /* GAME BY GAME, ONE ROW A MEASURE. The table Trends drew for the PIR, made general: every
     game of the season a column, every row a measure of one player, each cell coloured
     against that row's own season - green above it, red below, darker the further, pale
     when the game gave too little to judge (three attempts are not a percentage). The last
     columns are his season and the line of it. */
  function seasonGames() {
    return ((D.R && D.R.games) || []).map(function (gm) { return { d: gm.g.date, code: gm.code || "", opp: gm.opp, home: gm.home,
      us: gm.home ? gm.hs : gm.as, them: gm.home ? gm.as : gm.hs }; }).sort(function (a, b) { return String(a.d).localeCompare(String(b.d)); });
  }
  function matrix(rows, games, opts) {
    opts = opts || {};
    var t = el("div", { class: "pd-mx", style: "grid-template-columns:minmax(150px,1.6fr) repeat(" + games.length + ",minmax(44px,1fr)) minmax(56px,.9fr) minmax(90px,1.1fr)" });
    t.appendChild(el("span", { class: "hd l" }, opts.head || ""));
    games.forEach(function (g, i) { t.appendChild(el("span", { class: "hd g" + (opts.mark === i ? " mk" : ""), title: g.d + " " + (g.home ? "vs " : "@ ") + g.opp + (g.us != null ? " " + g.us + "–" + g.them : "") },
      el("b", {}, g.code || ddmm(g.d)), el("i", { class: g.us != null ? (g.us > g.them ? "w" : "l") : "" }, ddmm(g.d)))); });
    t.appendChild(el("span", { class: "hd" }, "Season")); t.appendChild(el("span", { class: "hd" }, "Trend"));
    rows.forEach(function (r) {
      if (r.group) { t.appendChild(el("span", { class: "grp", style: "grid-column:1/-1" }, r.group)); return; }
      var m = r.m, byD = {}; r.lines.forEach(function (x) { byD[x.d] = x; });
      var seas = value(m, sum(r.lines), UI.mode);
      t.appendChild(el("span", { class: "l", title: m.note || "" }, el("b", {}, r.label), r.sub ? el("i", {}, r.sub) : null));
      games.forEach(function (g, i) { var x = byD[g.d];
        if (!x) { t.appendChild(el("span", { class: "c dnp" + (opts.mark === i ? " mk" : "") }, "·")); return; }
        var S = sum([x]), v = value(m, S, UI.mode), sm = small(m, S) && m.t === "rate";
        var cls = "";
        if (v != null && seas != null && m.hi != null && !sm) {
          var d = v - seas, s1 = m.pct ? 5 : (m.k === "ortg" || m.k === "drtg" || m.k === "net") ? 8 : Math.max(0.5, Math.abs(seas) * 0.25);
          var good = (d > 0) === m.hi;
          cls = Math.abs(d) < s1 ? "" : (good ? (Math.abs(d) >= 2 * s1 ? "u2" : "u1") : (Math.abs(d) >= 2 * s1 ? "d2" : "d1"));
        }
        t.appendChild(el("span", { class: "c " + cls + (sm ? " sm" : "") + (opts.mark === i ? " mk" : ""), title: ddmm(g.d) + " " + g.opp + " · " + m.l + " " + fmt(m, v) + (sm ? " (small sample)" : "") }, v == null ? "—" : fmt(m, v))); });
      t.appendChild(el("span", { class: "c seas" }, fmt(m, seas)));
      var series = r.lines.map(function (x, i) { return value(m, sum(r.lines.slice(Math.max(0, i - 2), i + 1)), UI.mode); });
      var tr = trend(m, r.lines, "3", UI.mode);
      t.appendChild(el("span", { class: "c tr" }, spark(series, { ref: seas, tone: tr.tone, w: 90, h: 22 })));
    });
    return el("div", { class: "pd-mxw" }, t);
  }
  /* the overview's table: by each player's own goals, or one measure for everybody */
  var MXK = [["goals", "By their goals"], ["pir", "PIR"], ["pts", "Points"], ["reb", "Rebounds"], ["ast", "Assists"], ["tov", "Turnovers"], ["p3p", "3P%"], ["ts", "TS%"], ["pm", "+/-"], ["min", "Minutes"], ["net", "Net on"]];
  function overviewMatrix(root, P) {
    var games = seasonGames(); if (!games.length) return;
    var cur = UI.mx || "goals";
    var box = el("div", { class: "pd-mxbox" });
    box.appendChild(el("div", { class: "pd-h" }, el("b", {}, "Game by game"), el("span", { class: "pd-hs" }, "each cell against that row's own season: green above, red below, darker the further"),
      el("span", { class: "pd-tools" }, seg(MXK, cur, function (v) { UI.mx = v; }))));
    var rows = [];
    if (cur === "goals") {
      P.main.forEach(function (p) { if (!p.lines.length) return; var r = rec(p.key), act = (r.goals || []).filter(function (g) { return g.status === "active"; });
        var ks = []; act.forEach(function (g) { (g.metrics || []).forEach(function (k) { if (MK[k] && ks.indexOf(k) < 0) ks.push(k); }); });
        if (!ks.length) return;
        rows.push({ group: (p.num ? "#" + p.num + " " : "") + p.nm + " · " + act.map(function (g) { return g.name; }).join(" · ") });
        ks.forEach(function (k) { rows.push({ label: MK[k].l, m: MK[k], lines: p.lines }); }); });
    } else {
      P.main.concat(P.dl).forEach(function (p) { if (!p.lines.length) return; rows.push({ label: (p.num ? "#" + p.num + " " : "") + p.nm, m: MK[cur], lines: p.lines }); });
    }
    box.appendChild(matrix(rows, games, { head: cur === "goals" ? "Player · measure" : MK[cur].l }));
    root.appendChild(box);
  }
  /* EVERY PLAYER BY WHAT HE IS WORKING ON. One card a man: his goals, and under each goal
     only the measures that judge it - the value for the period, where it stands against
     his season, and the line of it game by game. On top, how many of those measures are
     going the right way and how many the wrong way, so the page reads in one sweep. */
  function goalsView(root, P) {
    var grid = el("div", { class: "pd-cards" });
    var tile = function (m, lines) {
      var t = trend(m, lines, UI.period, UI.mode);
      var series = lines.map(function (x, i) { return value(m, sum(lines.slice(Math.max(0, i - 2), i + 1)), UI.mode); });
      return { t: t, el: el("div", { class: "pd-tile " + t.tone + (t.small ? " sm" : ""), title: (m.note ? m.note + " · " : "") + (t.base != null ? "before " + fmt(m, t.base) : "") + (t.small ? " · small sample" : "") },
        el("i", {}, m.l),
        el("div", { class: "tv" }, el("b", {}, fmt(m, t.v)),
          t.d != null ? el("em", {}, (t.tone === "up" ? "▲" : t.tone === "dn" ? "▼" : "▸") + " " + fmt(Object.assign({}, m, { sign: true }), t.d)) : null),
        spark(series, { ref: t.base, tone: t.tone, w: 120, h: 28 })) };
    };
    var cardOf = function (p, dl) {
      var r = rec(p.key), act = (r.goals || []).filter(function (g) { return g.status === "active"; }), lines = p.lines;
      var c = el("button", { type: "button", class: "pd-pc" + (dl ? " dl" : ""), onclick: function () { UI.open = p.key; draw(); } });
      var up = 0, dn = 0;
      var body = el("div", { class: "pd-pcb" });
      if (!lines.length) body.appendChild(el("div", { class: "pd-miss" }, p.missing ? "Not on the league roster - check the name." : dl ? "No stats yet - they arrive with the ProB feed." : "No games yet."));
      else {
        var groups = act.length ? act.map(function (g) { return { name: g.name, ks: g.metrics || [], rs: g.ratings || [] }; })
          : [{ name: "No goal set yet · his season", ks: (r.metrics && r.metrics.length) ? r.metrics.slice(0, 4) : ["min", "pts", "ts", "pir"], rs: [] }];
        groups.forEach(function (gr) {
          var row = el("div", { class: "pd-tiles" });
          gr.ks.forEach(function (k) { var m = MK[k]; if (!m) return; var x = tile(m, lines); row.appendChild(x.el);
            if (act.length && !x.t.small) { if (x.t.tone === "up") up++; else if (x.t.tone === "dn") dn++; } });
          body.appendChild(el("div", { class: "pd-gr" }, el("div", { class: "pd-grn" }, gr.name), row)); });
      }
      var verdict = !lines.length || !act.length ? null : (up && !dn) ? ["up", "Improving"] : (dn && !up) ? ["dn", "Dropping"] : (up || dn) ? ["mix", "Mixed"] : ["", "Steady"];
      c.appendChild(el("div", { class: "pd-pch" },
        el("div", { class: "pl" }, el("u", {}, p.num ? "#" + p.num : ""), el("b", {}, p.nm),
          el("span", {}, lines.length ? lines.length + " GP · " + (sum(lines).s / 60 / lines.length).toFixed(1) + " min" : "")),
        verdict ? el("span", { class: "pd-vd " + verdict[0] }, verdict[1], (up || dn) ? el("i", {}, "▲" + up + " ▼" + dn) : null) : null));
      c.appendChild(body);
      return c;
    };
    P.main.forEach(function (p) { grid.appendChild(cardOf(p, false)); });
    root.appendChild(grid);
    overviewMatrix(root, P);
    root.appendChild(el("div", { class: "pd-foot" }, (UI.period === "all" ? "Season values. Choose last 10, 5 or 3 to see each measure against his season." :
      "Last " + UI.period + " games against the games before them: green is better, red is worse, pale is a sample too small to judge. ") +
      "The line is the three-game rolling value, the dashed line his season. Improving / dropping counts only his goal measures."));
    var rest = el("div", { class: "pd-cards rest" });
    P.dl.forEach(function (p) { rest.appendChild(cardOf(p, true)); });
    root.appendChild(el("div", { class: "pd-sep" }, "Double licence and the rest of the roster"));
    root.appendChild(rest);
  }
  /* ONE PLAYER, BY HIS GOALS. Each goal he is working on is a block of its own with one
     answer at the top - better, worse or the same - and under it each of its measures as
     a large before -> now, coloured by what it means, with the game-by-game line and the
     two levels drawn on it. "Before" is the games before the goal began when the goal has
     a start inside the season, and otherwise the games before the last few. Everything
     that is not about his goals is folded underneath. */
  function verdictOf(ts) { var up = 0, dn = 0; ts.forEach(function (t) { if (t.small) return; if (t.tone === "up") up++; else if (t.tone === "dn") dn++; });
    return { up: up, dn: dn, v: (up && !dn) ? ["up", "Improving"] : (dn && !up) ? ["dn", "Getting worse"] : (up || dn) ? ["mix", "Mixed"] : ["", "No clear change yet"] }; }
  function goalCompare(m, lines, g) {
    var gi = -1; for (var i = 0; i < lines.length; i++) if (lines[i].d >= (g.start || "0000")) { gi = i; break; }
    var end = g.end || "", during, before, how;
    if (gi > 0) { during = lines.filter(function (x) { return x.d >= g.start && (!end || x.d <= end); }); before = lines.slice(0, gi); how = "since " + ddmm(g.start) + " against before"; }
    else { var n = Math.min(+UI.period || 3, Math.max(1, lines.length - 1)); during = lines.slice(-n); before = lines.slice(0, lines.length - n); how = "last " + n + " games against the " + before.length + " before"; }
    var a = sum(during), b = sum(before), va = value(m, a, UI.mode), vb = before.length ? value(m, b, UI.mode) : null;
    var sm = small(m, a) || (before.length && small(m, b));
    var d = (va != null && vb != null) ? va - vb : null;
    var th = m.pct ? 3 : (m.k === "ortg" || m.k === "drtg" || m.k === "net") ? 4 : Math.max(0.3, Math.abs(vb || 0) * 0.12);
    var tone = (d == null || sm || m.hi == null || Math.abs(d) < th) ? "" : ((d > 0) === m.hi ? "up" : "dn");
    return { v: va, base: vb, d: d, tone: tone, small: sm, how: how, gi: gi > 0 ? gi : (lines.length - during.length), nd: during.length, nb: before.length };
  }
  function card2(root, key) {
    var P = people(), all = P.main.concat(P.dl), p = all.filter(function (x) { return x.key === key; })[0];
    if (!p) { UI.open = null; return overview(root); }
    var r = rec(key), ed = canEd(), lines = p.lines, S = sum(lines);
    var act = (r.goals || []).filter(function (g) { return g.status === "active"; });
    /* the head: who, and one line for all his goals together */
    var allT = [];
    act.forEach(function (g) { (g.metrics || []).forEach(function (k) { if (MK[k] && lines.length) allT.push(goalCompare(MK[k], lines, g)); }); });
    var V = verdictOf(allT);
    root.appendChild(el("div", { class: "pd-head" },
      el("button", { type: "button", class: "btn", onclick: function () { UI.open = null; draw(); } }, "‹ All players"),
      el("div", { class: "pd-title" }, el("b", {}, (p.num ? "#" + p.num + " " : "") + p.nm),
        el("span", {}, [p.pos, lines.length ? lines.length + " games · " + (S.s / 60 / Math.max(1, lines.length)).toFixed(1) + " min a game" : "no games yet"].filter(Boolean).join(" · "))),
      act.length && lines.length ? el("span", { class: "pd-big " + V.v[0] }, V.v[1], (V.up || V.dn) ? el("i", {}, "▲ " + V.up + "   ▼ " + V.dn) : null) : null,
      el("div", { class: "pd-tools" }, seg(MODES, UI.mode, function (v) { UI.mode = v; }))));
    /* a block per goal */
    if (!act.length) root.appendChild(el("div", { class: "pd-miss" }, "No goal set for him yet." + (ed ? " Add one below." : "")));
    var goalsHost = el("div", { class: "pd-goals2" }); root.appendChild(goalsHost);
    act.forEach(function (g) {
      var ts = [], tiles = el("div", { class: "pd-gt" });
      (g.metrics || []).forEach(function (k) { var m = MK[k]; if (!m || !lines.length) return;
        var c = goalCompare(m, lines, g); ts.push(c);
        tiles.appendChild(el("div", { class: "pd-gm " + c.tone + (c.small ? " sm" : "") },
          el("div", { class: "gl" }, el("b", {}, m.l), m.note ? el("i", { title: m.note }, "?") : null,
            el("span", { class: "gv" }, c.small ? "small sample" : c.tone === "up" ? "better" : c.tone === "dn" ? "worse" : "same")),
          el("div", { class: "gn2" }, el("span", { class: "was" }, c.base == null ? "—" : fmt(m, c.base)), el("span", { class: "arr" }, "→"), el("b", {}, fmt(m, c.v)),
            c.d != null ? el("em", {}, (c.d > 0 ? "+" : "") + fmt(Object.assign({}, m, { sign: false }), c.d)) : null),
          el("div", { class: "gw" }, "before · now"),
          chart(m, lines, UI.mode, [], { gi: c.gi, b: c.base, n: c.v, tone: c.tone }))); });
      var gv = verdictOf(ts);
      var head = el("div", { class: "pd-gh2" }, el("b", {}, g.name), el("span", { class: "pd-big sm " + gv.v[0] }, gv.v[1]),
        el("i", {}, ts[0] ? ts[0].how : ""),
        ed ? el("span", { class: "ga" },
          el("button", { type: "button", onclick: function () { goalEditor(root, p, g); } }, "Edit"),
          el("button", { type: "button", onclick: function () { closeGoal(p, g, "done"); } }, "Finish"),
          el("button", { type: "button", onclick: function () { closeGoal(p, g, "replaced"); goalEditor(root, p, null, g); } }, "Replace")) : null);
      var blk = el("div", { class: "pd-goal2 " + gv.v[0] }, head, g.desc ? el("div", { class: "gd" }, g.desc) : null,
        lines.length ? tiles : el("div", { class: "pd-miss" }, "No games yet."));
      /* the staff's observations on this goal */
      var notes = g.notes || [], nb = el("div", { class: "pd-notes" });
      notes.slice(-3).forEach(function (n) { nb.appendChild(el("div", {}, el("i", {}, ddmm(n.at) + " · " + (n.by || "")), " ", n.text)); });
      if (ed) { var inp = el("input", { class: "pd-in", id: "pdn" + g.id, placeholder: "Add a staff observation and press Enter…" });
        inp.addEventListener("keydown", function (e) { if (e.key !== "Enter" || !inp.value.trim()) return; var txt = inp.value.trim();
          commit("note on " + g.name + " · " + p.nm, function (doc, by) { var x = doc.players[p.key]; var gg = x && (x.goals || []).filter(function (y) { return y.id === g.id; })[0]; if (gg) (gg.notes = gg.notes || []).push({ at: today(), by: by, text: txt }); }).then(function () { draw(); }); });
        nb.appendChild(inp); }
      if (notes.length || ed) blk.appendChild(nb);
      goalsHost.appendChild(blk);
    });
    if (ed) goalsHost.appendChild(el("button", { type: "button", class: "pd-add big", onclick: function () { goalEditor(root, p, null); } }, "+ New goal"));
    /* his goals, game by game: one row per measure, grouped by goal, the start of each
       goal marked on its column */
    if (act.length && lines.length) {
      var games = seasonGames(), mrows = [], mark = null;
      act.forEach(function (g) { mrows.push({ group: g.name });
        var gi = -1; games.forEach(function (x, i) { if (gi < 0 && x.d >= (g.start || "0000")) gi = i; });
        if (gi > 0 && mark == null) mark = gi;
        (g.metrics || []).forEach(function (k) { if (MK[k]) mrows.push({ label: MK[k].l, m: MK[k], lines: lines }); }); });
      var mb = el("div", { class: "pd-mxbox" }, el("div", { class: "pd-h" }, el("b", {}, "His goals · game by game"),
        el("span", { class: "pd-hs" }, "each cell against his own season: green above, red below, darker the further · pale = too little in that game to judge")));
      mb.appendChild(matrix(mrows, games, { head: "Measure", mark: mark }));
      root.appendChild(mb);
    }
    /* everything else, folded */
    var fold = function (title, node, open) { var d = el("details", { class: "pd-hist" }, el("summary", {}, title)); if (open) d.open = true; d.appendChild(node); return d; };
    if (lines.length) {
      var sel = (UI.sel && UI.sel.key === key) ? UI.sel.ks : (r.metrics && r.metrics.length ? r.metrics.slice() : ["pts", "ts", "ast", "pir"]);
      UI.sel = { key: key, ks: sel };
      var ex = el("div", {});
      var groups = {}; M.forEach(function (m) { (groups[m.g] = groups[m.g] || []).push(m); });
      var pick = el("div", { class: "pd-pick" });
      Object.keys(groups).forEach(function (gk) { pick.appendChild(el("div", { class: "pd-pg" }, el("i", {}, gk), groups[gk].map(function (m) { var on = sel.indexOf(m.k) >= 0;
        return el("button", { type: "button", class: on ? "on" : "", title: m.note || "", onclick: function () { if (on) sel.splice(sel.indexOf(m.k), 1); else sel.push(m.k); UI.exOpen = true; draw(); } }, m.l); }))); });
      ex.appendChild(pick);
      var grid = el("div", { class: "pd-charts" });
      sel.forEach(function (k) { var m = MK[k]; if (!m) return; var t = trend(m, lines, "3", UI.mode), seas = value(m, sum(lines), UI.mode);
        grid.appendChild(el("div", { class: "pd-ch" }, el("div", { class: "pd-cht" }, el("b", {}, m.l), el("span", { class: t.tone + (t.small ? " sm" : "") }, "season " + fmt(m, seas) + " · last 3 " + fmt(m, t.v))), chart(m, lines, UI.mode, []))); });
      ex.appendChild(grid);
      root.appendChild(fold("Other stats · season game by game", ex, !!UI.exOpen));
      root.appendChild(fold("Team with him on the floor", impactBox(p, lines), false));
      root.appendChild(logBox(lines));
    }
    root.appendChild(fold("Staff ratings", ratingsBox(p, r, ed), false));
    var past = (r.goals || []).filter(function (g) { return g.status !== "active"; });
    if (past.length) { var hb = el("div", {}); past.forEach(function (g) { var gi = -1; for (var i = 0; i < lines.length; i++) if (lines[i].d >= (g.start || "0000")) { gi = i; break; } hb.appendChild(goalCard(p, g, lines, gi, ed, root)); });
      root.appendChild(fold("Goals worked on before · " + past.length, hb, false)); }
    var log = (D.doc.log || []).filter(function (x) { return String(x.what || "").indexOf(p.nm) >= 0; }).slice(-12).reverse();
    if (log.length) { var lb = el("div", {}); log.forEach(function (x) { lb.appendChild(el("div", { class: "pd-log" }, el("i", {}, String(x.at || "").slice(0, 10) + " · " + (x.by || "")), " ", x.what)); });
      root.appendChild(fold("Changes · " + log.length, lb, false)); }
  }
  /* ------------------------------------------------------------ one player */
  function card(root, key) {
    var P = people(), all = P.main.concat(P.dl), p = all.filter(function (x) { return x.key === key; })[0];
    if (!p) { UI.open = null; return overview(root); }
    var r = rec(key), ed = canEd(), lines = p.lines;
    var S = sum(lines);
    root.appendChild(el("div", { class: "pd-head" },
      el("button", { type: "button", class: "btn", onclick: function () { UI.open = null; draw(); } }, "‹ All players"),
      el("div", { class: "pd-title" }, el("b", {}, (p.num ? "#" + p.num + " " : "") + p.nm), el("span", {}, [p.pos, lines.length ? lines.length + " games · " + (S.s / 60 / Math.max(1, lines.length)).toFixed(1) + " min a game" : "no games yet"].filter(Boolean).join(" · "))),
      el("div", { class: "pd-tools" }, seg(MODES, UI.mode, function (v) { UI.mode = v; }))));
    /* ---- the goals that are on now, each with what its measures say since it began */
    var gIdx = function (g) { if (!g.start) return -1; for (var i = 0; i < lines.length; i++) if (lines[i].d >= g.start) return i; return lines.length; };
    var act = (r.goals || []).filter(function (g) { return g.status === "active"; });
    var gbox = el("div", { class: "pd-goals" });
    gbox.appendChild(el("div", { class: "pd-h" }, el("b", {}, "Working on now"), ed ? el("button", { type: "button", class: "pd-add", onclick: function () { goalEditor(root, p, null); } }, "+ New goal") : null));
    if (!act.length) gbox.appendChild(el("div", { class: "pd-miss" }, "No goal set for him yet."));
    act.forEach(function (g) { gbox.appendChild(goalCard(p, g, lines, gIdx(g), ed, root)); });
    root.appendChild(gbox);
    /* ---- the staff's ratings */
    root.appendChild(ratingsBox(p, r, ed));
    /* ---- the measures, game by game */
    var sel = (UI.sel && UI.sel.key === key) ? UI.sel.ks : (r.metrics && r.metrics.length ? r.metrics.slice() : ["pts", "ts", "ast", "pir"]);
    UI.sel = { key: key, ks: sel };
    var ex = el("div", { class: "pd-ex" });
    ex.appendChild(el("div", { class: "pd-h" }, el("b", {}, "Season · game by game"),
      el("span", { class: "pd-hs" }, "dots = each game · line = three-game rolling · dashed = season · markers = goals"),
      ed ? el("button", { type: "button", class: "pd-add", onclick: function () {
        commit("measures of " + p.nm, function (doc) { var x = doc.players[key] || (doc.players[key] = { metrics: null, goals: [], ratings: [] }); x.metrics = sel.slice(); }).then(function (ok) { toast(ok ? "His measures are saved for the overview" : "Not saved"); draw(); }); } }, "Use these as his measures") : null));
    var groups = {}; M.forEach(function (m) { (groups[m.g] = groups[m.g] || []).push(m); });
    var pick = el("div", { class: "pd-pick" });
    Object.keys(groups).forEach(function (gk) { pick.appendChild(el("div", { class: "pd-pg" }, el("i", {}, gk), groups[gk].map(function (m) {
      var on = sel.indexOf(m.k) >= 0;
      return el("button", { type: "button", class: on ? "on" : "", title: m.note || "", onclick: function () { if (on) sel.splice(sel.indexOf(m.k), 1); else sel.push(m.k); draw(); } }, m.l); }))); });
    ex.appendChild(pick);
    if (!lines.length) ex.appendChild(el("div", { class: "pd-miss" }, p.missing ? "This player is not on the league roster - check the name." : "No games of his in the league feed yet."));
    else {
      /* one marker a game, however many goals began on it; a goal from before the first
         game has no marker - it covers the whole line */
      var mk0 = {}; (r.goals || []).forEach(function (g) { var i = gIdx(g); if (i > 0 && i < lines.length) (mk0[i] = mk0[i] || []).push(g.name); });
      var marks = Object.keys(mk0).map(function (i) { return { i: +i, t: mk0[i].join(" · ") }; });
      var grid = el("div", { class: "pd-charts" });
      sel.forEach(function (k) { var m = MK[k]; if (!m) return;
        var t = trend(m, lines, "5", UI.mode), seas = value(m, sum(lines), UI.mode);
        grid.appendChild(el("div", { class: "pd-ch" },
          el("div", { class: "pd-cht" }, el("b", {}, m.l), el("span", { class: t.tone + (t.small ? " sm" : "") }, "season " + fmt(m, seas) + " · last 5 " + fmt(m, t.v) + (t.base != null ? " · before " + fmt(m, t.base) : "") + (t.small ? " · small sample" : "")),
            m.note ? el("i", { title: m.note }, "?") : null),
          chart(m, lines, UI.mode, marks))); });
      ex.appendChild(grid);
    }
    root.appendChild(ex);
    /* ---- impact: the season on and off, from the league */
    root.appendChild(impactBox(p, lines));
    /* ---- the games themselves */
    if (lines.length) root.appendChild(logBox(lines));
    /* ---- goals that are over: kept with what happened while they were on */
    var past = (r.goals || []).filter(function (g) { return g.status !== "active"; });
    if (past.length) { var hb = el("details", { class: "pd-hist" }, el("summary", {}, "Goals worked on before · " + past.length));
      past.forEach(function (g) { hb.appendChild(goalCard(p, g, lines, gIdx(g), ed, root)); }); root.appendChild(hb); }
    var log = (D.doc.log || []).filter(function (x) { return String(x.what || "").indexOf(p.nm) >= 0; }).slice(-12).reverse();
    if (log.length) { var lb = el("details", { class: "pd-hist" }, el("summary", {}, "Changes · " + log.length));
      log.forEach(function (x) { lb.appendChild(el("div", { class: "pd-log" }, el("i", {}, String(x.at || "").slice(0, 10) + " · " + (x.by || "")), " ", x.what)); }); root.appendChild(lb); }
  }
  /* a goal: its measures from the day it began against before it, and its chart */
  function goalCard(p, g, lines, gi, ed, root) {
    var end = g.end || ""; var during = lines.filter(function (x) { return x.d >= (g.start || "0000") && (!end || x.d <= end); });
    var before = lines.filter(function (x) { return x.d < (g.start || "0000"); });
    var st = { active: ["Active", "on"], done: ["Finished", "done"], replaced: ["Replaced", "rep"] }[g.status] || ["", ""];
    var box = el("div", { class: "pd-goal " + st[1] },
      el("div", { class: "gh" }, el("b", {}, g.name), el("span", { class: "st" }, st[0]),
        el("i", {}, "since " + ddmm(g.start) + (end ? " to " + ddmm(end) : "") + " · " + during.length + " game" + (during.length === 1 ? "" : "s")),
        ed ? el("span", { class: "ga" },
          el("button", { type: "button", onclick: function () { goalEditor(root, p, g); } }, "Edit"),
          g.status === "active" ? el("button", { type: "button", onclick: function () { closeGoal(p, g, "done"); } }, "Finish") : null,
          g.status === "active" ? el("button", { type: "button", onclick: function () { closeGoal(p, g, "replaced"); goalEditor(root, p, null, g); } }, "Replace") : null) : null),
      g.desc ? el("div", { class: "gd" }, g.desc) : null);
    var ms = el("div", { class: "gm" });
    (g.metrics || []).forEach(function (k) { var m = MK[k]; if (!m) return;
      var a = sum(during), b = sum(before), va = value(m, a, UI.mode), vb = value(m, b, UI.mode);
      var sm = small(m, a);
      var d = (va != null && vb != null && b.gp) ? va - vb : null;
      var th = m.pct ? 3 : Math.max(0.3, Math.abs(vb || 0) * 0.12);
      var tone = (d == null || sm || m.hi == null || Math.abs(d) < th) ? "" : ((d > 0) === m.hi ? "up" : "dn");
      var series = lines.map(function (x, i) { return value(m, sum(lines.slice(Math.max(0, i - 2), i + 1)), UI.mode); });
      ms.appendChild(el("div", { class: "gx " + tone + (sm ? " sm" : "") },
        el("i", { title: m.note || "" }, m.l), el("b", {}, fmt(m, va)),
        el("span", {}, b.gp ? "before " + fmt(m, vb) : "since the start"), spark(series, { ref: value(m, sum(lines), UI.mode), mark: gi > 0 ? gi : null, tone: tone, w: 90, h: 22 }))); });
    ([]).forEach(function (rk) {   /* staff ratings live in their own section, not on the goal */
      var lab = (RATINGS.filter(function (x) { return x[0] === rk; })[0] || [rk, rk])[1];
      var rr = ((rec(p.key).ratings) || []).filter(function (x) { return x.k === rk && x.d >= (g.start || "0000") && (!end || x.d <= end); });
      var lastR = rr.length ? rr[rr.length - 1] : null;
      ms.appendChild(el("div", { class: "gx staff" }, el("i", {}, lab + " · staff"), el("b", {}, lastR ? lastR.v + "/5" : "—"),
        el("span", {}, rr.length ? rr.length + " rating" + (rr.length === 1 ? "" : "s") : "not rated yet"), spark(rr.map(function (x) { return x.v; }), { w: 90, h: 22 }))); });
    box.appendChild(ms);
    var notes = (g.notes || []);
    var nb = el("div", { class: "gn" });
    notes.slice(-3).forEach(function (n) { nb.appendChild(el("div", {}, el("i", {}, ddmm(n.at) + " · " + (n.by || "")), " ", n.text)); });
    if (ed) { var inp = el("input", { class: "pd-in", id: "pdn" + g.id, placeholder: "Add a staff observation…" });
      inp.addEventListener("keydown", function (e) { if (e.key !== "Enter" || !inp.value.trim()) return; var txt = inp.value.trim();
        commit("note on " + g.name + " · " + p.nm, function (doc, by) { var x = doc.players[p.key]; var gg = x && (x.goals || []).filter(function (y) { return y.id === g.id; })[0]; if (gg) (gg.notes = gg.notes || []).push({ at: today(), by: by, text: txt }); }).then(function () { draw(); }); });
      nb.appendChild(inp); }
    if (notes.length || ed) box.appendChild(nb);
    return box;
  }
  function closeGoal(p, g, status) {
    commit((status === "done" ? "finished " : "replaced ") + g.name + " · " + p.nm, function (doc) {
      var x = doc.players[p.key]; var gg = x && (x.goals || []).filter(function (y) { return y.id === g.id; })[0];
      if (gg) { gg.status = status; gg.end = today(); } }).then(function () { draw(); });
  }
  /* new goal or edit - the old version of an edited goal goes to the log, whole */
  function goalEditor(root, p, g, from) {
    var box = el("div", { class: "pd-edit" });
    var name = el("input", { class: "pd-in", id: "pdgn", placeholder: "Goal" }); name.value = g ? g.name : (from ? from.name : "");
    var desc = el("textarea", { class: "pd-in", id: "pdgd", rows: "2", placeholder: "What we are working on, and how we will judge it" }); desc.value = g ? (g.desc || "") : "";
    var start = el("input", { class: "pd-in", id: "pdgs", type: "date" }); start.value = g ? (g.start || "") : today();
    var ks = g ? (g.metrics || []).slice() : (from ? (from.metrics || []).slice() : []);
    var rs = g ? (g.ratings || []).slice() : [];
    var mbox = el("div", { class: "pd-pick" });
    var drawM = function () { mbox.innerHTML = "";
      var groups = {}; M.forEach(function (m) { (groups[m.g] = groups[m.g] || []).push(m); });
      Object.keys(groups).forEach(function (gk) { mbox.appendChild(el("div", { class: "pd-pg" }, el("i", {}, gk), groups[gk].map(function (m) { var on = ks.indexOf(m.k) >= 0;
        return el("button", { type: "button", class: on ? "on" : "", onclick: function () { if (on) ks.splice(ks.indexOf(m.k), 1); else ks.push(m.k); drawM(); } }, m.l); }))); });
      mbox.appendChild(el("div", { class: "pd-pg" }, el("i", {}, "Staff ratings"), RATINGS.map(function (x) { var on = rs.indexOf(x[0]) >= 0;
        return el("button", { type: "button", class: on ? "on staff" : "staff", onclick: function () { if (on) rs.splice(rs.indexOf(x[0]), 1); else rs.push(x[0]); drawM(); } }, x[1]); }))); };
    drawM();
    var save = el("button", { type: "button", class: "btn primary sm" }, "Save goal"), cancel = el("button", { type: "button", class: "btn sm" }, "Cancel");
    cancel.onclick = function () { box.remove(); };
    save.onclick = function () { if (!name.value.trim()) { toast("The goal needs a name"); return; } save.disabled = true;
      commit((g ? "edited " : "new goal ") + name.value.trim() + " · " + p.nm, function (doc, by) {
        var x = doc.players[p.key] || (doc.players[p.key] = { metrics: null, goals: [], ratings: [], seeded: true });
        if (g) { var gg = (x.goals || []).filter(function (y) { return y.id === g.id; })[0];
          if (gg) { doc.log.push({ at: new Date().toISOString(), by: by, what: "previous version of " + gg.name + " · " + p.nm, before: JSON.parse(JSON.stringify(gg)) });
            gg.name = name.value.trim(); gg.desc = desc.value.trim(); gg.start = start.value; gg.metrics = ks.slice(); gg.ratings = rs.slice(); } }
        else (x.goals = x.goals || []).push({ id: uid(), name: name.value.trim(), desc: desc.value.trim(), start: start.value || today(), end: "", status: "active", metrics: ks.slice(), ratings: rs.slice(), notes: [], createdAt: new Date().toISOString(), by: by, follows: from ? from.id : "" });
      }).then(function (ok) { toast(ok ? "Goal saved" : "Not saved — check the connection"); draw(); }); };
    box.appendChild(el("div", { class: "pd-h" }, el("b", {}, g ? "Edit goal" : (from ? "Replace " + from.name + " with" : "New goal")), el("span", { class: "pd-hs" }, p.nm)));
    box.appendChild(el("div", { class: "pd-ef" }, el("label", {}, "Goal", name), el("label", {}, "Starts", start)));
    box.appendChild(desc);
    box.appendChild(el("div", { class: "pd-hs" }, "Measures that judge it"));
    box.appendChild(mbox);
    box.appendChild(el("div", { class: "pd-btns" }, save, cancel));
    var at = root.querySelector(".pd-goals2") || root.querySelector(".pd-goals"); if (at) at.appendChild(box); else root.appendChild(box);
    try { name.focus(); } catch (e) { }
  }
  /* what the staff judges by eye, 1 to 5, dated */
  function ratingsBox(p, r, ed) {
    var box = el("div", { class: "pd-rate" });
    var rr = r.ratings || [];
    box.appendChild(el("div", { class: "pd-h" }, el("b", {}, "Staff ratings"), el("span", { class: "pd-hs" }, "what the box score cannot measure - effort, shot selection, decisions, individual defense, catch & shoot against pull-up")));
    var used = RATINGS.filter(function (x) { return rr.some(function (y) { return y.k === x[0]; }); });
    if (used.length) box.appendChild(el("div", { class: "pd-rl" }, used.map(function (x) { var l = rr.filter(function (y) { return y.k === x[0]; });
      return el("div", { class: "pd-rx" }, el("i", {}, x[1]), el("b", {}, l[l.length - 1].v + "/5"), el("span", {}, l.length + " · last " + ddmm(l[l.length - 1].d)), spark(l.map(function (y) { return y.v; }), { w: 80, h: 20 })); })));
    else box.appendChild(el("div", { class: "pd-miss" }, "No staff rating yet."));
    if (ed) {
      var k = el("select", { class: "pd-in", id: "pdrk" }, RATINGS.map(function (x) { return el("option", { value: x[0] }, x[1]); }));
      var v = el("select", { class: "pd-in", id: "pdrv" }, [1, 2, 3, 4, 5].map(function (n) { return el("option", { value: String(n) }, n + " / 5"); })); v.value = "3";
      var nt = el("input", { class: "pd-in", id: "pdrn", placeholder: "Note (optional)" });
      var go = el("button", { type: "button", class: "btn sm" }, "Add rating");
      go.onclick = function () { go.disabled = true; commit("rating " + k.value + " · " + p.nm, function (doc, by) { var x = doc.players[p.key] || (doc.players[p.key] = { metrics: null, goals: [], ratings: [], seeded: true });
          (x.ratings = x.ratings || []).push({ k: k.value, v: +v.value, note: nt.value.trim(), d: today(), by: by }); }).then(function () { draw(); }); };
      box.appendChild(el("div", { class: "pd-ef" }, k, v, nt, go));
    }
    return box;
  }
  /* the season on and off the floor, from the league's own on/off, and the game-by-game
     net with him on - with the possessions each rests on */
  function impactBox(p, lines) {
    var box = el("div", { class: "pd-imp" });
    box.appendChild(el("div", { class: "pd-h" }, el("b", {}, "Team with him on the floor"), el("span", { class: "pd-hs" }, "collective numbers - they describe the five he plays with as much as him")));
    var L = leagueState(), tid = ourId(), PL = (L.players || {})[tid];
    var oo = PL && (PL.onoff || []).filter(function (x) { return String(x.id) === String(p.id); })[0];
    if (oo) {
      var f1 = function (v) { return v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(1); };
      box.appendChild(el("div", { class: "pd-oo" },
        el("div", {}, el("i", {}, "On the floor"), el("b", {}, f1(oo.onNet)), el("span", {}, "ORtg " + (oo.onOer || 0).toFixed(1) + " · DRtg " + (oo.onDer || 0).toFixed(1) + " · " + oo.onPoss + " poss.")),
        el("div", {}, el("i", {}, "Off the floor"), el("b", {}, f1(oo.offNet)), el("span", {}, "ORtg " + (oo.offOer || 0).toFixed(1) + " · DRtg " + (oo.offDer || 0).toFixed(1) + " · " + oo.offPoss + " poss.")),
        el("div", { class: (oo.onNet - oo.offNet) > 3 ? "up" : (oo.onNet - oo.offNet) < -3 ? "dn" : "" }, el("i", {}, "On − off"), el("b", {}, f1(oo.onNet - oo.offNet)),
          el("span", {}, (oo.onPoss < 150 || oo.offPoss < 80) ? "small sample - read with care" : "per 100 possessions"))));
      box.appendChild(el("div", { class: "pd-hs" }, "Season on/off as the league's feed counts it, over all its games; the strip below is each game's play by play, possessions estimated the same way for both teams - the two can differ by a few points."));
    } else box.appendChild(el("div", { class: "pd-miss" }, "The league has no on/off line for him yet."));
    if (lines.length) { var m = MK.net, s = lines.map(function (x) { return value(m, sum([x]), "pg"); });
      box.appendChild(el("div", { class: "pd-strip" }, lines.map(function (x, i) { var v = s[i];
        return el("div", { class: v == null ? "" : v > 0 ? "up" : "dn", title: ddmm(x.d) + " " + x.opp + " · " + Math.round((x.l.on && x.l.on.uposs) || 0) + " poss. on" },
          el("b", {}, v == null ? "—" : (v > 0 ? "+" : "") + Math.round(v)), el("i", {}, x.code || ddmm(x.d))); }))); }
    return box;
  }
  /* every game of his, one line each - the table the Trends players matrix showed, for him */
  function logBox(lines) {
    var box = el("details", { class: "pd-hist", open: "open" }, el("summary", {}, "Game by game · " + lines.length));
    var t = el("div", { class: "pd-log2" });
    ["Game", "Min", "Pts", "Reb", "Ast", "TO", "Stl", "FG", "3P", "FT", "PIR", "+/-", "Net on"].forEach(function (x) { t.appendChild(el("span", { class: "hd" }, x)); });
    lines.slice().reverse().forEach(function (x) { var l = x.l, on = l.on;
      var net = on && on.uposs && on.tposs ? 100 * on.up / on.uposs - 100 * on.tp / on.tposs : null;
      t.appendChild(el("span", { class: "g" }, ddmm(x.d) + " " + (x.home ? "vs " : "@ ") + x.opp + (x.us != null ? " · " + (x.us > x.them ? "W " : "L ") + x.us + "–" + x.them : "")));
      [(l.s / 60).toFixed(0), l.p, (l.or || 0) + (l.dr || 0) || l.r, l.a, l.t, l.stl == null ? "—" : l.stl, l.fm + "/" + l.fa, l.tm + "/" + l.ta, (l.f1 || 0) + "/" + (l.fta == null ? "?" : l.fta), l.pir,
        (l.pm > 0 ? "+" : "") + l.pm, net == null ? "—" : (net > 0 ? "+" : "") + Math.round(net)].forEach(function (v, i) {
        t.appendChild(el("span", { class: i === 9 ? (l.pir >= 15 ? "up" : l.pir <= 0 ? "dn" : "") : i === 11 ? (net > 0 ? "up" : net < 0 ? "dn" : "") : "" }, String(v))); }); });
    box.appendChild(t);
    return box;
  }

  /* ------------------------------------------------------------ the page */
  function draw() {
    if (!ROOT) return;
    var y = 0; try { var ws = document.getElementById("workspace"); y = ws ? ws.scrollTop : 0; } catch (e) { }
    ROOT.innerHTML = "";
    var page = el("div", { class: "pd" });
    ROOT.appendChild(page);
    if (!D.R && D.err) { page.appendChild(el("div", { class: "pd-miss" }, "The season could not be read: " + D.err)); return; }
    if (UI.open) card2(page, UI.open); else overview(page);
    try { var ws2 = document.getElementById("workspace"); if (ws2) ws2.scrollTop = y; } catch (e) { }
  }
  function render(root) {
    ROOT = root; root.innerHTML = "";
    if (!D.R || !D.doc) { root.appendChild(el("div", { class: "ld" }, "Reading the season, game by game…", el("span", { class: "ld-bar" })));
      load(draw); return; }
    draw();
  }
  function css() {
    var s = document.createElement("style");
    s.textContent = [
      ".pd{max-width:1320px;margin:0 auto;padding:10px 4px 30px;display:grid;gap:12px}",
      ".pd-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:10px;border-bottom:2px solid var(--ink,#141821)}",
      ".pd-title{display:flex;flex-direction:column;min-width:0}.pd-title b{font:700 20px 'Oswald',sans-serif;letter-spacing:.12em;text-transform:uppercase}.pd-title span{font:500 11.5px 'IBM Plex Mono',monospace;color:var(--ink-soft,#5b6472)}",
      ".pd-tools{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}",
      ".pd-seg{display:inline-flex;gap:2px;padding:3px;border-radius:9px;background:rgba(20,24,33,.06)}",
      ".pd-seg button{border:0;background:transparent;border-radius:7px;padding:5px 10px;cursor:pointer;font:700 10px 'Oswald',sans-serif;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-soft,#5b6472)}",
      ".pd-seg button.on{background:#141821;color:#fff}",
      ".pd-tbl{display:grid;gap:3px;overflow-x:auto}",
      ".pd-row{display:grid;grid-template-columns:minmax(170px,1.6fr) minmax(150px,1.5fr) repeat(7,minmax(78px,1fr));gap:6px;align-items:center;text-align:left;border:1px solid var(--line,#e4e7ec);border-radius:9px;background:var(--panel,#fff);padding:6px 10px;font:inherit;color:var(--ink,#141821);cursor:pointer;min-width:900px}",
      ".pd-row:hover{border-color:#c6a15b}",
      ".pd-row.mine{grid-template-columns:minmax(170px,1.6fr) minmax(150px,1.5fr) minmax(0,7fr)}",
      ".pd-row.hd{background:transparent;border:0;cursor:default;font:600 9px 'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint,#8a93a2);padding-top:0;padding-bottom:0}",
      ".pd-row.dl{opacity:.75}",
      ".pd-row .pl{display:flex;flex-direction:column;min-width:0}.pd-row .pl b{font-size:13px}.pd-row .pl u{text-decoration:none;font:600 9.5px 'IBM Plex Mono',monospace;color:var(--ink-faint,#8a93a2)}.pd-row .pl i{font:500 10px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-faint,#8a93a2)}",
      ".pd-row .wk{display:flex;flex-wrap:wrap;gap:3px}.pd-row .wk em{font:700 9.5px 'Oswald',sans-serif;font-style:normal;letter-spacing:.06em;text-transform:uppercase;background:rgba(198,161,91,.2);color:#7a5c12;border-radius:4px;padding:1px 6px}",
      ".pd-row .c{display:flex;flex-direction:column;align-items:flex-start;min-width:0;border-radius:6px;padding:2px 5px}",
      ".pd-row .c b{font:700 13px 'IBM Plex Mono',monospace}.pd-row .c i{font:600 9.5px 'IBM Plex Mono',monospace;font-style:normal}.pd-row .c small{font:600 8.5px 'IBM Plex Mono',monospace;text-transform:uppercase;color:var(--ink-faint,#8a93a2)}",
      ".pd-row .c.up{background:rgba(47,158,134,.1)}.pd-row .c.up i{color:#17805a}.pd-row .c.dn{background:rgba(216,82,78,.09)}.pd-row .c.dn i{color:#c0403c}.pd-row .c.sm{opacity:.55}",
      ".pd-row .c.wide{flex-direction:row;flex-wrap:wrap;gap:6px}.pd-row .c.mm .c{border:1px solid var(--line,#eef0f3)}.pd-row .c.none{font-size:11.5px;color:var(--ink-faint,#8a93a2)}",
      ".pd-big{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:5px 14px;font:700 13px 'Oswald',sans-serif;letter-spacing:.12em;text-transform:uppercase;background:var(--panel-2,#f1f2f4);color:var(--ink-soft,#5b6472);white-space:nowrap}",
      ".pd-big i{font:600 11px 'IBM Plex Mono',monospace;font-style:normal;letter-spacing:0;white-space:pre}",
      ".pd-big.up{background:#2f9e86;color:#fff}.pd-big.dn{background:#d8524e;color:#fff}.pd-big.mix{background:#d9a521;color:#fff}",
      ".pd-big.sm{font-size:10.5px;padding:3px 10px}",
      ".pd-goals2{display:grid;gap:12px}",
      ".pd-goal2{border:1px solid var(--line,#e4e7ec);border-left:6px solid #cfd4dc;border-radius:12px;background:var(--panel,#fff);padding:12px 14px;display:grid;gap:8px}",
      ".pd-goal2.up{border-left-color:#2f9e86}.pd-goal2.dn{border-left-color:#d8524e}.pd-goal2.mix{border-left-color:#d9a521}",
      ".pd-gh2{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.pd-gh2 > b{font:700 18px 'Oswald',sans-serif;letter-spacing:.08em;text-transform:uppercase}.pd-gh2 > i{font:500 11px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-faint,#8a93a2)}",
      ".pd-gh2 .ga{margin-left:auto;display:flex;gap:4px}.pd-gh2 .ga button{border:1px solid var(--line-strong,#cfd4dc);background:var(--panel,#fff);border-radius:5px;padding:2px 9px;cursor:pointer;font-size:11px}",
      ".pd-goal2 .gd{font-size:12.5px;color:var(--ink-soft,#5b6472)}",
      ".pd-gt{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}",
      ".pd-gm{border-radius:10px;padding:8px 10px 4px;background:var(--panel-2,#f4f5f7);border-top:4px solid #cfd4dc;display:grid;gap:2px;min-width:0}",
      ".pd-gm.up{background:rgba(47,158,134,.08);border-top-color:#2f9e86}.pd-gm.dn{background:rgba(216,82,78,.07);border-top-color:#d8524e}.pd-gm.sm{opacity:.6}",
      ".pd-gm .gl{display:flex;align-items:center;gap:6px}.pd-gm .gl b{font:700 11px 'Oswald',sans-serif;letter-spacing:.12em;text-transform:uppercase}.pd-gm .gl i{font-style:normal;font-size:10px;color:var(--ink-faint,#8a93a2);cursor:help}",
      ".pd-gm .gv{margin-left:auto;font:700 10px 'Oswald',sans-serif;letter-spacing:.12em;text-transform:uppercase;border-radius:999px;padding:1px 8px;background:rgba(20,24,33,.07);color:var(--ink-soft,#5b6472)}",
      ".pd-gm.up .gv{background:#2f9e86;color:#fff}.pd-gm.dn .gv{background:#d8524e;color:#fff}",
      ".pd-gm .gn2{display:flex;align-items:baseline;gap:8px}.pd-gm .gn2 .was{font:600 17px 'Oswald',sans-serif;color:var(--ink-faint,#8a93a2)}.pd-gm .gn2 .arr{color:var(--ink-faint,#8a93a2)}",
      ".pd-gm .gn2 b{font:700 28px/1 'Oswald',sans-serif}.pd-gm .gn2 em{font:700 12px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-soft,#5b6472)}",
      ".pd-gm.up .gn2 b,.pd-gm.up .gn2 em{color:#17805a}.pd-gm.dn .gn2 b,.pd-gm.dn .gn2 em{color:#c0403c}",
      ".pd-gm .gw{font:600 8.5px 'IBM Plex Mono',monospace;text-transform:uppercase;color:var(--ink-faint,#8a93a2)}",
      ".pd-gm .pd-chart{height:110px}",
      ".pd-chart .lvb{stroke:#8a93a2;stroke-width:2.5;stroke-dasharray:5 3}.pd-chart .lvn{stroke:#5b6472;stroke-width:3}.pd-chart .lvn.up{stroke:#2f9e86}.pd-chart .lvn.dn{stroke:#d8524e}.pd-chart .now{fill:rgba(198,161,91,.10)}",
      ".pd-notes{display:grid;gap:3px;font-size:12px}.pd-notes i{font:500 10px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-faint,#8a93a2)}",
      ".pd-add.big{justify-self:start;margin-left:0;padding:6px 14px;font-size:11px}",
      ".pd-mxbox{border:1px solid var(--line,#e4e7ec);border-radius:11px;background:var(--panel,#fff);padding:10px 12px}",
      ".pd-mxbox .pd-h .pd-tools{margin-left:auto}",
      ".pd-mxw{overflow-x:auto}",
      ".pd-mx{display:grid;gap:2px;min-width:720px;font-size:12px;align-items:stretch}",
      ".pd-mx .hd{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;font:600 9px 'IBM Plex Mono',monospace;text-transform:uppercase;color:var(--ink-faint,#8a93a2);padding-bottom:3px}",
      ".pd-mx .hd.l{align-items:flex-start}.pd-mx .hd b{font:700 10px 'Oswald',sans-serif;letter-spacing:.06em;color:var(--ink,#141821)}",
      ".pd-mx .hd i{font-style:normal;border-radius:3px;padding:0 3px}.pd-mx .hd i.w{background:rgba(47,158,134,.18);color:#17805a}.pd-mx .hd i.l{background:rgba(216,82,78,.15);color:#c0403c}",
      ".pd-mx .grp{font:700 10.5px 'Oswald',sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#7a5c12;padding:6px 0 2px;border-bottom:1px solid var(--line,#e4e7ec)}",
      ".pd-mx .l{display:flex;flex-direction:column;justify-content:center;padding:2px 4px;min-width:0}.pd-mx .l b{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pd-mx .l i{font-style:normal;font-size:10px;color:var(--ink-faint,#8a93a2)}",
      ".pd-mx .c{display:flex;align-items:center;justify-content:center;border-radius:5px;background:var(--panel-2,#f4f5f7);font:700 11.5px 'IBM Plex Mono',monospace;padding:4px 2px;min-height:24px}",
      ".pd-mx .c.u1{background:rgba(47,158,134,.22);color:#17603f}.pd-mx .c.u2{background:#2f9e86;color:#fff}.pd-mx .c.d1{background:rgba(216,82,78,.2);color:#9e302c}.pd-mx .c.d2{background:#d8524e;color:#fff}",
      ".pd-mx .c.sm{opacity:.45}.pd-mx .c.dnp{background:transparent;color:var(--ink-faint,#cfd4dc)}",
      ".pd-mx .c.seas{background:transparent;border:1px solid var(--line,#e4e7ec)}.pd-mx .c.tr{background:transparent}",
      ".pd-mx .mk{box-shadow:inset 3px 0 0 #c6a15b}",
      ".pd-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(520px,1fr));gap:10px}",
      ".pd-cards.rest{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}",
      "@media (max-width:640px){.pd-cards{grid-template-columns:minmax(0,1fr)}}",
      ".pd-pc{display:grid;gap:8px;text-align:left;border:1px solid var(--line,#e4e7ec);border-radius:12px;background:var(--panel,#fff);padding:10px 12px;cursor:pointer;font:inherit;color:var(--ink,#141821);min-width:0}",
      ".pd-pc:hover{border-color:#c6a15b;box-shadow:0 2px 10px rgba(20,24,33,.08)}",
      ".pd-pc.dl{opacity:.8}",
      ".pd-pch{display:flex;align-items:center;gap:10px;padding-bottom:6px;border-bottom:2px solid var(--ink,#141821)}",
      ".pd-pch .pl{display:flex;align-items:baseline;gap:7px;min-width:0;flex-wrap:wrap}.pd-pch .pl u{text-decoration:none;font:600 11px 'IBM Plex Mono',monospace;color:var(--ink-faint,#8a93a2)}.pd-pch .pl b{font:700 17px 'Oswald',sans-serif;letter-spacing:.06em;text-transform:uppercase}.pd-pch .pl span{font:500 10.5px 'IBM Plex Mono',monospace;color:var(--ink-faint,#8a93a2)}",
      ".pd-vd{margin-left:auto;display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;font:700 10.5px 'Oswald',sans-serif;letter-spacing:.12em;text-transform:uppercase;background:var(--panel-2,#f1f2f4);color:var(--ink-soft,#5b6472);white-space:nowrap}",
      ".pd-vd i{font:600 10px 'IBM Plex Mono',monospace;font-style:normal;letter-spacing:0}",
      ".pd-vd.up{background:rgba(47,158,134,.16);color:#17805a}.pd-vd.dn{background:rgba(216,82,78,.14);color:#c0403c}.pd-vd.mix{background:rgba(217,165,33,.18);color:#8a6410}",
      ".pd-pcb{display:grid;gap:8px}",
      ".pd-grn{font:700 10px 'Oswald',sans-serif;letter-spacing:.13em;text-transform:uppercase;color:#7a5c12;margin-bottom:4px}",
      ".pd-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:5px}",
      ".pd-tile{display:grid;gap:1px;border-radius:8px;padding:5px 7px 3px;background:var(--panel-2,#f4f5f7);border-top:3px solid #cfd4dc;min-width:0}",
      ".pd-tile.up{background:rgba(47,158,134,.09);border-top-color:#2f9e86}.pd-tile.dn{background:rgba(216,82,78,.08);border-top-color:#d8524e}.pd-tile.sm{opacity:.55}.pd-tile.staff{border-top-style:dashed;border-top-color:#c6a15b}",
      ".pd-tile i{font:600 8.5px 'IBM Plex Mono',monospace;font-style:normal;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-faint,#8a93a2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".pd-tile .tv{display:flex;align-items:baseline;gap:6px}.pd-tile .tv b{font:700 17px 'Oswald',sans-serif}.pd-tile .tv em{font:700 10px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-soft,#5b6472)}",
      ".pd-tile.up .tv b,.pd-tile.up .tv em{color:#17805a}.pd-tile.dn .tv b,.pd-tile.dn .tv em{color:#c0403c}",
      ".pd-tile svg{width:100%;height:28px}",
      ".pd-sep{font:700 11px 'Oswald',sans-serif;letter-spacing:.15em;text-transform:uppercase;margin:14px 0 4px;padding-bottom:4px;border-bottom:2px solid var(--ink,#141821)}",
      ".pd-foot{font-size:11.5px;color:var(--ink-soft,#5b6472);max-width:90ch}",
      ".pd-spark{display:block}.pd-spark .ln{fill:none;stroke:#8a93a2;stroke-width:1.6}.pd-spark .ln.up{stroke:#2f9e86}.pd-spark .ln.dn{stroke:#d8524e}.pd-spark .ref{stroke:#cfd4dc;stroke-dasharray:2 2}.pd-spark .mk{stroke:#c6a15b;stroke-width:1.5}.pd-spark .dot{fill:#5b6472}.pd-spark .dot.up{fill:#2f9e86}.pd-spark .dot.dn{fill:#d8524e}",
      ".pd-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}.pd-h b{font:700 12px 'Oswald',sans-serif;letter-spacing:.15em;text-transform:uppercase}.pd-hs{font-size:11px;color:var(--ink-faint,#8a93a2)}",
      ".pd-add{margin-left:auto;border:1px solid var(--line-strong,#cfd4dc);background:transparent;border-radius:6px;padding:3px 10px;cursor:pointer;font:700 10px 'Oswald',sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--ink,#141821)}",
      ".pd-goals,.pd-rate,.pd-ex,.pd-imp{border:1px solid var(--line,#e4e7ec);border-radius:11px;background:var(--panel,#fff);padding:10px 12px}",
      ".pd-goal{border-left:4px solid #c6a15b;border-radius:8px;background:rgba(198,161,91,.07);padding:8px 10px;margin-bottom:8px}",
      ".pd-goal.done{border-left-color:#2f9e86;background:rgba(47,158,134,.06)}.pd-goal.rep{border-left-color:#8a93a2;background:var(--panel-2,#f4f5f7)}",
      ".pd-goal .gh{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.pd-goal .gh b{font:700 14px 'Oswald',sans-serif;letter-spacing:.06em;text-transform:uppercase}",
      ".pd-goal .st{font:700 9px 'Oswald',sans-serif;letter-spacing:.12em;text-transform:uppercase;border-radius:999px;padding:1px 7px;background:#141821;color:#fff}",
      ".pd-goal .gh i{font:500 10.5px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-soft,#5b6472)}",
      ".pd-goal .ga{margin-left:auto;display:flex;gap:4px}.pd-goal .ga button{border:1px solid var(--line-strong,#cfd4dc);background:var(--panel,#fff);border-radius:5px;padding:1px 8px;cursor:pointer;font-size:11px}",
      ".pd-goal .gd{font-size:12px;color:var(--ink-soft,#5b6472);margin:3px 0 6px}",
      ".pd-goal .gm{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}",
      ".pd-goal .gx{display:grid;grid-template-columns:1fr auto;gap:0 6px;align-items:center;background:var(--panel,#fff);border:1px solid var(--line,#e4e7ec);border-radius:7px;padding:4px 7px}",
      ".pd-goal .gx i{grid-column:1/-1;font:600 9px 'IBM Plex Mono',monospace;font-style:normal;text-transform:uppercase;color:var(--ink-faint,#8a93a2)}",
      ".pd-goal .gx b{font:700 16px 'Oswald',sans-serif}.pd-goal .gx span{font-size:10.5px;color:var(--ink-soft,#5b6472)}.pd-goal .gx svg{grid-column:1/-1}",
      ".pd-goal .gx.up b{color:#17805a}.pd-goal .gx.dn b{color:#c0403c}.pd-goal .gx.sm{opacity:.6}.pd-goal .gx.staff{border-style:dashed}",
      ".pd-goal .gn{margin-top:6px;font-size:12px;display:grid;gap:3px}.pd-goal .gn i{font:500 10px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-faint,#8a93a2)}",
      ".pd-in{border:1px solid var(--line-strong,#cfd4dc);border-radius:6px;padding:5px 8px;font:inherit;font-size:12.5px;background:var(--panel,#fff);color:var(--ink,#141821);width:100%;box-sizing:border-box}",
      ".pd-edit{border:2px solid #c6a15b;border-radius:10px;padding:10px;margin-top:8px;display:grid;gap:8px;background:var(--panel,#fff)}",
      ".pd-ef{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;align-items:end}.pd-ef label{display:grid;gap:3px;font-size:11px;color:var(--ink-soft,#5b6472)}",
      ".pd-btns{display:flex;gap:6px}",
      ".pd-pick{display:grid;gap:4px;margin-bottom:8px}.pd-pg{display:flex;flex-wrap:wrap;align-items:center;gap:4px}.pd-pg > i{font:700 9px 'Oswald',sans-serif;font-style:normal;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint,#8a93a2);min-width:84px}",
      ".pd-pg button{border:1px solid var(--line,#e4e7ec);background:var(--panel,#fff);border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer;color:var(--ink,#141821)}",
      ".pd-pg button.on{background:#141821;color:#fff;border-color:#141821}.pd-pg button.staff{border-style:dashed}.pd-pg button.on.staff{background:#7a5c12;border-color:#7a5c12}",
      ".pd-charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:10px}",
      ".pd-ch{border:1px solid var(--line,#eef0f3);border-radius:8px;padding:6px 8px}",
      ".pd-cht{display:flex;align-items:baseline;gap:8px}.pd-cht b{font:700 11.5px 'Oswald',sans-serif;letter-spacing:.1em;text-transform:uppercase}.pd-cht span{font:500 10.5px 'IBM Plex Mono',monospace;color:var(--ink-soft,#5b6472)}.pd-cht span.up{color:#17805a}.pd-cht span.dn{color:#c0403c}.pd-cht span.sm{opacity:.6}.pd-cht i{margin-left:auto;font-style:normal;font-size:10px;color:var(--ink-faint,#8a93a2);cursor:help}",
      ".pd-chart{width:100%;height:150px;display:block}.pd-chart .grid{stroke:var(--line,#eef0f3)}.pd-chart .ax{font:9px 'IBM Plex Mono',monospace;fill:var(--ink-faint,#8a93a2)}",
      ".pd-chart .ref{stroke:#8a93a2;stroke-dasharray:4 3}.pd-chart .roll{fill:none;stroke:#2f6cc0;stroke-width:2.2}.pd-chart .gm{fill:#141821;opacity:.55}.pd-chart .mk{stroke:#c6a15b;stroke-width:1.5}.pd-chart .mkt{font:700 8.5px 'Oswald',sans-serif;fill:#7a5c12;letter-spacing:.05em}",
      ".pd-rl{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px;margin-bottom:6px}.pd-rx{border:1px dashed var(--line-strong,#cfd4dc);border-radius:7px;padding:4px 8px;display:grid}.pd-rx i{font:600 9px 'IBM Plex Mono',monospace;font-style:normal;text-transform:uppercase;color:var(--ink-faint,#8a93a2)}.pd-rx b{font:700 16px 'Oswald',sans-serif}.pd-rx span{font-size:10.5px;color:var(--ink-soft,#5b6472)}",
      ".pd-oo{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:8px}.pd-oo > div{border-radius:8px;background:var(--panel-2,#f4f5f7);padding:6px 9px;display:grid}.pd-oo i{font:600 9px 'IBM Plex Mono',monospace;font-style:normal;text-transform:uppercase;color:var(--ink-faint,#8a93a2)}.pd-oo b{font:700 20px 'Oswald',sans-serif}.pd-oo span{font-size:10.5px;color:var(--ink-soft,#5b6472)}.pd-oo .up b{color:#17805a}.pd-oo .dn b{color:#c0403c}",
      ".pd-strip{display:flex;gap:3px;flex-wrap:wrap}.pd-strip > div{display:grid;justify-items:center;border-radius:6px;padding:3px 6px;background:var(--panel-2,#f4f5f7);min-width:42px}.pd-strip b{font:700 12px 'IBM Plex Mono',monospace}.pd-strip i{font:600 9px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-faint,#8a93a2)}.pd-strip .up b{color:#17805a}.pd-strip .dn b{color:#c0403c}",
      ".pd-hist{border:1px solid var(--line,#e4e7ec);border-radius:11px;background:var(--panel,#fff);padding:8px 12px}.pd-hist > summary{cursor:pointer;font:700 11.5px 'Oswald',sans-serif;letter-spacing:.14em;text-transform:uppercase}",
      ".pd-log2{display:grid;grid-template-columns:minmax(200px,2.4fr) repeat(12,minmax(44px,1fr));gap:2px 6px;font-size:12px;margin-top:6px;overflow-x:auto}.pd-log2 .hd{font:600 9px 'IBM Plex Mono',monospace;text-transform:uppercase;color:var(--ink-faint,#8a93a2)}.pd-log2 span{font-family:'IBM Plex Mono',monospace;white-space:nowrap}.pd-log2 .g{font-family:inherit;font-weight:600;overflow:hidden;text-overflow:ellipsis}.pd-log2 .up{color:#17805a;font-weight:700}.pd-log2 .dn{color:#c0403c;font-weight:700}",
      ".pd-log{font-size:12px;padding:2px 0}.pd-log i{font:500 10px 'IBM Plex Mono',monospace;font-style:normal;color:var(--ink-faint,#8a93a2)}",
      ".pd-miss{font-size:12.5px;color:var(--ink-soft,#5b6472);background:var(--panel-2,#f4f5f7);border-radius:8px;padding:8px 10px;border-left:3px solid var(--ink-faint,#8a93a2)}"
    ].join("\n");
    document.head.appendChild(s);
  }
  css();
  window.PDev = { render: render, reload: function () { D.R = null; D.doc = null; } };
})();
