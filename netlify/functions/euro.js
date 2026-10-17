/* European games of German clubs.
 *
 *   /.netlify/functions/euro?season=2026
 *
 * Euroleague Basketball publishes two open APIs, no key and no account:
 *
 *   v2, JSON     /v2/competitions/{E|U}/seasons/{E|U}2026/clubs
 *                /v2/competitions/{E|U}/seasons/{E|U}2026/games?teamCode=MUN
 *   v1, XML      /v1/results?seasonCode=E2026     only games already played
 *                /v1/schedules?seasonCode=E2026   the whole calendar, no scores
 *
 * v2 is the one worth using: the club list carries each club's country, so the German
 * clubs are read from the feed instead of guessed from their names, and the per-club
 * game list carries the whole season — played and still to come — with scores. v1 is
 * kept as a fallback for the day v2 moves.
 *
 * E = EuroLeague, U = EuroCup, and the number is the starting year, the same one the
 * BBL API uses: 2026 is 2026/27 on both sides.
 *
 * NOT covered: the Basketball Champions League and the FIBA Europe Cup. Those are FIBA
 * competitions, their data goes through FIBA's GDAP portal and needs a subscription.
 * Until that exists there is no open feed, and this function says so in `missing`
 * rather than letting the absence look like an empty calendar.
 *
 * Output is the game shape the bbl function returns, so the panel does not care where
 * a game came from.
 */

const TTL_MS = 6 * 3600e3;
const cache = Object.create(null);
const EL = "https://api-live.euroleague.net";

const COMPS = [
  { code: "E", name: "EuroLeague" },
  { code: "U", name: "EuroCup" }
];

/* Some hosts answer a bare runtime fetch differently from a browser. Saying who we are
   costs nothing and takes one whole class of silent empty answers off the table. */
const HEAD = {
  "user-agent": "Mozilla/5.0 (compatible; LoewenCoachesHub/1.0; +https://basketball-loewen.de)",
  "accept-language": "en"
};

/* only used by the v1 fallback, where there is no country field to read */
const DE_WORDS = ("muenchen munchen munich bayern fcb chemnitz niners ulm ratiopharm frankfurt skyliners " +
  "berlin alba bamberg bonn telekom wuerzburg wurzburg vechta rasta hamburg towers veolia braunschweig " +
  "loewen lowen ludwigsburg riesen mhp oldenburg rostock seawolves jena hagen phoenix weissenfels mbc " +
  "syntainics trier gladiators heidelberg academics goettingen gottingen crailsheim merlins bremerhaven " +
  "giessen tuebingen tubingen").split(" ");

