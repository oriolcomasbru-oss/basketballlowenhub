/* BBL Backend API v2 adapter.
 *
 * One Netlify function in front of the league API. The key never reaches the browser:
 * index.html is downloaded whole by anyone, so the key lives only here, in a Netlify
 * environment variable.
 *
 *   Netlify → Site configuration → Environment variables
 *     BBL_API_KEY    the key from the BBL            (without it → clearly marked demo data)
 *     BBL_API_BASE   default https://api.basketball-bundesliga.de
 *                    (the test server is https://api.bbl.scb.world — only for testing)
 *     BBL_SEASON     optional, overrides the season the app asks for
 *     BBL_EURO_URL   optional, any URL returning JSON with European games
 *
 * Auth is a plain `X-API-Key` header. The production host is rate limited and watched
 * by a behaviour filter, so every answer here is cached and the 18 per-club calls are
 * made in small batches, never all at once.
 *
 * Resources
 *   ?res=all     teams + standings + games (+ cup, + euro)       the league dashboard
 *   ?res=four    four factors for and against, every club        18 calls, cached 6 h
 *   ?res=game    &id=<gameId>   game sheet + decoded live feed
 *   ?res=team    &id=<teamId>   club, roster and roster stats
 *   ?res=seasons available seasons and the active one
 *
 * The shape of `teams / standings / games / euro` is unchanged from the first version,
 * so the dashboard keeps working exactly as before.
 */

const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const num = (v) => { const n = Number(String(v == null ? "" : v).replace(",", ".")); return isFinite(n) ? n : null; };
const S = (v) => (v == null ? "" : String(v));

/* ---------- cache ----------
   Netlify recycles instances, so this only catches bursts. The real protection is the
   cache-control header below, which lets Netlify's CDN hold the answer. */
const TTL = { all: 10 * 60e3, four: 6 * 3600e3, game: 6 * 3600e3, team: 6 * 3600e3, seasons: 12 * 3600e3, players: 6 * 3600e3, pbpall: 12 * 3600e3, roster: 3 * 3600e3 };
const cache = Object.create(null);

function getCache(k, ttl) { const c = cache[k]; return (c && Date.now() - c.t < ttl) ? c.d : null; }
function setCache(k, d) { cache[k] = { t: Date.now(), d: d }; return d; }

/* ---------- transport ---------- */
function apiBase() { return env("BBL_API_BASE", "https://api.basketball-bundesliga.de").replace(/\/+$/, ""); }

async function api(path, key) {
  const url = apiBase() + path;
  const r = await fetch(url, { headers: { "X-API-Key": key, accept: "application/json" }, redirect: "follow" });
  const txt = await r.text();
  if (!r.ok) { const e = new Error("HTTP " + r.status + " " + path + (txt ? " :: " + txt.slice(0, 160) : "")); e.status = r.status; throw e; }
  try { return JSON.parse(txt); } catch (e) { throw new Error("not JSON from " + path + " :: " + txt.slice(0, 160)); }
}

/* Small batches with a breather between them: 18 clubs at once is exactly the shape a
   rate limiter is built to stop. */
async function batched(items, size, gap, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
    if (i + size < items.length && gap) await new Promise(r => setTimeout(r, gap));
  }
  return out;
}

/* ---------- reading game sheets without running out of clock ----------
   A serverless function gets about ten seconds. One game sheet is a few hundred
   kilobytes and the league plays nine a round, so "read every sheet, then answer" runs
   out of time and the caller gets a 502 with an HTML body - which is what an empty
   rotation table, an empty combinations table and an empty shot clock all were.

   So: every sheet read is kept per game (a finished game's sheet never changes), each
   call spends a budget and no more, and the answer says how much of the league it is
   built from. A caller that wants the rest asks again and the next call picks up where
   this one stopped. */
const FEED_TTL = 24 * 3600e3;
const feedCache = Object.create(null);
/* How long one call spends reading sheets, and how many at once.

   Six and a half seconds at three at a time with a breather between batches reads about
   eighteen sheets. A club in March has thirty, so the call always came back partial, the
   client asked again - and the second call landed on a different serverless container,
   whose cache of sheets is its own and empty. Progress made in one container is invisible
   to the next, so a read that cannot finish inside ONE call may never finish at all,
   which is the whole of the bug behind a panel sitting on "reading the game sheets".

   Five at a time, a shorter gap, and most of the ten seconds a call gets: around fifty
   sheets in one pass, which is a full season for any club in the league. Partial is now
   the rare case rather than the normal one, and when it does happen the client says so
   and offers to carry on. */
const READ_BUDGET = 8200;
const READ_WIDTH = 5;
const READ_GAP = 60;
/* The budget above is how long the READING may take; the call also has to fetch the club,
   its roster and its schedule first and merge everything after, and the whole call has
   about ten seconds before the platform kills it and the browser gets an error page
   instead of JSON. So the budget is spent against the clock from the moment the call
   started, never from the moment the reading did: whatever the earlier requests took comes
   off it, and what is left unread is reported as pending instead of as a 502. */
let CALL_T0 = Date.now();
function readBudget() {
  const left = 9000 - (Date.now() - CALL_T0);
  return Math.max(1200, Math.min(READ_BUDGET, left));
}

/* Two different things used to be counted together, and the difference is everything:
   a sheet NOT YET READ, which asking again will fetch, and a sheet THAT CANNOT BE READ,
   which asking again will fail at exactly the same way. Lumping them made "pending"
   permanent, "partial" permanent with it, and the client sat on "reading the game
   sheets" for ever over one game whose sheet the league does not publish. So they are
   counted apart, and a sheet that answers with a 4xx is remembered as empty for an hour:
   not retried on every round, and picked up by itself if it is published later. */
const FEED_BAD_TTL = 3600e3;
async function readFeeds(games, key, budget, onErr) {
  const t0 = Date.now();
  const got = [], todo = [];
  let pending = 0, failed = 0;
  games.forEach(g => {
    const c = feedCache[g.id];
    const ttl = (c && c.bad) ? FEED_BAD_TTL : FEED_TTL;
    if (c && Date.now() - c.t < ttl) { if (c.bad) failed++; else got.push({ g: g, acts: c.a }); }
    else todo.push(g);
  });
  for (let i = 0; i < todo.length; i += READ_WIDTH) {
    if (Date.now() - t0 > (budget || READ_BUDGET)) { pending += todo.length - i; break; }
    const part = todo.slice(i, i + READ_WIDTH);
    await Promise.all(part.map(async g => {
      try {
        const f = decodeFeed(await api("/v2/gameStats/" + encodeURIComponent(g.id), key));
        const a = (f.actions || []).slice().sort((x, y) => gameClock(x) - gameClock(y));
        feedCache[g.id] = { t: Date.now(), a: a };
        got.push({ g: g, acts: a });
      } catch (e) {
        const st = (e && e.status) || 0;
        if (st >= 400 && st < 500) { feedCache[g.id] = { t: Date.now(), a: [], bad: true }; failed++; }
        else pending++;
        if (onErr) onErr(g, e);
      }
    }));
    if (i + READ_WIDTH < todo.length) await new Promise(r => setTimeout(r, READ_GAP));
  }
  return { got: got, pending: pending, failed: failed };
}

/* ---------- season ----------
   The API's seasonId is the starting year: 2025 means 2025/26. The app may ask for a
   year that does not exist yet, so we ask the API which season is live. */
async function resolveSeason(wanted, key) {
  let info = null;
  try { info = await api("/v2/seasons", key); } catch (e) { /* fall through */ }
  const avail = (info && Array.isArray(info.available)) ? info.available.map(String) : [];
  const active = info && info.active != null ? String(info.active) : "";
  const w = S(wanted).match(/\d{4}/) ? S(wanted).match(/\d{4}/)[0] : "";
  if (w && (!avail.length || avail.indexOf(w) >= 0)) return { season: w, active: active, available: avail, asked: w };
  if (active) return { season: active, active: active, available: avail, asked: w };
  return { season: w || String(new Date().getFullYear()), active: active, available: avail, asked: w };
}

/* ---------- normalizers ---------- */
function normTeam(t) {
  return {
    id: S(t.id),
    name: S(t.name),
    short: S(t.short || t.shortname || t.name).slice(0, 16),
    tlc: S(t.tlc || t.TLC),
    logo: apiBase() + "/images/teams/logo/{season}/" + S(t.id)   /* {season} filled client side */
  };
}

function normStanding(r, i) {
  const t = r.team || {};
  const s = r.stats || {};
  const w = num(s.wins), l = num(s.losses);
  let pct = num(s.percent);
  if (pct != null && pct > 1.5) pct = pct / 100;
  if (pct == null && w != null && l != null && w + l > 0) pct = w / (w + l);
  return {
    pos: num(r.position) || (i + 1),
    teamId: S(t.id), team: S(t.name), tlc: S(t.tlc),
    gp: num(s.games), w: w, l: l, pct: pct,
    pf: num(s.plus), pa: num(s.minus), diff: num(s.diff),
    home: S(s.home), away: S(s.away), last10: S(s.last10), streak: num(s.series)
  };
}

const COMP_LABEL = { BBL: "BBL", BBL_CUP: "Pokal" };

/* ================= the play-by-play engine =================
 * The game sheet turned out to hold ONLY action rows — no player totals, no team
 * totals, no starting five. That is why the roster came back empty: it was looking for
 * rows that are not there. Everything is in the events instead, which is more work and
 * a better deal: the same single pass gives the box score, the quarter splits, the shot
 * zones, who was on the floor, and therefore lineups, rotations and on/off.
 *
 * Verified against real sheets: `time` counts DOWN in seconds within a quarter, points1
 * and points2 carry the running score, a made shot has result "+", a rebound carries O
 * or D in info1, and the assist on a made basket is player_id2.
 */
const Q_SECS = { q1: 600, q2: 600, q3: 600, q4: 600, ot1: 300, ot2: 300, ot3: 300, ot4: 300, ot5: 300, ot6: 300 };
const Q_ORDER = ["q1", "q2", "q3", "q4", "ot1", "ot2", "ot3", "ot4", "ot5", "ot6"];
function qIndex(q) { const i = Q_ORDER.indexOf(S(q)); return i < 0 ? 0 : i; }
/* one clock for the whole game, seconds since tip-off */
function gameClock(a) {
  const q = S(a.quarter), i = qIndex(q), len = Q_SECS[q] || 600;
  let base = 0;
  for (let k = 0; k < i; k++) base += Q_SECS[Q_ORDER[k]] || 600;
  const left = num(a.time);
  return base + (left == null ? 0 : (len - left));
}
const SHOT = { P2: 1, P3: 1 };
/* Who is on the floor, quarter by quarter. The sheet never says who started, and a
   substitution names two players without saying which one came in. Both are recovered
   the same way: a player who does something while not on the floor must have been on it
   all along, and a substitution swaps whichever of its two is currently on. */
/* ---------- who is on the floor ----------

   The old version of this was wrong in a way that poisoned everything built on it. When
   a player turned up in the events without a substitution we could match, it opened his
   span at ZERO - the tip-off - and closed it at the final buzzer. One unmatched sub and
   a player who came on in the third quarter was credited with the whole game. That is
   where 43 minutes a night came from, and where a phantom "#E" with a full game came
   from: the feed uses that code for team actions, and it was being treated as a player.

   Rewritten with the one invariant the old code never enforced: five on the floor, never
   six, and nobody on the floor before the quarter in which he first appears.

   Each quarter is solved on its own. A player who acts in a quarter before being
   substituted INTO it was on the floor when it started - that is the starting five, read
   off the events rather than guessed. Then the quarter is walked with that five, each
   SUBST swapping one for one, and a player who acts while not on the floor is added only
   if there is room. Solving per quarter means one bad sheet costs that quarter and not
   the game. */
