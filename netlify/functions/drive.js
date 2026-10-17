// Google Drive reader for the tagging CSVs.
//
// Two modes, tried in this order:
//
//   1. NO SETUP  — reads the public folder page and pulls the file list out of it,
//                  then downloads each file through the public download endpoint.
//                  Needs nothing but the folders being shared as "anyone with the link".
//   2. API KEY   — if GDRIVE_API_KEY is set, the Drive API is used instead. Sturdier,
//                  and the only option if the folders are ever made private-ish.
//
// Optional env vars:
//   GDRIVE_API_KEY          switches mode 2 on
//   GDRIVE_FOLDER_GAME      overrides the post-game folder id
//   GDRIVE_FOLDER_PRACTICE  overrides the post-practice folder id
//
//   /.netlify/functions/drive?folder=game       → {files:[{id,name}], mode}
//   /.netlify/functions/drive?folder=pregame    → opponent tagging (needs GDRIVE_FOLDER_PREGAME)
//   /.netlify/functions/drive?folder=practice   → idem
//   /.netlify/functions/drive?file=<fileId>     → the raw CSV bytes
//   /.netlify/functions/drive?file=<fileId>&as=text → the same file as plain text

const FOLDERS = {
  game: process.env.GDRIVE_FOLDER_GAME || "1jVE61lHX9_WxDa8_i_GjYdq6MKuYW0sN",
  practice: process.env.GDRIVE_FOLDER_PRACTICE || "1641_ma64tq_LGLERU_dRnjBR9A1gLAgs",
  /* The two document folders. These are not tagging exports: they are the game plan and
     the session sheet as they were written, PDFs and the odd slide deck, dropped in by
     the staff. Nothing reads their contents to make numbers out of them - the app only
     needs to know which game or which session each one belongs to, so that a day with a
     plan behind it can say so. */
  gameplan: process.env.GDRIVE_FOLDER_GAMEPLAN || "1Q1XXHXIgJGGO9M35EpKo6uESTsO8X1lc",
  practicedoc: process.env.GDRIVE_FOLDER_PRACTICEDOC || "1kgv3LL9HiKEK20U3-2pIZohRj9uMkXlm",
  /* opponent tagging: "G8 PREGAME ROSTOCK (HAMBURG).csv" — our game number,
     the opponent we are preparing, and in brackets the rival of that game.
     Set GDRIVE_FOLDER_PREGAME in Netlify to switch it on.
     Every opponent lives in this one folder on purpose: scoutpre.js pools the
     whole folder as the league reference each pre-game report measures against. */
  pregame: process.env.GDRIVE_FOLDER_PREGAME || "16rYmRVhaeVj-pPJJeSQfZMTelf61OvJp"
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "cache-control": "no-store"
};
const UA = { "user-agent": "Mozilla/5.0 (compatible; CoachesHub/1.0)" };

function json(status, obj) {
  return { statusCode: status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(obj) };
}

/* ------------------------------------------------------------------ mode 1 */
// The public folder page embeds the file list in a script blob. Names and ids
// sit next to each other; we pull every (id, name.csv) pair we can find.
/* Only the opponent-scouting folder holds workbooks (the call sheets). The game
   and practice folders are tagging exports and nothing else — listing a .xlsx
   there would let the post-game block pick one up and read zip bytes as CSV. */
const DOC_RE = /\.(pdf|docx?|pptx?|png|jpe?g|odt|odp|rtf|txt)$/i;
/* A tagging export is a file with an extension, always. A document folder is not: a game
   plan written in Google Docs or Slides is a file in Drive with NO extension at all - its
   name is just "GAME PLAN ROSTOCK" - so an extension test threw every one of them away
   and the folder came back empty. In a document folder the rule is the other way round:
   everything that is not a folder and not a tagging export counts. */
const NOTDOC_RE = /\.(csv|xlsx|xlsm|zip|json|mp4|mov)$/i;
const GOOGLE_DOC = /^application\/vnd\.google-apps\.(document|presentation|spreadsheet|drawing)$/;
function isDocFolder(f) { return f === "gameplan" || f === "practicedoc"; }
function fileRe(folder) {
  if (isDocFolder(folder)) return DOC_RE;
  return folder === "pregame" ? /\.(csv|xlsx)$/i : /\.csv$/i;
}
function keepInFolder(folder, name, mime) {
  if (mime === "application/vnd.google-apps.folder") return false;
  /* A call sheet written straight in Google Sheets is not a file with an extension — it
     is a native Sheets document whose name is just "G10 SEASON Ludwigsburg CALLS" — so
     the extension test threw it away and the scouting folder came back without the calls.
     Only the scouting folder takes one, and only when its name says CALLS: a tagging
     export is always a real .csv, and a stray spreadsheet must not become a game. */
  if (folder === "pregame" && mime === "application/vnd.google-apps.spreadsheet"
      && /(^|[^a-z])calls?([^a-z]|$)/i.test(String(name))) return true;
  if (!isDocFolder(folder)) return fileRe(folder).test(name);
  if (NOTDOC_RE.test(name)) return false;
  return true;
}

async function listPublic(folderId, folder) {
  const url = "https://drive.google.com/drive/folders/" + encodeURIComponent(folderId) + "?hl=en";
  const r = await fetch(url, { headers: UA, redirect: "follow" });
  if (!r.ok) throw new Error("folder page returned " + r.status);
  let html = await r.text();

  // The blob is hex-escaped inside a string literal; unescape so the regex can see it.
  html = html.replace(/\\x([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
             .replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\"/g, '"');

  const out = [], seen = {};
  // …,"<fileId>",["<parentId>"],"<file name>",…
  const re = /"([A-Za-z0-9_-]{25,})"\s*,\s*\[\s*"[A-Za-z0-9_-]{25,}"\s*\]\s*,\s*"((?:[^"\\]|\\.)*?)"/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1], name = m[2].replace(/\\(.)/g, "$1");
    /* the public folder page carries no mime type, so a call sheet written in Google
       Sheets is recognised by what it is called and by having no extension at all */
    const sheetByName = folder === "pregame" && !/\.[a-z0-9]{2,4}$/i.test(name)
      && /(^|[^a-z])calls?([^a-z]|$)/i.test(name);
    if ((!sheetByName && !keepInFolder(folder, name, "")) || seen[id]) continue;
    seen[id] = 1;
    out.push({ id: id, name: name });
  }
  if (!out.length) throw new Error("no files found on the public folder page");
  out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  return out;
}

/* ------------------------------------------------------------------ mode 2 */
async function listApi(folderId, key, folder) {
  const q = encodeURIComponent("'" + folderId + "' in parents and trashed = false");
  /* Drive answers a page at a time. One page of 200 was read and the rest of the folder
     silently did not exist - which is only invisible until a season's worth of session
     sheets goes past it. Ten pages is two thousand files and a hard stop either way. */
  const out = [];
  let token = "", pages = 0;
  do {
    const url = "https://www.googleapis.com/drive/v3/files?q=" + q +
      "&fields=" + encodeURIComponent("nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,size)") +
      "&orderBy=name&pageSize=200&key=" + encodeURIComponent(key) +
      (token ? ("&pageToken=" + encodeURIComponent(token)) : "");
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || "drive list failed");
    (j.files || []).forEach(function (f) {
      if (keepInFolder(folder, f.name || "", f.mimeType || "")) out.push(f);
    });
    token = j.nextPageToken || "";
  } while (token && ++pages < 10);
  return out;
}

