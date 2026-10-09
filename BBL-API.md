# BBL Backend API v2 — how the hub talks to the league

## The key

The key is **not** in `index.html`. That file is downloaded whole by every browser that
opens the site, so anything in it is public. The key lives in Netlify and only
`netlify/functions/bbl.js` ever sees it.

Netlify → **Project configuration → Environment variables** (older accounts still say
*Site configuration*) → **Add a variable**:

| Variable | Value |
|---|---|
| `BBL_API_KEY` | the key the BBL gave us |
| `BBL_API_BASE` | optional · `https://api.basketball-bundesliga.de` (default). The test host is `https://api.bbl.scb.world` |
| `BBL_SEASON` | optional · forces a season, otherwise the app asks and the API decides |
| `BBL_EURO_URL` | optional · any URL returning JSON with European games |

Netlify only picks up a new variable **on a deploy**, and its own documentation is explicit
about it. So the order matters: **set the variable first, then upload the new build.** Doing it
the other way round leaves the site running without the key until the next upload.

Without the key the function serves clearly marked demo data, so the screen can be
checked before the key exists.

## The league view refreshes itself

It used to refresh only when somebody pressed Sync, so reloading the page showed whatever
was last saved in the browser — a table a day old with yesterday's games missing, and
nothing on screen saying so. It now syncs by itself when what is stored is more than ten
minutes old, and the header says how old the data is rather than when it was taken.

The league also publishes its standings and its results from different places, and the
table can sit a day behind the games. The two are counted against each other and the gap
is named: *"the league's table is behind its own results: X, Y have played games not
counted here yet."* A club or two behind is lag and worth saying; half the league behind
means the two sources count different things, which is not lag, so that case says nothing
rather than warning on every row.

## Treat the production host carefully

The league's note: the production host is rate limited and watched by a behaviour
filter, and abuse gets a 24 h ban. So every answer is cached — ten minutes for the
dashboard, six hours for the per-club stats — and the eighteen club calls go out in
batches of four with a pause between them, never eighteen at once.

## What the function serves

    /.netlify/functions/bbl?res=all&season=2025      dashboard: teams, standings, games, cup
    /.netlify/functions/bbl?res=four&season=2025     four factors for and against, all clubs
    /.netlify/functions/bbl?res=team&id=422&season=  club, roster, roster stats, schedule
    /.netlify/functions/bbl?res=game&id=2004018      game sheet + decoded play-by-play
    /.netlify/functions/bbl?res=seasons              which seasons exist, which is live

`&fresh=1` skips the cache.

**The season is a starting year.** `2025` is the 2025/26 season. The app may ask for a
year that does not exist yet, so the function asks `/v2/seasons` first and falls back to
the season the league has marked active. The answer says which season it used
(`season`), which one was asked for (`seasonAsked`) and which is live (`seasonActive`).

## The league-wide schedule is truncated — don't use it

`/v2/schedule?seasonId=X` does not return the season. On 2 October 2026 it held **169 of
the 306 league games**, with **rounds 1 and 2 missing entirely** and several rounds short
of their nine games (6, 7, 8, 10, 11). Every missing game is a result that never reaches
the table, a matchday that starts at three instead of one, and a hole in a form strip.

`/v2/schedule?seasonId=X&teamId=Y` is complete. So the season is assembled from the
eighteen per-club schedules, four at a time, and the league-wide answer is used only to
fill anything they miss. A game that one call knows the result of beats one that does not.
`schedule` in the response reports how many came from the clubs and how many the
league-wide call returned, so the gap stays visible.

## One schedule, four kinds of fixture

`/v2/schedule` returns the main round, the play-in, the play-offs and the cup under one
roof, and they are not the same kind of fixture: **a matchday is a number, a knockout
round is a name.** `normGame` therefore sets `phase` to `main`, `playin`, `playoff` or
`cup`, and keeps the numeric `round` for the main round only. Everything that reads
matchdays — the results panel, the position chart, the standings replay — filters on
`phase === "main"`, so a cup day 2 can never be read as league matchday 2. The app
classifies the same way on its own side, so an older deployment of this function behaves
correctly too.

**Matchdays are rebuilt, not trusted.** The number the feed puts on a game is not always
the Spieltag the league prints, so the app groups the main-round games, orders the groups
by their first date and numbers them 1..N. If the feed's own number does not group the
games sensibly — too many distinct values, or games without one — it falls back to the
calendar week, which is what a matchday is anyway. The feed's original value is kept in
the title attribute of the matchday header, so a mismatch is visible instead of silent.

On screen: the results panel carries the league block and the cup block one under the
other, each labelled; the standings panel gains a **Cup** view that draws the knockout as
a bracket, and the league view grows a play-in / play-off bracket as soon as those games
exist in the feed. A series is shown as wins (2–1), a single game as its score.

The qualification zones are marked on the standings with a rule and a coloured edge, no
prose: **1–6 straight to the play-offs, 7–10 into a play-in for the last two places,
17–18 relegated to ProA.** Eight clubs reach the play-offs in the end, six plus the two
that come through. The play-in is three single elimination games, not series, which is
why it reads as scores and not as wins. The numbers live in one constant, `LG_FORMAT`,
written as counts rather than fixed places, so a change of league size does not need the
table rewritten.

## Four factors

One call per club gives that club's own stats **and its opponents'**, so defence is
measured rather than guessed. Possessions are the usual estimate:

    poss = FGA − OREB + TOV + 0.44 × FTA

and from there offensive and defensive rating per 100, pace, effective field goal
percentage, turnover rate, rebound percentage and free throw rate, each side of the ball.
The main round is used, not the cup. The table in the app colours only the three best and
the three worst of each column — the edges of the league, nothing else.

### Where we stand

Above the table, three figures: our rank in offensive rating, in defensive rating and in
net rating. Not a composite built from weights — the four factors *are* the decomposition
of the offensive rating, so the rating is their sum, measured in points. A weighted
z-score index was tried and dropped: it put a team second in the league while it sat
seventeenth on net rating, because z-scoring gives a factor with no real spread the same
voice as shooting. A summary that can contradict the columns under it is worse than no
summary.

## The team calendar has two sources

The Calendar view used to be a mirror of the Games sheet and nothing else. A hand-kept
sheet drifts: friendlies tagged BBL, one club under two names (MBC and Weissenfels),
dates nobody went back to correct. The header now carries a switch:

- **Google sheet** — as before, `syncGames` reads the published CSV.
- **BBL schedule** — our club's games are read from `?res=all`, league and cup, with the
  short club names the staff write, and the result filled in for games already played.

Whichever is chosen, anything that is **not** a BBL or cup game — friendlies, NBBL — is
kept from the sheet, because the league does not publish it. While the league schedule is
the source, the sheet sync stops writing over it.

One thing to know before switching: reports are keyed by date plus opponent
(`gameKey`), so a game whose date was wrong in the sheet and is corrected here gets a new
key, and a report already written against the old date will not follow it.

## Distribution and quarters: read by game, not by club

    /.netlify/functions/bbl?res=pbpall&season=2026

How possessions end (0, 1, 2 or 3 points, for and against) and the four factors quarter by
quarter cannot come from season totals; they need the events for the whole league. Reading
per club would read every game twice — each game has two clubs in it — so this reads per
**game** and fills both sides from each sheet. The cost then grows with matchdays played
instead of with the size of the league, and it is cached twelve hours.

