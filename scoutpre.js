/* ============================================================================
   Coaches Hub — Opponent scouting (pre game)

   Reads the opponent tagging CSVs straight from the shared Drive folder and
   fills the pre-game TEAM STATS section with the scouting report.

   This is NOT the same tagging vocabulary as our own games. Ours marks C2/M3/
   PAINT TOUCH; the scouting exports mark #LC2/#LM3/#Q1/#O../#D../#J##. So the
   parser, the possession model and the metrics here are their own thing and
   share nothing with stats.js beyond the Drive proxy.

   The one rule that makes the whole report readable:
     their offense  -> a high PPP helps THEM
     their defense  -> a high PPP allowed helps US
   so every number is painted by who it favours, never by its raw size.

   Depends on /.netlify/functions/drive?folder=pregame — the folder the app
   already reads the opponent tagging from. All opponents live in it together
   on purpose: the pooled folder IS the reference each report compares against.
   Self-contained: injects its own CSS, touches no app state.
   ========================================================================= */
(function () {
  "use strict";

  var FN = "/.netlify/functions/drive";
  var FOLDER = "pregame";
  var cacheList = null;
  var cacheFile = {};

  /* Every file read off the Drive stayed in here for the rest of the session - the raw
     bytes of each workbook in one case and every parsed row of each export in the other.
     A coach who works through a dozen reports in an afternoon was holding all twelve.
     They are kept as a short queue now: the newest 6, and the rest let go. Letting one
     go costs a re-download, which is a second; holding them all was costing the tab. */
  var CACHE_MAX = 6, cacheAge = [];
  function cacheKeep(key) {
    var i = cacheAge.indexOf(key);
    if (i >= 0) cacheAge.splice(i, 1);
    cacheAge.push(key);
    while (cacheAge.length > CACHE_MAX) { var old = cacheAge.shift(); delete cacheFile[old]; }
  }
  function cacheForget() { cacheAge.length = 0; }

  /* ================================================================= fetch */

  /* the Drive function wants the session token; the app hands over a fetch that adds it */
  function dfetch(url) {
    return window.LowenDriveFetch ? window.LowenDriveFetch(url) : fetch(url);
  }

  function listFolder() {
    if (!cacheList) {
      cacheList = dfetch(FN + "?folder=" + FOLDER)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.error) throw new Error(j.error);
          return j.files || [];
        })
        /* a failed list must not be cached: one dropped request would leave
           the block dead until the page is reloaded */
        .catch(function (e) { cacheList = null; throw e; });
    }
    return cacheList;
  }

  function dropCache() {
    cacheList = null;
    Object.keys(cacheFile).forEach(function (k) { delete cacheFile[k]; });
    cacheForget();
    if (typeof cacheRep !== "undefined") {
      Object.keys(cacheRep).forEach(function (k) { delete cacheRep[k]; });
    }
  }

  function getBuf(fileId) {
    cacheKeep(fileId);
    if (!cacheFile[fileId]) {
      cacheFile[fileId] = dfetch(FN + "?file=" + encodeURIComponent(fileId))
        .then(function (r) {
          if (!r.ok) {
            return r.json().then(
              function (j) { throw new Error((j && j.error) || "download failed"); },
              function () { throw new Error("download failed"); });
          }
          return r.arrayBuffer();
        })
        .catch(function (e) { delete cacheFile[fileId]; throw e; });
    }
    return cacheFile[fileId];
  }
  function getText(fileId) { return getBuf(fileId).then(decodeBytes); }

  /* ------------------------------------------------- the call sheet (.xlsx)
     A workbook is a ZIP holding XML. The two parts worth having are the shared
     string table and the first worksheet, and the browser already inflates —
     so no library and no CDN, just the twenty lines that read a ZIP directory. */
  function _u16(d, o) { return d[o] | (d[o + 1] << 8); }
  function _u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }
  function zipEntries(buf) {
    var d = new Uint8Array(buf), i = d.length - 22;
    while (i >= 0 && _u32(d, i) !== 0x06054b50) i--;
    if (i < 0) throw new Error("that file is not a workbook");
    var n = _u16(d, i + 10), off = _u32(d, i + 16), out = {}, p = off, k;
    for (k = 0; k < n; k++) {
      if (_u32(d, p) !== 0x02014b50) break;
      var method = _u16(d, p + 10), csize = _u32(d, p + 20), nlen = _u16(d, p + 28),
          elen = _u16(d, p + 30), clen = _u16(d, p + 32), lho = _u32(d, p + 42);
      var name = "", j;
      for (j = 0; j < nlen; j++) name += String.fromCharCode(d[p + 46 + j]);
      out[name] = { start: lho + 30 + _u16(d, lho + 26) + _u16(d, lho + 28), size: csize, method: method };
      p += 46 + nlen + elen + clen;
    }
    return { dir: out, bytes: d };
  }
  function inflateEntry(z, name) {
    var e = z.dir[name];
    if (!e) return Promise.resolve(null);
    var slice = z.bytes.subarray(e.start, e.start + e.size);
    if (e.method === 0) return Promise.resolve(new TextDecoder("utf-8").decode(slice));
    if (typeof DecompressionStream === "undefined")
      return Promise.reject(new Error("this browser cannot open .xlsx — export the calls as .csv"));
    var ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter();
    w.write(slice); w.close();
    return new Response(ds.readable).text();
  }
  function colNum(ref) {
    var n = 0, i = 0, c;
    while (i < ref.length) { c = ref.charCodeAt(i); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); i++; }
    return n - 1;
  }
  function readXlsx(buf) {
    var z = zipEntries(buf);
    var sheet = Object.keys(z.dir).filter(function (k) {
      return /^xl\/worksheets\/sheet\d+\.xml$/.test(k); }).sort()[0];
    if (!sheet) throw new Error("that workbook has no sheet");
    return Promise.all([inflateEntry(z, "xl/sharedStrings.xml"), inflateEntry(z, sheet)])
      .then(function (parts) {
        var P = new DOMParser(), shared = [], rows = [];
        if (parts[0]) {
          Array.prototype.forEach.call(P.parseFromString(parts[0], "application/xml")
            .getElementsByTagName("si"), function (si) {
            var t = "";
            Array.prototype.forEach.call(si.getElementsByTagName("t"), function (x) { t += x.textContent; });
            shared.push(t);
          });
        }
        Array.prototype.forEach.call(P.parseFromString(parts[1], "application/xml")
          .getElementsByTagName("row"), function (r) {
          var cells = [];
          Array.prototype.forEach.call(r.getElementsByTagName("c"), function (c) {
            var ci = colNum(c.getAttribute("r") || ""), ty = c.getAttribute("t") || "";
            var vEl = c.getElementsByTagName("v")[0], val = "", isEl;
            if (ty === "inlineStr") {
              isEl = c.getElementsByTagName("is")[0];
              if (isEl) Array.prototype.forEach.call(isEl.getElementsByTagName("t"),
                function (x) { val += x.textContent; });
            } else if (vEl) { val = (ty === "s") ? (shared[+vEl.textContent] || "") : vEl.textContent; }
            if (ci < 0) ci = cells.length;
            while (cells.length < ci) cells.push("");
            cells.push(String(val).trim());
          });
          rows.push(cells);
        });
        return rows;
      });
  }
  /* ------------------------------------------------- the call sheet (.csv)
     A sheet saved as CSV is not one shape. Google writes commas; Excel on a Spanish or
     German machine writes semicolons, and then a naive split on "," hands back one cell
     per line, no header is found, and the calls come out empty with nobody told. A cell
     may be quoted and hold the separator inside it. And a file saved by Sheets starts
     with a byte-order mark, which glues itself to the first heading.
     So: strip the mark, pick the separator the header row actually uses, and read the
     quotes properly. */
  function csvRows(text) {
    var t = String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var first = t.split("\n")[0] || "";
    var seps = [",", ";", "\t", "|"], sep = ",", best = -1;
    seps.forEach(function (s) {
      /* the separator is the one that cuts the heading into the most pieces */
      var n = first.split(s).length;
      if (n > best) { best = n; sep = s; }
    });
    var rows = [], cell = "", row = [], q = false, i, c;
    for (i = 0; i < t.length; i++) {
      c = t.charAt(i);
      if (q) {
        if (c === '"') { if (t.charAt(i + 1) === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === sep) { row.push(cell.trim()); cell = ""; }
      else if (c === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    row.push(cell.trim());
    if (row.length > 1 || row[0]) rows.push(row);
    return rows;
  }

  /* rows -> { CODE: {call, desc, type} }, the header row found by its columns */
  function parseCalls(rows) {
    var out = {}, hdr = -1, ci = {}, i, j;
    for (i = 0; i < rows.length && hdr < 0; i++) {
      for (j = 0; j < rows[i].length; j++) {
        var h = String(rows[i][j] || "").toLowerCase().trim();
        if (/^code$/.test(h)) ci.code = j;
        else if (/^call$/.test(h)) ci.call = j;
        else if (/^set description$|^description$|^set$/.test(h)) ci.desc = j;
        else if (/^play type$|^type$/.test(h)) ci.type = j;
      }
      if (ci.code !== undefined && ci.call !== undefined) hdr = i; else ci = {};
    }
    if (hdr < 0) return out;
    for (i = hdr + 1; i < rows.length; i++) {
      var r = rows[i];
      var code = String(r[ci.code] || "").replace(/^#/, "").trim().toUpperCase();
      if (!code) continue;
      out[code] = { call: String(r[ci.call] || "").trim(),
                    desc: ci.desc !== undefined ? String(r[ci.desc] || "").trim() : "",
                    type: ci.type !== undefined ? String(r[ci.type] || "").trim() : "" };
    }
    return out;
  }
  /* Everything the read of a call sheet learned, so the page can say it. A silent empty
     is how this cost two days: the folder had the sheet, every row said "no call", and
     nothing anywhere said whether the file was missing, unreadable, or simply keyed with
     codes the tagging has never used. */
  var CALLS_LOG = [];
  function loadCalls(files) {
    CALLS_LOG = [];
    if (!files.length) return Promise.resolve(null);
    return Promise.all(files.map(function (f) {
      return getBuf(f.id).then(function (buf) {
        /* What the file IS, not what it is called. A call sheet written straight in Google
           Sheets has no extension at all — "G10 SEASON Ludwigsburg CALLS" — and comes back
           from Drive as an exported workbook, so a name test sent a zip into the CSV
           reader. Every zip starts PK\u0003\u0004. */
        var head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength || 0));
        var isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
        if (isZip) return readXlsx(buf).then(function (r) { return { rows: r, kind: "workbook" }; });
        var txt = decodeBytes(buf);
        return { rows: csvRows(txt), kind: "csv", bytes: (buf.byteLength || 0) };
      }).then(function (got) {
        var map = parseCalls(got.rows);
        var n = Object.keys(map).length;
        CALLS_LOG.push({ file: f.name, kind: got.kind, rows: got.rows.length, codes: n,
          head: (got.rows[0] || []).join(" | ").slice(0, 90),
          why: n ? "" : (got.rows.length < 2 ? "the file came back with no rows"
            : "no row of headings with both Code and Call in it") });
        return map;
      }).catch(function (e) {
        CALLS_LOG.push({ file: f.name, kind: "?", rows: 0, codes: 0, head: "",
          why: (e && e.message) || String(e) });
        return {};
      });
    })).then(function (maps) {
      var all = {}, any = false;
      maps.forEach(function (m) { Object.keys(m).forEach(function (k) { all[k] = m[k]; any = true; }); });
      return any ? all : null;
    });
  }

  /* The old exports are cp1252, the new ones UTF-8. Strict UTF-8 first. */
  function decodeBytes(buf) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder("windows-1252").decode(buf); }
  }

  /* ================================================== tolerant CSV parsing */
  /* Some exports come back as one single line with no newlines at all. Then the
     only reliable record boundary is a "mm:ss,mm:ss," pair that describes a
     plausible clip: 0 < duration <= 120s, and the tagging advancing in time. */

  var TIME_FULL = /^\d{1,3}:\d{2}$/;

  function secs(t) {
    var m = /(\d{1,3}):(\d{2})/.exec(t || "");
    return m ? (+m[1]) * 60 + (+m[2]) : 0;
  }

  function splitBlob(text) {
    var re = /(\d{1,3}:\d{2}),(\d{1,3}:\d{2}),/g, m;
    var cands = [];
    while ((m = re.exec(text))) {
      cands.push({ p: m.index, t1: m[1], t2: m[2], len: m[0].length });
      re.lastIndex = m.index + 1;          // allow overlapping candidates
    }
    var accepted = [], lastStart = -1e9, pos = 0;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c.p < pos) continue;
      var a = secs(c.t1), b = secs(c.t2);
      if (!(b - a > 0 && b - a <= 120)) continue;
      if (a < lastStart - 60) continue;
      accepted.push(c);
      lastStart = a;
      pos = c.p + c.len;
    }
    var out = [];
    for (var j = 0; j < accepted.length; j++) {
      var s = accepted[j];
      var end = j + 1 < accepted.length ? accepted[j + 1].p : text.length;
      out.push({ t1: s.t1, t2: s.t2, body: text.slice(s.p + s.len, end) });
    }
    return out;
  }

  function parseFile(text) {
    text = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^﻿/, "");
    var rows = [], i, parts;
    var nl = (text.match(/\n/g) || []).length;
    if (nl > 5) {
      var lines = text.split("\n").filter(function (l) { return l.trim(); });
      for (i = 1; i < lines.length; i++) {                 // line 0 is the header
        parts = splitN(lines[i], ",", 4);
        if (parts.length < 3) continue;
        if (!TIME_FULL.test(parts[0].trim())) continue;
        rows.push({ t0: secs(parts[0]), t1: secs(parts[1]),
                    cat: parts[2].trim(), desc: (parts[3] || "").trim() });
      }
    } else {
      splitBlob(text).forEach(function (r) {
        var k = r.body.indexOf(",");
        rows.push({ t0: secs(r.t1), t1: secs(r.t2),
                    cat: (k < 0 ? r.body : r.body.slice(0, k)).trim(),
                    desc: (k < 0 ? "" : r.body.slice(k + 1)).trim() });
      });
    }
    return rows;
  }

  function splitN(s, sep, n) {
    var out = [], from = 0, k;
    while (out.length < n - 1 && (k = s.indexOf(sep, from)) >= 0) {
      out.push(s.slice(from, k)); from = k + sep.length;
    }
    out.push(s.slice(from));
    return out;
  }

  /* ============================================== the tagging vocabulary */

  var PERIOD = { "1Q": "Q1", "2Q": "Q2", "3Q": "Q3", "4Q": "Q4", "PR": "OT" };

  var COVERAGE = {
    "flat": "Flat", "ice": "Ice", "switch": "Switch", "short show": "Short Show",
    "show": "Show", "chase": "Chase", "top lock": "Top Lock", "high flat": "High Flat",
    "late switch": "Late Switch", "bump & recover": "Bump & Recover", "through": "Through",
    "deny + under": "Deny + Under", "next": "Next", "trap": "Trap", "fake show": "Fake Show",
    "plug & hedge": "Plug & Hedge", "push": "Push", "under": "Under", "fire": "Fire"
  };
  var ACTION = {
    "spot up": "Spot Up", "pnr ball handler": "PnR Ball Handler", "pnr roll man": "PnR Roll Man",
    "1n1": "Iso 1n1", "catch & drive": "Catch & Drive", "cut": "Cut", "off screen": "Off Screen",
    "ho": "Hand Off", "pnp": "Pick & Pop", "post up": "Post Up",
    "drive & drop off": "Drive & Drop Off", "duck in": "Duck In", "pass & chase": "Pass & Chase",
    "back pick": "Back Pick", "putback": "Putback"
  };
  var EVENT = {
    "turnover": "Turnover", "foul drawn": "Foul Drawn",
    "offensive rebound": "Offensive Rebound", "out of bounds": "Out of Bounds"
  };
  /* notes the analyst leaves on a clip, not data about the possession */
  var JUNK = { "cp descriptor": 1, "how to attack": 1 };
  var VIDEO = { "video team": 1, "video players": 1 };

  var RE_SHOT = /^([CM])([123])$/;
  var RE_PLAYER_PLAIN = /^(.+?)\s+(\d{1,2})$/;

  /* -> {k:kind, v:value} ; kind: period shot player coverage action event video junk unknown */
  function normTag(raw) {
    var t = String(raw || "").trim();
    if (!t) return null;
    var code = null;
    if (t.charAt(0) === "#") {
      var sp = t.indexOf(" ");
      var head = sp < 0 ? t : t.slice(0, sp);
      var rest = sp < 0 ? "" : t.slice(sp + 1).trim();
      code = head.slice(1);
      t = rest || code;
    }
    var low = t.toLowerCase();
    if (PERIOD[t]) return { k: "period", v: PERIOD[t] };
    if (code && /^Q[1-4]$/.test(code)) return { k: "period", v: code };
    if (code && code.indexOf("DPR1") === 0) return { k: "period", v: "OT" };
    if (RE_SHOT.test(t)) return { k: "shot", v: t };
    if (code && /^J\d+$/.test(code)) return { k: "player", v: t + "|" + code.slice(1) };
    if (VIDEO[low]) return { k: "video", v: t };
    if (JUNK[low]) return { k: "junk", v: t };
    if (COVERAGE[low]) return { k: "coverage", v: COVERAGE[low] };
    if (ACTION[low]) return { k: "action", v: ACTION[low] };
    if (EVENT[low]) return { k: "event", v: EVENT[low] };
    var m = RE_PLAYER_PLAIN.exec(t);
    if (m && !RE_SHOT.test(t)) return { k: "player", v: m[1] + "|" + m[2] };
    return { k: "unknown", v: t };
  }

  var FAM_DEF = [
    /* PF is "Defense Far PnR" — it was missing and it is the only code the
       three real Rostock/Vechta exports carried that nothing here knew. */
    [/^D(PS|PSU|PM1|PM2|PG|PE|PB|PL|PF|P4|TD)$/, "def_pnr"],
    [/^DPA$/, "def_offball"], [/^D(O|H|HE)$/, "def_offball"], [/^BP$/, "def_offball"],
    [/^D(P|D)$/, "def_post"], [/^DB$/, "def_transition"], [/^DR$/, "def_second_chance"],
    [/^D1$/, "def_iso"], [/^DPR$/, "def_press"], [/^DOD$/, "def_other"]
  ];
  var FAM_OFF = [
    [/^FB$/, "off_fastbreak"],
    [/^(TD|TO|TR|TT|TP)$/, "off_early"],
    [/^(ROFQ|ROFL)$/, "off_second_chance"],
    [/^(PS|PSU|PM1|PM2|PG|P4|PE)$/, "off_pnr_direct"],
    [/^(H|S|B)\d/, "off_set"], [/^T\d/, "off_set"], [/^\d[A-Z]$/, "off_set"],
    [/^OOS$/, "off_noset"], [/^PBR$/, "off_press_break"], [/^ATO$/, "off_set"],
    [/^OVZ$/, "off_zone"]
  ];
  var PLAIN_CAT = {
    "balance": ["D", "def_transition", "Defense Balance"],
    "defensive rebound": ["D", "def_second_chance", "Defense 2nd Chance"],
    "other def": ["D", "def_other", "Defense Other"],
    "off screen": ["D", "def_offball", "Defense Off Screens"],
    "ho": ["D", "def_offball", "Defense Hand Off"],
    "post up": ["D", "def_post", "Defense Post Up"],
    "pass & chase": ["D", "def_offball", "Defense Pass & Chase"],
    "1n1 - without ball": ["D", "def_iso", "Defense 1on1"],
    "pnr side defense": ["D", "def_pnr", "Defense PnR Side"],
    "pnr 4 defense": ["D", "def_pnr", "Defense PnR with 4"],
    "pnr empty defense": ["D", "def_pnr", "Defense PnR Empty"],
    "pnr guards defense": ["D", "def_pnr", "Defense PnR Guards"],
    "drag pnr defense": ["D", "def_pnr", "Defense Drag PnR"],
    "step up defense": ["D", "def_pnr", "Defense PnR Step Up"],
    "middle pnr (1) defense": ["D", "def_pnr", "Defense PnR Middle (1)"],
    "middle pnr (2) defense": ["D", "def_pnr", "Defense PnR Middle (2)"],
    "baseline pnr defense": ["D", "def_pnr", "Defense PnR Baseline"],
    "far pnr defense": ["D", "def_pnr", "Defense PnR Far"],
    "last seconds defense": ["D", "def_pnr", "Defense PnR Last Seconds"],
    "spain pnr defense": ["D", "def_pnr", "Defense PnR Spain"],
    "fastbreak": ["O", "off_fastbreak", "Fastbreak"],
    "drag pnr": ["O", "off_early", "Drag PnR"],
    "rim runner": ["O", "off_early", "Rim Runner"],
    "post up transition": ["O", "off_early", "Transition Post Up"],
    "1n1 early offense": ["O", "off_early", "Transition 1n1"],
    "out of sets": ["O", "off_noset", "Out Of Sets"],
    "rof q": ["O", "off_second_chance", "ROF Q"],
    "rof l": ["O", "off_second_chance", "ROF L"],
    "press break": ["O", "off_press_break", "Press Break"],
    "ato": ["O", "off_set", "ATO"],
    "pnr with 4": ["O", "off_pnr_direct", "PnR with 4"],
    "pnr guards": ["O", "off_pnr_direct", "PnR Guards"],
    "side pnr": ["O", "off_pnr_direct", "PnR Side"],
    "step up pnr": ["O", "off_pnr_direct", "PnR Step Up"],
    "middle pnr (1)": ["O", "off_pnr_direct", "PnR Middle 1"],
    "middle pnr (2)": ["O", "off_pnr_direct", "PnR Middle 2"],
    "empty pnr": ["O", "off_pnr_direct", "PnR Empty"],
    "offense vs zone": ["O", "off_zone", "Offense vs Zone"]
  };

  /* -> {side, fam, code, label} */
  function normCat(raw) {
    var t = String(raw || "").trim();
    var code = null, label = t, i;
    if (t.charAt(0) === "#") {
      var sp = t.indexOf(" ");
      var head = sp < 0 ? t : t.slice(0, sp);
      code = head.slice(1);
      label = (sp < 0 ? "" : t.slice(sp + 1).trim()) || code;
    } else {
      var low = t.toLowerCase();
      if (PLAIN_CAT[low]) {
        return { side: PLAIN_CAT[low][0], fam: PLAIN_CAT[low][1], code: null, label: PLAIN_CAT[low][2] };
      }
      var m = /^([A-Z]{1,2}\d[A-Z]?)\s+(.*)$/.exec(t);
      if (m) { code = m[1]; label = m[2]; }
      else return { side: "?", fam: "unknown", code: null, label: t };
    }
    for (i = 0; i < FAM_DEF.length; i++) if (FAM_DEF[i][0].test(code)) return { side: "D", fam: FAM_DEF[i][1], code: code, label: label };
    for (i = 0; i < FAM_OFF.length; i++) if (FAM_OFF[i][0].test(code)) return { side: "O", fam: FAM_OFF[i][1], code: code, label: label };
    return { side: "?", fam: "unknown", code: code, label: label };
  }

  /* ==================================================== events and chains */

  var PTS = { C1: 1, C2: 2, C3: 3, M1: 0, M2: 0, M3: 0 };

  function buildEvents(rows, game) {
    return rows.map(function (r, i) {
      var c = normCat(r.cat);
      var e = { game: game, i: i, t0: r.t0, t1: r.t1,
                side: c.side, fam: c.fam, code: c.code, label: c.label,
                period: null, shots: [], players: [], cov: [], acts: [], events: [],
                unknown: [], video: false };
      String(r.desc || "").split(" - ").forEach(function (d) {
        var n = normTag(d);
        if (!n) return;
        if (n.k === "period") e.period = n.v;
        else if (n.k === "shot") e.shots.push(n.v);
        else if (n.k === "player") e.players.push(n.v);
        else if (n.k === "coverage") e.cov.push(n.v);
        else if (n.k === "action") e.acts.push(n.v);
        else if (n.k === "event") e.events.push(n.v);
        else if (n.k === "video") e.video = true;
        else if (n.k === "unknown") e.unknown.push(n.v);
      });
      return e;
    });
  }

  /* An offensive rebound does not open a new possession: the second-chance
     family continues the chain it belongs to. */
  function chains(evs, side) {
    var out = [], byGame = {};
    evs.forEach(function (e) {
      if (e.side !== side) return;
      (byGame[e.game] || (byGame[e.game] = [])).push(e);
    });
    var scFam = side === "O" ? "off_second_chance" : "def_second_chance";
    Object.keys(byGame).forEach(function (g) {
      var seq = byGame[g].slice().sort(function (a, b) { return a.i - b.i; });
      var cur = null;
      seq.forEach(function (e) {
        var cont = cur && e.fam === scFam &&
          cur[cur.length - 1].events.indexOf("Offensive Rebound") >= 0;
        if (cont) cur.push(e);
        else { if (cur) out.push(cur); cur = [e]; }
      });
      if (cur) out.push(cur);
    });
    return out;
  }

  function chainStats(ch) {
    var o = { pts: 0, fga: 0, fgm: 0, fta: 0, fg3a: 0, fg3m: 0, orb: 0, tov: false, nEv: ch.length };
    ch.forEach(function (e) {
      if (e.events.indexOf("Turnover") >= 0) o.tov = true;
      if (e.events.indexOf("Offensive Rebound") >= 0) o.orb++;
      e.shots.forEach(function (s) {
        o.pts += PTS[s] || 0;
        if (s === "C1" || s === "M1") { o.fta++; return; }
        o.fga++;
        if (s === "C2" || s === "C3") o.fgm++;
        if (s === "C3" || s === "M3") { o.fg3a++; if (s === "C3") o.fg3m++; }
      });
    });
    return o;
  }

  /* ================================================================ metrics */

  var BASE_2P = 0.534, BASE_3P = 0.361, BASE_FT = 0.714;

  /* Deterministic PRNG so the confidence interval does not wobble between
     reloads of the same data. */
  function rng(seed) {
    var s = seed >>> 0;
    if (!s) s = 1;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function agg(chs) {
    var n = chs.length;
    if (!n) return null;
    var s = chs.map(chainStats);
    var pts = 0, fga = 0, fgm = 0, fta = 0, orb = 0, f3a = 0, f3m = 0, tov = 0;
    s.forEach(function (x) {
      pts += x.pts; fga += x.fga; fgm += x.fgm; fta += x.fta;
      orb += x.orb; f3a += x.fg3a; f3m += x.fg3m; if (x.tov) tov++;
    });
    var f2a = fga - f3a, f2m = fgm - f3m;
    var poss = fga - orb + tov + 0.44 * fta;
    var xpts = f2a * 2 * BASE_2P + f3a * 3 * BASE_3P + fta * BASE_FT;
    var lo = NaN, hi = NaN;
    if (n >= 8) {
      var r = rng(11 + n * 2654435761), ms = [], k, j, idx, p, pp;
      for (k = 0; k < 3000; k++) {
        var afga = 0, aorb = 0, atov = 0, afta = 0, apts = 0;
        for (j = 0; j < n; j++) {
          idx = (r() * n) | 0; p = s[idx];
          afga += p.fga; aorb += p.orb; afta += p.fta; apts += p.pts; if (p.tov) atov++;
        }
        pp = afga - aorb + atov + 0.44 * afta;
        if (pp > 0) ms.push(apts / pp);
      }
      if (ms.length) {
        ms.sort(function (a, b) { return a - b; });
        lo = ms[Math.floor(0.025 * ms.length)];
        hi = ms[Math.floor(0.975 * ms.length)];
      }
    }
    return {
      n: n, poss: poss, pts: pts,
      ppp: poss > 0 ? pts / poss : 0,
      xppp: poss > 0 ? xpts / poss : 0,
      ciLo: lo, ciHi: hi,
      fga: fga, fgm: fgm, f3a: f3a, f3m: f3m, f2a: f2a, f2m: f2m, fta: fta, orb: orb, tov: tov,
      efg: fga ? (fgm + 0.5 * f3m) / fga : 0,
      p3r: fga ? f3a / fga : 0,
      p3: f3a ? f3m / f3a : 0,
      p2: f2a ? f2m / f2a : 0,
      ftr: fga ? fta / fga : 0,
      tovr: poss > 0 ? tov / poss : 0,
      orbr: (fga - fgm) > 0 ? orb / (fga - fgm) : 0
    };
  }

  /* ============================================== buckets and orientation */

  function gO(c) {
    var f = c[0].fam, code = c[0].code || "";
    if (f === "off_set") {
      /* Oriol's coding: an S code is a sideline inbound, a B code a baseline
         one. Everything else with a set called is a half court set. */
      if (code.charAt(0) === "S") return "SLOB";
      if (code.charAt(0) === "B") return "BLOB";
      if (code === "ATO" || c[0].label === "ATO") return "ATO";
      return "Half Court Set";
    }
    return ({ off_pnr_direct: "Final Possession", off_early: "Early Offense",
      off_fastbreak: "Fastbreak", off_noset: "Out of Sets",
      off_press_break: "Press Break", off_second_chance: "Second Chance",
      off_zone: "Vs Zone" })[f] || f;
  }
  var GD = { def_pnr: "Ball screen", def_offball: "Off-ball screens", def_iso: "On-ball 1on1",
    def_transition: "Transition / balance", def_second_chance: "Defensive rebound",
    def_post: "Post defense", def_press: "Full court press", def_other: "Other" };
  function gD(c) { return GD[c[0].fam] || c[0].fam; }

  function uniq(ch, key) {
    var seen = {}, out = [];
    ch.forEach(function (e) { e[key].forEach(function (v) { if (!seen[v]) { seen[v] = 1; out.push(v); } }); });
    return out;
  }
  function covOf(c) { return uniq(c, "cov"); }
  function actOf(c) { return uniq(c, "acts"); }
  function plOf(c) { return uniq(c, "players"); }
  function perOf(c) {
    for (var i = 0; i < c.length; i++) if (c[i].period) return c[i].period;
    return null;
  }
  function firstAct(c) { var a = actOf(c).slice().sort(); return a.length ? a[0] : null; }
  function firstCov(c) { var a = covOf(c).slice().sort(); return a.length ? a[0] : null; }

  /* WHICH BIG IS IN THE BALL SCREEN.
     The only thing the tagging says about personnel on a ball screen is the category
     itself: "Pick And Roll with 4" (DP4) and "PnR Guards" (DPG) name who is in it, and
     every other ball-screen category - Side, Middle, Empty, Drag, Step Up, Baseline,
     Far, Spain - names where the screen was, not who defended it. The descriptors carry
     no defender either: a player tag appears on well under a third of the defensive ball
     screens, and the man tagged is whoever did something worth a clip, not necessarily
     the one on the screen.
     So a possession is "4" when the analyst marked it so, "guards" when marked so, and
     otherwise unmarked. Unmarked is the five in this tagging convention - DP4 is used as
     the exception - but it is the convention saying it and not the clip, which is why the
     unmarked ones keep their own row and the report says what it is doing. */
  /* The staff tag it this way: "PnR 4" means their 4 is the one defending the screen, and
     everything else is the 5 about nine times in ten. So the second row is named as the
     five rather than as an absence, and the one in ten it is not is in the hover. */
  var BIG_LABEL = { "4": "Defended by their 4", "5": "Defended by their 5", "G": "Two guards" };
  var BIG_ORDER = { "4": 0, "5": 1, "G": 2 };
  function bigOf(c) {
    var e = c[0] || {}, code = String(e.code || ""), lab = String(e.label || "").toLowerCase();
    if (code === "DP4" || /with\s*4|pnr\s*4/.test(lab)) return "4";
    if (code === "DPG" || /guard/.test(lab)) return "G";
    return "5";
  }
  function bigLbl(c) { return BIG_LABEL[bigOf(c)]; }
  /* the coverages a set of possessions carries, most used first */
  function covKeysOf(chs) {
    var n = {}, ks = [];
    chs.forEach(function (c) { covOf(c).forEach(function (k) {
      if (!n[k]) { n[k] = 0; ks.push(k); } n[k]++; }); });
    return ks.sort(function (a, b) { return n[b] - n[a]; });
  }

  var OPEN_FAMS = { off_early: 1, off_fastbreak: 1 };

  function bucket(chs, keyfn) {
    var b = {}, order = [];
    chs.forEach(function (c) {
      var k = keyfn(c);
      if (k == null) return;
      var arr = Array.isArray(k) ? k : [k];
      arr.forEach(function (x) {
        if (x == null) return;
        if (!b[x]) { b[x] = []; order.push(x); }
        b[x].push(c);
      });
    });
    return { map: b, keys: order };
  }

  function refmap(chs, keyfn, minposs) {
    minposs = minposs == null ? 20 : minposs;
    var g = bucket(chs, keyfn), out = {};
    g.keys.forEach(function (k) {
      var a = agg(g.map[k]);
      if (a && a.poss >= minposs) out[k] = a.ppp;
    });
    return out;
  }

  function conf(poss) { return poss >= 25 ? 3 : (poss >= 15 ? 2 : 1); }

  function r2(v) { return Math.round(v * 100) / 100; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function rp(v) { return Math.round(v * 100); }

  function R(label, a, side, ref, total) {
    if (!a) return null;
    var r = { label: label, n: a.n, poss: r1(a.poss), ppp: r2(a.ppp), xppp: r2(a.xppp),
      efg: rp(a.efg), p3r: rp(a.p3r), p2: rp(a.p2), p3: rp(a.p3),
      tov: rp(a.tovr), ftr: rp(a.ftr), conf: conf(a.poss), side: side };
    if (a.ciLo === a.ciLo) r.ci = [r2(a.ciLo), r2(a.ciHi)];
    if (ref != null) {
      r.ref = r2(ref);
      r.edge = Math.round(((side === "O" ? ref - a.ppp : a.ppp - ref)) * 1000) / 1000;
    }
    if (total) r.freq = Math.round(a.n / total * 100);
    return r;
  }

  function group(chs, keyfn, side, refs, total, minn) {
    minn = minn || 1;
    var g = bucket(chs, keyfn), tot = total || chs.length, out = [];
    g.keys.forEach(function (k) {
      if (g.map[k].length < minn) return;
      var r = R(k, agg(g.map[k]), side, (refs || {})[k], tot);
      if (r) out.push(r);
    });
    out.sort(function (a, b) { return b.poss - a.poss; });
    return out;
  }

  /* ============================================================ the report */

  /* Four blocks, and they stay four whatever the table is sorted by: open
     court, half court, and the two inbound families on their own. */
  var ORIGIN_BAND = {
    "Fastbreak": ["Open court", "Fastbreak"],
    "Early Offense": ["Open court", "Early offense"],
    "Press Break": ["Open court", "Press break"],
    "Half Court Set": ["Half court", "Called set"],
    "Final Possession": ["Half court", "Ball screen, no call"],
    "Out of Sets": ["Half court", "No structure"],
    "Vs Zone": ["Half court", "Vs zone"],
    "ATO": ["Half court", "After timeout"],
    "SLOB": ["SLOB", "Sideline"],
    "BLOB": ["BLOB", "Baseline"]
  };
  var BANDS = ["Open court", "Half court", "SLOB", "BLOB"];
  /* the order the origins are read in, everywhere they are listed */
  var ORIGIN_ORDER = ["Fastbreak", "Early Offense", "Half Court Set", "SLOB", "BLOB",
    "Final Possession", "Out of Sets", "Vs Zone", "ATO", "Press Break", "Second Chance"];
  function originRank(k) {
    var i = ORIGIN_ORDER.indexOf(k);
    return i < 0 ? ORIGIN_ORDER.length : i;
  }
  var ROLES = ["PnR Ball Handler", "Iso 1n1", "Spot Up", "Off Screen", "Hand Off",
    "Catch & Drive", "PnR Roll Man", "Pick & Pop", "Cut", "Post Up", "Putback"];

  /* games:    [{game:<rival label>, evs:[...]}]  the opponent being scouted
     refGames: the same shape for EVERY file in the folder — the reference  */
  function buildReport(teamName, games, refGames) {
    var evs = [], refEvs = [];
    games.forEach(function (g) { evs = evs.concat(g.evs); });
    refGames.forEach(function (g) { refEvs = refEvs.concat(g.evs); });

    var OFF = chains(evs, "O"), DEF = chains(evs, "D");
    var ALL_O = chains(refEvs, "O"), ALL_D = chains(refEvs, "D");
    var GAMES = games.map(function (g) { return g.game; });
    var NG = GAMES.length;
    var D = {};

    var REF_O = refmap(ALL_O, gO);
    var REF_D = refmap(ALL_D, gD);
    var REF_COV = refmap(ALL_D.filter(function (c) { return c[0].fam === "def_pnr"; }), covOf);
    var REF_BIG = refmap(ALL_D.filter(function (c) { return c[0].fam === "def_pnr"; }), bigLbl);
    var REF_ACT_O = refmap(ALL_O, firstAct);
    var REF_ACT_D = refmap(ALL_D, firstAct);
    var REF_TOV = {};
    var gdb = bucket(ALL_D, gD);
    gdb.keys.forEach(function (k) {
      var a = agg(gdb.map[k]);
      if (a && a.poss >= 20) REF_TOV[k] = a.tovr * 100;
    });
    var A_ALL_O = agg(ALL_O), A_ALL_D = agg(ALL_D);
    var ao = agg(OFF), ad = agg(DEF);
    if (!ao || !ad || !A_ALL_O || !A_ALL_D) return null;

    /* -------------------------------------------------------- 1. identity */
    function panel(a, side) {
      return { ppp: r2(a.ppp), ci: [r2(a.ciLo), r2(a.ciHi)], xppp: r2(a.xppp),
        luck: r2(a.ppp - a.xppp), poss: r1(a.poss),
        efg: rp(a.efg), p2: rp(a.p2), p3: rp(a.p3), tov: rp(a.tovr), ftr: rp(a.ftr),
        s2: a.fga ? Math.round(a.f2a / a.fga * 100) : 0,
        s3: a.fga ? Math.round(a.f3a / a.fga * 100) : 0,
        f2a: a.f2a, f3a: a.f3a, fta: a.fta, side: side };
    }
    D.panelOff = panel(ao, "O"); D.panelDef = panel(ad, "D");
    D.panelRefOff = panel(A_ALL_O, "O"); D.panelRefDef = panel(A_ALL_D, "D");

    /* --------------------------------------------------- 2. game by game */
    var rows = [];
    GAMES.forEach(function (g) {
      var o = agg(OFF.filter(function (c) { return c[0].game === g; }));
      var d = agg(DEF.filter(function (c) { return c[0].game === g; }));
      if (!o || !d) return;
      rows.push({ label: g, oPoss: r1(o.poss), oPpp: r2(o.ppp), oXppp: r2(o.xppp),
        oEfg: rp(o.efg), o3r: rp(o.p3r), oTov: rp(o.tovr),
        dPoss: r1(d.poss), dPpp: r2(d.ppp), dXppp: r2(d.xppp),
        dEfg: rp(d.efg), d3r: rp(d.p3r), dTov: rp(d.tovr),
        net: r2(o.ppp - d.ppp) });
    });
    var WORD = { 1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE", 6: "SIX" };
    rows.push({ label: "ALL " + (WORD[NG] || NG) + " GAMES", total: true,
      oPoss: r1(ao.poss), oPpp: r2(ao.ppp), oXppp: r2(ao.xppp),
      oEfg: rp(ao.efg), o3r: rp(ao.p3r), oTov: rp(ao.tovr),
      dPoss: r1(ad.poss), dPpp: r2(ad.ppp), dXppp: r2(ad.xppp),
      dEfg: rp(ad.efg), d3r: rp(ad.p3r), dTov: rp(ad.tovr),
      net: r2(ao.ppp - ad.ppp) });
    D.gamebygame = rows;

    /* ------------------------------------------- 3. half court/open court */
    function courtO(c) { return OPEN_FAMS[c[0].fam] ? "Open court" : "Half court"; }
    function courtD(c) { return c[0].fam === "def_transition" ? "Open court" : "Half court"; }
    D.court = group(OFF, courtO, "O", refmap(ALL_O, courtO));
    D.courtDef = group(DEF, courtD, "D", refmap(ALL_D, courtD));

    /* ------------------------------------------------------- 4. quarters */
    var qrows = [];
    GAMES.forEach(function (g) {
      ["Q1", "Q2", "Q3", "Q4"].forEach(function (q) {
        var o = agg(OFF.filter(function (c) { return c[0].game === g && perOf(c) === q; }));
        var d = agg(DEF.filter(function (c) { return c[0].game === g && perOf(c) === q; }));
        if (!o || !d) return;
        qrows.push({ game: g, q: q, oPoss: r1(o.poss), oPpp: r2(o.ppp),
          dPoss: r1(d.poss), dPpp: r2(d.ppp), net: r2(o.ppp - d.ppp),
          conf: conf(Math.min(o.poss, d.poss)) });
      });
    });
    D.quarters = qrows;

    /* ------------------------------------------------- 5. how they attack */
    D.mix = group(OFF.filter(function (c) { return gO(c) !== "Second Chance"; }),
      gO, "O", REF_O, OFF.length);
    D.finish = group(OFF, firstAct, "O", REF_ACT_O, OFF.length, 3);

    var sc = OFF.filter(function (c) { return c.length > 1; });
    var orb = 0;
    OFF.forEach(function (c) { c.forEach(function (e) { if (e.events.indexOf("Offensive Rebound") >= 0) orb++; }); });
    var scpts = 0; sc.forEach(function (c) { scpts += agg([c]).pts; });
    var refsc = ALL_O.filter(function (c) { return c.length > 1; });
    var refpts = 0; refsc.forEach(function (c) { refpts += agg([c]).pts; });
    D.second = { orb: orb, chains: sc.length, pts: scpts,
      ppp: r2(scpts / Math.max(1, sc.length)),
      refPpp: r2(refpts / Math.max(1, refsc.length)),
      orbRate: Math.round(100 * orb / Math.max(1, ao.fga - ao.fgm)) };

    var byq = {}, qtot = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    OFF.forEach(function (c) {
      var k = gO(c), p = perOf(c);
      /* a second chance is a possession continuing, not an origin they called —
         the same reason the mix table leaves it out */
      if (k === "Second Chance") return;
      if (!byq[k]) byq[k] = { label: k, Q1: 0, Q2: 0, Q3: 0, Q4: 0, n: 0 };
      byq[k].n++;
      if (p && byq[k][p] !== undefined) { byq[k][p]++; qtot[p]++; }
    });
    /* Read in the order the game is played, not by volume: fastbreak, early
       offense, half court set, the two inbounds, then the rest. Nothing is
       filtered out — an origin they used twice is still an origin they used. */
    D.usequarter = {
      rows: Object.keys(byq).map(function (k) { return byq[k]; })
        .sort(function (a, b) {
          var d = originRank(a.label) - originRank(b.label); if (d) return d;
          return b.n - a.n;
        }),
      qtot: qtot };

    /* ----------------------------------------------- the single playbook */
    var pb = {}, pbOrder = [];
    OFF.forEach(function (c) {
      var o = gO(c);
      if (o === "Second Chance") return;
      var name;
      if (o === "Vs Zone") name = "Offense vs zone";
      else if (o === "Early Offense") name = c[0].label || "Early offense";
      else if (o === "Fastbreak") name = "Fastbreak";
      else if (o === "Out of Sets") name = "No structure";
      else if (o === "Press Break") name = "Press break";
      else if (o === "ATO") name = "ATO";
      else name = ((c[0].code || "") + " " + (c[0].label || "")).trim();
      var key = o + "\u0000" + name;
      if (!pb[key]) { pb[key] = { o: o, name: name, chs: [] }; pbOrder.push(key); }
      pb[key].chs.push(c);
    });
    /* Nothing is folded away any more. A set called once is a set they have,
       and the coach decides whether it matters — the table says how often it
       was called and leaves the PPP uncoloured, which is the honest version of
       hiding it. */
    var pbrows = pbOrder.map(function (key) {
      var it = pb[key], a = agg(it.chs);
      var ends = {}, eo = [];
      it.chs.forEach(function (c) { actOf(c).forEach(function (x) { if (!ends[x]) { ends[x] = 0; eo.push(x); } ends[x]++; }); });
      eo.sort(function (x, y) { return ends[y] - ends[x]; });
      var bk = ORIGIN_BAND[it.o] || ["Half court", it.o];
      var code = (it.name.match(/^([A-Z]{1,2}\d[A-Z]?)\b/) || [])[1] || "";
      return { band: bk[0], kind: bk[1], label: it.name.slice(0, 58), code: code,
        origin: it.o, n: it.chs.length,
        poss: r1(a.poss), ppp: r2(a.ppp), xppp: r2(a.xppp), efg: rp(a.efg),
        p3r: rp(a.p3r), conf: conf(a.poss),
        end1: eo.length ? eo[0] : "",
        ends: eo.slice(0, 3).map(function (k) { return k + " " + ends[k]; }) };
    });

    /* The two red flags. Volume is read straight off the calls. "Best" is only
       read among sets called at least three times: one made three on a single
       call is a 3.00 that would otherwise own the top of the list and tell the
       staff nothing. */
    var PB_MIN_FLAG = 3, TOP_USE = 5, TOP_PPP = 7;
    /* Four rows in this table are not plays but buckets — a fastbreak, a
       broken possession, whatever they run against zone, a press break. Left in
       the ranking they take the flags and say nothing: "they fastbreak a lot"
       is the mix table's job. They stay in the table, they just do not compete
       for the marks. */
    var PB_BUCKET = { "Fastbreak": 1, "Out of Sets": 1, "Vs Zone": 1, "Press Break": 1 };
    var flagable = pbrows.filter(function (r) { return !PB_BUCKET[r.origin]; });
    flagable.slice().sort(function (a, b) { return b.n - a.n || b.poss - a.poss; })
      .slice(0, TOP_USE).forEach(function (r) { r.flagUse = true; });
    flagable.filter(function (r) { return r.n >= PB_MIN_FLAG; })
      .sort(function (a, b) { return b.ppp - a.ppp || b.n - a.n; })
      .slice(0, TOP_PPP).forEach(function (r) { r.flagPpp = true; });

    pbrows.sort(function (a, b) {
      var d = BANDS.indexOf(a.band) - BANDS.indexOf(b.band); if (d) return d;
      return b.n - a.n;
    });
    D.playbook = pbrows;
    D.playbookTotal = OFF.length;
    D.playbookFlags = { use: TOP_USE, ppp: TOP_PPP, min: PB_MIN_FLAG };

    /* ------------------------------------------------ 6. how they defend */
    D.defsit = group(DEF, gD, "D", REF_D, 0, 3);
    var pn = DEF.filter(function (c) { return c[0].fam === "def_pnr"; });
    D.coverage = group(pn, covOf, "D", REF_COV, pn.length, 3);
    D.generate = group(DEF, firstAct, "D", REF_ACT_D, DEF.length, 3);

    /* the 4 against the 5, as far as the tagging goes — see bigOf */
    var pn4 = pn.filter(function (c) { return bigOf(c) === "4"; });
    var pnG = pn.filter(function (c) { return bigOf(c) === "G"; });
    D.covbig = group(pn, bigLbl, "D", REF_BIG, pn.length, 1)
      .sort(function (a, b) {
        var ra = BIG_ORDER[a.label === BIG_LABEL["4"] ? "4" : (a.label === BIG_LABEL.G ? "G" : "5")];
        var rb = BIG_ORDER[b.label === BIG_LABEL["4"] ? "4" : (b.label === BIG_LABEL.G ? "G" : "5")];
        return ra - rb;
      });
    /* and how each of them is covered, which is the whole question: a team that drops
       with the five and switches with the four is two different defenses */
    D.covbig.forEach(function (r) {
      var key = r.label === BIG_LABEL["4"] ? "4" : (r.label === BIG_LABEL.G ? "G" : "5");
      var v = pn.filter(function (c) { return bigOf(c) === key; });
      var m = {}, ks = [];
      v.forEach(function (c) { covOf(c).forEach(function (k) { if (!m[k]) { m[k] = 0; ks.push(k); } m[k]++; }); });
      ks.sort(function (a, b) { return m[b] - m[a]; });
      r.mix = ks.slice(0, 4).map(function (k) { return k + " " + m[k]; }).join(" · ");
      r.mixMore = Math.max(0, ks.length - 4);
      r.nTagged = v.filter(function (c) { return covOf(c).length; }).length;
      r.nAll = v.length;
    });
    D.big4n = pn4.length;
    D.bigGn = pnG.length;
    /* every table in this group carries the same extra column: of these possessions,
       how many were the ones marked as the 4 */
    var pn5 = pn.filter(function (c) { return bigOf(c) === "5"; });
    /* The column beside these is possessions, not clips — a weighted number that is not
       the same as how many times the thing was tagged. Counting clips here put a 40 next
       to a 37 in the same row, which reads as a mistake because it is one: a split has to
       be in the unit of the thing it splits. */
    var possOf = function (v) { var a = v.length ? agg(v) : null; return a ? Math.round(a.poss) : 0; };
    D.coverage.forEach(function (r) {
      var inCov = function (c) { return covOf(c).indexOf(r.label) >= 0; };
      r.n4 = possOf(pn4.filter(inCov));
      r.n5 = possOf(pn5.filter(inCov));
    });

    /* AND THE SAME TABLE READ SIDEWAYS: each coverage under each big, with what it costs
       them. Two counts in the coverage table say how often; this says how well, which is
       the whole reason to ask who is in the screen — a team that drops with the five and
       switches with the four is two defenses, and the PPP is where that shows. */
    var bigCols = [["4", pn4], ["5", pn5]];
    var cellFor = function (v) {
      var a = v.length ? agg(v) : null;
      return { n: v.length, poss: a ? r1(a.poss) : 0, ppp: a ? a.ppp : null,
               conf: conf(a ? a.poss : 0) };
    };
    /* the reference travels with the row: the table is drawn in another scope */
    var refPnrAll = (function () {
      var a = agg(ALL_D.filter(function (c) { return c[0].fam === "def_pnr"; }));
      return a && a.poss >= 20 ? a.ppp : null;
    })();
    var bigTot = bigCols.map(function (b) { return cellFor(b[1]); });
    /* WHO IS IN THOSE CLIPS. The split says "their 4" and "their 5" and names nobody,
       because the tagging does not: the 4 is a category and the 5 is everything else.
       What the clips do carry, on some of them, is a player tag - so for each side of
       the split this lists the men tagged and how often, how many clips name nobody,
       and every clip with its game, quarter and time, to be checked against the video. */
    var clock = function (s) { s = Math.max(0, Math.round(Number(s) || 0));
      var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
      return (hh ? hh + ":" + (mm < 10 ? "0" : "") : "") + mm + ":" + (ss < 10 ? "0" : "") + ss; };
    D.bigwho = bigCols.map(function (b) {
      var v = b[1], m = {}, ks = [], tagged = 0;
      v.forEach(function (c) { var ps = plOf(c); if (ps.length) tagged++;
        ps.forEach(function (p) { if (!m[p]) { m[p] = []; ks.push(p); } m[p].push(c); }); });
      ks.sort(function (x, y) { return m[y].length - m[x].length; });
      return { key: b[0], n: v.length, tagged: tagged,
        players: ks.map(function (p) { var a = agg(m[p]);
          return { label: p.replace("|", " #"), n: m[p].length,
                   poss: a ? r1(a.poss) : 0, ppp: a ? a.ppp : null, conf: conf(a ? a.poss : 0) }; }),
        clips: v.map(function (c) { var a = agg([c]);
          return { game: c[0].game, period: perOf(c) || "", at: clock(c[0].t0), cat: c[0].label || "",
                   cov: covOf(c).join(", "), who: plOf(c).map(function (p) { return p.replace("|", " #"); }).join(", "),
                   pts: a ? Math.round(a.ppp * a.poss * 10) / 10 : null }; }) };
    });
    D.covbybig = {
      total: bigTot,
      totalRef: refPnrAll,
      rows: covKeysOf(pn).map(function (k) {
        var cells = bigCols.map(function (b, j) {
          var c = cellFor(b[1].filter(function (x) { return covOf(x).indexOf(k) >= 0; }));
          /* out of everything THAT big defends, not out of the whole table: four
             possessions beside thirty-seven is not a comparison until both are shares */
          c.share = bigTot[j].poss ? Math.round(100 * c.poss / bigTot[j].poss) : null;
          return c;
        });
        if (!cells.some(function (x) { return x.n; })) return null;
        return { label: k, ref: (REF_COV[k] == null ? null : REF_COV[k]), cells: cells };
      }).filter(Boolean)
    };

    /* ---------------------------------------------- the same screens, game by game
       The coverage table says what each coverage costs them over the whole sample, and
       a season average hides the night somebody took one apart. This is the same
       numbers with the rival on the row: read across and you see how that opponent did
       against each coverage; read down a column and you see whether one of them is
       where everybody gets their points. */
    (function () {
      /* buildEvents already stamps every event with the file it came from, so the
         chains carry it: nothing new had to be threaded through for this. */
      var gameOf = function (c) { return (c && c[0] && c[0].game) || ""; };
      var names = [];
      pn.forEach(function (c) { var g = gameOf(c); if (g && names.indexOf(g) < 0) names.push(g); });
      /* only the coverages with enough of a sample to be a row of numbers rather than
         a row of anecdotes; the rest are gathered under what every screen cost */
      var keys = covKeysOf(pn).filter(function (k) {
        return pn.filter(function (c) { return covOf(c).indexOf(k) >= 0; }).length >= 6;
      }).slice(0, 7);
      if (names.length < 2 || !keys.length) { D.covbygame = null; return; }
      var rows = names.map(function (gname) {
        var mine = pn.filter(function (c) { return gameOf(c) === gname; });
        return {
          game: gname,
          all: cellFor(mine),
          cells: keys.map(function (k) {
            return cellFor(mine.filter(function (c) { return covOf(c).indexOf(k) >= 0; }));
          })
        };
      /* the heaviest night first: a game with four possessions in it is not the story */
      }).sort(function (a, b) { return b.all.poss - a.all.poss; });
      D.covbygame = {
        keys: keys,
        refs: keys.map(function (k) { return REF_COV[k] == null ? null : REF_COV[k]; }),
        totalRef: refPnrAll,
        total: { all: cellFor(pn),
                 cells: keys.map(function (k) {
                   return cellFor(pn.filter(function (c) { return covOf(c).indexOf(k) >= 0; }));
                 }) },
        rows: rows
      };
    })();

    var covCount = {}, covKeys = [];
    pn.forEach(function (c) { covOf(c).forEach(function (k) { if (!covCount[k]) { covCount[k] = 0; covKeys.push(k); } covCount[k]++; }); });
    covKeys.sort(function (a, b) { return covCount[b] - covCount[a]; });
    D.covquarter = covKeys.map(function (k) {
      var v = pn.filter(function (c) { return covOf(c).indexOf(k) >= 0; });
      if (v.length < 3) return null;
      var r = { label: k, n: v.length,
                n4: v.filter(function (c) { return bigOf(c) === "4"; }).length,
                n5: v.filter(function (c) { return bigOf(c) === "5"; }).length };
      ["Q1", "Q2", "Q3", "Q4"].forEach(function (q) {
        r[q] = v.filter(function (c) { return perOf(c) === q; }).length;
      });
      return r;
    }).filter(Boolean);

    var pairs = {}, actTot = {}, actKeys = [];
    pn.forEach(function (c) {
      var cv = firstCov(c), ac = firstAct(c);
      if (!cv || !ac) return;
      var k = cv + "\u0000" + ac;
      pairs[k] = (pairs[k] || 0) + 1;
      if (!actTot[ac]) { actTot[ac] = 0; actKeys.push(ac); }
      actTot[ac]++;
    });
    actKeys.sort(function (a, b) { return actTot[b] - actTot[a]; });
    var cols = actKeys.slice(0, 6);
    D.covxfinish = { cols: cols, rows: covKeys.map(function (cv) {
      var hit = pn.filter(function (c) { return covOf(c).indexOf(cv) >= 0 && actOf(c).length; });
      var tot = hit.length;
      if (tot < 4) return null;
      return { label: cv, n: tot,
        n4: hit.filter(function (c) { return bigOf(c) === "4"; }).length,
        n5: hit.filter(function (c) { return bigOf(c) === "5"; }).length,
        cells: cols.map(function (a) { return pairs[cv + "\u0000" + a] || 0; }) };
    }).filter(Boolean) };

    D.forceto = D.defsit.map(function (r) {
      var v = DEF.filter(function (c) { return gD(c) === r.label; });
      var t = v.filter(function (c) {
        return c.some(function (e) { return e.events.indexOf("Turnover") >= 0; });
      }).length;
      var ref = REF_TOV[r.label];
      var rate = r.poss ? t / r.poss * 100 : 0;
      return { label: r.label, poss: r.poss, tov: t, rate: Math.round(rate),
        ref: ref ? Math.round(ref) : null,
        edge: ref ? Math.round((ref - rate) * 10) / 10 : null, conf: r.conf };
    });

    /* ------------------------------------------------------- 7. players */
    var pl = {}, plKeys = [];
    OFF.forEach(function (c) {
      plOf(c).forEach(function (p) { if (!pl[p]) { pl[p] = []; plKeys.push(p); } pl[p].push(c); });
    });
    plKeys.sort(function (a, b) { return pl[b].length - pl[a].length; });
    D.players = { roles: ROLES, rows: plKeys.map(function (k) {
      var v = pl[k];
      if (v.length < 4) return null;
      var a = agg(v), cnt = {}, tagged = 0;
      v.forEach(function (c) { actOf(c).forEach(function (x) { cnt[x] = (cnt[x] || 0) + 1; tagged++; }); });
      var roles = {};
      ROLES.forEach(function (r) { roles[r] = cnt[r] || 0; });
      return { label: String(k).replace("|", " #"), n: v.length, poss: r1(a.poss),
        use: Math.round(100 * v.length / OFF.length),
        ppp: r2(a.ppp), xppp: r2(a.xppp), luck: r2(a.ppp - a.xppp),
        efg: rp(a.efg), p3r: rp(a.p3r), tov: rp(a.tovr), conf: conf(a.poss),
        roles: roles, tagged: tagged };
    }).filter(Boolean) };

    /* ---------------------------------------------------------- 8. meta */
    function covPct(chs, f) {
      return Math.round(100 * chs.filter(f).length / Math.max(1, chs.length));
    }
    /* A category the tables below do not know gets no side, and a clip with no
       side is never counted anywhere. New opponents bring new codes — "Offense
       vs zone" only appeared in the third Rostock game — so a silent drop is the
       one way this report can be quietly wrong. It is counted and shown. */
    var unkN = 0, unkBy = {}, unkOrder = [], dscBy = {}, dscOrder = [];
    evs.forEach(function (e) {
      if (e.side === "?") {
        unkN++;
        var k = (e.code ? "#" + e.code + " " : "") + (e.label || "?");
        if (!unkBy[k]) { unkBy[k] = 0; unkOrder.push(k); }
        unkBy[k]++;
      }
      /* a descriptor nobody knows does not drop the clip, it just never becomes
         a coverage or an action — worth naming, one line lower */
      e.unknown.forEach(function (u) {
        if (!dscBy[u]) { dscBy[u] = 0; dscOrder.push(u); }
        dscBy[u]++;
      });
    });
    unkOrder.sort(function (a, b) { return unkBy[b] - unkBy[a]; });
    dscOrder.sort(function (a, b) { return dscBy[b] - dscBy[a]; });

    D.meta = { team: teamName, games: GAMES, ngames: NG,
      offN: OFF.length, defN: DEF.length,
      unknown: { n: unkN, pct: Math.round(100 * unkN / Math.max(1, evs.length)),
                 list: unkOrder.slice(0, 12).map(function (k) { return k + " ×" + unkBy[k]; }),
                 more: Math.max(0, unkOrder.length - 12),
                 dsc: dscOrder.slice(0, 10).map(function (k) { return k + " ×" + dscBy[k]; }) },
      possAtt: r1(ao.poss / NG), possDef: r1(ad.poss / NG),
      refGames: refGames.length, base: [53.4, 36.1, 71.4],
      refOff: r2(A_ALL_O.ppp), refDef: r2(A_ALL_D.ppp),
      tag: { period: covPct(OFF.concat(DEF), function (c) { return perOf(c) !== null; }),
        shot: covPct(OFF, function (c) { return c.some(function (e) { return e.shots.length; }); }),
        player: covPct(OFF, function (c) { return plOf(c).length > 0; }),
        cov: covPct(pn, function (c) { return covOf(c).length > 0; }),
        /* how much of the ball screen is marked with who is in it at all */
        big: covPct(pn, function (c) { return bigOf(c) !== "5"; }),
        bigN: pn.length, big4N: pn4.length,
        actO: covPct(OFF, function (c) { return actOf(c).length > 0; }),
        actD: covPct(DEF, function (c) { return actOf(c).length > 0; }) } };

    /* --------------------------------------------- 9. computed narrative */
    function row(tbl, lbl) {
      return (D[tbl] || []).filter(function (r) { return r.label === lbl; })[0] || null;
    }
    var gb = D.gamebygame.filter(function (r) { return !r.total; });
    var best = gb.slice().sort(function (a, b) { return a.dPpp - b.dPpp; })[0];
    var worst = gb.slice().sort(function (a, b) { return b.dPpp - a.dPpp; })[0];
    var bs = row("defsit", "Ball screen");
    var hc = row("court", "Half court"), oc = row("court", "Open court");
    var hcd = row("courtDef", "Half court"), ocd = row("courtDef", "Open court");
    var pnrh = row("finish", "PnR Ball Handler");
    var flat = row("coverage", "Flat"), swi = row("coverage", "Switch");
    var swq = (D.covquarter || []).filter(function (r) { return r.label === "Switch"; })[0];
    var q4tot = 0; (D.covquarter || []).forEach(function (r) { q4tot += r.Q4; });
    var dsTot = 0; D.defsit.forEach(function (r) { dsTot += r.poss; });
    D.say = {
      defBest: best ? [best.label, best.dPpp] : null,
      defWorst: worst ? [worst.label, worst.dPpp] : null,
      bsFreq: bs && dsTot ? Math.round(bs.poss / dsTot * 100) : null,
      bsPpp: bs ? bs.ppp : null, bsRef: bs ? bs.ref : null,
      hcPpp: hc ? hc.ppp : null, hcRef: hc ? hc.ref : null,
      ocPpp: oc ? oc.ppp : null, ocRef: oc ? oc.ref : null,
      hcdPpp: hcd ? hcd.ppp : null, hcdRef: hcd ? hcd.ref : null,
      ocdPpp: ocd ? ocd.ppp : null, ocdRef: ocd ? ocd.ref : null,
      pnrhPpp: pnrh ? pnrh.ppp : null, pnrhRef: pnrh ? pnrh.ref : null,
      flatPpp: flat ? flat.ppp : null, swiPpp: swi ? swi.ppp : null,
      q4switch: swq ? swq.Q4 : 0, q4tot: q4tot,
      swEarly: swq ? (swq.Q1 + swq.Q2 + swq.Q3) : 0,
      selfPpp: D.panelOff.ppp,
      ciWidth: r2((D.panelOff.ci[1] - D.panelOff.ci[0]) / 2),
      nPlayers: D.players.rows.length,
      twoPlayers: covPct(OFF, function (c) { return plOf(c).length >= 2; })
    };
    return D;
  }

  /* ============================================ matching files to a scout */
  function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  /* Two naming shapes live in the folder and both mean the same thing:
       "G8 PREGAME ROSTOCK (HAMBURG).csv"   the shape the app already uses
       "G8_ROSTOCK_ALBA.csv"                the shape the exports come out as
     A game number, the team that was SCOUTED, then its rival. Both team names
     are in the string, so "contains the opponent" is not enough — it would hand
     the Rostock-vs-Alba file to an Alba scout too. The scouted team is the run
     of tokens at the FRONT, so a file belongs to this opponent only when the
     name starts with it, once the game number and the noise words are gone. */
  var NOISE = { ok: 1, cup: 1, season: 1, game: 1, final: 1, copy: 1, csv: 1, vs: 1,
                pregame: 1, postgame: 1, pre: 1, post: 1, scout: 1, scouting: 1 };

  function nameTokens(name) {
    var t = String(name).replace(/\.(csv|xlsx)$/i, "");
    t = t.replace(/^[0-9a-f]{6,}-/i, "");                 /* the upload hash */
    return t.split(/[_\-\s()]+/).filter(function (x) {    /* brackets are separators */
      var k = slug(x);
      return k && !NOISE[k] && !/^g?\d+$/.test(k);
    });
  }

  /* A NAME TYPED WITH ONE SLIP IS STILL THAT CLUB. The call sheet for Ludwigsburg was
     saved as "G10 SEASON LUDWISGBURG CALLS" - two letters the wrong way round - and the
     exact test read it as some other team's file, so the report said there were no calls
     while the sheet sat in the folder. One slip is let through: two neighbouring letters
     swapped, or one letter wrong, missing or extra. Only for a word of six letters or
     more, where one slip cannot turn one club into another. */
  function oneSlip(a, b) {
    var la = a.length, lb = b.length, i = 0, j, k;
    if (Math.abs(la - lb) > 1) return false;
    while (i < la && i < lb && a.charAt(i) === b.charAt(i)) i++;
    if (i === la && i === lb) return true;
    if (la === lb) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;                 /* one wrong */
      return a.charAt(i) === b.charAt(i + 1) && a.charAt(i + 1) === b.charAt(i)
        && a.slice(i + 2) === b.slice(i + 2);                             /* two swapped */
    }
    j = la > lb ? a : b; k = la > lb ? b : a;                             /* one extra */
    return j.slice(i + 1) === k.slice(i);
  }
  function nearIn(tok, want) {
    if (tok.length < 6) return false;
    for (var n = tok.length - 1; n <= tok.length + 1; n++)
      for (var s = 0; s + n <= want.length; s++)
        if (oneSlip(tok, want.substr(s, n))) return true;
    return false;
  }

  /* -> {match:bool, rival:string} */
  function classify(name, opponent) {
    var toks = nameTokens(name), want = slug(opponent), i = 0;
    if (!want) return { match: false, rival: "" };
    while (i < toks.length) {
      var k = slug(toks[i]);
      if (k.length >= 3 && (want.indexOf(k) >= 0 || nearIn(k, want))) i++;
      else break;
    }
    if (!i) return { match: false, rival: "" };
    var rest = toks.slice(i).filter(function (x) {
      var k = slug(x);
      return k.length < 3 ? true : want.indexOf(k) < 0;   /* drop echoes of the scouted team */
    });
    return { match: true, rival: (rest.join(" ") || toks.slice(i).join(" ") || "GAME").toUpperCase().slice(0, 22) };
  }

  /* The folder holds two kinds of file now. A call sheet — "G8 ROSTOCK CALLS"
     — is not a tagged game: it is the list of what they shout for each set.
     Left alone it matched as a game of that opponent called "CALLS", counted as
     a fourth Rostock game and went into the league reference as well. */
  function isCallSheet(name) {
    return nameTokens(name).some(function (t) { return /^calls?$/.test(slug(t)); });
  }
  function pickFiles(files, opponent) {
    return files.filter(function (f) {
      return !isCallSheet(f.name) && classify(f.name, opponent).match;
    });
  }
  function callSheets(files, opponent) {
    return files.filter(function (f) {
      return isCallSheet(f.name) && classify(f.name, opponent).match;
    });
  }
  function rivalLabel(name, opponent) {
    var c = classify(name, opponent);
    return c.match ? c.rival : String(name).replace(/\.(csv|xlsx)$/i, "").toUpperCase().slice(0, 22);
  }

  /* ======================================================= export for tests */
  var API = { parseFile: parseFile, buildEvents: buildEvents, buildReport: buildReport,
              normCat: normCat, normTag: normTag, chains: chains, agg: agg,
              pickFiles: pickFiles, rivalLabel: rivalLabel, classify: classify,
              isCallSheet: isCallSheet, callSheets: callSheets,
              /* so the page can let the downloads go when it is running out of memory */
              dropCache: dropCache };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.ScoutPre = API;

  /* Everything below only runs in the browser. */
  if (typeof document === "undefined") return;

  /* ==================================================================
     View. Same grammar as the Offensive Staples block: dense tables, a
     chip in every numeric cell, a cream column on the right with the
     number to remember.

     Two ramps that are never mixed:
       green / gold  the PPP cell, painted by WHO the number favours
       blue          volume and share, no judgement at all
     ================================================================== */

/* ONE SCALE FOR EVERY NUMBER IN THE APP.

   There were three ramps - green for what favours us, gold for what favours them, blue
   for volume - and which ramp a cell used carried the direction while its darkness
   carried the amount. Making the three ramps the same colour destroyed the direction and
   produced tables where a 1.18 was green beside a 0.73 in red.

   The scale is SIGNED instead: nine steps from red through pale to green, and the step is
   where the number sits against its reference. Red is below it, green is above it. One
   rule for the league, the pre game and the post game: the colour is how big the number
   is, never who it favours - so a PPP this club concedes reads green when it is high. */
  var PERF9 = ["#C53727","#d4705f","#e7a596","#f6ddd6","#f2f2f0","#d6e5dc","#8fc0a9","#3f9570","#17805A"];
  function perfStep(diff, span) {
    var k = Math.max(-1, Math.min(1, (diff || 0) / (span || 1)));
    return Math.round((k + 1) / 2 * 8);
  }
  function perfChip(txt, diff, span, cls) {
    var st = perfStep(diff, span), d = Math.abs(st - 4);
    var td = el("td", "sxp-c" + (cls ? " " + cls : ""));
    var sp = el("span", "sxp-v" + (d ? (d >= 3 ? " chip on" : " chip") : ""), txt);
    if (d) sp.style.background = PERF9[st];
    td.appendChild(sp);
    return td;
  }

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function f2(v) { return v == null ? "—" : Number(v).toFixed(2); }
  function sgn(v) { return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2); }

  function step(k) {
    if (k < 0.20) return 0;
    if (k < 0.45) return 1;
    if (k < 0.68) return 2;
    if (k < 0.87) return 3;
    return 4;
  }

  /* a coloured chip inside a cell; step 0 means no colour at all */
  function chip(txt, ramp, st, cls) {
    var td = el("td", "sxp-c" + (cls ? " " + cls : ""));
    var sp = el("span", "sxp-v" + (st ? (st >= 3 ? " chip on" : " chip") : ""), txt);
    if (st) sp.style.background = ramp[st];
    td.appendChild(sp);
    return td;
  }
  /* What they shout for this set. A set with no call is not blank — it says so,
     because "we do not know it" and "they do not call it" are different things. */
  function callCell(v) {
    var td = el("td", "sxp-c sxp-callc");
    if (v) td.appendChild(el("span", "sxp-call", v));
    else td.appendChild(el("span", "sxp-nocall", "no call"));
    return td;
  }
  function plain(txt, cls) {
    var td = el("td", "sxp-c" + (cls ? " " + cls : ""));
    td.appendChild(el("span", "sxp-v", txt == null ? "—" : String(txt)));
    return td;
  }
  function lbl(txt, cls) {
    var td = el("td", "sxp-lbl" + (cls ? " " + cls : ""));
    td.textContent = txt;
    return td;
  }
  /* The same label with the player's portrait in front of it. The scouted club is on the
     report's own meta, so the name is matched against that club's roster by the league
     view's resolver - which lives in the page, not in here, so it is used only when it is
     actually there. Without it this is exactly the old label. */
  function lblFace(txt, team, cls) {
    var td = lbl(txt, cls);
    if (typeof window === "undefined") return td;
    var face = null;
    /* the label is "Surname #12" and the number is the reliable half of it, so the page's
       number-first resolver is asked before the name one */
    try {
      if (typeof window._lgFaceLabel === "function") face = window._lgFaceLabel(team, txt, "scout");
      else if (typeof window._lgFaceName === "function") face = window._lgFaceName({ opponent: team, competition: "BBL" }, txt, "scout");
    } catch (e) { face = null; }
    if (!face) return td;
    td.textContent = "";
    td.className += " sxp-lbl-f";
    td.appendChild(face);
    var sp = document.createElement("span");
    sp.textContent = txt;
    td.appendChild(sp);
    return td;
  }

  /* THE ORIENTATION RULE lives here and nowhere else.
     On their offense a high PPP is them performing; on their defense it is us scoring,
     which is them performing badly. One scale, the sign tells it which way round. */
  function pppCell(ppp, ref, side, cf) {
    if (ref == null) return plain(f2(ppp), "muted");
    var diff = side === "O" ? (ppp - ref) : (ref - ppp);
    return perfChip(f2(ppp), diff, 0.25 * (cf < 2 ? 2.2 : 1));
  }
  function shareCell(v, mx, suf) {
    if (v == null || v === "") return el("td", "sxp-c");
    return perfChip(v + (suf == null ? "%" : suf), (v / (mx || 1)) - 0.5, 0.5);
  }
  function heatCell(v, mx) {
    if (!v) return el("td", "sxp-c");
    return perfChip(String(v), (v / (mx || 1)) - 0.5, 0.5);
  }

  /* so a check can read a call sheet without a Drive folder behind it */
  try { window.ScoutPre._csvRows = csvRows; window.ScoutPre._parseCalls = parseCalls; } catch (e) {}

  function tableShell(headCells) {
    var wrap = el("div", "sxp-scroll");
    var t = el("table", "sxp-t");
    var thead = el("thead"), tr = el("tr");
    headCells.forEach(function (h) {
      var th = el("th", h.cls || "", h.t);
      if (h.span) th.colSpan = h.span;
      if (h.rows) th.rowSpan = h.rows;
      tr.appendChild(th);
    });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody"); t.appendChild(tb);
    wrap.appendChild(t);
    /* Sorting is not wired here. One listener on the page sorts every table in the app, so
       a heading in this report behaves exactly like a heading anywhere else — what this
       file owes it is the affordance in the stylesheet, and rows it can read. */
    return { wrap: wrap, table: t, head: thead, body: tb };
  }

  function section(root, num, title, lede) {
    var s = el("section", "sxp-sec");
    var h = el("div", "sxp-sechead");
    h.appendChild(el("span", "sxp-num", num));
    h.appendChild(el("h2", "sxp-h2", title));
    s.appendChild(h);
    /* the lede is not drawn: the tables carry the report, a grey paragraph over
       each one is noise. Callers still pass it so no call site has to change. */
    root.appendChild(s);
    return s;
  }
  /* EVERY BLOCK OF TABLES IS SHUT UNTIL IT IS ASKED FOR. The card at the top says what the
     tables say; a table is where a reader goes to check one of its lines, not what he has
     to scroll through to find them. Each block keeps one line saying what is in it, opens
     and closes on its own heading, and remembers the choice for as long as the page is
     open. Expand all and Collapse all are at the top of the tagging. */
  /* ONE QUESTION ON SCREEN AT A TIME. A row of Show buttons over a dozen shut tables was
     still a dozen tables; the report is split by the question a staff is asking instead:
     the overview, their offense, their defense, the ball screen, the games. Each block of
     the report says which of those it answers (data-tabs) and the bar shows the ones that
     answer the tab chosen - nothing is moved or rebuilt, so "Everything" is the old page.
     Inside a tab every table is a card, open, with the same heading. */
  var TABS = [["over", "Overview"], ["off", "Their offense"], ["def", "Their defense"],
              ["bs", "Ball screen"], ["games", "Games and quarters"], ["all", "Everything"]];
  var TAB = "over";
  function tabOf(node, tabs) { try { node.setAttribute("data-tabs", tabs); } catch (e) {} return node; }
  function tabBar(root) {
    var bar = el("div", "sxp-tabs");
    var paint = function () {
      root.setAttribute("data-tab", TAB);
      Array.prototype.forEach.call(bar.children, function (b) { b.classList.toggle("on", b.getAttribute("data-t") === TAB); });
    };
    TABS.forEach(function (t) {
      var b = el("button", "sxp-tab", t[1]); b.type = "button"; b.setAttribute("data-t", t[0]);
      b.addEventListener("click", function () { TAB = t[0]; paint();
        try { window.dispatchEvent(new Event("resize")); } catch (e) {} });
      bar.appendChild(b);
    });
    paint();
    return bar;
  }
  function sub(host, title, what) {
    var b = el("div", "sxp-blk sxp-card");
    var hd = el("div", "sxp-sub");
    hd.appendChild(el("b", null, title));
    if (what) { try { hd.title = String(what).replace(/\s+/g, " "); } catch (e) {} }
    if (title) b.appendChild(hd);
    host.appendChild(b);
    return b;
  }
  /* the prose under a table moves to the hover; the page keeps the numbers */
  function tnote(host, txt) { try { host.title = String(txt || "").replace(/\s+/g, " "); } catch (e) {} }

  /* ------------------------------------------------- the workhorse table */
  /* Poss · % all · PPP · Ref · extra % columns · vs ref (cream) */
  function edgeTable(host, rows, nameHd, pppHd, extra, note) {
    if (!rows.length) { host.appendChild(el("div", "sxp-empty", "Not enough tagged possessions yet.")); return; }
    extra = extra || [];
    var tot = 0; rows.forEach(function (r) { tot += r.poss; });
    tot = tot || 1;
    var mxsh = 0; rows.forEach(function (r) { mxsh = Math.max(mxsh, r.poss / tot * 100); });
    var mxc = {};
    extra.forEach(function (c) {
      mxc[c[0]] = rows.reduce(function (m, r) { return Math.max(m, r[c[0]] || 0); }, 0) || 1;
    });
    var head = [{ t: nameHd }, { t: "Poss", cls: "n" }, { t: "% all", cls: "n" },
                { t: pppHd, cls: "n" }, { t: "Ref", cls: "n" }];
    extra.forEach(function (c) { head.push({ t: c[1], cls: "n" }); });
    head.push({ t: "vs ref", cls: "n cream" });
    var T = tableShell(head);
    rows.forEach(function (r) {
      var tr = el("tr", r.conf < 2 ? "dim" : "");
      tr.appendChild(lbl(r.label));
      tr.appendChild(plain(Math.round(r.poss)));
      tr.appendChild(shareCell(Math.round(r.poss / tot * 100), mxsh));
      tr.appendChild(pppCell(r.ppp, r.ref, r.side, r.conf));
      tr.appendChild(plain(r.ref == null ? "—" : f2(r.ref), "ref"));
      extra.forEach(function (c) {
        var v = r[c[0]];
        /* a third element "n" asks for a count rather than a share bar */
        /* a zero here is a row the thing never happened in: a dash reads, a 0 is noise */
        if (c[2] === "n") { tr.appendChild(plain(v ? v : "—", v ? "" : "muted")); return; }
        /* "p": the number, shaded by how much of ITS OWN ROW it is — so the column is
           read down for volume and across for the split, without dividing in your head */
        if (c[2] === "p") { tr.appendChild(v ? heatCell(v, r.poss || 1)
          : plain("—", "muted")); return; }
        tr.appendChild(v == null ? el("td", "sxp-c") : shareCell(v, mxc[c[0]]));
      });
      tr.appendChild(plain(r.ref == null ? "—" : sgn(r.ppp - r.ref), "cream"));
      T.body.appendChild(tr);
    });
    host.appendChild(T.wrap);
    if (note) tnote(host, note);
  }

  /* ---------------------------------------------------- identity panels */
  function idPanel(p, ref, title, subtitle, dirtxt, luck) {
    var box = el("div", "sxp-idp " + (p.side === "O" ? "off" : "def"));
    var hd = el("div", "sxp-idh");
    hd.appendChild(el("h3", "", title));

    box.appendChild(hd);

    var delta = p.ppp - ref.ppp;
    var good = p.side === "O" ? delta < 0 : delta > 0;

    var hero = el("div", "sxp-hero");
    hero.appendChild(el("span", "sxp-big", f2(p.ppp)));
    var u = el("span", "sxp-unit");
    u.appendChild(document.createTextNode("points per possession"));
    u.appendChild(el("br"));
    u.appendChild(el("i", "", dirtxt));
    hero.appendChild(u);
    hero.appendChild(el("span", "sxp-badge " + (good ? "good" : "bad"),
      (delta >= 0 ? "ABOVE REF" : "BELOW REF")));
    box.appendChild(hero);

    var SCALE = 1.6;
    var tgt = el("div", "sxp-tgt");
    var fill = el("div", "sxp-tfill " + (good ? "g" : "b"));
    fill.style.width = Math.min(100, p.ppp / SCALE * 100).toFixed(1) + "%";
    var mk = el("div", "sxp-tmk");
    mk.style.left = (ref.ppp / SCALE * 100).toFixed(1) + "%";
    tgt.appendChild(fill); tgt.appendChild(mk);
    box.appendChild(tgt);
    var sc = el("div", "sxp-tlab");
    sc.appendChild(el("span", "", "0.00"));
    sc.appendChild(el("span", "mid", "reference " + f2(ref.ppp)));
    sc.appendChild(el("span", "", SCALE.toFixed(2)));
    box.appendChild(sc);

    box.appendChild(el("div", "sxp-ci",
      "95% confidence " + f2(p.ci[0]) + " – " + f2(p.ci[1]) +
      " · " + Math.round(p.poss) + " possessions"));

    var dl = el("dl", "sxp-idrow");
    [["League reference", f2(ref.ppp), delta, good],
     ["Shot quality (xPPP)", f2(p.xppp), p.luck, (p.luck > 0) === (p.side === "O")],
     ["eFG%", p.efg + "%", null, null],
     ["Turnovers", p.tov + "%", null, null]].forEach(function (x) {
      var d = el("div");
      d.appendChild(el("dt", "", x[0]));
      var dd = el("dd", "", x[1]);
      if (x[2] != null) {
        dd.appendChild(document.createTextNode(" "));
        dd.appendChild(el("span", "sxp-ev " + (x[3] ? "pos" : "neg"), sgn(x[2])));
      }
      d.appendChild(dd);
      dl.appendChild(d);
    });
    box.appendChild(dl);
    /* the luck sentence is gone: the number is already in the row above it as
       "Shot quality (xPPP)" with its own colour, and a paragraph saying the same
       thing in words was one more grey block over every card */

    var tot = p.f2a + p.f3a;
    var s2 = tot ? p.f2a / tot * 100 : 50;
    var rtot = ref.f2a + ref.f3a;
    var r2s = rtot ? ref.f2a / rtot * 100 : 50;
    var shot = el("div", "sxp-shot");
    shot.appendChild(el("div", "sxp-shotlbl", "Shot profile vs reference"));
    var bar = el("div", "sxp-shotbar");
    var i2 = el("i", "s2", p.f2a + " 2PA"); i2.style.width = s2.toFixed(0) + "%";
    var i3 = el("i", "s3", p.f3a + " 3PA"); i3.style.width = (100 - s2).toFixed(0) + "%";
    bar.appendChild(i2); bar.appendChild(i3);
    shot.appendChild(bar);
    var rb = el("div", "sxp-shotbar ref");
    var r2a = el("i", "s2"); r2a.style.width = r2s.toFixed(0) + "%";
    var r3a = el("i", "s3"); r3a.style.width = (100 - r2s).toFixed(0) + "%";
    rb.appendChild(r2a); rb.appendChild(r3a);
    shot.appendChild(rb);
    shot.appendChild(el("div", "sxp-shotfoot",
      p.s3 + "% of their shots are threes · reference " + Math.round(100 - r2s) +
      "% · 2P " + p.p2 + "% · 3P " + p.p3 + "% · " + p.fta + " free throws"));
    box.appendChild(shot);
    return box;
  }

  function luckLine(p) {
    var d = Math.abs(p.luck), dir = p.luck > 0 ? "above" : "below";
    var tail;
    if (p.side === "O") {
      tail = p.luck > 0.05 ? "they have been hot and should come down"
        : p.luck < -0.05 ? "the looks are better than the results, so read their offense as a touch better than the raw number"
          : "essentially no luck either way, the number is the number";
      return "They scored " + d.toFixed(2) + " " + dir + " what their shot selection is worth — " + tail + ".";
    }
    tail = p.luck > 0.05 ? "they have been punished on the shots they conceded, so their defense is not quite as bad as it looks"
      : p.luck < -0.05 ? ("missed open shots have flattered them, so the real level is worse than " + f2(p.ppp))
        : "no luck either way, what they allow is what they are";
    return "Opponents scored " + d.toFixed(2) + " " + dir +
      " the value of the shots they were given — " + tail + ".";
  }

  /* ============================================================= render */

  /* Section 06 used to close the TEAM STATS block. It is the first thing in
     PLAYERS STATS now, so it is drawn on its own and numbered by the caller. */
  function playersBlock(root, D, num) {
    var M = D.meta;
    if (!D.players.rows.length) return null;
    var s6 = section(root, num, "Players",
      "Volume, efficiency and role in one table. The left block is how much and how well; the right " +
      "block is what they are actually asked to do, shaded by how often.");
    var b6 = el("div", "sxp-blk"); s6.appendChild(b6);
    var used = D.players.roles.filter(function (r) {
      return D.players.rows.some(function (p) { return p.roles[r] > 0; });
    });
    var h6 = [{ t: "Player", rows: 2 },
      { t: "Volume and efficiency", span: 8, cls: "grpo" },
      { t: "Where the possession ends", span: used.length, cls: "grpd" }];
    var TPL = tableShell(h6);
    var r6 = el("tr");
    ["Poss", "Use", "PPP", "xPPP", "Luck", "eFG%", "3PAr", "TOV%"].forEach(function (x, i) {
      r6.appendChild(el("th", "n" + (i === 7 ? " sep" : ""), x));
    });
    used.forEach(function (x) { r6.appendChild(el("th", "n rot", x)); });
    TPL.head.appendChild(r6);
    var mxr = 0;
    D.players.rows.forEach(function (p) { used.forEach(function (r) { mxr = Math.max(mxr, p.roles[r]); }); });
    D.players.rows.forEach(function (p) {
      var tr = el("tr", p.conf < 2 ? "dim" : "");
      tr.appendChild(lblFace(p.label, M.team));
      tr.appendChild(plain(p.n));
      tr.appendChild(plain(p.use + "%"));
      tr.appendChild(pppCell(p.ppp, M.refOff, "O", p.conf));
      tr.appendChild(plain(f2(p.xppp), "ref"));
      var tdl = el("td", "sxp-c");
      tdl.appendChild(el("span", "sxp-v sxp-ev " + (p.luck > 0 ? "pos" : p.luck < 0 ? "neg" : ""), sgn(p.luck)));
      tr.appendChild(tdl);
      tr.appendChild(plain(p.efg + "%"));
      tr.appendChild(plain(p.p3r + "%"));
      tr.appendChild(plain(p.tov + "%", "sep"));
      used.forEach(function (r) { tr.appendChild(heatCell(p.roles[r], mxr)); });
      TPL.body.appendChild(tr);
    });
    b6.appendChild(TPL.wrap);
    tnote(b6, "Luck is PPP minus xPPP, coloured like everything else — green favours us. Role counts " +
      "come from the " + M.tag.player + "% of offensive clips that carry a player tag, so they are a " +
      "share, not a full box score.");

    return s6;
  }

  /* THE OPPONENT IN ONE CARD, BEFORE ANY TABLE.
     Team stats was a dozen tables one after another and the reader had to find the game
     plan in them. This is what those tables say, chosen from them: how they score and
     where they are better than the league at it, how their possessions end, where they
     concede, how they cover the ball screen - which coverage, how often, what it costs
     them, whether it changes with the big in it, with the quarter and from one game to
     the next - their second chances, and their quarters. A line is said when it is far
     enough from the reference and rests on enough possessions; each carries its count.
     "Red" is what hurts us and "green" what we can go at, whichever end it is. */
  function teamDash(D) {
    var K = (typeof window !== "undefined") && window.UIKit;
    if (!K || !D) return null;
    var f2n = function (v) { return (v == null || !isFinite(v)) ? "—" : Number(v).toFixed(2); };
    var figs = [], PO = D.panelOff, PD = D.panelDef, RO = D.panelRefOff, RD = D.panelRefDef, S = D.say || {};
    if (PO) figs.push({ label: "Their offense", value: f2n(PO.ppp), note: "per possession · league " + f2n(RO && RO.ppp),
      tone: K.tone(PO.ppp, RO && RO.ppp, false, 0.04) });
    if (PD) figs.push({ label: "Their defense", value: f2n(PD.ppp), note: "allowed · league " + f2n(RD && RD.ppp),
      tone: K.tone(PD.ppp, RD && RD.ppp, true, 0.04) });
    if (S.bsFreq != null) figs.push({ label: "Ball screens", value: S.bsFreq + "%", note: "of what they defend · " + f2n(S.bsPpp) + " allowed", tone: "vol" });
    if (D.second) figs.push({ label: "Second chances", value: D.second.orb, note: "offensive rebounds · " + D.second.pts + " points off them", tone: "vol" });
    if (D.meta) figs.push({ label: "Games tagged", value: D.meta.ngames, note: (D.meta.games || []).join(" · "), tone: "vol" });
    /* a row of one of the report's own tables, as a sentence: `edge` is already "how good
       this is for us", whichever side of the ball it is */
    var line = function (rows, minPoss, text, weight) {
      return (rows || []).filter(function (r) { return r && r.poss >= minPoss && r.ref != null && Math.abs(r.edge) >= 0.08; })
        .map(function (r) { return { text: text(r), tone: r.edge > 0 ? "good" : "bad",
          size: Math.min(1, Math.abs(r.edge) / 0.35) * (0.6 + 0.4 * Math.min(1, (r.freq || 10) / 25)),
          n: Math.round(r.poss), solidN: 30, unit: "poss", weight: weight || 1 }; });
    };
    var gOff = line(D.mix, 10, function (r) { return r.label + ": " + f2n(r.ppp) + " per possession, " + (r.freq != null ? r.freq + "% of their offense" : "") + " (league " + f2n(r.ref) + ")"; })
      .concat(line(D.court, 12, function (r) { return r.label + ": " + f2n(r.ppp) + " per possession (league " + f2n(r.ref) + ")"; }, 0.9));
    var gFin = line(D.finish, 10, function (r) { return "Ends in " + r.label + ": " + f2n(r.ppp) + " per possession" + (r.freq != null ? ", " + r.freq + "% of the time" : ""); });
    var gDef = line(D.defsit, 10, function (r) { return r.label + ": " + f2n(r.ppp) + " allowed per possession (league " + f2n(r.ref) + ")"; })
      .concat(line(D.generate, 10, function (r) { return "Against " + r.label + ": " + f2n(r.ppp) + " allowed"; }, 0.8));
    /* the ball screen: what each coverage costs, who is in it, and whether it moves */
    var gCov = line(D.coverage, 8, function (r) { return r.label + ": " + (r.freq != null ? r.freq + "% of their ball screens, " : "") + f2n(r.ppp) + " allowed"; }, 1.3);
    try {
      var tot = D.covbybig && D.covbybig.total;
      if (tot && tot[0] && tot[1] && tot[0].n >= 6 && tot[1].n >= 6 && tot[0].ppp != null && tot[1].ppp != null) {
        var d45 = tot[0].ppp - tot[1].ppp;
        if (Math.abs(d45) >= 0.12) gCov.push({ text: "Clips tagged “PnR 4” allow " + f2n(tot[0].ppp) + ", every other ball screen " + f2n(tot[1].ppp) + " — go at the " + (d45 > 0 ? "4" : "5"),
          tone: "neutral", size: Math.min(1, Math.abs(d45) / 0.4), n: Math.round(Math.min(tot[0].poss, tot[1].poss)), solidN: 20, unit: "poss", weight: 1.2 });
      }
      (D.covbybig && D.covbybig.rows || []).forEach(function (r) {
        var a = r.cells[0], b = r.cells[1];
        if (a && b && a.share != null && b.share != null && a.n >= 3 && b.n >= 3 && Math.abs(a.share - b.share) >= 25)
          gCov.push({ text: r.label + " is " + a.share + "% of what the 4 does and " + b.share + "% of what the 5 does", tone: "neutral",
            size: Math.min(1, Math.abs(a.share - b.share) / 60), n: Math.round(a.poss + b.poss), solidN: 20, unit: "poss" });
      });
      (D.covquarter || []).forEach(function (r) {
        var n = (r.Q1 || 0) + (r.Q2 || 0) + (r.Q3 || 0) + (r.Q4 || 0);
        if (n >= 8 && (r.Q4 || 0) >= 0.5 * n) gCov.push({ text: r.label + " mostly in the fourth quarter: " + r.Q4 + " of " + n, tone: "neutral", size: r.Q4 / n, n: n, solidN: 14, unit: "clips" });
        else if (n >= 8 && (r.Q1 || 0) >= 0.5 * n) gCov.push({ text: r.label + " mostly in the first quarter: " + r.Q1 + " of " + n, tone: "neutral", size: r.Q1 / n, n: n, solidN: 14, unit: "clips" });
      });
      var CG = D.covbygame;
      if (CG && CG.rows && CG.rows.length >= 2) CG.keys.forEach(function (k, i) {
        var per = CG.rows.map(function (g) { var c = g.cells[i]; var all = g.all && g.all.poss; return (c && c.n && all) ? { g: g.game, s: 100 * c.poss / all, p: c.poss } : null; }).filter(Boolean);
        if (per.length < 2) return;
        var hi = per.slice().sort(function (a, b) { return b.s - a.s; })[0], lo = per.slice().sort(function (a, b) { return a.s - b.s; })[0];
        if (hi.s - lo.s >= 30) gCov.push({ text: k + " changes from game to game: " + Math.round(hi.s) + "% of the ball screens against " + hi.g + ", " + Math.round(lo.s) + "% against " + lo.g,
          tone: "neutral", size: Math.min(1, (hi.s - lo.s) / 70), n: Math.round(hi.p + lo.p), solidN: 16, unit: "poss" });
      });
    } catch (e) { }
    /* their quarters, added up over the games */
    var gQ = [];
    try {
      var q = {}; (D.quarters || []).forEach(function (r) { var o = q[r.q] || (q[r.q] = { op: 0, opts: 0, dp: 0, dpts: 0 });
        o.op += r.oPoss || 0; o.opts += (r.oPpp || 0) * (r.oPoss || 0); o.dp += r.dPoss || 0; o.dpts += (r.dPpp || 0) * (r.dPoss || 0); });
      var qs = Object.keys(q).filter(function (k) { return q[k].op >= 12 && q[k].dp >= 12; })
        .map(function (k) { return { q: k, o: q[k].opts / q[k].op, d: q[k].dpts / q[k].dp, n: q[k].op + q[k].dp }; });
      if (qs.length >= 2) {
        var bo = qs.slice().sort(function (a, b) { return b.o - a.o; })[0], wo = qs.slice().sort(function (a, b) { return a.o - b.o; })[0];
        if (bo.o - wo.o >= 0.2) gQ.push({ text: "They score best in " + bo.q + " (" + f2n(bo.o) + ") and least in " + wo.q + " (" + f2n(wo.o) + ")", tone: "neutral",
          size: Math.min(1, (bo.o - wo.o) / 0.5), n: Math.round(Math.min(bo.n, wo.n)), solidN: 40, unit: "poss" });
        var bd = qs.slice().sort(function (a, b) { return b.d - a.d; })[0], wd = qs.slice().sort(function (a, b) { return a.d - b.d; })[0];
        if (bd.d - wd.d >= 0.2) gQ.push({ text: "They concede most in " + bd.q + " (" + f2n(bd.d) + ") and least in " + wd.q + " (" + f2n(wd.d) + ")", tone: "good",
          size: Math.min(1, (bd.d - wd.d) / 0.5), n: Math.round(Math.min(bd.n, wd.n)), solidN: 40, unit: "poss" });
      }
      var gg = (D.gamebygame || []).filter(function (r) { return !r.total; });
      if (gg.length >= 2) { var last = gg[gg.length - 1], rest = gg.slice(0, -1);
        var avg = function (k, w) { var n = 0, s = 0; rest.forEach(function (r) { n += r[w] || 0; s += (r[k] || 0) * (r[w] || 0); }); return n ? s / n : null; };
        var ao = avg("oPpp", "oPoss"), ad = avg("dPpp", "dPoss");
        if (ao != null && Math.abs(last.oPpp - ao) >= 0.12) gQ.push({ text: "Last game tagged (" + last.label + "): " + f2n(last.oPpp) + " scored per possession, " + f2n(ao) + " before",
          tone: last.oPpp > ao ? "bad" : "good", size: Math.min(1, Math.abs(last.oPpp - ao) / 0.35), n: Math.round(last.oPoss), solidN: 60, unit: "poss" });
        if (ad != null && Math.abs(last.dPpp - ad) >= 0.12) gQ.push({ text: "Last game tagged (" + last.label + "): " + f2n(last.dPpp) + " allowed per possession, " + f2n(ad) + " before",
          tone: last.dPpp > ad ? "good" : "bad", size: Math.min(1, Math.abs(last.dPpp - ad) / 0.35), n: Math.round(last.dPoss), solidN: 60, unit: "poss" });
      }
      if (D.second && D.second.chains >= 6) gQ.push({ text: "Second chances: " + D.second.orb + " offensive rebounds, " + D.second.pts + " points — " + f2n(D.second.ppp) + " per second chance",
        tone: D.second.ppp >= 1.1 ? "bad" : "neutral", size: Math.min(1, D.second.chains / 20), n: D.second.chains, solidN: 15, unit: "chances", weight: 1.1 });
    } catch (e) { }
    /* what the summary used to leave to the tables: their defense by court state, where
       their pressure forces turnovers, and who finishes their possessions */
    try {
      gDef = gDef.concat(line(D.courtDef, 12, function (r) { return r.label + ": " + f2n(r.ppp) + " allowed per possession (league " + f2n(r.ref) + ")"; }, 0.9));
      (D.forceto || []).forEach(function (r) {
        if (r.ref == null || r.poss < 15 || Math.abs(r.rate - r.ref) < 4) return;
        gDef.push({ text: r.label + ": forces a turnover on " + r.rate + "% (league " + r.ref + "%)", tone: r.rate < r.ref ? "good" : "bad",
          size: Math.min(1, Math.abs(r.rate - r.ref) / 12), n: Math.round(r.poss), solidN: 40, unit: "poss" });
      });
    } catch (e) { }
    var gWho = [];
    try {
      var avgP = S.selfPpp;
      ((D.players && D.players.rows) || []).slice(0, 8).forEach(function (p) {
        if (p.n < 8) return;
        var top = Object.keys(p.roles || {}).sort(function (a, b) { return p.roles[b] - p.roles[a]; })[0];
        var d = (avgP != null) ? p.ppp - avgP : 0;
        gWho.push({ k: p.label, v: f2n(p.ppp), text: p.use + "% of their possessions" + (top && p.roles[top] ? " · mostly " + top.toLowerCase() : ""),
          tone: d >= 0.08 ? "bad" : d <= -0.08 ? "good" : "neutral", size: Math.min(1, p.use / 22), n: p.n, solidN: 20, unit: "poss" });
      });
    } catch (e) { }
    /* the same tables as pictures: what their offense is made of, what they have to
       defend, how they cover the ball, and how the games and the quarters went */
    var visuals = [];
    try {
      var mixOf = function (rows, title, sub, inv) {
        var use = (rows || []).filter(function (r) { return r && r.poss > 0; });
        var tot = 0; use.forEach(function (r) { tot += r.poss; });
        if (!tot || use.length < 2) return null;
        use = use.slice().sort(function (a, b) { return b.poss - a.poss; });
        var head = use.slice(0, 6), rest = use.slice(6), parts = head.map(function (r) {
          return { label: r.label, share: r.poss / tot, value: f2n(r.ppp), tone: (r.ref == null || Math.abs(r.edge) < 0.06) ? "neutral" : (r.edge > 0 ? "good" : "bad") }; });
        if (rest.length) { var rp = 0; rest.forEach(function (r) { rp += r.poss; }); parts.push({ label: "Other (" + rest.length + ")", share: rp / tot }); }
        return K.split({ title: title, sub: sub, parts: parts });
      };
      visuals.push(mixOf(D.mix, "Their offense is made of", "share of possessions · points per possession"));
      visuals.push(mixOf(D.defsit, "What they have to defend", "share · points allowed"));
      visuals.push(mixOf(D.coverage, "How they cover the ball screen", "share · points allowed"));
      var ggs = (D.gamebygame || []).filter(function (r) { return !r.total; });
      if (ggs.length >= 2) visuals.push(K.strip({ title: "Game by game", sub: "their offense minus their defense, per possession", signed: true,
        items: ggs.map(function (r) { return { label: String(r.label).slice(0, 9), value: r.net, text: (r.net > 0 ? "+" : r.net < 0 ? "−" : "") + Math.abs(r.net).toFixed(2),
          tone: r.net > 0.03 ? "bad" : r.net < -0.03 ? "good" : "neutral", title: r.label + ": " + f2n(r.oPpp) + " scored, " + f2n(r.dPpp) + " allowed" }; }) }));
      var qq = {}; (D.quarters || []).forEach(function (r) { var o = qq[r.q] || (qq[r.q] = { op: 0, opts: 0, dp: 0, dpts: 0 });
        o.op += r.oPoss || 0; o.opts += (r.oPpp || 0) * (r.oPoss || 0); o.dp += r.dPoss || 0; o.dpts += (r.dPpp || 0) * (r.dPoss || 0); });
      var qk = Object.keys(qq).filter(function (k) { return qq[k].op >= 8 && qq[k].dp >= 8; }).sort();
      if (qk.length >= 2) visuals.push(K.strip({ title: "By quarter", sub: "their offense minus their defense, all games", signed: true,
        items: qk.map(function (k) { var v = qq[k].opts / qq[k].op - qq[k].dpts / qq[k].dp;
          return { label: k, value: v, text: (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2), tone: v > 0.03 ? "bad" : v < -0.03 ? "good" : "neutral",
            title: k + ": " + f2n(qq[k].opts / qq[k].op) + " scored, " + f2n(qq[k].dpts / qq[k].dp) + " allowed" }; }) }));
    } catch (e) { }
    return K.summary({ title: "The opponent, from the tagging",
      sub: "red is what hurts us · green is what we can go at · each line says what it rests on", figures: figs, visuals: visuals,
      groups: [ { title: "How they score", ideas: K.pick(gOff, 5) }, { title: "How their possessions end", ideas: K.pick(gFin, 4) },
        { title: "Where they concede", ideas: K.pick(gDef, 5) }, { title: "Ball screen coverage", ideas: K.pick(gCov, 6) },
        { title: "Quarters, last game, second chances", ideas: K.pick(gQ, 5) },
        { title: "Who finishes their possessions", ideas: gWho.slice(0, 6) } ],
      empty: "Not enough tagged possessions to say anything yet." });
  }

  function render(root, D, filesUsed, opts) {
    root.innerHTML = "";
    root.className = "sxp";
    var M = D.meta, S = D.say, PO = D.panelOff, PD = D.panelDef;

    /* which games this was built from belongs on the hover, not across the top of the
       report in grey type */
    try {
      root.title = "From the tagging of " + M.team + " · " + M.ngames + " game" +
        (M.ngames === 1 ? "" : "s") + " (" + M.games.join(" · ") + ")";
    } catch (e) {}

    /* what the tables below say, before the tables */
    try { root.appendChild(tabBar(root)); } catch (e) { }
    try { var dashT = teamDash(D); if (dashT) root.appendChild(tabOf(dashT, "over")); } catch (e) { }

    /* Said loudly and at the top: a category nobody taught the parser is a
       category that is not in a single number below it. */
    if (M.unknown && M.unknown.n) {
      var w = el("div", "sxp-warn");
      if (M.unknown.n) {
        w.appendChild(el("b", "", M.unknown.n + " clips (" + M.unknown.pct + "%) not counted:"));
        w.appendChild(el("span", "", M.unknown.list.join(" · ") +
          (M.unknown.more ? " · and " + M.unknown.more + " more" : "")));
      }
      /* "Descriptors not read: DFI x3" is a note to whoever tags, not to whoever reads the
         report, and it opened the page. It lives on the hover of the warning instead. */
      if (M.unknown.dsc.length) {
        try{ w.title = "Descriptors not read: " + M.unknown.dsc.join(" \u00b7 "); }catch(e){}
      }
      root.appendChild(w);
    }

    /* The colour rule used to open this block. It opens the whole report now, small, so it
       is read once and applies to everything under it instead of to this block alone. */

    /* The two hero panels - their offense and their defense as one PPP each - are gone.
       The report now opens with the league's own four factors for this club and ours, off
       the feed and marked against all eighteen, which is the same question answered from a
       whole season instead of from the clips we happened to tag. */

    /* The rows of the section are decided here rather than left to how wide a table
       happens to be: game by game sits beside the league's team analysis, and the two
       court splits share the line under them. Everything after that is a section wide
       enough to hold its own blocks, which the layout packs by measurement. */
    /* Three rows before the rest, in the order a staff reads them. The court split is the
       question the game plan starts from, so it leads and game by game sits beside it.
       The league's team analysis - eighteen clubs behind every number - is read against
       what the glass gives them back, so second chance shares its line. The quarters are
       four cards per game and want the whole width to themselves. */
    var rowA = el("div", "sxp rst-sxp sxp-row fit-even sxp-rowA"); root.appendChild(rowA);
    var rowAn = el("div", "sxp rst-sxp sxp-row fit-even sxp-rowAn"); root.appendChild(rowAn);
    var rowQ = el("div", "sxp rst-sxp sxp-row sxp-rowQ"); root.appendChild(rowQ);
    var rowB = el("div", "sxp rst-sxp sxp-row"); root.appendChild(rowB);
    tabOf(rowA, "off def games"); tabOf(rowAn, "off games"); tabOf(rowQ, "games"); tabOf(rowB, "none");

    /* ------------------------------------------------- 01 game by game */
    var s1 = section(rowA, "02", "Game by game",
      "The aggregate can hide different teams." +
      (S.defBest && S.defWorst && S.defBest[0] !== S.defWorst[0]
        ? " It does here: their defense gave up " + f2(S.defBest[1]) + " against " + S.defBest[0] +
          " and " + f2(S.defWorst[1]) + " against " + S.defWorst[0] + "."
        : ""));
    /* a list of the games played is a record, not a ranking - nothing in it is "the
       important row", so the report puts nothing forward here */
    tabOf(s1, "games");
    var b1 = el("div", "sxp-blk sxp-card"); b1.setAttribute("data-hl", "0"); s1.appendChild(b1);
    var T1 = tableShell([{ t: "", rows: 2 },
      { t: "Their offense", span: 6, cls: "grpo" }, { t: "Their defense", span: 6, cls: "grpd" },
      { t: "Net", rows: 2, cls: "n cream" }]);
    var r2r = el("tr");
    ["Poss", "PPP", "xPPP", "eFG%", "3PAr", "TOV%"].forEach(function (h) { r2r.appendChild(el("th", "n", h)); });
    ["Poss", "PPP", "xPPP", "eFG%", "3PAr", "TOV%"].forEach(function (h, i) {
      r2r.appendChild(el("th", "n" + (i === 0 ? " sep" : ""), h));
    });
    T1.head.appendChild(r2r);
    D.gamebygame.forEach(function (r) {
      var tr = el("tr", r.total ? "tot" : "");
      tr.appendChild(lbl(r.label));
      tr.appendChild(plain(Math.round(r.oPoss)));
      tr.appendChild(pppCell(r.oPpp, M.refOff, "O", 3));
      tr.appendChild(plain(f2(r.oXppp), "ref"));
      tr.appendChild(plain(r.oEfg + "%")); tr.appendChild(plain(r.o3r + "%")); tr.appendChild(plain(r.oTov + "%"));
      tr.appendChild(plain(Math.round(r.dPoss), "sep"));
      tr.appendChild(pppCell(r.dPpp, M.refDef, "D", 3));
      tr.appendChild(plain(f2(r.dXppp), "ref"));
      tr.appendChild(plain(r.dEfg + "%")); tr.appendChild(plain(r.d3r + "%")); tr.appendChild(plain(r.dTov + "%"));
      var td = el("td", "sxp-c cream");
      td.appendChild(el("span", "sxp-v sxp-ev " + (r.net > 0 ? "pos" : r.net < 0 ? "neg" : ""), sgn(r.net)));
      tr.appendChild(td);
      T1.body.appendChild(tr);
    });
    b1.appendChild(T1.wrap);
    tnote(b1, "xPPP next to each PPP is the shot-quality value of the same possessions. Net is their " +
      "offense minus their defense: positive means the game went their way.");

    /* ------------------------------------------ 02 half / open court */
    var s2s = section(rowA, "01", "Half court and open court",
      "The single most useful split in the report, because it decides whether the game plan starts " +
      "with transition defense or with a set defense.");
    rowA.insertBefore(s2s, rowA.firstChild);
    tabOf(s2s, "off def");
    var b2a = tabOf(sub(s2s, "Their offense", "Where their points come from, and whether they are better than average there."), "off");
    edgeTable(b2a, D.court, "Court state", "PPP",
      [["efg", "eFG%"], ["p3r", "3PAr"], ["tov", "TOV%"]],
      S.ocPpp != null ? ("Open court " + f2(S.ocPpp) + " against a " + f2(S.ocRef) + " reference; half court " +
        f2(S.hcPpp) + " against " + f2(S.hcRef) + ".") : "");
    var b2b = tabOf(sub(s2s, "Their defense", "The same split on what they allow."), "def");
    edgeTable(b2b, D.courtDef, "Court state", "PPP allowed",
      [["efg", "eFG%"], ["p3r", "3PAr"], ["tov", "TOV%"]],
      S.ocdPpp != null ? ("Transition defense " + f2(S.ocdPpp) + " against a " + f2(S.ocdRef) +
        " reference; in half court they allow " + f2(S.hcdPpp) + " against " + f2(S.hcdRef) +
        " — and that is where everything below comes from.") : "");

    /* --------------------------------------------------- 03 quarters */
    if (D.quarters.length) {
      var s3 = section(rowQ, "04", "Quarter by quarter, game by game",
        "Split per game so one eleven-point quarter does not get averaged into a pattern that never happened.");
      var b3 = el("div", "sxp-blk sxp-card"); s3.appendChild(b3);
      var qw = el("div", "sxp-qwrap fitgrid");
      M.games.forEach(function (g) {
        var rowsq = D.quarters.filter(function (x) { return x.game === g; });
        if (!rowsq.length) return;
        var card = el("div", "sxp-qcard");
        card.appendChild(el("h4", "", g));
        var grid = el("div", "sxp-qgrid");
        var mx = 0;
        rowsq.forEach(function (x) { mx = Math.max(mx, x.oPpp, x.dPpp); });
        rowsq.forEach(function (x) {
          var cell = el("div", "sxp-qcell" + (x.conf < 2 ? " dim" : ""));
          var bars = el("div", "sxp-qbars");
          [["o", x.oPpp], ["d", x.dPpp]].forEach(function (p) {
            var bq = el("div", "sxp-qb " + p[0]);
            bq.style.height = Math.max(3, p[1] / (mx || 1) * 100).toFixed(0) + "%";
            bq.appendChild(el("b", "", f2(p[1])));
            bars.appendChild(bq);
          });
          cell.appendChild(bars);
          cell.appendChild(el("div", "sxp-qlab", x.q));
          cell.appendChild(el("div", "sxp-qnet " + (x.net > 0 ? "pos" : x.net < 0 ? "neg" : ""), sgn(x.net)));
          grid.appendChild(cell);
        });
        card.appendChild(grid);
        qw.appendChild(card);
      });
      b3.appendChild(qw);
      var qk = el("div", "sxp-qkey");
      [["o", "their offense"], ["d", "their defense"]].forEach(function (x) {
        var sp = el("span");
        sp.appendChild(el("i", "sxp-kk " + x[0]));
        sp.appendChild(document.createTextNode(x[1]));
        qk.appendChild(sp);
      });
      qk.appendChild(el("span", "muted", "The net under each quarter follows the one colour rule — green above zero, red below, whoever it favours."));
      b3.appendChild(qk);
    }

    /* ------------------------------------------- 04 how they attack */
    var s4 = section(root, "05", "How they attack",
      "Origin, finish and playbook. Ordered by volume so the first row is always the one that matters most.");
    tabOf(s4, "off");
    var b4a = sub(s4, "Possession mix by origin",
      "What share of their offense each origin is, and whether they are better or worse than the reference there.");
    edgeTable(b4a, D.mix, "Origin", "PPP",
      [["efg", "eFG%"], ["p3r", "3PAr"], ["tov", "TOV%"]],
      "Green is where they struggle; gold is where they hurt us.");
    var b4b = sub(s4, "Finishing concept", "How the possession actually ends, whatever started it.");
    edgeTable(b4b, D.finish, "Concept", "PPP", [["efg", "eFG%"], ["p3r", "3PAr"]],
      "Green means we want them finishing there.");

    /* the single playbook */
    /* This one block is not read here: everything about the playbook belongs under the
       playbook table the staff actually works on, so the report moves it there. The class
       is the handle - see _pbRelocate in index.html. */
    var b4c = sub(s4, "Playbook — everything they call",
      "One table. Half court (called sets, ball screens with no call, broken possessions), open court " +
      "and dead ball. The PPP cell is painted against their own " + f2(S.selfPpp) + " average, so green " +
      "is a set that dies on them and gold is a set that hurts us. Anything called fewer than three " +
      "times is left uncoloured — there is nothing to read there.");
    var F = D.playbookFlags || { use: 5, ppp: 7, min: 3 };
    var TAG = { "Called set": "", "Ball screen, no call": "no call", "No structure": "broken",
      "Early offense": "early", "Fastbreak": "break", "Press break": "press", "Vs zone": "zone",
      "Sideline": "", "Baseline": "", "After timeout": "ATO" };

    /* The order is the coach's to choose. The four blocks never merge, so
       whatever he sorts by he is still reading open court, half court, sideline
       and baseline apart from each other. */
    var SORTS = [
      ["use", "Volume", function (a, b) { return b.n - a.n || b.poss - a.poss; }],
      ["ppp", "PPP", function (a, b) { return b.ppp - a.ppp || b.n - a.n; }],
      ["efg", "eFG%", function (a, b) { return b.efg - a.efg || b.n - a.n; }],
      ["end", "Ends in", function (a, b) {
        return String(a.end1 || "￿").localeCompare(String(b.end1 || "￿")) || b.n - a.n; }],
      ["ser", "Series", function (a, b) {
        return String(a.code || "￿" + a.label).localeCompare(String(b.code || "￿" + b.label)); }]
    ];
    var bar = el("div", "sxp-sortbar");
    bar.appendChild(el("span", "sxp-sortlbl", "Order by"));
    var TP = tableShell([{ t: "Set" }, { t: "Call" }, { t: "Runs", cls: "n" }, { t: "PPP", cls: "n" },
      { t: "eFG%", cls: "n" }, { t: "Ends in" }, { t: "vs avg", cls: "n cream" }]);

    function pbRow(r) {
      var tr = el("tr", (r.flagUse || r.flagPpp) ? "flag" : "");
      var name = el("td", "sxp-lbl");
      name.appendChild(document.createTextNode(r.label));
      var tg = TAG[r.kind] != null ? TAG[r.kind] : r.kind;
      if (tg) name.appendChild(el("span", "sxp-ptag", tg));
      if (r.flagUse) name.appendChild(el("span", "sxp-flag use", "TOP " + F.use + " USE"));
      if (r.flagPpp) name.appendChild(el("span", "sxp-flag ppp", "TOP " + F.ppp + " PPP"));
      tr.appendChild(name);
      tr.appendChild(callCell(r.call));
      tr.appendChild(plain(r.n));
      tr.appendChild(r.n >= F.min ? pppCell(r.ppp, S.selfPpp, "O", 3) : plain(f2(r.ppp), "muted"));
      tr.appendChild(plain(r.efg + "%"));
      tr.appendChild(el("td", "sxp-ends", (r.ends || []).join(" · ")));
      tr.appendChild(plain(r.n >= F.min ? sgn(r.ppp - S.selfPpp) : "—", "cream"));
      return tr;
    }
    function pbFill(cmp) {
      TP.body.innerHTML = "";
      var left = D.playbook.slice();
      BANDS.concat([null]).forEach(function (band) {
        var rows = band === null ? left
          : D.playbook.filter(function (r) { return r.band === band; });
        if (band !== null) left = left.filter(function (r) { return r.band !== band; });
        if (!rows.length) return;
        rows = rows.slice().sort(cmp);
        var calls = 0; rows.forEach(function (r) { calls += r.n; });
        var bt = el("tr", "band");
        var btd = el("td", "", (band === null ? "Other" : band) + " · " + rows.length +
          " set" + (rows.length === 1 ? "" : "s") + " · " + calls + " calls");
        btd.colSpan = 7; bt.appendChild(btd); TP.body.appendChild(bt);
        rows.forEach(function (r) { TP.body.appendChild(pbRow(r)); });
      });
    }
    SORTS.forEach(function (s, i) {
      var btn = el("button", "sxp-sortb" + (i === 0 ? " on" : ""), s[1]);
      btn.type = "button";
      btn.addEventListener("click", function () {
        Array.prototype.forEach.call(bar.querySelectorAll(".sxp-sortb"),
          function (x) { x.classList.remove("on"); });
        btn.classList.add("on");
        pbFill(s[2]);
      });
      bar.appendChild(btn);
    });
    b4c.classList.add("sxp-pbmove");
    b4c.appendChild(bar);
    pbFill(SORTS[0][2]);
    b4c.appendChild(TP.wrap);
    tnote(b4c, "Every set they called is here, including the ones called once — those keep their " +
      "PPP uncoloured, because one possession is not a number. The red marks are the two things " +
      "worth walking into the gym with: the " + F.use + " sets they call most, and the " + F.ppp +
      " that hurt us most, the second read only among sets called at least " + F.min + " times. " +
      "A ball screen run with no set called is kept as its own type inside the same table.");

    /* use by quarter */
    if (D.usequarter.rows.length) {
      var b4d = sub(s4, "Use by quarter", "Whether what they call changes as the game goes on. Darker is more.");
      var TQ = tableShell([{ t: "Origin" }, { t: "Poss", cls: "n" },
        { t: "Q1", cls: "n" }, { t: "Q2", cls: "n" }, { t: "Q3", cls: "n" }, { t: "Q4", cls: "n" }]);
      var mxq = 0;
      D.usequarter.rows.forEach(function (r) {
        ["Q1", "Q2", "Q3", "Q4"].forEach(function (q) { mxq = Math.max(mxq, r[q]); });
      });
      D.usequarter.rows.forEach(function (r) {
        var tr = el("tr");
        tr.appendChild(lbl(r.label));
        tr.appendChild(plain(r.n));
        ["Q1", "Q2", "Q3", "Q4"].forEach(function (q) { tr.appendChild(heatCell(r[q], mxq)); });
        TQ.body.appendChild(tr);
      });
      var tf = el("tfoot"), tfr = el("tr");
      tfr.appendChild(lbl("Possessions in the quarter"));
      tfr.appendChild(el("td"));
      ["Q1", "Q2", "Q3", "Q4"].forEach(function (q) { tfr.appendChild(plain(D.usequarter.qtot[q] || 0)); });
      tf.appendChild(tfr); TQ.table.appendChild(tf);
      b4d.appendChild(TQ.wrap);
    }

    /* second chance — beside the league's team analysis rather than buried in "how they
       attack": what they take back off their own glass is the same kind of claim as the
       four factors next to it, and the two are read together or not at all */
    var sSC = section(rowAn, "03", "Second chance",
      "They crash the glass. The question is whether it pays.");
    tabOf(sSC, "off");
    var b4e = sub(sSC, "", "They crash the glass. The question is whether it pays.");
    var stats = el("div", "sxp-stats");
    /* The tagging can say what share of its own misses this club takes back. What it
       cannot say is whether that share is any good, because it has nothing to compare
       with but itself - so the league's own average comes in from the feed, and the gap
       is written next to it. */
    var LO = null; try{ LO = window.LowenLeagueORB && window.LowenLeagueORB(); }catch(e){}
    var orbRows = [["Offensive rebounds", D.second.orb, D.second.orbRate + "% of their own misses"],
     ["Possessions extended", D.second.chains, "over " + M.ngames + " games"],
     ["Points from them", D.second.pts, f2(D.second.ppp) + " per extended possession"],
     ["Reference", f2(D.second.refPpp), "per extended possession, all tagged games"]];
    if (LO && LO.off != null) {
      var gap = D.second.orbRate - LO.off;
      orbRows.push(["League OREB%", LO.off.toFixed(1) + "%",
        "average of " + LO.clubs + " clubs · they are " +
        (gap >= 0 ? "+" : "−") + Math.abs(gap).toFixed(1) + " on it"]);
    }
    orbRows.forEach(function (x) {
      var d = el("div");
      d.appendChild(el("dt", "", x[0]));
      d.appendChild(el("dd", "", String(x[1])));
      d.appendChild(el("small", "", x[2]));
      stats.appendChild(d);
    });
    b4e.appendChild(stats);

    /* ------------------------------------------ 05 how they defend */
    var s5 = section(root, "06", "How they defend — where we attack",
      "The column here is what they allow, so a high number is a bad number for them — and the " +
      "colour already says so: green where they concede, gold where they hold.");
    tabOf(s5, "def bs");
    var b5a = tabOf(sub(s5, "By situation", "The table the game plan comes out of."), "def");
    edgeTable(b5a, D.defsit, "Situation", "PPP allowed", [["efg", "eFG%"], ["p3r", "3PAr"]],
      S.bsPpp != null ? ("The ball screen is " + S.bsFreq + "% of everything they defend and it is where " +
        "they leak: " + f2(S.bsPpp) + " against a " + f2(S.bsRef) + " reference.") : "");
    var b5b = tabOf(sub(s5, "Ball screen coverage", "What each coverage costs them."), "bs");
    edgeTable(b5b, D.coverage, "Coverage", "PPP allowed",
      [["efg", "eFG%"], ["p3r", "3PAr"], ["tov", "TOV%"],
       ["n4", "w/ 4", "p"], ["n5", "w/ 5", "p"]],
      "The last two columns are which big defended the screen: the 4 on the "
      + M.tag.big4N + " possessions tagged \u201cPnR 4\u201d, the 5 on the rest. A few guard "
      + "screens are in neither, so the two do not always add up to the possessions.");

    /* ---- the 4 or the 5. What the tagging can and cannot say is in bigOf; the table
       says it on the page too, because a reader who takes the second row for "the 5"
       without reading it is reading an assumption as a measurement. */
    if (D.covbig.length > 1) {
      /* it lives under the coverage table rather than in a panel of its own: the group is
         laid out two panels to a row and a seventh would be left alone across the page */
      var b5bb = b5b;
      b5bb.appendChild(el("div", "sxp-sub sxp-sub2", "Who is in the ball screen"));
      var TB = tableShell([{ t: "Screen" }, { t: "Poss", cls: "n" }, { t: "% all", cls: "n" },
        { t: "PPP allowed", cls: "n" }, { t: "eFG%", cls: "n" }]);
      var btot = 0; D.covbig.forEach(function (r) { btot += r.poss; }); btot = btot || 1;
      var bmx = 0; D.covbig.forEach(function (r) { bmx = Math.max(bmx, r.poss / btot * 100); });
      var emx = D.covbig.reduce(function (m, r) { return Math.max(m, r.efg || 0); }, 0) || 1;
      D.covbig.forEach(function (r) {
        var tr = el("tr", r.conf < 2 ? "dim" : "");
        tr.appendChild(lbl(r.label));
        tr.appendChild(plain(Math.round(r.poss)));
        tr.appendChild(shareCell(Math.round(r.poss / btot * 100), bmx));
        tr.appendChild(pppCell(r.ppp, r.ref, r.side, r.conf));
        tr.appendChild(shareCell(r.efg, emx));
        TB.body.appendChild(tr);
      });
      b5bb.appendChild(TB.wrap);

      /* and the same screens read sideways: every coverage under each big, how often and
         what it cost them. This is the table the question was actually about — a team that
         drops with the five and switches with the four is two defenses, and this is where
         that shows. */
      if (D.covbybig.rows.length) {
        b5bb.appendChild(el("div", "sxp-sub sxp-sub2", "How they cover each of them"));
        var TX2 = tableShell([
          { t: "Coverage", rows: 2 },
          { t: "Their 4", span: 3, cls: "grpd" }, { t: "Their 5", span: 3, cls: "grpd" }]);
        var hr2 = el("tr");
        ["Poss", "% of his", "PPP", "Poss", "% of his", "PPP"]
          .forEach(function (t) { hr2.appendChild(el("th", "n", t)); });
        TX2.head.appendChild(hr2);
        var bigRow = function (label, cells, ref, cls) {
          var tr = el("tr", cls || "");
          tr.appendChild(lbl(label));
          cells.forEach(function (c) {
            tr.appendChild(plain(c.n ? Math.round(c.poss) : "\u2014", c.n ? "" : "muted"));
            /* a nought here is "he was never in this coverage", and painting that as a
               full red cell shouts about nothing — the row already says it with a dash */
            tr.appendChild((c.share == null || !c.n) ? plain("\u2014", "muted")
              : shareCell(c.share, 100));
            tr.appendChild(c.ppp == null ? plain("\u2014", "muted")
              : pppCell(c.ppp, ref, "D", c.conf));
          });
          return tr;
        };
        /* the total row is the only one where the share is not a share of itself */
        var tot = D.covbybig.total.map(function (c) {
          return { n: c.n, poss: c.poss, ppp: c.ppp, conf: c.conf, share: null };
        });
        TX2.body.appendChild(bigRow("Any ball screen", tot, D.covbybig.totalRef, "sxp-tot"));
        D.covbybig.rows.forEach(function (r) {
          TX2.body.appendChild(bigRow(r.label, r.cells, r.ref));
        });
        b5bb.appendChild(TX2.wrap);
        tnote(TX2.wrap, "The same ball screens split by which big defended them. \u201c% of his\u201d "
          + "is out of everything that big defends, which is what makes the two columns "
          + "comparable \u2014 four possessions beside thirty-seven is not. A dash means that big "
          + "was never in that coverage; a pale PPP means too few possessions to read as a rate.");
      }

      /* who is tagged in those clips, and the clips themselves */
      if (D.bigwho && D.bigwho.some(function (w) { return w.n; })) {
        b5bb.appendChild(el("div", "sxp-sub sxp-sub2", "Who is in those clips"));
        var TW = tableShell([{ t: "Split" }, { t: "Player tagged" }, { t: "Clips", cls: "n" },
          { t: "Poss", cls: "n" }, { t: "PPP", cls: "n" }]);
        D.bigwho.forEach(function (w) {
          var name = w.key === "4" ? "Their 4" : "Their 5";
          var head = el("tr", "sxp-tot");
          head.appendChild(lbl(name));
          head.appendChild(plain(w.tagged + " of " + w.n + " clips name a player"));
          head.appendChild(plain(w.n)); head.appendChild(plain("")); head.appendChild(plain(""));
          TW.body.appendChild(head);
          w.players.forEach(function (p) {
            var tr = el("tr");
            tr.appendChild(lbl("")); tr.appendChild(plain(p.label));
            tr.appendChild(plain(p.n)); tr.appendChild(plain(Math.round(p.poss)));
            tr.appendChild(p.ppp == null ? plain("—", "muted") : pppCell(p.ppp, D.covbybig.totalRef, "D", p.conf));
            TW.body.appendChild(tr);
          });
          if (!w.players.length) {
            var none = el("tr"); none.appendChild(lbl(""));
            none.appendChild(plain("no clip names a player", "muted"));
            none.appendChild(plain("")); none.appendChild(plain("")); none.appendChild(plain(""));
            TW.body.appendChild(none);
          }
        });
        b5bb.appendChild(TW.wrap);
        tnote(TW.wrap, "The tagging does not say which player is the 4 or the 5: “their 4” is "
          + "every clip tagged “PnR 4” and “their 5” is every other ball screen. These are "
          + "the players named on those clips, where one is named — the man the clip is about, "
          + "who is not always the big in the screen. The list below is every clip, to check on video.");
        var det = document.createElement("details");
        det.className = "sxp-clips";
        var sm = document.createElement("summary");
        sm.textContent = "Every clip in the split — game, quarter and time in the video";
        det.appendChild(sm);
        var TV = tableShell([{ t: "Split" }, { t: "Game" }, { t: "Q", cls: "n" }, { t: "Time", cls: "n" },
          { t: "Tagged as" }, { t: "Coverage" }, { t: "Player" }, { t: "Pts", cls: "n" }]);
        D.bigwho.forEach(function (w) {
          w.clips.forEach(function (c) {
            var tr = el("tr");
            tr.appendChild(lbl(w.key === "4" ? "Their 4" : "Their 5"));
            tr.appendChild(plain(c.game || "")); tr.appendChild(plain(c.period || ""));
            tr.appendChild(plain(c.at)); tr.appendChild(plain(c.cat));
            tr.appendChild(plain(c.cov || "—", c.cov ? "" : "muted"));
            tr.appendChild(plain(c.who || "—", c.who ? "" : "muted"));
            tr.appendChild(plain(c.pts == null ? "" : c.pts));
            TV.body.appendChild(tr);
          });
        });
        det.appendChild(TV.wrap);
        b5bb.appendChild(det);
      }

      /* ---- and the same thing with the rival on the row ----
         Everything above is the season added up, and an average is exactly where a night
         somebody took one coverage apart disappears. One row per opponent: read across
         for how that team did against each coverage, down a column for the one that
         leaks against everybody. */
      if (D.covbygame && D.covbygame.rows.length > 1) {
        b5bb.appendChild(el("div", "sxp-sub sxp-sub2", "Game by game \u2014 who attacked what"));
        var CG = D.covbygame;
        var TX3 = tableShell([{ t: "Game" }, { t: "Any screen", cls: "n" }]
          .concat(CG.keys.map(function (k) { return { t: k, cls: "n" }; })));
        var cgCell = function (c, ref) {
          if (!c || !c.n) return plain("\u2014", "muted");
          var td = pppCell(c.ppp, ref, "D", c.conf);
          /* The count rides beside the rate: 1.42 off three possessions and off thirty
             are not the same number, and this row has no other column to say which. It
             goes OUTSIDE the coloured chip, so the colour stays on the rate alone. */
          td.appendChild(el("span", "sxp-n2", Math.round(c.poss)));
          return td;
        };
        var cgRow = function (label, r, cls) {
          var tr = el("tr", cls || "");
          tr.appendChild(lbl(label));
          tr.appendChild(cgCell(r.all, CG.totalRef));
          r.cells.forEach(function (c, i) { tr.appendChild(cgCell(c, CG.refs[i])); });
          return tr;
        };
        TX3.body.appendChild(cgRow("Every game", CG.total, "sxp-tot"));
        CG.rows.forEach(function (r) { TX3.body.appendChild(cgRow(r.game, r)); });
        b5bb.appendChild(TX3.wrap);
        tnote(TX3.wrap, "Points per possession against each coverage, one row per opponent, "
          + "with the possessions after the dot. The colour is against the same league "
          + "reference the table above uses, so a green cell is a night that coverage held "
          + "and a red one is a night it did not. A dash means that opponent never saw it. "
          + "Read a row for how one team attacked them and a column for the coverage "
          + "everybody scores on.");
      }
      /* the caveat goes on the table and not on the block, which already carries the
         coverage table's own note */
      tnote(TB.wrap, "The 4 row is the clips tagged “PnR 4”, which is how the staff mark a "
        + "screen their four defends: " + M.tag.big4N + " of " + M.tag.bigN + " ball screens across "
        + "these " + M.ngames + " games. Every other ball-screen category names where the screen "
        + "was and not who was in it, and about nine in ten of those are the five, so the second "
        + "row carries the one in ten that is not.");
    }

    if (D.covquarter.length) {
      var b5c = tabOf(sub(s5, "Coverage by quarter",
        "Whether the coverage they show early is the one they finish with. Darker is more."), "bs");
      var TC = tableShell([{ t: "Coverage" }, { t: "Poss", cls: "n" },
        { t: "w/ 4", cls: "n" }, { t: "w/ 5", cls: "n" },
        { t: "Q1", cls: "n" }, { t: "Q2", cls: "n" }, { t: "Q3", cls: "n" }, { t: "Q4", cls: "n" }]);
      var mxc2 = 0;
      D.covquarter.forEach(function (r) { ["Q1", "Q2", "Q3", "Q4"].forEach(function (q) { mxc2 = Math.max(mxc2, r[q]); }); });
      D.covquarter.forEach(function (r) {
        var tr = el("tr");
        tr.appendChild(lbl(r.label));
        tr.appendChild(plain(r.n));
        tr.appendChild(r.n4 ? heatCell(r.n4, r.n) : plain("—", "muted"));
        tr.appendChild(r.n5 ? heatCell(r.n5, r.n) : plain("—", "muted"));
        ["Q1", "Q2", "Q3", "Q4"].forEach(function (q) { tr.appendChild(heatCell(r[q], mxc2)); });
        TC.body.appendChild(tr);
      });
      b5c.appendChild(TC.wrap);
      if (S.q4tot) {
        tnote(b5c, S.q4switch + " of their " + S.q4tot + " fourth-quarter ball screens are switched, " +
          "against " + S.swEarly + " switches across the other three quarters put together.");
      }
    }

    if (D.covxfinish.rows.length) {
      var b5d = tabOf(sub(s5, "Coverage × how the possession ended",
        "What the opponent actually got out of each coverage. Darker is more."), "bs");
      var hd = [{ t: "Coverage" }, { t: "Poss", cls: "n" },
                { t: "w/ 4", cls: "n" }, { t: "w/ 5", cls: "n" }];
      D.covxfinish.cols.forEach(function (c) { hd.push({ t: c, cls: "n rot" }); });
      var TX = tableShell(hd);
      var mxx = 0;
      D.covxfinish.rows.forEach(function (r) { r.cells.forEach(function (v) { mxx = Math.max(mxx, v); }); });
      D.covxfinish.rows.forEach(function (r) {
        var tr = el("tr");
        tr.appendChild(lbl(r.label));
        tr.appendChild(plain(r.n));
        tr.appendChild(r.n4 ? heatCell(r.n4, r.n) : plain("—", "muted"));
        tr.appendChild(r.n5 ? heatCell(r.n5, r.n) : plain("—", "muted"));
        r.cells.forEach(function (v) { tr.appendChild(heatCell(v, mxx)); });
        TX.body.appendChild(tr);
      });
      b5d.appendChild(TX.wrap);
    }

    var b5e = tabOf(sub(s5, "What generates the shot against them", "The opponent action on the possessions they defend."), "def");
    edgeTable(b5e, D.generate, "Opponent action", "PPP allowed", [["efg", "eFG%"], ["p3r", "3PAr"]],
      "This table leans on the weakest descriptor in the tagging — only " + M.tag.actD +
      "% of defensive clips carry an action — so read it as a direction, not a measurement.");

    var b5f = tabOf(sub(s5, "Where they force turnovers", "Their pressure, measured against the reference."), "def");
    var TT = tableShell([{ t: "Situation" }, { t: "Poss", cls: "n" }, { t: "TO", cls: "n" },
      { t: "Rate", cls: "n" }, { t: "Ref", cls: "n" }, { t: "vs ref", cls: "n cream" }]);
    D.forceto.forEach(function (r) {
      var tr = el("tr", r.conf < 2 ? "dim" : "");
      tr.appendChild(lbl(r.label));
      tr.appendChild(plain(Math.round(r.poss)));
      tr.appendChild(plain(r.tov));
      if (r.ref == null) tr.appendChild(plain(r.rate + "%", "muted"));
      else {
        /* they force FEWER turnovers than the reference = good for us = green */
        var edge = r.ref - r.rate;
        tr.appendChild(perfChip(r.rate + "%", -edge, 10 * (r.conf < 2 ? 2.2 : 1)));
      }
      tr.appendChild(plain(r.ref == null ? "—" : r.ref + "%", "ref"));
      tr.appendChild(plain(r.ref == null ? "—" : ((r.rate - r.ref >= 0 ? "+" : "−") + Math.abs(r.rate - r.ref)), "cream"));
      TT.body.appendChild(tr);
    });
    b5f.appendChild(TT.wrap);
    tnote(b5f, "Red is below the reference and green above it, as everywhere else: a green rate " +
      "here means their pressure is real.");

    /* drawn here only when no PLAYERS STATS slot claimed it */
    if (!(opts && opts.skipPlayers)) { var sP = playersBlock(root, D, "07"); if (sP) tabOf(sP, "off"); }
    /* 07 "What this report cannot tell you" and the list of files read from
       Drive both lived here. Out, on request. The one caveat that changes how a
       number reads — the reference pools every file in the folder, this
       opponent's own games included — is said in the rule box at the top. */
  }



  /* A whole block still on its way is not a line of grey text: it is the shape of what is
     coming, shimmering, with the page's own small spinner and the reason above it. The
     heavy animation belongs to the splash; this is the quiet version of it. */
  function loadingBox(txt) {
    var box = el("div", "sxp-loading");
    box.appendChild(el("div", "ld", txt));
    var sk = el("div", "ld-skel");
    for (var i = 0; i < 5; i++) sk.appendChild(el("i"));
    box.appendChild(sk);
    return box;
  }
  function mount(host, run) {
    var box = el("div", "sxp-host");
    box.appendChild(loadingBox("Reading the tagging from Drive…"));
    host.parentNode.insertBefore(box, host);
    host.style.display = "none";
    run(box).catch(function (e) {
      box.innerHTML = "";
      var msg = String((e && e.message) || e);
      var wrap = el("div", "sxp-err");
      /* "err fetch failed" is the Drive function saying it could not reach Google: a
         missing or expired service account, or the folder not shared with it. Saying
         which call failed, and what to look at, beats a bare sentence. */
      if (/fetch failed|failed to fetch|networkerror/i.test(msg)) {
        wrap.appendChild(el("div", "", "The Drive folder could not be read (" + msg + ")."));
        wrap.appendChild(el("div", "sxp-files",
          "The tagging comes from /.netlify/functions/drive. Check in Netlify that the Drive "
          + "credentials are set and that the scouting folder is shared with that service account. "
          + "Everything else in this report is unaffected."));
      } else {
        wrap.appendChild(el("div", "", "Could not build the scouting stats: " + msg));
      }
      var again = el("button", "btn sm", "Try again");
      again.style.marginTop = "8px";
      again.addEventListener("click", function () { try { dropCache(); } catch (e2) {} scan(); });
      wrap.appendChild(again);
      box.appendChild(wrap);
      host.style.display = "";
    });
  }

  function opponentFromPage() {
    /* the report header carries "GAME vs <opponent>" / "@ <opponent>" */
    var n = document.querySelector(".scout-opp, .rep-opp, .week-label");
    var t = n ? n.textContent : "";
    var m = /(?:vs|@)\s+(.+?)\s*(?:·|\||$)/i.exec(t || "");
    return m ? m[1].trim() : "";
  }

  /* One pipeline, two consumers: the TEAM STATS block below and the Playbook
     section of the written report, which needs the same computed sets to fill
     its left column. Built once per opponent and kept. */
  var cacheRep = {};
  /* "Reading the tagging from Drive…" sat on the screen for as long as the page was open
     whenever the folder read neither answered nor failed - a token that has gone stale, a
     request that is simply dropped. A read gets half a minute and then it is a failure
     with a reason, which the block can show and the staff can retry. */
  var READ_WAIT = 30000;
  function within(ms, what, pr) {
    return new Promise(function (ok, no) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return; done = true;
        no(new Error(what + " did not answer in " + Math.round(ms / 1000) + "s"));
      }, ms);
      pr.then(function (v) { if (done) return; done = true; clearTimeout(t); ok(v); },
              function (e) { if (done) return; done = true; clearTimeout(t); no(e); });
    });
  }
  function buildFor(opponent) {
    var key = slug(opponent) || "_";
    if (!cacheRep[key]) {
      cacheRep[key] = within(READ_WAIT, "the Drive folder", listFolder()).then(function (all) {
        var names = all.map(function (f) { return f.name; });
        var calls = callSheets(all, opponent);
        /* the reference is every tagged game in the folder — call sheets are
           not games and never enter it */
        var files = all.filter(function (f) { return !isCallSheet(f.name); });
        if (!files.length) return { why: "empty", files: names, D: null, calls: calls };
        var mine = pickFiles(files, opponent);
        if (!mine.length) return { why: "nomatch", files: names, D: null, calls: calls };
        return Promise.all([
          loadCalls(calls),
          Promise.all(files.map(function (f) {
            return getText(f.id).then(function (txt) {
              var label = rivalLabel(f.name, opponent);
              var game = (mine.indexOf(f) >= 0 ? label : f.name);
              return { file: f, game: game, evs: buildEvents(parseFile(txt), game) };
            });
          }))
        ]).then(function (both) {
          var CALLS = both[0], all = both[1];
          var ours = all.filter(function (g) { return mine.indexOf(g.file) >= 0; });
          var D = buildReport(opponent || "Opponent", ours, all);
          /* the call sheet is keyed by the same code the tagging uses, so a set
             finds its call without anyone matching names */
          if (D) {
            D.calls = CALLS;
            D.playbook.forEach(function (r) {
              var c = r.code && CALLS ? CALLS[String(r.code).toUpperCase()] : null;
              r.call = (c && c.call) ? c.call : "";
            });
          }
          /* how many of the sets they ran actually found a call, which is the number that
             says whether the sheet is the right sheet */
          var hit = 0, codes = 0;
          if (D) D.playbook.forEach(function (r) { if (r.code) { codes++; if (r.call) hit++; } });
          return { why: D ? null : "nodata", files: names, D: D,
                   callFiles: calls.map(function (f) { return f.name; }),
                   callLog: CALLS_LOG.slice(), callHit: hit, callCodes: codes,
                   used: ours.map(function (g) { return g.file.name; }) };
        });
      }).catch(function (e) { delete cacheRep[key]; throw e; });
    }
    return cacheRep[key];
  }

  function hook(host) {
    var opponent = host.getAttribute("data-opponent") || opponentFromPage();
    mount(host, function (box) {
      return buildFor(opponent).then(function (R) {
        box.innerHTML = "";
        if (R.why === "empty") {
          box.appendChild(el("div", "sxp-empty", "No tagging files in the opponent Drive folder yet."));
          return;
        }
        if (R.why === "nomatch") {
          var e2 = el("div", "sxp-empty");
          e2.appendChild(el("div", "", "No file in the scouting folder matches “" + (opponent || "—") + "”."));
          e2.appendChild(el("div", "sxp-files", "In the folder: " + R.files.join(" · ")));
          box.appendChild(e2);
          return;
        }
        if (!R.D) {
          box.appendChild(el("div", "sxp-empty", "Those files carry no usable possessions."));
          return;
        }
        render(box, R.D, R.used, { skipPlayers: !!document.querySelector(".scoutpre-players-slot") || !!window.__preOneTable });
      });
    });
  }

  /* The players table is asked for at the top of the report, in PLAYERS STATS,
     not at the bottom of TEAM STATS. Same pipeline, same cache, its own host. */
  function hookPlayers(host) {
    var opponent = host.getAttribute("data-opponent") || opponentFromPage();
    mount(host, function (box) {
      return buildFor(opponent).then(function (R) {
        box.innerHTML = "";
        box.className = "sxp sxp-host";
        if (R.why === "empty" || R.why === "nomatch" || !R.D) {
          /* TEAM STATS says why in full; up here one line is enough */
          var e3 = el("div", "sxp-empty");
          e3.appendChild(el("div", "", R.why === "nomatch"
            ? "No tagging file in the scouting folder matches \u201c" + (opponent || "\u2014") + "\u201d."
            : "No opponent tagging in the Drive folder yet."));
          /* the folder's contents belong next to the complaint: nine times in ten the file
             is there under a name nobody expected, and that is visible at a glance */
          if ((R.files || []).length) e3.appendChild(el("div", "sxp-files", "In the folder: " + R.files.join(" \u00b7 ")));
          box.appendChild(e3);
          return;
        }
        var M = R.D.meta;
        try {
          box.title = "From the tagging of " + M.team + " \u00b7 " + M.ngames + " game" +
            (M.ngames === 1 ? "" : "s") + " (" + M.games.join(" \u00b7 ") + ")";
        } catch (e) {}
        if (!playersBlock(box, R.D, "01")) {
          box.appendChild(el("div", "sxp-empty", "The tagging carries no player tags for this opponent."));
        }
      });
    });
  }

  function scan() {
    var slots = document.querySelectorAll(".scoutpre-slot");
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].dataset.sxpDone) continue;
      slots[i].dataset.sxpDone = "1";
      hook(slots[i]);
    }
    var ps = document.querySelectorAll(".scoutpre-players-slot");
    for (var j = 0; j < ps.length; j++) {
      if (ps[j].dataset.sxpDone) continue;
      ps[j].dataset.sxpDone = "1";
      hookPlayers(ps[j]);
    }
  }
  function css() {
    var s = document.createElement("style");
    s.textContent = [
      ".sxp{font-size:13px;color:var(--ink);--cream:rgba(176,135,60,.13);--creamline:rgba(176,135,60,.3)}",
      ".sxp-host{margin:6px 0 4px}",
      ".scoutpre-slot,.scoutpre-players-slot{border:1px dashed var(--line-strong,#ccc);border-radius:10px;padding:22px;",
      "color:var(--ink-faint);font-size:13px;line-height:1.5;text-align:center;background:rgba(0,0,0,.015)}",
      ".sxp-loading,.sxp-empty{border:1px dashed var(--line-strong,#ccc);border-radius:10px;padding:20px;",
      /* the loading variant holds a spinner and a skeleton, which are read from the left */
      ".sxp-loading{text-align:left;padding:14px 16px}",
      "color:var(--ink-faint);font-size:13px;text-align:center}",
      ".sxp-err{border:1px solid var(--alert,#c0392b);border-radius:10px;padding:14px;color:var(--alert,#c0392b);font-size:13px}",
      ".sxp-meta{font:400 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink-faint);margin:2px 0 12px}",
      ".sxp-files{font-size:11px;color:var(--ink-faint);margin-top:10px;line-height:1.5}",
      ".sxp-warn{border:1px solid var(--gold-2,#b0873c);border-left:4px solid var(--gold-2,#b0873c);",
      "background:var(--accent-soft,#f6efe0);border-radius:9px;padding:11px 14px;margin:0 0 12px;",
      "display:grid;gap:5px}",
      ".sxp-warn b{font-size:12.5px;color:#7a5a20}",
      ".sxp-warn span{font-size:11.5px;color:var(--ink-soft);line-height:1.55}",

      ".sxp-rulebox{border:1px solid var(--line);border-radius:10px;padding:13px 15px;background:var(--panel,#fff);margin-bottom:12px}",
      ".sxp-keyrow{display:flex;align-items:center;gap:11px;margin-bottom:9px;flex-wrap:wrap}",
      ".sxp-k{font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;white-space:nowrap}",
      ".sxp-k.us{color:#27654c}.sxp-k.them{color:#8a6829}",
      ".sxp-grad{flex:1 1 180px;min-width:140px;height:13px;border-radius:4px;display:block;",
      "background:linear-gradient(90deg,#8a6829,#b0873c,#e0c99b,#f1f2f4 48%,#f1f2f4 52%,#a9c9b9,#44876a,#27654c)}",
      ".sxp-rulep{font-size:12.5px;color:var(--ink-soft);line-height:1.55;margin:0;max-width:82ch}",
      ".sxp-tnote{font-size:11.5px;color:var(--ink-faint);margin:8px 0 0;max-width:86ch;line-height:1.55}",

      ".sxp-idwrap{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:6px}",
      "@media(max-width:820px){.sxp-idwrap{grid-template-columns:1fr}}",
      ".sxp-idp{border:1px solid var(--line);border-radius:10px;background:var(--panel,#fff);padding:14px 16px}",
      ".sxp-idp.off{border-top:3px solid #5a76a2}.sxp-idp.def{border-top:3px solid #44876a}",
      ".sxp-idh h3{font-size:15px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;margin:0}",
      ".sxp-idh p{color:var(--ink-faint);font-size:12px;margin:2px 0 0}",
      ".sxp-hero{display:flex;align-items:baseline;gap:10px;margin-top:9px;flex-wrap:wrap}",
      ".sxp-big{font:800 40px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.02em}",
      ".sxp-unit{font-size:11.5px;color:var(--ink-faint);line-height:1.35}",
      ".sxp-unit i{font-style:normal;font-weight:700;color:var(--ink-soft)}",
      ".sxp-badge{font-size:10px;font-weight:800;letter-spacing:.1em;padding:4px 8px;border-radius:5px;align-self:center}",
      ".sxp-badge.good{background:#27654c;color:#fff}.sxp-badge.bad{background:var(--alert,#c0392b);color:#fff}",
      ".sxp-tgt{position:relative;height:14px;border-radius:4px;background:rgba(0,0,0,.08);margin-top:11px;overflow:hidden}",
      ".sxp-tfill{position:absolute;left:0;top:0;bottom:0;border-radius:4px}",
      ".sxp-tfill.g{background:#44876a}.sxp-tfill.b{background:#b0873c}",
      ".sxp-tmk{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--ink)}",
      ".sxp-tlab{display:flex;justify-content:space-between;font:400 10px/1 ui-monospace,monospace;color:var(--ink-faint);margin-top:4px}",
      ".sxp-tlab .mid{color:var(--ink-soft);font-weight:700}",
      ".sxp-ci{font:400 11.5px ui-monospace,monospace;color:var(--ink-faint);margin-top:6px}",
      ".sxp-idrow{display:grid;grid-template-columns:1fr 1fr;gap:9px 16px;margin:13px 0 0;padding:11px 0 0;border-top:1px solid var(--line)}",
      ".sxp-idrow dt{font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-faint)}",
      ".sxp-idrow dd{margin:4px 0 0;font:700 15px ui-monospace,monospace}",
      ".sxp-ev{font:700 12.5px ui-monospace,monospace}",
      ".sxp-ev.pos{color:#17805A}.sxp-ev.neg{color:#C53727}",
      ".sxp-luck{margin:11px 0 0;font-size:12.5px;color:var(--ink-soft);background:rgba(0,0,0,.035);border-radius:7px;padding:9px 11px;line-height:1.5}",
      ".sxp-shot{margin-top:13px}",
      ".sxp-shotlbl{font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:6px}",
      ".sxp-shotbar{display:flex;height:21px;gap:2px;margin-bottom:3px}",
      ".sxp-shotbar i{font:800 10px/21px ui-monospace,monospace;font-style:normal;text-align:center;overflow:hidden;white-space:nowrap;border-radius:4px}",
      ".sxp-shotbar .s2{background:#44876a;color:#fff}.sxp-shotbar .s3{background:#b3c3da;color:#12161d}",
      ".sxp-shotbar.ref{height:5px;opacity:.5}",
      ".sxp-shotfoot{font-size:11px;color:var(--ink-faint);margin-top:5px;line-height:1.5}",

      /* the same header the rest of the report uses: small, uppercase, over a rule */
      /* Blocks, not bands: the sub-blocks of a section sit side by side and wrap, so a
         narrow table stops taking the whole screen. A section that holds one wide table
         keeps it - the grid is on the blocks inside a section, not on the sections. */
      ".sxp-sec{border-top:1px solid var(--line);margin-top:26px;padding-top:12px}",
      ".sxp-sec{display:grid;grid-template-columns:1fr;gap:14px 16px;align-items:start}",
      ".sxp-sec > .sxp-sechead{grid-column:1/-1}",
      ".sxp-sec > .sxp-blk{min-width:0}",
      ".sxp-sec > .sxp-blk.wide{grid-column:1/-1}",
      ".sxp-sechead{display:flex;align-items:baseline;gap:9px}",
      ".sxp-num{font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;",
      "color:var(--gold-2,#b0873c);letter-spacing:.1em}",
      ".sxp-h2{font-family:var(--f-head,'Oswald',sans-serif);font-size:15px;font-weight:700;",
      "text-transform:uppercase;letter-spacing:.1em;margin:0}",
      ".sxp-lede{color:var(--ink-faint);font-size:12.5px;margin:6px 0 0;max-width:80ch;line-height:1.5}",
      ".sxp-blk{padding:16px 0 2px}",
      ".sxp-sub{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;letter-spacing:.13em;",
      "text-transform:uppercase;color:var(--ink-soft);margin:18px 0 3px}",
      ".sxp-sub:before{content:'\\2014';color:var(--gold-2,#b0873c);font-weight:800}",
      ".sxp-what{color:var(--ink-faint);font-size:12px;margin:2px 0 0;max-width:80ch;line-height:1.5}",

      ".sxp-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:8px;",
      "border:1px solid var(--line);border-radius:9px;background:var(--panel,#fff)}",
      ".sxp-t{border-collapse:collapse;width:100%;background:transparent;font-variant-numeric:tabular-nums}",
      ".sxp-t thead th{background:rgba(0,0,0,.035);color:var(--ink-faint);font-weight:700;font-size:9.5px;",
      "letter-spacing:.08em;text-transform:uppercase;text-align:left;padding:7px 9px;white-space:nowrap;",
      "border-bottom:1px solid var(--line)}",
      ".sxp-t thead th.n{text-align:right}",
      ".sxp-t thead th.rot{font-size:9px;letter-spacing:.02em}",
      /* Every column sorts — the page-wide listener does it. All this says is that the
         heading can be clicked, because a control nobody can see is a control nobody uses,
         and that is why this was asked for twice. The caret slot is always reserved, so a
         heading does not change width when the table is re-sorted and the twin measurement
         stays true. */
      ".sxp-t thead th{cursor:pointer;user-select:none;-webkit-user-select:none}",
      ".sxp-t thead th:hover{background:rgba(0,0,0,.075);color:var(--ink)}",
      ".sxp-t thead th::after{display:inline-block;width:7px;margin-left:3px;font-size:8px}",
      ".sxp-t thead th:not(.sort-up):not(.sort-down)::after{content:\"▾\";opacity:0}",
      ".sxp-t thead th:hover:not(.sort-up):not(.sort-down)::after{opacity:.35}",
      ".sxp-t thead th.sort-up,.sxp-t thead th.sort-down{color:var(--ink);background:rgba(0,0,0,.075)}",
      ".sxp-t thead th.grpo{background:#dfe5ef;color:#3a597e;text-align:center;letter-spacing:.12em}",
      ".sxp-t thead th.grpd{background:#e2ece6;color:#27654c;text-align:center;letter-spacing:.12em}",
      ".sxp-t thead th.cream{background:var(--cream);color:#8a6829;border-left:1px solid var(--creamline)}",
      ".sxp-t td{padding:3px 5px;border-bottom:1px solid var(--line);font-size:12.5px;white-space:nowrap;vertical-align:middle}",
      ".sxp-t tbody tr:last-child td{border-bottom:0}",
      ".sxp-lbl{font-weight:700;white-space:normal;min-width:140px;padding-left:10px !important;color:var(--ink)}",
      /* the coverage mix beside each big: a reading line, not a heading */
      ".sxp-t tr.sxp-tot td{background:rgba(0,0,0,.04);font-weight:700}",
      /* a second heading inside one panel needs the air a panel boundary would have given it */
      ".sxp-sub2{margin-top:16px}",
      ".sxp-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px;padding:4px;border-radius:11px;background:rgba(20,24,33,.05)}",
      ".sxp-tab{flex:1 1 auto;border:0;background:transparent;border-radius:8px;padding:8px 14px;cursor:pointer;font:700 11px 'Oswald',sans-serif;letter-spacing:.13em;text-transform:uppercase;color:#5b6472}",
      ".sxp-tab:hover{background:rgba(20,24,33,.07);color:#141821}",
      ".sxp-tab.on{background:#141821;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)}",
      ".sxp-card{border:1px solid var(--line,#e4e7ec);border-radius:11px;background:var(--panel,#fff);padding:10px 12px 10px!important}",
      ".sxp-card > .sxp-sub:first-child{margin:0 0 6px;padding:0 0 7px;border-bottom:2px solid #141821;color:#141821;font-family:'Oswald',sans-serif;font-size:11.5px}",
      ".sxp-card > .sxp-sub:first-child:before{content:none}",
      ".sxp-card .sxp-scroll{border:0;border-radius:0;margin-top:4px}",
      ".sxp[data-tab] > .sxp-sec,.sxp[data-tab] .sxp-row > .sxp-sec{border-top:0;margin-top:14px;padding-top:0}",
      "@media (min-width:1100px){.sxp[data-tab] .sxp-sec{grid-template-columns:repeat(2,minmax(0,1fr))}",
      ".sxp[data-tab] .sxp-sec > .sxp-sechead + .sxp-card:last-child{grid-column:1/-1}}",
      "@media screen{",
      "body:not(.prt) .sxp[data-tab='over'] [data-tabs]:not([data-tabs~='over']){display:none!important}",
      "body:not(.prt) .sxp[data-tab='off'] [data-tabs]:not([data-tabs~='off']){display:none!important}",
      "body:not(.prt) .sxp[data-tab='def'] [data-tabs]:not([data-tabs~='def']){display:none!important}",
      "body:not(.prt) .sxp[data-tab='bs'] [data-tabs]:not([data-tabs~='bs']){display:none!important}",
      "body:not(.prt) .sxp[data-tab='games'] [data-tabs]:not([data-tabs~='games']){display:none!important}",
      "body:not(.prt) .sxp[data-tab='over'] .ts-analysis,body:not(.prt) .sxp[data-tab='off'] .ts-analysis{display:none!important}",
      "body:not(.prt) .sxp[data-tab]:not([data-tab='all']) .sxp-row.sxp-rowA,body:not(.prt) .sxp[data-tab]:not([data-tab='all']) .sxp-row.sxp-rowAn{grid-template-columns:minmax(0,1fr)!important}",
      "}",
      "@media print{.sxp-tabs{display:none!important}}",
      "body.prt .sxp-tabs{display:none!important}",
      ".sxp-clips{margin-top:8px}",
      ".sxp-clips>summary{cursor:pointer;font-size:12px;color:#5b6472;padding:4px 0}",
      ".sxp-clips .sxp-scroll{max-height:420px;overflow:auto}",
      ".sxp-c{text-align:right}",
      /* the possession count beside a rate: present, and clearly not the number */
      ".sxp-n2{margin-left:5px;font-size:9px;color:var(--ink-faint);font-variant-numeric:tabular-nums}",
      ".sxp-v{display:block;padding:4px 8px;border-radius:5px;text-align:right;font-size:12px;",
      "font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
      ".sxp-v.chip{font-weight:800;color:#12161d}",
      ".sxp-v.chip.on{color:#fff}",
      ".sxp-c.ref .sxp-v,.sxp-c.muted .sxp-v{color:var(--ink-faint)}",
      /* a player who missed games: the column is his average, not the team's */
      ".sxp-c.warn .sxp-v{color:#8a5a12;font-weight:800}",
      ".sxp-c.sep,.sxp-t th.sep{border-left:1px solid var(--line-strong,rgba(0,0,0,.14))}",
      ".sxp-c.cream{background:var(--cream);border-left:1px solid var(--creamline)}",
      ".sxp-c.cream .sxp-v{font-weight:800}",
      ".sxp-ends{font-size:11px;color:var(--ink-soft);white-space:normal;min-width:170px}",
      ".sxp-callc{text-align:left!important;white-space:nowrap}",
      ".sxp-call{display:inline-block;font:800 11px ui-monospace,SFMono-Regular,Menlo,monospace;",
      "background:var(--accent-soft,#f6efe0);color:#7a5a20;border:1px solid var(--gold-1,#d8b877);",
      "border-radius:5px;padding:2px 7px}",
      ".sxp-nocall{display:inline-block;font:400 10.5px ui-monospace,monospace;color:var(--ink-faint);",
      "border:1px dashed var(--line-strong,#d2d7df);border-radius:5px;padding:2px 7px;opacity:.75}",
      ".sxp-t tbody tr.dim td{opacity:.5}",
      ".sxp-t tbody tr.tot td{background:var(--cream);font-weight:800;border-top:1px solid var(--creamline)}",
      ".sxp-t tbody tr.band td{background:rgba(0,0,0,.05);font-size:10px;font-weight:800;",
      "letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);padding:7px 10px}",
      ".sxp-t tfoot td{font-size:11px;color:var(--ink-faint);background:rgba(0,0,0,.035);border-top:1px solid var(--line)}",
      ".sxp-sortbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:9px 0 0}",
      ".sxp-sortlbl{font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;",
      "color:var(--ink-faint);margin-right:2px}",
      ".sxp-sortb{font:700 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
      "border:1px solid var(--line-strong,#ccc);background:var(--panel,#fff);color:var(--ink-soft);",
      "border-radius:6px;padding:6px 11px;cursor:pointer}",
      ".sxp-sortb:hover{border-color:var(--ink-faint);color:var(--ink)}",
      ".sxp-sortb.on{background:var(--ink);color:#fff;border-color:var(--ink)}",
      ".sxp-flag{display:inline-block;font:800 9px/1 ui-monospace,monospace;letter-spacing:.05em;",
      "border-radius:3px;padding:3px 5px;margin-left:5px;vertical-align:1px;white-space:nowrap}",
      ".sxp-flag.use{background:var(--alert,#c0392b);color:#fff;border:1px solid var(--alert,#c0392b)}",
      ".sxp-flag.ppp{background:transparent;color:var(--alert,#c0392b);border:1px solid var(--alert,#c0392b)}",
      ".sxp-t tbody tr.flag td{background:rgba(192,57,43,.045)}",
      ".sxp-t tbody tr.flag .sxp-lbl{box-shadow:inset 3px 0 0 var(--alert,#c0392b)}",
      ".sxp-ptag{display:inline-block;font:800 9px/1 ui-monospace,monospace;letter-spacing:.06em;",
      "text-transform:uppercase;color:var(--ink-faint);border:1px solid var(--line-strong,#ccc);",
      "border-radius:3px;padding:2px 5px;margin-left:6px;vertical-align:1px}",

      ".sxp-qwrap{display:grid;grid-template-columns:1fr;gap:12px;margin-top:8px;align-items:start}",
      ".sxp-qwrap > *{min-width:0}",
      ".sxp-qcard{border:1px solid var(--line);border-radius:9px;background:var(--panel,#fff);padding:12px}",
      ".sxp-qcard h4{font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-soft);margin:0 0 9px}",
      ".sxp-qgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}",
      ".sxp-qcell{text-align:center}.sxp-qcell.dim{opacity:.5}",
      ".sxp-qbars{display:flex;align-items:flex-end;justify-content:center;gap:4px;height:76px;border-bottom:1px solid var(--line-strong,#ccc)}",
      ".sxp-qb{width:18px;position:relative;min-height:3px;border-radius:3px 3px 0 0}",
      ".sxp-qb.o{background:#5a76a2}.sxp-qb.d{background:#44876a}",
      ".sxp-qb b{position:absolute;top:-13px;font:800 9px ui-monospace,monospace;color:var(--ink-soft);white-space:nowrap}",
      ".sxp-qb.o b{right:50%;padding-right:2px}.sxp-qb.d b{left:50%;padding-left:2px}",
      ".sxp-qlab{font-size:10.5px;font-weight:800;letter-spacing:.1em;margin-top:6px;color:var(--ink-soft)}",
      ".sxp-qnet{font:800 11.5px ui-monospace,monospace;margin-top:2px}",
      ".sxp-qnet.pos{color:#17805A}.sxp-qnet.neg{color:#C53727}",
      ".sxp-qkey{display:flex;gap:14px;flex-wrap:wrap;margin-top:9px;font-size:11px;color:var(--ink-faint);align-items:center}",
      ".sxp-kk{width:9px;height:9px;border-radius:2px;display:inline-block;margin-right:5px;vertical-align:-1px}",
      ".sxp-kk.o{background:#5a76a2}.sxp-kk.d{background:#44876a}",

      /* the last cell takes whatever the row has left: an odd number of figures used to
         leave a grey hole beside the fifth one, which reads as a number that failed to
         load rather than as a row that happens to be odd */
      ".sxp-stats>div:last-child:nth-child(odd){grid-column:1/-1}",
      /* Two to a row, always. auto-fit made three or four columns of a panel this wide and
         then left the tail of the last row as empty grey cells - the grid's own background
         showing through where there was nothing to put - which reads as data that failed
         to arrive rather than as a list with an odd number of figures in it. */
      ".sxp-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;",
      "background:var(--line);border:1px solid var(--line);border-radius:9px;overflow:hidden;margin-top:8px}",
      ".sxp-stats>div{background:var(--panel,#fff);padding:10px 12px;min-width:0}",
      ".sxp-stats dt{font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-faint)}",
      ".sxp-stats dd{margin:5px 0 0;font:800 20px ui-monospace,monospace;line-height:1.1}",
      ".sxp-stats small{display:block;margin-top:4px;font-size:11px;color:var(--ink-faint);line-height:1.4}",

      ".sxp-nv{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:9px}",
      ".sxp-nv li{background:var(--panel,#fff);border:1px solid var(--line);border-left:3px solid #b0873c;",
      "border-radius:9px;padding:10px 13px;display:grid;gap:3px}",
      ".sxp-nv b{font-size:13px}.sxp-nv span{color:var(--ink-soft);font-size:12.5px;line-height:1.55;max-width:84ch}"
    ].join("");
    document.head.appendChild(s);
  }

  css();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
  new MutationObserver(function () { scan(); })
    .observe(document.body || document.documentElement, { childList: true, subtree: true });

  API.render = render;
  /* what the written report's Playbook section reads: the computed sets for an
     opponent, grouped the same four ways the table below groups them */
  API.report = buildFor;
  /* the tagged players of an opponent, for the table that sets them beside the league's line */
  API.playersOf = function (opponent) {
    return buildFor(opponent).then(function (R) {
      if (!R.D) return { rows: [], why: R.why };
      return { rows: R.D.players.rows, roles: R.D.players.roles, avg: R.D.say.selfPpp, games: R.D.meta.ngames };
    });
  };
  API.sets = function (opponent, band) {
    return buildFor(opponent).then(function (R) {
      if (!R.D) return { why: R.why, files: R.files, rows: [] };
      var rows = R.D.playbook.filter(function (r) { return !band || r.band === band; });
      return { why: null, files: R.files, used: R.used, rows: rows, calls: R.D.calls,
               callFiles: R.callFiles, callLog: R.callLog,
               callHit: R.callHit, callCodes: R.callCodes,
               avg: R.D.say.selfPpp, games: R.D.meta.games, flags: R.D.playbookFlags };
    });
  };
  API.refresh = function () {
    dropCache();
    var n = document.querySelectorAll(".scoutpre-slot, .scoutpre-players-slot");
    for (var i = 0; i < n.length; i++) delete n[i].dataset.sxpDone;
    scan();
  };

})();