/* ================= the date inside a session sheet ==================================

   A game plan says in its NAME which opponent it is for; a practice sheet says in its
   CONTENT which day it was written for, and nothing on the outside of the file does. So
   the file has to be opened.

   A PDF is a container, not a text file. The words live in content streams, usually
   deflated, written as a sequence of show-text operators - "(Monday 12 October) Tj" and
   the kerned form "[(Mon)-20(day)] TJ". Node ships zlib, so the whole thing is: find
   every stream, inflate the ones that are deflated, pull the literal strings out of the
   text operators, and read the result as a line of words. No library, nothing to install,
   and it fails softly: a PDF it cannot read returns no date rather than a wrong one.

   Then the date. Written European-first, because that is what these sheets are: day
   before month, with the four-digit-year forms trusted over the two-digit ones and a
   month written out in words trusted over everything, since "12.10" could be either way
   round and "12 October" could not. Every candidate found is returned next to the one
   chosen, so a wrong read can be seen rather than argued about. */
const zlib = require("zlib");

function pdfStreams(buf) {
  const out = [];
  const hay = buf.toString("latin1");
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(hay))) {
    const start = m.index + m[0].length;
    const end = hay.indexOf("endstream", start);
    if (end < 0) break;
    const dict = hay.slice(Math.max(0, m.index - 400), m.index);
    const raw = buf.slice(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try { out.push(zlib.inflateSync(raw).toString("latin1")); }
      catch (e) { try { out.push(zlib.inflateRawSync(raw).toString("latin1")); } catch (e2) {} }
    } else if (!/\/(DCTDecode|JPXDecode|CCITTFaxDecode|Image)/.test(dict)) {
      out.push(raw.toString("latin1"));
    }
    re.lastIndex = end;
    if (out.length > 400) break;
  }
  return out;
}
/* "(a) Tj", "[(a)-20(b)] TJ", "(a) '", "(a) \"" - all of them show text */
function pdfText(buf) {
  const parts = [];
  pdfStreams(buf).forEach(function (st) {
    const re = /\((?:\\.|[^\\()])*\)/g;
    let m;
    while ((m = re.exec(st))) {
      const lit = m[0].slice(1, -1)
        .replace(/\\([nrtbf])/g, " ")
        .replace(/\\([0-7]{1,3})/g, function (_, o) { return String.fromCharCode(parseInt(o, 8)); })
        .replace(/\\(.)/g, "$1");
      if (lit) parts.push(lit);
    }
  });
  return parts.join(" ").replace(/\s+/g, " ").slice(0, 200000);
}

/* ================= the words on a session sheet =====================================

   pdfText above pulls the literal strings out of a PDF and reads them as they stand. That
   works for a file whose fonts use a standard encoding. The session sheets are printed
   from a Mac, and every font in them is a subset with its own private code table: the
   byte for "A" is whatever slot the letter happened to get, and the only thing that says
   which is the font's ToUnicode map. Read as they stand, those strings are noise, which
   is why not one of these sheets ever gave up a date or a word.

   So this reads them properly: every object in the file, the code table of each font,
   the name each page calls a font by, and then the text operators with the table of the
   font that is current when they run. It is still no PDF library - no encryption, no
   object streams - and it fails soft: a file it cannot follow gives back nothing, and
   the caller says "could not be read" instead of guessing.

   What it is for: whether a training had five on five in it. A session with none has
   nothing to tag, so a day with no tagging export is only a missing file when the sheet
   says there was five on five. */