/* The feed signs its team actions - a team rebound, a bench technical - with an entity
   that has a perfectly normal numeric id and a shirt number that is a LETTER. Filtering
   on the id alone let it through, and it turned up on the roster with a full game's
   minutes and no statistics, in the rotation chart, and inside the pairs and trios. The
   shirt number is what gives it away, so each game's actions are scanned once and any id
   that ever carries a non-numeric number is barred for that game. */
let BAD_IDS = Object.create(null);
function isPlayerId(id) { return !!id && id !== "0" && /^\d+$/.test(id) && !BAD_IDS[id]; }
function markNonPlayers(actions) {
  BAD_IDS = Object.create(null);
  actions.forEach(a => {
    const id = S(a.player_id1), nr = S(a.player_nr1);
    if (!id) return;
    if (nr && !/^\d{1,3}$/.test(nr)) BAD_IDS[id] = 1;
    if (!/^\d+$/.test(id)) BAD_IDS[id] = 1;
  });
  return BAD_IDS;
}

function quarterStarters(acts, code) {
  /* walk backwards: the last thing that happens to a player in a quarter tells us less
     than the first, so go forward and record who acted before his first sub-in */
  const inAt = Object.create(null), actAt = Object.create(null);
  acts.forEach((a, i) => {
    if (S(a.teamcode) !== code) return;
    const p1 = S(a.player_id1), p2 = S(a.player_id2);
    if (a.action === "SUBST") {
      if (isPlayerId(p2) && inAt[p2] === undefined) inAt[p2] = i;
      if (isPlayerId(p1) && actAt[p1] === undefined) actAt[p1] = i;   /* the one going off was on */
      return;
    }
    if (isPlayerId(p1) && actAt[p1] === undefined) actAt[p1] = i;
    if (isPlayerId(p2) && actAt[p2] === undefined) actAt[p2] = i;
  });
  const five = Object.keys(actAt).filter(id => inAt[id] === undefined || actAt[id] < inAt[id]);
  /* more than five candidates means the sheet contradicts itself; keep the earliest,
     which are the ones that acted before anybody was substituted */
  five.sort((x, y) => actAt[x] - actAt[y]);
  return five.slice(0, 5);
}

function onCourtTimeline(actions, code, checks) {
  const spans = [];
  const qs = [];
  actions.forEach(a => { const q = S(a.quarter); if (!qs.length || qs[qs.length - 1] !== q) qs.push(q); });
  /* the game ends when its last quarter ends, not when the last event was written down:
     the final action is usually a few seconds before the buzzer, and clipping everyone
     there quietly loses five players' worth of those seconds in every quarter */
  let end = 0;
  if (qs.length) {
    const lq = qs[qs.length - 1], li = qIndex(lq);
    for (let k = 0; k < li; k++) end += Q_SECS[Q_ORDER[k]] || 600;
    end += Q_SECS[lq] || 600;
  }

  qs.forEach(qname => {
    const acts = actions.filter(a => S(a.quarter) === qname);
    if (!acts.length) return;
    /* the quarter's own boundaries, not its first and last event: play starts at the
       tip and the first action is a few seconds in, and four quarters of that adds up to
       minutes that go missing from everybody's total */
    const qi = qIndex(qname), qLen = Q_SECS[qname] || 600;
    let qFrom = 0;
    for (let k = 0; k < qi; k++) qFrom += Q_SECS[Q_ORDER[k]] || 600;
    const qTo = qFrom + qLen;
    const on = Object.create(null);                 /* id -> when he came on */
    quarterStarters(acts, code).forEach(id => { on[id] = qFrom; });
    const size = () => Object.keys(on).length;
    const put = (id, t) => { if (isPlayerId(id) && on[id] === undefined && size() < 5) on[id] = t; };
    const take = (id, t) => {
      if (on[id] === undefined) return false;
      if (t > on[id]) spans.push({ id: id, from: on[id], to: t });
      delete on[id];
      return true;
    };
    acts.forEach(a => {
      if (S(a.teamcode) !== code) return;
      const t = gameClock(a);
      const p1 = S(a.player_id1), p2 = S(a.player_id2);
      if (a.action === "SUBST") {
        /* one off, one on - and never a sixth man, whatever the sheet says */
        const off = (on[p1] !== undefined) ? p1 : ((on[p2] !== undefined) ? p2 : null);
        const inc = (off === p1) ? p2 : p1;
        if (off) take(off, t); else if (checks) checks.subOrphan++;
        if (isPlayerId(inc) && on[inc] === undefined) {
          if (size() < 5) on[inc] = t; else if (checks) checks.sixth++;
        }
        return;
      }
      /* he did something, so he was on the floor: from now, not from the tip-off */
      if (isPlayerId(p1) && on[p1] === undefined) { if (size() < 5) on[p1] = t; else if (checks) checks.sixth++; }
      if (isPlayerId(p2) && on[p2] === undefined && size() < 5) on[p2] = t;
    });
    Object.keys(on).forEach(id => take(id, qTo));
  });
  /* an overtime that was not played out, or a sheet that stops early */
  const last = Math.max(end, 0);
  spans.forEach(s => { if (s.to > last) s.to = last; });
  if (checks) {
    const secs = spans.reduce((a, s) => a + (s.to - s.from), 0);
    checks.floorSec += secs;
    checks.gameSec += end;
  }
  return { spans: spans, end: end };
}
function onAt(spans, t) {
  const out = [];
  spans.forEach(s => { if (t >= s.from && t < s.to) out.push(s.id); });
  return out.sort();
}

/* ---------- possessions ----------

   Points no longer come from the running score. They are added up from the scoring
   actions inside the possession, which is the only way an and-one lands in the right
   place: the free throw after a made basket belongs to the possession that produced the
   basket, and the running score puts it in whatever comes next.

   A possession ends on a made field goal (unless a free throw by the same side follows,
   which is the and-one), on the last made free throw of a trip, on a defensive rebound,
   on a turnover, and at the end of a quarter. */
function possessions(actions) {
  const out = [];
  const T = actions.map(gameClock);
  let cur = null, q = null, handover = null;
  const open = (team, t) => {
    cur = { team: team, from: (handover != null && handover <= t) ? handover : t,
            to: t, quarter: q, pts: 0, acts: [] };
    handover = null;
  };
  const close = (t) => {
    if (!cur) return;
    cur.to = Math.max(cur.to, t);
    out.push(cur);
    cur = null;
    handover = t;              /* the ball changed hands here */
  };
  /* is the next thing this side does another free throw? then the trip is not over */
  const ftFollows = (i, team) => {
    for (let j = i + 1; j < actions.length; j++) {
      const a = actions[j];
      if (a.action === "SUBST" || a.action === "TIMEO") continue;
      if (S(a.teamcode) !== team) {
        /* a rebound by the other side between free throws does not happen; anything
           else from them means the trip is over */
        if (a.action === "REB") continue;
        return false;
      }
      return a.action === "FT";
    }
    return false;
  };
  actions.forEach((a, i) => {
    const t = T[i], c = S(a.teamcode);
    if (S(a.quarter) !== q) { close(t); q = S(a.quarter); handover = null; }
    if (a.action === "SUBST" || a.action === "TIMEO") return;
    if (c !== "A" && c !== "B") return;
    if (!cur) open(c, t);
    if (c !== cur.team && (a.action === "P2" || a.action === "P3" || a.action === "FT" || a.action === "TO")) {
      close(t); open(c, t);
    }
    cur.acts.push(i);
    cur.to = t;
    const made = S(a.result) === "+";
    if (c === cur.team) {
      if (a.action === "P2" && made) cur.pts += 2;
      else if (a.action === "P3" && made) cur.pts += 3;
      else if (a.action === "FT" && made) cur.pts += 1;
    }
    const fg = (a.action === "P2" || a.action === "P3");
    if (fg && made) { if (!ftFollows(i, cur.team)) close(t); return; }
    if (a.action === "FT" && made) { if (!ftFollows(i, cur.team)) close(t); return; }
    if (a.action === "TO") { close(t); return; }
    if (a.action === "REB" && S(a.info1) === "D") {
      const who = c;
      close(t);
      open(who, t);
      return;
    }
  });
  if (actions.length) close(T[T.length - 1]);
  return out.filter(p => p.acts.length);
}
/* every counting stat a box score has, read off the events */
function boxFromActions(actions, code) {
  const by = Object.create(null);
  const get = id => by[id] || (by[id] = { id: id, num: "", t: blank() });
  actions.forEach(a => {
    if (S(a.teamcode) !== code) return;
    const p1 = S(a.player_id1), p2 = S(a.player_id2);
    /* the feed writes team actions - a team rebound, a bench technical - against a code
       that is not a player id. Letting one through puts a ghost on the roster with a
       full game's minutes and nothing else, which is exactly what "#E" was. */
    if (p1 && !isPlayerId(p1)) return;
    const r = p1 ? get(p1) : null;
    if (r && !r.num) r.num = S(a.player_nr1);
    const made = S(a.result) === "+";
    switch (a.action) {
      case "P2": if (r) { r.t.p2a++; if (made) { r.t.p2m++; r.t.pts += 2; } } break;
      case "P3": if (r) { r.t.p3a++; if (made) { r.t.p3m++; r.t.pts += 3; } } break;
      case "FT": if (r) { r.t.fta++; if (made) { r.t.ftm++; r.t.pts += 1; } } break;
      case "REB": if (r) { if (S(a.info1) === "O") r.t.oreb++; else r.t.dreb++; r.t.reb++; } break;
      case "TO": if (r) r.t.tov++; break;
      case "ST": if (r) r.t.stl++; break;
      case "BL": if (r) r.t.blk++; break;
      case "FOUL": if (r) r.t.pf++; break;
      case "RFOUL": if (r) r.t.fd++; break;
    }
    /* the assist on a made basket, and a shot of ours that got rejected */
    if ((a.action === "P2" || a.action === "P3")) {
      if (made && isPlayerId(p2)) get(p2).t.ast++;
      if (S(a.result) === "BL" && r) r.t.bla++;
    }
  });
  return by;
}

/* every pair, trio and the five itself, as sorted keys */
/* ---------- the shot clock ----------
   The feed has no shot clock in it, so it is reconstructed: a possession starts with 24,
   an offensive rebound inside it resets to 14 (FIBA), and what is left when a shot goes
   up or when the possession ends is the block it belongs to. A possession that runs past
   its clock without a reset we could see is clamped to zero rather than thrown away: the
   event order is right even when a reset is missing from the sheet.
     24-18  early   - what the first option produces
     17-8   middle  - the offence running
     7-0    late    - who takes the shot when there is no time left */
function clockBlock(rem) { return rem >= 18 ? 0 : (rem >= 8 ? 1 : 2); }
function lateLine() { return { pts: 0, fga: 0, fgm: 0, p3a: 0, p3m: 0, fta: 0, ftm: 0, fd: 0, tov: 0, ast: 0, stl: 0, poss: 0 }; }
/* The other kind of "late": not the shot clock but the game clock. The last two minutes
   of any quarter and the last five of the fourth are when a staff asks who wants the
   ball, who gets to the line and who gives it away - and the feed's time is seconds
   remaining in the quarter, so both windows are a comparison, not an inference. */
/* Two windows, and the second is the one a staff argues about.

   q2  - the last two minutes of ANY quarter.
   cl  - the same two minutes of the fourth or an overtime, but only while the game is
         actually in the balance: six points or fewer either way, measured from the
         running score at that moment and not from the final result. A twenty-point win
         has garbage minutes in it and they do not belong in a clutch column.

   Assists and steals ride along with the shooting, because who creates and who takes the
   ball away in those minutes is the other half of the question. */