## Everything is built from the play-by-play

    /.netlify/functions/bbl?res=players&id=422&season=2026

The game sheet holds **only action rows**. No player totals, no team totals, no starting
five — that is why the roster used to come back empty: it was looking for rows that are
not there. Everything is in the events instead, which is more work and a better deal,
because one pass over them gives the box score, the quarter splits, the shot zones, who
was on the floor, and therefore lineups, rotations and on/off.

What the events say, verified on real sheets: `time` counts **down** in seconds within a
quarter; `points1`/`points2` carry the running score; a made shot has `result` `"+"`; a
rebound carries `O` or `D` in `info1`; the assist on a made basket is `player_id2`; fouls
drawn come as `RFOUL`; and a substitution names two players without saying which one came
on.

Three things had to be recovered rather than read:

- **Who started.** The sheet never says. A player who does something while not on the
  floor must have been on it all along, so the five fill themselves in as the quarter is
  walked.
- **Which way a substitution goes.** It swaps whichever of its two players is currently
  on, so the direction never has to be assumed.
- **Possessions.** One ends on a made field goal, a made free throw, a defensive rebound,
  a turnover or the end of a quarter. Points come from the running score rather than from
  adding the shots up, so an and-one cannot be lost — but the possession has to open on
  the score as it stood *before* its first action, or the basket that ended the previous
  possession is counted as this one's starting point and every possession reads zero.

Checked against a synthetic game with a known score: 116–86 comes back as 114.9 offensive
and 87.4 defensive rating, minutes add to exactly 200, and the bench players who never
touch the ball still appear with their minutes.

`checks` reports what the walk found: sheets read, sides flipped, actions, how often a
sixth man appeared on the floor and how often a substitution named nobody known. A sheet
without substitutions is counted too, so a feed that stops sending them is visible.

## The shot chart

The coordinate system was read off a real game sheet (Chemnitz–Hagen, 2026-09-27) rather
than guessed at:

- **x runs across the floor**, 0 to about 280, centre at 140. Dunks and layups come in at
  x 101–169 — a couple of metres either side of the ring — and corner threes at x 7–50 and
  237–272, which is each sideline.
- **y runs out from the baseline**, 0 to about 170. Dunks sit at y 34–46, a top-of-the-key
  three at y 160.

So there is **one basket, and the data is already half court**: the two three-point
clusters are the two corners, not the two ends. Every heuristic that tried to deduce this
from the shape of the data read it backwards — that is what put the shots in a band across
the top of the chart.

The scale is 280 units to 15 m, not the span the shots happen to cover: no game has a shot
right on each sideline, so measuring the observed spread makes the floor narrow and pushes
every shot away from the ring. Checked on that game's 34 identifiable shots: every dunk and
layup lands inside the paint (median 1.2 m from the ring) and every three outside the arc
(median 7.2 m).

## Colour on the calendar

A chip has two things to say: how the game went, and which competition it was. The result
owns the fill where there is one — green and red are what gets scanned for — and the
competition owns a 4px bar down the left edge. A game not yet played has no result to
show, so there the competition takes the fill: blue for the Pokal, orange for the play-in
and play-offs, violet for Europe, near-black for the main round. The three hues were run
through the colour-blind separation check as a set, and white text sits at 5.4:1 or better
on every fill, in both themes. A key under the calendar names only the competitions that
club actually plays.

European games used to belong to nobody: the EuroLeague feed identifies clubs by its own
codes and the BBL by its ids, so they never matched and never appeared on a team's
calendar. `_lgClubKey` gives each club one key and maps every spelling the feeds use onto
it — "FC Bayern München Basketball" and "FC BAYERN MUNICH" land on the same club — and the
European games are attached to the BBL team before anything is drawn.

## Position by matchday

The chart beside the standings is not in the feed: it is replayed from the results, round by
round, ranking on win percentage and then point difference. The league's own tiebreak starts
with head to head, so a tie inside a matchday can sit one place off the official table. The
shape of a season is what the chart is for; the standings panel beside it is the table of
record.

## The play-by-play feed

`gameStats` and the live socket send rows of plain numbers, the first number being the row
type. The mapping published by the league is in `bbl.js` (`FEED`, `FEED_COLS`, `FEED_MAP`),
so nothing downstream has to guess what column 17 means.

Two things in there are worth knowing:

- **Shots carry their spot on the floor.** An action row has `x` and `y`, the shot type in
  `info3` (jump shot, layup, dunk, alley-oop, tip-in), the distance class in `info1`, and
  the assisting player in `player_id2`. `decodeFeed` pulls these out into `shots`.
- **A player row lists everyone nominated**, including players who never came on. Filter on
  `playcode === "S"` for those who actually played — do not infer it from minutes.

The decoder checks one thing on every read: that a player's points equal
`FTM + 2·P2M + 3·P3M`. If that ever stops holding, the column mapping is wrong, and the
answer says so in `feed.checks` instead of serving quiet nonsense.

## Live games

Live needs a socket.io connection held open, which a Netlify function cannot do. Finished
games come through `gameStats` over plain HTTP, which is what the post-game work needs.
Live scoring would need a different kind of host.

## European games — a second, separate feed

The BBL API publishes **only its own two competitions**, BBL and BBL_CUP. The allowed
values of the `competition` parameter say so outright. Europe is run by other bodies, so
`netlify/functions/euro.js` goes and gets it:

    /.netlify/functions/euro?season=2026

Euroleague Basketball publishes two open APIs — no key, no account:

    /v2/competitions/{E|U}/seasons/{E|U}2026/clubs             JSON, clubs with country
    /v2/competitions/{E|U}/seasons/{E|U}2026/games?teamCode=   JSON, that club's season
    /v1/results?seasonCode=E2026                               XML, played games only
    /v1/schedules?seasonCode=E2026                              XML, the calendar

v2 is what the function uses. The club list carries each club's **country**, so the German
clubs are read from the feed rather than guessed from their names, and the per-club game
list carries the whole season — played and still to come — with scores. The old v1 results
feed only ever returns games that have already been played, which is why the panel looked
empty at the start of a season; v1 is kept as a fallback, now reading the schedule and
merging the results into it.

E is EuroLeague, U is EuroCup, and the number is the starting year, the same one the BBL
API uses. A season that has not opened yet is retried one year back. Cached six hours.
Every call is reported in `diag`, and the panel prints it when it has nothing to show, so
an empty panel says which request came back empty instead of staying silent.

**The Champions League, read from its own site.** FIBA publishes no open feed and GDAP is
a subscription, but the competition's site renders its pages on the server: the clubs,
groups and records are in the HTML that arrives, not drawn later by the browser. It is
built with Next.js, so the data is in the page twice — as text, and as the JSON the
server streamed (one `__NEXT_DATA__` script, or a run of `self.__next_f.push` chunks).
The function reads the JSON, walks it for anything with two sides and a date, and keeps
the games with a German club. Both page shapes are covered, and the whole thing fails
quietly: if nothing can be read, `diag` says which step gave nothing and the panel prints
it. It will never invent a game.

This could not be verified against real data: the 2026/27 Champions League had not started
when it was written — every record read 0/0 and there were no games at all. The first real
matchday is 6 October 2026, and that is when it either fills the panel by itself or says
what it could not read.