function pdfObjects(hay) {
  var out = {}, re = /(\d+)\s+\d+\s+obj\b/g, m;
  while ((m = re.exec(hay))) {
    var start = m.index + m[0].length;
    var end = hay.indexOf("endobj", start);
    if (end < 0) break;
    var body = hay.slice(start, end);
    var sm = /stream\r?\n/.exec(body);
    var o = { dict: body, a: -1, b: -1 };
    if (sm) {
      o.dict = body.slice(0, sm.index);
      o.a = start + sm.index + sm[0].length;
      var de = hay.indexOf("endstream", o.a);
      o.b = (de < 0 || de > end) ? end : de;
    }
    out[m[1]] = o;
    re.lastIndex = end;
  }
  return out;
}
function pdfStreamOf(buf, o, zlib) {
  if (!o || o.a < 0) return "";
  var raw = buf.slice(o.a, o.b);
  if (/\/FlateDecode/.test(o.dict)) {
    /* the line break before "endstream" is not part of the data, and an inflater that is
       strict about what follows the end of the stream refuses the whole thing over it:
       tried as written, then without the break */
    var ends = [o.b], k;
    if (buf[o.b - 1] === 10) { ends.unshift(o.b - 1); if (buf[o.b - 2] === 13) ends.unshift(o.b - 2); }
    else if (buf[o.b - 1] === 13) ends.unshift(o.b - 1);
    for (k = 0; k < ends.length; k++) {
      try { var r1 = zlib.inflateSync(buf.slice(o.a, ends[k])); if (r1 && r1.length) return r1.toString("latin1"); } catch (e) {}
    }
    for (k = 0; k < ends.length; k++) {
      try { var r2 = zlib.inflateRawSync(buf.slice(o.a, ends[k])); if (r2 && r2.length) return r2.toString("latin1"); } catch (e2) {}
    }
    return "";
  }
  if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|LZWDecode|ASCII85Decode)/.test(o.dict)) return "";
  return raw.toString("latin1");
}
function pdfHexStr(h) {
  var s = "";
  if (h.length % 4) h = h.length < 4 ? ("0000" + h).slice(-4) : h;
  for (var i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16));
  return s;
}
function pdfCMap(txt) {
  var map = {}, bytes = 1;
  var cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(txt);
  if (cs) bytes = Math.max(1, cs[1].length / 2);
  txt.replace(/beginbfchar([\s\S]*?)endbfchar/g, function (_, b) {
    b.replace(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g, function (__, a, d) { map[parseInt(a, 16)] = pdfHexStr(d); });
  });
  txt.replace(/beginbfrange([\s\S]*?)endbfrange/g, function (_, b) {
    b.replace(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g, function (__, a, z, d, arr) {
      var lo = parseInt(a, 16), hi = parseInt(z, 16), c;
      if (d !== undefined) {
        var pre = d.length > 4 ? pdfHexStr(d.slice(0, d.length - 4)) : "";
        var last = parseInt(d.slice(-4), 16);
        for (c = lo; c <= hi && c - lo < 4096; c++) map[c] = pre + String.fromCharCode(last + (c - lo));
      } else {
        (arr.match(/<([0-9a-fA-F]*)>/g) || []).forEach(function (it, i) { map[lo + i] = pdfHexStr(it.slice(1, -1)); });
      }
    });
  });
  return { map: map, bytes: bytes };
}
function pdfLitBytes(s) {          /* "(...)" without the brackets -> array of byte values */
  var out = [], i = 0;
  while (i < s.length) {
    var ch = s.charCodeAt(i);
    if (ch === 92) {               /* backslash */
      var n = s[i + 1];
      if (n >= "0" && n <= "7") { var oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))[0]; out.push(parseInt(oct, 8) & 255); i += 1 + oct.length; continue; }
      var esc = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      if (n === "\n") { i += 2; continue; }
      if (n === "\r") { i += (s[i + 2] === "\n") ? 3 : 2; continue; }
      out.push(esc[n] !== undefined ? esc[n] : s.charCodeAt(i + 1)); i += 2; continue;
    }
    out.push(ch & 255); i++;
  }
  return out;
}
function pdfHexBytes(h) {
  h = h.replace(/\s+/g, ""); if (h.length % 2) h += "0";
  var out = []; for (var i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
  return out;
}
function pdfDecode(bytes, font) {
  var s = "", i;
  if (!font) { for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
  var w = font.bytes || 1;
  for (i = 0; i + w <= bytes.length; i += w) {
    var code = 0; for (var k = 0; k < w; k++) code = code * 256 + bytes[i + k];
    var u = font.map[code];
    s += (u !== undefined) ? u : (w === 1 && code >= 32 && code < 127 ? String.fromCharCode(code) : "");
  }
  return s;
}
function pdfTextMapped(buf, zlib) {
  var hay = buf.toString("latin1");
  var objs = pdfObjects(hay), id;
  /* which font object carries which code table */
  var fontMap = {};
  for (id in objs) {
    var tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(objs[id].dict);
    if (tu && objs[tu[1]]) fontMap[id] = pdfCMap(pdfStreamOf(buf, objs[tu[1]], zlib));
  }
  /* and under which name a page calls it: "/TT2 9 0 R" wherever it is written */
  var names = {};
  for (id in objs) {
    objs[id].dict.replace(/\/([A-Za-z0-9_.+\-]+)\s+(\d+)\s+\d+\s+R/g, function (_, nm, ref) {
      if (fontMap[ref]) names[nm] = fontMap[ref];
    });
  }
  var parts = [];
  var re = /\/([A-Za-z0-9_.+\-]+)\s+-?[\d.]+\s+Tf|\[((?:\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-fA-F\s]*>|[^\]\(<])*)\]\s*TJ|\(((?:\\[\s\S]|[^\\)])*)\)\s*(?:Tj|'|")|<([0-9a-fA-F\s]*)>\s*Tj|\b(ET|T\*|Td|TD|Tm)\b/g;
  for (id in objs) {
    var o = objs[id];
    if (o.a < 0) continue;
    if (/\/Subtype\s*\/Image|\/FontFile|\/Type\s*\/XRef|\/Type\s*\/ObjStm/.test(o.dict)) continue;
    var st = pdfStreamOf(buf, o, zlib);
    if (!st || st.indexOf("BT") < 0 || !/T[jJ]/.test(st)) continue;
    var cur = null, m;
    re.lastIndex = 0;
    while ((m = re.exec(st))) {
      if (m[1] !== undefined) { cur = names[m[1]] || null; continue; }
      if (m[2] !== undefined) {
        var seg = "";
        m[2].replace(/\(((?:\\[\s\S]|[^\\)])*)\)|<([0-9a-fA-F\s]*)>|(-?\d+(?:\.\d+)?)/g, function (_, lit, hx, num) {
          if (lit !== undefined) seg += pdfDecode(pdfLitBytes(lit), cur);
          else if (hx !== undefined) seg += pdfDecode(pdfHexBytes(hx), cur);
          else if (+num < -180) seg += " ";      /* a gap wide enough to be a space */
        });
        parts.push(seg); continue;
      }
      if (m[3] !== undefined) { parts.push(pdfDecode(pdfLitBytes(m[3]), cur)); continue; }
      if (m[4] !== undefined) { parts.push(pdfDecode(pdfHexBytes(m[4]), cur)); continue; }
      parts.push(m[5] === "ET" ? "\n" : " ");
    }
  }
  return parts.join("").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 200000);
}
/* five on five, however the sheet writes it: 5x5, 5 X 5, 5v5, 5vs5, 5c5, 5 on 5, 5:5 */
function has5x5(text) {
  return /(^|[^0-9])5\s*(?:x|×|v|vs\.?|c|contra|on|against|gegen|:)\s*5(?![0-9])/i.test(String(text || ""));
}

/* ================= where things sit on a page ========================================

   pdfTextMapped reads the words of a sheet in the order the file happens to hold them,
   which is enough to ask whether a word is there. A rotation sheet is a table: what a
   name means depends on the row and the column it sits in, and what a line of the box
   means depends on the colour painted behind it. So this pass keeps, for every piece of
   text, the point of the page it is drawn at - through the text matrix and whatever the
   page has scaled or moved - and every filled block with its colour and its rectangle,
   whether it was drawn as a rectangle or as a path of four lines. */