const MONTH = { jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06",
                jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12" };

function norm(s) {
  return String(s || "").toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function isGermanName(name) {
  const w = norm(name).split(/[^a-z0-9]+/).filter(Boolean);
  return w.some(x => DE_WORDS.indexOf(x) >= 0);
}
function isGermanClub(c) {
  const co = (c && c.country) || {};
  return String(co.code || "").toUpperCase() === "GER" || /german|deutsch/i.test(String(co.name || ""));
}

async function get(url, json) {
  const r = await fetch(url, {
    headers: Object.assign({ accept: json ? "application/json" : "application/xml,text/xml,*/*" }, HEAD),
    redirect: "follow"
  });
  const t = await r.text();
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; e.url = url; throw e; }
  if (!json) return t;
  try { return JSON.parse(t); }
  catch (e) { const x = new Error("not JSON"); x.url = url; throw x; }
}
/* ---------- kick-off times, read for what they carry --------------------------------
   Same law as the league function: a timestamp that carries a zone is an instant and is
   turned into the German wall clock the rest of the report runs on; one that carries no
   zone is already that clock and is left alone. Cutting characters 11 to 16 out of an
   instant is what put a EuroCup tip-off two hours away from the truth. */
function lastSundayUTC(y, m) {
  const last = new Date(Date.UTC(y, m + 1, 0));
  return Date.UTC(y, m, last.getUTCDate() - last.getUTCDay(), 1, 0, 0);
}
function berlinOffsetMin(ms) {
  const y = new Date(ms).getUTCFullYear();
  return (ms >= lastSundayUTC(y, 2) && ms < lastSundayUTC(y, 9)) ? 120 : 60;
}
const ZONED = /(?:Z|z|[+-]\d{2}:?\d{2})$/;
function whenParts(raw) {
  const s = String(raw == null ? "" : raw);
  if (!s) return { date: "", time: "", tz: "" };
  const plain = { date: s.slice(0, 10), time: s.length >= 16 ? s.slice(11, 16) : "" };
  if (!ZONED.test(s)) return { date: plain.date, time: plain.time, tz: "local" };
  const ms = Date.parse(s);
  if (!isFinite(ms)) return { date: plain.date, time: plain.time, tz: "unreadable" };
  const b = new Date(ms + berlinOffsetMin(ms) * 60000);
  const p = n => (n < 10 ? "0" : "") + n;
  return {
    date: b.getUTCFullYear() + "-" + p(b.getUTCMonth() + 1) + "-" + p(b.getUTCDate()),
    time: p(b.getUTCHours()) + ":" + p(b.getUTCMinutes()),
    tz: /[Zz]$/.test(s) ? "utc" : "offset"
  };
}
function rows(j) { return Array.isArray(j) ? j : ((j && (j.data || j.items)) || []); }

/* ---------- v2, the one we want ---------- */
function mapV2(g, compName) {
  const lo = g.local || {}, ro = g.road || {};
  const lc = lo.club || {}, rc = ro.club || {};
  const d = String(g.date || "");
  const played = !!g.played;
  return {
    id: g.identifier || String(g.gameCode || ""),
    date: whenParts(d).date,
    time: whenParts(d).time,
    tz: whenParts(d).tz,
    round: g.round != null ? String(g.round) : "",
    competition: compName,
    roundName: g.roundName || g.roundAlias || ((g.phaseType || {}).name) || "",
    homeId: lc.code || "", home: lc.name || "",
    awayId: rc.code || "", away: rc.name || "",
    hs: (played && lo.score != null) ? lo.score : null,
    as: (played && ro.score != null) ? ro.score : null,
    status: played ? "final" : "scheduled",
    venue: (g.venue && (g.venue.name || g.venue.code)) || ""
  };
}
async function viaV2(comp, seasonCode, diag) {
  const base = EL + "/v2/competitions/" + comp.code + "/seasons/" + seasonCode;
  const clubs = rows(await get(base + "/clubs", true)).filter(isGermanClub);
  diag.push({ comp: comp.name, step: "clubs", season: seasonCode, german: clubs.map(c => c.code) });
  if (!clubs.length) return { games: [], clubs: [] };

  const seen = Object.create(null), out = [];
  for (const c of clubs) {
    const j = await get(base + "/games?teamCode=" + encodeURIComponent(c.code), true);
    rows(j).forEach(g => {
      const m = mapV2(g, comp.name);
      if (!m.id || seen[m.id]) return;          /* two German clubs meeting = one game */
      seen[m.id] = 1;
      out.push(m);
    });
  }
  diag.push({ comp: comp.name, step: "games", count: out.length });
  return { games: out, clubs: clubs.map(c => c.name) };
}

/* ---------- v1 fallback: the schedule for the fixtures, the results for the scores ---------- */
function decode(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&").trim();
}
function blocks(xml, tag) {
  const out = [], re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + ">", "g");
  let m; while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function field(block, tag) {
  const m = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + ">"));
  return m ? decode(m[1]) : "";
}
function isoDate(s) {
  const m = String(s || "").match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return "";
  const mm = MONTH[m[1].toLowerCase()];
  return mm ? m[3] + "-" + mm + "-" + String(m[2]).padStart(2, "0") : "";
}
function numOf(v) {
  const n = Number(String(v == null ? "" : v).trim());
  return isFinite(n) && String(v).trim() !== "" ? n : null;
}
function parseV1(xml, compName) {
  let list = blocks(xml, "item");
  if (!list.length) list = blocks(xml, "game");
  const out = [];
  list.forEach(b => {
    const home = field(b, "hometeam"), away = field(b, "awayteam");
    if (!home || !away) return;
    if (!isGermanName(home) && !isGermanName(away)) return;
    const hs = numOf(field(b, "homescore")), as = numOf(field(b, "awayscore"));
    const played = /true|yes|1/i.test(field(b, "played"));
    out.push({
      id: field(b, "gamecode") || (compName + "-" + home + "-" + away),
      date: isoDate(field(b, "date")),
      time: (field(b, "startime") || field(b, "time") || "").slice(0, 5),
      round: field(b, "gameday") || "",
      competition: compName,
      roundName: field(b, "group") || field(b, "round") || "",
      homeId: field(b, "homecode"), home: home,
      awayId: field(b, "awaycode"), away: away,
      hs: (played && hs != null) ? hs : null,
      as: (played && as != null) ? as : null,
      status: (played && hs != null && as != null) ? "final" : "scheduled",
      venue: field(b, "arenaname") || ""
    });
  });
  return out;
}
async function viaV1(comp, seasonCode, diag) {
  const sched = parseV1(await get(EL + "/v1/schedules?seasonCode=" + seasonCode, false), comp.name);
  const by = Object.create(null);
  sched.forEach(g => { by[g.id] = g; });
  try {
    parseV1(await get(EL + "/v1/results?seasonCode=" + seasonCode, false), comp.name).forEach(r => {
      if (r.hs == null) return;
      const g = by[r.id];
      if (g) { g.hs = r.hs; g.as = r.as; g.status = "final"; } else { by[r.id] = r; }
    });
  } catch (e) { diag.push({ comp: comp.name, step: "v1 results", error: String(e.message || e) }); }
  const games = Object.keys(by).map(k => by[k]);
  diag.push({ comp: comp.name, step: "v1", season: seasonCode, count: games.length });
  return { games: games, clubs: [] };
}