**Nothing is labelled "not covered" any more.** EuroLeague and EuroCup come from their own
API, the Champions League is read from its site, and the FIBA Europe Cup has no German
club in 2026/27 — so an empty competition means not played yet, not unreachable, and the
panel no longer says otherwise. When a week has no games it still keeps the slot: the next
fixture is shown, and clicking it moves the panel to that week.

## The shot clock (build 142)

The feed carries no shot clock, so it is reconstructed from the event order.
`possessions()` now opens a possession at the moment the ball changed hands — the made
basket, the turnover or the defensive rebound that ended the previous one — instead of
at whatever the new offence did first. Without that, nearly every possession measured
one or two seconds and the clock could not be rebuilt at all.

Each possession also carries `acts`, the indices of the actions that belong to it. That
replaces matching on timestamps: two possessions share the instant of the handover, so a
time window counted the same shot twice (79 attempts came back as 108 before the fix).

`clockSplit()` then walks each possession: 24 seconds from the handover, reset to 14 on
an offensive rebound, and whatever is left when a shot goes up decides its block —
24–18, 17–8, 7–0. The result rides in `res=players` as `clock: { team, opp, byPlayer }`,
three blocks each with `poss, pts, fga, fgm, p3a, p3m, tov`.

Caveat worth knowing before quoting a number from it: the game clock does not stop on a
made basket outside the last two minutes, so the inbound after a score — a second or two
— is counted inside the first block. A possession whose reset we never saw is clamped to
zero rather than discarded.

## The league shot grid

`res=pbpall` also returns `league`, every shot in the competition on a 20-unit grid
(`"x,y" -> [made, attempted]`), plus `grid`. The shot chart's mesh colours each cell
against the league's figure from that same patch of floor; a cell the league has taken
fewer than four shots from falls back to the club's own average, and the club's own cell
stays grey under three attempts.

## Reading sheets inside the time a function gets (build 143)

A serverless call gets about ten seconds. One game sheet is a few hundred kilobytes, the
league plays nine a round, and `res=players` reads up to eight of them while `res=pbpall`
reads the whole competition. Past a certain number of games that call simply never
finished: the browser got a 502 with an HTML body, `r.json()` threw, and the rotation,
the combinations and the shot clock came up empty for good — nothing ever asked twice.

Now:
- `feedCache` keeps every sheet it has read, keyed by game id, for 24 hours. A finished
  game's sheet does not change.
- `readFeeds(games, key, budget)` spends `READ_BUDGET` (6.5 s) and no more, then returns
  what it has plus `pending`.
- `res=players` and `res=pbpall` answer with `read`, `total`, `pending` and
  `partial: pending > 0`.
- A partial answer is never written to the result cache.
- The client calls again (up to 14 rounds, 700 ms apart) while `partial` is true, and the
  panels show the count climbing.

## Standings reconciliation

`_lgMergeStandings` used to top the official table up by position: sort a club's games
oldest first, skip as many as the table claims to have counted, add the rest. That is
only correct when the table counted the oldest games — and the reason the function exists
is that the feed drops games from the early rounds, which puts the lists out of step and
makes the top-up add the wrong result.

It now rebuilds each club's record from every finished league game held and uses it only
when it covers more games than the official row. A line under the table says how many
games each side holds, how many rows were rebuilt, and names any club that appears in the
games but not in the table at all.


## End of possession, end of game (build 144)

`clockSplit` now carries free throws and fouls drawn inside each shot-clock block, so the
7-0 block answers "who gets fouled when there is no clock left" and not only "who shoots".

`lateGame(actions, code)` is the other half of the question and has nothing to do with the
shot clock: it buckets a side's own actions by the time remaining in the quarter. Two
windows, both straight off `a.time` (seconds remaining, counting down):

- `q2` - the last 2:00 of any quarter
- `g5` - the last 5:00 of the fourth or of any overtime

Each holds `pts, fga, fgm, p3a, p3m, fta, ftm, fd, tov` per player plus a team line
(`tq2`, `tg5`). `fd` comes from the `RFOUL` action, which is the foul received.

Points per possession was dropped from that panel. Over a block of a few dozen
possessions it is an average of an average that moves on a single shot, and no question a
staff asks is answered by it.


## OER and DER are shown on a base of one (build 145)

The engine stores every efficiency figure per 100 possessions, which is what ORtg, DRtg
and the four factors use everywhere else. The Combinations panel — pairs, trios, fives and
on/off — now prints OER, DER and net as points per possession, two decimals, which is how
a coaching staff states them. The conversion is one function at the display step
(`LG_PPP` / `LG_PPPS`); nothing stored changes, so the values stay comparable with the
league ratings.


## The engine was wrong, twice (build 146)

Two bugs that made every derived number untrustworthy. Both are fixed and both now have
assertions against a deliberately nasty fixture (`/tmp/claude-0/hard.mjs`: free throws,
and-ones, a team-code actor, unmatched substitutions, a player who only appears in the
second half, an overtime).

**Minutes.** `onCourtTimeline` opened a player's span at ZERO - the tip-off - whenever he
appeared in the events without a substitution it could match, and closed it at the final
buzzer. One unmatched sub and a player who came on in the third quarter was credited with
the whole game. That is where 43-minute nights came from. The same path admitted the feed's
team-action code (`player_id1 = "E"`) as a player, which is where the phantom "#E" with a
full game and no statistics came from.

Rewritten per quarter with the invariant the old code never enforced: five on the floor,
never six, and nobody on the floor before the quarter in which he first appears. A
quarter's starting five is read off the events (a player who acts before being substituted
in was already on), each quarter is solved independently so one bad sheet costs a quarter
rather than a game, and spans run between the quarter's true boundaries rather than its
first and last recorded event - which was quietly losing five players' worth of seconds
every quarter. `isPlayerId` keeps non-player codes out of the box score, the assist
credit, the timeline and the units.

Checked: team minutes equal five times the game length, to the second.

**Possession points.** They came from the difference in the running score across the
possession. That cannot place an and-one - the free throw after a made basket falls into
whatever comes next - and the possession never closed on a made free throw at all, so a
trip to the line left the possession open until the next defensive rebound and it
collected everything in between. Pairs were reading OER above 1000 per 100.

Possessions now carry their own actions (`acts`) and points are added up from the scoring
actions inside them. A possession closes on a made field goal unless a free throw by the
same side follows (the and-one), on the last made free throw of a trip, on a defensive
rebound, on a turnover and at the end of a quarter.

Checked: the possession points of each side equal the final score exactly.

**Plus-minus.** The feed has no such field, so the column read 0.0 for everybody. It is now
the margin while the player was on the floor, taken from the corrected spans and the
corrected possession points. Checked: the sum over a club's players equals five times the
game margin.


## Why the build 146 fixes were invisible (build 147)

Everything rebuilt from the game sheets — the roster, the units, the rotation, the shot
clock — is cached in the browser under `state.league.players` and `state.league.pbp`, and
the panels only fetched when that key was missing. A corrected engine therefore changed
nothing for anyone who had already opened the page: they kept being served the numbers the
old engine had written, which is why 48-minute nights and OER above 20 survived a build
that fixes both.