function pdfLayout(buf, zlib, X) {
  var hay = buf.toString("latin1");
  var objs = X.pdfObjects(hay), id;
  var fontMap = {}, names = {};
  for (id in objs) {
    var tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(objs[id].dict);
    if (tu && objs[tu[1]]) fontMap[id] = X.pdfCMap(X.pdfStreamOf(buf, objs[tu[1]], zlib));
  }
  for (id in objs) {
    objs[id].dict.replace(/\/([A-Za-z0-9_.+\-]+)\s+(\d+)\s+\d+\s+R/g, function (_, nm, ref) {
      if (fontMap[ref]) names[nm] = fontMap[ref];
    });
  }
  var mul = function (m, n) {
    return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
            m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
            m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  };
  var pt = function (m, x, y) { return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]; };
  var texts = [], fills = [];
  var TOK = /\((?:\\[\s\S]|[^\\()])*\)|<[0-9a-fA-F\s]*>|\[|\]|\/[^\s\/\[\]()<>]+|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+/g;
  for (id in objs) {
    var o = objs[id];
    if (o.a < 0) continue;
    if (/\/Subtype\s*\/Image|\/FontFile|\/Type\s*\/XRef|\/Type\s*\/ObjStm|\/Length1/.test(o.dict)) continue;
    var st = X.pdfStreamOf(buf, o, zlib);
    if (!st || !/\b(re|BT)\b/.test(st)) continue;
    var ctm = [1, 0, 0, 1, 0, 0], fill = [0, 0, 0], stack = [];
    var tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], font = null, size = 0, lead = 0;
    var ops = [], pend = [], path = [], paths = [], inArr = null, m;
    var show = function (s) {
      if (!s) return;
      var p = pt(mul(tm, ctm), 0, 0);
      var last = texts[texts.length - 1];
      if (last && Math.abs(last.x - p[0]) < 0.01 && Math.abs(last.y - p[1]) < 0.01) last.s += s;
      else texts.push({ x: p[0], y: p[1], s: s, size: size });
    };
    var str = function (tok) {
      return tok[0] === "(" ? X.pdfDecode(X.pdfLitBytes(tok.slice(1, -1)), font)
                            : X.pdfDecode(X.pdfHexBytes(tok.slice(1, -1)), font);
    };
    TOK.lastIndex = 0;
    while ((m = TOK.exec(st))) {
      var t = m[0], c0 = t[0];
      if (t === "[") { inArr = []; continue; }
      if (t === "]") { ops.push(inArr || []); inArr = null; continue; }
      if (c0 === "(" || c0 === "<" || c0 === "/" || /^[-+.\d]/.test(t)) {
        var v = (c0 === "(" || c0 === "<" || c0 === "/") ? t : parseFloat(t);
        if (inArr) inArr.push(v); else ops.push(v);
        continue;
      }
      var n = ops.length;
      switch (t) {
        case "q": stack.push([ctm, fill]); break;
        case "Q": if (stack.length) { var sv = stack.pop(); ctm = sv[0]; fill = sv[1]; } break;
        case "cm": if (n >= 6) ctm = mul(ops.slice(n - 6), ctm); break;
        case "rg": case "sc": case "scn":
          if (n >= 3 && typeof ops[n - 3] === "number") fill = ops.slice(n - 3);
          else if (n >= 1 && typeof ops[n - 1] === "number") fill = [ops[n - 1], ops[n - 1], ops[n - 1]];
          break;
        case "g": if (n >= 1) fill = [ops[n - 1], ops[n - 1], ops[n - 1]]; break;
        case "re": if (n >= 4) pend.push(ops.slice(n - 4)); break;
        /* a block drawn as a path - move, lines, close - is a rectangle all the same */
        case "m": if (n >= 2) { if (path.length) paths.push(path); path = [pt(ctm, ops[n - 2], ops[n - 1])]; } break;
        case "l": if (n >= 2) path.push(pt(ctm, ops[n - 2], ops[n - 1])); break;
        case "c": if (n >= 6) path.push(pt(ctm, ops[n - 2], ops[n - 1])); break;
        case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*":
          pend.forEach(function (r) {
            var a = pt(ctm, r[0], r[1]), b = pt(ctm, r[0] + r[2], r[1] + r[3]);
            fills.push({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
                         w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]), rgb: fill.slice() });
          });
          if (path.length) paths.push(path);
          paths.forEach(function (pp) {
            if (pp.length < 3) return;
            var xs = pp.map(function (q) { return q[0]; }), ys = pp.map(function (q) { return q[1]; });
            var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
            fills.push({ x: x0, y: y0, w: Math.max.apply(null, xs) - x0, h: Math.max.apply(null, ys) - y0, rgb: fill.slice() });
          });
          pend = []; path = []; paths = []; break;
        case "n": case "S": case "s": pend = []; path = []; paths = []; break;
        case "BT": tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
        case "Tf": if (n >= 2) { font = names[String(ops[n - 2]).slice(1)] || null; size = ops[n - 1]; } break;
        case "TL": if (n >= 1) lead = ops[n - 1]; break;
        case "Tm": if (n >= 6) { tm = ops.slice(n - 6); tlm = tm; } break;
        case "Td": if (n >= 2) { tlm = mul([1, 0, 0, 1, ops[n - 2], ops[n - 1]], tlm); tm = tlm; } break;
        case "TD": if (n >= 2) { lead = -ops[n - 1]; tlm = mul([1, 0, 0, 1, ops[n - 2], ops[n - 1]], tlm); tm = tlm; } break;
        case "T*": tlm = mul([1, 0, 0, 1, 0, -lead], tlm); tm = tlm; break;
        case "Tj": if (n >= 1 && typeof ops[n - 1] === "string") show(str(ops[n - 1])); break;
        case "'": case '"':
          tlm = mul([1, 0, 0, 1, 0, -lead], tlm); tm = tlm;
          if (n >= 1 && typeof ops[n - 1] === "string") show(str(ops[n - 1])); break;
        case "TJ":
          if (n >= 1 && Array.isArray(ops[n - 1])) {
            var seg = "";
            ops[n - 1].forEach(function (e) {
              if (typeof e === "string") seg += str(e);
              else if (typeof e === "number" && e < -180) seg += " ";
            });
            show(seg);
          }
          break;
      }
      ops = [];
    }
  }
  return { texts: texts, fills: fills };
}


/* ================= a game-plan sheet, read into the plan the app keeps ===============
   The staff's sheet is always the same page: for each quarter a strip of colour, a clock
   row, five rows of names, and to the right a box with the quarter's general lines, its
   coloured stretches (FIRST 4', NEXT 4', LAST 2') and the defence. Everything is where it
   is on the page, so it is read by position. */