/* ---------- Basketball Champions League ----------
 * FIBA publishes no open feed for it; GDAP is a subscription. What the competition's
 * own site does do is render its pages on the server — the club names, group and
 * records are in the HTML that arrives, not drawn later by the browser. That is
 * readable without a key.
 *
 * Next.js is what the site is built with, so the data is in the page twice: as text,
 * and as the JSON the server streamed to the client (one __NEXT_DATA__ script on the
 * Pages Router, a run of self.__next_f.push([1,"…"]) chunks on the App Router). The
 * JSON is worth more than the text, so it is read first.
 *
 * At the time of writing the season had not started: every record read 0/0 and there
 * were no games at all. So this cannot be verified against real data yet, and it is
 * written to fail quietly and say why — never to invent a game. Whatever it finds lands
 * in `diag`, which the panel shows when it has nothing else.
 */
const BCL = { host: "https://www.championsleague.basketball", name: "Champions League" };

function flightBlobs(html) {
  const out = [];
  const nd = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) out.push(nd[1]);
  let m, buf = "";
  const re = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  while ((m = re.exec(html))) buf += m[1];
  if (buf) {
    try { out.push(JSON.parse('"' + buf + '"')); } catch (e) { out.push(buf); }
  }
  return out;
}
/* Every balanced {...} in a blob that mentions one of these keys, parsed on its own.
   The flight payload as a whole is not valid JSON, so it is read object by object. */