`LG_DATA_VER` now stamps that cache. On load, a mismatch drops `players`, `pbp` and `four`
and the panels refetch. Bump it in the same commit as any change to the shape or the
arithmetic of the derived data.

## The team-action entity, properly identified

Filtering it by player id was wrong: the entity the feed signs team actions with has a
perfectly ordinary numeric id. What gives it away is the shirt number — a letter. Each
game's actions are now scanned once (`markNonPlayers`) and any id that ever carries a
non-numeric number is barred for that game, which keeps it out of the box score, the
assist credit, the timeline, the units and the shot clock.


## Rotation raster (build 148)

The single band per player is replaced by a raster: one row per player, five thin lanes
inside it, one per game, all on the same 0-40 axis with the quarter lines marked. Bars are
the real intervals between a substitution in and a substitution out, to the second -
nothing is bucketed into minutes. Right of each player: average minutes, range and the
standard deviation over the games he played.

Built in HTML and CSS rather than SVG so the sizes are exact: 5px lanes, 2px between
lanes, 10px between players. A dozen players fit on one screen. One colour for on-court,
a hatched lane for a game he did not play, the games told apart by a G1-G5 label rather
than by colour.

Also fixed while in there: `rot` kept the first six games of the season rather than the
most recent six, and the sheets come back from the cache in no particular order. It now
sorts by date and keeps the tail, so "last five games" means the last five.


## A saved selection that points at nothing (build 149)

The rotation panel kept the chosen game id in the persisted state and read it back on
every render. Two things then broke it: the list of games it can point at changes every
week, and build 148 swapped the panel from the first six games of the season to the most
recent six. A saved id that matches no option leaves every `<option>` unselected, so the
browser displays the first one — "Last 5 games" — while the panel still renders the old
single game. The dropdown said one thing and the chart showed another.

Any saved mode that is neither `raster` nor a game currently held now falls back to the
raster. Worth checking the same pattern anywhere a persisted id indexes a list that the
server rebuilds.


## The data version now rides on the request (build 150)

Build 148 changed the shape of `rot` (most recent six games, date sorted) and build 149
changed how the panel reads it — and neither bumped `LG_DATA_VER`, so browsers kept
serving the old payload out of local storage and the function kept serving it out of its
own six-hour cache. The rotation lanes were therefore in the order the old build left
them, which put a player's missing game in the wrong lane.

`LG_DATA_VER` is now sent as `&v=` on the `players` and `pbpall` requests and is part of
the function's cache key. One bump invalidates both sides. Bump it in the same change as
anything that alters the shape or the arithmetic of the derived payload.

The client also sorts the rotation games by date itself before drawing, so a payload that
predates the server-side sort still draws in calendar order.

## Club fixture check

Clicking a club in the standings now prints, under the table, what the feed actually holds
for it: how many league games, how many carry a result, the last played with its score and
the next one with its matchday. "The game against X is missing" is a click to settle.


## League view, build 151

**Colour rule, one for every table.** Best three and worst three of each column, direction
respected, plus everyone level with the third — "level" meaning inside two per cent of the
column's own spread, so the threshold scales with the statistic instead of needing one per
column. Ties are included deliberately: marking one of three clubs on 36.5% and leaving the
other two plain says something untrue. On the league tables a quiet underline marks the
clubs within a quarter of a standard deviation of the mean, which answers the other
question — not who is extreme, but who is ordinary. A key under each table states it.

The League row's NET is always 0.0 by construction: every point one club scores another
concedes. Its tooltip now says so.

**Venue and per-game.** `_lgVenue` and `_lgPerGame` are shared controls. Four factors and
shooting gain All / Home / Away, built from new per-venue boxes in `res=pbpall` (`hm`,
`aw`) — the league's own team statistics are season totals and carry no split. Combinations
gain the same, from new `hOff*`/`hDef*` counters on each unit and `raw` counts on each
on/off row; away is the total minus home. Per game / Totals is on every table, per game by
default.

**Late clock.** The explanation moved to the panel title (hover) instead of a fixed
paragraph. The "last 5:00 of the fourth" window is replaced by a clutch window: the last
two minutes of a fourth quarter or overtime played within six points, judged from the
running score at that moment rather than the final result, so a blowout contributes none
of its garbage minutes. Both windows now carry points, assists and steals alongside the
shooting, free throws and fouls drawn.

**Combinations** is a real table with sortable headers instead of a chip bar, the
possession bar sits behind its number rather than beside it, and the room that frees goes
to the names.


## Crests and head shots (build 152)

The club crest was already in the payload and unused: `normTeam` builds
`{base}/images/teams/logo/{season}/{id}` with the season left as a placeholder for the
client. It is now drawn beside the club in the standings and in the team analysis table.

Player head shots are a guess. The roster rows are not documented and the field names have
changed between seasons, so `photoOf` tries every plausible one (`photo`, `image`,
`imageUrl`, `picture`, `headshot`, on the row and on its nested player) and falls back to
`{base}/images/players/{season}/{playerId}`.

Both go through `_lgImg`, which draws a monogram first — the club's three-letter code, or
the player's shirt number — and only hides it once the image actually loads. A path that is
wrong therefore costs nothing: the table keeps its initials and its layout. Worth checking
on the live site whether the player path resolves; if it does not, the right fix is to read
the real field name off a roster response rather than to add more guesses.

## Reading the combinations automatically

The panel now states its conclusions above the table: best and worst net, attack and
defense for pairs and for trios, the most used combination, and — when it is not the same
one — the most used combination that is losing its minutes.

Two things had to be handled honestly. A combination with thirty possessions tops any list
by accident, since the error on a net rating is about 1.63 per possession over the square
root of the count — 0.30 at thirty possessions, wider than almost every real difference
between pairs. So nothing under `LG_UNIT_MIN` is eligible, and the eligible ones are ranked
on a value pulled back towards the club's own average in proportion to how little has been
seen of them (`n/(n+60)`, ordinary shrinkage). The printed figure is the real one; only the
ordering is adjusted. Volume gets its own line rather than being blended into the
efficiency ranking, because the pairing a staff uses and the pairing that works are
different facts.


## Finding the head shots without guessing (build 153)

Naming candidate fields by hand did not work and was never going to: the roster rows are
undocumented and the field name has changed between seasons. Replaced with two things.

**The server walks the row.** `deepImages` visits every string anywhere inside a roster
entry, to four levels, and keeps anything that looks like an image — a URL ending in an
image extension, or any URL under a key that mentions photo, image, picture, headshot,
portrait, avatar, thumb or media. Keys that mention one are preferred. If the feed carries
a portrait under any name at all, this finds it.

**The browser settles the rest.** Failing a real field, `photoOf` returns a LIST of
conventional paths rather than one guess:
`/images/players/{photo|portrait|headshot|}/{season}/{id}`, for both the player id and the
roster id. The client tries them in order and keeps the first that loads, remembering the
outcome per URL for the session so twelve players do not re-try the dead paths twelve
times. A wrong candidate costs one failed request and nothing visible — the monogram is
what is on screen until a real image arrives.

The first guess was `/images/players/{season}/{id}`, which omitted the segment the crest
path has: the crest is `/images/teams/logo/{season}/{id}`, so the player path very likely
carries an equivalent one. That is now among the candidates.