function lateGame(actions, code) {
  const out = { q2: Object.create(null), cl: Object.create(null),
                tq2: lateLine(), tcl: lateLine(), clSec: 0 };
  const get = (m, id) => m[id] || (m[id] = lateLine());
  actions.forEach(a => {
    const t = num(a.time);
    if (t == null) return;
    const q = S(a.quarter);
    if (t > 120) return;
    const s1 = num(a.points1), s2 = num(a.points2);
    const mine = (code === "A") ? s1 : s2, theirs = (code === "A") ? s2 : s1;
    const close = (mine != null && theirs != null) && Math.abs(mine - theirs) <= 6;
    const isCl = (q === "q4" || /^ot/.test(q)) && close;
    if (S(a.teamcode) !== code) return;
    const id = S(a.player_id1), id2 = S(a.player_id2);
    const made = S(a.result) === "+";
    const bump = (m, tm) => {
      const r = isPlayerId(id) ? get(m, id) : null;
      const hit = (x) => { if (!x) return;
        switch (a.action) {
          case "P2": x.fga++; if (made) { x.fgm++; x.pts += 2; } break;
          case "P3": x.fga++; x.p3a++; if (made) { x.fgm++; x.p3m++; x.pts += 3; } break;
          case "FT": x.fta++; if (made) { x.ftm++; x.pts += 1; } break;
          case "RFOUL": x.fd++; break;
          case "TO": x.tov++; break;
          case "ST": x.stl++; break;
        } };
      hit(r); hit(tm);
      /* the assist belongs to the second player on a made basket */
      if (made && (a.action === "P2" || a.action === "P3") && isPlayerId(id2)) {
        get(m, id2).ast++; if (tm) tm.ast++;
      }
    };
    bump(out.q2, out.tq2);
    if (isCl) bump(out.cl, out.tcl);
  });
  return out;
}
function clockSplit(actions, poss, code) {
  const blank3 = () => [0, 1, 2].map(() => ({ poss: 0, pts: 0, fga: 0, fgm: 0, p3a: 0, p3m: 0, fta: 0, ftm: 0, fd: 0, tov: 0 }));
  const out = { team: blank3(), opp: blank3(), byPlayer: Object.create(null) };
  const pl = id => out.byPlayer[id] || (out.byPlayer[id] = blank3());
  const times = actions.map(gameClock);
  poss.forEach(p => {
    const side = (p.team === code) ? out.team : out.opp;
    let len = 24, ref = p.from;
    const own = p.acts || [];
    for (let n = 0; n < own.length; n++) {
      const i = own[n], t = times[i], a = actions[i];
      if (S(a.teamcode) !== p.team) continue;
      if (a.action === "REB" && S(a.info1) === "O") { len = 14; ref = t; continue; }
      const rem = Math.max(0, Math.min(len, len - (t - ref)));
      const b = clockBlock(rem);
      if (a.action === "P2" || a.action === "P3") {
        side[b].fga++; if (a.action === "P3") side[b].p3a++;
        const made = S(a.result) === "+";
        if (made) { side[b].fgm++; if (a.action === "P3") side[b].p3m++; }
        if (p.team === code) {
          const q = pl(S(a.player_id1))[b];
          q.fga++; if (a.action === "P3") q.p3a++;
          if (made) { q.fgm++; if (a.action === "P3") q.p3m++; }
          q.pts += made ? (a.action === "P3" ? 3 : 2) : 0;
        }
      } else if (a.action === "TO") {
        side[b].tov++;
        if (p.team === code) pl(S(a.player_id1))[b].tov++;
      } else if (a.action === "FT") {
        side[b].fta++; if (S(a.result) === "+") side[b].ftm++;
        if (p.team === code) { const q = pl(S(a.player_id1))[b];
          q.fta++; if (S(a.result) === "+") { q.ftm++; q.pts++; } }
      } else if (a.action === "RFOUL") {
        side[b].fd++;
        if (p.team === code) pl(S(a.player_id1))[b].fd++;
      }
    }
    const remEnd = Math.max(0, Math.min(len, len - (p.to - ref)));
    const be = clockBlock(remEnd);
    side[be].poss++; side[be].pts += p.pts;
  });
  return out;
}
function unitKeys(five) {
  const out = [five.slice().sort().join("|")];
  for (let i = 0; i < five.length; i++) {
    for (let j = i + 1; j < five.length; j++) {
      out.push([five[i], five[j]].sort().join("|"));
      for (let k = j + 1; k < five.length; k++) out.push([five[i], five[j], five[k]].sort().join("|"));
    }
  }
  return out;
}
function mergeInto(t, r) {
  Object.keys(r).forEach(k => { if (k !== "gp" && typeof r[k] === "number") t[k] = (t[k] || 0) + r[k]; });
}
function teamFromBox(t, box) {
  t.gp++;
  Object.keys(box).forEach(pid => {
    const r = box[pid].t;
    t.fgm += r.p2m + r.p3m; t.fga += r.p2a + r.p3a;
    t.p3m += r.p3m; t.p3a += r.p3a;
    t.ftm += r.ftm; t.fta += r.fta;
    t.pts += r.pts; t.oreb += r.oreb; t.dreb += r.dreb;
    t.tov += r.tov; t.ast += r.ast; t.stl += r.stl; t.blk += r.blk; t.pf += r.pf;
  });
}

/* ---------- per-player aggregation ---------- */
function blank() {
  return { gp: 0, sec: 0, pts: 0, p2m: 0, p2a: 0, p3m: 0, p3a: 0, ftm: 0, fta: 0,
           oreb: 0, dreb: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, pm: 0, eff: 0,
           /* fouls drawn and shots of ours that got rejected: both are PIR terms, and
              neither is in a normal box score */
           fd: 0, bla: 0 };
}
function add(t, p) {
  const n = k => num(p[k]) || 0;
  t.gp++;
  t.sec += n("SP"); t.pts += n("PTS");
  t.p2m += n("P2M"); t.p2a += n("P2A"); t.p3m += n("P3M"); t.p3a += n("P3A");
  t.ftm += n("FTM"); t.fta += n("FTA");
  t.oreb += n("OREB"); t.dreb += n("DREB"); t.reb += n("REB");
  t.ast += n("AST"); t.stl += n("STL"); t.blk += n("BL"); t.tov += n("TOV");
  t.pf += n("FOUL"); t.pm += n("PM"); t.eff += n("EFF"); t.fd += n("FOULR");
}
/* A side's totals, taken from the team row of the sheet rather than by adding the
   players up, so a sheet that disagrees with itself shows it. */
function blankTeam() {
  return { gp: 0, sec: 0, pts: 0, fgm: 0, fga: 0, p3m: 0, p3a: 0, ftm: 0, fta: 0,
           oreb: 0, dreb: 0, tov: 0, ast: 0, stl: 0, blk: 0, pf: 0 };
}
function addTeam(t, row, secs) {
  if (!row) return;
  const n = k => num(row[k]) || 0;
  t.gp++;
  t.sec += secs || 0;
  t.fgm += n("P2M") + n("P3M"); t.fga += n("P2A") + n("P3A");
  t.p3m += n("P3M"); t.p3a += n("P3A");
  t.ftm += n("FTM"); t.fta += n("FTA");
  t.pts += n("FTM") + 2 * n("P2M") + 3 * n("P3M");
  t.oreb += n("OREB"); t.dreb += n("DREB"); t.tov += n("TOV");
  t.ast += n("AST"); t.stl += n("STL"); t.blk += n("BL"); t.pf += n("FOUL");
}
/* The roster endpoint is the only place a name lives, and its field names are not
   guaranteed, so the likely ones are tried and the shirt number is kept as a second
   way in for when the ids do not line up. */
/* The roster is the only place a name lives. Its rows look like
   { id: 2001027, firstName, lastName, playerId, NUM: "8" } — `id` is the same number the
   feed uses for a player, `playerId` is something else, so the join is on `id` with the
   shirt number as a second way in for anyone the list misses. */
/* A head shot, without guessing which field holds it.

   Naming every candidate field by hand was the wrong approach and it did not work: the
   roster rows are undocumented and the name has changed between seasons. So the row is
   WALKED instead - every string anywhere inside it, at any depth - and anything that looks
   like an image is taken, with keys that mention a photo preferred over keys that do not.
   If the feed carries a portrait under any name at all, this finds it.

   Failing that, the conventional paths. The club crest lives at
   /images/teams/logo/{season}/{id} - note the "logo" segment - so the player path almost
   certainly carries an equivalent one, and the first guess omitted it. Rather than pick a
   favourite, all of them are handed to the browser, which tries each in turn and keeps the
   first that loads. A wrong candidate costs one failed request and nothing else. */
/* Every path the image host might use, in one list, so the proxy and the probe agree.
   The crest is documented by the feed itself; the player path is not, so all the shapes
   the crest path implies are tried in turn. */