function gpColour(f) {
  return "#" + f.rgb.map(function (v) {
    var n = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
    return n.length < 2 ? "0" + n : n;
  }).join("");
}
function gpIsTint(hex) {          /* a colour, not white, black, grey or the yellow of a sub */
  if (!/^#[0-9a-f]{6}$/.test(hex)) return false;
  var r = parseInt(hex.substr(1, 2), 16), g = parseInt(hex.substr(3, 2), 16), b = parseInt(hex.substr(5, 2), 16);
  if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return false;
  if (r > 240 && g > 240 && b < 40) return false;
  return true;
}
function parseGamePlan(L) {
  var warn = [];
  var T = L.texts.map(function (t) { return { x: t.x, y: t.y, s: String(t.s || "").replace(/\s+/g, " ").trim() }; })
    .filter(function (t) { return t.s; });
  var F = L.fills.filter(function (f) { return f.w > 8 && f.h > 4; })
    .map(function (f) { return { x: f.x, y: f.y, w: f.w, h: f.h, c: gpColour(f) }; })
    .filter(function (f) { return gpIsTint(f.c); });
  var clocks = T.filter(function (t) { return /^CLOCK$/i.test(t.s); }).sort(function (a, b) { return b.y - a.y; });
  if (!clocks.length) return { plan: null, warn: ["no CLOCK row on the page — this is not a rotation sheet"] };
  var QN = ["Q1", "Q2"];
  var clean = function (s) {
    return String(s).replace(/(\d)\s*[«´`'’′»]/g, "$1′").replace(/\s*=\s*/g, " = ").replace(/\s+/g, " ").trim();
  };
  var plan = { pool: [], grid: {}, offbar: {}, defbar: {}, offleg: ["", "", "", ""], defleg: ["", "", "", ""], gen: {} };
  var palette = [null, null, null, null], bandsByQ = {}, poolSeen = {};
  /* The sheet always uses the same four colours, and the app keeps four of its own in
     the same order - green, yellow, red, blue. A colour off the sheet takes the slot of
     the app colour it is nearest to, so green on paper is green on the screen in every
     game; if that slot is already another colour's, it takes the next free one. */
  var APP = ["#92d050", "#fdd868", "#f28e86", "#8cb5f9"];
  var rgbOf = function (h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; };
  var slotOf = function (c) {
    var have = palette.indexOf(c);
    if (have >= 0) return have;
    var a = rgbOf(c);
    var dist = function (k) { var b = rgbOf(APP[k]); return (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]); };
    var order = [0, 1, 2, 3].sort(function (i, j) { return dist(i) - dist(j); });
    for (var k = 0; k < order.length; k++) if (!palette[order[k]]) { palette[order[k]] = c; return order[k]; }
    return -1;
  };
  var addPool = function (n) { n = String(n).toUpperCase(); if (n && !poolSeen[n]) { poolSeen[n] = 1; plan.pool.push(n); } };
  var POS = ["PG", "SG", "SF", "PF", "C"];
  clocks.slice(0, 2).forEach(function (ck, qi) {
    var q = QN[qi];
    var yTop = ck.y + 30, yBot = clocks[qi + 1] ? clocks[qi + 1].y + 30 : -1e9;
    var mins = T.filter(function (t) { return Math.abs(t.y - ck.y) < 3 && /^\d{1,2}\s*MIN$/i.test(t.s); })
      .sort(function (a, b) { return a.x - b.x; });
    /* the table's edges: the colour strip says exactly, the clock labels nearly */
    var rail = F.filter(function (f) { return f.y > ck.y && f.y < ck.y + 22 && f.h < 30; });
    var left, right;
    if (rail.length) {
      left = Math.min.apply(null, rail.map(function (f) { return f.x; }));
      right = Math.max.apply(null, rail.map(function (f) { return f.x + f.w; }));
    } else if (mins.length >= 2) {
      var step = (mins[mins.length - 1].x - mins[0].x) / (mins.length - 1);
      left = mins[0].x - step * 0.25; right = left + step * 10;
    } else { warn.push(q + ": no clock labels to place the columns by"); left = 55; right = 411; }
    var colW = (right - left) / 10;
    var colOf = function (x) { return Math.max(0, Math.min(9, Math.floor((x + 8 - left) / colW))); };
    /* the five rows */
    var grid = [];
    POS.forEach(function (pos) {
      var lab = T.filter(function (t) { return t.s === pos && t.x < left && t.y < ck.y && t.y > yBot; })
        .sort(function (a, b) { return b.y - a.y; })[0];
      var row = [null, null, null, null, null, null, null, null, null, null];
      if (!lab) { warn.push(q + ": no " + pos + " row"); grid.push(row); return; }
      var names = T.filter(function (t) { return t.x >= left - 2 && t.x < right && t.y > lab.y - 3 && t.y < lab.y + 10 && t !== lab; })
        .sort(function (a, b) { return a.x - b.x; });
      if (names.length === 10) names.forEach(function (t, i) { row[i] = t.s.toUpperCase(); });
      else { names.forEach(function (t) { row[colOf(t.x)] = t.s.toUpperCase(); });
        warn.push(q + " " + pos + ": " + names.length + " names found, placed by position"); }
      row.forEach(function (n) { if (n) addPool(n); });
      grid.push(row);
    });
    plan.grid[q] = grid;
    /* the strip of colour over the clock row */
    var bar = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var c = 0; c < 10; c++) {
      var cx = left + colW * (c + 0.5);
      var hit = rail.filter(function (f) { return cx >= f.x && cx <= f.x + f.w; })[0];
      if (!hit) continue;
      bar[c] = slotOf(hit.c) + 1;
    }
    plan.offbar[q] = bar; plan.defbar[q] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    /* the box on the right */
    var boxLeft = right + 60;
    /* a bare number out here is a total from the minutes rows, not a line of the box */
    var box = T.filter(function (t) { return t.x >= boxLeft && t.y < yTop && t.y > yBot - 2 && t.y <= ck.y + 3 && !/^\d+$/.test(t.s); });
    var lines = [];
    box.sort(function (a, b) { return (b.y - a.y) || (a.x - b.x); }).forEach(function (t) {
      var ln = lines[lines.length - 1];
      if (!ln || Math.abs(ln.y - t.y) > 3) { ln = { y: t.y, items: [] }; lines.push(ln); }
      ln.items.push(t);
    });
    var clusters = [];
    /* "FIRST 4' = ...": a stretch of minutes and nothing else in front of the equals sign.
       "LAST 3' DEFENSE = BLACK" is a note that happens to start the same way. */
    var isBand = function (s) { return /^(FIRST|NEXT|LAST|ALL)\s*\d+(?:\s*-\s*\d+)?\s*[«´`’′»']?\s*(=|$)/i.test(s); };
    lines.forEach(function (ln) {
      var cur = null;
      ln.items.sort(function (a, b) { return a.x - b.x; }).forEach(function (t) {
        var glue = /^[^A-Za-z0-9(]*=/.test(t.s);
        var fresh = !cur || (!glue && (isBand(t.s) || (t.s.indexOf("=") > 0 && cur.s.indexOf("=") >= 0)));
        if (fresh) { cur = { x: t.x, y: t.y, s: t.s }; clusters.push(cur); }
        else cur.s += " " + t.s;
      });
    });
    var side = "off", gen = { off: [], def: [] }, bands = [];
    clusters.forEach(function (cl) {
      var s = clean(cl.s);
      if (/^DEFEN[SC]E\b/i.test(s)) side = "def";
      if (isBand(s)) {
        /* the colour the line sits on: the sheet paints one band the whole width of the box and
           the next one over part of it (green under, yellow on top on the right), so of every
           coloured box under the line the smallest is the one that shows */
        var fill = F.filter(function (f) { return f.x >= boxLeft - 8 && cl.x >= f.x - 4 && cl.x <= f.x + f.w && cl.y >= f.y - 4 && cl.y <= f.y + f.h + 4; })
          .sort(function (a, b) { return (a.w * a.h) - (b.w * b.h); })[0];
        var eq = s.indexOf("=");
        bands.push({ label: (eq > 0 ? s.slice(0, eq) : s).trim(), text: eq > 0 ? s.slice(eq + 1).trim() : "", c: fill ? fill.c : "", raw: s });
      } else gen[side].push(s);
    });
    plan.gen[q] = { off: gen.off.join("\n"), def: gen.def.join("\n") };
    bandsByQ[q] = bands;
    if (!rail.length) warn.push(q + ": no colour strip over the clock row");
    /* the squad, in the order the minutes row has it */
    var ml = T.filter(function (t) { return /^[12]Q\s*MIN$/i.test(t.s) && t.y < ck.y && t.y > yBot; })[0];
    if (ml) T.filter(function (t) { return t.x > left - 10 && t.x < boxLeft - 20 && t.y > ml.y + 8 && t.y < ml.y + 26 && /^[A-Z][A-Z .'-]{1,14}$/.test(t.s); })
      .sort(function (a, b) { return a.x - b.x; }).forEach(function (t) { addPool(t.s); });
  });
  /* each coloured stretch's text goes to its colour; one whose colour is on no strip is
     still a concept of the quarter, so it is kept as a general line under its own name */
  QN.forEach(function (q) {
    var bar = plan.offbar[q] || [];
    /* the stretches of this quarter in the order they are played */
    var runs = [];
    bar.forEach(function (v) { if (v && runs[runs.length - 1] !== v) runs.push(v); });
    var nextSeen = 0;
    (bandsByQ[q] || []).forEach(function (b) {
      var pi = b.c ? palette.indexOf(b.c) : -1;
      /* the colour of the line says which stretch it is; when the line's colour is not on
         the strip, its own name does - FIRST is the one that opens, LAST the one that
         closes, NEXT whatever comes between, in order */
      if (pi < 0 || bar.indexOf(pi + 1) < 0) {
        var w = b.label.toUpperCase(), r = -1;
        if (/^FIRST|^ALL/.test(w)) r = 0;
        else if (/^LAST/.test(w)) r = runs.length - 1;
        else if (/^NEXT/.test(w)) { r = 1 + nextSeen; if (r > runs.length - 2) r = runs.length - 2; }
        pi = (r >= 0 && r < runs.length) ? runs[r] - 1 : -1;
      }
      if (/^NEXT/i.test(b.label)) nextSeen++;
      if (pi < 0) { plan.gen[q].off += (plan.gen[q].off ? "\n" : "") + b.raw; return; }
      if (!b.text) return;
      plan.offleg[pi] += (plan.offleg[pi] ? " · " : "") + q + ": " + b.text;
    });
  });
  if (!plan.grid.Q2) { plan.grid.Q2 = []; plan.offbar.Q2 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; plan.defbar.Q2 = plan.offbar.Q2.slice(); plan.gen.Q2 = { off: "", def: "" }; warn.push("only one quarter on the sheet"); }
  var filled = 0;
  QN.forEach(function (q) { (plan.grid[q] || []).forEach(function (r) { r.forEach(function (n) { if (n) filled++; }); }); });
  return { plan: plan, warn: warn, filled: filled, colours: palette.filter(Boolean) };
}

const PDFX = { pdfObjects: pdfObjects, pdfStreamOf: pdfStreamOf, pdfCMap: pdfCMap,
               pdfLitBytes: pdfLitBytes, pdfHexBytes: pdfHexBytes, pdfDecode: pdfDecode };

const MONTHS = {
  jan:1, january:1, ene:1, enero:1, gen:1, januar:1, gener:1,
  feb:2, february:2, febrero:2, februar:2, febrer:2,
  mar:3, march:3, marzo:3, "märz":3, marz:3, mars:3, marc:3, "març":3,
  apr:4, april:4, abr:4, abril:4, avril:4,
  may:5, mai:5, mayo:5, maig:5, mag:5,
  jun:6, june:6, junio:6, juni:6, juny:6,
  jul:7, july:7, julio:7, juli:7, juliol:7,
  aug:8, august:8, ago:8, agosto:8, agost:8,
  sep:9, sept:9, september:9, septiembre:9, setembre:9, setiembre:9,
  oct:10, october:10, octubre:10, oktober:10,
  nov:11, november:11, noviembre:11, novembre:11,
  dec:12, december:12, dic:12, diciembre:12, dez:12, dezember:12, desembre:12
};
function iso(y, mo, d) {
  if (!(y >= 2000 && y <= 2099) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  const p = n => (n < 10 ? "0" : "") + n;
  return y + "-" + p(mo) + "-" + p(d);
}
function findDates(text) {
  const t = " " + String(text || "").toLowerCase() + " ";
  const hits = [];
  const add = (v, conf, how) => { if (v) hits.push({ date: v, conf: conf, how: how }); };
  let m, re;
  /* 2026-10-12 */
  re = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = re.exec(t))) add(iso(+m[1], +m[2], +m[3]), 100, "iso");
  /* 12 October 2026 / 12 de octubre de 2026 / 12. Oktober 2026 */
  const mon = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
  re = new RegExp("\\b(\\d{1,2})\\s*(?:\\.|de|of|\\-)?\\s*(" + mon + ")\\.?\\s*(?:de|,)?\\s*(20\\d{2})\\b", "g");
  while ((m = re.exec(t))) add(iso(+m[3], MONTHS[m[2]], +m[1]), 95, "day-month-year");
  /* October 12, 2026 */
  re = new RegExp("\\b(" + mon + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(20\\d{2})\\b", "g");
  while ((m = re.exec(t))) add(iso(+m[3], MONTHS[m[1]], +m[2]), 90, "month-day-year");
  /* 12/10/2026 — day first, which is what these sheets are written in */
  re = /\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/g;
  while ((m = re.exec(t))) add(iso(+m[3], +m[2], +m[1]), 70, "dd-mm-yyyy");
  /* 12/10/26 */
  re = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})\b/g;
  while ((m = re.exec(t))) add(iso(2000 + +m[3], +m[2], +m[1]), 50, "dd-mm-yy");
  /* 12 October, with no year at all: the season decides which one */
  re = new RegExp("\\b(\\d{1,2})\\s*(?:\\.|de|of)?\\s*(" + mon + ")\\b(?!\\s*\\.?\\s*,?\\s*20\\d{2})", "g");
  while ((m = re.exec(t))) {
    const mo = MONTHS[m[2]], d = +m[1];
    const now = new Date(), y = now.getUTCFullYear();
    /* a season runs July to June: a month before July belongs to the later year */
    const season = (now.getUTCMonth() + 1) >= 7 ? y : y - 1;
    add(iso(mo >= 7 ? season : season + 1, mo, d), 40, "day-month, year from the season");
  }
  const seen = {}, uniq = [];
  hits.sort((a, b) => b.conf - a.conf);
  hits.forEach(x => { if (!seen[x.date + x.how]) { seen[x.date + x.how] = 1; uniq.push(x); } });
  return uniq;
}
/* the file name is tried first for a game plan, and as a fallback for a session sheet */
function dateFromName(name) {
  /* "Practice 12 21_8_26.pdf": an underscore between two numbers is the date's own
     separator, not a space. Turned into spaces the day, the month and the year stopped
     being a date at all and no name written this way ever gave one. */
  const f = findDates(String(name || "").replace(/(\d)_(?=\d)/g, "$1/").replace(/_/g, " "));
  return f.length ? f[0] : null;
}

/* ================= who is asking ====================================================

   This function used to answer anybody: the address was enough to list every folder and
   download every file in it, signed in or not. The app hid the tabs, but hiding a tab is
   not the same as refusing the data behind it.

   Every request now carries the session token the app got from Supabase at sign-in, and
   the token is checked there (the same `me` call the app makes on a reload) before
   anything is read from Drive. No token, or one Supabase does not recognise, is a 401.

   A staff account reads everything. A player account reads the opponent-tagging folder
   and the files inside it, which is what the pre-game report is built from, and nothing
   else. Anything that is not clearly staff is treated as a player: a field missing from
   the answer must leave somebody with less, never with more. */
const SB_URL = (process.env.SUPABASE_URL || "https://smpahparklfuzxmgviql.supabase.co").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_KEY || "sb_publishable_FGaC9HnZp9zpRBAgmW1CVQ_EaIRnYEk";
const PLAYER_FOLDERS = ["pregame"];
const WHO_TTL = 60 * 1000, LIST_TTL = 5 * 60 * 1000;
const whoCache = {};    // token -> {at, who}
const listCache = {};   // folder -> {at, ids}

function bearer(event) {
  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || "");
  return m ? m[1].trim() : "";
}
async function whoIs(token) {
  if (!token) return null;
  const hit = whoCache[token];
  if (hit && Date.now() - hit.at < WHO_TTL) return hit.who;
  /* "THE SESSION COULD NOT BE CHECKED" IS NOT "NOT SIGNED IN".
     One slow or refused answer from the database - a busy moment, a limit hit by several
     of these calls landing together - used to be read as nobody being signed in, and the
     page was told to sign in while it was. That is what "sign in to read this" on a game
     plan was. Only an answer that actually says the token is not a session is taken as
     that; anything else is tried once more and then reported as what it is, a check that
     failed, which the page can try again. */
  let r = null, j = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    j = null;
    try {
      r = await fetch(SB_URL + "/rest/v1/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json", apikey: SB_KEY, authorization: "Bearer " + SB_KEY },
        body: JSON.stringify({ p_token: token })
      });
      try { j = await r.json(); } catch (e) {}
    } catch (e) { r = null; }
    if (r && r.ok && j) break;
    if (attempt === 0) await new Promise(res => setTimeout(res, 350));
  }
  if (!r || !r.ok || !j) throw new Error("the session check answered " + (r ? r.status : "nothing"));
  if (j.ok !== true) return null;
  const scope = String(j.scope || j.role || "").toLowerCase();
  const who = { username: j.username || "", staff: scope === "coach" || scope === "admin", scope: scope };
  whoCache[token] = { at: Date.now(), who: who };
  return who;
}
async function listFolder(folder, key) {
  const id = FOLDERS[folder];
  if (key) {
    try { return { mode: "api", files: await listApi(id, key, folder) }; }
    catch (e) { /* fall through to the public read */ }
  }
  return { mode: "public", files: await listPublic(id, folder) };
}
/* a player may open a file only if it sits in a folder a player may list */
async function playerMayOpen(fileId, key) {
  for (const f of PLAYER_FOLDERS) {
    if (!FOLDERS[f]) continue;
    let c = listCache[f];
    if (!c || Date.now() - c.at > LIST_TTL) {
      const got = await listFolder(f, key);
      c = listCache[f] = { at: Date.now(), ids: got.files.map(x => x.id) };
    }
    if (c.ids.indexOf(fileId) >= 0) return true;
  }
  return false;
}