**`res=probe`** answers the question outright. With no `&id=` it resolves our own club, and
returns the roster row count, the first row's field names with truncated values, every
string in it that could be an image, and the candidate list that was built. Open

    /.netlify/functions/bbl?res=probe

on the deployed site and the roster's real shape is on screen. If `imageLike` comes back
empty, the feed carries no portrait and the monogram is the correct end state.


## Crests everywhere in the league view (build 154)

Results rows, calendar chips and the club pickers now carry the crest. In a result the
home badge sits to the right of its name and the away badge to the left, so the two meet
around the score and the fixture reads as a pairing rather than two lists.

The club picker is no longer a `<select>`: a native option cannot carry an image, so it is
a button and a list, same value and same callback as before. It closes on Escape, on a
click outside and on choosing. Five panels plus the calendar use it.

Everything goes through `_lgImg`, so a crest that fails to load leaves the club's
three-letter code in its place and the row keeps its height.


## Images go through the function (build 155)

Why the crests stopped: they were being requested straight from the image host by the
browser, and everything on that host wants `X-API-Key`. A browser cannot put a header on an
`<img>`. The request therefore failed on auth — and the player portraits never had a chance
for exactly the same reason, whatever the path was.

`res=img&kind=team|player&id=…` now fetches the image server side with the key, checks the
content type really is an image, and hands the bytes back base64 with a day of cache and a
permissive CORS header. It walks the candidate paths in `imgPaths()` and returns the first
that answers with an image, so the client never has to know which shape is right. A miss
returns 404 with half an hour of cache, and the failed paths in an `x-tried` header for
whoever is debugging.

`res=probe` now asks the image host for real: for our club and for the first player on the
roster it reports, per candidate path, the status code, the content type and the length.
One visit answers whether the portraits exist and at which path.

The roster's own player id and the event feed's player id need not be the same, so both
travel to the client and both are tried.


## The portrait path, read off the league's own site (build 156)

    https://api.basketball-bundesliga.de/images/player/portrait/{season}/{playerId}

**player, singular.** The crest path is `/images/teams/logo/{season}/{id}` with an s, and
every guess here assumed the portrait path matched it. It does not. Taken from the markup
of easycredit-bbl.de/teams/422, which serves exactly this URL through its own image
resizer.

The ids are the long ones (2003105, 2001383), the same space the event feed uses for
`player_id`, so the id already carried for a player is the right one.

Club ids, from the same page, for whenever one is needed by hand: ALBA 413, Bayern 486,
Bamberg 420, Bonn 415, Würzburg 540, ulm 418, Vechta 541, Trier 414, Rostock 551,
Ludwigsburg 433, Oldenburg 430, Chemnitz 485, MBC 428, Hamburg 554, SKYLINERS 426,
Jena 483, Phoenix Hagen 473, Braunschweig 422.


## Badges across the whole app (build 157)

**A crest from a club's name.** Outside the league view a game names its opponent as free
text, so `_lgTeamIdByName` normalises both sides — accents, punctuation and the words every
German club shares (basketball, baskets, e.V.) are dropped — and matches on the distinctive
token, which is what a person uses too: nobody says MHP RIESEN, they say Ludwigsburg. It
returns nothing unless exactly one club matches, because nothing is better than the wrong
badge. `_lgOppCrest` wraps it and only answers for BBL and cup games.

Wired into: the planning season cards, the month grid and the day cards; the calendar's
game chips and year view; the post-game, pre-game and game-plan lists; and the sheet
headers, where it sits next to "GAME vs …".

**Faces in the league view.** The shot chart marks each of the ten zones with the face of
the player who owns it — best points per attempt, not raw percentage, so three of five from
outside beats four of eight from inside, with a floor that rises with how busy the zone is.
Selecting one player replaces that with a single card top left. Rotation carries a face per
row and the opponent's crest on each game lane. The combinations summary, the late-clock
tables and the roster carry faces too.

**Scouted opponents.** A player typed into a scouting report has no id, so his name is
matched against that club's roster — the club is known from the game — and the portrait
follows from the roster id. It asks for that club's sheets once if they are not loaded, so
the next render has the faces. `scoutpre.js` does the same through `lblFace`, which falls
back to the plain label when the page's resolver is not there.


## Three corrections (build 158)

**The current matchday.** It was the highest round with a result in it. The league moves
several games a season, and a game played early carries its own late round number — which
made matchday 23 current in October while matchday 7 still had games to play. It is now the
FIRST round that is not finished: a round is behind us when all of it is behind us, which is
what counting by games played means.

**Pace.** The header now follows the number instead of contradicting it. Per game in the
season view it is pace; with a quarter selected it is possessions in that quarter, which is
a quarter of a pace and is labelled `Poss/Q`; under Totals it is the season's possessions
and is labelled `Poss`. That column is also the only count in the four-factors table, so it
is what the Per game / Totals switch acts on there — in the shooting view the switch acts on
the made-attempted pairs.

**Crests** on the standings chart (at the end of every club's line, which is the only place
an eighteen-line chart can be read without a legend per line) and in the cup bracket.


## Loading on open, and one club for the whole tab (build 159)

**`_lgWarm()`** runs once when the app starts, whichever view opened. It stages four reads —
the league itself, the four factors, the play-by-play, then our own club's game sheets —
250 ms apart rising to 3.8 s, skipping any whose data is already fresh, all in the
background. Nothing blocks the interface and no view is forced. By the time the league tab
is opened it is already filled.

**The club bar.** The league view now opens with one picker that moves every panel under
it, plus that club's record and league position. `_lgSetClub` sets both keys together: the
selection that highlights a row in the standings and the one the game-sheet panels read
were separate variables, which is what made this feel like eight unrelated screens.
Clicking a row in the standings or in the team-analysis table moves it too. Each panel keeps
its own picker, because comparing two clubs by changing one panel is a real thing to want.


## Our calendar follows the league's (build 160)

Our own calendar is typed in at the start of the season and the league then moves several
fixtures. Once the two disagree, every tab built on ours is counting towards the wrong day —
the planning cycle that says MD-3, the scouting sheet attached to a date, the post-game
list. `_lgSyncCalendar()` runs after the feed loads and brings our BBL and cup games onto
the fixture list's dates.

Deliberately timid, because moving a game wrongly is worse than leaving it alone:

- the opponent must resolve to exactly one club in the league,
- the venue must agree,
- the fixture must be the ONLY candidate against that club within five weeks,
- a game that already has a result typed in is never touched,
- anything outside BBL and the cup is ignored.

What it changes it records: the old date stays on the game as `moved`, a small ↻ appears
next to that game everywhere it is listed with the previous date in its tooltip, and a toast
names the change. It goes through `commit()`, so undo reverses it like any other edit.

Tested in `/tmp/claude-0/resched.mjs`: a moved game moves and remembers where from, a game
already on the right date is untouched, two fixtures against the same club inside the window
leave ours alone, a venue mismatch does not match, a played game is never touched, and a
club outside the league is ignored.


## Late clock reads itself (build 161)

Three short columns above the tables — the shot clock under eight, the last two minutes of
a quarter, and the same two minutes inside six points — naming who carries the late
shooting, who shoots it best and worst, who gets fouled, who scores, who creates and who
loses it. Faces, one line each, the supporting count beside every figure. Anything ranked
on a percentage needs at least five attempts behind it, so a two-for-two does not win.

