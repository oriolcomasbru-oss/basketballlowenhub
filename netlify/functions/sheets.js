// Google Sheets reader.
//
//   /.netlify/functions/sheets?src=<name>[&sheet=<tab>]   one of the club's own sheets, by name
//   /.netlify/functions/sheets?id=<spreadsheetId>[&sheet=<tab>]   any sheet, staff only
//   /.netlify/functions/sheets?url=<published csv url>            any published sheet, staff only
//
// The sheet ids and the published links used to be written in index.html, which is
// served to anybody who opens the site, and this function answered whoever asked. The
// availability sheet and the load sheet are about named players; neither belonged in a
// public page. The addresses live here now, on the server, and the app asks by name.
//
// Every request carries the session token the app got from Supabase at sign-in and the
// token is checked there before anything is read. Staff read everything. A player reads
// the fixtures, which is what the list of pre-game reports is built from, and nothing
// else. Anything that is not clearly staff is treated as a player.
//
// Optional env vars, to point a name at a different document without a deploy:
//   SHEET_GAMES, SHEET_MEDICAL, SHEET_MONTHLY, SHEET_WEEKLY, SHEET_KINEXON   spreadsheet ids
//   SHEET_CALENDAR_URL, SHEET_KINEXON_URL, SHEET_PFWEEKLY_URL                published csv links

const PUB = "https://docs.google.com/spreadsheets/d/e/";
const SOURCES = {
  games:    { id: process.env.SHEET_GAMES   || "1J-ERToyQJwiExqEmxcJjay1bFHLNpBzgzlWBxhkUNZ0" },
  medical:  { id: process.env.SHEET_MEDICAL || "1azqCDuqwsc-8JfMMRaJV2la7o1Sec8PVdp5Dej77kUU" },
  monthly:  { id: process.env.SHEET_MONTHLY || "15SlxXA5rGuadbcFngta_2EQDp_RHo3V0RA7yK1_nDNo" },
  weekly:   { id: process.env.SHEET_WEEKLY  || "1BjaNTzYmzqaS6lk1pwvUIc9Grwie0tDYXG9k2KKsuGs" },
  kinexon:  { id: process.env.SHEET_KINEXON || "1Nfa02Krz8jDBUjOtiHDYHb1dVfentMC0HLHEnpH3TyA" },
  calendar: { url: process.env.SHEET_CALENDAR_URL ||
    PUB + "2PACX-1vRzbI_u1PNrlDXspm0tzKZI_-klv64GsY5VEWyzJTpcd07CMl4ZOPUTCRlNwyC95zjJXi1dRUCMmJLR/pub?gid=354227494&single=true&output=csv" },
  kinexon_pub: { url: process.env.SHEET_KINEXON_URL ||
    PUB + "2PACX-1vSaHAtNrhOF3FJnyysVP0Kqisw9h09ZXRIU4DggdKR1AVrrlCxe-GZn47f624Li2XUSv0L3-R9_LXmv/pub?gid=872319668&single=true&output=csv" },
  pfweekly: { url: process.env.SHEET_PFWEEKLY_URL ||
    PUB + "2PACX-1vQ9Ozzv0OtzmIi7zc4bHAkFMmjf3ojaa4XyqYP86dUv0axaZ-43FetQSjLpofC-Mq-X9SjH6J0rcOt7/pub?gid=0&single=true&output=csv" }
};
const PLAYER_SOURCES = ["games"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "cache-control": "no-store"
};
function text(status, body) {
  return { statusCode: status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" }, body: body };
}

/* ---- who is asking: the same check the Drive function makes ---- */
const SB_URL = (process.env.SUPABASE_URL || "https://smpahparklfuzxmgviql.supabase.co").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_KEY || "sb_publishable_FGaC9HnZp9zpRBAgmW1CVQ_EaIRnYEk";
const WHO_TTL = 60 * 1000;
const whoCache = {};
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
  const who = { username: j.username || "", staff: scope === "coach" || scope === "admin" };
  whoCache[token] = { at: Date.now(), who: who };
  return who;
}

/* headers=1 or Google guesses how many rows of the sheet are headings - for DB_Games
   it guesses three, and the first two fixtures of the season never arrive. */
function gviz(id, sheet) {
  return "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(id) +
         "/gviz/tq?tqx=out:csv&headers=1" + (sheet ? "&sheet=" + encodeURIComponent(sheet) : "");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  let who = null;
  try { who = await whoIs(bearer(event)); }
  catch (e) { return text(502, "could not check the session (" + ((e && e.message) || e) + ")"); }
  if (!who) return text(401, "sign in to read this");

  const p = event.queryStringParameters || {};
  let target;
  if (p.src) {
    const s = SOURCES[p.src];
    if (!s) return text(400, "unknown source");
    if (!who.staff && PLAYER_SOURCES.indexOf(p.src) < 0) return text(403, "this account may not read that");
    target = s.url || gviz(s.id, p.sheet);
  } else if (p.url) {
    if (!who.staff) return text(403, "this account may not read that");
    try {
      const u = new URL(p.url);
      if (u.protocol !== "https:" ||
          (!/(^|\.)docs\.google\.com$/.test(u.hostname) && !/(^|\.)googleusercontent\.com$/.test(u.hostname)))
        return text(400, "bad url host");
      target = p.url;
    } catch (e) { return text(400, "bad url"); }
  } else if (p.id) {
    if (!who.staff) return text(403, "this account may not read that");
    target = gviz(p.id, p.sheet);
  } else {
    return text(400, "missing src, id or url");
  }

  try {
    const r = await fetch(target, { redirect: "follow" });
    const t = await r.text();
    return { statusCode: r.status, headers: { ...CORS, "content-type": "text/csv; charset=utf-8" }, body: t };
  } catch (e) {
    return text(502, "err " + (e && e.message));
  }
};