/* ----------------------------------------------------------------- handler */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const p = event.queryStringParameters || {};
  const key = process.env.GDRIVE_API_KEY || "";

  let who = null;
  try { who = await whoIs(bearer(event)); }
  catch (e) { return json(502, { error: "could not check the session (" + ((e && e.message) || e) + ")" }); }
  if (!who) return json(401, { error: "sign in to read this" });
  const denied = () => json(403, { error: "this account may not read that" });

  try {
    if (p.folder) {
      const id = FOLDERS[p.folder];
      if (!id) return json(400, { error: p.folder==="pregame"
        ? "the opponent-tagging folder is not configured — set GDRIVE_FOLDER_PREGAME on the site"
        : "unknown folder, use game, practice, pregame, gameplan or practicedoc" });
      if (!who.staff && PLAYER_FOLDERS.indexOf(p.folder) < 0) return denied();

      if (key) {
        try { return json(200, { folder: p.folder, mode: "api", files: await listApi(id, key, p.folder) }); }
        catch (e) { /* fall through to the public read */ }
      }
      try {
        return json(200, { folder: p.folder, mode: "public", files: await listPublic(id, p.folder) });
      } catch (e) {
        return json(502, {
          error: "Could not read the folder. Check it is shared as “Anyone with the link · Viewer”. " +
                 "If it is and this keeps failing, set GDRIVE_API_KEY on the site. (" + e.message + ")"
        });
      }
    }

    /* ?doc=<id> — open a document and say which day it is for. The answer is cheap to
       keep, so the app asks once per file and remembers it; nothing here caches, because
       a function container does not live long enough for a cache to be worth anything. */
    if (p.doc) {
      if (!/^[A-Za-z0-9_-]{10,}$/.test(p.doc)) return json(400, { error: "bad file id" });
      /* game plans and session sheets: staff only */
      if (!who.staff) return denied();
      const name = p.name || "";
      const byName = dateFromName(name);
      /* A Google Doc or Slides file has no bytes to download - alt=media answers 403 on
         it. It has to be EXPORTED, and text/plain is all this needs, so the export comes
         first and the plain download after it: whichever the file turns out to be, one of
         the two answers. */
      const targets = key
        ? ["https://www.googleapis.com/drive/v3/files/" + p.doc + "/export?mimeType=text%2Fplain&key=" + encodeURIComponent(key),
           "https://www.googleapis.com/drive/v3/files/" + p.doc + "?alt=media&key=" + encodeURIComponent(key),
           "https://docs.google.com/document/d/" + p.doc + "/export?format=txt",
           "https://drive.google.com/uc?export=download&id=" + p.doc]
        : ["https://docs.google.com/document/d/" + p.doc + "/export?format=txt",
           "https://drive.google.com/uc?export=download&id=" + p.doc,
           "https://drive.usercontent.google.com/download?id=" + p.doc + "&export=download"];
      let buf = null, last = "", plain = "";
      for (const t of targets) {
        try {
          const r = await fetch(t, { headers: UA, redirect: "follow" });
          if (!r.ok) { last = "status " + r.status; continue; }
          const b = Buffer.from(await r.arrayBuffer());
          const head = b.slice(0, 200).toString("latin1");
          if (/^\s*<(?:!DOCTYPE|html)/i.test(head)) { last = "got an HTML page instead of the file"; continue; }
          /* an export answers in text; a download answers in bytes */
          if (/\/export\b/.test(t)) {
            const txt = b.toString("utf8");
            if (txt.replace(/\s+/g, "").length < 2) { last = "the export came back empty"; continue; }
            plain = txt; buf = b; break;
          }
          buf = b; break;
        } catch (e) { last = (e && e.message) || "download failed"; }
      }
      if (!buf) {
        return json(200, { id: p.doc, name: name, date: byName ? byName.date : null,
          how: byName ? ("name \u00b7 " + byName.how) : null, found: byName ? [byName] : [],
          five: null, text: 0, err: "could not open the file (" + last + ")" });
      }
      const isPdf = buf.slice(0, 5).toString("latin1") === "%PDF-";
      /* the words as the fonts really spell them, when the file can be followed; the old
         reading of the raw strings only as the fallback it now is */
      let mapped = "";
      if (isPdf && !plain) { try { mapped = pdfTextMapped(buf, zlib); } catch (e) { mapped = ""; } }
      const words = plain || mapped;
      const text = plain ? plain.replace(/\s+/g, " ").slice(0, 200000)
        : (mapped.length > 40 ? mapped.replace(/\s+/g, " ") : (isPdf ? pdfText(buf) : ""));
      /* five on five in it, yes or no - and null when the sheet gave up too little to say */
      const five = words.replace(/\s+/g, "").length > 40 ? has5x5(words) : null;
      const found = findDates(text);
      /* what is written inside beats what somebody typed in the file name, but a file
         that cannot be read still answers with whatever the name said */
      /* The name wins when it carries a date. It is the one the staff typed, and now that
         the sheets can be read the inside turns out to be a trap: the header says
         "2026/27" and then "AUG 5", and a reader hunting for a day finds "27 AUG" in it. */
      const best = byName || found[0] || null;
      return json(200, {
        id: p.doc, name: name,
        date: best ? best.date : null,
        how: best ? (byName ? "name \u00b7 " + best.how : best.how) : null,
        found: found.slice(0, 6),
        fromName: byName ? byName.date : null,
        five: five,
        text: text.length,
        kind: plain ? "exported text" : (isPdf ? "pdf" : "other"),
        sample: text.slice(0, 180)
      });
    }

    /* ?plan=<id> — a rotation sheet read into the plan the app keeps: who is on the floor
       each minute of each quarter, the colour of each stretch and what is run in it, and
       the general lines of the quarter. Staff only: it is the game plan. */
    if (p.plan) {
      if (!/^[A-Za-z0-9_-]{10,}$/.test(p.plan)) return json(400, { error: "bad file id" });
      if (!who.staff) return denied();
      const tg = key
        ? ["https://www.googleapis.com/drive/v3/files/" + p.plan + "?alt=media&key=" + encodeURIComponent(key),
           "https://drive.google.com/uc?export=download&id=" + p.plan]
        : ["https://drive.google.com/uc?export=download&id=" + p.plan,
           "https://drive.usercontent.google.com/download?id=" + p.plan + "&export=download"];
      let pb = null, why = "";
      for (const t of tg) {
        try {
          const r = await fetch(t, { headers: UA, redirect: "follow" });
          if (!r.ok) { why = "status " + r.status; continue; }
          const b = Buffer.from(await r.arrayBuffer());
          if (b.slice(0, 5).toString("latin1") !== "%PDF-") { why = "it is not a PDF"; continue; }
          pb = b; break;
        } catch (e) { why = (e && e.message) || "download failed"; }
      }
      if (!pb) return json(200, { id: p.plan, plan: null, warn: ["could not open the sheet (" + why + ")"] });
      /* ?dbg=1: the raw text pieces of the coloured-stretch lines with where they sit - to see
         why a line was read the way it was (staff only, as the rest of this call) */
      if (p.dbg === "1") {
        const Ld = pdfLayout(pb, zlib, PDFX);
        const hit = Ld.texts.filter(function (t) { return /FIRST|NEXT|LAST|ALL|GtoG|POP|SIDE|SPECIAL|=/.test(String(t.s || "")); })
          .map(function (t) { return { x: Math.round(t.x * 10) / 10, y: Math.round(t.y * 10) / 10, s: String(t.s || "") }; });
        return json(200, { id: p.plan, dbg: hit.slice(0, 200) });
      }
      let got;
      try { got = parseGamePlan(pdfLayout(pb, zlib, PDFX)); }
      catch (e) { return json(200, { id: p.plan, plan: null, warn: ["could not read the sheet (" + ((e && e.message) || e) + ")"] }); }
      return json(200, { id: p.plan, plan: got.plan, warn: got.warn || [], filled: got.filled || 0 });
    }

    if (p.file) {
      if (!/^[A-Za-z0-9_-]{10,}$/.test(p.file)) return json(400, { error: "bad file id" });
      if (!who.staff && !(await playerMayOpen(p.file, key))) return denied();
      /* A call sheet kept as a native Google Sheet has no bytes to download: alt=media
         answers 403 on it and uc?export=download hands back a sign-in page. It has to be
         EXPORTED, and it is exported as .xlsx so that what arrives here is the same
         workbook the reader already knows how to open. The export targets go last, so a
         real uploaded .csv or .xlsx still takes the direct download it always took. */
      const XLSX = "application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const asSheet = [
        "https://www.googleapis.com/drive/v3/files/" + p.file + "/export?mimeType=" + XLSX
          + (key ? ("&key=" + encodeURIComponent(key)) : ""),
        "https://docs.google.com/spreadsheets/d/" + p.file + "/export?format=xlsx"
      ];
      const targets = (key
        ? ["https://www.googleapis.com/drive/v3/files/" + p.file + "?alt=media&key=" + encodeURIComponent(key),
           "https://drive.google.com/uc?export=download&id=" + p.file]
        : ["https://drive.google.com/uc?export=download&id=" + p.file,
           "https://drive.usercontent.google.com/download?id=" + p.file + "&export=download"]
      ).concat(asSheet);
      let last = "";
      for (const t of targets) {
        const r = await fetch(t, { headers: UA, redirect: "follow" });
        if (!r.ok) { last = "status " + r.status; continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        // A sign-in or virus-scan interstitial comes back as HTML, not a CSV.
        const head = buf.slice(0, 200).toString("latin1");
        if (/^\s*<(?:!DOCTYPE|html)/i.test(head)) { last = "got an HTML page instead of the file"; continue; }
        /* ?as=text hands the CSV back as plain text — handy for a quick look
           in a browser tab, and for anything that cannot read base64 bytes. */
        if (p.as === "text") {
          return {
            statusCode: 200,
            headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
            body: buf.slice(0, 400000).toString("utf8")
          };
        }
        return {
          statusCode: 200,
          headers: { ...CORS, "content-type": "application/octet-stream" },
          body: buf.toString("base64"),
          isBase64Encoded: true
        };
      }
      return json(502, { error: "Could not download that file (" + last + ")." });
    }

    return json(400, { error: "use ?folder=game|practice|pregame|gameplan|practicedoc, ?file=<id> or ?doc=<id>" });
  } catch (e) {
    return json(502, { error: "err " + (e && e.message) });
  }
};

/* exported for the offline checks in /tmp — no effect at runtime */
module.exports._t = { pdfText: pdfText, pdfStreams: pdfStreams, findDates: findDates, dateFromName: dateFromName,
                      pdfTextMapped: pdfTextMapped, has5x5: has5x5,
                      pdfLayout: pdfLayout, parseGamePlan: parseGamePlan, PDFX: PDFX,
                      keepInFolder: keepInFolder, fileRe: fileRe };
