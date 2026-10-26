/* ProB (Zweite Basketball Bundesliga) adapter.
 *
 * The league's API takes the club's key as the last part of every address, so the key
 * must never reach the browser: it lives only here, in a Netlify environment variable.
 *
 *   Netlify → Site configuration → Environment variables
 *     PROB_API_KEY   the key of our ProB team (SG Braunschweig)
 *     PROB_LEAGUE    optional, default prob-nord
 *
 * Documentation: https://wiki.2basketballbundesliga.de/index.php/API
 * What a team key reads (checked 2026-10-17): schedule and table of the whole league,
 * the live scores of ProA and ProB, and - for our own team only - the roster, the season
 * stats and the full Swiss Timing files of our games.
 *
 *   ?res=all     schedule + table + live scores + our roster with its stats
 */

const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const S = (v) => (v == null ? "" : String(v));
const num = (v) => { const n = Number(String(v == null ? "" : v).replace(",", ".")); return v !== "" && v != null && isFinite(n) ? n : null; };
const BASE = "https://api.2basketballbundesliga.de";

const cache = {};
function getCache(k, ttl) { const c = cache[k]; return (c && Date.now() - c.t < ttl) ? c.d : null; }

/* the season the league is in: from August on, the one that starts this year */
function seasonNow() {
  const d = new Date(), y = d.getUTCFullYear();
  const s = d.getUTCMonth() >= 6 ? y : y - 1;
  return s + "-" + (s + 1);
}

async function get(path, key) {
  const r = await fetch(BASE + "/" + path + "/" + key, { headers: { accept: "application/json" } });
  const txt = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " " + path);
  /* the league answers 200 with nothing at all when a part is not open to our key */
  if (!txt.trim()) throw new Error(path + ": empty answer (not open to our key)");
  try { return JSON.parse(txt); } catch (e) { throw new Error(path + ": not JSON"); }
}

