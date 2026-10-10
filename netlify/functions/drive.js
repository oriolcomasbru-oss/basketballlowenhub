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
  const f = findDates(String(name || "").replace(/_/g, " "));
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
  const r = await fetch(SB_URL + "/rest/v1/rpc/me", {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SB_KEY, authorization: "Bearer " + SB_KEY },
    body: JSON.stringify({ p_token: token })
  });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j || j.ok !== true) return null;
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
          text: 0, err: "could not open the file (" + last + ")" });
      }
      const isPdf = buf.slice(0, 5).toString("latin1") === "%PDF-";
      const text = plain ? plain.replace(/\s+/g, " ").slice(0, 200000) : (isPdf ? pdfText(buf) : "");
      const found = findDates(text);
      /* what is written inside beats what somebody typed in the file name, but a file
         that cannot be read still answers with whatever the name said */
      const best = found[0] || byName || null;
      return json(200, {
        id: p.doc, name: name,
        date: best ? best.date : null,
        how: best ? (found[0] ? best.how : "name \u00b7 " + best.how) : null,
        found: found.slice(0, 6),
        fromName: byName ? byName.date : null,
        text: text.length,
        kind: plain ? "exported text" : (isPdf ? "pdf" : "other"),
        sample: text.slice(0, 180)
      });
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
                      keepInFolder: keepInFolder, fileRe: fileRe };