function imgPaths(kind, season, id) {
  if (kind === "team") {
    return ["/images/teams/logo/" + season + "/" + id,
            "/images/teams/" + season + "/" + id,
            "/images/teams/logo/" + id];
  }
  /* Read off the league's own site, which serves exactly this:
       https://api.basketball-bundesliga.de/images/player/portrait/2026/2003105
     PLAYER, singular - the crest path is /images/teams/ with an s and the portrait path is
     not, which is what every guess here got wrong. The rest stay as fallbacks in case an
     older season is shaped differently. */
  /* The probe answered this: portrait and photo, PLAYER singular, both 200 with an image
     content type; every plural /images/players/... shape came back 400 or 404. They were
     kept as fallbacks, and each one cost an upstream round trip on every miss - five
     requests to learn nothing. Two paths, both known to work, is the whole list. */
  return ["/images/player/portrait/" + season + "/" + id,
          "/images/player/photo/" + season + "/" + id];
}
const IMG_RE = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;
const IMG_KEY = /(photo|image|picture|headshot|portrait|avatar|thumb|media)/i;
function deepImages(obj) {
  const hits = [];
  const seen = new Set();
  const walk = (v, key, depth) => {
    if (v == null || depth > 4) return;
    if (typeof v === "string") {
      const t = v.trim();
      if (!t || t.length > 400 || seen.has(t)) return;
      const looksUrl = /^https?:\/\//i.test(t) || t[0] === "/";
      if (IMG_RE.test(t) || (looksUrl && IMG_KEY.test(key || "")) || (IMG_KEY.test(key || "") && looksUrl)) {
        seen.add(t);
        hits.push({ url: t, strong: IMG_KEY.test(key || "") || IMG_RE.test(t), key: S(key) });
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach(x => walk(x, key, depth + 1)); return; }
    if (typeof v === "object") { Object.keys(v).forEach(k => walk(v[k], k, depth + 1)); }
  };
  walk(obj, "", 0);
  hits.sort((a, b) => (b.strong ? 1 : 0) - (a.strong ? 1 : 0));
  return hits;
}
/* What the roster row itself carries, and nothing invented.

   This used to append five guessed URLs per player id - /images/players/photo/{season}/..
   and friends - on the theory that a wrong guess costs one failed request. It does not.
   The image host needs the API key, so a browser asking it directly gets nothing back
   whatever the path, and eight of those per player on a twelve man roster is a hundred
   dead requests on the first render of every panel that shows a face. The proxy below
   (res=img) is the only way a browser can get one of these images at all, and the client
   falls back to it by player id, so the guesses bought nothing and cost a lot. If the
   feed publishes a real, public URL it is still used first - that is what this reads. */
function photoOf(r, p) {
  const abs = u => /^https?:/i.test(u) ? u : (apiBase() + (u[0] === "/" ? "" : "/") + u);
  const out = [];
  deepImages(r).forEach(hRec => { const u = abs(hRec.url); if (out.indexOf(u) < 0) out.push(u); });
  return out.slice(0, 4);
}
function rosterIndex(rows) {
  const by = Object.create(null);
  (Array.isArray(rows) ? rows : []).forEach(r => {
    const p = r.player || r;
    const first = S(p.firstName || r.firstName), last = S(p.lastName || r.lastName);
    const nm = S(p.name || p.fullName || r.name || (first + " " + last).trim());
    const no = S(r.NUM || r.number || r.jersey || p.NUM || p.number || p.jersey);
    /* the roster's own id for the player, which need not be the id the event feed uses -
       the image host may key on either, so both travel to the client */
    /* Whatever the roster endpoint happens to call them. A scouting card wants the
       passport - where he is from, how big he is, how old, and what he plays - and the feed
       spells those a dozen ways depending on the season. Anything missing simply does not
       appear on the card. */
    const grab = (obj, re) => {
      if (!obj || typeof obj !== "object") return "";
      const k = Object.keys(obj).filter(x => re.test(x))[0];
      if (!k) return "";
      const v = obj[k];
      if (v == null) return "";
      /* nationalities comes back as ["DE"], and one nationality is what a card prints */
      if (Array.isArray(v)) return S(v.filter(Boolean)[0] || "");
      if (typeof v === "object") return S(v.name || v.code || v.value || v.title || "");
      return S(v);
    };
    const pick2 = re => grab(p, re) || grab(r, re);
    /* The roster carries the official season line as well as the passport: games, games
       started, seconds on the floor and the whole box score, totals and per game. It is the
       league's own arithmetic over every game played, so it is worth having next to ours -
       and it is there from the first call, while the game sheets are still being read. */
    const stRaw = (p.seasonStats || r.seasonStats || null);
    /* num() hands back null for anything that is not a number, and isFinite(null) is true
       because null coerces to zero - so the type check is the one that matters here */
    const N = x => { const v = num(x); return (typeof v === "number" && isFinite(v)) ? v : 0; };
    const off = stRaw ? {
      gp: N(stRaw.GP), s5: N(stRaw.S5), sec: N(stRaw.SP),
      pts: N(stRaw.PTS), p2m: N(stRaw["2PM"]), p2a: N(stRaw["2PA"]),
      p3m: N(stRaw["3PM"]), p3a: N(stRaw["3PA"]), ftm: N(stRaw.FTM), fta: N(stRaw.FTA),
      oreb: N(stRaw.OREB), dreb: N(stRaw.DREB), reb: N(stRaw.REB), ast: N(stRaw.AST),
      stl: N(stRaw.STL), blk: N(stRaw.BL), tov: N(stRaw.TOV), pf: N(stRaw.FOUL),
      fd: N(stRaw.FOULR), pm: N(stRaw.PM), eff: N(stRaw.EFF)
    } : null;
    const rec = { name: nm, num: no, first: first, last: last, photo: photoOf(r, p),
                  pid: S(p.id || p.playerId || r.playerId || r.id),
                  /* POINT_GUARD, SHOOTING_GUARD, … - the underscores go, the client maps it */
                  pos: pick2(/^(position|pos|spielposition)$/i).replace(/_/g, " ").trim(),
                  height: pick2(/^(height|groesse|gr[oö]sse|size)$/i),
                  weight: pick2(/^(weight|gewicht)$/i),
                  nat: pick2(/(nationalit|nation|country|citizenship)/i),
                  born: pick2(/(birthdate|birthday|birth|geburt|dob)/i),
                  off: off };
    [r.id, r.playerId, p.id, p.playerId].forEach(v => { const k = S(v); if (k) by["id:" + k] = rec; });
    if (no && !by["no:" + no]) by["no:" + no] = rec;
  });
  return by;
}

/* main | playin | playoff | cup — the league schedule carries all four under one
   competition code, and they are not the same kind of fixture. */
function phaseOf(comp, g) {
  if (comp === "BBL_CUP") return "cup";
  const n = S(g.roundName || g.round || g.phase).toUpperCase();
  if (/PLAY[\s_-]?IN/.test(n)) return "playin";
  if (/PLAY[\s_-]?OFF|FINAL|SEMI|QUARTER|VIERTEL|HALBFINAL|ACHTEL/.test(n)) return "playoff";
  return "main";
}

/* ---------- kick-off times -------------------------------------------------------
   The schedule used to be read by cutting characters 11 to 16 out of the timestamp and
   calling it the time. That is only right when the feed writes the German wall clock
   with no zone on it. The moment a fixture arrives as an instant - "…T16:30:00Z", or an
   offset the feed put there itself - those characters are a time in another zone, and a
   staff reads 16:30 for a game that tips at 18:30. It is also how a date goes wrong: a
   20:30 game on the 6th is 18:30Z on the 6th, but a 01:00 kick-off would be the day
   before in UTC and the whole fixture lands on the wrong day.

   So the timestamp is read for what it carries. Zoned, it is turned into the German
   wall clock - one clock for the whole report, whichever country the game is in.
   Unzoned, it is already that clock and is left exactly as it is. Nothing is shifted by
   a fixed two hours anywhere, and `tz` says which of the two happened so the diagnostics
   can report what the league is really sending rather than what we assume.

   Europe/Berlin is worked out here rather than asked of Intl, which depends on the time
   zone data the runtime happens to ship: summer time runs from the last Sunday in March
   at 01:00 UTC to the last Sunday in October at 01:00 UTC, and has since 1996. */
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
  const s = S(raw);
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

function normGame(g) {
  const ht = g.homeTeam || {}, at = g.guestTeam || g.awayTeam || {};
  const when = S(g.scheduledTime);
  const w = whenParts(when);
  const iso = w.date, time = w.time;
  const res = g.results || null;
  const fs = res && Array.isArray(res.finalScore) ? res.finalScore : (g.result && Array.isArray(g.result.final) ? g.result.final : null);
  const comp = S(g.competition || "BBL");
  const done = !!(g.completed || (fs && fs.length === 2));
  const phase = phaseOf(comp, g);
  return {
    id: S(g.id),
    /* `utc` is the league's own string, untouched, so the diagnostics can show what it
       actually sent beside what we display */
    date: iso, time: time, utc: when, tz: w.tz,
    /* the cup day number is not a league matchday — leaving it empty keeps the
       matchday panel reading league rounds only */
    /* a matchday is a number and belongs to the main round; a knockout round is a
       name. Keeping `round` for the main round only is what stops the cup and the
       play-offs being read as league matchdays. */
    round: phase === "main" ? S(g.day || "") : "",
    day: num(g.day),
    competition: COMP_LABEL[comp] || comp,
    phase: phase,
    roundName: S(g.roundName || g.round),
    homeId: S(ht.id), home: S(ht.name), homeTlc: S(ht.TLC || ht.tlc),
    awayId: S(at.id), away: S(at.name), awayTlc: S(at.TLC || at.tlc),
    hs: fs ? num(fs[0]) : null,
    as: fs ? num(fs[1]) : null,
    quarters: res && Array.isArray(res.scores) ? res.scores : null,
    attendance: res ? num(res.spectators) : null,
    status: done ? "final" : "scheduled",
    venue: S((g.stadium && g.stadium.name) || g.stadium || "")
  };
}

/* ---------- four factors ----------
   Possessions are the Oliver estimate. The API gives the same block for the club and
   for its opponents, so defence is measured, not inferred. */
function pack(s) {
  if (!s) return null;
  const FGA = num(s.FGA), FGM = num(s.FGM), P3 = num(s["3PM"]), FTA = num(s.FTA), FTM = num(s.FTM);
  const OREB = num(s.OREB), DREB = num(s.DREB), TOV = num(s.TOV), PTS = num(s.PTS), GP = num(s.GP);
  if (FGA == null || !FGA) return null;
  return {
    gp: GP, pts: PTS, fga: FGA, fgm: FGM, p3m: P3, p3a: num(s["3PA"]),
    fta: FTA, ftm: FTM, oreb: OREB, dreb: DREB, tov: TOV,
    ast: num(s.AST), stl: num(s.STL), bl: num(s.BL),
    p2m: (FGM != null && P3 != null) ? FGM - P3 : null,
    p2a: (FGA != null && num(s["3PA"]) != null) ? FGA - num(s["3PA"]) : null,
    p3m: P3, p3a: num(s["3PA"]),
    poss: FGA - (OREB || 0) + (TOV || 0) + 0.44 * (FTA || 0),
    efg: (FGM + 0.5 * (P3 || 0)) / FGA,
    ftr: FTA != null ? FTA / FGA : null
  };
}

function pickRound(rows, want) {
  if (!Array.isArray(rows)) return null;
  for (const r of want) { const hit = rows.find(x => S(x.round) === r); if (hit) return hit; }
  return rows[0] || null;
}

function fourFactors(team, js, want) {
  const o = pack(pickRound(js && js.teamStats, want));
  const d = pack(pickRound(js && js.opponentStats, want));
  if (!o || !d) return null;
  const gp = o.gp || d.gp || null;
  return {
    teamId: S(team.id), team: S(team.name), tlc: S(team.tlc), gp: gp,
    ortg: o.poss ? 100 * o.pts / o.poss : null,
    drtg: d.poss ? 100 * d.pts / d.poss : null,
    net: (o.poss && d.poss) ? (100 * o.pts / o.poss) - (100 * d.pts / d.poss) : null,
    pace: gp ? (o.poss + d.poss) / 2 / gp : null,
    off: { efg: o.efg, tov: o.poss ? o.tov / o.poss : null, reb: (o.oreb + d.dreb) ? o.oreb / (o.oreb + d.dreb) : null, ftr: o.ftr, pts: gp ? o.pts / gp : null,
           p2m: o.p2m, p2a: o.p2a, p3m: o.p3m, p3a: o.p3a, ftm: o.ftm, fta: o.fta },
    def: { efg: d.efg, tov: d.poss ? d.tov / d.poss : null, reb: (o.dreb + d.oreb) ? o.dreb / (o.dreb + d.oreb) : null, ftr: d.ftr, pts: gp ? d.pts / gp : null,
           p2m: d.p2m, p2a: d.p2a, p3m: d.p3m, p3a: d.p3a, ftm: d.ftm, fta: d.fta }
  };
}

/* ---------- live / post-game feed ----------
   The feed is arrays of numbers to keep it small; the first number is the row type.
   This is the mapping published with the API, kept here so nothing downstream has to
   guess what column 17 means. */
const FEED = {
  type: { 0: "scorelist", 1: "action", 2: "team", 3: "time_event", 4: "player_stats", 5: "scorelist_delete", 6: "action_delete", 7: "starting_five", 8: "delete_player", 20: "history_end" },
  quarter: { 1: "q1", 2: "q2", 3: "q3", 4: "q4", 5: "ot1", 6: "ot2", 7: "ot3", 8: "ot4", 9: "ot5", 10: "ot6" },
  action: { 0: "JB", 1: "JS", 2: "FT", 3: "P2", 4: "P3", 5: "FOUL", 6: "RFOUL", 7: "REB", 8: "TREB", 9: "TO", 10: "ST", 11: "BL", 12: "TIMEO", 13: "SUBST", 14: "CFOUL", 15: "TTO" },
  info1: { 0: "D", 1: "O", 2: "P", 3: "T", 4: "U", 5: "Q", 6: "C", 7: "P", 8: "1", 9: "2", 10: "3", 11: "LB", 12: "BP", 13: "OB", 14: "TR", 15: "VI", 16: "5", 17: "8", 18: "24", 19: "E" },
  info3: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: "SC", 7: "FB", 8: "TO", 9: "FT", 10: "ST", 11: "SF", 12: "AL", 51: "JS", 52: "LU", 53: "DU", 54: "AO", 55: "TI" },
  result: { 0: "-", 1: "+", 2: "BL" },
  teamcode: { 1: "A", 2: "B" },
  timeAction: { 0: "start", 1: "end", 2: "game end" },
  playcode: { 0: "N", 1: "S" }
};
const FEED_COLS = {
  0: ["type", "id", "quarter", "time", "points_1", "points_2"],
  1: ["type", "id", "quarter", "teamcode", "player_id1", "player_id2", "time", "player_nr1", "player_nr2", "action", "info1", "info2", "info3", "result", "points1", "points2", "x", "y", "time_of_day"],
  2: ["type", "id", "teamcode", "FTM", "FTA", "FT_rate", "P2M", "P2A", "P2_rate", "P3M", "P3A", "P3_rate", "FOUL", "DREB", "OREB", "BL", "STL", "TOV", "index1", "index2", "team_fouls"],
  3: ["type", "id", "quarter", "time", "action", "points1", "points2", "time_of_day"],
  4: ["type", "id", "teamcode", "player_id", "playcode", "NUM", "PTS", "FTM", "FTA", "FT_rate", "P2M", "P2A", "P2_rate", "P3M", "P3A", "P3_rate", "FOUL", "REB", "AST", "BL", "STL", "TOV", "index1", "index2", "SP", "DREB", "OREB", "EFF", "PM", "FOULR"],
  5: ["type", "id", "points_1", "points_2"],
  6: ["type", "id"],
  7: ["type", "quarter", "teamcode", "player_id1", "player_id2", "player_id3", "player_id4", "player_id5"],
  8: ["type", "id"],
  20: ["type"]
};
const FEED_MAP = {
  0: { 0: "type", 2: "quarter" },
  1: { 0: "type", 2: "quarter", 3: "teamcode", 9: "action", 10: "info1", 12: "info3", 13: "result" },
  2: { 0: "type", 2: "teamcode" },
  3: { 0: "type", 2: "quarter", 4: "timeAction" },
  4: { 0: "type", 2: "teamcode", 4: "playcode" },
  5: { 0: "type" }, 6: { 0: "type" },
  7: { 0: "type", 1: "quarter", 2: "teamcode" },
  8: { 0: "type" }, 20: { 0: "type" }
};