function schedule(raw) {
  const out = [];
  Object.keys(raw || {}).forEach(day => {
    if (!/^\d+$/.test(day)) return;
    const list = Array.isArray(raw[day]) ? raw[day] : [raw[day]];
    list.forEach(g => {
      if (!g) return;
      const ref = g.referees || {};
      const refs = ["referee1", "referee2", "referee3", "referee4"].map(k => ref[k]).filter(r => r && r.lastname)
        .map(r => (S(r.firstname) + " " + S(r.lastname)).trim());
      out.push({
        id: S(g.id), day: Number(day), round: S(g.round), ts: g.datetime ? Number(g.datetime) * 1000 : null,
        homeId: S(g.homeId), home: S(g.home), hAbbr: S(g.hletter), guestId: S(g.guestId), guest: S(g.guest), gAbbr: S(g.gletter),
        hp: num(g.hPoints), gp: num(g.gPoints), stream: S(g.link_livestream), refs: refs,
        arena: g.stadium ? S(g.stadium.name) : "", city: g.stadium ? S(g.stadium.city) : ""
      });
    });
  });
  return out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function table(raw) {
  return ((raw && raw.table) || []).map(r => ({
    pos: num(r.pos), id: S(r.team_id), team: S(r.team_caption), short: S(r.team_shortname).trim(), abbr: S(r.team_abbrev),
    pts: num(r.PKT), w: num(r.S), l: num(r.N), gp: num(r.G), plus: num(r.plus), minus: num(r.minus), diff: num(r.diff),
    home: S(r.heim), away: S(r.gast), last10: S(r.last10), streak: num(r.serie)
  }));
}

function live(raw) {
  const L = { a: "ProA", n: "ProB Nord", s: "ProB Süd" };
  return (Array.isArray(raw) ? raw : []).map(g => ({
    id: S(g.g), day: S(g.n), q: S(g.q), league: L[g.l] || S(g.l), l: S(g.l), date: S(g.d), time: S(g.s), clock: S(g.t),
    homeId: S(g.t1), awayId: S(g.t2), home: S(g.c1), away: S(g.c2), hp: num(g.p1), ap: num(g.p2),
    top1: g.top1 || null, top2: g.top2 || null, hidden: S(g.h) === "1"
  }));
}

function roster(kader, stats) {
  const tot = {}, avg = {};
  ((stats && stats.g) || []).forEach(p => { tot[S(p.id)] = p; });
  ((stats && stats.s) || []).forEach(p => { avg[S(p.id)] = p; });
  const line = (p) => p ? {
    gp: num(p.games), min: S(p.time), pts: num(p.points), reb: num(p.REB_nr), oreb: num(p.rbo), dreb: num(p.rbd), ast: num(p.assists),
    stl: num(p.ST_nr), blk: num(p.BL_nr), tov: num(p.TO_nr), pf: num(p.fouls), eff: num(p.eff),
    ftm: num(p.FT_points), fta: num(p.FT_attempts), p2m: num(p.P2_points), p2a: num(p.P2_attempts), p3m: num(p.P3_points), p3a: num(p.P3_attempts),
    ftp: num(p.ftp), p2p: num(p.p2p), p3p: num(p.p3p), fgp: num(p.fgp)
  } : null;
  const seen = {};
  const out = ((kader && kader.kader) || []).map(p => {
    const id = S(p.id); seen[id] = 1;
    return {
      id: id, first: S(p.firstname).trim(), last: S(p.lastname).trim(), num: S(p.number), pos: S(p.position1_short) + (p.position2_short ? "/" + S(p.position2_short) : ""),
      height: num(p.height), weight: num(p.weight), born: S(p.birthdate_ymd), nat: S(p.nationality_short), lastClub: S(p.last_station),
      captain: S(p.captain) === "true", coach: /trainer|coach/i.test(S(p.position1_short) + " " + S(p.position1)), avg: line(avg[id]), tot: line(tot[id])
    };
  });
  /* a player with stats who is no longer on the roster sheet still played for us */
  Object.keys(tot).forEach(id => {
    if (seen[id]) return;
    const p = tot[id];
    out.push({ id: id, first: S(p.firstname).trim(), last: S(p.lastname).trim(), num: "", pos: S(p.position), height: null, weight: null,
      born: S(p.birthdate), nat: S(p.nationality), lastClub: "", captain: false, gone: true, avg: line(avg[id]), tot: line(p) });
  });
  return out;
}

function reply(code, body, ttl) {
  const secs = Math.max(0, Math.round((ttl || 0) / 1000));
  return {
    statusCode: code,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": secs ? "public, max-age=" + Math.min(secs, 120) + ", s-maxage=" + secs : "no-store" },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const key = env("PROB_API_KEY", "");
  const league = env("PROB_LEAGUE", "prob-nord");
  const season = S(q.season || seasonNow());
  if (!key) return reply(200, { ok: false, nokey: true, errors: ["PROB_API_KEY is not set in Netlify yet"] }, 0);
  /* never let the key travel back inside an error message */
  const clean = (m) => S(m).split(key).join("…");
  const res = S(q.res || "all");
  try {
    if (res === "all") {
      const ck = "all|" + league + "|" + season;
      const ttl = 3 * 60e3;
      if (q.fresh !== "1") { const hit = getCache(ck, ttl); if (hit) return reply(200, Object.assign({}, hit, { cached: true }), 60e3); }
      const errors = [];
      const take = (p) => get(p, key).catch(e => { errors.push(clean(e.message)); return null; });
      /* the other group of the ProB, for the standings' switch: never an error if it is not there */
      const otherLeague = /nord/.test(league) ? league.replace("nord", "sued") : league.replace(/s(ue|ü)d/, "nord");
      const [sp, tb, lv, kd, st, tbo] = await Promise.all([
        take("spielplan/" + league + "/" + season), take("tabelle_" + league), take("gamesLive"), take("kader"), take("stats_hauptrunde"),
        get("tabelle_" + otherLeague, key).catch(() => null)
      ]);
      const stats = st && st.g && st.g[0];
      const out = {
        ok: true, league: (sp && sp.data && sp.data.league) || (tb && tb.data && tb.data.league) || league, season: season,
        day: sp && sp.data ? num(sp.data.day) : null, updated: new Date().toISOString(),
        tableUpdated: tb && tb.data ? S(tb.data.last_update) : "",
        team: { id: stats ? S(stats.team_id) : "", name: (kd && kd.data && S(kd.data.team_caption)) || (stats ? S(stats.team_caption) : ""),
          short: kd && kd.data ? S(kd.data.team_shortname) : "", abbr: kd && kd.data ? S(kd.data.team_abbrev) : "" },
        games: sp ? schedule(sp) : [], table: tb ? table(tb) : [], live: lv ? live(lv) : [], roster: roster(kd, st),
        other: tbo ? { league: (tbo.data && tbo.data.league) || otherLeague, table: table(tbo) } : null,
        errors: errors
      };
      cache[ck] = { t: Date.now(), d: out };
      return reply(200, out, 60e3);
    }
    /* ?res=file&f=2006342Q4.JSN  one Swiss Timing file of one of our games, as the league
       gives it (the name only: letters, digits, dot, dash, underscore - never a path) */
    if (res === "file") {
      const f = S(q.f);
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(f)) return reply(400, { ok: false, errors: ["bad file name"] }, 0);
      const ck = "file|" + f, hit = getCache(ck, 10 * 60e3);
      if (hit) return reply(200, hit, 60e3);
      const r = await fetch(BASE + "/livedata/" + f + "/" + key, { headers: { accept: "application/json" } });
      const txt = await r.text();
      if (!r.ok) return reply(200, { ok: false, f: f, status: r.status, errors: [clean("HTTP " + r.status)] }, 0);
      if (!txt.trim()) return reply(200, { ok: false, f: f, status: r.status, errors: ["empty answer (no such file, or not open to our key)"] }, 0);
      let data = null; try { data = JSON.parse(clean(txt)); } catch (e) {}
      const out = data != null ? { ok: true, f: f, data: data } : { ok: true, f: f, text: clean(txt).slice(0, 200000) };
      cache[ck] = { t: Date.now(), d: out };
      return reply(200, out, 60e3);
    }
    return reply(400, { ok: false, errors: ["unknown res"] }, 0);
  } catch (e) {
    return reply(502, { ok: false, errors: [clean(e.message)] }, 0);
  }
};