function jsonObjects(blob, keys) {
  const out = [];
  for (let i = 0; i < blob.length; i++) {
    if (blob[i] !== "{") continue;
    let depth = 0, str = false, esc = false, end = -1;
    for (let j = i; j < blob.length && j - i < 20000; j++) {
      const c = blob[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { str = !str; continue; }
      if (str) continue;
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (!depth) { end = j; break; } }
    }
    if (end < 0) continue;
    const chunk = blob.slice(i, end + 1);
    if (keys.some(k => chunk.indexOf('"' + k + '"') >= 0)) {
      try { out.push(JSON.parse(chunk)); } catch (e) {}
    }
    i = end;
  }
  return out;
}
const CLUBK = ["name", "clubName", "teamName", "displayName", "title", "shortName"];
function clubName(v) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  for (const k of CLUBK) if (typeof v[k] === "string" && v[k].trim()) return v[k].trim();
  return "";
}
function pickDate(o) {
  for (const k of ["date", "startDate", "startTime", "scheduledTime", "dateTime", "utcDate"]) {
    const v = o[k];
    if (typeof v === "string" && /\d{4}-\d{2}-\d{2}/.test(v)) return v;
  }
  return "";
}
function score(side) {
  if (side && typeof side === "object") {
    for (const k of ["score", "points", "result"]) {
      const v = side[k];
      if (typeof v === "number" && isFinite(v)) return v;
    }
  }
  return null;
}
/* the games sit somewhere inside whatever wrapper the page uses, so every node is
   visited rather than guessing at the path */
function walk(node, fn, depth) {
  if (!node || typeof node !== "object" || (depth || 0) > 12) return;
  fn(node);
  if (Array.isArray(node)) { node.forEach(v => walk(v, fn, (depth || 0) + 1)); return; }
  Object.keys(node).forEach(k => walk(node[k], fn, (depth || 0) + 1));
}
/* A game is an object with two sides and a date. The side keys are whatever the site
   happens to use, so the pairs it may use are listed rather than assumed. */
const SIDES = [["home", "away"], ["local", "road"], ["homeTeam", "awayTeam"],
               ["teamA", "teamB"], ["competitorA", "competitorB"], ["home", "guest"]];