The summary states season totals whatever the tables are set to: "most turnovers, 0.6" is
not a sentence anybody says.

Both tables now carry the standard marking — best three and worst three of each column with
ties included — with the direction right for each one (fewer turnovers is better, a higher
late-shot rate is not a compliment).

`_lgEdges` also learned to scale its depth: three at each end of a six-man list is most of
the list, so the cut is now a quarter of the rows rather than a third. A short rotation gets
one at each end; a league table of eighteen still gets three.


## Picking players, and the average lane (build 162)

**Combinations takes a filter.** A row of chips, one per man in the rotation, over both the
combination tables and on/off. On pairs, trios and fives a combination is shown when it
contains *every* player picked — one chip gives every pair he appears in, two chips on trios
give the trios built around that pair. On the on/off table the same chips mean *any* of
them, because that table is one row per player and no other reading of it makes sense.

The reading above the table follows the filter rather than ignoring it, so the best and worst
named at the top are always the best and worst of what is actually on screen. Picking three
players while the segment says pairs says so in words instead of showing an empty table. A
selection saved from another club is dropped on load: it would otherwise filter everything
away and look like missing data.

Above it all, a card with the players picked — photo, number, name — and, when the selection
*is* one of the groups in the table, that group's own possessions, OER, DER and net.

**Rotation grew an AVG lane.** Under the five game lanes, in blue rather than the gold the
games are drawn in, a strip of how often the player was on the floor at that point of the
clock: dark for every week, pale for once, twenty-second bins. The five lanes and the strip
answer different questions — a player who always plays the same eight minutes and one who
plays eight scattered minutes have the same average and completely different strips — so
both are on the row.

**And a reading above the raster**: the starting five with how often each man actually
started, the rest of the rotation by average minutes (eight minutes and up, in at least half
the games), and a third line for anything unsettled — a starter who did not start every
game, a player who missed one, a man whose minutes swing by a third of his own average.
Those men also carry a ring on their photograph in the lines above, so the summary says
which parts of it are firm without being read twice. Only men who actually took a tip-off
are counted as starters.

## The three clubs with no crest (build 162)

`_lgTeamIdByName` matched on words of four letters or more. "ULM" and "MBC" are three, and
"Weissenfels" is the town rather than the sponsored name, so all three resolved to nothing
and their badges never drew. It now tries, cheapest first: a name bound by hand, the exact
name, the three-letter code, then `_lgClubKey` — the club table the European linking already
used, which holds the towns, the codes and the sponsors — and only then the word match.

Whatever still fails is listed under the standings with a club picker next to it. Bind it
once and it is remembered in `league.alias` and used everywhere a crest is drawn. Cup
placeholders ("TBD (Round 2)", "Final Four", "Winner of…") are filtered out of that list:
they are not clubs and never will be.

## Smaller things (build 162)

- The zone owner on the shot chart is a chip now — photo and name on one line, in a box,
  clear above the percentage — because at that type size the face, the name and the number
  were landing on top of each other. Clamped to the floor, so a corner-three owner is no
  longer cut in half by the edge; the percentages are clamped too.
- Any player photo opens full size on a click, with his number and name under it. One
  listener on the document covers every face in the app, including the ones inside the shot
  chart's svg, and the click is stopped so a photo inside a control enlarges rather than
  firing the control. Escape closes it.
- The faces in the Late clock and Combinations summaries are twice the size, overlapped in
  pairs and trios the way a lineup graphic does it.
- The quarter dividers and the axis above the raster were 16px to the left of the lanes they
  belong to, ever since the lanes gained an opponent crest. They line up now.


## The explanations moved to the title (build 163)

Every paragraph of prose under a table is gone. What it said now hangs off the panel's own
title, behind the small `?`, the way Late clock already did it: there for whoever wants it,
no vertical space for whoever does not. The legends stay — a colour key is not an
explanation, it is part of the chart.

Gone from the page and onto the title: the roster's gold-edge note, the shot chart's
measurement line, the rotation's G1/G5 line (which now also explains SD in one sentence),
the late-clock floor, the combinations' shrinkage paragraph, and the on/off paragraph that
sat above the table. The standings keep their two lines: those are diagnostics, not prose —
how many games the feed holds against how many ours does, and what the feed says about the
club you have selected.

## Per game and totals now reach the summaries (build 163)

Both readings — the combinations summary and the late-clock summary — followed their own
rule before: the first always printed total possessions, the second always printed season
totals. One panel showing a number two ways is how a staff ends up arguing about which one
is right, so both now follow the Per game / Totals switch the tables use. The
made-of-attempted fractions stay whole: they are the evidence behind a percentage, and a
sixth of a shot is not evidence of anything.

(The harness had a stub around `_lgUnitSummary` that dropped the new argument, which made
this look broken when it was not. The stub passes everything through now.)

## SD, in one line

The standard deviation of a player's minutes over the games he played — not over the games
in the window, so a DNP does not count as a zero and drag him down. 2 means a typical night
lands within two minutes of his average; 6 means the night decides it. Checked in the
harness against the minutes recomputed from the spans.

## The calendar column that ate the week (build 163)

`.lg-cal` was `repeat(7,1fr)`, and `1fr` means `minmax(auto,1fr)`: a grid item's automatic
minimum is its content, so the day holding "vs Fitness First Würzburg Baskets" pushed its
own column wide and squeezed the five empty ones next to it. The wider the window, the worse
it looked, because the chip could ask for more. It is `minmax(0,1fr)` now, the cells and
chips carry `min-width:0`, and the chip prints the short club name with the full one on
hover. Seven equal columns at every width, checked in the harness.

## English everywhere (build 163)

Sixty-odd strings were still in Spanish — the sign-in and first-password dialogs, the admin
panel, the report toolbar, the section editor, the playbook's tagging messages, the print
toasts and the weekday strip in the session view. All translated. The only Spanish left is
inside a column-name matcher for imported sheets, where it is there to recognise a Spanish
header, not to show one.


## Three corrections (build 164)

**The list of names with no crest is gone.** Almost everything it offered to bind was a
preseason friendly or a cup opponent from outside the league — clubs the BBL feed has no
badge for and never will. A standing list of things the app cannot draw is not a job to do.
The alias lookup stays in the matcher, so anything already bound keeps working.

**The shot chart's card holds everyone picked.** The chips were already additive — pick two
men and the mesh is their shots added together — but the card in the top left only appeared
for one, so the moment you added a second you lost track of whose floor you were reading.
Now it carries every man selected: photographs overlapped, the numbers and names, and the
combined shot count under them. Picking a fourth adds him; clicking one off takes him and
his shots away. Over five it shows five faces and "+N".

**The fixture sync follows the whole season, not five weeks of it.** It used to look for the
league's version of one of our games inside 35 days of where our calendar had it, which
covers a kick-off moved by a weekend and misses what actually happens: a game pulled out of
October and replayed in February, or a pair swapped so the home leg lands where the away leg
was.

Our games and the league's are now grouped on what identifies a fixture and nothing else —
competition, opponent, and which floor it is played on — and inside a group they are paired
in date order. One of ours against one of theirs moves wherever it has gone, however far.
Two against two — both legs at the same venue, or a played one and one still to come — pair
first with first and second with second, so both move and neither steals the other's date. A
group where the counts disagree is left alone: that is the only honest answer when we cannot
tell which fixture is which. Games with a result typed in are still never touched, and every
move still records where it came from.