function mapRow(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const t = Number(arr[0]);
  const cols = FEED_COLS[t]; if (!cols) return null;
  const maps = FEED_MAP[t] || {};
  const o = {};
  cols.forEach((k, i) => {
    const m = maps[i];
    o[k] = m ? (FEED[m][arr[i]] != null ? FEED[m][arr[i]] : arr[i]) : arr[i];
  });
  return o;
}

/* The one claim worth checking at runtime: that the "points" columns of a player row
   are made shots, not points. If PTS ever stops equalling FTM + 2·P2M + 3·P3M the
   decoding is wrong and the answer says so instead of serving quiet nonsense. */
function decodeFeed(raw) {
  const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
  const out = { actions: [], players: [], teams: [], score: [], timeline: [], starters: [], checks: { players: 0, mismatched: 0, ok: true } };
  rows.forEach(r => {
    const o = mapRow(r); if (!o) return;
    switch (o.type) {
      case "action": out.actions.push(o); break;
      case "player_stats": {
        out.players.push(o);
        const pts = num(o.PTS), ftm = num(o.FTM) || 0, p2 = num(o.P2M) || 0, p3 = num(o.P3M) || 0;
        if (pts != null) { out.checks.players++; if (pts !== ftm + 2 * p2 + 3 * p3) out.checks.mismatched++; }
        break;
      }
      case "team": out.teams.push(o); break;
      case "scorelist": out.score.push(o); break;
      case "time_event": out.timeline.push(o); break;
      case "starting_five": out.starters.push(o); break;
    }
  });
  out.checks.ok = out.checks.mismatched === 0;
  /* shots carry their spot on the floor; keep them apart, that is the scouting gold */
  out.shots = out.actions.filter(a => (a.action === "P2" || a.action === "P3") && a.x != null && a.y != null)
    .map(a => ({
      team: a.teamcode, player: a.player_id1, num: a.player_nr1,
      three: a.action === "P3", made: a.result === "+", blocked: a.result === "BL",
      zone: a.info1, shotType: a.info3, assist: a.player_id2 || null,
      q: a.quarter, time: a.time, x: a.x, y: a.y
    }));
  return out;
}

/* ---------- demo payload, used while there is no key ---------- */
function demoPayload() {
  const names = ["Alba Berlin", "Bayern Munich", "Bamberg", "Bonn", "Löwen Braunschweig", "Chemnitz", "Frankfurt", "Göttingen",
    "Hamburg", "Heidelberg", "Jena", "Ludwigsburg", "Oldenburg", "Rostock", "Ulm", "Vechta", "Weissenfels", "Würzburg"];
  const teams = names.map((n, i) => ({ id: "T" + (i + 1), name: n, short: n.slice(0, 14), tlc: n.slice(0, 3).toUpperCase(), logo: "" }));
  const games = [];
  const base = new Date(Date.now() - 25 * 86400000);
  for (let r = 1; r <= 6; r++) for (let i = 0; i < 9; i++) {
    const home = teams[(i + r) % teams.length], away = teams[(teams.length - 1 - i + r) % teams.length];
    if (home.id === away.id) continue;
    const d = new Date(base.getTime() + ((r - 1) * 7 + (i % 2)) * 86400000);
    const played = d.getTime() < Date.now();
    games.push({
      id: "G" + r + "-" + i, date: d.toISOString().slice(0, 10), time: i % 2 ? "18:00" : "20:30",
      round: String(r), competition: "BBL", homeId: home.id, home: home.name, awayId: away.id, away: away.name,
      hs: played ? 70 + ((i * 7 + r * 3) % 26) : null, as: played ? 70 + ((i * 5 + r * 11) % 26) : null,
      status: played ? "final" : "scheduled", venue: ""
    });
  }
  const tally = {}; teams.forEach(t => tally[t.id] = { w: 0, l: 0, pf: 0, pa: 0 });
  games.filter(g => g.status === "final").forEach(g => {
    const hh = tally[g.homeId], aa = tally[g.awayId];
    hh.pf += g.hs; hh.pa += g.as; aa.pf += g.as; aa.pa += g.hs;
    if (g.hs > g.as) { hh.w++; aa.l++; } else { aa.w++; hh.l++; }
  });
  const standings = teams.map(t => {
    const s = tally[t.id];
    return { pos: 0, teamId: t.id, team: t.name, tlc: t.tlc, gp: s.w + s.l, w: s.w, l: s.l, pct: (s.w + s.l) ? s.w / (s.w + s.l) : 0, pf: s.pf, pa: s.pa, diff: s.pf - s.pa };
  }).sort((x, y) => (y.pct - x.pct) || (y.diff - x.diff)).map((r, i) => (r.pos = i + 1, r));
  const four = teams.map((t, i) => {
    const seed = (i * 37) % 23;
    const ortg = 104 + (seed % 13) - 6, drtg = 104 + ((seed * 5) % 13) - 6;
    return {
      teamId: t.id, team: t.name, tlc: t.tlc, gp: 7, ortg: ortg, drtg: drtg, net: ortg - drtg, pace: 72 + (seed % 7),
      off: { efg: .50 + (seed % 9) / 100 - .04, tov: .13 + (seed % 5) / 100 - .02, reb: .26 + (seed % 7) / 100 - .03, ftr: .22 + (seed % 6) / 100 - .03, pts: 80 + seed % 11 },
      def: { efg: .50 + ((seed * 3) % 9) / 100 - .04, tov: .13 + ((seed * 2) % 5) / 100 - .02, reb: .72 + (seed % 7) / 100 - .03, ftr: .22 + ((seed * 3) % 6) / 100 - .03, pts: 80 + (seed * 2) % 11 }
    };
  });
  /* a cup round in the demo too, so the knockout block can be seen without a key */
  const cup = [];
  for (let i = 0; i < 4; i++) {
    const home = teams[i * 2], away = teams[i * 2 + 1];
    const d = new Date(base.getTime() + 10 * 86400000);
    cup.push({
      id: "C" + i, date: d.toISOString().slice(0, 10), time: "19:00", round: "", day: 2,
      competition: "Pokal", phase: "cup", roundName: "Achtelfinale",
      homeId: home.id, home: home.name, awayId: away.id, away: away.name,
      hs: 80 + i * 3, as: 74 + i * 5, status: "final", venue: ""
    });
  }
  return { teams, standings, games: games.concat(cup), cup: cup, euro: [], four };
}