function harvestGames(roots, compName) {
  const out = [], seen = Object.create(null);
  const objs = [];
  roots.forEach(r => walk(r, n => { if (!Array.isArray(n)) objs.push(n); }));
  objs.forEach(o => {
    if (!o || typeof o !== "object") return;
    const date = pickDate(o);
    if (!date) return;
    for (const pair of SIDES) {
      const a = pair[0], b = pair[1];
      if (!(a in o) || !(b in o)) continue;
      const home = clubName(o[a]), away = clubName(o[b]);
      if (!home || !away) continue;
      const hs = score(o[a]), as = score(o[b]);
      const id = String(o.id || o.gameCode || o.identifier || (date + "|" + home + "|" + away));
      if (seen[id]) return;
      seen[id] = 1;
      const played = hs != null && as != null;
      out.push({
        id: "BCL_" + id, date: whenParts(date).date, time: whenParts(date).time,
        tz: whenParts(date).tz,
        round: o.round != null ? String(o.round) : "", competition: compName,
        roundName: String(o.roundName || o.groupName || (o.group && o.group.name) || ""),
        homeId: (o[a] && (o[a].code || o[a].id)) || "", home: home,
        awayId: (o[b] && (o[b].code || o[b].id)) || "", away: away,
        hs: played ? hs : null, as: played ? as : null,
        status: played ? "final" : "scheduled", venue: ""
      });
      return;
    }
  });
  return out;
}
async function viaBCL(diag) {
  const html = await get(BCL.host + "/en/games", false);
  const blobs = flightBlobs(html);
  diag.push({ comp: BCL.name, step: "page", html: html.length, blobs: blobs.map(b => b.length) });
  if (!blobs.length) { diag.push({ comp: BCL.name, step: "parse", error: "no embedded data in the page" }); return { games: [], clubs: [] }; }
  const objs = [];
  blobs.forEach(b => { jsonObjects(b, ["homeTeam", "awayTeam", "local", "road", "gameCode", "scheduledTime", "startDate"]).forEach(o => objs.push(o)); });
  const games = harvestGames(objs, BCL.name).filter(g => isGermanName(g.home) || isGermanName(g.away));
  diag.push({ comp: BCL.name, step: "games", objects: objs.length, count: games.length });
  return { games: games, clubs: [] };
}

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const m = String(q.season || "").match(/\d{4}/);
  const season = m ? m[0] : String(new Date().getFullYear());
  const fresh = q.fresh === "1";

  if (!fresh && cache[season] && Date.now() - cache[season].t < TTL_MS) {
    return reply(200, Object.assign({}, cache[season].d, { cached: true }));
  }

  const out = {
    ok: true, season: season, updated: new Date().toISOString(),
    source: EL, games: [], competitions: [], clubs: [], errors: [], diag: [],
    /* nothing is "not covered" any more: EuroLeague and EuroCup come from their own
       API, the Champions League is read from its site, and the FIBA Europe Cup has no
       German club at all. An empty competition means not played yet, not unreachable. */
    missing: []
  };

  for (const comp of COMPS) {
    /* a season that has not opened yet answers with nothing, so the year before it is
       worth one try before reporting an empty competition */
    const codes = [comp.code + season, comp.code + String(Number(season) - 1)];
    let got = null;
    for (const code of codes) {
      try {
        const r = await viaV2(comp, code, out.diag);
        if (r.games.length) { got = r; break; }
      } catch (e) {
        out.diag.push({ comp: comp.name, step: "v2", season: code, error: String(e.message || e) });
        try {
          const r = await viaV1(comp, code, out.diag);
          if (r.games.length) { got = r; break; }
        } catch (e2) {
          out.errors.push(comp.name + " " + code + ": " + String(e2.message || e2));
        }
      }
    }
    if (got) {
      out.competitions.push(comp.name);
      out.games = out.games.concat(got.games);
      out.clubs = out.clubs.concat(got.clubs);
    }
  }

  /* the Champions League is read from its own site; it has no feed. If it gives
     nothing, the panel says so in `diag` rather than pretending there are no games. */
  try {
    const r = await viaBCL(out.diag);
    if (r.games.length) {
      out.competitions.push(BCL.name);
      out.games = out.games.concat(r.games);
      /* covered after all, so stop listing it as missing */

    }
  } catch (e) {
    out.diag.push({ comp: BCL.name, step: "fetch", error: String((e && e.message) || e) });
  }

  /* THE OFFICIAL TABLES. The games above are only the German clubs', so a table built from
     them would be wrong for everybody else; the competition publishes its standings by
     round, group by group. The round asked for is the last one that has started. */
  out.standings = [];
  for (const comp of COMPS) {
    const sc = comp.code + season;
    try {
      const rs = await get(EL + "/v2/competitions/" + comp.code + "/seasons/" + sc + "/rounds", true);
      const now = Date.now();
      const started = ((rs && rs.data) || []).filter(r => r.phaseTypeCode === "RS" && Date.parse(r.minGameStartDate) <= now)
        .sort((a, b) => b.round - a.round)[0];
      if (!started) continue;
      const st = await get(EL + "/v2/competitions/" + comp.code + "/seasons/" + sc + "/rounds/" + started.round + "/standings", true);
      (Array.isArray(st) ? st : []).forEach(g => out.standings.push({
        competition: comp.name, round: started.round, group: String((g.group && (g.group.rawName || g.group.name)) || ""),
        rows: ((g.standings) || []).map(s => ({ code: String((s.club && s.club.code) || ""), name: String((s.club && s.club.name) || ""),
          crest: String((s.club && s.club.images && s.club.images.crest) || ""),
          pos: (s.data && s.data.position) || null, g: (s.data && s.data.gamesPlayed) || 0, w: (s.data && s.data.gamesWon) || 0, l: (s.data && s.data.gamesLost) || 0,
          pf: (s.data && s.data.pointsFavour) || 0, pa: (s.data && s.data.pointsAgainst) || 0, q: !!(s.data && s.data.qualified) }))
          .sort((a, b) => (a.pos || 99) - (b.pos || 99)) }));
    } catch (e) { out.diag.push({ comp: comp.name, step: "standings", error: String((e && e.message) || e) }); }
  }

  out.games.sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || ""));
  out.teams = Array.from(new Set(out.clubs)).sort();
  out.ok = out.games.length > 0;
  if (out.ok) cache[season] = { t: Date.now(), d: out };
  return reply(200, out);
};

function reply(code, body) {
  return {
    statusCode: code,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=600, s-maxage=21600"
    },
    body: JSON.stringify(body)
  };
}