`/tmp/claude-0/resched.mjs` covers it: eleven assertions now, including a game moved four
months and both legs against one club moving in the same pass.


## The league, inside the pre-game report (build 165)

A pre-game report is about one club, and the feed already holds most of what a staff asks
about a club before playing it. So the league view's panels are now in the report, built for
the opponent instead of for us.

**How.** The panels are the same functions, unchanged. Three things differ and only three:
the league state's selected club is set to the opponent for the length of the render and
restored immediately after; the club picker draws as a label, because the club is not a
choice here; and every redraw in the league view goes through `_lgRerender`, which redraws
the live embeds when there are any and the league view when there are not. An embed whose
element has left the document is dropped on the next call, so closing a report takes its
panels with it. Nothing is duplicated, and a fix to a league table is a fix in both places.

**Where.**

- *Their season*, in front of the players section: results, standings and the calendar, with
  Europe added only for a club that plays it.
- *Team stats* now says which half you are reading: **From our video** — the tagging, as
  before — and **From the league**, which is the team analysis table with the scouted club
  marked as the selected row and ours marked as ours, so the comparison is on one screen.
- *Their players, from the league*, behind the players section: roster, shot chart,
  rotation, combinations and late clock.

All of it only when the opponent resolves to a club in the feed. A preseason friendly
against a second-division side gets none of it, which is right.

## Faces in the pre-game players table (build 165)

The tagging writes a player as "Surname #12". The surname is whatever the analyst typed — an
initial, a nickname, a spelling — and that is what the face resolver was matching on, which
is why that table had no photographs. The number is not up to the analyst, so it is tried
first now, against the club's roster, and the name only as a fallback.

While there: every face built from a roster row carries the player's name as well as his
number, so the tooltip and the enlarged photo say who it is rather than just "#9".

`/tmp/claude-0/pre.mjs` covers the lot: the opponent resolving to a club, the three panels in
front and the five behind, Europe appearing only when it is played, the club stated rather
than offered, a control inside an embed redrawing the embed and not the league view, the
scouted club and ours both marked in the team analysis, and the face found by shirt number.


## Planning and the calendar are one screen (build 166)

They were five screens showing the same month three times: the calendar had the games, the
planning month had the sessions and the load, the season strip had the shape of the year,
and reading a week meant opening all of them and holding the answer in your head.

**One tab now**, Planning, opening on an **Overview** that holds the lot:

- a dashboard of four readings — the next game with its crest, its hour and how many days
  away it is, and a button straight into Game-to-game; the record with the last five as a
  form strip and the last result; the week, with how many sessions and games it holds, the
  average load across the days that have one, and a button into the next session sheet; and
  the month on screen, counted;
- the month calendar, where a day now carries everything that happens on it: the game drawn
  the way the league view draws it (crest, who, and the result or the hour), every session
  with its hour and its label — click one and the session sheet opens on that day — the
  hand-written notes, the focus of the day and the load heat;
- the season strip underneath, month by month.

Game-to-game and the session sheet stay as their own tabs: that is where the work that needs
a full screen happens. The Season and Month tabs are gone, because the overview is both.

**The old Calendar tab is gone.** `calendar` as a view redirects to Planning, so saved state,
the back/forward history and anything that still names it keep working; a stored `planTab`
of "season" or "monthly" opens the overview. The games-source switch (Google sheet / BBL
schedule) and the refresh-on-open came across with it, and whoever had permission for either
section keeps access through Planning.

Tab order is League first, then Planning, as asked.

`/tmp/claude-0/planhome.mjs` covers it: the tab gone and the order right, the overview as the
default with its three parts, the four dashboard cards, the record counted off the results
with its form strip, the sessions on their day, a chip carrying a result and another carrying
an hour, a session click landing on the right sheet, and an old calendar link landing on
Planning.


## The pre-game report, in the order it is read (build 167)

The blocks now run: **Roster**, **Their season**, the staff's **Players stats**, **Shot
chart**, **Rotations**, **Clutch**, and then everything the staff writes — our offense, our
defense, the playbook and team stats. One banner per section, the panels inside them, so the
hierarchy is the same everywhere.

- **Their season** no longer carries the league's month grid and the whole matchday. It is
  the table plus **Fixtures**: every game the feed holds for this club, oldest first, with
  the venue, the opponent's crest, the result, the margin and the round, and the next one to
  be played highlighted. Europe is still added only for a club that plays it.
- **Shot chart** is one panel now instead of a club's chart and a chip row: the club on the
  left with the ten zone percentages, and on the right every man who has taken at least
  eight shots, drawn on the same floor and the same colour scale, ordered by volume or by
  efficiency — the one who matters most first. A small multiple is drawn with thicker
  hexagons and only its sixty busiest cells, because at a quarter of the width the thin ones
  are noise rather than information.
- **Rotations** holds the rotation raster and the combinations; **Clutch** holds the late
  clock. "Their players, from the league" is gone as a heading.
- **Team stats** puts the league first — the four factors, narrowed to this club and ours,
  each keeping the position it actually holds in the league and the marks still worked out
  over all eighteen — and the video tagging under it.

## Two clubs in one roster (build 167)

A scouting report was showing players from two teams. The reader decides which side of a
game sheet is ours by comparing the running score to our final score, and it was reading
that score off the **last action** — which is not always a basket. A substitution or a
timeout carries whatever those fields happened to hold, so a game now and then went to the
wrong side and the opponent's box score was merged into this club's roster.

Three rules now, in order of how much they can be trusted: the **highest** running score on
each side against our own final score (the running score is monotonic, so its maximum is the
final score whatever the last row says); then, when those are equidistant, how many actions
on each side are signed by a player this club has on its roster; then home and away.
`checks.codeRoster` counts how often the second rule had to decide. `LG_DATA_VER` goes to 10,
which clears both caches.


## Build 168

**League opens on the league.** "Whole league" is a state of its own and the default: the
tables that are about the league read normally, and the five panels that are about one club
say so instead of quietly showing ours. Picking a club anywhere turns it off; the bar at the
top turns it back on.

**Every button in the league view was dead.** `_lgRerender` redrew the live embeds when any
existed and returned — and a pre-game report left in a hidden tab is still in the document,
so "an embed exists" was true forever and the league view never redrew. It now redraws what
is actually on screen: the league view when it is the one showing, the embeds that are
visible, and nothing else. Covered in the harness with a report hidden off-screen.

**Post-game practice could not draw Trends and comparison.** `stats.js` had a bare
`if (!anyPhased)` with nothing after it but a blank line, so the next statement became its
body: with any phased game in the range the button was never created and the panel died on
`tgtBtn.addEventListener`. The note that was meant to be there is there, and the button is
unconditional again.

**Planning is two calendars.** The four cards are gone. The season is a strip on the left -
one row per month, one cell per day, a game as a block in the club's colours (won green,
lost red), a session as a tick, a note as a mark - and the month is on the right, fitted to
its half of the screen. The shape of the season and the detail of the month, both without
scrolling, both without a tab.