/* ---------- handler ---------- */
exports.handler = async (event) => {
  CALL_T0 = Date.now();
  const q = (event && event.queryStringParameters) || {};
  const res = S(q.res || "all");
  const fresh = q.fresh === "1";
  const key = env("BBL_API_KEY", "");
  const askSeason = S(env("BBL_SEASON", "") || q.season || "");

  if (!key) {
    const d = demoPayload();
    return reply(200, Object.assign({ ok: true, demo: true, season: askSeason, updated: new Date().toISOString(), source: "demo" }, d), 0);
  }

  try {
    const sea = await resolveSeason(askSeason, key);
    const season = sea.season;
    /* the caller's data version is part of the key, so a deploy that changes the shape
       of what this returns cannot be answered out of a cache filled by the old shape */
    const ck = res + "|" + season + "|" + S(q.id) + "|v" + S(q.v || "0");
    const ttl = TTL[res] || TTL.all;
    if (!fresh) { const hit = getCache(ck, ttl); if (hit) return reply(200, Object.assign({}, hit, { cached: true }), ttl); }

    const meta = { ok: true, demo: false, season: season, seasonAsked: sea.asked, seasonActive: sea.active, updated: new Date().toISOString(), source: apiBase(), errors: [] };
    let out;

    if (res === "img") {
      /* A browser cannot put the API key on an <img>, and everything else on this host
         needs it - which is why the crests stopped arriving the moment they were asked for
         directly. So the image comes through here instead: fetched server side with the
         key, handed back with its own content type and cached for a day. It also sidesteps
         CORS, and it means the client does not need to know which of the candidate paths
         is the right one. */
      const kind = S(q.kind) === "player" ? "player" : "team";
      const id = S(q.id);
      if (!id) return { statusCode: 400, headers: { "content-type": "text/plain" }, body: "need id" };
      const tried = [];
      for (const path of imgPaths(kind, season, id)) {
        try {
          const r = await fetch(apiBase() + path, { headers: { "X-API-Key": key } });
          const ct = S(r.headers.get("content-type"));
          tried.push(path + " -> " + r.status + " " + ct);
          if (!r.ok || !/^image\//i.test(ct)) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          if (!buf.length) continue;
          return { statusCode: 200, isBase64Encoded: true, body: buf.toString("base64"),
                   headers: { "content-type": ct, "cache-control": "public, max-age=86400",
                              "access-control-allow-origin": "*" } };
        } catch (e) { tried.push(path + " -> " + e.message); }
      }
      /* nothing there: say so briefly, and let the browser remember that for a while so a
         roster of twelve does not ask twelve times on every render */
      return { statusCode: 404, headers: { "content-type": "text/plain",
               "cache-control": "public, max-age=1800", "x-tried": tried.join(" | ").slice(0, 400) },
               body: "no image" };

    } else if (res === "probe") {
      /* What the roster rows actually look like. Field names only, plus any string that
         could be an image, so the question "does the feed carry a portrait" can be
         answered by opening a URL instead of by guessing in code. */
      let id = S(q.id);
      if (!id) {
        /* no club given: use ours, so the probe is one URL with nothing to look up */
        const tl = await api("/v2/teams/" + season + "?competition=BBL", key).catch(() => null);
        const mine = (Array.isArray(tl) ? tl : []).filter(t => /l(ö|oe)wen|braunschweig/i.test(S(t.name)))[0];
        id = S(mine && mine.id) || S((Array.isArray(tl) && tl[0] && tl[0].id) || "");
        meta.probedTeam = S(mine && mine.name) || "";
      }
      if (!id) return reply(400, { ok: false, errors: ["res=probe found no club to read"] }, 0);
      const raw = await api("/v2/teamStats/" + id + "/" + season + "/roster?competition=BBL", key)
        .catch(e => ({ _error: e.message }));
      if (raw && raw._error) return reply(502, Object.assign(meta, { ok: false, errors: [raw._error] }), 0);
      const rows = (raw && raw.roster) || [];
      const keysOf = (o, pre) => { const out = [];
        Object.keys(o || {}).forEach(k => {
          const v = o[k];
          if (v && typeof v === "object" && !Array.isArray(v)) out.push.apply(out, keysOf(v, pre + k + "."));
          else out.push(pre + k + " = " + (typeof v === "string" ? v.slice(0, 90) : JSON.stringify(v)));
        });
        return out; };
      /* and actually ask the image host, with the key, so the answer is a status code
         and a content type rather than a theory */
      const first = rows[0] || {};
      const fp = first.player || first;
      const pid = S(fp.id || fp.playerId || first.playerId || first.id);
      const check = async (kind, who) => {
        const outp = [];
        for (const path of imgPaths(kind, season, who)) {
          try {
            const r = await fetch(apiBase() + path, { headers: { "X-API-Key": key } });
            outp.push({ path: path, status: r.status, type: S(r.headers.get("content-type")),
                        bytes: S(r.headers.get("content-length")) });
          } catch (e) { outp.push({ path: path, error: e.message }); }
        }
        return outp;
      };
      out = Object.assign(meta, {
        teamId: id, playerId: pid,
        rows: rows.length,
        sample: rows.length ? keysOf(rows[0], "") : [],
        imageLike: rows.length ? deepImages(rows[0]) : [],
        teamImage: await check("team", id),
        playerImage: pid ? await check("player", pid) : []
      });
      out.ok = true;

    } else if (res === "roster") {
      /* The roster, and only the roster: ONE request upstream, no game sheets, no budget,
         nothing progressive, nothing that can come back half done.

         Everything a scouting card states as fact - who is on the squad, his number, his
         position, where he is from, how tall and how heavy, how old, how many games he has
         played and started, his minutes, and his whole season box score - is in this one
         call, because the league publishes its own season totals on the roster row. The
         game sheets add what only they can add: the shot chart, who plays with whom, the
         late clock. Those are worth waiting for. A card is not, and it should never have
         been behind them: a club whose sheets will not read had no cards at all, which is
         the opposite of the point.

         So the cards are built from here, in a few hundred milliseconds, for any club in
         the league, whatever the reader is doing. */
      const id = S(q.id);
      if (!id) return reply(400, { ok: false, errors: ["res=roster needs &id=<teamId>"] }, 0);
      const [club, rosterRaw] = await Promise.all([
        api("/v2/team/" + id + "/" + season, key).catch(e => ({ _error: e.message })),
        api("/v2/teamStats/" + id + "/" + season + "/roster?competition=BBL", key).catch(e => ({ _error: e.message }))
      ]);
      if (rosterRaw && rosterRaw._error) meta.errors.push("roster: " + rosterRaw._error);
      const idx = rosterIndex((rosterRaw && !rosterRaw._error && rosterRaw.roster) || []);
      const seen = Object.create(null);
      const list = [];
      Object.keys(idx).forEach(k => {
        if (k.indexOf("id:") !== 0) return;
        const w = idx[k], pid = k.slice(3);
        /* the index files a man under every id the feed gives him - his roster id and his
           player id - so the same player arrives twice here; his shirt and his name are
           what make him one person */
        const tag = S(w.num) + "|" + S(w.name).toLowerCase();
        if (seen[tag]) return;
        seen[tag] = 1;
        list.push({ id: pid, pid: S(w.pid || pid), num: S(w.num), name: S(w.name),
                    first: S(w.first), last: S(w.last), photo: w.photo || [],
                    pos: S(w.pos), height: S(w.height), weight: S(w.weight),
                    nat: S(w.nat), born: S(w.born), off: w.off || null });
      });
      list.sort((a, b) => (num(a.num) || 99) - (num(b.num) || 99) || a.name.localeCompare(b.name));
      out = Object.assign(meta, { teamId: id, team: (club && !club._error && club.name) || "",
                                  players: list, count: list.length });
      out.ok = list.length > 0;
      if (!out.ok && !meta.errors.length) meta.errors.push("the league returned no roster for this club");

    } else if (res === "seasons") {
      out = Object.assign(meta, { available: sea.available, active: sea.active });

    } else if (res === "game") {
      const id = S(q.id);
      if (!id) return reply(400, { ok: false, errors: ["res=game needs &id=<gameId>"] }, 0);
      const [sheet, feed] = await Promise.all([
        api("/v2/game/" + encodeURIComponent(id), key).catch(e => ({ _error: e.message })),
        api("/v2/gameStats/" + encodeURIComponent(id), key).catch(e => ({ _error: e.message }))
      ]);
      if (sheet && sheet._error) meta.errors.push("game: " + sheet._error);
      if (feed && feed._error) meta.errors.push("gameStats: " + feed._error);
      out = Object.assign(meta, {
        game: (sheet && !sheet._error) ? sheet : null,
        feed: (feed && !feed._error) ? decodeFeed(feed) : null
      });

    } else if (res === "team") {
      const id = S(q.id);
      if (!id) return reply(400, { ok: false, errors: ["res=team needs &id=<teamId>"] }, 0);
      const [club, roster, stats, sched] = await Promise.all([
        api("/v2/team/" + id + "/" + season, key).catch(e => ({ _error: e.message })),
        api("/v2/teamStats/" + id + "/" + season + "/roster?competition=BBL", key).catch(e => ({ _error: e.message })),
        api("/v2/teamStats/" + id + "/" + season + "?competition=BBL", key).catch(e => ({ _error: e.message })),
        api("/v2/schedule?seasonId=" + season + "&teamId=" + id, key).catch(e => ({ _error: e.message }))
      ]);
      [["team", club], ["roster", roster], ["teamStats", stats], ["schedule", sched]].forEach(([n, v]) => { if (v && v._error) meta.errors.push(n + ": " + v._error); });
      out = Object.assign(meta, {
        team: (club && !club._error) ? club : null,
        roster: (roster && !roster._error && roster.roster) ? roster.roster : [],
        four: (stats && !stats._error) ? fourFactors({ id: id, name: (club && club.name) || "", tlc: (club && club.TLC) || "" }, stats, ["MAIN_ROUND", "SEASON"]) : null,
        games: Array.isArray(sched) ? sched.map(normGame) : []
      });

    } else if (res === "players") {
      const id = S(q.id);
      if (!id) return reply(400, { ok: false, errors: ["res=players needs &id=<teamId>"] }, 0);
      const [club, rosterRaw, schedRaw] = await Promise.all([
        api("/v2/team/" + id + "/" + season, key).catch(e => ({ _error: e.message })),
        api("/v2/teamStats/" + id + "/" + season + "/roster?competition=BBL", key).catch(e => ({ _error: e.message })),
        api("/v2/schedule?seasonId=" + season + "&teamId=" + id, key).catch(e => ({ _error: e.message }))
      ]);
      [["team", club], ["roster", rosterRaw], ["schedule", schedRaw]].forEach(p => { if (p[1] && p[1]._error) meta.errors.push(p[0] + ": " + p[1]._error); });

      const who = rosterIndex((rosterRaw && !rosterRaw._error && rosterRaw.roster) || []);
      const rosterHas = Object.keys(who).some(k => k.indexOf("id:") === 0);
      const played = (Array.isArray(schedRaw) ? schedRaw.map(normGame) : [])
        .filter(g => g.phase === "main" && g.hs != null && g.as != null)
        .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

      const checks = { games: 0, feeds: 0, flipped: 0, actions: 0, sixth: 0, subOrphan: 0, noSubs: 0,
                       floorSec: 0, gameSec: 0, ptsBox: 0, ptsPoss: 0, codeRoster: 0, foreign: 0 };
      const agg = Object.create(null);
      const tm = { all: blankTeam(), home: blankTeam(), away: blankTeam() };
      const op = { all: blankTeam(), home: blankTeam(), away: blankTeam() };
      const shots = [], rot = [], byGame = [];
      const blk3 = () => [0, 1, 2].map(() => ({ poss: 0, pts: 0, fga: 0, fgm: 0, p3a: 0, p3m: 0, fta: 0, ftm: 0, fd: 0, tov: 0 }));
      const clk = { team: blk3(), opp: blk3(), byPlayer: Object.create(null),
                    q2: Object.create(null), cl: Object.create(null),
                    tq2: lateLine(), tcl: lateLine() };
      const tmQ = [blankTeam(), blankTeam(), blankTeam(), blankTeam()];
      const opQ = [blankTeam(), blankTeam(), blankTeam(), blankTeam()];
      const units = Object.create(null);     /* key -> unit totals */
      const onoff = Object.create(null);

      const want = played.slice(-40);
      const read = await readFeeds(want, key, readBudget(),
        (g, e) => { if (meta.errors.length < 4) meta.errors.push("game " + g.id + ": " + e.message); });

      read.got.forEach(fx => {
        const g = fx.g, acts = fx.acts;
        if (!acts.length) return;
        markNonPlayers(acts);
        checks.feeds++; checks.actions += acts.length;
        const home = (g.homeId === id);
        const ourPts = home ? g.hs : g.as;
        /* Which side of the sheet we are. It used to be decided by the running score on
           the LAST action, and the last action is not always a basket - a substitution or a
           timeout carries whatever those fields happened to hold - so a game now and then
           went to the wrong side and the other club's players were merged into this roster.
           That is what a scouting report with two teams in one table looks like.

           Three rules, in order of how much they can be trusted: the highest running score
           on each side against our own final score; then, if those are equidistant, how many
           actions on each side are signed by a player this club has on its roster; then home
           and away. */
        /* the running score is monotonic, so its maximum is the final score however stale
           the fields on the last action happen to be */
        let maxA = 0, maxB = 0;
        acts.forEach(a => { const x = num(a.points1) || 0, y = num(a.points2) || 0;
          if (x > maxA) maxA = x; if (y > maxB) maxB = y; });
        const dA = Math.abs(maxA - ourPts), dB = Math.abs(maxB - ourPts);
        let code = null;
        if (dA !== dB) code = dA < dB ? "A" : "B";
        /* a tie means the score cannot tell them apart - our own roster can */
        if (!code && rosterHas) {
          const hit = { A: 0, B: 0 };
          acts.forEach(a => {
            const c = S(a.teamcode); if (c !== "A" && c !== "B") return;
            const p = S(a.player_id1); if (!p) return;
            if (who["id:" + p]) hit[c]++;
          });
          if (hit.A !== hit.B) { code = hit.A > hit.B ? "A" : "B"; checks.codeRoster++; }
        }
        if (!code) code = home ? "A" : "B";
        const foe = code === "A" ? "B" : "A";
        if (code !== (home ? "A" : "B")) checks.flipped++;
        checks.games++;

        /* ---- box score, ours and theirs ---- */
        const mineBox = boxFromActions(acts, code), foeBox = boxFromActions(acts, foe);
        const qOf = a => qIndex(a.quarter);
        const perQ = Object.create(null);
        acts.forEach(a => {
          if (S(a.teamcode) !== code) return;
          const p = S(a.player_id1); if (!p) return;
          const k = p + "|" + qOf(a);
          if (!perQ[k]) perQ[k] = blank();
        });
        Object.keys(mineBox).forEach(pid => {
          const r = mineBox[pid];
          const slot = agg[pid] || (agg[pid] = { id: pid, num: r.num, name: "",
            all: blank(), home: blank(), away: blank(), q: [blank(), blank(), blank(), blank()] });
          const w = who["id:" + pid] || who["no:" + r.num];
          if (w && w.name && !slot.name) { slot.name = w.name; if (w.num) slot.num = w.num; }
          if (!slot.num) slot.num = r.num;
          mergeInto(slot.all, r.t); mergeInto(home ? slot.home : slot.away, r.t);
          slot.all.gp++; (home ? slot.home : slot.away).gp++;
        });
        /* per quarter, from the same events — for the players and for both teams, so
           the four factors can be split by quarter too */
        [0, 1, 2, 3].forEach(qi => {
          const sub = acts.filter(a => qIndex(a.quarter) === qi);
          if (!sub.length) return;
          const bq = boxFromActions(sub, code);
          Object.keys(bq).forEach(pid => {
            const slot = agg[pid]; if (!slot) return;
            mergeInto(slot.q[qi], bq[pid].t);
          });
          teamFromBox(tmQ[qi], bq);
          teamFromBox(opQ[qi], boxFromActions(sub, foe));
        });
        teamFromBox(tm.all, mineBox); teamFromBox(home ? tm.home : tm.away, mineBox);
        teamFromBox(op.all, foeBox); teamFromBox(home ? op.home : op.away, foeBox);

        /* AND THE SAME NUMBERS, GAME BY GAME.
           Every feed is already read and every box already built; the only thing missing
           was keeping them apart instead of adding them all into one season. The four
           factors and the shooting of one night, ours and theirs, are these eight fields
           and nothing else, so one line per game is the whole cost of a trend. */
        const perGameUs = blankTeam(), perGameThem = blankTeam();
        teamFromBox(perGameUs, mineBox); teamFromBox(perGameThem, foeBox);
        byGame.push({ id: g.id, date: g.date, round: g.round,
          home: home ? 1 : 0,
          opp: home ? (g.away || "") : (g.home || ""),
          hs: g.hs, as: g.as,
          us: perGameUs, them: perGameThem });

        acts.forEach(a => {
          if (S(a.teamcode) !== code) return;
          if ((a.action === "P2" || a.action === "P3") && (num(a.x) || num(a.y))) {
            shots.push([S(a.player_id1), S(a.result) === "+" ? 1 : 0, a.action === "P3" ? 1 : 0,
                        num(a.x), num(a.y), home ? 1 : 0, qOf(a)]);
          }
        });

        /* ---- who was on the floor ---- */
        const us = onCourtTimeline(acts, code, checks);
        const them = onCourtTimeline(acts, foe, checks);
        if (!acts.some(a => a.action === "SUBST" && S(a.teamcode) === code)) checks.noSubs++;
        /* Minutes come from the spans, which is the only place they exist. A player who
           was on the floor but never touched the ball has no box score line, so the
           spans also create him — otherwise he vanishes from the roster and the team's
           minutes do not add up to five times the game. */
        us.spans.forEach(sp => {
          const slot = agg[sp.id] || (agg[sp.id] = { id: sp.id, num: "", name: "",
            all: blank(), home: blank(), away: blank(), q: [blank(), blank(), blank(), blank()] });
          if (!slot.name) { const w = who["id:" + sp.id]; if (w && w.name) { slot.name = w.name; if (w.num) slot.num = w.num; } }
          const d = sp.to - sp.from;
          slot.all.sec += d; (home ? slot.home : slot.away).sec += d;
        });
        rot.push({ id: g.id, date: g.date, home: home, opp: home ? g.away : g.home,
                   end: us.end, spans: us.spans });

        /* ---- possessions, and what each unit did with them ---- */
        const poss = possessions(acts);
        const cs = clockSplit(acts, poss, code);
        const addBlk = (dst, src) => { [0, 1, 2].forEach(i => {
          Object.keys(src[i]).forEach(k => { dst[i][k] += src[i][k]; }); }); };
        addBlk(clk.team, cs.team); addBlk(clk.opp, cs.opp);
        Object.keys(cs.byPlayer).forEach(pid => {
          if (!clk.byPlayer[pid]) clk.byPlayer[pid] = [0, 1, 2].map(() => ({ poss: 0, pts: 0, fga: 0, fgm: 0, p3a: 0, p3m: 0, fta: 0, ftm: 0, fd: 0, tov: 0 }));
          addBlk(clk.byPlayer[pid], cs.byPlayer[pid]);
        });
        const lg2 = lateGame(acts, code);
        const addLine = (dst, src) => { Object.keys(src).forEach(k => { dst[k] += src[k]; }); };
        ["q2", "cl"].forEach(w => {
          Object.keys(lg2[w]).forEach(pid => {
            if (!clk[w][pid]) clk[w][pid] = lateLine();
            addLine(clk[w][pid], lg2[w][pid]);
          });
        });
        addLine(clk.tq2, lg2.tq2); addLine(clk.tcl, lg2.tcl);
        poss.forEach(p => {
          const mid = (p.from + p.to) / 2;
          const five = onAt(us.spans, mid);
          if (five.length < 2) return;
          const ours = (p.team === code);
          const keys = unitKeys(five);
          keys.forEach(k => {
            const u = units[k] || (units[k] = { k: k, n: five.length, offPoss: 0, offPts: 0, defPoss: 0, defPts: 0,
                                                hOffPoss: 0, hOffPts: 0, hDefPoss: 0, hDefPts: 0 });
            if (ours) { u.offPoss++; u.offPts += p.pts; if (home) { u.hOffPoss++; u.hOffPts += p.pts; } }
            else { u.defPoss++; u.defPts += p.pts; if (home) { u.hDefPoss++; u.hDefPts += p.pts; } }
          });
          five.forEach(pid => {
            const o = onoff[pid] || (onoff[pid] = { id: pid, onOff: 0, onOffPts: 0, onDef: 0, onDefPts: 0,
                                                   offOff: 0, offOffPts: 0, offDef: 0, offDefPts: 0,
                                                   hOnOff: 0, hOnOffPts: 0, hOnDef: 0, hOnDefPts: 0,
                                                   hOffOff: 0, hOffOffPts: 0, hOffDef: 0, hOffDefPts: 0 });
            if (ours) { o.onOff++; o.onOffPts += p.pts; if (home) { o.hOnOff++; o.hOnOffPts += p.pts; } }
            else { o.onDef++; o.onDefPts += p.pts; if (home) { o.hOnDef++; o.hOnDefPts += p.pts; } }
            /* plus-minus. The feed has no such field - the column read 0.0 for everybody -
               but with correct spans and correct possession points it is just the margin
               while he was on the floor, which is what the number means. */
            const sl = agg[pid];
            if (sl) { const dd = ours ? p.pts : -p.pts;
              sl.all.pm += dd; (home ? sl.home : sl.away).pm += dd;
              const qi2 = Math.min(3, qIndex(p.quarter));
              if (sl.q[qi2]) sl.q[qi2].pm += dd; }
          });
          Object.keys(agg).forEach(pid => {
            if (five.indexOf(pid) >= 0) return;
            const o = onoff[pid]; if (!o) return;
            if (ours) { o.offOff++; o.offOffPts += p.pts; if (home) { o.hOffOff++; o.hOffOffPts += p.pts; } }
            else { o.offDef++; o.offDefPts += p.pts; if (home) { o.hOffDef++; o.hOffDefPts += p.pts; } }
          });
        });
      });

      /* the rotation chart wants the MOST RECENT games, and the sheets come back in
         whatever order the cache and the network settle on, so sort by date and keep the
         tail. Keeping the first six was keeping September in January. */
      rot.sort((a, b) => S(a.date).localeCompare(S(b.date)));
      rot.splice(0, Math.max(0, rot.length - 6));

      const players = Object.keys(agg).map(k => agg[k]).filter(p => p.all.gp > 0 || p.all.sec > 0)
        .sort((a, b) => (b.all.pts / (b.all.gp || 1)) - (a.all.pts / (a.all.gp || 1)));
      /* one last pass for anyone the id join missed: the shirt number is enough */
      players.forEach(p => {
        if (p.name) return;
        const w = who["no:" + S(p.num)];
        if (w && w.name) { p.name = w.name; p.first = w.first; p.last = w.last; }
      });
      /* The game sheets are read a few at a time and may not be in yet, but the roster is
         there from the first call. Anyone on it who has no line from the sheets is added
         with the league's own season numbers, so the scouting cards and the passport are
         available immediately; his box score fills in as the sheets arrive. */
      const seen = Object.create(null);
      players.forEach(p => { seen[S(p.id)] = 1; if (p.num) seen["no:" + S(p.num)] = 1; });
      Object.keys(who).forEach(k => {
        if (k.indexOf("id:") !== 0) return;
        const w = who[k];
        const idk = k.slice(3);
        if (seen[idk] || (w.num && seen["no:" + S(w.num)])) return;
        if (!w.off || !w.off.gp) return;
        seen[idk] = 1; if (w.num) seen["no:" + S(w.num)] = 1;
        players.push({ id: idk, num: S(w.num), name: w.name, first: w.first, last: w.last,
          all: blank(), home: blank(), away: blank(), q: [blank(), blank(), blank(), blank()],
          rosterOnly: true });
      });
      const name = {};
      players.forEach(p => {
        const w = who["id:" + p.id] || who["no:" + S(p.num)] || {};
        p.first = p.first || w.first || ""; p.last = p.last || w.last || "";
        p.photo = (p.photo && p.photo.length) ? p.photo : (w.photo || []);
        p.pid = w.pid || "";
        p.pos = w.pos || ""; p.height = w.height || ""; p.weight = w.weight || "";
        p.nat = w.nat || ""; p.born = w.born || "";
        p.off = w.off || null;
        name[p.id] = { n: p.num || "", name: p.name || "", first: p.first, last: p.last,
                       photo: p.photo, pid: p.pid };
      });
      const unitRows = Object.keys(units).map(k => {
        const u = units[k];
        const ids = k.split("|");
        return { ids: ids, n: ids.length,
                 offPoss: u.offPoss, offPts: u.offPts, defPoss: u.defPoss, defPts: u.defPts,
                 hOffPoss: u.hOffPoss, hOffPts: u.hOffPts, hDefPoss: u.hDefPoss, hDefPts: u.hDefPts,
                 oer: u.offPoss ? 100 * u.offPts / u.offPoss : null,
                 der: u.defPoss ? 100 * u.defPts / u.defPoss : null,
                 net: (u.offPoss && u.defPoss) ? (100 * u.offPts / u.offPoss) - (100 * u.defPts / u.defPoss) : null };
      }).filter(u => u.offPoss + u.defPoss >= 4);
      const onoffRows = Object.keys(onoff).map(k => {
        const o = onoff[k];
        const r = (a, b) => a ? 100 * b / a : null;
        const on = (o.onOff && o.onDef) ? r(o.onOff, o.onOffPts) - r(o.onDef, o.onDefPts) : null;
        const off = (o.offOff && o.offDef) ? r(o.offOff, o.offOffPts) - r(o.offDef, o.offDefPts) : null;
        return { id: o.id, onPoss: o.onOff + o.onDef, offPoss: o.offOff + o.offDef,
                 onOer: r(o.onOff, o.onOffPts), onDer: r(o.onDef, o.onDefPts), onNet: on,
                 offOer: r(o.offOff, o.offOffPts), offDer: r(o.offDef, o.offDefPts), offNet: off,
                 raw: { onOff: o.onOff, onOffPts: o.onOffPts, onDef: o.onDef, onDefPts: o.onDefPts,
                        offOff: o.offOff, offOffPts: o.offOffPts, offDef: o.offDef, offDefPts: o.offDefPts,
                        hOnOff: o.hOnOff, hOnOffPts: o.hOnOffPts, hOnDef: o.hOnDef, hOnDefPts: o.hOnDefPts,
                        hOffOff: o.hOffOff, hOffOffPts: o.hOffOffPts, hOffDef: o.hOffDef, hOffDefPts: o.hOffDefPts },
                 diff: (on != null && off != null) ? on - off : null };
      }).filter(o => o.onPoss > 0);

      out = Object.assign(meta, {
        teamId: id, team: (club && !club._error && club.name) || "",
        players: players, team_tot: tm, opp_tot: op, team_q: tmQ, opp_q: opQ, shots: shots,
        names: name, rot: rot, units: unitRows, onoff: onoffRows, clock: clk,
        /* one line per game, ours and theirs, in date order — the four factors and the
           shooting of a season are already here; this is the same thing not added up */
        by_game: byGame.slice().sort(function (a, b) {
          return S(a.date).localeCompare(S(b.date)); }),
        games: played.length, checks: checks,
        /* partial means "there is more to fetch, ask again". A sheet the league will not
           give us is reported as failed and does not keep the client asking. */
        total: want.length, read: read.got.length, pending: read.pending,
        failed: read.failed || 0, partial: read.pending > 0
      });
      out.ok = players.length > 0;
      if (!out.ok && !meta.errors.length) {
        meta.errors.push(played.length
          ? ("read " + checks.feeds + " of " + played.length + " sheets, " + checks.actions + " actions, no player could be built")
          : "no finished league game in the schedule yet");
      }

    } else if (res === "pbpall") {
      /* What the season totals cannot give: how possessions end, and the four factors
         quarter by quarter. Both need the events. Fetching per club would read every
         game twice; fetching per GAME reads each once and fills both clubs from it, so
         the cost grows with matchdays played and not with the size of the league. */
      const teamsRaw = await api("/v2/teams/" + season + "?competition=BBL", key).catch(e => ({ _error: e.message }));
      const teams = Array.isArray(teamsRaw) ? teamsRaw.map(normTeam) : [];
      const sched = await batched(teams, 4, 220, async (t) => {
        try { return await api("/v2/schedule?seasonId=" + season + "&teamId=" + t.id, key); }
        catch (e) { return null; }
      });
      const byId = Object.create(null);
      sched.forEach(rows => (Array.isArray(rows) ? rows : []).forEach(r => {
        const g = normGame(r);
        if (g.id && g.phase === "main" && g.hs != null) byId[g.id] = g;
      }));
      const list = Object.keys(byId).map(k => byId[k])
        .sort((a, b) => (a.date || "").localeCompare(b.date || "")).slice(-Number(q.max || 80));

      /* The league's shots on a coarse grid, so a club's chart can be coloured against
         what the league actually does from that spot rather than against a round number.
         Twenty feed units is about a metre; anything finer is one shot per cell. */
      const GRID = 20;
      const league = Object.create(null);
      const cellOf = (x, y) => (Math.floor(x / GRID) * GRID) + "," + (Math.floor(y / GRID) * GRID);
      const bucket = {};   /* teamId -> { off:[0,0,0,0], def:[...], q:[{tm,op}x4] } */
      const slot = tid => bucket[tid] || (bucket[tid] = { off: [0, 0, 0, 0], def: [0, 0, 0, 0],
        q: [0, 1, 2, 3].map(() => ({ tm: blankTeam(), op: blankTeam() })),
        hm: { tm: blankTeam(), op: blankTeam() }, aw: { tm: blankTeam(), op: blankTeam() } });
      const done = await readFeeds(list, key, readBudget(),
        (g, e) => { if (meta.errors.length < 4) meta.errors.push("game " + g.id + ": " + e.message); });
      let read = 0;
      done.got.forEach(fx => {
        const g = fx.g, acts = fx.acts;
        if (!acts.length) return;
        markNonPlayers(acts);
        read++;
        const last = acts[acts.length - 1];
        const eA = num(last.points1) || 0, eB = num(last.points2) || 0;
        const homeIsA = Math.abs(eA - g.hs) <= Math.abs(eB - g.hs);
        const sideOf = c => (c === "A") === homeIsA ? g.homeId : g.awayId;
        possessions(acts).forEach(p => {
          const tid = sideOf(p.team), other = tid === g.homeId ? g.awayId : g.homeId;
          const b = Math.max(0, Math.min(3, p.pts));
          if (tid) slot(tid).off[b]++;
          if (other) slot(other).def[b]++;
        });
        acts.forEach(a => {
          if (a.action !== "P2" && a.action !== "P3") return;
          const x = num(a.x), y = num(a.y);
          if (x == null || y == null || (!x && !y)) return;
          const k = cellOf(x, y);
          const e = league[k] || (league[k] = [0, 0]);
          e[1]++; if (S(a.result) === "+") e[0]++;
        });
        [0, 1, 2, 3].forEach(qi => {
          const sub = acts.filter(a => qIndex(a.quarter) === qi);
          if (!sub.length) return;
          ["A", "B"].forEach(c => {
            const tid = sideOf(c), other = tid === g.homeId ? g.awayId : g.homeId;
            if (!tid) return;
            const box = boxFromActions(sub, c);
            teamFromBox(slot(tid).q[qi].tm, box);
            if (other) teamFromBox(slot(other).q[qi].op, box);
          });
        });
        /* the same boxes for the whole game, kept apart by where it was played, so the
           four factors and the shooting can be read home, away or both */
        ["A", "B"].forEach(c => {
          const tid = sideOf(c), other = tid === g.homeId ? g.awayId : g.homeId;
          if (!tid) return;
          const box = boxFromActions(acts, c);
          const side = (tid === g.homeId) ? "hm" : "aw";
          teamFromBox(slot(tid)[side].tm, box);
          if (other) teamFromBox(slot(other)[(other === g.homeId) ? "hm" : "aw"].op, box);
        });
      });
      out = Object.assign(meta, { teams: teams, games: list.length, read: read, dist: bucket,
                                   grid: GRID, league: league,
                                   pending: done.pending, failed: done.failed || 0,
                                   partial: done.pending > 0 });
      out.ok = read > 0;
      if (!out.ok) meta.errors.push("no game sheet could be read");

    } else if (res === "four") {
      const want = S(q.round || "").toUpperCase() === "SEASON" ? ["SEASON", "MAIN_ROUND"] : ["MAIN_ROUND", "SEASON"];
      const teamsRaw = await api("/v2/teams/" + season + "?competition=BBL", key);
      const teams = (Array.isArray(teamsRaw) ? teamsRaw : []).map(normTeam);
      const rows = await batched(teams, 4, 220, async (t) => {
        try { return fourFactors(t, await api("/v2/teamStats/" + t.id + "/" + season + "?competition=BBL", key), want); }
        catch (e) { meta.errors.push(t.short + ": " + e.message); return null; }
      });
      out = Object.assign(meta, { teams: teams, four: rows.filter(Boolean) });
      out.ok = out.four.length > 0;

    } else {
      /* res=all — the dashboard */
      const euroUrl = env("BBL_EURO_URL", "");
      const jobs = [
        api("/v2/teams/" + season + "?competition=BBL", key).catch(e => ({ _error: "teams: " + e.message })),
        api("/v2/standings/?season=" + season, key).catch(e => ({ _error: "standings: " + e.message })),
        api("/v2/schedule?seasonId=" + season, key).catch(e => ({ _error: "schedule: " + e.message }))
      ];
      if (euroUrl) jobs.push(fetch(euroUrl.replace(/\{season\}/g, encodeURIComponent(season)), { headers: { accept: "application/json" } })
        .then(r => r.json()).catch(e => ({ _error: "euro: " + e.message })));
      const [teamsRaw, standRaw, schedRaw, euroRaw] = await Promise.all(jobs);
      [teamsRaw, standRaw, schedRaw, euroRaw].forEach(v => { if (v && v._error) meta.errors.push(v._error); });

      /* The league-wide schedule comes back truncated: on 2 October it held 169 of the
         306 league games, with rounds 1 and 2 missing entirely and several rounds short
         of their nine. Every game that is missing is a result that never reaches the
         table, a matchday that starts at three instead of one, and a form strip with
         holes in it. The per-club schedules are complete, so the season is assembled
         from those and the league-wide answer is only used to fill anything they miss.
         Eighteen calls, four at a time, cached like everything else. */
      const teamList = Array.isArray(teamsRaw) ? teamsRaw.map(normTeam) : [];
      const perTeam = await batched(teamList, 4, 220, async (t) => {
        try { return await api("/v2/schedule?seasonId=" + season + "&teamId=" + t.id, key); }
        catch (e) { meta.errors.push("schedule " + t.short + ": " + e.message); return null; }
      });
      const byId = Object.create(null);
      const take = rows => { (Array.isArray(rows) ? rows : []).forEach(r => {
        const g = normGame(r);
        if (!g.id) return;
        const had = byId[g.id];
        /* a sheet that knows the result wins over one that does not */
        if (!had || (g.hs != null && had.hs == null)) byId[g.id] = g;
      }); };
      perTeam.forEach(take);
      const beforeFill = Object.keys(byId).length;
      take(schedRaw);
      const all = Object.keys(byId).map(k => byId[k])
        .sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || ""));
      meta.schedule = { fromTeams: beforeFill, total: all.length,
                        leagueWide: Array.isArray(schedRaw) ? schedRaw.length : 0 };
      out = Object.assign(meta, {
        teams: teamList,
        standings: Array.isArray(standRaw) ? standRaw.map(normStanding) : [],
        games: all,
        cup: all.filter(g => g.competition !== "BBL"),
        euro: Array.isArray(euroRaw) ? euroRaw.map(g => Object.assign(normGame(g), { competition: S(g.competition || "EURO") })) : []
      });
      if (!out.teams.length && out.standings.length) {
        out.teams = out.standings.map(r => ({ id: r.teamId, name: r.team, short: r.team.slice(0, 16), tlc: r.tlc, logo: "" }));
      }
      out.ok = !!(out.teams.length || out.games.length || out.standings.length);
    }

    /* a partial answer is a staging post, not the answer: caching it would freeze the
       view at whatever the first call managed to read */
    if (out.ok && !out.partial) setCache(ck, out);
    return reply(out.ok ? 200 : 502, out, out.ok ? ttl : 0);

  } catch (e) {
    return reply(502, { ok: false, demo: false, updated: new Date().toISOString(), errors: [(e && e.message) || String(e)] }, 0);
  }
};

function reply(code, body, ttl) {
  const secs = Math.max(0, Math.round((ttl || 0) / 1000));
  return {
    statusCode: code,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": secs ? ("public, max-age=" + Math.min(secs, 600) + ", s-maxage=" + secs) : "no-store"
    },
    body: JSON.stringify(body)
  };
}

/* exported for the offline checks in /tmp — no effect at runtime */
module.exports._t = { normTeam, normStanding, normGame, fourFactors, decodeFeed, mapRow, pack, rosterIndex, whenParts, berlinOffsetMin };
