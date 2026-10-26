/* ============================================================================
   Coaches Hub — Offensive Staples
   Reads the tagging CSVs straight from the two shared Drive folders and fills
   the three stats placeholders: post-game card, post-practice card, and the
   team-wide overview.

   Depends on /.netlify/functions/drive (see that file for the env vars).
   Self-contained: injects its own CSS, touches no app state.
   ========================================================================= */
(function () {
  "use strict";

  var FN = "/.netlify/functions/drive";
  var cacheList = {};   // kind -> promise of [{id,name,...}]
  var cacheFile = {};   // fileId -> promise of parsed rows

  /* Every file read off the Drive stayed in here for the rest of the session - the raw
     bytes of each workbook in one case and every parsed row of each export in the other.
     A coach who works through a dozen reports in an afternoon was holding all twelve.
     They are kept as a short queue now: the newest 10, and the rest let go. Letting one
     go costs a re-download, which is a second; holding them all was costing the tab. */
  var CACHE_MAX = 10, cacheAge = [];
  function cacheKeep(key) {
    var i = cacheAge.indexOf(key);
    if (i >= 0) cacheAge.splice(i, 1);
    cacheAge.push(key);
    while (cacheAge.length > CACHE_MAX) { var old = cacheAge.shift(); delete cacheFile[old]; }
  }
  function cacheForget() { cacheAge.length = 0; }

  /* ---------------------------------------------------------------- fetch */

  /* the Drive function wants the session token; the app hands over a fetch that adds it */
  function dfetch(url) {
    return window.LowenDriveFetch ? window.LowenDriveFetch(url) : fetch(url);
  }

  /* THE FILES KEPT IN THIS BROWSER. A tagging export does not change once it is in the
     folder, so each one is kept here with the date Drive gives it: the next visit reads it
     from the browser, and only a new file - or one changed since - comes down again. */
  var fileStamp = {};   // fileId -> Drive's modifiedTime, from the last listing
  var _idbP = null;
  function idb() {
    if (_idbP) return _idbP;
    _idbP = new Promise(function (ok) {
      try {
        var q = indexedDB.open("lowen-tagging", 1);
        q.onupgradeneeded = function () { q.result.createObjectStore("files"); };
        q.onsuccess = function () { ok(q.result); };
        q.onerror = function () { ok(null); };
      } catch (e) { ok(null); }
    });
    return _idbP;
  }
  function idbGet(id, stamp) {
    return idb().then(function (db) {
      if (!db || !stamp) return null;
      return new Promise(function (ok) {
        try {
          var q = db.transaction("files").objectStore("files").get(id);
          q.onsuccess = function () { var v = q.result; ok(v && v.m === stamp ? v.t : null); };
          q.onerror = function () { ok(null); };
        } catch (e) { ok(null); }
      });
    });
  }
  function idbPut(id, stamp, text) {
    if (!stamp) return;
    idb().then(function (db) {
      if (!db) return;
      try { db.transaction("files", "readwrite").objectStore("files").put({ m: stamp, t: text }, id); } catch (e) {}
    });
  }

  function listFolder(kind) {
    if (!cacheList[kind]) {
      cacheList[kind] = dfetch(FN + "?folder=" + kind)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.error) throw new Error(j.error);
          /* the public listing gives no dates: then the name stands for the version (a new export is a new file, with its own id) */
          (j.files || []).forEach(function (f) { if (f && f.id) fileStamp[f.id] = f.modifiedTime ? (f.modifiedTime + "|" + (f.size || "")) : ("name:" + (f.name || "")); });
          return j.files || [];
        })
        /* a failed list must not be cached: asked before sign-in, it would stay failed */
        .catch(function (e) { delete cacheList[kind]; throw e; });
    }
    return cacheList[kind];
  }

  /* Throw away everything read from Drive. The comparison panel calls this each
     time it is opened, so collapsing and reopening picks up a file uploaded in
     the meantime instead of redrawing the copy held in memory. */
  function dropCache() {
    Object.keys(cacheList).forEach(function (k) { delete cacheList[k]; });
    Object.keys(cacheFile).forEach(function (k) { delete cacheFile[k]; });
    cacheForget();
  }

  function getRows(fileId) {
    cacheKeep(fileId);
    if (!cacheFile[fileId]) {
      var stamp = fileStamp[fileId] || "";
      cacheFile[fileId] = idbGet(fileId, stamp).then(function (kept) {
        if (kept != null) return parseCsv(kept);
        return dfetch(FN + "?file=" + encodeURIComponent(fileId))
          .then(function (r) {
            if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || "download failed"); },
                                            function () { throw new Error("download failed"); });
            return r.arrayBuffer();
          })
          .then(function (buf) { var text = decodeBytes(buf); idbPut(fileId, stamp, text); return parseCsv(text); });
      });
      /* a failed read is not kept: the next ask tries again */
      cacheFile[fileId].catch(function () { delete cacheFile[fileId]; });
    }
    return cacheFile[fileId];
  }

  // The older exports are latin-1, the newer ones UTF-8. Try UTF-8 strictly;
  // fall back to latin-1 when it throws.
  function decodeBytes(buf) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (e) {
      return new TextDecoder("iso-8859-1").decode(buf);
    }
  }

  /* Some exports come out as one single line with no newlines at all — split on
     a newline they give one line, the header is dropped and nothing is left. Then
     the only reliable record boundary is a "mm:ss,mm:ss," pair that describes a
     plausible clip: it lasts more than nothing and at most two minutes, and the
     tagging keeps moving forward. */
  function splitBlob(text) {
    var re = /(\d{1,3}:\d{2}),(\d{1,3}:\d{2}),/g, m, cands = [];
    while ((m = re.exec(text))) {
      cands.push({ p: m.index, t1: m[1], t2: m[2], len: m[0].length });
      re.lastIndex = m.index + 1;                    // candidates may overlap
    }
    var ok = [], out = [], last = -1e9, pos = 0, i, c, a, b2;
    for (i = 0; i < cands.length; i++) {
      c = cands[i];
      if (c.p < pos) continue;
      a = secs(c.t1); b2 = secs(c.t2);
      if (!(b2 - a > 0 && b2 - a <= 120)) continue;
      if (a < last - 60) continue;
      ok.push(c); last = a; pos = c.p + c.len;
    }
    for (i = 0; i < ok.length; i++) {
      var end = i + 1 < ok.length ? ok[i + 1].p : text.length;
      out.push(ok[i].t1 + "," + ok[i].t2 + "," + text.slice(ok[i].p + ok[i].len, end));
    }
    return out;
  }
  function parseCsv(text) {
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "");
    var lines = text.split("\n").filter(function (l) { return l.trim(); });
    /* The first couple of lines are where an export writes what it is and when it was
       made, and they were thrown away unread. They are the only place a session's own
       date lives when the file name does not carry it, so they are kept. */
    /* The head of the sheet, where an export writes what it is, the season and the day.
       Two lines was too tight: the date sits a few lines in on some exports. Six is
       still the head and not the body, which matters because the body is full of clock
       times and tag text that a date reader would happily mistake for a date. */
    var top = lines.slice(0, 6).join(" \u00b7 ");
    if (lines.length > 5) lines.shift();             // header
    else lines = splitBlob(text);                    // the one-line export
    var out = lines.map(function (line) {
      var i1 = line.indexOf(","), i2 = line.indexOf(",", i1 + 1), i3 = line.indexOf(",", i2 + 1);
      var ini = line.slice(0, i1), fin = line.slice(i1 + 1, i2);
      var cat = line.slice(i2 + 1, i3 < 0 ? undefined : i3);
      var desc = i3 < 0 ? "" : line.slice(i3 + 1);
      // "Rim Rolls - Dives" carries the same separator that splits the tags.
      desc = desc.replace(/Rim Rolls - Dives/g, "Rim Rolls/Dives");
      return {
        a: secs(ini), b: secs(fin), cat: cat.trim(),
        tags: desc.split(" - ").map(function (t) { return t.trim(); }).filter(Boolean)
      };
    }).filter(function (r) { return r.cat; });
    try { out.header = top; } catch (e) {}
    return out;
  }

  /* The date a session carries inside itself. Only the first two lines are read: the
     body is full of clock times and tag text, and hunting a date through all of it
     finds one that is not a date sooner or later. */
  /* A DATE WRITTEN THE WAY A COACH WRITES IT.
     The sheets carry their day as "OCT 3" with the season on the line above it, and
     fileDate only ever understood digits - 2026-10-03 and 3/10/2026 - so every one of
     those files looked undated and fell back on whatever day it happened to reach the
     Drive. The month names are read now, in the four languages this staff writes in,
     either way round (OCT 3 and 3 OCT), with or without a year. */
  var MONTH_WORDS = {
    jan:1, ene:1, gen:1, january:1, enero:1, gener:1, januar:1,
    feb:2, february:2, febrero:2, febrer:2, februar:2,
    mar:3, mrz:3, march:3, marzo:3, marc:3, "març":3, maerz:3,
    apr:4, abr:4, april:4, abril:4,
    may:5, mai:5, mayo:5, maig:5,
    jun:6, june:6, junio:6, juny:6, juni:6,
    jul:7, july:7, julio:7, juliol:7, juli:7,
    aug:8, ago:8, august:8, agosto:8, agost:8,
    sep:9, sept:9, set:9, september:9, septiembre:9, setembre:9,
    oct:10, okt:10, october:10, octubre:10, oktober:10,
    nov:11, november:11, noviembre:11, novembre:11,
    dec:12, dez:12, dic:12, des:12, december:12, diciembre:12, desembre:12, dezember:12
  };
  function monthWord(w) {
    var k = String(w || "").toLowerCase().replace(/\.$/, "");
    return MONTH_WORDS[k] || 0;
  }
  /* A season reads "2026/27" or "2026-27": August to December belong to the first year
     and January to July to the second, which is how a basketball season runs. */
  function seasonYear(text, mo) {
    var m = String(text || "").match(/\b(20\d{2})\s*[\/\-]\s*(\d{2})\b/);
    if (m) return mo >= 8 ? +m[1] : (+m[1] + 1);
    m = String(text || "").match(/\b(20\d{2})\b/);
    if (m) return +m[1];
    return null;
  }
  function wordDate(text) {
    var t = String(text || "");
    if (!t) return null;
    /* "OCT 3", "OCT 3 2026", "October 3rd" */
    var re = /\b([A-Za-zÀ-ÿ]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:[,\s]+(20\d{2}))?/g, m;
    var hits = [];
    while ((m = re.exec(t))) {
      var mo = monthWord(m[1]);
      if (mo && +m[2] >= 1 && +m[2] <= 31) hits.push({ mo: mo, d: +m[2], y: m[3] ? +m[3] : null });
    }
    /* "3 OCT", "3 de octubre 2026" */
    re = /\b(\d{1,2})\s*(?:de\s+|d['’]\s*)?([A-Za-zÀ-ÿ]{3,10})\.?\b(?:[,\s]+(?:de\s+)?(20\d{2}))?/g;
    while ((m = re.exec(t))) {
      var mo2 = monthWord(m[2]);
      if (mo2 && +m[1] >= 1 && +m[1] <= 31) hits.push({ mo: mo2, d: +m[1], y: m[3] ? +m[3] : null });
    }
    if (!hits.length) return null;
    var h = hits[0];
    var y = h.y || seasonYear(t, h.mo);
    if (!y) return null;
    if (y < 2000 || y > 2099) return null;
    return y + "-" + pad2(h.mo) + "-" + pad2(h.d);
  }
  function headerDate(rows) {
    var h = rows && rows.header;
    if (!h) return null;
    return fileDate(String(h)) || wordDate(String(h));
  }

  /* A PRACTICE FILE WITH NO DATE IN ITS NAME IS STILL A PRACTICE.
     Games have had three ways to find their date for a while - the name, the fixture
     list, the day the file landed on the Drive - and practices had one. Anything whose
     name did not spell a date out was dropped before it was ever read, silently, and
     the count of sessions on the screen looked right because it only ever counted what
     had got through. These are the same three ways, in the order they can be trusted. */
  function datedPractice(f, rows) {
    var d = fileDate(f.name) || wordDate(f.name);
    if (d) return { d: d, how: "name" };
    d = headerDate(rows);
    if (d) return { d: d, how: "inside" };
    var t = f.createdTime || f.modifiedTime;
    if (t && /^\d{4}-\d{2}-\d{2}/.test(String(t))) return { d: String(t).slice(0, 10), how: "drive" };
    return { d: null, how: null };
  }

  function secs(t) {
    var m = /(\d+):(\d+)/.exec(t || "");
    return m ? (+m[1]) * 60 + (+m[2]) : 0;
  }

  /* ------------------------------------------------------- shared metrics */

  /* CL2/ML2 are the long two. They were not counted at all: a converted long
     two was worth nothing and a missed one was not a shot. Rare in the files so
     far, and load-bearing for the transition-defense rules, which key off them. */
  function points(tags) {
    return count(tags, "C1") + 2 * (count(tags, "C2") + count(tags, "CL2")) + 3 * count(tags, "C3");
  }
  function count(arr, v) { var n = 0; for (var i = 0; i < arr.length; i++) if (arr[i] === v) n++; return n; }
  /* every way a paint touch is written, old and new */
  function ptMarks(tags) {
    var n = count(tags, "PAINT TOUCH");
    for (var i = 0; i < PT_TYPES.length; i++) n += count(tags, PT_TYPES[i]);
    return n;
  }
  function has(arr, v) { return arr.indexOf(v) >= 0; }

  function shotLine(ps) {
    var o = { n: ps.length, pts: 0, fgm: 0, fga: 0, t2a: 0, t3a: 0, fta: 0, tov: 0 };
    ps.forEach(function (q) {
      o.pts += q.pts;
      o.fgm += count(q.tags, "C2") + count(q.tags, "CL2") + count(q.tags, "C3");
      o.fga += count(q.tags, "C2") + count(q.tags, "CL2") + count(q.tags, "C3") +
               count(q.tags, "M2") + count(q.tags, "ML2") + count(q.tags, "M3");
      o.t2a += count(q.tags, "C2") + count(q.tags, "CL2") + count(q.tags, "M2") + count(q.tags, "ML2");
      o.t3a += count(q.tags, "C3") + count(q.tags, "M3");
      o.fta += count(q.tags, "C1") + count(q.tags, "M1");
      /* "Turnover - <player> - Offensive foul" is one turnover described twice.
         Added blind it counted as two, so a one-possession row could report 200%. */
      var tv = count(q.tags, "Turnover"), of = count(q.tags, "Offensive foul");
      o.tov += tv + Math.max(0, of - tv);
    });
    o.ppp = o.n ? o.pts / o.n : null;
    return o;
  }

  /* ------------------------------------------------------- the game model */

  var DEF_CATS = ["BALANCE", "1n1 - Without Ball", "HO", "PASS & CHASE", "OFF SCREEN", "BACK PICK",
    "DUCK IN", "POST UP", "DOUBLE HANDS", "ZONE", "DEFENSIVE REBOUND", "HELPS", "OTHER DEF",
    "Drag PnR defense", "Middle PnR (1) defense", "Middle PnR (2) defense", "Step Up defense",
    "PnR Side defense", "PnR Empty defense", "Baseline PnR defense", "PnR 4 defense",
    "Spain PnR defense", "PnR Guards Defense", "Last seconds defense"];
  var FB_CATS = ["FASTBREAK", "RIM RUNNER", "TRAILER"];
  var SEC_CATS = ["7", "7 CLEAR", "1n1 EARLY OFFENSE", "POST UP TRANSITION", "PRESS BREAK", "DRAG PnR"];
  /* The staff writes the inbounds two ways: SLOB/BLOB and the shorter SOB/BOB. Both
     are in here, and phaseOf reads the end off the name so a new one works the day it
     is tagged rather than the day this list is edited. */
  var OOB_CATS = ["3 SLOB", "OTHER SLOB", "PIO PIO",
                  "SOB 3", "OTHER SOB", "BOB LAST"];
  var PHASES = ["Fastbreak", "Secondary break", "Half court", "Offensive rebound", "OOB (SLOB/BLOB)"];

  var FAM_ORDER = ["Fastbreak", "Secondary break", "Half court set", "OOB (SLOB/BLOB)", "ATO", "Out of sets"];
  function actionFamily(cat) {
    cat = String(cat || "");
    if (FB_CATS.indexOf(cat) >= 0) return "Fastbreak";
    if (SEC_CATS.indexOf(cat) >= 0) return "Secondary break";
    if (OOB_CATS.indexOf(cat) >= 0) return "OOB (SLOB/BLOB)";
    if (/^ATO/i.test(cat)) return "ATO";
    if (/^(OUT OF SETS|OTHER OREB|PUTBACK|OTHER ACTIONS)$/i.test(cat)) return "Out of sets";
    return "Half court set";
  }


  /* ============================================================ the defense

     Everything below reads the same rows the offensive model already parsed.
     Three things come out of them: what we concede by situation, how the
     transition defense held after our own shot, and the play types on both
     ends. None of it needs a mark the taggers are not already writing. */

  var PNR_DEF = ["Drag PnR defense", "Middle PnR (1) defense", "Middle PnR (2) defense",
    "Step Up defense", "PnR Side defense", "PnR Empty defense", "Baseline PnR defense",
    "PnR 4 defense", "Spain PnR defense", "PnR Guards Defense", "Last seconds defense"];

  /* One coverage, more than one word. The dictionary defines RED as the hedge,
     and BLACK is the switch — so each pair is one row. Kept apart, two games
     read as two different defensive systems when only the wording changed. */
  var COVERAGE = [
    { k: "Red / Hedge", marks: ["RED", "HEDGE"] },
    { k: "Switch", marks: ["SWITCH", "BLACK"] },
    { k: "Plug & hedge", marks: ["PLUG & HEDGE"] },
    { k: "Short show", marks: ["SHORT SHOW"] },
    { k: "Trap", marks: ["TRAP"] },
    { k: "Fire", marks: ["FIRE"] },
    { k: "Flat — drop and over", marks: ["FLAT"] },
    { k: "Under — drop and under", marks: ["UNDER"] },
    { k: "Top lock", marks: ["TOP LOCK"] },
    { k: "Bump & recover", marks: ["BUMP & RECOVER"] },
    { k: "Drop step", marks: ["DROP STEP"] },
    { k: "Black out", marks: ["BLACK OUT"] },
    { k: "Deny + under", marks: ["DENY + UNDER"] }
  ];

  var PLAYTYPES = ["PnR Ball Handler", "PnR Roll Man", "Pop", "Off Screen", "Back Pick",
    "Pass & Chase", "HO", "Cut", "Spot Up", "1n1", "Putback", "Catch & Drive",
    "Drive & Drop Off", "Duck In", "Post Up"];

  /* WHICH PERIOD A CLIP BELONGS TO. The four quarters are tagged 1Q to 4Q and that was
     all that was read, so a game that went to overtime lost every possession of it: the
     tagging marks extra time "PR." (prórroga), which matched none of the four, and those
     clips fell out of every table split by period. Extra time is one more period, called
     OT, however it is written. */
  function periodOf(tags) {
    for (var i = 0; i < tags.length; i++) {
      var t = String(tags[i] || "").trim().toUpperCase();
      if (/^[1-4]Q$/.test(t)) return t;
      if (/^(PR\.?|PRORROGA|PRÓRROGA|OT\d?|[5-9]Q|EXTRA ?TIME|ET)$/.test(t)) return "OT";
    }
    return "";
  }
  /* Their possessions, chained exactly like ours: consecutive defensive clips
     are one possession unless we had the ball in between, so the PPP conceded
     is on the same scale as the PPP we produce. */
  function chainDef(rows) {
    var dz = rows.filter(function (r) { return r.def; }), out = [], cur = null;
    dz.forEach(function (r, i) {
      var join = false;
      if (i > 0) {
        var prev = dz[i - 1];
        var between = rows.some(function (x) { return !x.def && x.a > prev.a && x.a < r.a; });
        var gap = r.a - prev.b;
        join = (!between && ((has(prev.tags, "Offensive Rebound") && gap <= 20) || gap <= 5));
      }
      if (!join || !cur) { cur = { clips: [r], tags: r.tags.slice(), first: r.cat }; out.push(cur); }
      else { cur.clips.push(r); cur.tags = cur.tags.concat(r.tags); }
    });
    out.forEach(function (q) {
      q.pts = points(q.tags);
      /* on a defensive clip an "Offensive Rebound" is theirs — the second chance
         we gave away. Without this the OREB column read zero on every row. */
      q.oreb = count(q.tags, "Offensive Rebound");
      q.q = periodOf(q.tags);
      q.pnr = PNR_DEF.indexOf(q.first) >= 0;
      /* the block is the defense, so every row does not need to say so */
      q.label = String(q.first || "\u2014").replace(/\s*defense\s*$/i, "");
    });
    return out;
  }

  /* --------------------------------------------------- transition defense

     Straight from the tagging dictionary. The row before a defensive row is
     our own possession; what we finished it with decides which of the two this
     is, and the ten seconds keep out dead-ball and end-of-quarter situations.

       TAG   we finished on a long shot (M3, ML2, C3, CL2) — the long rebound
       BACK  we finished at the rim (C2, M2) or gave it away (Turnover)

     A turnover is a BACK: they run off it exactly like off a rebound. An
     offensive foul is not — it is a dead ball with nobody running, and it is
     written next to the turnover, so it is taken back out.

     BACK is never written in a file and does not need to be: both are read off
     the rows. The literal TAG mark is a different thing and lives in its own
     block — it names the player who did NOT tag up, not the situation. */
  var LONG_END = ["M3", "ML2", "C3", "CL2"], CLOSE_END = ["M2", "Turnover"];   /* after our make at the rim it is their full-court press, not BACK */
  var FG_MARKS = ["C2", "CL2", "C3", "M2", "ML2", "M3"];
  var TRANS_GAP = 10;

  /* A foul while the shot is still in the air or on the floor is not transition
     defense — nobody ran. It is written as a defensive clip that opens before
     our own clip has closed and that produces free throws and nothing else.
     The rule as written names OTHER DEF; in the files these are almost always
     BALANCE, so the test is the shape of the clip and not its category. A clip
     that also carries a field goal is left in: that is an and-one, not a foul
     on the rebound. */
  /* which of the three a BACK came from: our turnover, our miss at the rim, our make */
  function backSub(pv) { return has(pv.tags, "Turnover") ? "to" : "miss"; }
  var BACK_SUB = [["to", " after our turnover", "Turnover"], ["miss", " after our miss (their rebound)", "M2"]];
  /* the BACK row's three parts, for a table of `cols` columns: situations, points and PPP
     in the places the main rows have them, the rest left empty */
  function backSubRows(back, all, cols) {
    var sub = back && back.sub; if (!sub) return [];
    return BACK_SUB.map(function (s) {
      var o = sub[s[0]] || { n: 0, pts: 0 }, ppp = o.n ? o.pts / o.n : null;
      var cells = [s[1]];
      var at = cols === 9 ? 5 : 6;   /* where "situations" sits in each table */
      for (var i = 1; i < at; i++) cells.push("");
      cells.push({ v: o.n, cls: "sx-vol " + volStep(100 * o.n / Math.max(1, all)) });
      cells.push(o.pts);
      cells.push({ v: f2(ppp), cls: "sx-cell " + pppStepD(ppp) + (o.n < SMALL ? " sx-small" : "") });
      while (cells.length < cols - 1) cells.push("");
      cells.push(s[2]);
      return { cells: cells, cls: "sx-subrow" };
    });
  }
  function fouledOnTheRebound(d, pv) {
    if (d.a >= pv.b) return false;
    if (!(has(d.tags, "Foul Drawn") || has(d.tags, "C1") || has(d.tags, "M1"))) return false;
    return !FG_MARKS.some(function (x) { return has(d.tags, x); });
  }

  function buildTransDef(rows) {
    var o = { tag: { n: 0, pts: 0, of: 0, miss: 0, oreb: 0 },
              back: { n: 0, pts: 0, of: 0, miss: 0, oreb: 0, sub: { to: { n: 0, pts: 0 }, miss: { n: 0, pts: 0 }, make: { n: 0, pts: 0 } } }, events: [] };
    /* how many of our possessions ended that way at all, paired or not: without
       it the table looks like the whole game when it is a slice of it */
    rows.forEach(function (r) {
      if (r.def) return;
      if (LONG_END.some(function (x) { return has(r.tags, x); })) o.tag.of++;
      else if (!has(r.tags, "Offensive foul") && CLOSE_END.some(function (x) { return has(r.tags, x); })) o.back.of++;
      /* the other half of the same situation: the misses we rebounded ourselves,
         split by the shot that produced them, so the second chances sit next to
         the transition defense they replaced. On a clip of ours an "Offensive
         Rebound" is ours; no clip in the files carries two misses, so the miss
         it belongs to is never in doubt. */
      var ml = count(r.tags, "M3") + count(r.tags, "ML2"), mp = count(r.tags, "M2");
      var ore = count(r.tags, "Offensive Rebound");
      o.tag.miss += ml; o.back.miss += mp;
      if (ore) {
        if (ml && !mp) o.tag.oreb += Math.min(ore, ml);
        else if (mp && !ml) o.back.oreb += Math.min(ore, mp);
      }
    });
    for (var i = 1; i < rows.length; i++) {
      var d = rows[i], pv = rows[i - 1];
      if (!d.def || pv.def) continue;
      if (d.a - pv.b > TRANS_GAP) continue;
      var dead = has(pv.tags, "Offensive foul");
      var kind = LONG_END.some(function (x) { return has(pv.tags, x); }) ? "tag"
        : (!dead && CLOSE_END.some(function (x) { return has(pv.tags, x); })) ? "back" : null;
      if (!kind) continue;
      if (fouledOnTheRebound(d, pv)) continue;
      o[kind].n++; o[kind].pts += points(d.tags);
      /* BACK is two situations: after our turnover and after our miss at the rim (their rebound)
         the total, and each apart under it (after our make it is their full-court press, not BACK) */
      var sub = kind === "back" ? backSub(pv) : null;
      if (sub) { o.back.sub[sub].n++; o.back.sub[sub].pts += points(d.tags); }
      /* each one with where it is in the video and its quarter, for the minute-by-minute table */
      o.events.push({ a: d.a, q: periodOf(d.tags), kind: kind, sub: sub, pts: points(d.tags) });
    }
    return o;
  }

  /* TAG AND BACK IN A PRACTICE FILE.

     The pass above needs a defensive clip to run our possession against, and a practice
     file has none: five on five in training is two of our own teams, and both ends are
     tagged as attacks. So the table never appeared for a training - only the rebounding
     on our own misses did. But the situation is there all the same: the action that
     follows a shot IS the possession the other five had to get back for.

     The staff's own rule, as written:
       TAG   the row before ended on a long shot        M3, ML2, C3, CL2
       BACK  the row before ended at the rim or lost it  C2, M2, Turnover
       - the action is not a SECOND CHANCE (that is the same team again, nobody ran back)
       - it opens no more than ten seconds after the one before closed, which leaves out
         balls out of bounds, the end of a possession, a stop in the drill and a repeat
       - the points are what the action scored: C1 one, C2 and CL2 two, C3 three

     Every such action is a possession defended, and what it scored is what was given
     up. The ones that carry "Transition Attack Poss" are counted a second time on their
     own, because that is the narrower thing - what the balance itself conceded - and the
     two questions are not the same question. */
  /* A player as the practice tagging writes him: a first name, with or without his shirt
     number - "Ferdinand 6", "GIAN", "Andre". Returned without the number and in one
     spelling, so GIAN and Gian 4 are one man. Anything that is a mark and not a man -
     a shot, a turnover, a rebound, a paint touch - is not a name. */
  var NOT_A_MAN = { turnover: 1, oreb: 1, unknown: 1, fastbreak: 1, fastberak: 1 };
  function tagMan(tok) {
    tok = String(tok || "").trim();
    var m = /^([A-Za-zÀ-ÿ'][A-Za-zÀ-ÿ']+)(?: \d{1,2})?$/.exec(tok);
    if (!m) return "";
    var w = m[1].toLowerCase();
    if (NOT_A_MAN[w] || PT_TYPES.indexOf(tok) >= 0) return "";
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  function buildTransPractice(rows) {
    var mk = function () { return { n: 0, pts: 0, of: 0, miss: 0, oreb: 0, tn: 0, tpts: 0, mtu: 0 }; };
    var o = { tag: mk(), back: mk(), mtuOdd: 0, orebLoose: 0, mtuBy: {} };
    o.back.sub = { to: { n: 0, pts: 0 }, miss: { n: 0, pts: 0 }, make: { n: 0, pts: 0 } };
    rows.forEach(function (r) {
      if (r.def) return;
      /* MISSED TAG UP is the one thing about TAG the staff writes down by hand: the long
         shot went up and somebody did not go. It was never read - the table worked the
         situation out of the rows and left the mark itself on the floor, so a day with
         five of them showed none. It belongs to the long shot, M3 or ML2, and nowhere
         else; one written on any other row is counted apart so it can be said out loud
         instead of being quietly added in. */
      var mt = count(r.tags, "MISSED TAG UP");
      if (mt) {
        if (has(r.tags, "M3") || has(r.tags, "ML2")) o.tag.mtu += mt; else o.mtuOdd += mt;
        /* WHO DID NOT GO. The tagger's rule, as he wrote it: the name comes right after
           the mark, and when nothing comes after it, it is the name right before. */
        r.tags.forEach(function (tok, i) {
          if (tok !== "MISSED TAG UP") return;
          var who = tagMan(r.tags[i + 1]) || tagMan(r.tags[i - 1]) || "?";
          o.mtuBy[who] = (o.mtuBy[who] || 0) + 1;
        });
      }
      if (LONG_END.some(function (x) { return has(r.tags, x); })) o.tag.of++;
      else if (!has(r.tags, "Offensive foul") && CLOSE_END.some(function (x) { return has(r.tags, x); })) o.back.of++;
      var ml = count(r.tags, "M3") + count(r.tags, "ML2"), mp = count(r.tags, "M2");
      var ore = count(r.tags, "Offensive Rebound") + count(r.tags, "OREB");
      o.tag.miss += ml; o.back.miss += mp;
      if (ore) {
        if (ml && !mp) o.tag.oreb += Math.min(ore, ml);
        else if (mp && !ml) o.back.oreb += Math.min(ore, mp);
        /* a rebound on a row that carries no missed shot cannot be put under the long
           shot or under the rim, and is not guessed at: it is counted, and said */
        else if (!ml && !mp) o.orebLoose += ore;
      }
    });
    for (var i = 1; i < rows.length; i++) {
      var d = rows[i], pv = rows[i - 1];
      if (pv.def) continue;
      if (String(d.cat || "").trim().toUpperCase() === "SECOND CHANCE") continue;
      if (d.a - pv.b > TRANS_GAP) continue;
      var dead = has(pv.tags, "Offensive foul");
      var kind = LONG_END.some(function (x) { return has(pv.tags, x); }) ? "tag"
        : (!dead && CLOSE_END.some(function (x) { return has(pv.tags, x); })) ? "back" : null;
      if (!kind) continue;
      if (d.def && fouledOnTheRebound(d, pv)) continue;
      var p = points(d.tags);
      o[kind].n++; o[kind].pts += p;
      if (kind === "back") { var sb = backSub(pv); o.back.sub[sb].n++; o.back.sub[sb].pts += p; }
      if (has(d.tags, "Transition Attack Poss")) { o[kind].tn++; o[kind].tpts += p; }
    }
    return o;
  }

  /* A possession can carry more than one play type, so the shares are of the
     possessions that carry any at all and can add past 100%. */
  function playAgg(list) {
    var m = {}, tagged = 0;
    list.forEach(function (q) {
      var any = false;
      PLAYTYPES.forEach(function (p) {
        if (!has(q.tags, p)) return;
        any = true;
        var e = m[p] || (m[p] = { k: p, n: 0, pts: 0, list: [] });
        e.n++; e.pts += q.pts; e.list.push(q);
      });
      if (any) tagged++;
    });
    var rows = [];
    for (var k in m) if (m.hasOwnProperty(k)) rows.push(m[k]);
    rows.sort(function (a, b) { return b.n - a.n; });
    return { rows: rows, tagged: tagged, of: list.length };
  }

  function buildGame(rows) {
    rows = rows.slice().sort(function (x, y) { return x.a - y.a || x.b - y.b; });
    rows.forEach(function (r) { r.def = DEF_CATS.indexOf(r.cat) >= 0; });

    var off = rows.filter(function (r) { return !r.def; });
    var poss = [], cur = null;
    off.forEach(function (r, i) {
      var join = false;
      if (i > 0) {
        var prev = off[i - 1];
        var between = rows.some(function (x) { return x.def && x.a > prev.a && x.a < r.a; });
        var gap = r.a - prev.b;
        join = (!between && ((has(prev.tags, "Offensive Rebound") && gap <= 20) || gap <= 5));
      }
      if (!join || !cur) { cur = { clips: [r], tags: r.tags.slice(), first: r.cat }; poss.push(cur); }
      else { cur.clips.push(r); cur.tags = cur.tags.concat(r.tags); }
    });

    poss.forEach(function (q) {
      q.pts = points(q.tags);
      /* The game tagging stopped using one blanket "PAINT TOUCH" mark and now
         names the touch by type, the same six the practice tagging uses. Both
         are counted, so old files and new ones read the same. */
      q.pt = ptMarks(q.tags);
      q.br = q.tags.filter(function (t) { return t.indexOf("BR:") === 0; }).length;
      q.oreb = count(q.tags, "Offensive Rebound");
      q.q = periodOf(q.tags);
      var base = FB_CATS.indexOf(q.first) >= 0 ? "Fastbreak"
        : SEC_CATS.indexOf(q.first) >= 0 ? "Secondary break"
          : OOB_CATS.indexOf(q.first) >= 0 ? "OOB (SLOB/BLOB)" : "Half court";
      q.phase = q.oreb > 0 ? "Offensive rebound" : base;
    });

    var def = rows.filter(function (r) { return r.def; });
    var oppPts = def.reduce(function (s, r) { return s + points(r.tags); }, 0);
    var dposs = chainDef(rows);
    return { poss: poss, clips: off.length, oppPts: oppPts, kind: "game",
             rows: rows, dposs: dposs, dclips: def.length,
             trans: buildTransDef(rows),
             playUs: playAgg(poss), playThem: playAgg(dposs) };
  }

  /* --------------------------------------------------- the practice model */

  var PT_TYPES = ["Rim Rolls/Dives", "Dribble Penetration", "Basket Cuts", "Rim Runs",
    "Other Paint Touch", "Transition Attack Poss"];

  /* Whatever the practice tagging ends up calling a fastbreak, it is read here.
     A possession gets a phase only when one of these shows up in its category or
     its tags; a file with none of them stays unphased and the 70% measure keeps
     reporting a floor for it, exactly as before. */
  /* FASTBERAK is how the category is spelt in the tagging window itself, so that is the
     word every practice file carries - and the list only knew the dictionary spelling. */
  var FB_MARKS = ["FASTBREAK", "FASTBERAK", "FAST BREAK", "FB", "TRANSITION", "TRANSITION ATTACK",
                  "RIM RUNNER", "TRAILER", "EARLY OFFENSE", "SECONDARY", "SECONDARY BREAK"];
  function fbMark(s) {
    s = String(s || "").trim().toUpperCase();
    return FB_MARKS.indexOf(s) >= 0;
  }

  /* Second chances we won off our own miss, split by the shot that produced
     them: the long shot under TAG, the shot at the rim under BACK.

     Read per clip and not by walking the descriptors in order, because the
     order is not dependable — two clips in Trier carry the rebound written
     ahead of the shot it followed. Per clip is only safe while no clip holds
     two missed shots, which is true of every file seen so far; `mixed` counts
     the ones that would break it so the caller can refuse to show the split
     rather than publish a guess. */
  function orebSplit(list) {
    var o = { tagMiss: 0, tagOreb: 0, backMiss: 0, backOreb: 0, marks: 0, mixed: 0 };
    list.forEach(function (r) {
      var t = r.tags || [];
      var ml = count(t, "M3") + count(t, "ML2"), mp = count(t, "M2");
      var ore = count(t, "Offensive Rebound") + count(t, "OREB");
      o.marks += ore;
      if (ml + mp > 1) o.mixed++;
      o.tagMiss += ml; o.backMiss += mp;
      if (ore) {
        if (ml && !mp) o.tagOreb += Math.min(ore, ml);
        else if (mp && !ml) o.backOreb += Math.min(ore, mp);
      }
    });
    return o;
  }

  function buildPractice(rows) {
    /* A practice file can carry defensive clips too — in the 5x5 stretch both ends get
       tagged. They were being folded into the offensive possessions, which inflated the
       count and put defensive tags in an offensive row. They are marked here, kept out
       of the possession build, and handed to the same transition-defense pass the games
       use. Nothing else needs to change: that pass pairs one of our clips with a
       defensive clip that opens within ten seconds, which only happens in live play, so
       the 5x5 selects itself and the drills never pair. */
    rows = rows.slice().sort(function (x, y) { return (x.a - y.a) || (x.b - y.b); });
    rows.forEach(function (r) { r.def = DEF_CATS.indexOf(r.cat) >= 0; });
    var offRows = rows.filter(function (r) { return !r.def; });
    var defN = rows.length - offRows.length;

    var poss = [], cur = null;
    offRows.forEach(function (r) {
      if (r.cat === "SECOND CHANCE") {
        if (cur) { cur.tags = cur.tags.concat(r.tags); cur.sc++; return; }
      }
      var m = /^(\d+) BALL REVERSAL$/.exec(r.cat);
      cur = { tags: r.tags.slice(), br: m ? +m[1] : null, cat: r.cat, sc: 0 };
      poss.push(cur);
    });
    poss.forEach(function (q) {
      q.pts = points(q.tags);
      q.pt = q.tags.filter(function (t) { return PT_TYPES.indexOf(t) >= 0; }).length;
      q.oreb = count(q.tags, "OREB");
      var fb = fbMark(q.cat) || q.tags.some(fbMark);
      if (fb) q.phase = q.oreb > 0 ? "Offensive rebound" : "Fastbreak";
      else if (q.tags.some(function (t) { return /^(HALF COURT|SET|STATIC|OOB|SLOB|BLOB|ATO)$/i.test(String(t).trim()); })
               || /^(HALF COURT|SET|STATIC|OOB|SLOB|BLOB|ATO)$/i.test(String(q.cat || "").trim()))
        q.phase = q.oreb > 0 ? "Offensive rebound" : "Half court";
    });
    /* only claim the file is phased when something was actually marked */
    var anyPhase = poss.some(function (q) { return !!q.phase; });
    if (anyPhase) poss.forEach(function (q) { if (!q.phase) q.phase = q.oreb > 0 ? "Offensive rebound" : "Half court"; });
    /* on the raw rows, not on the merged possessions: a SECOND CHANCE row folds
       into the one before it, and the merged tags would then hold two misses */
    return { poss: poss, kind: "practice", oreb: orebSplit(offRows),
             trans: buildTransPractice(rows), defN: defN,
             /* the defensive clips of the 5x5, chained into possessions, and what they gave up */
             dposs: chainDef(rows), oppPts: rows.filter(function (r) { return r.def; }).reduce(function (s, r) { return s + points(r.tags); }, 0) };
  }

  function touchTable(poss) {
    var players = {}, isPlayer = /^(?:[A-Z][a-zA-Z]+(?: \d+)?|UNKNOWN)$/;
    var skip = { "Turnover": 1, "OREB": 1, "Foul": 1, "Out": 1, "GOOD": 1, "BAD": 1, "VIDEO": 1 };
    poss.forEach(function (q) {
      q.tags.forEach(function (tok, i) {
        if (PT_TYPES.indexOf(tok) < 0 && tok !== "OREB") return;
        var prev = q.tags[i - 1] || "";
        var who = (isPlayer.test(prev) && !skip[prev.split(" ")[0]] && PT_TYPES.indexOf(prev) < 0)
          ? prev : "Unattributed";
        players[who] = players[who] || { name: who, total: 0 };
        players[who][tok] = (players[who][tok] || 0) + 1;
        players[who].total++;
      });
    });
    return Object.keys(players).map(function (k) { return players[k]; })
      .sort(function (a, b) { return b.total - a.total; });
  }

  /* Paint touch by player, read off the game tagging.

     The rule is the one the tagging can actually honour: a touch belongs to the
     player tagged on the same clip. One player on the clip takes every touch on
     it; as many players as PAINT TOUCH marks pairs them in order; anything else
     is left unattributed rather than guessed, because a wrong name in a player
     report is worse than a missing one.

     Today most clips carry no player at all, so the block checks the coverage
     and only prints the table once it clears the bar. Nothing here needs
     changing when the tagging does. */
  var PLAYER_TAG = /^[A-Z][a-zA-Z.'-]+(?: [A-Z][a-zA-Z.'-]+)? \d+$/;

  function gameTouchTable(poss) {
    var by = {}, total = 0, attributed = 0;
    poss.forEach(function (q, qi) {
      (q.clips || []).forEach(function (c) {
        var marks = count(c.tags, "PAINT TOUCH");
        if (!marks) return;
        total += marks;
        var pl = c.tags.filter(function (t) { return PLAYER_TAG.test(t); });
        var take = null;
        if (pl.length === 1) { take = []; for (var i = 0; i < marks; i++) take.push(pl[0]); }
        else if (pl.length === marks) take = pl.slice();
        if (!take) return;
        take.forEach(function (name) {
          var r = by[name] || (by[name] = { name: name, touch: 0, seen: {} });
          r.touch++; attributed++; r.seen[qi] = 1;
        });
      });
    });
    var rows = Object.keys(by).map(function (k) {
      var r = by[k];
      var list = Object.keys(r.seen).map(function (i) { return poss[i]; });
      var sh = shotLine(list);
      r.poss = list.length; r.pts = sh.pts; r.ppp = sh.ppp;
      return r;
    }).sort(function (a, b) { return b.touch - a.touch || a.name.localeCompare(b.name); });
    return { rows: rows, total: total, attributed: attributed,
             coverage: total ? attributed / total : 0 };
  }

  /* ----------------------------------------------------------------- view */

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function pct(a, b) { return b ? Math.round(100 * a / b) + "%" : "—"; }
  function f2(v) { return v == null ? "—" : v.toFixed(2); }

  function pppStep(v) {
    if (v == null) return "";
    return v < 0.5 ? "s0" : v < 0.8 ? "s1" : v < 1.0 ? "s2" : v < 1.25 ? "s3" : v < 1.6 ? "s4" : "s5";
  }
  /* THE ONE PLACE THE COLOUR RULE TURNS ROUND.
     Everywhere else in the app the colour is the size of the number: low is red, high is
     green. That reads correctly for everything we produce and backwards for everything we
     give up - a PPP of 1.40 against us was coming out the same green as a 1.40 of ours.
     The tables that start from our defense use this instead, and nothing else does. */
  function pppStepD(v) {
    if (v == null) return "";
    return v < 0.5 ? "s5" : v < 0.8 ? "s4" : v < 1.0 ? "s3" : v < 1.25 ? "s2" : v < 1.6 ? "s1" : "s0";
  }
  function pppCls(v, def) { return def ? pppStepD(v) : pppStep(v); }
  function volStep(p) {
    return p < 20 ? "b0" : p < 35 ? "b1" : p < 50 ? "b2" : p < 65 ? "b3" : p < 80 ? "b4" : "b5";
  }

  /* Every table in the post game is built here, so sorting is built here once.

     A coach reads a table by looking for the top of a column - most possessions, worst
     PPP, who shoots the most - and the order a table happens to be written in is rarely
     that. Clicking a heading sorts by it: numbers high to low first, because that is the
     question being asked, words A to Z first, and a third click puts the table back the
     way it was written, which matters where the written order IS the meaning (quarters,
     sessions by date).

     What the cells hold is text, not numbers - "45%", "8-16", "+0.23", "1.12", "—" -
     so the value sorted on is read off the text: the first number in it, with a per cent
     or a sign taken as read, and an em dash treated as nothing at all and always sent to
     the bottom whichever way the column runs. A row whose first cell says TOTAL, TEAM or
     ALL is a summary of the others, not one of them, so it stays at the foot. */
  function sortKey(txt) {
    var t = String(txt == null ? "" : txt).trim();
    if (!t || t === "\u2014" || t === "-" || t === "\u2013") return null;
    var m = t.replace(/,/g, ".").match(/-?\d+(\.\d+)?/);
    if (m && /^[^A-Za-z]*-?[\d.]/.test(t)) return parseFloat(m[0]);
    return t.toLowerCase();
  }
  var SX_PIN = /^(total|totals|team|all|sum|overall)\b/i;
  function sortable(t, tb) {
    var heads = [].slice.call(t.querySelectorAll("thead th"));
    var body = [].slice.call(tb.children);
    var kept = body.filter(function (r) { return !SX_PIN.test(r.cells[0] ? r.cells[0].textContent : ""); });
    var pinned = body.filter(function (r) { return kept.indexOf(r) < 0; });
    if (kept.length < 2) return;   /* two rows are still an order worth flipping */
    var state = { col: -1, dir: 0 };
    var put = function (list) {
      list.forEach(function (r) { tb.appendChild(r); });
      pinned.forEach(function (r) { tb.appendChild(r); });
    };
    heads.forEach(function (th, ci) {
      th.classList.add("sx-sortable");
      th.setAttribute("title", "Sort by " + (th.textContent || "this column")
        + " \u2014 click again to reverse, a third time for the original order");
      th.addEventListener("click", function () {
        var first = (ci === 0) ? 1 : -1;            /* words up, numbers down */
        if (state.col !== ci) { state.col = ci; state.dir = first; }
        else if (state.dir === first) { state.dir = -first; }
        else { state.col = -1; state.dir = 0; }
        heads.forEach(function (h2) { h2.classList.remove("sx-sort-up", "sx-sort-down"); });
        if (state.dir === 0) { put(kept.slice()); return; }
        th.classList.add(state.dir > 0 ? "sx-sort-up" : "sx-sort-down");
        var keyed = kept.map(function (r, i) {
          var c = r.cells[ci];
          return { r: r, i: i, k: sortKey(c ? c.textContent : "") };
        });
        keyed.sort(function (a, b) {
          if (a.k === null && b.k === null) return a.i - b.i;
          if (a.k === null) return 1;
          if (b.k === null) return -1;
          var na = typeof a.k === "number", nb = typeof b.k === "number";
          if (na && nb) return (a.k - b.k) * state.dir || a.i - b.i;
          if (na !== nb) return na ? -1 : 1;
          return String(a.k).localeCompare(String(b.k)) * state.dir || a.i - b.i;
        });
        put(keyed.map(function (x) { return x.r; }));
      });
    });
  }
  function table(head, rows, opts) {
    opts = opts || {};
    var wrap = el("div", "sx-tablewrap"), t = el("table", "sx-table");
    var thead = el("thead"), tr = el("tr");
    head.forEach(function (hcell) { tr.appendChild(el("th", null, hcell)); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody");
    rows.forEach(function (r) {
      var row = el("tr", r.cls || null);
      (r.cells || r).forEach(function (c) {
        var td = el("td", (c && c.cls) || null, c && c.v != null ? c.v : c);
        /* a small mark after the text: a rank, in the colour of what it ranks */
        if (c && typeof c === "object" && c.sup != null) td.appendChild(el("sup", c.supCls || null, String(c.sup)));
        /* a band row is one cell across the whole table; the page's own sorter already
           knows one of those is a heading and sorts the block under it, not the band */
        if (c && c.span > 1) td.colSpan = c.span;
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb); wrap.appendChild(t);
    if (opts.sort !== false) { try { sortable(t, tb); } catch (e) {} }
    return wrap;
  }

  function gauge(name, value, total, note, graded) {
    graded = graded !== false;
    var p = total ? 100 * value / total : 0;
    var shown = Math.round(p);
    var verdict = shown >= 70 ? ["Perfect", "perfect"] : shown >= 65 ? ["Ok", "ok"] : shown >= 60 ? ["Regular", "regular"] : ["Below", "below"];
    var g = el("div", "sx-gauge" + (graded ? "" : " ungraded"));
    var top = el("div", "sx-gtop");
    top.appendChild(el("span", "sx-gname", name));
    var right = el("span");
    right.appendChild(el("span", "sx-gbig", shown + "%"));
    if (graded) right.appendChild(el("span", "sx-verdict sx-" + verdict[1], verdict[0]));
    top.appendChild(right);
    g.appendChild(top);
    var track = el("div", "sx-gtrack");
    var seg = el("div", "sx-gseg", value + " of " + total);
    seg.style.width = Math.max(p, 0) + "%";
    track.appendChild(seg);
    if (graded) {
      [60, 65, 70].forEach(function (v) {
        var tick = el("div", "sx-gtick" + (v === 70 ? "" : " soft"));
        tick.style.left = v + "%";
        track.appendChild(tick);
      });
    }
    g.appendChild(track);
    if (graded) {
      /* The three labels were pinned at 60%, 65% and 70% of the bar - five percent
         apart, which is twenty pixels in a card - and printed on top of one another.
         The ticks on the bar say where the thresholds are; this is the key to them, on
         one line, in the order they come. */
      var sc = el("div", "sx-gscale");
      [["60", "regular"], ["65", "ok"], ["70", "perfect"]].forEach(function (x) {
        var s2 = el("span", "sx-gsc");
        s2.appendChild(el("b", null, x[0]));
        s2.appendChild(el("i", null, x[1]));
        sc.appendChild(s2);
      });
      g.appendChild(sc);
    }
    if (note) g.appendChild(el("div", "sx-gnote", note));
    return g;
  }

  /* The 70% target is not "how often did we touch the paint". A fastbreak is a
     good possession on its own — it does not owe us a paint touch or a reversal.
     So the bar carries two segments over the same total: every fastbreak, and
     the possessions in every other phase where the concept was played. The
     target is what the two add up to. */
  /* graded === false: the bar is drawn, the number is shown, and nothing is
     judged. Used where we have no agreed optimum to measure against. */
  function gaugeSplit(name, fb, fbTotal, rest, restTotal, total, unit, graded) {
    graded = graded !== false;
    var pFb = total ? 100 * fb / total : 0;
    var pRest = total ? 100 * rest / total : 0;
    var p = pFb + pRest;
    // judge the number the coach actually reads, so 69.9% shown as 70% is not
    // labelled "Ok" next to a big 70
    var shown = Math.round(p);
    var verdict = shown >= 70 ? ["Perfect", "perfect"] : shown >= 65 ? ["Ok", "ok"] : shown >= 60 ? ["Regular", "regular"] : ["Below", "below"];
    var g = el("div", "sx-gauge" + (graded ? "" : " ungraded"));

    var top = el("div", "sx-gtop");
    top.appendChild(el("span", "sx-gname", name));
    var right = el("span");
    right.appendChild(el("span", "sx-gbig", shown + "%"));
    if (graded) right.appendChild(el("span", "sx-verdict sx-" + verdict[1], verdict[0]));
    top.appendChild(right);
    g.appendChild(top);

    var track = el("div", "sx-gtrack");
    var a = el("div", "sx-gseg fb", pFb >= 11 ? "FB " + fb : (pFb >= 6 ? String(fb) : ""));
    a.style.width = Math.max(pFb, 0) + "%";
    a.title = "Fastbreak — " + fb + " of " + total + " possessions";
    track.appendChild(a);
    var b = el("div", "sx-gseg rest", pRest >= 11 ? String(rest) + " " + unit : (pRest >= 6 ? String(rest) : ""));
    b.style.left = pFb + "%";
    b.style.width = Math.max(pRest, 0) + "%";
    b.title = unit + " in every other phase — " + rest + " of " + restTotal + " possessions";
    if (pFb > 0) b.style.borderRadius = "0";
    track.appendChild(b);
    if (graded) {
      [60, 65, 70].forEach(function (v) {
        var tick = el("div", "sx-gtick" + (v === 70 ? "" : " soft"));
        tick.style.left = v + "%";
        track.appendChild(tick);
      });
    }
    g.appendChild(track);

    if (graded) {
      /* The three labels were pinned at 60%, 65% and 70% of the bar - five percent
         apart, which is twenty pixels in a card - and printed on top of one another.
         The ticks on the bar say where the thresholds are; this is the key to them, on
         one line, in the order they come. */
      var sc = el("div", "sx-gscale");
      [["60", "regular"], ["65", "ok"], ["70", "perfect"]].forEach(function (x) {
        var s2 = el("span", "sx-gsc");
        s2.appendChild(el("b", null, x[0]));
        s2.appendChild(el("i", null, x[1]));
        sc.appendChild(s2);
      });
      g.appendChild(sc);
    }

    var note = el("div", "sx-gsplit");
    var one = el("div", "sx-gpart");
    one.appendChild(el("span", "sx-gkey fb"));
    one.appendChild(el("span", "sx-gpt", "Fastbreak"));
    one.appendChild(el("span", "sx-gpv", fb + " of " + total + " poss · " + Math.round(pFb) + "%"));
    note.appendChild(one);
    var two = el("div", "sx-gpart");
    two.appendChild(el("span", "sx-gkey rest"));
    two.appendChild(el("span", "sx-gpt", unit + ", every other phase"));
    two.appendChild(el("span", "sx-gpv", rest + " of " + restTotal + " poss · " + Math.round(pRest) + "% of all " + total));
    note.appendChild(two);
    var sum = el("div", "sx-gpart sum");
    sum.appendChild(el("span", "sx-gkey blank"));
    sum.appendChild(el("span", "sx-gpt", "Together"));
    sum.appendChild(el("span", "sx-gpv", Math.round(pFb) + "% + " + Math.round(pRest) + "% = " + shown + "%" +
      (graded ? "  ·  target 70%" : "")));
    note.appendChild(sum);
    g.appendChild(note);
    return g;
  }

  function mixBar(lab, two, three, ppp, sub) {
    var row = el("div", "sx-mixrow");
    row.appendChild(el("span", "sx-ml", lab));
    var bar = el("div", "sx-mixbar");
    var tot = two + three;
    if (tot === 0) { bar.appendChild(el("span", "sx-none", "no shots")); }
    else {
      if (two) { var a = el("span", "sx-two", Math.round(100 * two / tot) + "% 2PA"); a.style.width = (100 * two / tot) + "%"; bar.appendChild(a); }
      if (three) { var b = el("span", "sx-three", Math.round(100 * three / tot) + "% 3PA"); b.style.width = (100 * three / tot) + "%"; bar.appendChild(b); }
    }
    row.appendChild(bar);
    row.appendChild(el("span", "sx-mp " + pppStep(ppp), f2(ppp)));
    var w = el("div", "sx-mixwrap");
    w.appendChild(row);
    if (sub) w.appendChild(el("div", "sx-mixsub", sub));
    return w;
  }

  function section(title, sub) {
    var s = el("div", "sx-sec");
    /* the heading runs the width of the block whatever the layout puts beside it */
    s.appendChild(el("div", "sx-h fit-span", title));
    /* the subtitle is not drawn: a table says what it says, and a paragraph of
       grey prose under every one of them is noise. Callers still pass it so the
       signature does not have to change everywhere. */
    return s;
  }
  function callout(text) { return el("div", "sx-callout", text); }
  /* The OREB% in these tables is ours against ourselves. The league's own average comes
     off the BBL four factors, through the League view, so the number has something to be
     measured against instead of standing on its own. */
  function leagueOrbLine() {
    var w = el("div", "sx-sub");
    var LO = null; try { LO = window.LowenLeagueORB && window.LowenLeagueORB(); } catch (e) {}
    if (!LO || LO.off == null) {
      w.textContent = "The league's own offensive-rebound rate is not loaded yet \u2014 open League once and it appears here.";
      return w;
    }
    w.textContent = "BBL average \u00b7 offensive rebounds " + LO.off.toFixed(1) + "% of own misses"
      + (LO.def != null ? ", defensive " + LO.def.toFixed(1) + "%" : "")
      + " \u00b7 " + LO.clubs + " clubs.";
    return w;
  }

  /* ------------------------------------------------------- game rendering */

  /* --------------------------------------------------- practice rendering */

  /* THE PRACTICE IN ONE LOOK: the last ten sessions in one table, this one marked. For each:
     the paint touch rate against the 70% the staff trains for (floor 60%), the points given
     up in TAG and BACK, the ball reversal rate, and what the session scored and conceded a
     possession (OER from the offensive possessions, DER from the defensive clips of the 5x5). */
  function practiceLook(recent, current) {
    var cur = {}; (current || []).forEach(function (s) { cur[s.label] = 1; });
    var box = el("div", "sx-prlook");
    var hd = el("div", "sx-prlook-h");
    hd.appendChild(el("b", null, "The practice in one look"));
    hd.appendChild(el("span", null, "the last " + recent.length + (recent.length === 1 ? " session" : " sessions") + " · paint touches against the 70% target, floor 60% · TAG and BACK: points given up a time · OER / DER: points a possession"));
    box.appendChild(hd);
    var t = el("table", "sx-prlook-t");
    var head = el("tr");
    ["Session", "Poss", "Paint touches", "TAG", "BACK", "Ball reversals", "OER", "DER"].forEach(function (x, i) {
      var th = el("th", i ? "" : "l", x); head.appendChild(th); });
    t.appendChild(head);
    var ptTone = function (v) { return v >= 70 ? "g" : v >= 60 ? "a" : "r"; };
    var tbTone = function (v) { return v == null ? "" : v <= 0.8 ? "g" : v >= 1.2 ? "r" : ""; };
    var tb = function (o) { if (!o || !o.n) return el("td", "mu", "—"); var v = o.pts / o.n, c = el("td", tbTone(v), f2(v));
      c.title = o.pts + " points in " + o.n; return c; };
    var bar = function (v, tone, ref) {
      var c = el("td", "sx-prlook-b " + tone);
      var w = el("span", "sx-prlook-bar"); var i = el("i"); i.style.width = Math.max(0, Math.min(100, v)) + "%"; w.appendChild(i);
      if (ref != null) { var u = el("u"); u.style.left = ref + "%"; w.appendChild(u); }
      c.appendChild(el("b", null, Math.round(v) + "%")); c.appendChild(w); return c; };
    var tot = { n: 0, pt: 0, br: 0, pts: 0, tag: { n: 0, pts: 0 }, back: { n: 0, pts: 0 }, dn: 0, dpts: 0 };
    recent.forEach(function (s) {
      var P = s.poss || [], n = P.length; if (!n) return;
      var pt = P.filter(function (q) { return q.pt > 0; }).length, br = P.filter(function (q) { return (q.br || 0) > 0; }).length;
      var all = shotLine(P), dp = s.dposs || [], dl = dp.length ? { pts: s.oppPts || 0, ppp: (s.oppPts || 0) / dp.length } : null;
      var tr = el("tr", cur[s.label] ? "on" : "");
      var d = String(s.label || ""), lab = d.slice(8, 10) + "/" + d.slice(5, 7);
      var c0 = el("td", "l", lab + (cur[s.label] ? " · this session" : "")); tr.appendChild(c0);
      tr.appendChild(el("td", null, String(n)));
      tr.appendChild(bar(100 * pt / n, ptTone(100 * pt / n), 70));
      tr.appendChild(tb(s.trans && s.trans.tag)); tr.appendChild(tb(s.trans && s.trans.back));
      tr.appendChild(bar(100 * br / n, "v", null));
      tr.appendChild(el("td", "o", f2(all.ppp)));
      tr.appendChild(el("td", "o", dl ? f2(dl.ppp) : "—"));
      t.appendChild(tr);
      tot.n += n; tot.pt += pt; tot.br += br; tot.pts += all.pts;
      if (s.trans) { tot.tag.n += s.trans.tag.n; tot.tag.pts += s.trans.tag.pts; tot.back.n += s.trans.back.n; tot.back.pts += s.trans.back.pts; }
      if (dl) { tot.dn += dp.length; tot.dpts += dl.pts; }
    });
    if (tot.n) {
      var tr = el("tr", "tot");
      tr.appendChild(el("td", "l", "All " + recent.length));
      tr.appendChild(el("td", null, String(tot.n)));
      tr.appendChild(bar(100 * tot.pt / tot.n, ptTone(100 * tot.pt / tot.n), 70));
      tr.appendChild(tb(tot.tag)); tr.appendChild(tb(tot.back));
      tr.appendChild(bar(100 * tot.br / tot.n, "v", null));
      tr.appendChild(el("td", "o", f2(tot.pts / tot.n)));
      tr.appendChild(el("td", "o", tot.dn ? f2(tot.dpts / tot.dn) : "—"));
      t.appendChild(tr);
    }
    var wrap = el("div", "sx-prlook-w"); wrap.appendChild(t); box.appendChild(wrap);
    return box;
  }
  function renderPractice(root, sets, label, recent) {
    root.innerHTML = "";
    var P = [];
    sets.forEach(function (s) { P = P.concat(s.poss); });
    var N = P.length;
    if (!N) { root.appendChild(el("div", "sx-empty", "No tagged possessions in this range.")); return; }
    var all = shotLine(P);
    var withPT = P.filter(function (q) { return q.pt > 0; });
    var withBR = P.filter(function (q) { return (q.br || 0) > 0; });

    try{ if(window.LowenColourKey) root.appendChild(window.LowenColourKey("us")); }catch(e){}
    root.appendChild(el("div", "sx-meta", label + " · " + sets.length + (sets.length === 1 ? " session" : " sessions") +
      " · " + N + " possessions · " + all.pts + " points · " + f2(all.ppp) + " PPP"));

    /* Two concepts, two blocks. They were interleaved - a rate panel holding both gauges,
       then a reversal table, then a touch table - so reading either one meant skipping
       over the other. Each now has its own group and its own gauge, and the groups lay
       their sections side by side like everywhere else. */
    /* THE SESSIONS IN ONE LOOK, before any table: how much was tagged, what it returned,
       the two rates the staff trains for, and how they moved from one session to the next */
    try {
      var KP = window.UIKit;
      if (KP && KP.strip) {
        var ptRate = 100 * withPT.length / N, brRate = 100 * withBR.length / N;
        var gradeP = function (v) { return v >= 70 ? "good" : v >= 60 ? "neutral" : "bad"; };
        var perSet = function (key, title, graded) {
          if (sets.length < 2) return null;
          return KP.strip({ title: title, sub: "share of possessions, session by session", items: sets.map(function (s, i) {
            var n = s.poss.length, m = s.poss.filter(function (q) { return (q[key] || 0) > 0; }).length, v = n ? 100 * m / n : 0;
            return { label: String(s.label || ("S" + (i + 1))).slice(5), value: v, text: Math.round(v) + "%", tone: graded ? gradeP(v) : "vol", title: (s.label || "") + " · " + n + " possessions" }; }) });
        };
        var worthP = function (key, title) {
          var it = [0, 1, 2].map(function (k) {
            var g = P.filter(function (q) { return k < 2 ? (q[key] || 0) === k : (q[key] || 0) >= 2; }), s = shotLine(g);
            return g.length ? { label: (k === 2 ? "2+" : String(k)) + " · " + g.length + " poss", value: s.ppp || 0, text: f2(s.ppp),
              tone: s.ppp >= all.ppp + 0.05 ? "good" : s.ppp <= all.ppp - 0.05 ? "bad" : "neutral" } : null; }).filter(Boolean);
          return it.length >= 2 ? KP.strip({ title: title, sub: "points per possession by how many", items: it }) : null;
        };
        var types = PT_TYPES.map(function (t) { var n = 0; P.forEach(function (q) { n += count(q.tags, t); }); return { label: t, n: n }; })
          .filter(function (x) { return x.n > 0; }).sort(function (a, b) { return b.n - a.n; });
        var typeTot = 0; types.forEach(function (x) { typeTot += x.n; });
        var sP = shotLine(withPT), sN = shotLine(P.filter(function (q) { return !(q.pt > 0); }));
        if (recent && recent.length) root.appendChild(practiceLook(recent, sets)); else
        root.appendChild(KP.summary({ cls: "sx-prsum", title: "The practice in one look", sub: label, figures: [
          { label: "Tagged", value: N, note: "possessions · " + sets.length + (sets.length === 1 ? " session" : " sessions"), tone: "vol" },
          { label: "Points per possession", value: f2(all.ppp), note: all.pts + " points · " + all.fgm + "/" + all.fga + " FG", tone: "vol" },
          { label: "Paint touch rate", value: Math.round(ptRate) + "%", note: "target 70%", tone: gradeP(ptRate), scale: { lo: 0, hi: 100, v: ptRate, ref: 70 } },
          { label: "PPP with / without a touch", value: f2(sP.ppp) + " / " + f2(sN.ppp), note: sP.n + " and " + sN.n + " possessions", tone: (sP.ppp || 0) >= (sN.ppp || 0) ? "good" : "bad" },
          { label: "Ball reversal rate", value: Math.round(brRate) + "%", note: withBR.length + " possessions with one or more", tone: "vol", scale: { lo: 0, hi: 100, v: brRate } }],
          visuals: [perSet("pt", "Paint touch rate", true), worthP("pt", "What a paint touch is worth"),
            typeTot ? KP.split({ title: "Where the touches come from", sub: "share of the touches tagged",
              parts: types.map(function (x) { return { label: x.label, share: x.n / typeTot, value: x.n }; }) }) : null,
            perSet("br", "Ball reversal rate", false), worthP("br", "What a reversal is worth")] }));
      }
    } catch (e) { }

    var pG = g2Group("pt", "01", "Paint touches");
    var bG = g2Group("br", "02", "Ball reversals");
    /* in place from the start; the sections below fill them where they belong */
    root.appendChild(pG); root.appendChild(bG);

    var s1 = section("Rate vs the 70% target");
    s1.appendChild(gauge("Paint touch", withPT.length, N, null));
    pG.appendChild(s1);
    var s1b = section("Rate");
    s1b.appendChild(gauge("Ball reversal", withBR.length, N, null, false));
    bG.appendChild(s1b);

    var s2 = section("By count", "In practice the category itself carries the count.");
    var rows = [];
    [0, 1, 2, 3].forEach(function (k) {
      var g = P.filter(function (q) { return q.br === k; });
      if (!g.length) return;
      var s = shotLine(g);
      rows.push([k, g.length, { v: pct(g.length, N), cls: "sx-vol " + volStep(100 * g.length / N) }, s.pts,
        { v: f2(s.ppp), cls: "sx-cell " + pppStep(s.ppp) }, s.fgm + "/" + s.fga, s.t3a,
        pct(g.filter(function (q) { return q.pt > 0; }).length, g.length)]);
    });
    var other = P.filter(function (q) { return q.br == null; });
    if (other.length) {
      var so = shotLine(other);
      rows.push({ cls: "sx-totrow", cells: ["Other actions", other.length, pct(other.length, N), so.pts, f2(so.ppp), so.fgm + "/" + so.fga, so.t3a, pct(other.filter(function (q) { return q.pt > 0; }).length, other.length)] });
    }
    s2.appendChild(table(["Reversals", "Poss", "%", "Points", "PPP", "FG", "3PA", "% w/ PT"], rows));
    bG.appendChild(s2);

    var s3 = section("By count", "Counting the tagged touch types.");
    s3.appendChild(table(["Touches", "Poss", "%", "PPP", "FG", "2PA", "3PA", "FTA", "TOV"],
      [0, 1, 2, 3].map(function (k) {
        var g = P.filter(function (q) { return k < 3 ? q.pt === k : q.pt >= 3; });
        var s = shotLine(g);
        return [k === 3 ? "3 or more" : k, g.length,
          { v: pct(g.length, N), cls: "sx-vol " + volStep(100 * g.length / N) },
          { v: f2(s.ppp), cls: "sx-cell " + pppStep(s.ppp) },
          s.fgm + "/" + s.fga, s.t2a, s.t3a, s.fta, s.tov];
      }).filter(function (r) { return r[1]; })));
    pG.appendChild(s3);

    /* ---- TAG and BACK, the same table the post-game report has ----
       It needs defensive clips to run our end against, and a practice file only
       has them for the stretch that was played 5x5. When they are there the
       table is identical to the game one, read the same way and with the same
       marks; when they are not, the block says so rather than drawing an empty
       table, and what is left of the question — the rebounding on our own
       misses — is the smaller table under it. */
    var TDF = ["n", "pts", "of", "miss", "oreb", "tn", "tpts", "mtu"];
    var tdZero = function () { var z = {}; TDF.forEach(function (f) { z[f] = 0; }); return z; };
    var TD = { tag: tdZero(), back: tdZero() }, defClips = 0, mtuOdd = 0, orebLoose = 0, mtuBy = {};
    sets.forEach(function (s) {
      defClips += s.defN || 0;
      var t = s.trans; if (!t) return;
      mtuOdd += t.mtuOdd || 0; orebLoose += t.orebLoose || 0;
      Object.keys(t.mtuBy || {}).forEach(function (k) { mtuBy[k] = (mtuBy[k] || 0) + t.mtuBy[k]; });
      ["tag", "back"].forEach(function (k) {
        TDF.forEach(function (f) { TD[k][f] += t[k][f] || 0; });
      });
      var sb = t.back && t.back.sub; TD.back.sub = TD.back.sub || { to: { n: 0, pts: 0 }, miss: { n: 0, pts: 0 }, make: { n: 0, pts: 0 } };
      if (sb) ["to", "miss"].forEach(function (k) { TD.back.sub[k].n += (sb[k] && sb[k].n) || 0; TD.back.sub[k].pts += (sb[k] && sb[k].pts) || 0; });
    });
    var tdAny = (TD.tag.n + TD.back.n) > 0;
    /* A training has no defensive clips - it is two of our own fives - so the possession
       defended is the action that follows the shot. See buildTransPractice for the rule.
       What was missing here was the volume and what it cost: how many times we had to tag
       up or get back, and the points given up each time. */
    if (tdAny) {
      var sTD = section("Transition defense \u2014 TAG and BACK",
        "The possession counted is the action that follows one of ours: not a second chance, " +
        "and opening within ten seconds of ours ending, which is live play and nothing else. " +
        "DER is what that action scored, per possession. The last two columns are the ones " +
        "tagged as a transition attack, on their own.");
      var tdRowP = function (lbl, o, marks) {
        var share = 100 * o.n / Math.max(1, TD.tag.n + TD.back.n);
        var ppp = o.n ? o.pts / o.n : null;
        return { cells: [lbl, o.of, o.miss, o.oreb,
          { v: pct(o.oreb, o.miss), cls: "sx-cell" + (o.miss < SMALL ? " sx-small" : "") },
          /* the mark belongs to the long shot, so the rim row has none to show */
          o === TD.back ? "—" : o.mtu,
          { v: o.n, cls: "sx-vol " + volStep(share) },
          o.pts,
          /* points conceded: the one direction that turns round - see pppStepD */
          { v: f2(ppp), cls: "sx-cell " + pppStepD(ppp) + (o.n < SMALL ? " sx-small" : "") },
          o.tn, o.tpts,
          marks] };
      };
      var tdAll = tdZero();
      TDF.forEach(function (f) { tdAll[f] = TD.tag[f] + TD.back[f]; });
      var tdTot = tdRowP("TAG + BACK", tdAll, "");
      tdTot.cls = "sx-totrow";
      sTD.appendChild(table(["Situation", "Our poss.", "Missed", "Off. reb", "OREB%", "Missed tag up",
        "Possessions", "Pts conceded", "DER", "In transition", "Trans. pts", "We finished on"], [
        tdRowP("TAG \u00b7 after a long shot", TD.tag, "M3 \u00b7 ML2 \u00b7 C3 \u00b7 CL2"),
        tdRowP("BACK \u00b7 after a miss at the rim or a turnover", TD.back, "M2 \u00b7 Turnover")
      ].concat(backSubRows(TD.back, TD.tag.n + TD.back.n, 12)).concat([
        tdTot
      ])));
      sTD.appendChild(el("div", "sx-sub", sets.length + (sets.length === 1 ? " session" : " sessions") +
        (defClips ? " \u00b7 " + defClips + (defClips === 1 ? " defensive clip" : " defensive clips") : "") + "."));
      /* who the missed tag ups belong to, most first */
      var mtuWho = Object.keys(mtuBy).sort(function (a, b) { return (mtuBy[b] - mtuBy[a]) || a.localeCompare(b); });
      if (mtuWho.length) {
        var line = el("div", "sx-sub sx-mtu");
        line.appendChild(el("b", "", "Missed tag up — "));
        line.appendChild(document.createTextNode(mtuWho.map(function (k) { return k + " " + mtuBy[k]; }).join(" · ")));
        sTD.appendChild(line);
      }
      /* said, not hidden: what was tagged but could not be placed in the table above */
      if (orebLoose) sTD.appendChild(el("div", "sx-sub", orebLoose + (orebLoose === 1 ? " offensive rebound is" : " offensive rebounds are") +
        " tagged on a row with no missed shot written on it (M2, M3 or ML2), so " + (orebLoose === 1 ? "it is" : "they are") +
        " not under TAG or BACK above. " + (TD.tag.oreb + TD.back.oreb + orebLoose) + " tagged in all."));
      if (mtuOdd) sTD.appendChild(el("div", "sx-sub", mtuOdd + " MISSED TAG UP on a row that is not an M3 or an ML2 — a tagging slip, not counted above."));
      sTD.appendChild(leagueOrbLine());
      root.appendChild(sTD);
    } else {
      root.appendChild(section("Transition defense \u2014 TAG and BACK",
        "Nothing to read: no action in these sessions opens within ten seconds of a shot or a turnover of ours, so there is no possession to get back for. It appears with the first stretch of live five on five."));
    }

    /* Same split as the post-game block, without the TAG/BACK names: there is
       no defensive clip in a practice file to run the transition against, so
       what is left is the shot the miss came from. Hidden when nothing was
       marked, and hidden when a clip carries two missed shots, because then the
       rebound cannot be tied to one of them. */
    var OR = { tagMiss: 0, tagOreb: 0, backMiss: 0, backOreb: 0, marks: 0, mixed: 0 };
    sets.forEach(function (s) {
      var o = s.oreb; if (!o) return;
      for (var k in OR) if (OR.hasOwnProperty(k)) OR[k] += o[k] || 0;
    });
    if (!tdAny && OR.marks > 0 && OR.mixed === 0 && (OR.tagMiss + OR.backMiss) > 0) {
      var s34 = section("Offensive rebounding on our misses");
      s34.appendChild(table(["Shot", "Missed", "Off. rebounds", "OREB%", "Marks"], [
        { cells: ["Long shots", OR.tagMiss, OR.tagOreb,
          { v: pct(OR.tagOreb, OR.tagMiss), cls: "sx-cell" + (OR.tagMiss < SMALL ? " sx-small" : "") },
          "M3 · ML2"] },
        { cells: ["Shots at the rim", OR.backMiss, OR.backOreb,
          { v: pct(OR.backOreb, OR.backMiss), cls: "sx-cell" + (OR.backMiss < SMALL ? " sx-small" : "") },
          "M2"] }
      ]));
      root.appendChild(s34);
    }

    /* what each concept changes about the shot, under the concept it belongs to */
    [["pt", "Paint touches", pG], ["br", "Ball reversals", bG]].forEach(function (pair) {
      var sec = section("What it changes: shot selection");
      var any = false;
      [0, 1, 2].forEach(function (k) {
        var g = P.filter(function (q) { var v = q[pair[0]] || 0; return k < 2 ? v === k : v >= 2; });
        if (!g.length) return;
        any = true;
        var s = shotLine(g);
        sec.appendChild(mixBar((k === 2 ? "2+" : k) + (pair[0] === "br" ? " rev" : " touch"), s.t2a, s.t3a, s.ppp,
          g.length + " poss · " + s.fgm + "/" + s.fga + " FG · " + pct(s.fgm, s.fga)));
      });
      if (any) pair[2].appendChild(sec);
    });

    var tt = touchTable(P);
    if (tt.length) {
      var cats = PT_TYPES.concat(["OREB"]);
      var s4 = section("Paint touches by player and type",
        "Only the practice files carry the touch type and the player. " +
        "The shading is the blue volume ramp, read down each column: darkest is the player with most of that touch.");
      var shown = tt.filter(function (p) { return p.total >= 3; });
      /* one ramp per column, against that column's own best, so a rare touch
         type is still readable next to a common one */
      var colMax = {};
      cats.forEach(function (c) {
        colMax[c] = Math.max.apply(null, shown.map(function (p) { return p[c] || 0; }).concat([0]));
      });
      var totMax = Math.max.apply(null, shown.map(function (p) { return p.total; }).concat([0]));
      var cell = function (v, mx) {
        if (!v) return { v: 0, cls: "sx-zero" };
        return { v: v, cls: "sx-vol " + volStep(mx ? 100 * v / mx : 0) };
      };
      var trows = shown.map(function (p) {
        return [p.name]
          .concat(cats.map(function (c) { return cell(p[c] || 0, colMax[c]); }))
          .concat([{ v: p.total, cls: "sx-strong sx-vol " + volStep(totMax ? 100 * p.total / totMax : 0) }]);
      });
      var tot = { name: "Team total", total: 0 };
      tt.forEach(function (p) { cats.forEach(function (c) { tot[c] = (tot[c] || 0) + (p[c] || 0); }); tot.total += p.total; });
      trows.push({ cls: "sx-totrow", cells: ["Team total"].concat(cats.map(function (c) { return tot[c] || 0; })).concat([tot.total]) });
      s4.appendChild(table(["Player"].concat(cats).concat(["Total"]), trows));
      s4.appendChild(legendVolumeOnly());
      pG.appendChild(s4);
    }


    if (sets.length > 1) {
      var s5 = section("Session by session");
      s5.appendChild(table(["Session", "Poss", "Points", "PPP", "% w/ PT", "PPP w/ PT", "PPP w/o PT", "% w/ Rev"],
        sets.map(function (s) {
          var sp = s.poss, sa = shotLine(sp);
          var w = shotLine(sp.filter(function (q) { return q.pt > 0; }));
          var o = shotLine(sp.filter(function (q) { return q.pt === 0; }));
          var b = sp.filter(function (q) { return (q.br || 0) > 0; });
          return [s.label, sp.length, sa.pts,
            { v: f2(sa.ppp), cls: "sx-cell " + pppStep(sa.ppp) },
            { v: pct(w.n, sp.length), cls: "sx-vol " + volStep(100 * w.n / sp.length) },
            f2(w.ppp), f2(o.ppp),
            { v: pct(b.length, sp.length), cls: "sx-vol " + volStep(100 * b.length / sp.length) }];
        })));
      root.appendChild(s5);
    }

    root.appendChild(legend());
  }

  function legend() {
    var l = el("div", "sx-legend");
    var a = el("span", null, "PPP");
    l.appendChild(a);
    var sc = el("span", "sx-scale");
    [["s0", "<0.50"], ["s1", "0.50"], ["s2", "0.80"], ["s3", "1.00"], ["s4", "1.25"], ["s5", "1.60+"]].forEach(function (x) {
      var sw = el("span", "sx-sw");
      var i = el("i", "sx-" + x[0]); sw.appendChild(i); sw.appendChild(el("span", null, x[1])); sc.appendChild(sw);
    });
    l.appendChild(sc);
    l.appendChild(el("span", null, "Volume"));
    var sv = el("span", "sx-scale");
    [["b0", "<20%"], ["b1", "20%"], ["b2", "35%"], ["b3", "50%"], ["b4", "65%"], ["b5", "80%+"]].forEach(function (x) {
      var sw = el("span", "sx-sw");
      var i = el("i", "sx-" + x[0]); sw.appendChild(i); sw.appendChild(el("span", null, x[1])); sc.appendChild(sw);
      sv.appendChild(sw);
    });
    l.appendChild(sv);
    return l;
  }

  /* -------------------------------------------------------- file matching */

  /* the blue ramp on its own, built from the same pieces as legend() so the
     two read identically — tables with volume and no PPP use this one */
  function legendVolumeOnly() {
    var l = el("div", "sx-legend");
    l.appendChild(el("span", null, "Share of the column leader"));
    var sv = el("span", "sx-scale");
    [["b0", "<20%"], ["b1", "20%"], ["b2", "35%"], ["b3", "50%"], ["b4", "65%"], ["b5", "80%+"]].forEach(function (x) {
      var sw = el("span", "sx-sw");
      sw.appendChild(el("i", "sx-" + x[0]));
      sw.appendChild(el("span", null, x[1]));
      sv.appendChild(sw);
    });
    l.appendChild(sv);
    return l;
  }

  function slug(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function findGameFile(files, opponent, date) {
    /* a workbook in this folder is never a tagging export, and read as CSV it
       parses into rows with no tags at all — every count would come out zero */
    files = (files || []).filter(function (f) { return /\.csv$/i.test(f.name || ""); });
    var op = slug(opponent);
    var hit = files.filter(function (f) { return op && slug(f.name).indexOf(op) >= 0; });
    if (!hit.length && opponent) {
      // "Rasta Vechta" in the schedule, "VECHTA" in the file name: fall back to the
      // longest word of the name, but only when exactly one file answers to it.
      var words = String(opponent).split(/\s+/).map(slug).filter(function (w) { return w.length >= 4; })
        .sort(function (a, b) { return b.length - a.length; });
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var alt = files.filter(function (f) { return slug(f.name).indexOf(w) >= 0; });
        if (alt.length === 1) { hit = alt; break; }
        if (alt.length > 1) { hit = alt; break; }
      }
    }
    if (!hit.length && opponent) {
      /* A NAME TYPED WITH ONE SLIP IS STILL THAT GAME. "G10 BBL LUDWISGBURG.csv" has two
         letters the wrong way round, so the Ludwigsburg game had its tagging in the folder
         and no report, and was missing from every trend. One slip in a word of six
         letters or more is let through: two neighbours swapped, or one letter wrong,
         missing or extra. Only when exactly one file answers, so it cannot pick between
         two. */
      var slip = function (a, b) {
        var la = a.length, lb = b.length, i = 0;
        if (Math.abs(la - lb) > 1) return false;
        while (i < la && i < lb && a.charAt(i) === b.charAt(i)) i++;
        if (i === la && i === lb) return true;
        if (la === lb) return a.slice(i + 1) === b.slice(i + 1) ||
          (a.charAt(i) === b.charAt(i + 1) && a.charAt(i + 1) === b.charAt(i) && a.slice(i + 2) === b.slice(i + 2));
        var lg = la > lb ? a : b, sh = la > lb ? b : a;
        return lg.slice(i + 1) === sh.slice(i);
      };
      var ws = String(opponent).split(/\s+/).map(slug).filter(function (w) { return w.length >= 6; });
      var near = files.filter(function (f) {
        var toks = String(f.name || "").replace(/\.csv$/i, "").split(/[^A-Za-zÀ-ÿ]+/).map(slug).filter(Boolean);
        return ws.some(function (w) { return toks.some(function (t) { return t.length >= 6 && slip(t, w); }); });
      });
      if (near.length === 1) hit = near;
    }
    if (!hit.length) return null;
    if (hit.length > 1 && date) {
      // two games against the same opponent: the date in the file name decides
      var byDate = hit.filter(function (f) { return fileDate(f.name) === date; });
      if (byDate.length) return byDate[0];
      var d = date.replace(/-/g, "");
      var byDigits = hit.filter(function (f) { return slug(f.name).indexOf(d) >= 0; });
      if (byDigits.length) return byDigits[0];
    }
    return hit[0];
  }

  // Two naming habits are in use, so both are read:
  //   training-020926-2026-09-02.csv          → 2026-09-02   (ISO, wins if present)
  //   19_9_2026 G7 BBL TRIER.csv              → 2026-09-19   (day_month_year)
  //   10_9_2026 G6 CUP POSTGAME BREMERHAVEN…  → 2026-09-10
  // Separators may be _ - . or /. A four-digit first number means year first.
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fileDate(name) {
    // scan every ISO-looking run and take the first one that is a real date,
    // so a nonsense "2026-13-01" does not shadow a good date later in the name
    var re = /(\d{4})-(\d{2})-(\d{2})/g, iso;
    while ((iso = re.exec(name))) {
      if (+iso[2] >= 1 && +iso[2] <= 12 && +iso[3] >= 1 && +iso[3] <= 31 &&
          +iso[1] >= 2000 && +iso[1] <= 2099) return iso[0];
    }
    var m = /(?:^|[^\d])(\d{1,4})[_.\/-](\d{1,2})[_.\/-](\d{1,4})(?:[^\d]|$)/.exec(name);
    if (!m) return null;
    var y, mo = +m[2], d;
    if (m[1].length === 4) {                 // 2026-9-19, 2026_09_18 — year first
      if (m[3].length > 2) return null;
      y = +m[1]; d = +m[3];
    } else {                                  // 19_9_2026, 5-10-26 — day first
      if (m[1].length > 2) return null;
      d = +m[1];
      if (m[3].length === 4) y = +m[3];
      else if (m[3].length === 2) y = 2000 + (+m[3]);
      else return null;                       // a one-digit year is not a year
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2099) return null;
    return y + "-" + pad2(mo) + "-" + pad2(d);
  }

  function practiceFilesInRange(files, from, to) {
    return files.map(function (f) { return { f: f, d: fileDate(f.name) }; })
      .filter(function (x) { return x.d && x.d >= from && x.d <= to; })
      .sort(function (a, b) { return a.d < b.d ? -1 : 1; });
  }

  function rangeFor(scope, iso) {
    var d = new Date(iso + "T00:00:00");
    if (scope === "session") return [iso, iso];
    if (scope === "week") {
      var dow = (d.getDay() + 6) % 7;
      var mon = new Date(d); mon.setDate(d.getDate() - dow);
      var sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
    }
    if (scope === "month") {
      return [iso.slice(0, 8) + "01", iso.slice(0, 8) + "31"];
    }
    return ["1900-01-01", "2999-12-31"];
  }

  /* ==================================================================
     POST-GAME TEAM STATS  —  the block that sits under "Other" in the
     written post-game report.

     Tables only. Every number lives in a cell; the single line under each
     band is the definition, not commentary. Visual line taken from the game
     plan: Oswald for labels, Inter for the body, Plex Mono for figures,
     hairline rules, inline volume bars, and a PPP scale that diverges from
     OUR OWN PPP for the same game rather than from an absolute ramp.

     Possession credit: a possession belongs to the action it started with
     (`first`) and keeps that credit. Offensive rebounds are a column, not a
     phase that swallows the set. `phase` itself is left alone — the rate
     table above still uses it, and the rest of the report depends on it.
     ================================================================== */

  /* Out of bounds is two different things and the playbook says which is which:
     BASELINE (BOB) holds Pio Pio and Last, SIDELINE (SOB) holds the 3 series and
     3 Special. Lumping them together hid the difference between a baseline set
     and a sideline set, which are not the same play or the same read.
     "Last" is in both lists in the playbook, so a clip tagged only LAST cannot
     be told apart and is counted as sideline with a note. */
  var PG_FAMS = ["Transition", "Early offense", "Half court set",
                 "Sideline (SOB)", "Baseline (BOB)", "Out of sets", "ATO"];
  var SOB_CATS = ["3 SLOB", "OTHER SLOB", "3 SPECIAL", "SLOB"];
  var BOB_CATS = ["PIO PIO", "BLOB", "OTHER BLOB", "3 BLOB"];
  function pgFamily(cat) {
    cat = String(cat || "").trim();
    if (FB_CATS.indexOf(cat) >= 0) return "Transition";
    if (SEC_CATS.indexOf(cat) >= 0) return "Early offense";
    var up=cat.toUpperCase();
    /* Every baseline set in one family and every sideline set in the other,
       whichever of the two spellings the tagger used. A coded set goes by its
       first letter: B is a baseline, S is a sideline. "SOB 3" and "OTHER SOB"
       matched nothing before and were filed as half court sets. */
    if (BOB_CATS.indexOf(up) >= 0 || /\b(BOB|BLOB)\b/.test(up) || /^PIO/.test(up) ||
        /^B\s?\d/.test(up)) return "Baseline (BOB)";
    if (SOB_CATS.indexOf(up) >= 0 || /\b(SOB|SLOB)\b/.test(up) || /^LAST$/.test(up) ||
        /^S\s?\d/.test(up)) return "Sideline (SOB)";
    if (/^ATO/i.test(cat)) return "ATO";
    if (/^(OUT OF SETS|OTHER OREB|PUTBACK|OTHER ACTIONS)$/i.test(cat)) return "Out of sets";
    return "Half court set";
  }


  function orebOf(list) { var n = 0; list.forEach(function (q) { n += q.oreb || 0; }); return n; }

  /* ---- the post-game block, built out of the report's own components ----
     Gauges, banded tables and shot-mix bars: the same language the Post game
     view already uses. What is new is the arrangement — the report is cut into
     three categories with a menu, so paint touches, ball reversals and the
     efficiency tables never sit in the same scroll. */

  /* one category of the block */
  function g2Group(key, no, title, note) {
    var w = el("div", "sx-cat");
    w.dataset.g = key;
    var hd = el("div", "sx-cath fit-span");
    hd.appendChild(el("span", "sx-catno", no));
    hd.appendChild(el("span", "sx-catt", title));
    w.appendChild(hd);
    if (note) w.appendChild(el("div", "sx-catn fit-span", note));
    return w;
  }

  /* the efficiency row: every possession counted once, offensive rebounds a
     column rather than a phase that swallows the set it came from */
  /* Efficiency and volume are two different things and each keeps its own
     channel: the PPP cell is always coloured, whatever the sample, so a good
     number on five possessions is still visible; the share column carries the
     volume. A row under SMALL possessions is ringed instead of dimmed — the
     warning is there without the number being taken away. */
  var SMALL = 5;
  /* one channel, one fact: the Poss cell is tinted by how big the row is next
     to the biggest row of its own table, the share stays a plain number, and
     the PPP keeps the green ramp. Tinting the share instead would paint a
     one-possession set that is the whole of its family as the darkest cell on
     the page. */
  function effCells(label, list, total, max, extra) {
    var s = shotLine(list), n = list.length;
    return {
      cells: [
        extra && extra.indent ? { v: label, cls: "sx-indent" } : label,
        { v: n, cls: "sx-vol " + volStep(100 * n / (max || 1)) },
        pct(n, total),
        s.pts,
        { v: f2(s.ppp), cls: "sx-cell " + pppCls(s.ppp, extra && extra.def) + (n < SMALL ? " sx-small" : "") },
        s.fgm + "/" + s.fga, s.t2a, s.t3a, s.fta,
        s.tov + (n ? " · " + Math.round(100 * s.tov / n) + "%" : ""),
        orebOf(list)
      ]
    };
  }
  function effHead(first, share) {
    return [first, "Poss", share || "% all", "Pts", "PPP", "FG", "2PA", "3PA", "FTA", "TO", "OREB"];
  }

  /* ---- the block ------------------------------------------------------- */

  function renderPostTeam(root, model, meta) {
    root.innerHTML = "";
    var P = model.poss || [], N = P.length;
    if (!N) { root.appendChild(el("div", "sx-empty", "No tagged possessions in this game.")); return; }

    var box = el("div", "sx sx-post");
    /* A file that parses but carries no PAINT TOUCH would report 0% everywhere
       and look like a bad game instead of a tag that never arrived. The two
       marks the whole block rests on are checked and named. */
    var ptTot = 0, brTot = 0;
    P.forEach(function (q) { ptTot += (q.pt || 0); brTot += (q.br || 0); });
    if (!ptTot || !brTot) {
      var miss = [];
      if (!ptTot) miss.push("PAINT TOUCH");
      if (!brTot) miss.push("BR:");
      var w = el("div", "sx-gap");
      w.appendChild(el("b", "", "Not one of the " + N + " tagged possessions carries " +
        miss.join(" nor ") + "."));
      w.appendChild(el("span", "", "The block reads those two marks from the descriptors, written exactly " +
        "like that — \"PAINT TOUCH\" and a reversal as \"BR: 1\". Everything below that counts them " +
        "is therefore zero, which is a tagging gap, not a bad game."));
      box.appendChild(w);
    }
    var all = shotLine(P), anchor = all.ppp;
    var fbP = P.filter(function (q) { return q.phase === "Fastbreak"; });
    var restP = P.filter(function (q) { return q.phase !== "Fastbreak"; });
    var noFB = restP;

    var byFam = {}, bySet = {};
    P.forEach(function (q) {
      var cat = String(q.first || "—").trim() || "—";
      var fam = pgFamily(cat);
      (byFam[fam] || (byFam[fam] = [])).push(q);
      var key = fam + "||" + cat;
      (bySet[key] || (bySet[key] = { fam: fam, cat: cat, list: [] })).list.push(q);
    });
    var qs = ["1Q", "2Q", "3Q", "4Q", "OT"].filter(function (q) { return P.some(function (x) { return x.q === q; }); });
    var phases = PHASES.filter(function (ph) { return P.some(function (q) { return q.phase === ph; }); });
    var byPhase = phases.map(function (ph) {
      return { label: ph, list: P.filter(function (q) { return q.phase === ph; }) };
    });
    var byQ = qs.map(function (qq) {
      return { label: qq, list: P.filter(function (q) { return q.q === qq; }) };
    });
    var pbp = gameTouchTable(P);

    try{ if(window.LowenColourKey) box.appendChild(window.LowenColourKey("us")); }catch(e){}
    box.appendChild(el("div", "sx-meta", meta + " · " + N + " possessions · " +
      all.pts + "–" + model.oppPts + " from the tagging · " + f2(all.ppp) + " PPP"));

    var menu = el("div", "sx-menu");
    box.appendChild(menu);

    /* ------------------------------------------------ shared table shapes */

    /* the old count table: 0 / 1 / 2+ of the concept across a dimension */
    function countTable(dimName, items, key) {
      var rows = items.map(function (it) {
        var sub = it.list;
        var cells = [it.label, sub.length, { v: pct(sub.length, N), cls: "sx-vol " + volStep(100 * sub.length / N) }];
        [0, 1, 2].forEach(function (k) {
          var g = sub.filter(function (q) { return k < 2 ? (q[key] || 0) === k : (q[key] || 0) >= 2; });
          var s = shotLine(g);
          cells.push(g.length);
          cells.push({ v: pct(g.length, sub.length), cls: "sx-vol " + volStep(100 * g.length / sub.length) });
          cells.push({ v: f2(s.ppp), cls: "sx-cell " + pppStep(s.ppp) });
        });
        var w = shotLine(sub.filter(function (q) { return (q[key] || 0) > 0; }));
        cells.push({ v: f2(w.ppp), cls: "sx-cell " + pppStep(w.ppp) });
        cells.push({ v: f2(shotLine(sub).ppp), cls: "sx-cell sx-tot" });
        return cells;
      });
      /* THE WHOLE, UNDER ITS PARTS. Each row says how a phase or a quarter splits into
         none, one, two or more; what was missing was the same split for everything
         together - how many possessions of the game had none, one, two or more, and
         what share of the total that is. */
      var allList = [];
      items.forEach(function (it) { allList = allList.concat(it.list); });
      if (items.length > 1 && allList.length) {
        var tc = ["Total", allList.length, { v: pct(allList.length, N), cls: "" }];
        [0, 1, 2].forEach(function (k) {
          var g = allList.filter(function (q) { return k < 2 ? (q[key] || 0) === k : (q[key] || 0) >= 2; });
          tc.push(g.length);
          tc.push({ v: pct(g.length, allList.length), cls: "sx-vol " + volStep(100 * g.length / allList.length) });
          tc.push({ v: f2(shotLine(g).ppp), cls: "sx-cell " + pppStep(shotLine(g).ppp) });
        });
        tc.push({ v: f2(shotLine(allList.filter(function (q) { return (q[key] || 0) > 0; })).ppp), cls: "sx-cell" });
        tc.push({ v: f2(shotLine(allList).ppp), cls: "sx-cell sx-tot" });
        rows.push({ cls: "sx-totrow", cells: tc });
      }
      return table([dimName, "Poss", "% all", "0", "%", "PPP", "1", "%", "PPP", "2+", "%", "PPP", "PPP w/ 1+", dimName + " PPP"], rows);
    }

    /* the staples pair: played against not played */
    function staplesTable(key, onLabel, offLabel) {
      var on = P.filter(function (q) { return (q[key] || 0) > 0; });
      var off = P.filter(function (q) { return (q[key] || 0) === 0; });
      return table(["", "Poss", "Points", "PPP", "% of poss"], [on, off].map(function (list, i) {
        var s = shotLine(list);
        return [i ? offLabel : onLabel, list.length, s.pts,
          { v: f2(s.ppp), cls: "sx-cell " + pppStep(s.ppp) },
          { v: pct(list.length, N), cls: "sx-vol " + volStep(100 * list.length / N) }];
      }));
    }

    /* the shot-mix column: what the concept does to shot selection */
    function mixBox(key, label) {
      var boxc = el("div");
      boxc.appendChild(el("div", "sx-band", label));
      [0, 1, 2].forEach(function (k) {
        var g = noFB.filter(function (q) { return k < 2 ? (q[key] || 0) === k : (q[key] || 0) >= 2; });
        if (!g.length) return;
        var s = shotLine(g);
        boxc.appendChild(mixBar((k === 2 ? "2+" : String(k)), s.t2a, s.t3a, s.ppp,
          g.length + " poss · " + s.fgm + "/" + s.fga + " FG · " + pct(s.fgm, s.fga) + " · " + s.fta + " FTA"));
      });
      return boxc;
    }

    /* ================================================== PAINT TOUCHES === */
    var gPT = g2Group("pt", "01", "Paint touches");
    var ptRest = restP.filter(function (q) { return (q.pt || 0) > 0; }).length;

    var s1 = section("Rate vs the 70% target");
    s1.appendChild(gaugeSplit("Paint touch", fbP.length, fbP.length, ptRest, restP.length, N, "Paint touch"));
    gPT.appendChild(s1);

    var s2 = section("Played or not");
    s2.appendChild(staplesTable("pt", "Paint touch", "No paint touch"));
    gPT.appendChild(s2);

    if (byPhase.length) {
      var s3 = section("By phase");
      s3.appendChild(countTable("Phase", byPhase, "pt"));
      gPT.appendChild(s3);
    }
    if (byQ.length) {
      var s4 = section("By quarter");
      s4.appendChild(countTable("Quarter", byQ, "pt"));
      gPT.appendChild(s4);
    }

    var s5 = section("What it changes: shot selection");
    s5.appendChild(mixBox("pt", "Paint touches"));
    gPT.appendChild(s5);

    var s6 = section("By player");
    if (pbp.rows.length && pbp.coverage >= 0.6) {
      var topTouch = pbp.rows[0].touch || 1;
      s6.appendChild(table(["Player", "Touches", "% of team", "Poss", "Points", "PPP"],
        pbp.rows.map(function (r) {
          return [r.name, r.touch,
            { v: pct(r.touch, pbp.attributed), cls: "sx-vol " + volStep(100 * r.touch / topTouch) },
            r.poss, r.pts, { v: f2(r.ppp), cls: "sx-cell " + pppStep(r.ppp) + (r.poss < SMALL ? " sx-small" : "") }];
        })));
      gPT.appendChild(s6);
    }

    /* where the touches come from — the action map, by family and by action */
    var byAct = {};
    P.forEach(function (q) {
      var cat = String(q.first || "—").trim() || "—";
      var a = byAct[cat] || (byAct[cat] = { cat: cat, fam: pgFamily(cat), n: 0, ptN: 0, list: [] });
      a.n++; a.list.push(q);
      if (q.phase === "Fastbreak" || (q.pt || 0) > 0) a.ptN++;
    });
    var acts = Object.keys(byAct).map(function (k) { return byAct[k]; })
      .sort(function (x, y) { return y.n - x.n || x.cat.localeCompare(y.cat); });
    var s7 = section("Where the touches come from");
    var famT = [];
    PG_FAMS.forEach(function (fam) {
      var list = acts.filter(function (a) { return a.fam === fam; });
      if (!list.length) return;
      var n = 0, ptN = 0, pool = [];
      list.forEach(function (a) { n += a.n; ptN += a.ptN; pool = pool.concat(a.list); });
      var sh = shotLine(pool);
      famT.push([fam, n, { v: pct(n, N), cls: "sx-vol " + volStep(100 * n / N) }, ptN,
        { v: pct(ptN, n), cls: "sx-vol " + volStep(100 * ptN / n) }, sh.pts,
        { v: f2(sh.ppp), cls: "sx-cell " + pppStep(sh.ppp) + (n < SMALL ? " sx-small" : "") }]);
    });
    /* A band and the table under it are one thing. Left as two children of the section
       they were laid out as two panels, which put a label beside somebody else's table;
       made full-width labels instead, each table then took a line of its own and left
       the rest of a 1900px row white. Grouped, the pair is a panel like any other and
       two of them sit side by side. */
    /* NOT byFam. That was a second "var byFam" in the same function, a div, and because
       var is function-scoped it overwrote the map of possessions by family for everything
       after this line - so "By family" and "By set" in the efficiency group below have
       been drawing an empty table, with only their total row, for as long as this box has
       existed. A div and a map of possessions do not share a name any more. */
    var famBox = el("div", "sx-bgrp");
    famBox.appendChild(el("div", "sx-band", "By family"));
    famBox.appendChild(table(["Family", "Poss", "% all", "Touch", "Touch %", "Points", "PPP"], famT));
    s7.appendChild(famBox);
    var actT = acts.map(function (a) {
      var sh = shotLine(a.list);
      return [a.cat, a.fam, a.n, { v: pct(a.n, N), cls: "sx-vol " + volStep(100 * a.n / N) }, a.ptN,
        { v: pct(a.ptN, a.n), cls: "sx-vol " + volStep(100 * a.ptN / a.n) }, sh.pts,
        { v: f2(sh.ppp), cls: "sx-cell " + pppStep(sh.ppp) + (a.n < SMALL ? " sx-small" : "") }];
    });
    var byAct = el("div", "sx-bgrp");
    byAct.appendChild(el("div", "sx-band", "By action"));
    byAct.appendChild(table(["Action", "Family", "Poss", "% all", "Touch", "Touch %", "Points", "PPP"], actT));
    s7.appendChild(byAct);
    gPT.appendChild(s7);
    box.appendChild(gPT);

    /* ================================================= BALL REVERSALS === */
    var gBR = g2Group("br", "02", "Ball reversals");
    var brRest = restP.filter(function (q) { return (q.br || 0) > 0; }).length;

    var r1 = section("Rate");
    r1.appendChild(gaugeSplit("Ball reversal", fbP.length, fbP.length, brRest, restP.length, N, "Ball reversal", false));
    gBR.appendChild(r1);

    var r2 = section("Played or not");
    r2.appendChild(staplesTable("br", "1+ ball reversal", "No reversal"));
    gBR.appendChild(r2);

    if (byPhase.length) {
      var r3 = section("By phase");
      r3.appendChild(countTable("Phase", byPhase, "br"));
      gBR.appendChild(r3);
    }
    if (byQ.length) {
      var r4 = section("By quarter");
      r4.appendChild(countTable("Quarter", byQ, "br"));
      gBR.appendChild(r4);
    }

    var r5 = section("What it changes: shot selection");
    r5.appendChild(mixBox("br", "Ball reversals"));
    gBR.appendChild(r5);
    box.appendChild(gBR);

    /* ====================================================== EFFICIENCY == */
    var gEF = g2Group("eff", "03", "Efficiency");

    var e1 = section("By family");
    var famRows = [], famMax = 1;
    PG_FAMS.forEach(function (f) { if (byFam[f] && byFam[f].length > famMax) famMax = byFam[f].length; });
    PG_FAMS.forEach(function (f) {
      if (!byFam[f] || !byFam[f].length) return;
      famRows.push(effCells(f, byFam[f], N, famMax));
    });
    famRows.push({ cls: "sx-totrow", cells: [
      "Total", { v: N, cls: "sx-vol" }, "100%", all.pts,
      { v: f2(all.ppp), cls: "sx-cell sx-tot" },
      all.fgm + "/" + all.fga, all.t2a, all.t3a, all.fta,
      all.tov + " · " + Math.round(100 * all.tov / N) + "%", orebOf(P)] });
    e1.appendChild(table(effHead("Family"), famRows));
    gEF.appendChild(e1);

    /* "Last" is in both the baseline and the sideline block of the playbook, so
       a clip tagged with nothing else cannot be told apart. It goes to sideline. */
    var e2 = section("By set");
    var setRows = [], setMax = 1;
    Object.keys(bySet).forEach(function (k) { if (bySet[k].list.length > setMax) setMax = bySet[k].list.length; });
    PG_FAMS.forEach(function (fam) {
      if (!byFam[fam] || !byFam[fam].length) return;
      var list = Object.keys(bySet).map(function (k) { return bySet[k]; })
        .filter(function (s) { return s.fam === fam; })
        .sort(function (a, b) { return b.list.length - a.list.length || a.cat.localeCompare(b.cat); });
      /* every set keeps its own row: a row you cannot name is a row you
         cannot act on, and the ring already says the sample is small */
      setRows.push({ cls: "sx-famrow", cells: [{ v: fam, cls: "sx-famc" }, "", "", "", "", "", "", "", "", "", ""] });
      var famN = byFam[fam].length;
      list.forEach(function (s) { setRows.push(effCells(s.cat, s.list, famN, setMax, { indent: 1 })); });
    });
    e2.appendChild(table(effHead("Set", "% fam"), setRows));
    gEF.appendChild(e2);

    if (byPhase.length) {
      var e3 = section("By phase");
      var phMax = 1;
      byPhase.forEach(function (d) { if (d.list.length > phMax) phMax = d.list.length; });
      e3.appendChild(table(effHead("Phase"), byPhase.map(function (d) { return effCells(d.label, d.list, N, phMax); })));
      gEF.appendChild(e3);
    }
    if (byQ.length) {
      var e4 = section("By quarter");
      var qMax = 1;
      byQ.forEach(function (d) { if (d.list.length > qMax) qMax = d.list.length; });
      e4.appendChild(table(effHead("Quarter"), byQ.map(function (d) { return effCells(d.label, d.list, N, qMax); })));
      gEF.appendChild(e4);

      /* THE SAME QUESTION ONE LEVEL DOWN. "By set" says what a system produced over the
         game and "By quarter" says what the game produced in each of its four pieces;
         neither says which system stopped working after half time, which is the thing a
         staff changes at half time. Quarters across, sets down, the efficiency in the
         cell: one grid, read along a row for a set's night and down a column for a
         quarter's. A cell nobody ran is a dash, not a zero. */
      var e5 = section("By set and quarter");
      var qHead = ["Set"].concat(qs).concat(["Poss", "PPP"]);
      var qRows = [];
      PG_FAMS.forEach(function (fam) {
        if (!byFam[fam] || !byFam[fam].length) return;
        var list = Object.keys(bySet).map(function (k) { return bySet[k]; })
          .filter(function (s2) { return s2.fam === fam; })
          .sort(function (a, b) { return b.list.length - a.list.length || a.cat.localeCompare(b.cat); });
        var famCells = [{ v: fam, cls: "sx-famc" }];
        qs.forEach(function (qq) {
          var l = byFam[fam].filter(function (x) { return x.q === qq; });
          var sh = shotLine(l);
          famCells.push(l.length
            ? { v: f2(sh.ppp), cls: "sx-cell " + pppStep(sh.ppp) + (l.length < SMALL ? " sx-small" : "") }
            : { v: "\u2014", cls: "sx-dash" });
        });
        var fsh = shotLine(byFam[fam]);
        famCells.push(byFam[fam].length);
        famCells.push({ v: f2(fsh.ppp), cls: "sx-cell " + pppStep(fsh.ppp) });
        qRows.push({ cls: "sx-famrow", cells: famCells });
        list.forEach(function (s2) {
          var cells = [{ v: s2.cat, cls: "sx-indent" }];
          qs.forEach(function (qq) {
            var l = s2.list.filter(function (x) { return x.q === qq; });
            var sh = shotLine(l);
            cells.push(l.length
              ? { v: f2(sh.ppp), cls: "sx-cell " + pppStep(sh.ppp) + (l.length < SMALL ? " sx-small" : "") }
              : { v: "\u2014", cls: "sx-dash" });
          });
          var tsh = shotLine(s2.list);
          cells.push(s2.list.length);
          cells.push({ v: f2(tsh.ppp), cls: "sx-cell " + pppStep(tsh.ppp) + (s2.list.length < SMALL ? " sx-small" : "") });
          qRows.push({ cells: cells });
        });
      });
      if (qRows.length) {
        e5.appendChild(table(qHead, qRows));
        gEF.appendChild(e5);
      }
    }
    box.appendChild(gEF);

    /* ------------------------------------------- 04 transition defense */
    var TD = model.trans || { tag: { n: 0, pts: 0, of: 0, miss: 0, oreb: 0 },
                              back: { n: 0, pts: 0, of: 0, miss: 0, oreb: 0 } };
    var gTD = g2Group("td", "04", "Transition defense — TAG and BACK");
    /* The colour is the size of the number everywhere in the app except here: these are
       points we gave up, so a high PPP is red and a low one green - see pppStepD. */
    /* One row carries the whole possession, because the question is not how
       often we got beaten but what became of every possession that ended that
       way: how many we missed, how many of those misses we rebounded ourselves,
       and how many turned into a transition situation against us. The rebound
       percentage is over the misses and the misses sit in the column beside it,
       so the denominator is never something to guess.

       A missed long two is a TAG and a missed two at the rim is a BACK — the
       shot decides it, not the distance the rebound travels. */
    function tdRow(lbl, o, marks) {
      var share = 100 * o.n / Math.max(1, TD.tag.n + TD.back.n);
      var ppp = o.n ? o.pts / o.n : null;
      return { cells: [lbl,
        o.of,
        o.miss,
        o.oreb,
        { v: pct(o.oreb, o.miss), cls: "sx-cell" + (o.miss < SMALL ? " sx-small" : "") },
        { v: o.n, cls: "sx-vol " + volStep(share) },
        o.pts,
        { v: f2(ppp), cls: "sx-cell " + pppStepD(ppp) + (o.n < SMALL ? " sx-small" : "") },
        marks] };
    }
    var tdRows = [
      tdRow("TAG \u00b7 after a long shot", TD.tag, "M3 \u00b7 ML2 \u00b7 C3 \u00b7 CL2"),
      tdRow("BACK \u00b7 after a miss at the rim or a turnover", TD.back, "M2 \u00b7 Turnover")
    ].concat(backSubRows(TD.back, TD.tag.n + TD.back.n, 9));
    var sTD = section("The two situations");
    sTD.appendChild(table(["Situation", "Our poss.", "Missed", "Off. reb", "OREB%",
      "Situations", "Pts conceded", "PPP", "We finished on"], tdRows));
    /* the OREB% above is ours against ourselves; this is what the league does */
    sTD.appendChild(leagueOrbLine());
    gTD.appendChild(sTD);

    box.appendChild(gTD);


    /* -------------------------------------- 05 what we concede by situation */
    var DP = model.dposs || [], DN = DP.length;
    var gDF = g2Group("def", "05", "What we concede");

    if (DN) {
      var byCat = {}, catOrder = [];
      DP.forEach(function (q) {
        var k = q.label || "—";
        if (!byCat[k]) { byCat[k] = []; catOrder.push(k); }
        byCat[k].push(q);
      });
      catOrder.sort(function (a, b) { return byCat[b].length - byCat[a].length; });
      var dMax = byCat[catOrder[0]].length || 1;
      var s51 = section("By situation");
      var dRows = catOrder.map(function (k) { return effCells(k, byCat[k], DN, dMax, { def: 1 }); });
      dRows.push({ cls: "sx-tot", cells: effCells("Total", DP, DN, dMax, { def: 1 }).cells });
      s51.appendChild(table(effHead("Situation"), dRows));
      gDF.appendChild(s51);

      var pnrL = DP.filter(function (q) { return q.pnr; });
      if (pnrL.length) {
        var s52 = section("Pick and roll only");
        var byP = {}, pOrder = [];
        pnrL.forEach(function (q) { if (!byP[q.label]) { byP[q.label] = []; pOrder.push(q.label); } byP[q.label].push(q); });
        pOrder.sort(function (a, b) { return byP[b].length - byP[a].length; });
        var pMax = byP[pOrder[0]].length || 1;
        s52.appendChild(table(effHead("P&R situation", "% P&R"),
          pOrder.map(function (k) { return effCells(k, byP[k], pnrL.length, pMax, { def: 1 }); })));
        gDF.appendChild(s52);
      }

      /* the coverage twice: the half court ball screens, and the transition ones (drag PnR)
         apart - a drag in the open floor is met with a defense of its own */
      var isDrag = function (q) { return /drag|transition/i.test(String(q.first || "")); };
      [["By coverage · half court", DP.filter(function (q) { return !isDrag(q); })],
       ["By coverage · transition (drag PnR)", DP.filter(isDrag)]].forEach(function (pair) {
        var covRows = [], covSeen = 0;
        COVERAGE.forEach(function (c) {
          var l = pair[1].filter(function (q) {
            return c.marks.some(function (m) { return has(q.tags, m); });
          });
          if (l.length) { covRows.push({ c: c, l: l }); covSeen += l.length; }
        });
        if (!covRows.length) return;
        covRows.sort(function (a, b) { return b.l.length - a.l.length; });
        var cMax = covRows[0].l.length || 1;
        /* RED and HEDGE are one coverage, and so are SWITCH and BLACK */
        var s53 = section(pair[0]);
        s53.appendChild(table(effHead("Coverage", "% cov"),
          covRows.map(function (r) { return effCells(r.c.k, r.l, covSeen, cMax, { def: 1 }); })));
        gDF.appendChild(s53);
      });
    }
    box.appendChild(gDF);

    /* 06 PLAY TYPES is gone. It read fifteen fixed phrases out of the descriptors -
       "PnR Ball Handler", "Spot Up", "Post Up" and the rest - and counted a possession
       once for each phrase it carried, so its rows added up to more than the game and
       its percentages were over a different denominator from every other table in the
       block. What it found depended entirely on whoever tagged writing those words
       exactly, and the same question is answered from the tagging's own categories in
       Efficiency, by family and by set. playAgg and PLAYTYPES stay in the model: the
       marks are still parsed, and nothing in the block draws them. */

    /* ------------------------------ each category, drawn before its tables
       The tables answer a question once it has been asked; what was missing was the
       answer itself at the top of each block - the rate, what it is worth, and how it
       moved through the game - drawn with the same parts as every other summary. */
    (function () {
      var K = (typeof window !== "undefined") && window.UIKit;
      if (!K || !K.strip) return;
      var put = function (g, o) {
        try { o.cls = "sx-cathead fit-span"; var c = K.summary(o); g.insertBefore(c, g.children[1] || null); } catch (e) { }
      };
      var rate = function (list, key) {
        var m = list.filter(function (q) { return q.phase === "Fastbreak" || (q[key] || 0) > 0; }).length;
        return list.length ? 100 * m / list.length : 0;
      };
      var grade = function (v) { return v >= 70 ? "good" : v >= 60 ? "neutral" : "bad"; };
      var vs = function (v) { return v == null ? "neutral" : v >= anchor + 0.05 ? "good" : v <= anchor - 0.05 ? "bad" : "neutral"; };
      var qStrip = function (key, title, graded) {
        if (byQ.length < 2) return null;
        return K.strip({ title: title, sub: "share of possessions, by quarter", items: byQ.map(function (it) {
          var v = rate(it.list, key);
          return { label: it.label, value: v, text: Math.round(v) + "%", tone: graded ? grade(v) : "vol" }; }) });
      };
      var worth = function (key, title) {
        var it = [0, 1, 2].map(function (k) {
          var g = P.filter(function (q) { return k < 2 ? (q[key] || 0) === k : (q[key] || 0) >= 2; });
          var s = shotLine(g);
          return g.length ? { label: (k === 2 ? "2+" : String(k)) + " · " + g.length + " poss", value: s.ppp || 0, text: f2(s.ppp), tone: vs(s.ppp) } : null;
        }).filter(Boolean);
        return it.length >= 2 ? K.strip({ title: title, sub: "points per possession by how many", items: it }) : null;
      };
      var pair = function (key) {
        return [shotLine(P.filter(function (q) { return (q[key] || 0) > 0; })), shotLine(P.filter(function (q) { return (q[key] || 0) === 0; }))];
      };
      var ptR = rate(P, "pt"), brR = rate(P, "br"), pp = pair("pt"), bb = pair("br");
      put(gPT, { figures: [
        { label: "Paint touch rate", value: Math.round(ptR) + "%", note: "target 70% · fastbreaks count whole", tone: grade(ptR), scale: { lo: 0, hi: 100, v: ptR, ref: 70 } },
        { label: "PPP with a paint touch", value: f2(pp[0].ppp), note: pp[0].n + " possessions", tone: vs(pp[0].ppp) },
        { label: "PPP without", value: f2(pp[1].ppp), note: pp[1].n + " possessions", tone: vs(pp[1].ppp) },
        { label: "Game PPP", value: f2(anchor), note: N + " possessions", tone: "vol" }],
        visuals: [qStrip("pt", "Paint touch rate", true), worth("pt", "What a paint touch is worth")] });
      put(gBR, { figures: [
        { label: "Ball reversal rate", value: Math.round(brR) + "%", note: "fastbreaks count whole", tone: "vol", scale: { lo: 0, hi: 100, v: brR } },
        { label: "PPP with a reversal", value: f2(bb[0].ppp), note: bb[0].n + " possessions", tone: vs(bb[0].ppp) },
        { label: "PPP without", value: f2(bb[1].ppp), note: bb[1].n + " possessions", tone: vs(bb[1].ppp) }],
        visuals: [qStrip("br", "Ball reversal rate", false), worth("br", "What a reversal is worth")] });
      put(gEF, { figures: [
        { label: "Points per possession", value: f2(all.ppp), note: all.pts + " points · " + N + " possessions", tone: "vol" },
        { label: "Field goals", value: all.fgm + "/" + all.fga, note: pct(all.fgm, all.fga) + " · " + all.t3a + " threes taken", tone: "vol" },
        { label: "Turnovers", value: all.tov, note: pct(all.tov, N) + " of possessions", tone: "vol" },
        { label: "Offensive rebounds", value: orebOf(P), note: "possessions extended", tone: "vol" }],
        visuals: [
          byPhase.length >= 2 ? K.split({ title: "Our possessions by phase", sub: "share · points per possession",
            parts: byPhase.map(function (it) { var s = shotLine(it.list); return { label: it.label, share: it.list.length / N, value: f2(s.ppp), tone: vs(s.ppp) }; }) }) : null,
          byQ.length >= 2 ? K.strip({ title: "Points per possession", sub: "by quarter", items: byQ.map(function (it) { var s = shotLine(it.list);
            return { label: it.label, value: s.ppp || 0, text: f2(s.ppp), tone: vs(s.ppp) }; }) }) : null] });
      var tdP = function (o) { return o && o.n ? o.pts / o.n : null; };
      var tdT = function (v) { return v == null ? "neutral" : v <= 0.9 ? "good" : v >= 1.15 ? "bad" : "neutral"; };
      put(gTD, { figures: [
        { label: "TAG · after a long shot", value: f2(tdP(TD.tag)), note: (TD.tag.pts || 0) + " conceded in " + (TD.tag.n || 0) + " situations", tone: tdT(tdP(TD.tag)) },
        { label: "BACK · after a miss at the rim or a turnover", value: f2(tdP(TD.back)), note: (TD.back.pts || 0) + " conceded in " + (TD.back.n || 0) + " situations", tone: tdT(tdP(TD.back)) }] });
      if (DN) {
        var dAll = shotLine(DP), cats = Object.keys(byCat || {}).sort(function (a, b) { return byCat[b].length - byCat[a].length; });
        var head = cats.slice(0, 6), restN = 0; cats.slice(6).forEach(function (k) { restN += byCat[k].length; });
        var parts = head.map(function (k) { var s = shotLine(byCat[k]);
          return { label: k, share: byCat[k].length / DN, value: f2(s.ppp), tone: s.ppp == null ? "neutral" : s.ppp <= dAll.ppp - 0.08 ? "good" : s.ppp >= dAll.ppp + 0.08 ? "bad" : "neutral" }; });
        if (restN) parts.push({ label: "Other (" + (cats.length - 6) + ")", share: restN / DN });
        put(gDF, { figures: [
          { label: "Points allowed per possession", value: f2(dAll.ppp), note: dAll.pts + " points · " + DN + " possessions defended", tone: tdT(dAll.ppp) },
          { label: "Their field goals", value: dAll.fgm + "/" + dAll.fga, note: pct(dAll.fgm, dAll.fga), tone: "vol" },
          { label: "Turnovers forced", value: dAll.tov, note: pct(dAll.tov, DN) + " of what we defended", tone: "vol" }],
          visuals: [parts.length >= 2 ? K.split({ title: "What we defended", sub: "share · points allowed", parts: parts }) : null] });
      }
    })();

    /* ---------------------------------------------------------- the menu */
    /* the post game's own tab bar can choose the category from outside the block */
    var cat = (typeof window !== "undefined" && window.__postCat && window.__postCat !== "ov" && window.__postCat !== "pbp") ? window.__postCat : "pt";
    function apply() {
      box.querySelectorAll(".sx-cat").forEach(function (g) {
        g.classList.toggle("hide", cat !== "all" && g.dataset.g !== cat);
      });
    }
    [["pt", "Paint touches"], ["br", "Ball reversals"], ["eff", "Efficiency"],
     ["td", "Transition D"], ["def", "What we concede"], ["all", "Everything"]]
      .forEach(function (t) {
        var b = el("button", "sx-tab" + (t[0] === cat ? " on" : ""), t[1]);
        b.addEventListener("click", function () {
          cat = t[0];
          menu.querySelectorAll(".sx-tab").forEach(function (x) { x.classList.remove("on"); });
          b.classList.add("on");
          apply();
        });
        b.dataset.cat = t[0];
        menu.appendChild(b);
      });
    apply();
    box.__setCat = function (c) {
      cat = c;
      menu.querySelectorAll(".sx-tab").forEach(function (x) { x.classList.toggle("on", x.dataset.cat === c); });
      apply();
    };

    box.appendChild(legend());
    var foot = el("div", "sx-foot");
    foot.appendChild(el("span", null, model.clips + " offensive clips \u2192 " + N + " possessions"));
    box.appendChild(foot);

    root.appendChild(box);
  }

  /* ---------------------------------------------------------------- hooks */

  /* A whole block still on its way is not a line of grey text: it is the shape of what is
     coming, shimmering, with the page's own small spinner and the reason above it. The
     heavy animation belongs to the splash; this is the quiet version of it. */
  function loadingBox(txt) {
    var box = el("div", "sx-loading");
    var ld = el("div", "ld", txt); ld.appendChild(el("span", "ld-bar")); box.appendChild(ld);
    var sk = el("div", "ld-skel");
    for (var i = 0; i < 5; i++) sk.appendChild(el("i"));
    box.appendChild(sk);
    return box;
  }
  function mount(host, run) {
    var box = el("div", "sx");
    box.appendChild(loadingBox("Loading the tagging from Drive…"));
    host.replaceWith(box);
    run(box).catch(function (e) {
      box.innerHTML = "";
      box.appendChild(el("div", "sx-err", "Could not load the stats: " + (e && e.message ? e.message : e)));
      box.appendChild(el("div", "sx-sub", "The folders have to be shared as “Anyone with the link · Viewer”. If they are and this persists, set GDRIVE_API_KEY on the site and redeploy."));
    });
  }

  // The app keeps its state inside a closure, so state.ui.ts is not reachable.
  // The training header prints the date with toLocaleDateString in the page locale:
  // rebuild the ISO from the day number, the localised month name and the year.
  function monthIndex(text) {
    var low = (text || "").toLowerCase();
    for (var m = 0; m < 12; m++) {
      var name = new Date(2020, m, 15).toLocaleDateString("en-GB", { month: "long" }).toLowerCase();
      if (name && low.indexOf(name) >= 0) return m;
    }
    return -1;
  }

  function dateFromHeader() {
    var hd = document.querySelector("#viewTeamScout .week-label");
    var txt = hd ? hd.textContent : "";
    var iso = /(\d{4}-\d{2}-\d{2})/.exec(txt);
    if (iso) return iso[1];
    var m = monthIndex(txt);
    var day = /(?:^|[^\d])(\d{1,2})(?:[^\d]|$)/.exec(txt);
    var year = /(20\d{2})/.exec(txt);
    if (m < 0 || !day || !year) return null;
    var d = new Date(+year[1], m, +day[1], 12);
    return d.toISOString().slice(0, 10);
  }

  function hookTraining(host) {
    var scopeEl = document.querySelector("#viewTeamScout .scope-tab.active");
    var scopeLabel = scopeEl ? scopeEl.textContent.trim().toLowerCase() : "this session";
    var scope = /week/.test(scopeLabel) ? "week"
      : /month/.test(scopeLabel) ? "month"
        : /season/.test(scopeLabel) ? "season" : "session";
    var iso = dateFromHeader();

    mount(host, function (box) {
      return listFolder("practice").then(function (files) {
        var dated = files.map(function (f) { return { f: f, d: fileDate(f.name) }; })
          .filter(function (x) { return x.d; })
          .sort(function (a, b) { return a.d < b.d ? -1 : 1; });

        var picked;
        if (scope === "session") {
          picked = iso ? dated.filter(function (x) { return x.d === iso; }) : [];
        } else {
          var r = rangeFor(scope, iso || (dated.length ? dated[dated.length - 1].d : ""));
          picked = dated.filter(function (x) { return x.d >= r[0] && x.d <= r[1]; });
        }

        if (!picked.length) {
          box.innerHTML = "";
          box.appendChild(el("div", "sx-empty", "No tagging file for this " + scope + "."));
          return;
        }

        /* the sessions picked, and the last ten up to the last of them for the one-look table */
        var lastD = picked[picked.length - 1].d;
        var ten = dated.filter(function (x) { return x.d <= lastD; }).slice(-10);
        var load = function (x) { return getRows(x.f.id).then(function (rows) { var m = buildPractice(rows); m.label = x.d; return m; }); };
        return Promise.all([Promise.all(picked.map(load)), Promise.all(ten.map(function (x) { return load(x).catch(function () { return null; }); }))]).then(function (both) {
          var sets = both[0], recent = both[1].filter(Boolean);
          var label = scope === "session" ? iso : (picked[0].d + " → " + picked[picked.length - 1].d);
          renderPractice(box, sets, label, recent);
        });
      });
    });
  }

  /* The written post-game report mounts its own block through this — nothing
     here scans the DOM, so the block appears once, where the report puts it. */
  function mountPostTeam(host, opponent, date) {
    host.innerHTML = "";
    var box = el("div", "sx sx-postwrap");
    box.appendChild(loadingBox("Loading the tagging from Drive…"));
    host.appendChild(box);
    return listFolder("game").then(function (files) {
      var f = findGameFile(files, opponent, date);
      if (!f) {
        box.innerHTML = "";
        box.appendChild(el("div", "sx-empty", "No tagging file for this game in the Drive folder yet."));
        return;
      }
      return getRows(f.id).then(function (rows) {
        renderPostTeam(box, buildGame(rows), f.name.replace(/\.csv$/i, ""));
      });
    }).catch(function (e) {
      box.innerHTML = "";
      box.appendChild(el("div", "sx-err", "Could not load the tagging: " + (e && e.message ? e.message : e)));
      box.appendChild(el("div", "sx-sub", "The game folder has to be shared as \u201cAnyone with the link \u00b7 Viewer\u201d."));
    });
  }

  /* THE SAME GAME, AS NUMBERS AND NOT AS A PAGE. The overview at the top of a post game
     reads the tagging beside the league's play by play, so it needs the possessions and
     not the tables drawn from them. Nothing is fetched twice: the folder list and the
     file are the ones the Team stats block reads. Null when the game has no file yet. */
  function gameModel(opponent, date) {
    return listFolder("game").then(function (files) {
      var f = findGameFile(files, opponent, date);
      if (!f) return null;
      return getRows(f.id).then(function (rows) {
        return { model: buildGame(rows), name: f.name.replace(/\.csv$/i, "") };
      });
    });
  }

  /* ==================================================================
     TRENDS & COMPARISON — every training and every game in one place.
     Season / month / week, and any two ranges side by side.
     ================================================================== */

  /* One compact row of parameters per file, whatever the source. */
  function summarise(model) {
    var P = model.poss;
    var s = shotLine(P);
    var ptP = 0, brP = 0, orebP = 0, ptTot = 0, brTot = 0;
    var fb = 0, ptRest = 0, brRest = 0, phased = false;
    P.forEach(function (q) {
      if (q.pt > 0) ptP++;
      if ((q.br || 0) > 0) brP++;
      if (q.oreb > 0) orebP++;
      ptTot += q.pt || 0;
      brTot += q.br || 0;
      if (q.phase) {
        phased = true;
        if (q.phase === "Fastbreak") fb++;
        else { if (q.pt > 0) ptRest++; if ((q.br || 0) > 0) brRest++; }
      }
    });
    return {
      kind: model.kind, poss: P.length, pts: s.pts, ppp: s.ppp,
      ptP: ptP, brP: brP, orebP: orebP, ptTot: ptTot, brTot: brTot,
      /* the 70% target needs the phases, so it exists for games only */
      phased: phased, fb: fb, ptRest: ptRest, brRest: brRest,
      fgm: s.fgm, fga: s.fga, t2a: s.t2a, t3a: s.t3a, fta: s.fta, tov: s.tov,
      oppPts: model.oppPts != null ? model.oppPts : null
    };
  }
  function addUp(list) {
    if (!list.length) return null;
    var o = { kind: list[0].kind, poss: 0, pts: 0, ptP: 0, brP: 0, orebP: 0, ptTot: 0, brTot: 0,
      fb: 0, ptRest: 0, brRest: 0, fgm: 0, fga: 0, t2a: 0, t3a: 0, fta: 0, tov: 0, oppPts: 0, files: list.length };
    o.phased = list.some(function (x) { return x.phased; });
    list.forEach(function (x) {
      ["poss", "pts", "ptP", "brP", "orebP", "ptTot", "brTot", "fb", "ptRest", "brRest", "fgm", "fga", "t2a", "t3a", "fta", "tov"]
        .forEach(function (k) { o[k] += x[k] || 0; });
      o.oppPts += x.oppPts || 0;
    });
    o.ppp = o.poss ? o.pts / o.poss : null;
    return o;
  }

  /* ---- ranges ---------------------------------------------------------- */
  /* Game-to-game microcycles when every game file carries its date in the
     name; plain Mon–Sun weeks otherwise. The view says which one it used. */
  function buildRanges(practice, games) {
    var gameDates = games.map(function (g) { return g.d; }).filter(Boolean).sort();
    var allDates = practice.map(function (p) { return p.d; }).concat(gameDates).filter(Boolean).sort();
    if (!allDates.length) return { months: [], weeks: [], mode: "none" };

    var months = [];
    allDates.forEach(function (d) { var m = d.slice(0, 7); if (months.indexOf(m) < 0) months.push(m); });

    var weeks = [], mode;
    if (gameDates.length >= 2 && gameDates.length === games.length) {
      mode = "game-to-game";
      var prev = allDates[0];
      gameDates.forEach(function (gd, i) {
        weeks.push({ from: prev, to: gd, label: (i === 0 ? "Start" : "after " + prev) + " → " + gd });
        prev = nextDay(gd);
      });
      if (prev <= allDates[allDates.length - 1])
        weeks.push({ from: prev, to: allDates[allDates.length - 1], label: prev + " → today (no game yet)" });
      weeks.forEach(function (w, i) { w.label = "W" + (i + 1) + " · " + w.from + " → " + w.to; });
    } else {
      mode = "calendar";
      var seen = {};
      allDates.forEach(function (d) {
        var r = rangeFor("week", d);
        if (seen[r[0]]) return;
        seen[r[0]] = 1;
        weeks.push({ from: r[0], to: r[1], label: r[0] + " → " + r[1] });
      });
      weeks.sort(function (a, b) { return a.from < b.from ? -1 : 1; });
    }
    return { months: months, weeks: weeks, mode: mode, first: allDates[0], last: allDates[allDates.length - 1] };
  }
  function nextDay(iso) {
    var d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  function monthLabel(m) {
    var d = new Date(m + "-15T12:00:00");
    return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }

  /* ---- little chart ---------------------------------------------------- */
  /* One bar per session, in date order. No library: a div per row. */
  function trendChart(title, sub, rows, fmt, ref) {
    var wrap = el("div", "sx-sec");
    wrap.appendChild(el("div", "sx-h", title));
    if (!rows.length) { wrap.appendChild(el("div", "sx-empty", "Nothing in this range.")); return wrap; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.v || 0; })) || 1;
    if (ref != null && ref > max) max = ref;
    var box = el("div", "cmp-chart");
    rows.forEach(function (r) {
      var row = el("div", "cmp-row" + (r.kind === "game" ? " game" : ""));
      row.appendChild(el("div", "cmp-lab", r.label));
      var track = el("div", "cmp-track");
      if (ref != null) { var rf = el("div", "cmp-ref"); rf.style.left = (100 * ref / max) + "%"; track.appendChild(rf); }
      var fill = el("div", "cmp-fill " + (r.step || ""));
      fill.style.width = Math.max(2, Math.round(100 * (r.v || 0) / max)) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("div", "cmp-val", fmt(r)));
      box.appendChild(row);
    });
    wrap.appendChild(box);
    return wrap;
  }

  /* ==================================================================
     TIMELINE — sessions and games in one chronological line, dots and
     lines, one panel per unit. Never two scales on one plot: the shares
     live on a 0-100 panel with the 70% rule, the per-possession rates on
     their own, points per possession on its own.
     ================================================================== */

  var NS = "http://www.w3.org/2000/svg";
  function sv(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  /* Round tick values, not max/4 — an axis reading 0.38 / 0.75 / 1.13 is noise.
     Returns the step and the top, both landing on 1, 2, 2.5 or 5 x 10^k. */
  function niceScale(v, wantTicks) {
    if (!isFinite(v) || v <= 0) return { max: 1, step: 0.25 };
    var raw = v / (wantTicks || 4);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / mag;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    return { max: Math.ceil(v / step) * step, step: step };
  }
  function shortDate(iso) {
    if (!iso) return "";
    var p = iso.split("-");
    return p.length === 3 ? p[2] + "/" + p[1] : iso;
  }

  /* points: [{d, label, kind, s}]  ·  series: [{name, color, get(s), fmt(v)}] */
  function timelineChart(title, sub, points, series, opts) {
    opts = opts || {};
    var wrap = el("div", "sx-sec tl");
    wrap.appendChild(el("div", "sx-h", title));
    if (!points.length) { wrap.appendChild(el("div", "sx-empty", "Nothing in this range.")); return wrap; }

    /* legend — always present for two series or more, identity never colour alone */
    if (series.length > 1) {
      var lg = el("div", "tl-legend");
      series.forEach(function (s) {
        var it = el("span", "tl-lg");
        var sw = el("span", "tl-lgk" + (s.dash ? " dash" : "")); sw.style.background = s.color;
        if (s.dash) { sw.style.background = "none"; sw.style.borderTop = "3px dashed " + s.color; }
        it.appendChild(sw); it.appendChild(el("span", null, s.name));
        lg.appendChild(it);
      });
      /* a chart of games only has no training on it, and saying "training · game" under
         one is a small lie printed in the legend */
      if (opts.under) {
        var ul2 = el("span", "tl-lg");
        var uk = el("span", "tl-lgk"); uk.style.background = opts.under.color || "var(--tl-1)";
        ul2.appendChild(uk); ul2.appendChild(el("span", null, opts.under.name + " (band below)"));
        lg.appendChild(ul2);
      }
      if (opts.kinds !== false) {
        var km = el("span", "tl-lg tl-lgkind");
        km.appendChild(el("span", "tl-lgshape circle"));
        km.appendChild(el("span", null, "training"));
        km.appendChild(el("span", "tl-lgshape diamond"));
        km.appendChild(el("span", null, "game"));
        lg.appendChild(km);
      }
      wrap.appendChild(lg);
    }

    var host = el("div", "tl-host");
    wrap.appendChild(host);
    var tip = el("div", "tl-tip"); tip.style.display = "none";
    host.appendChild(tip);

    function paint() {
      var old = host.querySelector("svg"); if (old) old.remove();
      var W = Math.max(320, host.clientWidth || 640);
      var padL = 44, padR = 74, padT = 12, padB = 30;
      /* ---------------------------------------------------------- the lower band
         A second measure on a different scale cannot go on this axis: the percentage
         runs to a hundred and the rating sits around one, so one y-axis flattens the
         rating into the floor and two y-axes invent whatever correlation the scales
         happen to line up as. It gets a band of its own under the plot, sharing the
         same dates: the columns line up, so a night can be read down - 76% there, and
         what it scored right below it - and nothing already on the chart moves. */
      var UND = opts.under || null;
      var undH = UND ? (UND.height || 58) : 0, undGap = UND ? 26 : 0;
      var H = (opts.height || 190) + undH + undGap;
      var iw = W - padL - padR, ih = H - padT - padB - undH - undGap;
      var uTop = padT + ih + undGap, uBot = uTop + undH;
      var plotBot = UND ? uBot : padT + ih;

      /* A DAY BUILT ON TWO POSSESSIONS IS NOT A DAY'S DEFENCE.
         A rate per possession over one or two possessions can only come out as 0, 1.5 or
         3, so a line drawn through every day was mostly a drawing of how few possessions
         there were: a spike to 3.00 was one three conceded, a floor of 0.00 was two stops.
         A series that says how many possessions each point stands on (s.n) is drawn in
         two layers. The LINE is the last few sessions added together - points over
         possessions, not an average of averages - so one play cannot move it. The DOTS
         are still each day, but a day under the minimum is small and pale, is not joined
         to anything, and does not stretch the axis. */
      var MINN = opts.minN || 0, ROLLW = opts.rollWindow || 5;
      var thinAt = function (s, p) { return !!(MINN && s.n && (s.n(p.s) || 0) < MINN); };
      var rollOf = function (s) {
        if (!s.roll) return null;
        return points.map(function (p, i) {
          var num = 0, den = 0;
          for (var k = Math.max(0, i - ROLLW + 1); k <= i; k++) { var r = s.roll(points[k].s) || [0, 0]; num += r[0] || 0; den += r[1] || 0; }
          return (den >= Math.max(1, MINN)) ? num / den : NaN;
        });
      };
      var vals = [];
      points.forEach(function (p) { series.forEach(function (s) { var v = s.get(p.s); if (isFinite(v) && !thinAt(s, p)) vals.push(v); }); });
      series.forEach(function (s) { (rollOf(s) || []).forEach(function (v) { if (isFinite(v)) vals.push(v); }); });
      var peak = Math.max.apply(null, vals.concat(opts.ref ? [opts.ref.v] : [0]));
      var sc = opts.max != null ? { max: opts.max, step: opts.max / 4 } : niceScale(peak * 1.08, 4);
      var max = sc.max;
      var n = points.length;
      var X = function (i) { return padL + (n === 1 ? iw / 2 : iw * i / (n - 1)); };
      var Y = function (v) { return padT + ih - (Math.max(0, Math.min(v, max)) / max) * ih; };

      var svg = sv("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, class: "tl-svg", role: "img" });
      var refLabel = null, refY = null;

      /* grid — solid hairlines, one shade off the surface */
      var ticks = Math.round(max / sc.step);
      for (var t = 0; t <= ticks; t++) {
        var v = sc.step * t, y = Y(v);
        svg.appendChild(sv("line", { x1: padL, x2: padL + iw, y1: y, y2: y, class: "tl-grid" }));
        var lab = sv("text", { x: padL - 8, y: y + 3.5, class: "tl-axis", "text-anchor": "end" });
        lab.textContent = opts.axisFmt ? opts.axisFmt(v) : String(Math.round(v));
        svg.appendChild(lab);
      }

      /* the 70% rule, when this panel has one */
      if (opts.ref) {
        var ry = Y(opts.ref.v);
        svg.appendChild(sv("line", { x1: padL, x2: padL + iw, y1: ry, y2: ry, class: "tl-ref" }));
        refY = ry;   /* the label itself is drawn after the series, on top of them */
      }

      /* softer bands under the main rule, the same 60 / 65 the gauge uses */
      (opts.bands || []).forEach(function (b) {
        var by = Y(b.v);
        svg.appendChild(sv("line", { x1: padL, x2: padL + iw, y1: by, y2: by, class: "tl-band" }));
        var bl = sv("text", { x: W - 2, y: by + 3.5, class: "tl-bandlab", "text-anchor": "end" });
        bl.textContent = b.label;
        svg.appendChild(bl);
      });

      /* a faint upright at every game, so the eye finds them down the row */
      points.forEach(function (p, i) {
        if (p.kind !== "game") return;
        svg.appendChild(sv("line", { x1: X(i), x2: X(i), y1: padT, y2: plotBot, class: "tl-gameline" }));
      });

      /* one line per series, then its markers on top */
      var ends = [];
      series.forEach(function (s) {
        var pts = points.map(function (p, i) { var v = s.get(p.s); return isFinite(v) ? [X(i), Y(v), v, i, thinAt(s, p)] : null; });
        /* what the line runs through: the sessions added together when the series can be,
           otherwise the days themselves, leaving out the ones too thin to join */
        var rl = rollOf(s);
        var linePts = rl ? rl.map(function (v, i) { return isFinite(v) ? [X(i), Y(v), v, i] : null; })
                         : pts.map(function (q) { return (q && !q[4]) ? q : null; });
        var run = [], runs = [];
        linePts.forEach(function (q) { if (q) run.push(q); else { if (run.length) runs.push(run); run = []; } });
        if (run.length) runs.push(run);
        runs.forEach(function (r) {
          if (r.length < 2) return;
          var d = r.map(function (q, j) { return (j ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1); }).join(" ");
          var ln = sv("path", { d: d, class: "tl-line" + (s.dash ? " dash" : ""), stroke: s.color });
          svg.appendChild(ln);
        });
        pts.forEach(function (q, i) {
          if (!q) return;
          var kind = points[i].kind, m;
          if (kind === "game") {
            m = sv("rect", { x: q[0] - 5, y: q[1] - 5, width: 10, height: 10, transform: "rotate(45 " + q[0] + " " + q[1] + ")", class: "tl-mk", fill: s.color });
          } else {
            m = sv("circle", { cx: q[0], cy: q[1], r: 4.5, class: "tl-mk", fill: s.color });
          }
          if (s.hollow) { m.setAttribute("class", "tl-mk hollow"); m.style.fill = "var(--tl-surface)"; m.style.stroke = s.color; }
          /* a thin day: half the size and pale. Under a line of sessions added together,
             every day steps back a little, since the line is now what is being read */
          /* Under a line of sessions added together the days step right back: a day too
             thin to read is not drawn at all - pale dots pinned to the top and the bottom
             of the plot were the mess - a training is a small quiet dot, and a game keeps
             its diamond, because a game is the one day worth finding on the line. */
          if (q[4]) return;
          if (rl && kind !== "game") { m.setAttribute("r", 2.6); m.style.opacity = "0.38"; }
          svg.appendChild(m);
        });
        /* direct label at the end of the line — the relief the palette asks for */
        var last = null, lastSrc = rl ? linePts : pts;
        for (var i2 = lastSrc.length - 1; i2 >= 0; i2--) { if (lastSrc[i2] && !lastSrc[i2][4]) { last = lastSrc[i2]; break; } }
        if (!last) for (var i3 = pts.length - 1; i3 >= 0; i3--) { if (pts[i3]) { last = pts[i3]; break; } }
        if (last) ends.push({ x: last[0], y: last[1], txt: s.fmt ? s.fmt(last[2]) : String(Math.round(last[2])) });
      });

      /* two series can finish on the same value — push the labels apart rather
         than printing one on top of the other */
      ends.sort(function (a, b) { return a.y - b.y; });
      for (var e = 1; e < ends.length; e++)
        if (ends[e].y - ends[e - 1].y < 12) ends[e].y = ends[e - 1].y + 12;
      ends.forEach(function (o) {
        var dl = sv("text", { x: o.x + 9, y: o.y + 3.5, class: "tl-dlab" });
        dl.textContent = o.txt;
        svg.appendChild(dl);
      });

      /* the rule label goes on last so no series line runs across it; it sits
         inside the plot because the right gutter belongs to the end labels */
      if (opts.ref && refY != null) {
        refLabel = sv("text", { x: padL + 6, y: refY - 5, class: "tl-reflab" });
        refLabel.textContent = opts.ref.label;
        svg.appendChild(refLabel);
      }

      /* ---- the band itself: its own scale, its own average, its own end label ---- */
      if (UND) {
        /* a hairline where one scale ends and the other begins, so the two are read as
           two and nobody measures the rating against the percentage axis */
        svg.appendChild(sv("line", { x1: padL - 10, x2: padL + iw, y1: uTop - 11, y2: uTop - 11,
          class: "tl-undrule" }));
        var uv2 = [];
        points.forEach(function (p) { var v = UND.get(p.s); if (isFinite(v)) uv2.push(v); });
        if (uv2.length) {
          var ulo = Math.min.apply(null, uv2), uhi = Math.max.apply(null, uv2);
          var upad = Math.max(0.04, (uhi - ulo) * 0.22);
          ulo = Math.max(0, ulo - upad); uhi = uhi + upad;
          if (uhi - ulo < 0.2) { uhi = ulo + 0.2; }
          var UY = function (v) { return uBot - (Math.max(ulo, Math.min(v, uhi)) - ulo) / (uhi - ulo) * undH; };
          var ucol = UND.color || "var(--tl-1)";
          /* a floor and a ceiling, labelled, so the band is a scale and not a squiggle */
          [ulo, uhi].forEach(function (v) {
            svg.appendChild(sv("line", { x1: padL, x2: padL + iw, y1: UY(v), y2: UY(v), class: "tl-grid" }));
            var ul = sv("text", { x: padL - 8, y: UY(v) + 3.5, class: "tl-axis", "text-anchor": "end" });
            ul.textContent = UND.fmt(v); svg.appendChild(ul);
          });
          /* the season average, which is the line a night is above or below */
          var uavg = uv2.reduce(function (a, v) { return a + v; }, 0) / uv2.length;
          svg.appendChild(sv("line", { x1: padL, x2: padL + iw, y1: UY(uavg), y2: UY(uavg),
            class: "tl-band" }));
          var uq = points.map(function (p, i) { var v = UND.get(p.s); return isFinite(v) ? [X(i), UY(v), v] : null; });
          var urun = [], uruns = [];
          uq.forEach(function (q) { if (q) urun.push(q); else { if (urun.length) uruns.push(urun); urun = []; } });
          if (urun.length) uruns.push(urun);
          uruns.forEach(function (r) {
            if (r.length < 2) return;
            svg.appendChild(sv("path", { d: r.map(function (q, j) {
              return (j ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1); }).join(" "),
              class: "tl-line", stroke: ucol }));
          });
          uq.forEach(function (q, i) {
            if (!q) return;
            var m = points[i].kind === "game"
              ? sv("rect", { x: q[0] - 4, y: q[1] - 4, width: 8, height: 8,
                  transform: "rotate(45 " + q[0] + " " + q[1] + ")", class: "tl-mk", fill: ucol })
              : sv("circle", { cx: q[0], cy: q[1], r: 3.6, class: "tl-mk", fill: ucol });
            svg.appendChild(m);
          });
          var ulast = null; for (var ui = uq.length - 1; ui >= 0; ui--) { if (uq[ui]) { ulast = uq[ui]; break; } }
          if (ulast) {
            var udl = sv("text", { x: ulast[0] + 9, y: ulast[1] + 3.5, class: "tl-dlab" });
            udl.textContent = UND.fmt(ulast[2]); svg.appendChild(udl);
          }
          /* and it says what it is, inside its own band */
          var unm = sv("text", { x: padL + 6, y: uTop + 11, class: "tl-undname" });
          unm.style.fill = ucol;
          unm.textContent = UND.name; svg.appendChild(unm);
        }
      }

      /* x axis — every label if they fit, otherwise thin them out, games always kept */
      var every = Math.ceil(n / Math.max(4, Math.floor(iw / 54)));
      points.forEach(function (p, i) {
        if (p.kind !== "game" && i % every !== 0 && i !== n - 1) return;
        var tx = sv("text", { x: X(i), y: plotBot + 16, class: "tl-axis" + (p.kind === "game" ? " game" : ""), "text-anchor": "middle" });
        tx.textContent = shortDate(p.d);
        svg.appendChild(tx);
      });

      /* hover: a crosshair and one tooltip carrying every series at that x */
      var cross = sv("line", { x1: 0, x2: 0, y1: padT, y2: plotBot, class: "tl-cross" });
      cross.style.display = "none";
      svg.appendChild(cross);
      var hit = sv("rect", { x: padL, y: padT, width: iw, height: plotBot - padT, fill: "transparent", class: "tl-hit" });
      svg.appendChild(hit);
      /* A point on this line is a day of work, and the question it raises - why was that
         one so low - is answered on that day's own sheet. So the point opens it. */
      if (window.LowenOpenDay) {
        hit.style.cursor = "pointer";
        hit.addEventListener("click", function (ev) {
          var p = points[at(ev)];
          if (p) try { window.LowenOpenDay(p.kind, p.d, p.label); } catch (e) {}
        });
      }

      function at(ev) {
        var r = svg.getBoundingClientRect();
        var px = (ev.clientX - r.left) * (W / r.width);
        var i = n === 1 ? 0 : Math.round((px - padL) / (iw / (n - 1)));
        return Math.max(0, Math.min(n - 1, i));
      }
      hit.addEventListener("mousemove", function (ev) {
        var i = at(ev), p = points[i];
        cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.style.display = "";
        var rows = series.map(function (s) {
          var v = s.get(p.s);
          return '<div class="tl-trow"><span class="tl-tk" style="background:' + s.color + '"></span>' +
            '<span class="tl-tn">' + s.name + '</span><span class="tl-tv">' +
            (isFinite(v) ? (s.fmt ? s.fmt(v) : Math.round(v)) : "—") +
            /* what the figure stands on, and a word when that is not enough to read */
            (s.n ? ' <i style="opacity:.6;font-style:normal">· ' + (s.n(p.s) || 0) + " poss" + (thinAt(s, p) ? ", too few" : "") + "</i>" : "") +
            "</span></div>";
        }).join("");
        if (UND) {
          var uv = UND.get(p.s);
          rows += '<div class="tl-trow"><span class="tl-tk" style="background:' + (UND.color || "var(--tl-1)") +
            '"></span><span class="tl-tn">' + UND.name + '</span><span class="tl-tv">' +
            (isFinite(uv) ? UND.fmt(uv) : "—") + "</span></div>";
        }
        tip.innerHTML = '<div class="tl-th">' + (p.kind === "game" ? "◆ " : "") + (p.label || p.d) + "</div>" + rows +
          /* a chart whose series carry their own possession counts says them on each line
             above; "no 5x5" belongs to the measures that need a count of the whole day */
          '<div class="tl-tf">' + (p.s.poss ? (p.s.poss + " possessions")
            : (series.some(function (s) { return !!s.n; }) ? (p.kind === "game" ? "game" : "training") : "no 5x5 \u2014 not counted")) +
          (window.LowenOpenDay ? " \u00b7 click to open it" : "") + "</div>";
        tip.style.display = "block";
        var rr = svg.getBoundingClientRect();
        var left = X(i) * (rr.width / W) + 12;
        if (left + tip.offsetWidth > rr.width) left = X(i) * (rr.width / W) - tip.offsetWidth - 12;
        tip.style.left = Math.max(0, left) + "px";
        tip.style.top = "6px";
      });
      hit.addEventListener("mouseleave", function () { cross.style.display = "none"; tip.style.display = "none"; });

      host.appendChild(svg);

      /* getBBox only measures once the node is in the page, so the backing that
         keeps a series line from running through the rule label goes on here */
      if (refLabel) {
        try {
          var bb = refLabel.getBBox();
          var bg = sv("rect", { x: bb.x - 3, y: bb.y - 1, width: bb.width + 6, height: bb.height + 2,
            rx: 3, class: "tl-reflab-bg" });
          svg.insertBefore(bg, refLabel);
        } catch (e) { }
      }
    }

    /* paint() needs a real width, and at build time the node is not in the page
       yet — so repaint whenever the host is measured or changes size. */
    paint();
    var lastW = 0, rt = null;
    if (window.ResizeObserver) {
      /* the first measure draws at once; after that a chart is redrawn when its box has
         stopped changing, not on every frame of a window being dragged */
      new ResizeObserver(function () {
        var w = host.clientWidth || 0;
        if (!w || Math.abs(w - lastW) <= 2) return;
        if (!lastW) { lastW = w; paint(); return; }
        clearTimeout(rt);
        rt = setTimeout(function () { var w2 = host.clientWidth || 0;
          if (w2 && Math.abs(w2 - lastW) > 2) { lastW = w2; paint(); } }, 180);
      }).observe(host);
    } else {
      requestAnimationFrame(paint);
      window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(paint, 160); });
    }
    return wrap;
  }

  /* the table view the light-mode contrast warning obliges */
  function timelineTable(points, series) {
    var head = ["Date", "Type", "Poss"].concat(series.map(function (s) { return s.name; }));
    var rows = points.map(function (p) {
      return [p.d, p.kind === "game" ? "Game" : "Training", p.s.poss].concat(
        series.map(function (s) { var v = s.get(p.s); return isFinite(v) ? (s.fmt ? s.fmt(v) : Math.round(v)) : "—"; }));
    });
    return table(head, rows);
  }

  /* ---- the panel ------------------------------------------------------- */
  function renderCompare(root, practiceSets, gameSets) {
    root.innerHTML = "";
    var R = buildRanges(practiceSets, gameSets.filter(function (x) { return !!x.d; }));
    var undated = gameSets.filter(function (x) { return !x.d; });
    var all = practiceSets.concat(gameSets.filter(function (x) { return !!x.d; }))
      .sort(function (a, b) { return a.d < b.d ? -1 : 1; });

    var state = { scope: "season", a: null, b: null };

    var head = el("div", "sx-sec");
    head.appendChild(el("div", "sx-h", "Trends & comparison"));
    head.appendChild(el("div", "sx-meta",
      practiceSets.length + " training \u00b7 " + gameSets.length + " game" +
      (R.first ? " \u00b7 " + R.first + " \u2192 " + R.last : "")));
    root.appendChild(head);

    var ctr = el("div", "cmp-ctr");
    var scopeSel = el("select", "cmp-sel");
    [["season", "Whole season"], ["month", "A month"], ["week", "A week"]].forEach(function (o) {
      var op = el("option", null, o[1]); op.value = o[0]; scopeSel.appendChild(op);
    });
    var aSel = el("select", "cmp-sel"), bSel = el("select", "cmp-sel");
    ctr.appendChild(el("span", "cmp-lbl", "Range"));
    ctr.appendChild(scopeSel);
    ctr.appendChild(aSel);
    ctr.appendChild(el("span", "cmp-lbl", "compare with"));
    ctr.appendChild(bSel);
    root.appendChild(ctr);

    var out = el("div", "cmp-out");
    root.appendChild(out);

    function options() {
      var list = [];
      if (state.scope === "season") list = [{ from: "1900-01-01", to: "2999-12-31", label: "Whole season" }];
      else if (state.scope === "month") list = R.months.map(function (m) {
        return { from: m + "-01", to: m + "-31", label: monthLabel(m) };
      });
      else list = R.weeks.slice();
      return list;
    }
    function fill(sel, list, withNone) {
      sel.innerHTML = "";
      if (withNone) { var n = el("option", null, "— nothing —"); n.value = "-1"; sel.appendChild(n); }
      list.forEach(function (x, i) { var o = el("option", null, x.label); o.value = String(i); sel.appendChild(o); });
      sel.disabled = list.length <= (withNone ? 0 : 1) && !withNone;
    }
    function inRange(x, r) { return x.d && x.d >= r.from && x.d <= r.to; }

    function draw() {
      var list = options();
      var A = list[Math.max(0, Math.min(list.length - 1, parseInt(aSel.value, 10) || 0))];
      var bi = parseInt(bSel.value, 10);
      var B = (bi >= 0 && list[bi]) ? list[bi] : null;
      out.innerHTML = "";

      /* one chart, its note, its button and its table — together, in that order */
      function unit(chart){ var u = el("div", "cmp-unit"); u.appendChild(chart); out.appendChild(u); return u; }

      var inA = all.filter(function (x) { return inRange(x, A); });
      if (undated.length) {
        /* the only note left in the block: it does not explain a number, it says
           which files are missing from it */
        var note = callout("Left out, no date in the name: " +
          undated.map(function (x) { return x.label; }).join(", "));
        note.className = (note.className ? note.className + " " : "") + "cmp-note";
        out.appendChild(note);
      }
      if (!inA.length) { out.appendChild(el("div", "sx-empty", "No tagged sessions or games in " + A.label + ".")); return; }

      /* the single-range summary table is gone; the block still earns its place
         when two ranges are set against each other, which is what it was for */
      if (B) out.appendChild(rangeBlock(A, inA, all.filter(function (x) { return inRange(x, B); }), B));

      /* the timeline — trainings and games in one chronological row.
         Three panels sharing that row, one unit each: a share panel cannot carry
         a rate, and forcing them onto one axis would invent a correlation. */
      var C_PT = "var(--tl-1)", C_BR = "var(--tl-2)", C_3 = "var(--tl-3)";
      var tlPoints = inA.map(function (x) {
        return { d: x.d, kind: x.kind, label: (x.label || x.d), s: x.s };
      });

      /* ---- the 70% measure, on its own, first ---------------------------- */
      var pctF = function (v) { return Math.round(v) + "%"; };
      var targetSeries = [
        { name: "Games — measured", color: C_3,
          get: function (s) { return (s.phased && s.poss) ? 100 * (s.fb + s.ptRest) / s.poss : NaN; }, fmt: pctF },
        { name: "Trainings — floor, no fastbreak is credited", color: C_3, dash: true, hollow: true,
          get: function (s) { return (!s.phased && s.poss) ? 100 * s.ptP / s.poss : NaN; }, fmt: pctF }
      ];
      var anyPhased = inA.some(function (x) { return x.s.phased; });
      var u70 = unit(timelineChart("The 70% measure",
        "(fastbreaks + paint touches in every other phase) \u00f7 total possessions. " +
        "The practice tagging marks no phase, so a training credits no fastbreak and its figure is a floor — " +
        "the real number can only be higher. Mark transition in practice and the two become the same measure.",
        tlPoints, targetSeries,
        { max: 100, ref: { v: 70, label: "70% — target" },
          bands: [{ v: 65, label: "65" }, { v: 60, label: "60" }],
          axisFmt: pctF, height: 230 }));
      /* This used to be a bare `if (!anyPhased)` with nothing after it but a blank line,
         which made the next statement its body: with any phased game in the range the
         button was never created and the panel died on tgtBtn.addEventListener. The note
         it was meant to carry is here, and the button is unconditional again. */
      if (!anyPhased) u70.appendChild(el("div", "sx-sub",
        "No game in this range carries phase tags, so every figure above is the training floor."));

      var tgtBtn = el("button", "tl-tblbtn", "Show the 70% numbers and the rating as a table");
      var tgtBox = el("div"); tgtBox.style.display = "none";
      tgtBtn.addEventListener("click", function () {
        var on = tgtBox.style.display === "none";
        if (on && !tgtBox.childNodes.length) {
          /* The rating goes beside the measure here too. Reading that we got to 70%
             without reading what the night scored is half the story, and this table
             is the one a staff looks at after a game. */
          tgtBox.appendChild(table(["Date", "Type", "Poss", "Fastbreak", "Paint touch elsewhere",
              "The 70% measure", "OER", "Reading"],
            tlPoints.map(function (p) {
              var st = p.s, measured = st.phased;
              if (!st.poss) return [p.d, measured ? "Game" : "Training", 0,
                "no 5x5", "no 5x5", { v: "\u2014", cls: "" }, { v: "\u2014", cls: "" }, "not counted"];
              var v = measured ? 100 * (st.fb + st.ptRest) / st.poss : (st.poss ? 100 * st.ptP / st.poss : 0);
              var sh = Math.round(v);
              var oer = st.poss ? st.pts / st.poss : NaN;
              return [p.d, measured ? "Game" : "Training", st.poss,
                measured ? st.fb + " (" + pctF(100 * st.fb / st.poss) + ")" : "not tagged",
                (measured ? st.ptRest : st.ptP) + " (" + pctF(100 * (measured ? st.ptRest : st.ptP) / st.poss) + ")",
                { v: sh + "%", cls: "sx-vol " + volStep(sh) },
                isFinite(oer) ? { v: f2(oer), cls: "sx-cell " + pppStep(oer) }
                              : { v: "\u2014", cls: "" },
                measured ? (sh >= 70 ? "Perfect" : sh >= 65 ? "Ok" : sh >= 60 ? "Regular" : "Below") : "floor only"];
            })));
        }
        tgtBox.style.display = on ? "" : "none";
        tgtBtn.textContent = on ? "Hide the table" : "Show the 70% numbers and the rating as a table";
      });
      u70.appendChild(tgtBtn); u70.appendChild(tgtBox);

      /* ---- everything else, kept apart ----------------------------------- */
      out.appendChild(el("div", "sx-band", "Other trends"));

      var rateSeries = [
        { name: "Paint touches per possession (average)", color: C_PT, get: function (s) { return s.poss ? s.ptTot / s.poss : NaN; }, fmt: f2 },
        { name: "Ball reversals per possession (average)", color: C_BR, get: function (s) { return s.poss ? s.brTot / s.poss : NaN; }, fmt: f2 }
      ];
      var uRate = unit(timelineChart("Average per possession — how many there were",
        "Total paint touches divided by total possessions. 0.83 means 83 paint touches in 100 possessions. " +
        "Above 1.00 the average possession touched the paint more than once. The panel above asks whether it " +
        "happened; this one asks how often it happened inside the possession.",
        tlPoints, rateSeries, { axisFmt: f2, height: 170 }));

      /* A session with no possessions had no five on five in it - a shooting day, a walk
         through, a tagging that only carries drills. Its PPP is not zero, it is nothing,
         and drawing it as zero pulls the line to the floor and the average with it. The
         two rate panels above already skip it; this one did not. */
      var pppSeries = [{ name: "Points per possession", color: C_3,
        get: function (s) { return s.poss ? s.ppp : NaN; }, fmt: f2 }];
      var uPpp = unit(timelineChart("Points per possession", "", tlPoints, pppSeries, { axisFmt: f2, height: 150 }));

      var tblBtn = el("button", "tl-tblbtn", "Show the numbers as a table");
      var tblBox = el("div"); tblBox.style.display = "none";
      tblBtn.addEventListener("click", function () {
        var on = tblBox.style.display === "none";
        if (on && !tblBox.childNodes.length)
          tblBox.appendChild(timelineTable(tlPoints, rateSeries.concat(pppSeries)));
        tblBox.style.display = on ? "" : "none";
        tblBtn.textContent = on ? "Hide the table" : "Show the numbers as a table";
      });
      /* this one table carries both charts above it, so it hangs off the second */
      uPpp.appendChild(tblBtn); uPpp.appendChild(tblBox);

    }

    function rangeBlock(A, inA, inB, B) {
      var box = el("div", "sx-sec");
      box.appendChild(el("div", "sx-h", B ? A.label + "  vs  " + B.label : A.label));
      var kinds = [["practice", "Practice"], ["game", "Game"]];
      var head = ["", "Sessions", "Poss", "Pts", "PPP", "Paint touch", "Reversal", "OREB poss", "TOV"];
      if (B) head = ["", "Sessions", "Poss", "PPP", "Paint touch", "Reversal", "OREB poss"];
      var rows = [];
      kinds.forEach(function (k) {
        var a = addUp(inA.filter(function (x) { return x.kind === k[0]; }).map(function (x) { return x.s; }));
        if (!a && !(inB && addUp(inB.filter(function (x) { return x.kind === k[0]; }).map(function (x) { return x.s; })))) return;
        if (!B) {
          rows.push([k[1], a ? a.files : 0, a ? a.poss : 0, a ? a.pts : 0,
            { v: f2(a && a.ppp), cls: pppStep(a && a.ppp) },
            { v: a ? pct(a.ptP, a.poss) + " (" + a.ptP + ")" : "—", cls: a ? volStep(100 * a.ptP / (a.poss || 1)) : "" },
            { v: a ? pct(a.brP, a.poss) + " (" + a.brP + ")" : "—", cls: a ? volStep(100 * a.brP / (a.poss || 1)) : "" },
            a ? pct(a.orebP, a.poss) : "—", a ? a.tov : "—"]);
          return;
        }
        var b = addUp(inB.filter(function (x) { return x.kind === k[0]; }).map(function (x) { return x.s; }));
        var pair = function (av, bv, fmt) {
          if (av == null && bv == null) return "—";
          return (fmt ? fmt(av) : av) + "  →  " + (fmt ? fmt(bv) : bv);
        };
        var dl = function (av, bv, unit) {
          if (av == null || bv == null) return "";
          var d = bv - av;
          return "  (" + (d > 0 ? "+" : "") + (unit === "ppp" ? d.toFixed(2) : Math.round(d)) + (unit === "pct" ? "pp" : "") + ")";
        };
        var rateA = a && a.poss ? 100 * a.ptP / a.poss : null, rateB = b && b.poss ? 100 * b.ptP / b.poss : null;
        var brA = a && a.poss ? 100 * a.brP / a.poss : null, brB = b && b.poss ? 100 * b.brP / b.poss : null;
        var orA = a && a.poss ? 100 * a.orebP / a.poss : null, orB = b && b.poss ? 100 * b.orebP / b.poss : null;
        rows.push([k[1],
          pair(a ? a.files : 0, b ? b.files : 0),
          pair(a ? a.poss : 0, b ? b.poss : 0),
          { v: pair(a && a.ppp, b && b.ppp, f2) + dl(a && a.ppp, b && b.ppp, "ppp"), cls: cmpCls(a && a.ppp, b && b.ppp) },
          { v: pair(rateA, rateB, function (x) { return x == null ? "—" : Math.round(x) + "%"; }) + dl(rateA, rateB, "pct"), cls: cmpCls(rateA, rateB) },
          { v: pair(brA, brB, function (x) { return x == null ? "—" : Math.round(x) + "%"; }) + dl(brA, brB, "pct"), cls: cmpCls(brA, brB) },
          { v: pair(orA, orB, function (x) { return x == null ? "—" : Math.round(x) + "%"; }), cls: "" }
        ]);
      });
      if (!rows.length) { box.appendChild(el("div", "sx-empty", "Nothing tagged in this range.")); return box; }
      box.appendChild(table(head, rows));
      return box;
    }
    function cmpCls(a, b) {
      if (a == null || b == null) return "";
      if (b > a * 1.02) return "cmp-up";
      if (b < a * 0.98) return "cmp-down";
      return "cmp-flat";
    }

    scopeSel.addEventListener("change", function () {
      state.scope = scopeSel.value;
      var list = options();
      fill(aSel, list, false);
      fill(bSel, list, true);
      aSel.value = String(list.length - 1);
      bSel.value = "-1";
      draw();
    });
    aSel.addEventListener("change", draw);
    bSel.addEventListener("change", draw);

    var list0 = options();
    fill(aSel, list0, false); fill(bSel, list0, true);
    aSel.value = "0"; bSel.value = "-1";
    draw();
  }

  /* ====================================================================== */
  /*  THE TRENDS DASHBOARD                                                   */
  /*                                                                          */
  /*  Post game and post practice answer "what happened in this one". This    */
  /*  answers the other question: what is moving between one and the next.    */
  /*                                                                          */
  /*  TWO RULES ABOUT WHAT GOES IN, both of them the staff's: a day with no   */
  /*  training is not a day with a zero, and a training with no five-on-five  */
  /*  in it — a shooting day, a walk-through, a file that only carries drills */
  /*  — is not a training either. Both are dropped before anything is drawn,  */
  /*  because a zero in a trend line is a claim that we played badly, and     */
  /*  neither of those is that claim. What was dropped is said out loud, so   */
  /*  nobody reads a short line as a short season.                            */
  /* ====================================================================== */

  /* A GAME FILE WITH NO DATE IN ITS NAME IS STILL A GAME.
     "G8 BBL ROSTOCK" carries no date, and everything here is ordered by date, so those
     files were dropped on the floor — the trend line showed two games out of six and said
     nothing about the four it had quietly refused. The app already knows when every game
     was played: the fixture list. So the opponent is read out of the file name and matched
     against it, and the date comes from the fixture. Where that fails, the day Drive says
     the file was created is used, which is the day it was tagged — close, and marked as
     borrowed so nobody reads it as the day it was played. A file that gets neither is
     still left out, and still named. */
  function slugWord(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  /* ---------------------------------------------------- the calendar is the authority
     The app already keeps the season's fixture list - every date, every opponent - and
     it was only being consulted when a file name had no date of its own. That left two
     holes. A name with a date in it was never checked, so a typo in a file name moved a
     game on the chart; and a club we play twice (Rostock in August and again in
     September, Bamberg in September and again in November) always matched the first of
     the two, because a name on its own cannot say which meeting it was.

     So the calendar decides. When the name carries a date, that date is used to pick
     WHICH meeting the file is, and the fixture's own date is what the chart runs on.
     When it carries none, the fixture still names the day. Only when the calendar has
     nothing to say does the file name, and then the Drive, get a turn. */
  function fixtureList() {
    var G = [];
    try { G = (typeof window.LowenFixtures === "function" ? window.LowenFixtures() : null)
              || (window.state && window.state.games) || []; } catch (e) { G = []; }
    return (G || []).filter(function (g) { return g && g.date && g.opponent; })
      .slice().sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); })
      .map(function (g, i) { return { date: g.date, opponent: g.opponent,
        competition: g.competition, result: g.result, idx: i }; });
  }
  function fixtureHits(name) {
    var G = fixtureList();
    if (!G.length) return [];
    var n = slugWord(name), tail = slugWord((String(name).match(/[A-Za-z]{4,}/g) || []).slice(-1)[0] || "");
    var exact = G.filter(function (g) {
      var op = slugWord(g.opponent);
      if (op.length < 4) return false;
      /* the file says ROSTOCK and the fixture says "Rostock Seawolves" — either way round */
      return n.indexOf(op) >= 0 || op.indexOf(n.replace(/^g\d+/, "").slice(0, 12)) >= 0 ||
             (tail.length >= 4 && op.indexOf(tail) >= 0);
    });
    if (exact.length) return exact;
    /* THE SAME SLIP THAT HID THE FILE FROM ITS OWN REPORT HID IT FROM THE CALENDAR.
       "G10 BBL LUDWISGBURG.csv" carries no date, so the only thing that can say which
       night it is is the fixture against that club - and with two letters swapped it
       matched no club, got no date, and a file with no date is left out of every trend.
       A word of six letters or more that is one slip away from a word of the opponent's
       name is that opponent. */
    var toks = String(name || "").replace(/\.csv$/i, "").split(/[^A-Za-zÀ-ÿ]+/)
      .map(slugWord).filter(function (t) { return t.length >= 6; });
    if (!toks.length) return [];
    return G.filter(function (g) {
      return String(g.opponent || "").split(/\s+/).map(slugWord).some(function (w) {
        return w.length >= 6 && toks.some(function (t) { return oneSlip(t, w); });
      });
    });
  }
  /* two neighbouring letters swapped, or one letter wrong, missing or extra */
  function oneSlip(a, b) {
    var la = a.length, lb = b.length, i = 0;
    if (Math.abs(la - lb) > 1) return false;
    while (i < la && i < lb && a.charAt(i) === b.charAt(i)) i++;
    if (i === la && i === lb) return true;
    if (la === lb) return a.slice(i + 1) === b.slice(i + 1) ||
      (a.charAt(i) === b.charAt(i + 1) && a.charAt(i + 1) === b.charAt(i) && a.slice(i + 2) === b.slice(i + 2));
    var lg = la > lb ? a : b, sh = la > lb ? b : a;
    return lg.slice(i + 1) === sh.slice(i);
  }
  var FIX_NEAR_DAYS = 5;   /* a name's date and its fixture should not be a week apart */
  function daysApart(a, b) {
    return Math.abs(Date.parse(a + "T00:00:00") - Date.parse(b + "T00:00:00")) / 86400000;
  }
  function todayISO2() { return new Date().toISOString().slice(0, 10); }
  function playedFix(g) { return !!(g && (g.result || g.date <= todayISO2())); }

  function fixtureFor(name, near) {
    var hits = fixtureHits(name);
    if (!hits.length) return null;
    if (near) {
      var best = null, bd = 1e9;
      hits.forEach(function (g) { var dd = daysApart(g.date, near); if (dd < bd) { bd = dd; best = g; } });
      return (best && bd <= FIX_NEAR_DAYS) ? best : null;
    }
    /* A game already played is one with a result on it OR one whose day has passed.
       Only the result was being used, and it is an optional field that mostly stays
       empty, so every club we play twice matched the FIRST meeting of the season for
       ever. Only the date would be wrong the other way: a result typed in against a
       fixture whose date was never corrected is still a game that was played. */
    var done = hits.filter(function (g) { return playedFix(g); });
    return done.length ? done[done.length - 1] : hits[0];
  }
  function fixtureDate(name) { var g = fixtureFor(name, null); return g ? g.date : null; }

  /* ---------------------------------------------- ONE FILE, ONE GAME
     Dating each file on its own lets two of them land on the same night: two Rostock
     files with no date in either name both match the same fixture and sit on top of
     each other, and the order after them is wrong for the rest of the season.

     They are assigned together instead. Each file is placed on the nearest fixture
     against that club that no other file has taken, strongest evidence first - a date
     in the name is worth more than the day the file reached the Drive - so the pair
     sorts itself out even when neither name carries a date. */
  function assignGames(files) {
    var taken = {};
    var cand = files.map(function (f) {
      var dn = fileDate(f.name);
      var up = (f.createdTime || f.modifiedTime || "");
      up = /^\d{4}-\d{2}-\d{2}/.test(String(up)) ? String(up).slice(0, 10) : null;
      return { f: f, dn: dn, up: up, hits: fixtureHits(f.name),
               /* a date in the name is evidence; the upload day is a hint */
               rank: dn ? 0 : (up ? 1 : 2) };
    });
    cand.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      var ka = a.dn || a.up || "9999", kb = b.dn || b.up || "9999";
      return ka < kb ? -1 : (ka > kb ? 1 : (String(a.f.name) < String(b.f.name) ? -1 : 1));
    });
    var out = {};
    cand.forEach(function (c) {
      var anchor = c.dn || c.up;
      /* a file cannot belong to a night that has not been played */
      var free = c.hits.filter(function (g) { return !taken[g.idx] && playedFix(g); });
      if (!free.length) free = c.hits.filter(function (g) { return !taken[g.idx]; });
      var pick = null;
      if (free.length && anchor) {
        var bd = 1e9;
        free.forEach(function (g) { var dd = daysApart(g.date, anchor); if (dd < bd) { bd = dd; pick = g; } });
        /* a name's own date that lands nowhere near any fixture is left alone */
        if (c.dn && bd > FIX_NEAR_DAYS && pick) pick = null;
      } else if (free.length) {
        pick = free[free.length - 1];
      }
      if (pick) {
        taken[pick.idx] = 1;
        out[c.f.id] = { d: pick.date, opp: pick.opponent, idx: pick.idx,
                        how: (c.dn && c.dn === pick.date) ? "name" : "fixture" };
        return;
      }
      if (c.dn) { out[c.f.id] = { d: c.dn, how: "name", opp: null, idx: null }; return; }
      if (c.up) { out[c.f.id] = { d: c.up, how: "drive", opp: null, idx: null }; return; }
      out[c.f.id] = { d: null, how: null, opp: null, idx: null };
    });
    return out;
  }
  /* -> { d, how, opp, idx } ; how: "name" | "fixture" | "drive" | null
     idx is the game's place in the calendar, which settles the order when two land on
     the same day instead of leaving it to whichever file was read first. */
  function datedGame(f) {
    var dn = fileDate(f.name);
    var fx = fixtureFor(f.name, dn);
    if (fx) return { d: fx.date, opp: fx.opponent, idx: fx.idx,
      /* the name already said this day: nothing was borrowed */
      how: (dn && dn === fx.date) ? "name" : "fixture" };
    if (dn) return { d: dn, how: "name", opp: null, idx: null };
    var t = f.createdTime || f.modifiedTime;
    if (t && /^\d{4}-\d{2}-\d{2}/.test(String(t)))
      return { d: String(t).slice(0, 10), how: "drive", opp: null, idx: null };
    return { d: null, how: null, opp: null, idx: null };
  }

  /* least squares over the index, which is "per game" — the x axis of every
     projection here is the next game, not the next day */
  function linfit(ys) {
    var n = ys.length;
    if (n < 2) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0, i;
    for (i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
    var d = n * sxx - sx * sx;
    if (!d) return null;
    var b = (n * sxy - sx * sy) / d, a = (sy - b * sx) / n;
    /* how much of the movement the straight line actually explains: without it a
       projection off three scattered games reads as confidently as one off ten */
    var mean = sy / n, ssT = 0, ssR = 0;
    for (i = 0; i < n; i++) { ssT += (ys[i] - mean) * (ys[i] - mean);
      var e = ys[i] - (a + b * i); ssR += e * e; }
    return { a: a, b: b, n: n, r2: ssT ? Math.max(0, 1 - ssR / ssT) : 0, mean: mean,
             at: function (i) { return a + b * i; } };
  }
  function pct0(v) { return v == null || !isFinite(v) ? "—" : Math.round(v) + "%"; }

  /* the mark the pre-game report uses, in the same words: a star on what is worth
     walking into the room with, a warning on what is going the wrong way */
  function trFlag(kind, title) {
    var e = el("span", "tr-flag " + kind);
    e.textContent = kind === "good" ? "★" : kind === "up" ? "▲" : kind === "down" ? "▼" : "!";
    if (title) e.title = title;
    return e;
  }
  function trChip(kind, text, note) {
    var c = el("div", "tr-chip " + kind);
    c.appendChild(trFlag(kind === "warn" ? "warn" : kind === "down" ? "down" : kind === "up" ? "up" : "good"));
    c.appendChild(el("span", "tr-chip-t", text));
    if (note) c.appendChild(el("span", "tr-chip-n", note));
    return c;
  }

  /* ---- the five comparisons ------------------------------------------- */

  /* A table with a column per game is not a side panel. The page lays a section out in
     columns and shrinks a table to fit one of them, which left this one squeezed into half
     the width with the other half empty. Past six columns it asks for the whole line. */
  function trTable(head, rows, opts) {
    var w = table(head, rows, opts);
    if (head.length > 6) w.dataset.fitGrow = "1";
    return w;
  }

  /* The heading and its sentence are the section's title, not a panel beside the chart:
     the page's grid packs every child of a section into columns, which put the heading in
     one and the table in the other and left half the width empty. "fit-span" is that
     grid's own word for "this one is a line of its own". */
  function trSection(root, no, title, sub) {
    var w = el("div", "sx-sec tr-sec");
    var h = el("div", "tr-h fit-span");
    h.appendChild(el("span", "tr-no", no));
    h.appendChild(el("div", "sx-h", title));
    w.appendChild(h);
    if (sub) w.appendChild(el("div", "sx-sub fit-span", sub));
    root.appendChild(w);
    return w;
  }

  /*  THE SAME RULE THE REPORTS USE, AND NO OTHER.
      A post game and a post practice both judge the thing one way: a fastbreak counts
      whole, and in every other phase the possession counts when it carried the thing —
      over the possessions played. That is the 70% measure, and it is the rule the staff
      works to. This screen was answering a different question, touches divided by
      possessions, which is a real number and not the one anybody is trying to move. So
      the trend is the measure, for paint touches and for ball reversals alike.

      The practice tagging marks no phase, so a training credits no fastbreak and its
      figure is a FLOOR — the real number can only be higher. That is said on the page
      rather than papered over, and the two are drawn as two series so nobody reads a
      training against a game as if they were measured the same way.                     */
  function measured(s, key) {   /* key: "pt" | "br" */
    if (!s.poss) return NaN;
    if (s.phased) return 100 * (s.fb + (key === "br" ? s.brRest : s.ptRest)) / s.poss;
    return 100 * (key === "br" ? s.brP : s.ptP) / s.poss;   /* the floor */
  }
  var pct0f = function (v) { return (v == null || !isFinite(v)) ? "—" : Math.round(v) + "%"; };

  function trMeasure(root, no, title, sub, points, key, opts) {
    opts = opts || {};
    var sec = trSection(root, no, title, sub);
    var vals = points.map(function (p) { return measured(p.s, key); }).filter(isFinite);
    if (!vals.length) { sec.appendChild(el("div", "sx-empty", "Nothing tagged for this yet.")); return null; }
    var avg = vals.reduce(function (a, v) { return a + v; }, 0) / vals.length;
    var anyPhased = points.some(function (p) { return p.s.phased; });
    /* the rating rides under the measure, on the same dates, in a band of its own */
    var oerUnder = function (st) { return st.poss ? st.pts / st.poss : NaN; };
    var copt = { max: 100, axisFmt: pct0f, height: 215,
      under: { name: "OER — points per possession", get: oerUnder, fmt: f2,
               color: "var(--tl-1)", height: 58 } };
    if (opts.target) { copt.ref = { v: 70, label: "70% — target" };
      copt.bands = [{ v: 65, label: "65" }, { v: 60, label: "60" }]; }
    else copt.ref = { v: avg, label: "season average · " + pct0f(avg) };
    sec.appendChild(timelineChart("", "", points, [
      { name: "Games — measured", color: "var(--tl-3)",
        get: function (s) { return s.phased ? measured(s, key) : NaN; }, fmt: pct0f },
      { name: "Trainings — floor, no fastbreak is credited", color: "var(--tl-3)",
        dash: true, hollow: true,
        get: function (s) { return s.phased ? NaN : measured(s, key); }, fmt: pct0f }
    ], copt));
    if (!anyPhased) sec.appendChild(el("div", "sx-sub",
      "No game here carries phase tags, so every figure above is the training floor."));
    var what = opts.what || "Paint touch";

    /* ---- and what it scored -------------------------------------------------
       The measure says how much of it we did. On its own that is half a question:
       the one the staff is asking is whether doing more of it scores more. So the
       rating sits in the same table, session by session, and the relationship
       between the two is stated under it.

       It is not drawn on the chart above. That axis is a percentage and the rating
       is about one point a possession; putting both on it needs two scales, and two
       scales invent whatever correlation they happen to line up as. The column and
       the sentence say it without that. */
    var oerOf = oerUnder;
    var oers = points.map(function (p) { return oerOf(p.s); }).filter(isFinite);
    var oAvg = oers.length ? oers.reduce(function (a, v) { return a + v; }, 0) / oers.length : NaN;

    sec.appendChild(trTable(["Date", "Type", "Poss", "Fastbreak", what + " elsewhere",
        title.replace(/ —.*$/, ""), "OER", opts.target ? "Reading" : "vs average"],
      points.map(function (p) {
        var st = p.s, m = st.phased, v = measured(st, key);
        var sh = Math.round(v);
        var rest = m ? (key === "br" ? st.brRest : st.ptRest) : (key === "br" ? st.brP : st.ptP);
        var oer = oerOf(st);
        return [p.d, m ? "Game" : "Training", st.poss,
          m ? st.fb + " (" + pct0f(100 * st.fb / st.poss) + ")" : "not tagged",
          rest + " (" + pct0f(100 * rest / st.poss) + ")",
          { v: sh + "%", cls: "sx-vol " + volStep(sh) },
          isFinite(oer) ? { v: f2(oer),
            cls: "sx-cell " + pppStep(oer) } : { v: "—", cls: "tr-none" },
          opts.target
            ? (m ? (sh >= 70 ? "Perfect" : sh >= 65 ? "Ok" : sh >= 60 ? "Regular" : "Below") : "floor only")
            : { v: (v >= avg ? "+" : "−") + Math.round(Math.abs(v - avg)) + "%",
                cls: v >= avg ? "tr-good" : "tr-warn" }];
      })));

    /* the relationship, in one line, and never a number with a confident face on top
       of a cloud: under 30% explained there is nothing to read and it says so */
    var pairs = points.map(function (p) { return [measured(p.s, key), oerOf(p.s)]; })
      .filter(function (q) { return isFinite(q[0]) && isFinite(q[1]); });
    var fit = pairs.length >= 4 ? fitXY(pairs) : null;
    var firm = !!(fit && fit.r2 >= 0.3);
    var line;
    if (pairs.length < 4) line = "Too few sessions to say whether more of it scores more.";
    else if (!fit) line = "Every session is at the same volume, so there is nothing to read across.";
    else if (!firm) line = "More of it does not predict more points: a straight line through " +
      "the sessions explains only " + Math.round(100 * fit.r2) + "% of the spread (R² " +
      f2(fit.r2) + "). Season OER " + f2(oAvg) + ".";
    else line = "Every ten points of it is worth " + (fit.b >= 0 ? "+" : "−") +
      f2(Math.abs(fit.b * 10)) + " per possession, and that line explains " +
      Math.round(100 * fit.r2) + "% of the spread (R² " + f2(fit.r2) + "). Season OER " +
      f2(oAvg) + ".";
    sec.appendChild(el("div", "sx-sub fit-span" + (firm ? "" : " tr-warnline"), line));

    /* and the same thing a coach can act on: when we got it over seventy, what did we
       score. One line, because four bands do not need a table of their own. */
    var bands = oerBands(points, key).filter(function (b) { return b.n; });
    if (bands.length > 1) {
      var bl = el("div", "sx-sub fit-span");
      bl.appendChild(el("b", null, "OER by volume:  "));
      bl.appendChild(document.createTextNode(bands.map(function (b) {
        return b.label + " " + f2(b.oer) + " (" + b.n + ")";
      }).join("   ·   ")));
      sec.appendChild(bl);
    }
    return { avg: avg, vals: vals, last: vals[vals.length - 1],
             oerAvg: oAvg, fit: fit, firm: firm, bands: bands };
  }

  /* ---- 03 · tag and back, across the games ----------------------------- */
  /*  Every training and every game on one line of dates, the way the paint touches are.
      It was the games alone, because a training had no way to be read for this; it has
      one now (buildTransPractice), so a session of either kind with at least one such
      possession is a point here. The two are not measured on the same thing - in a game
      the possession defended is the opponent's, in a training it is our other five - and
      the chart marks which is which rather than pretending they are one series.          */
  function trTagBack(root, sessions) {
    var sec = trSection(root, "03", "Transition defense — TAG and BACK, every session",
      "TAG is the possession that follows one of ours ending on a long shot, BACK the one that " +
      "follows a shot at the rim or a turnover. The number is the DER on each: what was scored " +
      "per possession. Games and trainings share the dates; the marker says which is which.");
    var pts = sessions.filter(function (g) {
      return g.m && g.m.trans && (g.m.trans.tag.n + g.m.trans.back.n) > 0;
    }).map(function (g) {
      var t = g.m.trans;
      return { d: g.d, kind: g.kind, label: g.label || g.d,
        s: { tagN: t.tag.n, tagP: t.tag.pts, backN: t.back.n, backP: t.back.pts,
             tagPpp: t.tag.n ? t.tag.pts / t.tag.n : NaN,
             backPpp: t.back.n ? t.back.pts / t.back.n : NaN,
             allPpp: (t.tag.n + t.back.n) ? (t.tag.pts + t.back.pts) / (t.tag.n + t.back.n) : NaN,
             tagOf: t.tag.of, backOf: t.back.of,
             /* the DER of the whole game: what they scored over the possessions they had */
             der: (g.kind === "game" && g.m.dposs && g.m.dposs.length && g.m.oppPts != null)
               ? g.m.oppPts / g.m.dposs.length : NaN } };
    });
    if (!pts.length) { sec.appendChild(el("div", "sx-empty", "No session carries it yet.")); return null; }
    sec.appendChild(timelineChart("", "", pts, [
      { name: "TAG — DER after a long shot", color: "var(--tl-1)", get: function (s) { return s.tagPpp; }, fmt: f2,
        n: function (s) { return s.tagN; }, roll: function (s) { return [s.tagP, s.tagN]; } },
      { name: "BACK — DER after a miss at the rim or a turnover", color: "var(--tl-2)", get: function (s) { return s.backPpp; }, fmt: f2,
        n: function (s) { return s.backN; }, roll: function (s) { return [s.backP, s.backN]; } }
    ], { axisFmt: f2, height: 200, minN: 4, rollWindow: 5 }));
    sec.appendChild(el("div", "sx-sub", "The line is the last five sessions added together, points over possessions. Small dots are trainings and diamonds are games; a day with fewer than four possessions is left out."));
    var sum = function (list, f) { return list.reduce(function (a, p) { return a + p.s[f]; }, 0); };
    var tot = function (label, list) {
      var tN = sum(list, "tagN"), tP = sum(list, "tagP"), bN = sum(list, "backN"), bP = sum(list, "backP");
      return { cls: "tr-tot", cells: [label, "", tN, tP, f2(tN ? tP / tN : NaN),
        bN, bP, f2(bN ? bP / bN : NaN), f2((tN + bN) ? (tP + bP) / (tN + bN) : NaN),
        (tN && bN) ? (tP / tN > bP / bN ? "TAG" : "BACK") : "—"] };
    };
    var gm = pts.filter(function (p) { return p.kind === "game"; });
    var tr = pts.filter(function (p) { return p.kind !== "game"; });
    var rows = pts.map(function (p) {
      var worse = (isFinite(p.s.tagPpp) && isFinite(p.s.backPpp))
        ? (p.s.tagPpp > p.s.backPpp ? "TAG" : "BACK") : "—";
      var cell = function (v) { return isFinite(v)
        ? { v: f2(v), cls: "sx-cell " + pppStepD(v) } : { v: "—", cls: "tr-none" }; };
      return [p.kind === "game" ? p.label : p.d, p.kind === "game" ? "Game" : "Training",
        p.s.tagN, p.s.tagP, cell(p.s.tagPpp), p.s.backN, p.s.backP, cell(p.s.backPpp), cell(p.s.allPpp), worse];
    });
    if (gm.length) rows.push(tot("Every game", gm));
    if (tr.length) rows.push(tot("Every training", tr));
    if (gm.length && tr.length) rows.push(tot("Everything", pts));
    sec.appendChild(trTable(["Session", "Type", "TAG poss", "TAG pts", "TAG DER", "BACK poss", "BACK pts", "BACK DER", "Both DER", "Worse end"],
      rows, { sort: false }));
    /* the headline figure stays the games': it is the one measured against an opponent */
    var head = gm.length ? gm : pts;
    var tAll = sum(head, "tagN"), tPts = sum(head, "tagP"), bAll = sum(head, "backN"), bPts = sum(head, "backP");
    return { tag: tAll ? tPts / tAll : NaN, back: bAll ? bPts / bAll : NaN, pts: pts };
  }

  /* ---- 04 · where the possessions come from ---------------------------- */
  /*  Thirty-odd sets is a table, not a picture: a line each would be unreadable and would
      say nothing, because most of them are run three times. The thing that CAN be drawn is
      where the possessions came from — transition, early offense, half court, the two
      inbounds, after a timeout, and the ones out of any set — and what each of those
      returned. Six lines, one question each, and the sets themselves stay as a table
      underneath where they belong.                                                      */
  var PHASE_ROW = [
    { k: "Transition",   color: "var(--tl-1)" },
    { k: "Early offense",color: "var(--tl-2)" },
    { k: "Half court",   color: "var(--tl-3)" },
    { k: "Sideline",     color: "var(--tl-4)" },
    { k: "Baseline",     color: "var(--tl-5)" },
    { k: "After timeout",color: "var(--tl-6)" },
    { k: "Out of sets",  color: "var(--tl-7)" }
  ];
  /* An inbound names its end in the category, whichever list the model happens to hold
     it in: SLOB is the sideline and BLOB the baseline, and that is read off the name
     first so a new one works the day it is tagged. What is left is the ones named after
     the play and not the end — PIO PIO is a baseline play, which only the staff could
     say — and anything still unnamed is kept apart rather than guessed at. */
  /* named after the play and not the end, so only the staff can say which it is */
  var OOB_NAMED = { "PIO PIO": "Baseline" };
  function phaseOf(cat) {
    var fam = actionFamily(cat), c = String(cat || "").toUpperCase().trim();
    /* SOB and BOB are the same two ends written short - SLOB has no "SOB" in it and
       BLOB has no "BOB", so neither pattern can catch the other */
    if (/\bSLOB\b/.test(c) || /\bSOB\b/.test(c)) return "Sideline";
    if (/\bBLOB\b/.test(c) || /\bBOB\b/.test(c)) return "Baseline";
    if (OOB_NAMED[c]) return OOB_NAMED[c];
    if (fam === "Fastbreak") return "Transition";
    if (fam === "Secondary break") return "Early offense";
    if (fam === "ATO") return "After timeout";
    if (fam === "Out of sets") return "Out of sets";
    if (fam === "OOB (SLOB/BLOB)") return "Inbound — unnamed";
    return "Half court";
  }
  function trPhases(root, games) {
    var sec = trSection(root, "04", "Where our possessions came from",
      "One line per phase: how much of the game it was, and what it returned. The sets " +
      "themselves are the table under this one — thirty of them is a list, not a picture.");
    if (!games.length) { sec.appendChild(el("div", "sx-empty", "No game yet.")); return null; }
    var rows = PHASE_ROW.map(function (x) { return x.k; });
    var extra = [];
    var pts = games.map(function (g) {
      var m = {}, tot = 0;
      (g.m && g.m.poss ? g.m.poss : []).forEach(function (q) {
        var k = phaseOf(q.first);
        if (rows.indexOf(k) < 0 && extra.indexOf(k) < 0) extra.push(k);
        var e = m[k] || (m[k] = { n: 0, pts: 0 });
        e.n++; e.pts += q.pts || 0; tot++;
      });
      return { d: g.d, kind: "game", label: g.label, s: { m: m, tot: tot } };
    });
    var keys = rows.concat(extra);
    var share = function (k) { return function (s) { return s.tot ? 100 * ((s.m[k] || {}).n || 0) / s.tot : NaN; }; };
    var ppp = function (k) { return function (s) { var e = s.m[k]; return (e && e.n) ? e.pts / e.n : NaN; }; };
    var colour = function (k, i) {
      var r = PHASE_ROW.filter(function (x) { return x.k === k; })[0];
      return r ? r.color : "var(--tl-" + (1 + (i % 7)) + ")";
    };
    /* only the phases this club actually plays get a line */
    var live = keys.filter(function (k) { return pts.some(function (p) { return (p.s.m[k] || {}).n; }); });
    /* seven lines and a legend of seven do not fit in half a section: each chart takes
       the width, one under the other */
    var wide = function (node) { node.dataset.fitGrow = "1"; return node; };
    sec.appendChild(el("div", "sx-sub fit-span", "How much of the game each one was"));
    sec.appendChild(wide(timelineChart("", "", pts,
      live.map(function (k, i) { return { name: k, color: colour(k, i), get: share(k), fmt: pct0f }; }),
      { axisFmt: pct0f, height: 230, kinds: false })));
    sec.appendChild(el("div", "sx-sub fit-span", "And what each one returned, per possession"));
    sec.appendChild(wide(timelineChart("", "", pts,
      live.map(function (k, i) { return { name: k, color: colour(k, i), get: ppp(k), fmt: f2 }; }),
      { axisFmt: f2, height: 230, kinds: false })));
    /* the table: every phase, every game, share and PPP, season on the right */
    var head = ["Phase"].concat(games.map(function (g) { return g.label; }), ["Poss", "% all", "PPP"]);
    var tot = {}, totAll = 0;
    pts.forEach(function (p) { live.forEach(function (k) {
      var e = p.s.m[k]; if (!e) return;
      var t = tot[k] || (tot[k] = { n: 0, pts: 0 });
      t.n += e.n; t.pts += e.pts; totAll += e.n; }); });
    var ordered = live.slice().sort(function (a, b) {
      return ((tot[b] || {}).n || 0) - ((tot[a] || {}).n || 0); });
    sec.appendChild(trTable(head, ordered.map(function (k) {
      var t = tot[k] || { n: 0, pts: 0 };
      var cells = [k].concat(pts.map(function (p) {
        var e = p.s.m[k];
        if (!e) return { v: "—", cls: "tr-none" };
        var v = e.pts / e.n;
        return { v: e.n + " · " + f2(v), cls: "sx-cell " + pppStep(v) };
      }));
      cells.push(t.n);
      cells.push(shareCellLike(totAll ? Math.round(100 * t.n / totAll) : 0));
      cells.push(t.n >= 4 ? { v: f2(t.pts / t.n), cls: "sx-cell " + pppStep(t.pts / t.n) }
                          : { v: f2(t.pts / t.n), cls: "tr-thin" });
      return cells;
    }), { sort: false }));
    return ordered.map(function (k) { return { k: k, n: (tot[k] || {}).n || 0,
      ppp: (tot[k] && tot[k].n) ? tot[k].pts / tot[k].n : NaN }; });
  }
  function shareCellLike(p) { return { v: p + "%", cls: "sx-vol " + volStep(p) }; }

  /* ---- 04 · every set we called, across every game --------------------- */
  /*  One row per set and one column per game, and in each cell BOTH numbers: how many
      times it was run that night and what it returned. A column of bare counts says we
      called Elbow 5 four times and nothing about whether it was worth calling.
      The last column is the same trend the panels above carry, and it is read only over
      the games the set was actually run in — a game it was not called in is not a zero
      for it, it is silence, and a zero would drag the line down for not playing.        */
  function trSets(root, games) {
    var sec = trSection(root, "05", "Every set we called, game by game",
      "Grouped by the phase it is called in, and sorted by volume inside each one. Each " +
      "cell is runs and points per possession for that night. The trend is read only " +
      "over the games the set was run in: a game it was never called in says nothing about " +
      "it and is left out of the line rather than counted as a nought.");
    var bySet = {}, order = [];
    var SET_FAMS = { "Half court set": 1, "OOB (SLOB/BLOB)": 1, "ATO": 1 };
    games.forEach(function (g, gi) {
      (g.m && g.m.poss ? g.m.poss : []).forEach(function (q) {
        var fam = actionFamily(q.first);
        if (!SET_FAMS[fam]) return;
        var k = String(q.first || "").trim();
        if (!k) return;
        var e = bySet[k] || (bySet[k] = { k: k, fam: fam, n: 0, pts: 0, per: {} });
        if (!bySet[k].seen) { order.push(k); bySet[k].seen = 1; }
        e.n++; e.pts += q.pts || 0;
        var c = e.per[gi] || (e.per[gi] = { n: 0, pts: 0 });
        c.n++; c.pts += q.pts || 0;
      });
    });
    var rows = order.map(function (k) { return bySet[k]; })
      .sort(function (a, b) { return b.n - a.n || (a.k < b.k ? -1 : 1); });
    if (!rows.length) { sec.appendChild(el("div", "sx-empty", "No called set in the tagging yet.")); return null; }
    var MIN = 4;     /* under this a season PPP is an anecdote and is left uncoloured */
    var MINGAMES = 3;  /* a trend off two nights is a line through two dots */
    var head = ["Set"].concat(games.map(function (g) { return g.label; }),
      ["Runs", "PPP", "Trend"]);

    /* Thirty sets in one list sorted by volume reads as thirty unrelated rows: a half
       court set and a sideline inbound sit next to each other because they happened to
       be called the same number of times. They go under their phase instead, in the
       order the phases happen, and the volume sort runs inside each block. The band
       carries the block's own totals, so a phase can be read without adding it up.

       A phase with no named set in it is not drawn - transition and early offense are
       tagged by phase and not by play name, so they have no sets to list. They stay in
       the order anyway, for the day one of them is named. */
    var PHASE_SETS = PHASE_ROW.map(function (x) { return x.k; }).concat(["Inbound — unnamed"]);
    var grouped = [];
    PHASE_SETS.forEach(function (ph) {
      var mine = rows.filter(function (r) { return phaseOf(r.k) === ph; });
      if (!mine.length) return;
      var n = 0, pts = 0;
      mine.forEach(function (r) { n += r.n; pts += r.pts; });
      grouped.push({ band: ph, n: n, sets: mine.length, ppp: n ? pts / n : NaN });
      mine.forEach(function (r) { grouped.push({ set: r }); });
    });

    /* THE EIGHT BEST AND THE EIGHT WORST, MARKED WHERE THEY STAND - a small number after
       the name, green for the best and red for the worst, and nothing else on the row. Ranked on points per
       possession over the season, among the sets called often enough to be ranked at
       all - the same cut as the colour: under it a season figure is an anecdote. */
    var rankable = rows.filter(function (r) { return r.n >= MIN; })
      .sort(function (a, b) { return (b.pts / b.n) - (a.pts / a.n) || (b.n - a.n); });
    var nMark = Math.min(8, Math.floor(rankable.length / 2));
    var bestAt = {}, worstAt = {};
    rankable.slice(0, nMark).forEach(function (r, i) { bestAt[r.k] = i + 1; });
    rankable.slice(-nMark).reverse().forEach(function (r, i) { if (nMark) worstAt[r.k] = i + 1; });

    var body = [];
    grouped.forEach(function (g) {
      if (g.band) {
        body.push({ cls: "tr-bandrow", cells: [{ span: head.length, cls: "sx-band",
          v: g.band + "  ·  " + g.sets + " set" + (g.sets === 1 ? "" : "s") +
             "  ·  " + g.n + " run" + (g.n === 1 ? "" : "s") +
             "  ·  " + f2(g.ppp) + " per possession" }] });
        return;
      }
      var r = g.set;
      var ppp = r.n ? r.pts / r.n : NaN;
      var cells = [bestAt[r.k] ? { v: r.k, sup: bestAt[r.k], supCls: "tr-sup good", cls: "tr-supc" }
        : worstAt[r.k] ? { v: r.k, sup: worstAt[r.k], supCls: "tr-sup bad", cls: "tr-supc" } : r.k];
      var seq = [];
      games.forEach(function (gm, gi) {
        var c = r.per[gi];
        if (!c) { cells.push({ v: "—", cls: "tr-none" }); return; }
        var v = c.pts / c.n;
        seq.push(v);
        cells.push({ v: c.n + " · " + f2(v),
          cls: "sx-cell " + pppStep(v) });
      });
      cells.push(r.n);
      cells.push(r.n >= MIN
        ? { v: f2(ppp), cls: "sx-cell " + pppStep(ppp) }
        : { v: f2(ppp), cls: "tr-thin" });
      /* the trend, over the nights it was run and no others */
      if (seq.length < MINGAMES) cells.push({ v: seq.length + " game" + (seq.length === 1 ? "" : "s"), cls: "tr-thin" });
      else {
        var f = linfit(seq);
        var flat = !f || f2(Math.abs(f.b)) === f2(0);
        cells.push(flat ? { v: "flat", cls: "tr-thin" }
          : { v: (f.b > 0 ? "▲ +" : "▼ −") + f2(Math.abs(f.b)) + " / game",
              cls: f.b > 0 ? "tr-up" : "tr-down" });
      }
      body.push(cells);
    });
    /* the band rows stay where they are when a column is sorted, which is what the
       page's sorter does with a single-cell row that spans the table */
    sec.appendChild(trTable(head, body));
    return rows.filter(function (r) { return r.n >= MIN; });
  }


  /* ----------------------------------------------- volume against what it scored
     These two are used by the measure blocks above: the rating now lives in the same
     table as the measure it belongs to, rather than in a section of its own. A
     scatter of the pair was tried and taken out - one more panel to scroll past for
     a relationship that reads perfectly well as a column and a sentence. */

  function fitXY(pairs) {
    var n = pairs.length, i, sx = 0, sy = 0, sxx = 0, sxy = 0;
    if (n < 2) return null;
    for (i = 0; i < n; i++) { sx += pairs[i][0]; sy += pairs[i][1];
      sxx += pairs[i][0] * pairs[i][0]; sxy += pairs[i][0] * pairs[i][1]; }
    var d = n * sxx - sx * sx;
    if (!d) return null;
    var b = (n * sxy - sx * sy) / d, a = (sy - b * sx) / n;
    var mean = sy / n, ssT = 0, ssR = 0;
    for (i = 0; i < n; i++) {
      ssT += (pairs[i][1] - mean) * (pairs[i][1] - mean);
      var e = pairs[i][1] - (a + b * pairs[i][0]); ssR += e * e;
    }
    return { a: a, b: b, n: n, mean: mean, r2: ssT ? Math.max(0, 1 - ssR / ssT) : 0,
             at: function (x) { return a + b * x; } };
  }

  function oerBands(points, key) {
    var BANDS = [[0, 60, "Under 60%"], [60, 65, "60 – 65%"], [65, 70, "65 – 70%"],
                 [70, 101, "70% and over"]];
    return BANDS.map(function (b) {
      var mine = points.filter(function (p) {
        var v = measured(p.s, key);
        return isFinite(v) && v >= b[0] && v < b[1] && p.s.poss;
      });
      var poss = 0, pts = 0;
      mine.forEach(function (p) { poss += p.s.poss; pts += p.s.pts; });
      return { label: b[2], n: mine.length, oer: poss ? pts / poss : NaN };
    });
  }

  /* ---- 05 · the next five ---------------------------------------------- */
  function trProjection(root, games, metrics) {
    var sec = trSection(root, "06", "The next five games, on the trend we are on",
      "A straight line through the games played, carried five games forward. R² says how much " +
      "of the movement that line actually explains — under 0.30 it is a guess with a ruler, and " +
      "the row says so instead of pretending.");
    if (games.length < 3) {
      sec.appendChild(el("div", "sx-empty",
        "Three games are the fewest a line can be drawn through. There are " + games.length + "."));
      return [];
    }
    var out = [];
    sec.appendChild(trTable(["Measure", "Now (last game)", "Season average", "Per game", "In 5 games", "Fit", "Reading"],
      metrics.map(function (M) {
        var ys = games.map(function (g) { return M.get(g.s); }).filter(isFinite);
        var f = linfit(ys);
        if (!f) return [M.name, "—", "—", "—", "—", "—", "not enough games"];
        var last = ys[ys.length - 1], end = f.at(ys.length - 1 + 5);
        if (M.clamp) end = Math.max(M.clamp[0], Math.min(M.clamp[1], end));
        var good = M.higherIsBetter ? f.b > 0 : f.b < 0;
        var firm = f.r2 >= 0.3 && ys.length >= 4;
        var kind = !firm ? "" : (good ? "up" : "down");
        out.push({ name: M.name, slope: f.b, end: end, r2: f.r2, good: good, firm: firm, fmt: M.fmt,
                   last: last, mean: f.mean, n: ys.length, clamp: M.clamp || null });
        return [{ v: M.name },
          M.fmt(last), M.fmt(f.mean),
          /* a slope that rounds to nothing is flat, and "+0.00" reads as a measurement */
          { v: (M.fmt(Math.abs(f.b)) === M.fmt(0)) ? "flat"
               : ((f.b >= 0 ? "+" : "−") + M.fmt(Math.abs(f.b))),
            cls: kind ? ("tr-" + kind) : "" },
          { v: M.fmt(end), cls: firm ? (good ? "tr-good" : "tr-warn") : "tr-thin" },
          f.r2.toFixed(2),
          firm ? (good ? "holding the direction we want" : "drifting the wrong way")
               : "too scattered to carry forward"];
      }), { sort: false }));
    return out;
  }

  /* ---- 06 · key ideas -------------------------------------------------- */
  function trHighlights(root, bits) {
    if (!bits.length) return;
    /* not an .sx-sec: the page's grid lays those out in columns, which put the chips in a
       column of their own beside the heading instead of under it */
    var sec = el("div", "tr-top");
    sec.appendChild(el("div", "sx-h", "Key ideas"));
    var box = el("div", "tr-chips");
    bits.forEach(function (b) { box.appendChild(trChip(b.kind, b.text, b.note)); });
    sec.appendChild(box);
    root.appendChild(sec);
  }

  /* ----------------------------------------- a session with no five on five in it
     A day with no training never arrives here. A day WITH a training that was tagged
     but never got to five on five does arrive, with possessions in it and both
     measures reading nought - and a nought like that is not a reading, it is an
     absence. Zero paint touches AND zero ball reversals across a whole session does
     not happen playing five on five; what happened is that they did not play it. Left
     in, it drags the average and bends the trend line for no reason.

     Only when BOTH are nought. A session of drives and little ball movement can give
     a true zero reversals with the paint touches to prove it was played, and that is a
     reading worth looking at, not a day to throw away. */
  function trWhyOut(x) {
    if (!x.s || !x.s.poss) return "nothing tagged";
    var pt = measured(x.s, "pt"), br = measured(x.s, "br");
    if (isFinite(pt) && isFinite(br) && pt === 0 && br === 0) return "no five on five";
    return "";
  }
  /* day first, then the calendar's own order for games, then the file name */
  function trOrder(a, b) {
    var da = a.d || "9999-99-99", db = b.d || "9999-99-99";
    if (da !== db) return da < db ? -1 : 1;
    var ia = a.idx == null ? 1e9 : a.idx, ib = b.idx == null ? 1e9 : b.idx;
    if (ia !== ib) return ia - ib;
    /* a training and a game on one day: the training came first */
    var ka = a.kind === "game" ? 1 : 0, kb = b.kind === "game" ? 1 : 0;
    if (ka !== kb) return ka - kb;
    return String(a.name || a.label || "") < String(b.name || b.label || "") ? -1 : 1;
  }
  /* THE PAGE IS SHOWN WHEN IT IS WHOLE. The highlights at the top are worked out from the
     charts under them, so they are built last - and built straight into the page that
     meant the bottom of it appeared first and the top landed on it afterwards. It is
     built off the page now and put in in one piece, top to bottom. */
  function renderTrendsDash(root, sets, noDate, folder) {
    var stage0 = document.createElement("div");
    renderTrendsDashInner(stage0, sets, noDate, folder);
    root.innerHTML = "";
    root.appendChild(stage0);
  }
  function renderTrendsDashInner(root, sets, noDate, folder) {
    root.innerHTML = "";
    /* a day with no training never arrives here; the two kinds of empty session are
       dropped here, and both are counted so the line is not read as the whole season */
    var dropped = sets.filter(function (x) { return !!trWhyOut(x); });
    /* ONE ORDER, EVERYWHERE.
       Sorting on the day alone leaves two sessions that share one in whatever order the
       Drive handed them over, and that order is not stable between reads - so a chart
       could swap two columns between one visit and the next. The calendar's own place
       settles games, and the file name settles the rest, so the sequence is the same
       every time and every section below is built from this one list. */
    var live = sets.filter(function (x) { return !trWhyOut(x); }).sort(trOrder);
    /* We play some clubs twice, so two columns can both read ROSTOCK and there is no
       way to tell the August one from the September one. A club that turns up more than
       once carries its day; the ones we played once stay as they were. */
    (function () {
      var seen = {};
      live.forEach(function (x) {
        if (x.kind !== "game") return;
        var k = String(x.label || "").toUpperCase();
        seen[k] = (seen[k] || 0) + 1;
      });
      live.forEach(function (x) {
        if (x.kind !== "game") return;
        var k = String(x.label || "").toUpperCase();
        if (seen[k] > 1 && x.d) x.label = x.label + " " + x.d.slice(8, 10) + "/" + x.d.slice(5, 7);
      });
    })();
    var games = live.filter(function (x) { return x.kind === "game"; });
    var head = el("div", "sx-sec");
    head.appendChild(el("div", "sx-h", "Us, across the season"));
    head.appendChild(el("div", "sx-meta",
      live.filter(function (x) { return x.kind === "practice"; }).length + " training · " +
      games.length + " game" +
      (live.length ? " · " + live[0].d + " → " + live[live.length - 1].d : "") +
      (dropped.length ? "  ·  " + dropped.length + " session" +
        (dropped.length === 1 ? "" : "s") + " left out" : "")));
    /* which days, and which of the two reasons - a count on its own looks like the
       numbers were quietly massaged */
    ["no five on five", "nothing tagged"].forEach(function (why) {
      var hit = dropped.filter(function (x) { return trWhyOut(x) === why; });
      if (!hit.length) return;
      var names = hit.map(function (x) { return x.name || x.label || x.d || "?"; }).join(", ");
      head.appendChild(el("div", "sx-sub tr-warnline",
        why === "no five on five"
          ? ("Left out, tagged but no five on five played in " +
             (hit.length === 1 ? "it" : "them") + " — both paint touches and ball " +
             "reversals read nought, which a session of five on five does not: " + names)
          : ("Left out, nothing tagged in " + (hit.length === 1 ? "it" : "them") +
             ": " + names)));
    });
    /* where a date came from, when it did not come from the file name */
    var borrowed = games.filter(function (g) { return g.how === "fixture" || g.how === "drive"; });
    if (borrowed.length) head.appendChild(el("div", "sx-sub",
      borrowed.length + " game" + (borrowed.length === 1 ? " has" : "s have") +
      " no date in the file name: " +
      borrowed.map(function (g) {
        return g.label + " → " + g.d +
          (g.how === "fixture" ? " (from the calendar)" : " (the day it was tagged)");
      }).join(" · ")));
    if (noDate && noDate.length) head.appendChild(el("div", "sx-sub tr-warnline",
      "Left out, nothing anywhere says when " + (noDate.length === 1 ? "it" : "they") +
      " happened: " + noDate.join(", ")));
    /* THE COUNT AGAINST THE FOLDER.
       Everything above counts what got through, which is the one number that cannot
       answer "are they all in?" - forty-seven sessions on the Drive and three on the
       chart both read as "3 training". So the folder's own total is stated first, and
       every file between that total and the chart is accounted for by name. */
    if (folder) {
      var inPr = live.filter(function (x) { return x.kind === "practice"; }).length;
      var inGm = games.length;
      var missP = folder.practice - inPr, missG = folder.game - inGm;
      var line = el("div", "sx-sub fit-span tr-count");
      line.appendChild(el("b", null, "Tagging exports on the Drive: " + folder.practice +
        " training and " + folder.game + " game."));
      line.appendChild(document.createTextNode(
        "  On the charts: " + inPr + " training and " + inGm + " game" +
        (inGm === 1 ? "" : "s") + "." +
        ((missP > 0 || missG > 0)
          ? ("  " + (missP + missG) + " file" + ((missP + missG) === 1 ? " is" : "s are") +
             " not on them — each one is named below.")
          : "  Nothing is missing.")));
      head.appendChild(line);
      /* The plans are a different folder, and counting them is the only way to see how
         many sessions were held but never tagged - which is what "the Drive has 47 and
         the chart has twelve" actually means. */
      if (folder.plans) {
        var gap = folder.plans - folder.practice;
        var pl = el("div", "sx-sub fit-span" + (gap > 0 ? " tr-warnline" : ""));
        pl.textContent = "Session plans on the Drive: " + folder.plans +
          " \u2014 those are the practice sheets, a different folder, and nothing on a " +
          "chart comes from them." +
          (gap > 0
            ? ("  " + gap + " session" + (gap === 1 ? " has" : "s have") +
               " a plan but no tagging export, so " + (gap === 1 ? "it is" : "they are") +
               " not measured here.")
            : "");
        head.appendChild(pl);
      }
    }
    /* EVERY GAME, WITH THE DAY IT WAS GIVEN AND WHERE THAT DAY CAME FROM.
       When the order on a chart looks wrong there is no way to see why: the charts show
       a date and not the file it came from, so a file matched to the wrong night looks
       like a bug in the sorting. This lists them, in the order they are drawn, each with
       its file name and whether the day came from that name, from the calendar, or from
       the day it reached the Drive. */
    var gameRows = live.filter(function (x) { return x.kind === "game"; });
    if (gameRows.length) {
      var gd = document.createElement("details");
      var gs = document.createElement("summary");
      gs.textContent = gameRows.length + " game" + (gameRows.length === 1 ? "" : "s") +
        " on the charts, in this order. Show where each date came from";
      gd.appendChild(gs);
      var gl = el("div", "tr-datelist");
      gameRows.forEach(function (x, i) {
        gl.appendChild(el("div", null, (i + 1) + ".  " + x.d + "   " + (x.label || "") +
          "   \u2190 " + (x.name || "") +
          (x.how === "name" ? "   (date from the file name)"
            : x.how === "fixture" ? "   (matched to the calendar)"
            : x.how === "drive" ? "   (the day it reached the Drive)" : "")));
      });
      gd.appendChild(gl);
      var gw = el("div", "sx-sub fit-span"); gw.appendChild(gd);
      head.appendChild(gw);
    }
    /* where a practice date came from, when it did not come from the file name */
    var pBorrowed = live.filter(function (x) {
      return x.kind === "practice" && (x.how === "inside" || x.how === "drive"); });
    if (pBorrowed.length) {
      var ins = pBorrowed.filter(function (x) { return x.how === "inside"; }).length;
      var drv = pBorrowed.length - ins;
      var bits = [];
      if (ins) bits.push(ins + " read from inside the file");
      if (drv) bits.push(drv + " from the day they were tagged");
      /* The count is the sentence. Forty-odd file names strung together on one line is
         a wall nobody reads, so the list goes behind a fold - there when a date looks
         wrong and out of the way when it does not. */
      var wrapB = el("div", "sx-sub fit-span");
      var det = document.createElement("details");
      var sum = document.createElement("summary");
      sum.textContent = pBorrowed.length + " training file" +
        (pBorrowed.length === 1 ? " has" : "s have") + " no date in the name — " +
        bits.join(", ") + ". Show which";
      det.appendChild(sum);
      var ul = el("div", "tr-datelist");
      pBorrowed.forEach(function (x) {
        ul.appendChild(el("div", null, (x.name || x.d) + "  →  " + x.d +
          (x.how === "inside" ? "  (inside the file)" : "  (the day it was tagged)")));
      });
      det.appendChild(ul);
      wrapB.appendChild(det);
      head.appendChild(wrapB);
    }
    /* WHAT WAS READ AND WHAT WAS LEFT OUT IS FOR THE DAY SOMETHING LOOKS WRONG. It opened
       the page as a block of seven lines - which files, which dates were borrowed from
       the calendar, how many plans have no tagging - and a staff reading its trends had
       to get past it every time. It is one quiet line now, closed, and the whole account
       is still behind it for when a number does not add up. */
    var about = document.createElement("details");
    about.className = "td-about";
    var aboutSum = document.createElement("summary");
    aboutSum.textContent = live.filter(function (x) { return x.kind === "practice"; }).length + " trainings · " +
      games.length + " games" + (live.length ? " · " + live[0].d + " → " + live[live.length - 1].d : "") +
      (dropped.length ? " · " + dropped.length + " left out" : "") + " · what was read";
    about.appendChild(aboutSum);
    about.appendChild(head);
    root.appendChild(about);
    if (!live.length) {
      about.open = true;
      root.appendChild(el("div", "sx-empty", "Nothing with five on five in it yet."));
      return;
    }
    var hl = el("div"); root.appendChild(hl);   /* the highlights go on top, built last */

    /* THE PAGE WAS SIX SECTIONS ONE UNDER ANOTHER, each with its chart, its table and its
       paragraphs, and reading it meant scrolling through all of it to find the one thing
       wanted. It is a dashboard now: the pictures first, small and side by side, and the
       full sections - every table and every sentence that was here before - built exactly
       as they were but kept off the page until one is asked for. So they are built into
       `stage` and not into the page, and the sets, which are a table and never a chart,
       get a place of their own at the bottom. */
    var stage = el("div"), setsHost = el("div");

    var pts = live.map(function (x) { return { d: x.d, kind: x.kind, label: x.label || x.d, s: x.s }; });
    var bits = [];

    var pt = trMeasure(stage, "01", "Paint touches \u2014 the 70% measure",
      "The rule the reports use: a fastbreak counts whole, and in every other phase the " +
      "possession counts when it touched the paint \u2014 over the possessions played. 70% is the " +
      "target, 65 and 60 the lines under it.",
      pts, "pt", { target: true, what: "Paint touch" });
    var br = trMeasure(stage, "02", "Ball reversals \u2014 the same measure",
      "The same arithmetic, counting a reversal instead of a paint touch. No target is drawn " +
      "on it, because the reports do not grade it either \u2014 the line against the season average " +
      "is the reading.",
      pts, "br", { target: false, what: "Reversal" });

    var tb = trTagBack(stage, live);
    var phases = trPhases(stage, games);
    var sets4 = trSets(setsHost, games);
    /* the same games and sets, handed to the page: the season dashboard and the league's
       game-by-game block read our tagging beside the play by play */
    try {
      window.LowenTrendsData = { games: games.map(function (g) { return { d: g.d, label: g.label, s: g.s, m: g.m }; }),
                                 sets: sets4 || [] };
      window.dispatchEvent(new Event("lowen-trends"));
    } catch (e) { }

    var METRICS = [
      { name: "Paint touches \u2014 the 70% measure", get: function (s) { return measured(s, "pt"); },
        fmt: pct0f, higherIsBetter: true, clamp: [0, 100] },
      { name: "Ball reversals \u2014 the same measure", get: function (s) { return measured(s, "br"); },
        fmt: pct0f, higherIsBetter: true, clamp: [0, 100] },
      { name: "Points per possession", get: function (s) { return s.poss ? s.ppp : NaN; },
        fmt: f2, higherIsBetter: true, clamp: [0, 2.5] }
    ];
    var proj = trProjection(stage, games, METRICS);

    /* ---- and the marks, read off what was just drawn ---- */
    if (pt && pt.vals.length > 1) {
      bits.push({ kind: pt.last >= 70 ? "good" : "warn",
        text: "Paint touches " + pct0f(pt.last) + " last time out",
        note: "target 70% \u00b7 season " + pct0f(pt.avg) });
    }
    if (br && br.vals.length > 1) {
      bits.push({ kind: br.last >= br.avg ? "good" : "warn",
        text: "Ball reversals " + pct0f(br.last) + " last time out",
        note: "season " + pct0f(br.avg) });
    }
    if (tb && isFinite(tb.tag) && isFinite(tb.back)) {
      var worse = tb.tag > tb.back ? "after a long shot" : "after a miss at the rim";
      bits.push({ kind: "warn", text: "They hurt us most " + worse,
        note: "TAG " + f2(tb.tag) + " · BACK " + f2(tb.back) + " per possession" });
    }
    (proj || []).forEach(function (r) {
      if (!r.firm) return;
      bits.push({ kind: r.good ? "up" : "down",
        text: r.name + " heading for " + r.fmt(r.end),
        note: "in five games, on this trend" });
    });

    /* WHERE IT IS HEADING. The marks above say where each thing stands; these say which
       way it is moving. Each measure's last few sessions are set against everything
       before them, and the three that have moved the most are named, in the colour of
       whether that movement is the one we want. Rates over possessions are added up
       before they are divided, never averaged day by day. */
    var heading = [];
    var mean2 = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : NaN; };
    var trendBy = function (name, list, get, fmt, hiGood) {
      var v = list.map(function (p) { return get(p.s); }).filter(isFinite);
      if (v.length < 6) return;
      var k = Math.min(4, Math.floor(v.length / 2));
      var a = mean2(v.slice(-k)), b = mean2(v.slice(0, v.length - k));
      if (!isFinite(a) || !isFinite(b) || !b) return;
      heading.push({ name: name, a: a, b: b, rel: (a - b) / Math.abs(b), fmt: fmt, good: (a > b) === hiGood, k: k });
    };
    var trendPool = function (name, list, num, den, hiGood) {
      var ok = list.filter(function (p) { return (p.s[den] || 0) > 0; });
      if (ok.length < 6) return;
      var k = Math.min(5, Math.floor(ok.length / 2));
      var sum = function (l, f) { return l.reduce(function (x, p) { return x + (p.s[f] || 0); }, 0); };
      var la = ok.slice(-k), lb = ok.slice(0, ok.length - k);
      var a = sum(la, num) / Math.max(1, sum(la, den)), b = sum(lb, num) / Math.max(1, sum(lb, den));
      if (!isFinite(a) || !isFinite(b) || !b) return;
      heading.push({ name: name, a: a, b: b, rel: (a - b) / Math.abs(b), fmt: f2, good: (a > b) === hiGood, k: k });
    };
    trendBy("Paint touches", pts, function (s) { return measured(s, "pt"); }, pct0f, true);
    trendBy("Ball reversals", pts, function (s) { return measured(s, "br"); }, pct0f, true);
    trendBy("Points per possession", pts, function (s) { return s.poss ? s.ppp : NaN; }, f2, true);
    if (tb && tb.pts) {
      trendPool("TAG defense", tb.pts, "tagP", "tagN", false);
      trendPool("BACK defense", tb.pts, "backP", "backN", false);
      trendBy("DER, whole game", tb.pts, function (s) { return s.der; }, f2, false);
    }
    heading = heading.filter(function (x) { return Math.abs(x.rel) >= 0.04; })
      .sort(function (x, y) { return Math.abs(y.rel) - Math.abs(x.rel); }).slice(0, 3);

    /* the page's season dashboard says these now, from both sources; this is the fallback
       for when it is not there */
    if (!window.UIKit) trHighlights(hl, bits);

    if (heading.length && !window.UIKit) {
      var hsec = el("div", "tr-top");
      hsec.appendChild(el("div", "sx-h", "Where it is heading"));
      var hbox = el("div", "tr-chips");
      heading.forEach(function (x) {
        hbox.appendChild(trChip(x.good ? "up" : "down",
          x.name + (x.a > x.b ? " rising" : " falling") + " — " + x.fmt(x.a),
          "last " + x.k + " sessions · " + x.fmt(x.b) + " before · " + (x.rel > 0 ? "+" : "") + Math.round(100 * x.rel) + "%"));
      });
      hsec.appendChild(hbox);
      hl.appendChild(hsec);
    }

    /* THE SETS, RANKED FOUR WAYS, SIDE BY SIDE. The eight that return the most and the
       eight that return the least say where a set stands; the other two columns say which
       way it is moving - the five that have gained the most and the five that have lost
       the most, the last games each was run in against the ones before. A set needs a
       handful of runs to be ranked at all, and a handful on each side of the split to be
       said to have moved: two possessions are not a trend. */
    if (sets4 && sets4.length) {
      var minRuns = 4, minSide = 3;
      var ranked = sets4.filter(function (x) { return x.n >= minRuns; })
        .map(function (x) { return { k: x.k, n: x.n, ppp: x.pts / x.n }; })
        .sort(function (a, b) { return (b.ppp - a.ppp) || (b.n - a.n); });
      /* how each set has moved: its runs in the last games it was called in, added up,
         against its runs in the games before them, added up */
      var moved = [];
      sets4.forEach(function (x) {
        var gs = Object.keys(x.per || {}).map(Number).sort(function (a, b) { return a - b; });
        if (gs.length < 3) return;
        var k = Math.min(3, Math.floor(gs.length / 2));
        var sum = function (list) { var n = 0, p = 0;
          list.forEach(function (gi) { n += x.per[gi].n; p += x.per[gi].pts; });
          return { n: n, p: p }; };
        var a = sum(gs.slice(-k)), b = sum(gs.slice(0, gs.length - k));
        if (a.n < minSide || b.n < minSide) return;
        moved.push({ k: x.k, n: x.n, now: a.p / a.n, was: b.p / b.n, d: a.p / a.n - b.p / b.n,
          games: k, nNow: a.n, nWas: b.n });
      });
      var upList = moved.filter(function (x) { return x.d > 0.005; })
        .sort(function (a, b) { return b.d - a.d; }).slice(0, 5);
      var downList = moved.filter(function (x) { return x.d < -0.005; })
        .sort(function (a, b) { return a.d - b.d; }).slice(0, 5);
      if (ranked.length >= 2) {
        var nTop = Math.min(8, Math.floor(ranked.length / 2) || 1);
        var rsec = el("div", "tr-top");
        rsec.appendChild(el("div", "sx-h", "Sets — where they stand and where they are heading"));
        var four = el("div", "tr-rank2 tr-rank4");
        var topPpp = Math.max.apply(null, ranked.map(function (x) { return x.ppp; })) || 1;
        var topD = Math.max.apply(null, moved.map(function (x) { return Math.abs(x.d); }).concat([0.01]));
        var col = function (title, list, cls, row) {
          var c = el("div", "tr-rank " + cls);
          c.appendChild(el("div", "tr-rank-h", title));
          if (!list.length) c.appendChild(el("div", "tr-rank-e", "None yet — not enough runs on both sides."));
          list.forEach(function (x, i) {
            var r = el("div", "tr-rank-r");
            r.appendChild(el("span", "tr-rank-n", String(i + 1)));
            r.appendChild(el("span", "tr-rank-k", x.k));
            var v = row(x);
            r.appendChild(el("b", "tr-rank-v", v.v));
            var bar = el("span", "tr-rank-bar"); var fill = el("i");
            fill.style.width = Math.max(3, Math.round(100 * v.w)) + "%"; bar.appendChild(fill);
            r.appendChild(bar);
            r.appendChild(el("span", "tr-rank-c", v.c));
            r.title = x.k + " — " + v.t;
            c.appendChild(r);
          });
          return c;
        };
        var stand = function (x) { return { v: f2(x.ppp), w: x.ppp / topPpp, c: x.n + " runs",
          t: f2(x.ppp) + " points per possession over " + x.n + " runs" }; };
        var move = function (x) { return { v: (x.d > 0 ? "+" : "−") + f2(Math.abs(x.d)), w: Math.abs(x.d) / topD,
          c: f2(x.was) + " → " + f2(x.now),
          t: f2(x.was) + " over " + x.nWas + " runs before, " + f2(x.now) + " over " + x.nNow +
             " runs in the last " + x.games + " game" + (x.games === 1 ? "" : "s") + " it was run in" }; };
        four.appendChild(col("Best " + nTop + " — points per possession", ranked.slice(0, nTop), "good", stand));
        four.appendChild(col("Worst " + nTop, ranked.slice(-nTop).reverse(), "bad", stand));
        four.appendChild(col("Improved the most", upList, "good", move));
        four.appendChild(col("Dropped the most", downList, "bad", move));
        rsec.appendChild(four);
        /* THE SETS AT A GLANCE: HOW OFTEN, HOW WELL, AND WHICH WAY. One line a set, the most
           run first. The blue bar is how often it is called; the chip is what it returns, in
           the colour of the rate; the squares are its games in order - bigger the more it
           was run that night, coloured by what it returned - so a set that is fading or
           coming on is seen without reading a table. */
        var glance = sets4.slice().sort(function (a, b) { return b.n - a.n; }).slice(0, 14);
        if (glance.length) {
          var gbox = el("div", "tr-glance");
          gbox.appendChild(el("div", "tr-rank-h", "Sets at a glance — volume, return, and game by game"));
          var gMax = glance[0].n || 1;
          glance.forEach(function (x) {
            var row = el("div", "tr-gl-r");
            row.appendChild(el("span", "tr-gl-k", x.k));
            var vb = el("span", "tr-gl-v"); var vf = el("i"); vf.style.width = Math.max(4, Math.round(100 * x.n / gMax)) + "%";
            vb.appendChild(vf); vb.appendChild(el("b", null, String(x.n))); row.appendChild(vb);
            var pv = x.pts / x.n;
            row.appendChild(el("span", "tr-gl-p sx-cell " + pppStep(pv), f2(pv)));
            var sq = el("span", "tr-gl-s");
            games.forEach(function (gm, gi) {
              var c = x.per[gi], d = el("i", c ? ("sx-cell " + pppStep(c.pts / c.n)) : "none");
              if (c) { var sz = Math.max(8, Math.min(20, 6 + 3 * c.n)); d.style.width = sz + "px"; d.style.height = sz + "px";
                d.title = gm.label + " · " + c.n + " runs · " + f2(c.pts / c.n) + " per possession"; }
              else d.title = gm.label + " · not run";
              sq.appendChild(d);
            });
            row.appendChild(sq);
            gbox.appendChild(row);
          });
          rsec.appendChild(gbox);
        }
        rsec.appendChild(el("div", "sx-sub", "Ranked: sets run at least " + minRuns + " times, the bar is each set against the best one. " +
          "Moved: the last games a set was run in (up to three) against the ones before, at least " + minSide + " runs on each side."));
        hl.appendChild(rsec);
      }
    }

    /* ---------------------------------------------------------------- the dashboard */
    var dash = el("div", "td-grid");
    var gamesMeasured = function (key) { return [
      { name: "Games", color: "var(--tl-3)",
        get: function (s) { return s.phased ? measured(s, key) : NaN; }, fmt: pct0f },
      { name: "Trainings (floor)", color: "var(--tl-3)", dash: true, hollow: true,
        get: function (s) { return s.phased ? NaN : measured(s, key); }, fmt: pct0f } ]; };
    var lastOf = function (list, get) {
      for (var i = list.length - 1; i >= 0; i--) { var v = get(list[i].s); if (isFinite(v)) return v; }
      return NaN; };
    var meanOf = function (list, get) {
      var v = list.map(function (p) { return get(p.s); }).filter(isFinite);
      return v.length ? v.reduce(function (a, x) { return a + x; }, 0) / v.length : NaN; };

    /* THE RATING RIDES UNDER THE MEASURE IT ANSWERS FOR. A paint touch is not the point;
       the point is whether touching the paint scores. So the OER is not a chart of its
       own: it is a band under the paint touches and under the ball reversals, on the
       same dates, and a night is read straight down - 76% there, and what it scored
       right below. The same goes for the other end: under TAG and BACK, which are the
       DER on two kinds of possession, sits the DER on all of them. */
    var oerGet = function (s) { return s.poss ? s.pts / s.poss : NaN; };
    var oerAvg = meanOf(pts, oerGet), oerLast = lastOf(pts, oerGet);
    var oerBand = function () { return { name: "OER — points per possession", get: oerGet, fmt: f2,
      color: "var(--tl-1)", height: 64 }; };
    var oerKpi = isFinite(oerAvg) ? [
      { l: "OER last", v: f2(oerLast), cls: oerLast >= oerAvg ? "good" : "bad" },
      { l: "OER season", v: f2(oerAvg) } ] : [];
    if (pt) dash.appendChild(tdCard("Paint touches · OER", "the 70% measure, and what we scored the same day underneath", [
        { l: "Last", v: pct0f(pt.last), cls: pt.last >= 70 ? "good" : pt.last >= 60 ? "" : "bad" },
        { l: "Season", v: pct0f(pt.avg) }, { l: "Target", v: "70%" } ].concat(oerKpi),
      timelineChart("", "", pts, gamesMeasured("pt"),
        { max: 100, axisFmt: pct0f, height: 200, ref: { v: 70, label: "70%" }, under: oerBand() })));
    if (br) dash.appendChild(tdCard("Ball reversals · OER", "the same measure, and what we scored the same day underneath", [
        { l: "Last", v: pct0f(br.last), cls: br.last >= br.avg ? "good" : "bad" },
        { l: "Season", v: pct0f(br.avg) } ].concat(oerKpi),
      timelineChart("", "", pts, gamesMeasured("br"),
        { max: 100, axisFmt: pct0f, height: 200, ref: { v: br.avg, label: "avg" }, under: oerBand() })));
    if (tb && tb.pts && tb.pts.length) {
      var derGet = function (s) { return s.der; };
      var derAvg = meanOf(tb.pts, derGet), derLast = lastOf(tb.pts, derGet);
      var tOpt = { axisFmt: f2, height: 200, minN: 4, rollWindow: 5 }, tKpi = [{ l: "TAG", v: f2(tb.tag) }, { l: "BACK", v: f2(tb.back) }];
      /* a training has no DER of its own - both fives are ours, so what one concedes is
         what the other scores and the figure would just be the OER again - so the band
         carries the games, where there is an opponent to concede to */
      if (isFinite(derAvg)) {
        tOpt.under = { name: "DER — points conceded per possession, whole game", get: derGet, fmt: f2,
          color: "var(--tl-2)", height: 64 };
        tKpi.push({ l: "DER last", v: f2(derLast), cls: derLast <= derAvg ? "good" : "bad" });
        tKpi.push({ l: "DER season", v: f2(derAvg) });
      }
      dash.appendChild(tdCard("Transition defense · DER", "the line is the last five sessions together · small dots trainings, diamonds games · days under four possessions left out — lower is better",
        tKpi,
        timelineChart("", "", tb.pts, [
          { name: "TAG: after our long shot", color: "var(--tl-1)", get: function (s) { return s.tagPpp; }, fmt: f2,
            n: function (s) { return s.tagN; }, roll: function (s) { return [s.tagP, s.tagN]; } },
          { name: "BACK: after our shot at the rim or a turnover", color: "var(--tl-2)", get: function (s) { return s.backPpp; }, fmt: f2,
            n: function (s) { return s.backN; }, roll: function (s) { return [s.backP, s.backN]; } } ], tOpt)));
    }
    var heat = tdPhaseHeat(games);
    if (heat) dash.appendChild(tdCard("Where our possessions came from",
      "share of each game · points per possession underneath", null, heat, "wide"));
    /* The projection is not on the dashboard. With a season of real sessions every row of
       it read "no clear trend", which is the honest answer and an empty panel: it stays
       under Full detail for whoever wants the working, and a measure that IS heading
       somewhere already says so in the key ideas at the top. */
    root.appendChild(dash);

    /* ---------------------------------------------------------------- the detail */
    var secs = [].slice.call(stage.children);
    if (secs.length) {
      var pick = el("div", "td-pick");
      pick.appendChild(el("span", "td-pick-l", "Full detail"));
      var body = el("div", "td-detail");
      var NAMES = { "01": "Paint touches", "02": "Ball reversals", "03": "TAG / BACK",
                    "04": "Possession origin", "06": "Projection" };
      var open = null, btns = [];
      secs.forEach(function (sec) {
        var no = (sec.querySelector(".tr-no") || {}).textContent || "";
        var b = el("button", "td-pick-b", NAMES[no] || ((sec.querySelector(".sx-h") || {}).textContent || no));
        b.type = "button";
        b.addEventListener("click", function () {
          var same = open === sec;
          while (body.firstChild) body.removeChild(body.firstChild);
          btns.forEach(function (x) { x.classList.remove("on"); });
          open = same ? null : sec;
          if (open) { body.appendChild(sec); b.classList.add("on"); }
        });
        btns.push(b); pick.appendChild(b);
      });
      pick.appendChild(el("span", "td-pick-n", "the table and the reading behind each panel — click again to close"));
      root.appendChild(pick);
      root.appendChild(body);
    }

    /* ---------------------------------------------------------------- the sets */
    if (setsHost.firstChild) {
      var ss = setsHost.firstChild;
      ss.classList.add("tr-sets");
      var no5 = ss.querySelector(".tr-no"); if (no5) no5.textContent = "SETS";
      var h5 = ss.querySelector(".sx-h"); if (h5) h5.textContent = "Systems efficiency — every set we called, game by game";
      root.appendChild(ss);
    }
  }

  /* ---- the dashboard's own pieces --------------------------------------- */
  function tdCard(title, sub, kpis, bodyNode, cls) {
    var c = el("div", "td-card" + (cls ? " " + cls : ""));
    var h = el("div", "td-h");
    var t = el("div", "td-t");
    t.appendChild(el("b", null, title));
    if (sub) t.appendChild(el("span", null, sub));
    h.appendChild(t);
    if (kpis && kpis.length) {
      var k = el("div", "td-kpis");
      kpis.forEach(function (x) {
        var one = el("div", "td-kpi" + (x.cls ? " " + x.cls : ""));
        one.appendChild(el("i", null, x.l));
        one.appendChild(el("b", null, x.v));
        k.appendChild(one);
      });
      h.appendChild(k);
    }
    c.appendChild(h);
    if (bodyNode) c.appendChild(bodyNode);
    return c;
  }

  /*  WHERE THE POSSESSIONS CAME FROM, AS A GRID AND NOT AS SEVEN LINES.
      Two charts of seven lines each answered this, and seven lines crossing over four
      games is a knot: nobody can say from it how much of last Saturday was transition.
      It is a grid. A row is a phase, a column is a game, and the cell says what share of
      that game the phase was - the darker the cell, the more of the game it was - with
      what it returned per possession written small under it. Read across, a row is how
      the phase has moved from game to game; read down, a column is the shape of one
      night. The season is the last two columns.                                         */
  function tdPhaseHeat(games) {
    if (!games.length) return null;
    var known = PHASE_ROW.map(function (x) { return x.k; }), extra = [];
    var per = games.map(function (g) {
      var m = {}, tot = 0;
      (g.m && g.m.poss ? g.m.poss : []).forEach(function (q) {
        var k = phaseOf(q.first);
        if (known.indexOf(k) < 0 && extra.indexOf(k) < 0) extra.push(k);
        var e = m[k] || (m[k] = { n: 0, pts: 0 });
        e.n++; e.pts += q.pts || 0; tot++;
      });
      return { m: m, tot: tot };
    });
    var keys = known.concat(extra).filter(function (k) { return per.some(function (p) { return (p.m[k] || {}).n; }); });
    if (!keys.length) return null;
    var tot = {}, all = 0;
    per.forEach(function (p) { keys.forEach(function (k) {
      var e = p.m[k]; if (!e) return;
      var t = tot[k] || (tot[k] = { n: 0, pts: 0 }); t.n += e.n; t.pts += e.pts; all += e.n; }); });
    keys.sort(function (a, b) { return ((tot[b] || {}).n || 0) - ((tot[a] || {}).n || 0); });
    var wrap = el("div", "td-heatwrap"), t = el("table", "td-heat");
    /* Two numbers stacked in one cell with a dot between them had to be decoded. Each
       game is two columns with their own headings instead: how much of the game the phase
       was, as a bar that fills with the share, and what it scored per possession, tinted
       green above the season's own average for that game and red below it. */
    var allPts = 0; keys.forEach(function (k) { allPts += (tot[k] || {}).pts || 0; });
    var seasonPpp = all ? allPts / all : NaN;
    var h1 = el("tr"), h2 = el("tr", "sub");
    var ph = el("th", "l", "Phase"); ph.rowSpan = 2; h1.appendChild(ph);
    games.forEach(function (g) {
      var th = el("th", "g", g.label); th.colSpan = 2; h1.appendChild(th);
      h2.appendChild(el("th", null, "% of game")); h2.appendChild(el("th", null, "pts / poss"));
    });
    var ths = el("th", "g sum", "Season"); ths.colSpan = 3; h1.appendChild(ths);
    h2.appendChild(el("th", "sum", "% of all")); h2.appendChild(el("th", "sum", "pts / poss")); h2.appendChild(el("th", "sum", "poss"));
    t.appendChild(h1); t.appendChild(h2);
    var shareCell = function (share, n, cls) {
      var td = el("td", "pc" + (cls ? " " + cls : ""));
      if (share == null) { td.className += " none"; td.textContent = "—"; return td; }
      var bar = el("span", "bar"); bar.style.width = Math.max(2, Math.min(100, share)) + "%";
      td.appendChild(bar);
      td.appendChild(el("b", null, Math.round(share) + "%"));
      td.title = n + " possessions";
      return td;
    };
    var pppCell = function (v, n, cls) {
      var td = el("td", "pp" + (cls ? " " + cls : ""));
      if (v == null) { td.className += " none"; td.textContent = "—"; return td; }
      td.textContent = f2(v);
      /* under four possessions a rate is an anecdote: shown, not judged */
      if (n >= 4 && isFinite(seasonPpp)) td.className += (v >= seasonPpp + 0.1 ? " hi" : v <= seasonPpp - 0.1 ? " lo" : "");
      else td.className += " thin";
      td.title = n + " possessions";
      return td;
    };
    keys.forEach(function (k) {
      var tr = el("tr");
      tr.appendChild(el("td", "l", k));
      per.forEach(function (p) {
        var e = p.m[k];
        if (e && p.tot) { tr.appendChild(shareCell(100 * e.n / p.tot, e.n)); tr.appendChild(pppCell(e.pts / e.n, e.n)); }
        else { tr.appendChild(shareCell(null)); tr.appendChild(pppCell(null)); }
      });
      var s = tot[k];
      if (s && all) {
        tr.appendChild(shareCell(100 * s.n / all, s.n, "sum")); tr.appendChild(pppCell(s.pts / s.n, s.n, "sum"));
        tr.appendChild(el("td", "n sum", String(s.n)));
      } else { tr.appendChild(shareCell(null, 0, "sum")); tr.appendChild(pppCell(null, 0, "sum")); tr.appendChild(el("td", "n sum", "—")); }
      t.appendChild(tr);
    });
    wrap.appendChild(t);
    wrap.appendChild(el("div", "td-note", "% of game: how many of that game's possessions started in this phase — the bar fills with it. " +
      "pts / poss: points scored per possession from it; green is above our season average of " + f2(seasonPpp) +
      ", red below, grey is fewer than four possessions."));
    return wrap;
  }

  /*  THE NEXT FIVE GAMES, SAID THE WAY ONE WOULD SAY IT.
      The table had seven columns - now, average, slope per game, the value in five, R²
      and a reading - which is the working, not the answer. The answer is one line per
      measure: where it is, where it is going, and whether that can be believed. So each
      measure is a row with the last game on the left, an arrow, and where the trend puts
      it in five games on the right, on a bar that shows the two against the season. When
      the games are too irregular for a line to mean anything the row says exactly that,
      in words, and draws no arrow - a guess is not dressed up as a forecast.             */
  function tdProjection(proj, nGames) {
    if (!proj || !proj.length) {
      if (nGames >= 3) return null;
      return el("div", "sx-empty", "Three games are the fewest a trend can be read from. There are " + nGames + ".");
    }
    var box = el("div", "td-proj");
    proj.forEach(function (r) {
      var row = el("div", "td-pr" + (r.firm ? (r.good ? " up" : " down") : " flat"));
      row.appendChild(el("div", "td-pr-n", r.name.replace(/ —.*$/, "")));
      var now = el("div", "td-pr-v");
      now.appendChild(el("i", null, "last game")); now.appendChild(el("b", null, r.fmt(r.last)));
      row.appendChild(now);
      /* the bar: season average as a tick, the last game and the projection as dots */
      /* a percentage is drawn on the whole 0-100; anything else on the stretch it moves in */
      var mn = Math.min(r.last, r.end, r.mean), mx = Math.max(r.last, r.end, r.mean), lo, hi;
      if (r.clamp && r.clamp[1] > 10) { lo = 0; hi = 100; }
      else { var pad = (mx - mn) * 0.6 || 0.2; lo = mn - pad; hi = mx + pad; }
      var at = function (v) { return Math.max(0, Math.min(100, 100 * (v - lo) / ((hi - lo) || 1))); };
      var bar = el("div", "td-pr-bar");
      var avg = el("span", "td-pr-avg"); avg.style.left = at(r.mean) + "%"; avg.title = "season average " + r.fmt(r.mean);
      bar.appendChild(avg);
      if (r.firm) {
        var seg = el("span", "td-pr-seg");
        seg.style.left = Math.min(at(r.last), at(r.end)) + "%";
        seg.style.width = Math.abs(at(r.end) - at(r.last)) + "%";
        bar.appendChild(seg);
      }
      var d1 = el("span", "td-pr-dot now"); d1.style.left = at(r.last) + "%"; bar.appendChild(d1);
      if (r.firm) { var d2 = el("span", "td-pr-dot end"); d2.style.left = at(r.end) + "%"; bar.appendChild(d2); }
      row.appendChild(bar);
      var end = el("div", "td-pr-v end");
      if (r.firm) {
        end.appendChild(el("i", null, "in 5 games"));
        end.appendChild(el("b", null, (r.end >= r.last ? "▲ " : "▼ ") + r.fmt(r.end)));
      } else {
        end.appendChild(el("i", null, "in 5 games"));
        end.appendChild(el("b", null, "—"));
      }
      row.appendChild(end);
      row.appendChild(el("div", "td-pr-say", r.firm
        ? ((r.good ? "Improving" : "Getting worse") + " · " +
           (r.fmt(Math.abs(r.slope)) === r.fmt(0) ? "barely moving" : ((r.slope >= 0 ? "+" : "−") + r.fmt(Math.abs(r.slope)) + " a game")) +
           " · season average " + r.fmt(r.mean))
        : ("No clear trend — the games go up and down too much to project · season average " + r.fmt(r.mean))));
      box.appendChild(row);
    });
    box.appendChild(el("div", "td-note", "Grey tick: season average. Dark dot: the last game. Coloured dot: where a straight line through the " +
      nGames + " games played puts it five games from now."));
    return box;
  }

  function hookTrends(host) {
    dropCache();
    mount(host, function (box) {
      /* THE TWO FOLDERS, AND WHY THE COUNT NEVER MATCHED.
         The session PLANS and the session TAGGING live in different folders on the
         Drive. Trends is built from the tagging - a plan has no possessions in it to
         measure - but the folder a coach counts is the one with the plans in it, so
         "there are 47" and "the chart shows 12" were both true and about different
         things. The plan folder is listed too now, purely to say so. */
      return Promise.all([listFolder("practice"), listFolder("game"),
        listFolder("practicedoc").catch(function () { return []; })]).then(function (res) {
        /* EVERY practice in the folder is read, not only the ones whose name spells a
           date out. practiceFilesInRange throws the rest away before they are opened,
           which is right for a single session or a week - those have to be picked
           without downloading forty files - and wrong here, where the question is how
           the whole season is going. The date is settled after reading, because the
           file carries one inside it when the name does not. */
        var pfAll = (res[0] || []).slice();
        /* a game with no date in its name is still a game: see datedGame */
        /* all the game files at once, so no two of them claim the same night */
        var assigned = assignGames(res[1] || []);
        var gf = (res[1] || []).map(function (f) {
            var g = assigned[f.id] || datedGame(f);
            return { f: f, d: g.d, how: g.how, opp: g.opp, idx: g.idx };
          })
          /* by day, and the calendar's own order settles two on the same day rather
             than leaving it to whichever file came back from the Drive first */
          .sort(function (a, b) {
            var da = a.d || "9999", db = b.d || "9999";
            if (da !== db) return da < db ? -1 : 1;
            var ia = a.idx == null ? 1e9 : a.idx, ib = b.idx == null ? 1e9 : b.idx;
            if (ia !== ib) return ia - ib;
            return String(a.f.name) < String(b.f.name) ? -1 : 1;
          });
        var noDate = gf.filter(function (x) { return !x.d; });
        gf = gf.filter(function (x) { return !!x.d; });
        if (!pfAll.length && !gf.length) {
          box.innerHTML = "";
          box.appendChild(el("div", "sx-empty", "No tagging files in Drive yet."));
          return;
        }
        var folder = { practice: pfAll.length, game: res[1].length,
                       plans: (res[2] || []).length };
        var pNoDate = [];
        return Promise.all(
          pfAll.map(function (f) {
            return getRows(f.id).then(function (rows) {
              var g = datedPractice(f, rows);
              if (!g.d) { pNoDate.push(f.name); return null; }
              var m = buildPractice(rows);
              return { kind: "practice", d: g.d, how: g.how, label: g.d, name: f.name,
                       m: m, s: summarise(m) };
            /* one unreadable file must not take the other forty-six with it */
            }, function (e) { pNoDate.push(f.name + " (could not be read)"); return null; });
          }).concat(gf.map(function (x) {
            return getRows(x.f.id).then(function (rows) {
              var m = buildGame(rows);
              return { kind: "game", d: x.d, how: x.how, m: m, s: summarise(m),
                       /* the calendar's own spelling of the club when it recognised the
                          file: "ROSTOCK", not "G7 BBL ROSTOCK OK" */
                       label: x.opp ? String(x.opp).toUpperCase().slice(0, 18) : shortGame(x.f.name),
                       idx: x.idx, name: x.f.name };
            }, function (e) { noDate.push({ f: x.f }); return null; });
          }))
        ).then(function (sets) {
          renderTrendsDash(box, sets.filter(Boolean),
            noDate.map(function (x) { return x.f.name; }).concat(pNoDate), folder);
        });
      });
    });
  }
  /* "2026-09-19 G7 BBL TRIER.csv" is a column heading nobody can read. The opponent is
     the last words of it, and that is the whole name a coach needs on a chart. */
  /* every tagged game of the season as numbers, for a page that wants the trend without the
     Trends screen: the same files, the same reading, kept once per visit */
  var _seasonGamesP = null;
  function seasonGames() {
    if (_seasonGamesP) return _seasonGamesP;
    _seasonGamesP = listFolder("game").then(function (files) {
      var assigned = assignGames(files || []);
      var gf = (files || []).map(function (f) {
        var g = assigned[f.id] || datedGame(f);
        return { f: f, d: g.d, opp: g.opp };
      }).filter(function (x) { return !!x.d; }).sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
      return Promise.all(gf.map(function (x) {
        return getRows(x.f.id).then(function (rows) {
          var m = buildGame(rows);
          return { d: x.d, label: x.opp ? String(x.opp).toUpperCase().slice(0, 18) : shortGame(x.f.name), m: m, s: summarise(m) };
        }, function () { return null; });
      })).then(function (l) { return l.filter(Boolean); });
    });
    _seasonGamesP.catch(function () { _seasonGamesP = null; });
    return _seasonGamesP;
  }
  function shortGame(name) {
    var t = String(name).replace(/\.csv$/i, "")
      .replace(/^[0-9a-f]{6,}-/i, "")
      .replace(/\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{4})\b/g, "")
      .replace(/\b(G\d+|BBL|CUP|POSTGAME|POST|GAME|SEASON|OK)\b/gi, "")
      .replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
    return t ? t.toUpperCase().slice(0, 18) : String(name).slice(0, 18);
  }

  function hookCompare(host) {
    dropCache();   /* every open is a fresh read of both folders */
    mount(host, function (box) {
      return Promise.all([listFolder("practice"), listFolder("game")]).then(function (res) {
        var pf = practiceFilesInRange(res[0], "1900-01-01", "2999-12-31");
        var gf = res[1].map(function (f) { return { f: f, d: fileDate(f.name) }; });
        if (!pf.length && !gf.length) {
          box.innerHTML = "";
          box.appendChild(el("div", "sx-empty", "No tagging files in Drive yet."));
          return;
        }
        return Promise.all(
          pf.map(function (x) {
            return getRows(x.f.id).then(function (rows) {
              return { kind: "practice", d: x.d, label: x.d, s: summarise(buildPractice(rows)) };
            });
          }).concat(gf.map(function (x) {
            return getRows(x.f.id).then(function (rows) {
              return { kind: "game", d: x.d, label: x.f.name.replace(/\.csv$/i, ""), s: summarise(buildGame(rows)) };
            });
          }))
        ).then(function (sets) {
          var practice = sets.filter(function (x) { return x.kind === "practice"; });
          var games = sets.filter(function (x) { return x.kind === "game"; });
          renderCompare(box, practice, games);
        });
      });
    });
  }

  function scan() {
    document.querySelectorAll(".scout-placeholder").forEach(function (p) {
      if (p.dataset.sxDone) return;
      /* the marker is the attribute, not the sentence: the placeholder text used
         to be what picked the hook, so shortening it silently unmounted the
         block. The text test stays as a fallback for anything not yet tagged. */
      var kind = p.dataset.sx || "";
      var t = p.textContent || "";
      if (kind === "training" || (!kind && /Team stats/.test(t))) { p.dataset.sxDone = "1"; hookTraining(p); }
      else if (kind === "compare" || (!kind && /Trends and comparison across every training and game/.test(t))) {
        p.dataset.sxDone = "1"; hookCompare(p);
      }
      else if (kind === "trends") { p.dataset.sxDone = "1"; hookTrends(p); }
      /* Player development is deliberately left alone: the season practice
         report belongs in Post game / practice, not in this view. */
    });
  }

  function css() {
    var s = document.createElement("style");
    s.textContent = [
      /* One scale for the whole app: red is more of it, green is less of it. The post game
         used a green ramp for efficiency and a blue one for volume, which is two rules on
         one screen; both are this one now, so a dark cell always means "a lot of it"
         wherever the reader finds it. */
      /* THE DIRECTION OF THE COLOUR, and there is only one of it.
         Less is red, more is green - in the league, in the pre game and here. The colour
         carries the SIZE of the number and nothing else. It used to carry a verdict as
         well, which meant the same green said "good for us" on one screen and "bad for
         us" on the next, and the defensive groups carried a third direction of their own.
         The one exception is the tables that start from our defense - what we concede,
         transition defense, the half of the play types that is theirs - where those
         points are theirs and a high PPP is red. See pppStepD. */
      ".sx{--s0:#C53727;--s1:#d4705f;--s2:#e7a596;--s3:#d6e5dc;--s4:#8fc0a9;--s5:#17805A;",
      "--b0:#eef1f6;--b1:#dbe2ee;--b2:#c2cfe2;--b3:#a3b6d2;--b4:#7f97bd;--b5:#5b77a6;",
      "font-size:13px;color:var(--ink)}",

      /* white type only where the fill is dark enough to need it */
      ".sx-cell.s0,.sx-cell.s5{color:#fff}",

      ".sx-meta{font-size:12px;color:var(--ink-soft);margin-bottom:14px}",
      /* Blocks, not one running sheet. A group lays its sections side by side and a
         section lays its tables side by side; how many fit on a line is measured, not
         guessed - see _fitGrid in index.html. */
      /* A SECTION IS A CARD. The tables used to float on the page with nothing around
         them, so a block of six of them read as one sheet of numbers with gaps in it
         rather than as six things - and the gaps, which are only the difference between
         a tall table and a short one beside it, read as mistakes. A card closes that:
         the eye is told where a section begins and ends, and the white inside a card is
         the card's, not the page's. */
      ".sx-sec{margin:0 0 14px;display:grid;grid-template-columns:1fr;gap:10px 16px;align-items:start;",
      "background:var(--panel,#fff);border:1px solid var(--line,#e4e7ec);border-radius:10px;",
      "padding:12px 14px 13px;box-shadow:0 1px 2px rgba(16,24,40,.04);box-sizing:border-box}",
      ".sx-cat > .sx-sec{margin:0}",
      ".sx-sec > *{min-width:0}",
      /* A card is as tall as what is in it. Stretching them to a common bottom edge was
         tried: it lines the row up, and it also puts five hundred pixels of nothing
         inside the shorter card, which is the thing that made this block look broken in
         the first place. The border closes each one, so a row of cards of different
         heights reads as a row of cards. */
      ".sx-cat > .sx-sec{align-content:start}",
      ".fit-span{grid-column:1/-1}",
      ".sx-h{font-size:11.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-soft,#5b6472);margin:0 0 4px}",
      ".sx-sub{font-size:11.5px;color:var(--ink-faint);margin:0 0 10px;line-height:1.5}",
      ".sx-band{display:flex;align-items:center;gap:9px;background:transparent;color:var(--ink-faint,#8a93a2);",
      "font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;padding:0;margin:14px 0 5px;border-radius:0}",
      ".sx-band:after{content:'';flex:1;height:1px;background:var(--line,#e4e7ec)}",
      ".sx-tablewrap{overflow-x:visible}",
      /* A table is as wide as what it says, and no wider. Filling the card was tried and
         is worse: a four-column table of three-digit numbers stretched across a card
         leaves two hundred pixels between one column and the next, and a reader's eye
         has to travel the whole way to pair a label with its number. Left in the card,
         with the card's own edge closing the line, a small table reads as a small table. */
      ".sx-table{border-collapse:separate;border-spacing:2px;width:auto;max-width:100%;",
      /* ...but it does not sit in the corner of a card five hundred pixels wider than it
         is either. A floor of 560, or the card if the card is narrower: a small table
         grows a little into the room it has been given and stops well before its columns
         start swimming. */
      "min-width:min(100%,560px);font-variant-numeric:tabular-nums}",
      ".sx-table th{font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-faint);padding:4px 7px;text-align:right;white-space:nowrap}",
      ".sx-table th:first-child{text-align:left}",
      ".sx-table th.sx-sortable{cursor:pointer;user-select:none;position:relative}",
      ".sx-table th.sx-sortable:hover{color:var(--ink)}",
      ".sx-table th.sx-sortable::after{content:'';opacity:0}",
      ".sx-table th.sx-sort-up::after,.sx-table th.sx-sort-down::after{opacity:1;font-size:8px;margin-left:3px}",
      ".sx-table th.sx-sort-up::after{content:'\u25b2'}",
      ".sx-table th.sx-sort-down::after{content:'\u25bc'}",
      ".sx-table th.sx-sort-up,.sx-table th.sx-sort-down{color:var(--ink)}",
      ".sx-table td{padding:6px 7px;text-align:right;font-size:12.5px;white-space:nowrap;background:rgba(0,0,0,.02);border-radius:4px}",
      ".sx-table td:first-child{text-align:left;font-weight:700;background:transparent}",
      ".sx-table tr.sx-totrow td{font-weight:800;background:rgba(0,0,0,.05)}",
      ".sx-table tr.sx-tailrow td{opacity:.7;font-style:italic}",
      ".sx-notyet{border:1px dashed var(--line);border-radius:8px;padding:11px 13px;",
      "color:var(--ink-soft);font-size:12.5px;line-height:1.55;background:rgba(0,0,0,.015)}",
      ".sx-strong{font-weight:800}",
      ".sx-cell{font-weight:800;color:#12161d}",
      ".sx-cell.s0{background:var(--s0)}.sx-cell.s1{background:var(--s1)}.sx-cell.s2{background:var(--s2)}",
      ".sx-cell.s3{background:var(--s3)}.sx-cell.s4{background:var(--s4)}.sx-cell.s5{background:var(--s5)}",
      ".sx-cell.sx-tot{background:var(--accent-soft);color:var(--ink)}",
      ".sx-vol{font-weight:700;color:#12161d}",
      ".sx-vol.b0{background:var(--b0)}.sx-vol.b1{background:var(--b1)}.sx-vol.b2{background:var(--b2)}",
      ".sx-vol.b3{background:var(--b3)}.sx-vol.b4{background:var(--b4);color:#fff}.sx-vol.b5{background:var(--b5);color:#fff}",
      ".sx-gauge{margin:14px 0 18px}",
      ".sx-gtop{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:6px;flex-wrap:wrap}",
      ".sx-gname{font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}",
      ".sx-gbig{font-size:30px;font-weight:800;font-variant-numeric:tabular-nums}",
      ".sx-verdict{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:3px 9px;margin-left:9px;border-radius:5px;vertical-align:middle}",
      ".sx-perfect{background:#2f7a56;color:#fff}.sx-ok{background:#6fab8d;color:#fff}",
      ".sx-regular{background:var(--gold-2);color:#1c1405}.sx-below{background:var(--alert);color:#fff}",
      ".sx-gtrack{position:relative;height:30px;background:rgba(0,0,0,.06);border-radius:6px;overflow:visible}",
      ".sx-gseg{position:absolute;left:0;top:0;height:100%;background:var(--b4);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;border-radius:6px 0 0 6px;overflow:hidden}",
      ".sx-gtick{position:absolute;top:-5px;bottom:-5px;width:2px;background:var(--ink);opacity:.75}",
      ".sx-gtick.soft{opacity:.3}",
      ".sx-gscale{display:flex;gap:14px;margin-top:7px;font-size:10px;color:var(--ink-faint)}",
      ".sx-gsc{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap}",
      ".sx-gsc b{font:700 10px 'IBM Plex Mono',ui-monospace,monospace;color:var(--ink-soft,#5b6472)}",
      ".sx-gsc i{font-style:normal;letter-spacing:.06em;text-transform:uppercase;font-size:8.5px}",
      ".sx-gnote{margin-top:8px;font-size:11.5px;color:var(--ink-soft)}",
      ".sx-gseg.fb{background:var(--b2);color:var(--ink);border-radius:6px 0 0 6px}",
      ".sx-gseg.rest{background:var(--b4);color:#fff}",
      ".sx-gsplit{margin-top:10px;display:flex;flex-direction:column;gap:3px}",
      ".sx-gpart{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink-soft)}",
      ".sx-gpart.sum{margin-top:2px;padding-top:5px;border-top:1px solid var(--line);color:var(--ink);font-weight:700}",
      ".sx-gkey{width:11px;height:11px;border-radius:3px;flex:none}",
      ".sx-gkey.fb{background:var(--b2)}",
      ".sx-gkey.rest{background:var(--b4)}",
      ".sx-gkey.blank{background:transparent}",
      ".sx-gauge.ungraded .sx-gtrack{background:rgba(0,0,0,.05)}",
      ".sx-gauge.ungraded .sx-gbig{color:var(--ink-soft)}",
      ".sx-gpt{flex:none;min-width:170px}",
      ".sx-gpv{font-variant-numeric:tabular-nums}",
      "@media (max-width:560px){.sx-gpart{flex-wrap:wrap;gap:4px}.sx-gpt{min-width:0}}",
      ".sx-mixcols{display:grid;grid-template-columns:1fr 1fr;gap:20px}",
      "@media(max-width:900px){.sx-mixcols{grid-template-columns:1fr}}",
      ".sx-mixwrap{margin-bottom:4px}",
      ".sx-mixrow{display:grid;grid-template-columns:62px 1fr 48px;align-items:center;gap:8px}",
      ".sx-ml{font-size:11.5px;font-weight:700;text-align:right;color:var(--ink-soft)}",
      ".sx-mixbar{display:flex;height:24px;border-radius:5px;overflow:hidden;background:rgba(0,0,0,.05)}",
      ".sx-mixbar span{display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:800;overflow:hidden;white-space:nowrap}",
      ".sx-two{background:var(--s4);color:#fff}.sx-three{background:var(--b2);color:#12161d}",
      ".sx-none{color:var(--ink-faint);font-weight:600;width:100%}",
      /* a cell for a set nobody ran in that quarter: a dash, never a zero, because a
         zero is a result and this is an absence */
      ".sx-dash{color:var(--ink-faint);opacity:.45;text-align:center}",
      ".sx-mp{font-size:14px;font-weight:800;text-align:right;padding:2px 4px;border-radius:4px}",
      ".sx-mixsub{grid-column:2/4;font-size:10.5px;color:var(--ink-faint);margin:2px 0 8px 70px}",
      ".sx-legend{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:10.5px;color:var(--ink-faint);margin-top:6px}",
      ".sx-scale{display:flex}",
      ".sx-sw{width:42px;text-align:center}",
      ".sx-sw i{display:block;height:12px}",
      ".sx-sw span{display:block;margin-top:2px}",
      ".sx-s0{background:var(--s0)}.sx-s1{background:var(--s1)}.sx-s2{background:var(--s2)}.sx-s3{background:var(--s3)}.sx-s4{background:var(--s4)}.sx-s5{background:var(--s5)}",
      ".sx-b0{background:var(--b0)}.sx-b1{background:var(--b1)}.sx-b2{background:var(--b2)}.sx-b3{background:var(--b3)}.sx-b4{background:var(--b4)}.sx-b5{background:var(--b5)}",
      ".sx-callout{border-left:3px solid var(--accent);padding:4px 0 4px 11px;margin-top:14px;font-size:12px;color:var(--ink-soft);line-height:1.5}",
      ".sx-loading,.sx-empty{border:1px dashed var(--line-strong);border-radius:10px;padding:20px;color:var(--ink-faint);font-size:12.5px;text-align:center}",
      /* the loading variant holds a spinner and a skeleton, which are read from the left */
      ".sx-loading{text-align:left;padding:14px 16px}",
      /* ---- the trends dashboard ----
         The marks are the pre-game report's, in the same words: a star on what is worth
         walking into the room with, a triangle on a direction, a warning on what is going
         the wrong way. They are chips at the top and a tint in the table, never colour on
         its own — every one of them carries its glyph. */
      ".tr-sec{margin-bottom:20px}",
      /* ---- the compact dashboard: cards side by side, the detail on request ---- */
      /* one chart a row, the full width: forty-odd sessions in a card a quarter of the page wide is a smudge of dots */
      ".td-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin:0 0 14px}",
      ".td-card{background:var(--panel,#fff);border:1px solid var(--line-strong,#d7dbe0);border-radius:12px;",
      "  padding:11px 13px 9px;min-width:0;box-sizing:border-box}",
      ".td-card.wide{grid-column:1/-1}",
      /* what was read: one closed line at the top, the account behind it */
      ".td-about{margin:0 0 10px}",
      ".td-about > summary{cursor:pointer;list-style:none;font-size:11px;color:var(--ink-faint);padding:2px 0;user-select:none}",
      ".td-about > summary::-webkit-details-marker{display:none}",
      ".td-about > summary::before{content:'\\25b8  '}",
      ".td-about[open] > summary::before{content:'\\25be  '}",
      ".td-about > summary:hover{color:var(--ink)}",
      ".td-about > .sx-sec{margin:8px 0 0}",
      ".td-kpis{flex-wrap:wrap;justify-content:flex-end;row-gap:6px}",
      ".td-h{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:4px}",
      ".td-t{min-width:0}",
      ".td-t b{display:block;font:800 13px/1.15 'Oswald',sans-serif;letter-spacing:.07em;text-transform:uppercase;color:var(--ink)}",
      ".td-t span{display:block;margin-top:2px;font-size:10.5px;color:var(--ink-faint);line-height:1.3}",
      ".td-kpis{display:flex;gap:14px;flex:0 0 auto}",
      ".td-kpi{text-align:right}",
      ".td-kpi i{display:block;font:600 9px/1 'Inter',sans-serif;font-style:normal;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint)}",
      ".td-kpi b{display:block;margin-top:3px;font:800 19px/1 'Oswald',sans-serif;color:var(--ink);font-variant-numeric:tabular-nums}",
      ".td-kpi.good b{color:#17805a}.td-kpi.bad b{color:#c53727}",
      ".td-card .sx-sec.tl{margin:0;display:block}",
      ".td-card .sx-sec.tl > .sx-h{display:none}",
      ".td-card .tl-legend{margin:0 0 2px;font-size:10px}",
      ".td-note{margin-top:7px;font-size:10.5px;color:var(--ink-faint);line-height:1.4}",
      /* phases as a grid */
      ".td-heatwrap{overflow-x:auto}",
      "table.td-heat{border-collapse:separate;border-spacing:3px;width:100%;table-layout:fixed}",
      ".td-heat th{font:700 9.5px/1.2 'Inter',sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);",
      "  padding:2px 4px 4px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".td-heat th.l,.td-heat td.l{text-align:left;width:170px}",
      ".td-heat td.l{font:700 12px/1.2 'Inter',sans-serif;color:var(--ink);padding:0 6px 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".td-heat th.g{font-size:10.5px;color:var(--ink);border-bottom:2px solid var(--ink,#15181f);padding-bottom:3px}",
      ".td-heat tr.sub th{font-size:8.5px;letter-spacing:.06em;padding-top:3px}",
      ".td-heat td{text-align:center;border-radius:5px;padding:0 4px;height:26px;font-variant-numeric:tabular-nums}",
      ".td-heat td.pc{position:relative;text-align:left;background:var(--panel-2,#f1f3f5);overflow:hidden;padding:0}",
      ".td-heat td.pc .bar{position:absolute;left:0;top:0;bottom:0;background:#9fb2d6;border-radius:5px 0 0 5px}",
      ".td-heat td.pc b{position:relative;display:block;padding:0 7px;font:800 14px/26px 'Oswald',sans-serif;color:#12161d}",
      ".td-heat td.pp{font:700 12.5px/26px 'IBM Plex Mono',monospace;color:var(--ink);background:var(--panel-2,#f1f3f5)}",
      ".td-heat td.pp.hi{background:#cfe9dc;color:#0f5c40}.td-heat td.pp.lo{background:#f6d5cf;color:#8f2418}",
      ".td-heat td.pp.thin{color:var(--ink-faint);font-weight:500}",
      ".td-heat td.n{font:600 12px/26px 'IBM Plex Mono',monospace;color:var(--ink-soft,#5b6472)}",
      ".td-heat td.none{color:var(--line-strong,#c9ced6);background:transparent;text-align:center;font-weight:400}",
      ".td-heat td.pc.none{line-height:26px}",
      ".td-heat td.sum.pc .bar{background:#7f95c2}",
      ".td-heat td.sum{box-shadow:inset 0 0 0 1.5px var(--ink,#15181f)}",
      ".td-heat th.sum{color:var(--ink)}",
      /* the projection as rows */
      ".td-proj{display:grid;gap:8px}",
      ".td-pr{display:grid;grid-template-columns:170px 78px minmax(120px,1fr) 96px;column-gap:14px;row-gap:3px;align-items:center;",
      "  padding:8px 10px;border-radius:9px;background:var(--panel-2,#f6f7f9);border-left:5px solid var(--line-strong,#d7dbe0)}",
      ".td-pr.up{border-left-color:#17805a}.td-pr.down{border-left-color:#c53727}",
      ".td-pr-n{font:800 12.5px/1.2 'Oswald',sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--ink)}",
      ".td-pr-v i{display:block;font:600 9px/1 'Inter',sans-serif;font-style:normal;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}",
      ".td-pr-v b{display:block;margin-top:3px;font:800 20px/1 'Oswald',sans-serif;color:var(--ink);font-variant-numeric:tabular-nums}",
      ".td-pr-v.end{text-align:right}",
      ".td-pr.up .td-pr-v.end b{color:#17805a}.td-pr.down .td-pr-v.end b{color:#c53727}",
      ".td-pr.flat .td-pr-v.end b{color:var(--ink-faint)}",
      ".td-pr-bar{position:relative;height:10px;border-radius:5px;background:var(--line,#e4e7ec)}",
      ".td-pr-avg{position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;background:var(--ink-faint,#8a919c)}",
      ".td-pr-seg{position:absolute;top:3px;height:4px;background:var(--ink-faint,#8a919c)}",
      ".td-pr.up .td-pr-seg{background:#17805a}.td-pr.down .td-pr-seg{background:#c53727}",
      ".td-pr-dot{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;box-sizing:border-box}",
      ".td-pr-dot.now{background:var(--ink,#15181f)}",
      ".td-pr-dot.end{background:var(--panel,#fff);border:3px solid var(--ink-faint)}",
      ".td-pr.up .td-pr-dot.end{border-color:#17805a}.td-pr.down .td-pr-dot.end{border-color:#c53727}",
      ".td-pr-say{grid-column:1/-1;font-size:11px;color:var(--ink-soft,#5b6472)}",
      "@media(max-width:720px){.td-pr{grid-template-columns:1fr 1fr}.td-pr-n,.td-pr-bar{grid-column:1/-1}}",
      /* the detail picker */
      ".td-pick{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0 10px;padding-top:12px;border-top:1px solid var(--line-strong,#d7dbe0)}",
      ".td-pick-l{font:800 11px/1 'Oswald',sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--ink);margin-right:6px}",
      ".td-pick-b{border:1px solid var(--line-strong,#d7dbe0);background:var(--panel,#fff);color:var(--ink);border-radius:8px;",
      "  font:700 11px/1 'Inter',sans-serif;padding:7px 11px;cursor:pointer}",
      ".td-pick-b:hover{border-color:var(--ink)}",
      ".td-pick-b.on{background:var(--ink,#15181f);color:var(--panel,#fff);border-color:var(--ink)}",
      ".td-pick-n{font-size:10.5px;color:var(--ink-faint);margin-left:6px}",
      ".td-detail:empty{display:none}",
      ".td-detail{border:1px solid var(--line-strong,#d7dbe0);border-radius:12px;padding:14px 16px 4px;margin:0 0 18px;background:var(--panel,#fff)}",
      /* the sets: the name next to its numbers, not a screen away from them */
      ".tr-sets{margin-top:6px;padding-top:14px;border-top:1px solid var(--line-strong,#d7dbe0)}",
      ".tr-sets .sx-tablewrap{overflow-x:auto;max-width:100%}",
      ".tr-sets table.sx-table{width:auto;min-width:0;border-collapse:separate;border-spacing:2px 2px}",
      ".tr-sets .sx-table th{padding:4px 8px;white-space:nowrap;text-align:center}",
      ".tr-sets .sx-table th:first-child{text-align:left}",
      ".tr-sets .sx-table td{padding:5px 9px;text-align:center;white-space:nowrap;min-width:74px;border-radius:5px}",
      ".tr-sets .sx-table td:first-child,.tr-sets .sx-table th:first-child{position:sticky;left:0;z-index:1;",
      "  background:var(--panel,#fff);text-align:left;min-width:150px;max-width:210px;overflow:hidden;text-overflow:ellipsis}",
      ".tr-sets .sx-table td:first-child{font:800 12.5px/1.2 'Oswald',sans-serif;letter-spacing:.04em;text-transform:uppercase;",
      "  color:var(--ink);border-right:2px solid var(--ink,#15181f);border-radius:0}",
      ".tr-sets .sx-table tbody tr:hover td{box-shadow:inset 0 2px 0 var(--ink,#15181f),inset 0 -2px 0 var(--ink,#15181f)}",
      ".tr-sets .sx-table tbody tr:hover td:first-child{background:var(--panel-2,#f1f3f5)}",
      /* the band is one cell across the table; left unbreakable, its own length was being
         handed to the first column and pushed every set's numbers a screen away from its name */
      /* and it has to BE a table cell for that: drawn as a flex box it stops spanning the
         table, sits in the first column alone and makes that column as wide as its text */
      ".tr-sets .sx-table tr.tr-bandrow td{display:table-cell}",
      ".tr-sets .sx-table tr.tr-bandrow td:after{display:none}",
      ".tr-sets .sx-table tr.tr-bandrow td{position:static;text-align:left;border:0;border-bottom:1px solid var(--line-strong,#d7dbe0);max-width:none;min-width:0;white-space:normal;padding-top:12px;",
      "  font:800 11px/1 'Oswald',sans-serif;letter-spacing:.14em;color:var(--ink)}",
      ".tr-sets .sx-table tr.tr-bandrow:hover td{box-shadow:none;background:transparent}",
      ".tr-h{display:flex;align-items:baseline;gap:10px}",
      ".tr-no{font:800 10px/1 'Oswald',sans-serif;letter-spacing:.16em;color:var(--ink-faint);",
      "  border:1px solid var(--line-strong);border-radius:5px;padding:4px 6px}",
      ".tr-top{background:var(--panel-2,#f6f7f9);border:1px solid var(--line-strong);",
      "  border-radius:12px;padding:14px 16px;margin:0 0 18px;box-sizing:border-box}",
      ".tr-top .sx-h{margin:0}",
      ".tr-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}",
      ".tr-chip{display:flex;align-items:center;gap:7px;border:1px solid var(--line-strong);",
      "  border-radius:9px;padding:7px 11px;background:var(--panel);font-size:12px;max-width:100%}",
      ".tr-chip-t{font-weight:700;color:var(--ink)}",
      ".tr-chip-n{color:var(--ink-faint);font-size:11px}",
      ".tr-chip.good{border-color:#9ccfb8}.tr-chip.warn{border-color:#e3a79c}",
      ".tr-chip.up{border-color:#9ccfb8}.tr-chip.down{border-color:#e3a79c}",
      ".tr-flag{font-size:11px;line-height:1}",
      ".tr-flag.good,.tr-flag.up{color:#17805a}",
      ".tr-flag.warn,.tr-flag.down{color:#c53727}",
      ".sx-table td.tr-good{color:#17805a;font-weight:800}",
      ".sx-table td.tr-warn{color:#c53727;font-weight:800}",
      ".sx-table td.tr-up{color:#17805a;font-weight:800}",
      ".sx-table td.tr-down{color:#c53727;font-weight:800}",
      /* a rate off too few possessions is printed and left pale: it is a number, not a rate */
      ".sx-table td.tr-thin{color:var(--ink-faint)}",
      ".sx-table tr.tr-tot td{background:rgba(0,0,0,.045);font-weight:800}",
      /* a game a set was never called in: silence, not a nought */
      ".sx-table td.tr-none{color:var(--line-strong)}",
      ".tr-warnline{color:#c53727}",
      ".sx-picker{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}",
      ".sx-picker .sx-sub{margin:0}",
      ".sx-select{font:inherit;font-size:12px;padding:5px 8px;border:1px solid var(--line-strong);border-radius:7px;background:var(--panel);color:var(--ink);max-width:100%}",
      ".sx-warn{font-size:11px;color:var(--alert)}",
      ".sx-err{border:1px solid var(--alert-bd);background:var(--alert-bg);color:var(--alert);border-radius:10px;padding:14px;font-size:12.5px}",
      /* trends & comparison */
      ".cmp-ctr{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 16px}",
      ".cmp-lbl{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}",
      ".cmp-sel{font:inherit;font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;",
      "background:var(--panel);color:var(--ink);max-width:270px}",
      ".cmp-sel:disabled{opacity:.5}",
      ".cmp-chart{display:flex;flex-direction:column;gap:3px}",
      ".cmp-row{display:grid;grid-template-columns:150px 1fr 118px;align-items:center;gap:9px;font-size:11.5px}",
      ".cmp-row.game .cmp-lab{font-weight:800;color:var(--ink)}",
      ".cmp-lab{color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cmp-track{position:relative;height:15px;background:var(--sx-track,rgba(127,127,127,.13));border-radius:4px;overflow:hidden}",
      ".cmp-fill{height:100%;border-radius:4px;background:var(--s3)}",
      ".cmp-fill.s0{background:var(--s0)}.cmp-fill.s1{background:var(--s1)}.cmp-fill.s2{background:var(--s2)}",
      ".cmp-fill.s3{background:var(--s3)}.cmp-fill.s4{background:var(--s4)}.cmp-fill.s5{background:var(--s5)}",
      ".cmp-fill.b0{background:var(--b0)}.cmp-fill.b1{background:var(--b1)}.cmp-fill.b2{background:var(--b2)}",
      ".cmp-fill.b3{background:var(--b3)}.cmp-fill.b4{background:var(--b4)}.cmp-fill.b5{background:var(--b5)}",
      ".cmp-ref{position:absolute;top:0;bottom:0;width:2px;background:#c0392b;opacity:.75;z-index:2}",
      ".cmp-val{text-align:right;color:var(--ink-soft);font-variant-numeric:tabular-nums}",
      ".sx-table td.cmp-up{color:#1e824c;font-weight:700}",
      ".sx-table td.cmp-down{color:#c0392b;font-weight:700}",
      ".sx-table td.cmp-flat{color:var(--ink-soft)}",
      ".sx-empty{font-size:12.5px;color:var(--ink-faint);padding:10px 0}",
      ".sx-table td.sx-zero{color:var(--ink-faint);opacity:.5}",
      /* timeline chart — categorical slots 1-3, validated light and dark */
      /* Seven lines on one chart needs seven hues, and seven picked by eye is how a chart
         ends up unreadable to a colourblind reader. These are the validated set, in fixed
         order, stepped separately for the dark surface rather than flipped: the worst
         adjacent pair clears the CVD floor in both modes. Three of the light ones sit
         under 3:1 against the surface, which is why every series is named in the legend
         and repeated in the table under the chart — identity is never colour alone. */
      ".sx{--tl-1:#2a78d6;--tl-2:#eb6834;--tl-3:#1baf7a;--tl-4:#eda100;--tl-5:#e87ba4;",
      "--tl-6:#008300;--tl-7:#4a3aa7;--tl-grid:rgba(0,0,0,.08);--tl-surface:#fff}",
      "@media (prefers-color-scheme:dark){:root:where(:not([data-theme=\"light\"])) .sx{",
      "--tl-1:#3987e5;--tl-2:#d95926;--tl-3:#199e70;--tl-4:#c98500;--tl-5:#d55181;",
      "--tl-6:#008300;--tl-7:#9085e9;--tl-grid:rgba(255,255,255,.12);--tl-surface:#1a1a19}}",
      ":root[data-theme=\"dark\"] .sx{--tl-1:#3987e5;--tl-2:#d95926;--tl-3:#199e70;",
      "--tl-4:#c98500;--tl-5:#d55181;--tl-6:#008300;--tl-7:#9085e9;",
      "--tl-grid:rgba(255,255,255,.12);--tl-surface:#1a1a19}",
      ".tl-legend{display:flex;flex-wrap:wrap;gap:14px;margin:2px 0 8px;font-size:11.5px;color:var(--ink-soft)}",
      ".tl-lg{display:flex;align-items:center;gap:6px}",
      ".tl-lgk{width:14px;height:3px;border-radius:2px;flex:none}",
      ".tl-lgk.dot{width:10px;height:10px;border-radius:50%}",
      ".tl-undname{font-size:9.5px;font-weight:700;letter-spacing:.04em;font-family:'Inter',sans-serif}",
      ".tl-undrule{stroke:var(--line,#e4e7ec);stroke-width:1}",
      ".tr-count{color:var(--ink,#1b1f24)}",
      ".tr-datelist{margin:6px 0 0 2px;max-height:230px;overflow:auto;font-size:11.5px;line-height:1.7}",
      ".tr-datelist div{white-space:nowrap}",
      "details > summary{cursor:pointer}",
      ".tr-count b{font-weight:700}",
      ".tl-lgkind{gap:5px;color:var(--ink-faint)}",
      ".tl-lgshape{width:9px;height:9px;background:var(--ink-faint);flex:none}",
      ".tl-lgshape.circle{border-radius:50%}",
      ".tl-lgshape.diamond{transform:rotate(45deg)}",
      ".tl-host{position:relative;width:100%}",
      ".tl-svg{display:block;width:100%;overflow:visible}",
      ".tl-grid{stroke:var(--tl-grid);stroke-width:1}",
      ".tl-ref{stroke:#c0392b;stroke-width:1.5;opacity:.8}",
      ".tl-reflab{fill:#c0392b;font-size:10px;font-weight:800}",
      ".tl-reflab-bg{fill:var(--tl-surface);opacity:.92}",
      ".tl-gameline{stroke:var(--tl-grid);stroke-width:1}",
      ".tl-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}",
      ".tl-line.dash{stroke-dasharray:5 4;opacity:.75}",
      ".tl-mk.hollow{stroke-width:2.2}",
      ".tl-band{stroke:var(--tl-grid);stroke-width:1}",
      ".tl-bandlab{fill:var(--ink-faint);font-size:9.5px}",
      ".tl-mk{stroke:var(--tl-surface);stroke-width:2}",
      ".tl-axis{fill:var(--ink-faint);font-size:10px}",
      ".tl-axis.game{fill:var(--ink);font-weight:700}",
      ".tl-dlab{fill:var(--ink-soft);font-size:10.5px;font-weight:700}",
      ".tl-cross{stroke:var(--ink-faint);stroke-width:1;opacity:.5;pointer-events:none}",
      ".tl-hit{cursor:crosshair}",
      ".tl-tip{position:absolute;z-index:5;pointer-events:none;background:var(--panel);color:var(--ink);",
      "border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:11.5px;min-width:150px;",
      "box-shadow:0 6px 18px rgba(0,0,0,.14)}",
      ".tl-th{font-weight:800;margin-bottom:5px}",
      ".tl-trow{display:flex;align-items:center;gap:7px;margin:2px 0}",
      ".tl-tk{width:9px;height:3px;border-radius:2px;flex:none}",
      ".tl-tn{flex:1;color:var(--ink-soft);white-space:nowrap}",
      ".tl-tv{font-weight:800;font-variant-numeric:tabular-nums}",
      ".tl-tf{margin-top:5px;padding-top:5px;border-top:1px solid var(--line);color:var(--ink-faint)}",
      ".tl-tblbtn{margin:6px 0 14px;background:transparent;border:1px solid var(--line);color:var(--ink-soft);",
      "border-radius:6px;padding:5px 10px;font-size:11.5px;cursor:pointer}",
      ".tl-tblbtn:hover{border-color:var(--ink-faint)}",
      ".sx-sec.tl{margin-bottom:26px}",
      /* ---- post-game team stats: the block under "Other" ---------------
         Four levels and each one has to be unmistakably lighter than the one
         above it: the report's own TEAM STATS banner, then the numbered
         category, then the section, then the band inside a section. The shared
         .sx-band is a filled black pill, which outweighs a section title and
         inverts the order — inside this block it is a plain grey label. */
      /* No cap and no auto margins. This block used to be 1000px centred, which on a
         2000px screen left the report in the middle third with the banner stretching
         full width behind it. The measured layout engine decides the columns; the
         wrapper's only job is to be as wide as what it is given. */
      ".sx-post{max-width:none;margin-left:0;margin-right:0;width:100%}",
      ".sx-postwrap{max-width:none;margin-left:0;margin-right:0;width:100%}",
      ".sx-menu{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 6px}",
      /* A chart is a row, never a column. This was a measured multi-column grid for one
         build and it put a "show as table" button in a column beside the chart it belongs
         to, and the "Other trends" rule in a column of its own. A timeline wants every
         pixel of width it can get, so the block is a plain stack and each chart keeps its
         own button and its own table underneath it. */
      ".cmp-out{display:block}",
      ".cmp-out > *{min-width:0}",
      ".cmp-unit{margin:0 0 18px}",
      ".cmp-unit > .tl-tblbtn{margin-top:6px}",
      ".cmp-note{margin:0 0 14px}",
      ".sx-tab{border:1px solid var(--line-strong,#d2d7df);background:transparent;cursor:pointer;border-radius:20px;",
      "padding:4px 13px;font:600 9.5px 'Inter',sans-serif;letter-spacing:.1em;text-transform:uppercase;",
      "color:var(--ink-faint,#8a93a2)}",
      ".sx-tab:hover{border-color:var(--ink-faint,#8a93a2);color:var(--ink)}",
      ".sx-tab.on{background:var(--accent-strong,#a8801a);border-color:var(--accent-strong,#a8801a);color:#fff}",
      /* level 1 — the category */
      ".sx-cat.hide{display:none}",
      "@media print{.sx-cat.hide{display:grid!important}}",
      "body.prt .sx-cat.hide{display:grid!important}",
      /* the same headings and the same switch as the game read from the play by play */
      ".sx-post .sx-menu{gap:4px;padding:4px;border-radius:11px;background:rgba(20,24,33,.05);margin:0 0 4px}",
      ".sx-post .sx-tab{flex:1 1 auto;border:0;border-radius:8px;padding:8px 14px;font:700 11px 'Oswald',sans-serif;letter-spacing:.13em;color:#5b6472}",
      ".sx-post .sx-tab:hover{background:rgba(20,24,33,.07);color:#141821}",
      ".sx-post .sx-tab.on{background:#141821;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)}",
      ".sx-cathead{margin:0!important;border:0!important;padding:0!important;background:transparent!important;box-shadow:none!important}",
      ".sx-cathead .ui-figs{margin-bottom:10px}",
      ".sx-cat{margin-top:26px;display:grid;grid-template-columns:1fr;gap:12px 16px;align-items:start}",
      ".sx-cat > *{min-width:0}",
      ".sx-post .sx-cath{display:flex;align-items:baseline;gap:9px;margin:0;padding-top:12px;",
      "border-top:1px solid var(--line,#e4e7ec);border-bottom:0}",
      ".sx-catno{font:700 10px 'IBM Plex Mono',monospace;letter-spacing:.1em;color:var(--accent-strong,#a8801a)}",
      ".sx-post .sx-catt{font:700 15px 'Oswald',sans-serif;text-transform:uppercase;letter-spacing:.1em;",
      "line-height:1.1;color:var(--ink)}",
      ".sx-post .sx-catn{display:block;max-width:64ch;margin:9px 0 0;font:400 11.5px/1.6 'Inter',sans-serif;",
      "color:var(--ink-faint,#8a93a2)}",
      /* level 2 — the section */
      ".sx-post .sx-sec{margin:26px 0 0}",
      ".sx-post .sx-h{display:flex;align-items:center;gap:8px;font:700 11px 'Inter',sans-serif;",
      "letter-spacing:.13em;text-transform:uppercase;color:var(--ink-soft,#5b6472);margin:0 0 5px}",
      ".sx-post .sx-h:before{content:none}",
      ".sx-post .sx-h{font:700 12px 'Oswald',sans-serif;letter-spacing:.12em;color:#141821;border-bottom:2px solid #141821;padding-bottom:6px;margin-bottom:8px}",
      ".sx-post .sx-cath{border-top:0!important}",
      ".sx-post .sx-catt{font-size:18px!important}",
      ".sx-post .sx-sub{margin:0 0 11px 17px;max-width:64ch;font-size:11px;color:var(--ink-faint,#8a93a2)}",
      /* level 3 — the band inside a section */
      ".sx-post .sx-band{display:flex;align-items:center;gap:9px;background:transparent;color:var(--ink-faint,#8a93a2);",
      "padding:0;margin:15px 0 5px;border-radius:0;font:600 9px 'Inter',sans-serif;letter-spacing:.2em}",
      ".sx-post .sx-band:after{content:'';flex:1;height:1px;background:var(--line,#e4e7ec)}",
      /* a band and what it labels, as one panel */
      ".sx-bgrp{min-width:0}",
      ".sx-bgrp > .sx-band:first-child{margin-top:0}",
      /* tables */
      ".sx-table td.sx-indent{padding-left:18px;font-weight:500;color:var(--ink-soft)}",
      /* small sample: ringed, never dimmed — a good number on five
         possessions still has to be visible */
      ".sx-table td.sx-cell.sx-small{outline:1.5px dotted currentColor;outline-offset:-4px}",
      ".sx-table tr.sx-famrow td{background:transparent;padding-top:10px;padding-bottom:2px}",
      ".sx-table td.sx-famc{font:700 9px 'Inter',sans-serif;letter-spacing:.16em;text-transform:uppercase;",
      "color:var(--accent-strong,#a8801a)}",
      ".sx-post .sx-legend{margin-top:26px;padding-top:10px;border-top:1px solid var(--line,#e4e7ec)}",
      ".sx-gap{border:1px solid var(--gold-2,#b0873c);border-left:4px solid var(--gold-2,#b0873c);",
      "background:var(--accent-soft,#f6efe0);border-radius:9px;padding:11px 14px;margin:0 0 12px;display:grid;gap:5px}",
      ".sx-gap b{font-size:12.5px;color:#7a5a20}",
      ".sx-gap span{font-size:11.5px;color:var(--ink-soft);line-height:1.55}",
      ".sx-foot{display:flex;flex-direction:column;gap:3px;margin-top:10px;",
      "font:400 10px/1.5 'IBM Plex Mono',monospace;color:var(--ink-faint,#8a93a2)}"
    ].join("");
    document.head.appendChild(s);
  }

  /* The status bar of a practice card needs one fact only: is there a tagging
     file for this day. The folder listing is already cached, so after the first
     call this costs nothing. */
  function datesWithFiles(kind) {
    return listFolder(kind || "practice").then(function (files) {
      var m = {};
      (files || []).forEach(function (f) { var d = fileDate(f.name); if (d) m[d] = true; });
      return m;
    }).catch(function () { return {}; });
  }

  function boot() {
    css();
    scan();
    var mo = new MutationObserver(function () { scan(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseCsv: parseCsv, buildGame: buildGame, buildPractice: buildPractice,
                       shotLine: shotLine, touchTable: touchTable, gameTouchTable: gameTouchTable, decodeBytes: decodeBytes,
                       summarise: summarise, addUp: addUp, buildRanges: buildRanges,
                       fileDate: fileDate, findGameFile: findGameFile, practiceFilesInRange: practiceFilesInRange };
  } else if (typeof document !== "undefined") {
    /* published before boot: the written report can mount its block as soon as
       the file is parsed, without waiting for DOMContentLoaded */
    window.LowenPostStats = { mount: mountPostTeam, dropCache: dropCache,
                              gameModel: gameModel, shotLine: shotLine, measured: measured, summarise: summarise,
                              seasonGames: seasonGames, addUp: addUp,
                              datesWithFiles: datesWithFiles,
                              /* the folders as files (name, created), for the video staff's deadlines */
                              files: listFolder, findGameFile: findGameFile, fileDate: fileDate,
                              /* exposed so a report block can be rendered against a
                                 known file without driving the whole page */
                              buildPractice: buildPractice, buildGame: buildGame,
                              renderPractice: renderPractice,
                              /* the table builder and its sort key, so the sorting can be
                                 tested on its own rather than through a whole report */
                              /* and the trend arithmetic, so a projection can be checked
                                 against a series whose answer is known rather than only
                                 through whatever happens to be in Drive */
                              /* the chart and the table, so the league block in the app
                                 can draw its own trend in the same language instead of
                                 inventing a second one */
                              chart: timelineChart, table2: table,
                              _t: { table: table, sortKey: sortKey, linfit: linfit, renderPostTeam: renderPostTeam,
                                    renderTrends: renderTrendsDash, measured: measured, addUp: addUp,
                                    phaseOf: phaseOf,
                                    fitXY: fitXY, oerBands: oerBands,
                                    datedPractice: datedPractice, parseCsv: parseCsv,
                                    fileDate: fileDate, datedGame: datedGame,
                                    fixtureFor: fixtureFor, wordDate: wordDate,
                                    headerDate: headerDate, assignGames: assignGames } };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})();