**The pre-game report, tightened.**
- The four factors computed from the pasted box score are gone. The league's own are in the
  report, for this club and ours.
- "Their season" is two rows of the table - them and us, each with the position it really
  holds - and the last five fixtures with the next one highlighted. The whole season is one
  fold below.
- Rotations, Combinations and Clutch show their reading and fold the table away. Open it to
  work, close it and it is gone again. In the league view, where the table is the screen,
  nothing folds.
- "Their offense" and "Their defense" as two hero panels are out of team stats: the same
  question is answered above from a whole season instead of from the clips we tagged.
- Shooting, Rebounding and Scoring and load carry each player's photograph, matched on the
  shirt number first and the name second.

**One format.** The report's section header was a black slab with 58px type on it. It is now
what every other block in the app uses to name itself - Oswald, small, uppercase, wide
tracking, over a rule - and the stats sections inside it are on the same scale. The league
panels were already there, so a report reads as one document rather than two.


## Build 169

**League.** Nobody selected is about the bar and the league-wide tables — no club followed,
no row marked. The five panels that are about one club still have to show one, and they open
on ours, which is what they always did and what a staff wants to see first. So: the bar says
Whole league, every panel says us, and picking a club anywhere moves all of them.

**The pre-game report was missing everything but the four factors.** The five panels off the
feed hung off "the first stats section that is not the tagging one" — which is a shape of
report, not a rule. A report built another way, or with that section renamed, matched
nothing and got none of them; the four factors still appeared because they ride inside the
team-stats block, which is created on its own. Who they are and where they stand now open
the report before anything that was typed into it, and the shot chart, the rotations and the
clutch follow the first stats section of any kind — or close the report when there is none.
Covered by a test with a report that carries no stats section at all.

While there: opening a report asks for the three feeds it needs — this club's game sheets,
the four factors and the play-by-play — rather than leaving it to whichever panel happens to
be drawn first. Each is guarded by its own in-flight flag, so it costs nothing when the data
is already in.

**Post-game hierarchy.** A block that lives inside a section cannot shout louder than the
section does, and the stats panel's own category titles were 23px over a 3px black rule
while the section above them is 17px over a 2px one. Everything inside now steps down from
the section: category 15px Oswald over a hairline, section 11px Inter uppercase, band 9px
with a rule running off it.

**Planning, laid out.** Two panels with the same header the rest of the app uses: the season
on the left — its strip, its key, and the games-source switch at the foot of it — and the
month on the right with its navigation in the panel header instead of floating above it.


## Build 170

**The player cards write themselves.** They were built by hand, one opponent at a time,
which is why only Bamberg had any. Everything on a card that is a fact rather than an
opinion is already in the feed, so the feed writes the first draft of all of them:

- one card per man who has played, in the column his position says, with his photograph;
- the passport under the name — nationality, age, height, weight — from the roster endpoint;
- minutes per game, and a badge: starter over 24 minutes, rotation over 12, bench under it;
- the numbers the position is asked for: points always, assists for a point guard, 2P and 3P
  as volume and percentage together, free throws with the attempts, and offensive rebounds
  for a four or a five;
- what stands out whoever he is: the share of the club's shooting he takes, a creator, a
  crasher, hands in the passing lane, a shooter you never leave, a non-shooter you let
  shoot, a poor two-point finisher, a man to foul late;
- the closeout bar set from his three-point line: shooter, mix, or driver.

It goes through the sheet's own importer — same validation, same preview, same confirm — so
nothing is overwritten without being seen. A player the feed gives no position for is placed
by his numbers and the footer says how many were placed that way, so they can be dragged.
The cards are the sheet's own: editable, draggable between columns, duplicated and deleted
as before.

**Roles, under the roster.** The sheet now ends with a roles board — one column per position,
lining up with the cards above, editable and saved with the sheet. No second screen and no
button: who they are, then what they do.

**The server now carries the passport.** `rosterIndex` reads position, height, weight,
nationality and date of birth off the roster row whatever the feed happens to call them, and
`res=players` passes them through. Anything the feed does not have simply does not appear on
the card.

**Three fixes.**

- The shot chart is one view again. Two orderings meant two visits to answer one question;
  the men are ordered by volume and every court — the club's and all twelve small ones —
  carries its own zone percentages, bigger on the small charts and left off a zone with
  fewer than three attempts.
- The playbook's "our adjustments" column was half empty because the Combinations summary I
  added uses a container class called `us`, and the playbook column is also called `us`. A
  two-letter class in a twenty-thousand-line stylesheet will find its twin: the summary is
  `lgsum` now.
- The colour rule moved from the middle of the tagging block to the top of the report, small:
  read once, applies to everything under it.


## Build 171 — the roster row, as the league actually sends it

`res=probe` settled what the roster carries, and it is more than the cards were asking for:

```
id 56763 · playerId 27000 · NUM 6 · firstName/lastName
height 1.91 · weight 94 · birthDate 1998-04-11
position SHOOTING_GUARD · nationalities ["DE"] · isForeign false
seasonStats: GP S5 SP PTS 2PA 2PM 3PA 3PM FGA FGM FTA FTM OREB DREB REB
             AST STL TOV BL EFF PM FOUL FOULR  (+ the same per game)
```

Three things were read wrongly and are read right now:

- `position` comes `SHOOTING_GUARD`. The underscores are stripped server side and the client
  maps POINT GUARD / SHOOTING GUARD / SMALL FORWARD / POWER FORWARD / CENTER onto its five
  columns, so a card lands where it belongs instead of being placed by its own numbers.
- `nationalities` is an array. It was being read as an object and came out empty; the first
  entry is what a card prints.
- `height` and `weight` are plain numbers on the row, matched now by exact key rather than
  by a loose "size"-ish pattern that could pick up something else.

And two things are new:

- **`seasonStats` travels with the player.** It is the league's own arithmetic over every
  game played, it is there on the first call, and the game sheets are not — so a scouting
  card can be built the moment a club is picked and gets richer as the sheets arrive. The
  cards use ours when we have it and the league's when we do not.
- **`S5`, games started.** A starter is now a man who starts rather than a man who plays a
  lot of minutes.

Everyone on the roster travels too, not only the men a game sheet has been read for. The
panels that are about what happened on the floor still filter by games played, so an unread
player adds nothing to them; the cards and the passport are available immediately.
`LG_DATA_VER` goes to 11.

`/tmp/claude-0/roster.mjs` reads the exact probe row through the real `rosterIndex`: both ids
and the number indexed, the underscore gone, the country out of the array, the box score
mapped onto ours, a zero kept as a zero rather than turned into a null, and no invented line
for a row that carries no season stats.


## Build 172 — a timeout is not a verdict

`res=players` reads the game sheets inside a budget and a Netlify function gets ten seconds.
When the gateway cut a call off, the client stored the error, set `_lgPlTried` for that club
and never asked again: the roster, the shot chart, the rotation, the combinations and the
clutch all sat on "the game sheets took too long to read" until somebody pressed the arrow.

The sheets that call did read are cached server side, so the next call starts further along
and the one after that usually finishes. A 5xx, a timeout or a dropped connection now
retries by itself — three goes, backing off 1.5s, 4s, 6.5s — and only then parks with the
error and the retry button. A real error (a bad id, a key that is not set) still stops at
once, because it does not match.
