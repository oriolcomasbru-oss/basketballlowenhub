# Offensive Staples in the Coaches Hub — setup

The stats read the tagging CSVs live from the two shared Drive folders. Nothing is copied
into the site: drop a new file in Drive and the card shows it on the next reload.

## What was added

| File | What it does |
|---|---|
| `stats.js` | The whole engine: CSV parsing for both export formats, possession model, metrics, and the rendering. Injects its own CSS, reads no app state, writes none. |
| `netlify/functions/drive.js` | Proxy to the Drive API. Lists a folder, downloads a file. Keeps the API key on the server. |
| `index.html` | One line added before `</body>`: `<script defer src="/stats.js"></script>`. Nothing else changed. |

## Setup

**Nothing, if the two folders are shared as "Anyone with the link · Viewer".** The function reads the
public folder page for the file list and downloads each file through Drive's public download link.
No Google Cloud project, no API key.

That path depends on the shape of a Google page, so it can break the day Google changes it. If the
stats stop listing files, the fallback is a Drive API key — fifteen minutes, once, free:

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project → **APIs & Services**
   → **Enable APIs and services** → **Google Drive API** → Enable.
2. **Credentials** → **Create credentials** → **API key**. Under *API restrictions* restrict it to the
   Drive API. Leave *Application restrictions* at **None** — the key is used server-side by the Netlify
   function, so a website/referrer restriction would block it and Netlify's outbound IPs are not fixed.
3. Netlify → **Site configuration → Environment variables** → `GDRIVE_API_KEY` = the key.
4. Redeploy. Netlify only picks up new variables on a deploy.

With the key set the function uses the API and falls back to the public read if the API call fails, so
setting it can only make things sturdier.

The folder ids are already in `drive.js`:

- post game `1jVE61lHX9_WxDa8_i_GjYdq6MKuYW0sN`
- post practice `1641_ma64tq_LGLERU_dRnjBR9A1gLAgs`
- opponent scouting `16rYmRVhaeVj-pPJJeSQfZMTelf61OvJp`

To change them without touching code, set `GDRIVE_FOLDER_GAME`, `GDRIVE_FOLDER_PRACTICE` and
`GDRIVE_FOLDER_PREGAME`.

**Every opponent shares the scouting folder, and that is the point.** The whole folder pooled is the
reference each pre-game report measures its opponent against; one folder per opponent would leave
each report with nothing to compare to. A file belongs to an opponent when its name *starts* with
that team, after the game number and words like `PREGAME` or `CUP` — both naming shapes work:

    G8 PREGAME ROSTOCK (HAMBURG).csv      the scouted team, its rival in brackets
    G8_ROSTOCK_ALBA.csv                   the scouted team, then its rival

Both team names are in the string, so "the file mentions Rostock" is not enough: it would hand the
Rostock-vs-Alba game to an Alba scout as well.

## Where the stats appear

Three places, all of them placeholders that already existed in the app:

1. **Post game / practice → a game** — the post-game card. Was *"El Post game lo definimos aparte"*.
   Renders: the two 70% gauges, the staples block, paint touches and ball reversals by phase,
   shot selection with the fastbreak excluded, and the quarter table.
2. **Post game / practice → a training** — the *Team stats* panel. The session / week / month / season
   tabs already there now drive the range: the session tab reads that day's file, the others
   aggregate every file in the range.
3. **The team-wide overview** — the season view of every practice file in the folder.

## How a file is matched to a card

- **Games** by opponent: the file name is slugged and searched for the opponent name, so
  `G6 CUP BREMERHAVEN.csv` matches the game against Bremerhaven. If two files match, the one whose
  name carries the date wins. If none matches, the card lists what is in the folder so you can see
  the mismatch.
- **Practices** by the `YYYY-MM-DD` at the end of the file name, which is how the exports are
  already named (`training-180926-2026-09-18.csv`).

Keep those two naming habits and nothing else needs configuring.

## What the engine does with the data

Verified against the files you sent — the numbers it produces match the reports exactly.

**Games.** Clips are not possessions: 112 offensive clips in the Bremerhaven file become 93
possessions. Clips chain into one possession when there is no defensive clip between them and
either the previous clip has an offensive rebound within 20 s, or the gap is 5 s or less. Phases:
Fastbreak, Secondary break, Half court, OOB (SLOB/BLOB), and Offensive rebound, which overrides the
others whenever a possession contains one — so the five are exclusive and sum to the total.

**Practices.** The category carries the reversal count directly; `SECOND CHANCE` rows merge into the
possession above. Paint touches are typed and attributed, so the per-player table by touch type —
the one the game files cannot produce — is built here.

**Both.** Free throws are counted from `C1` / `M1`, never from the `Foul Drawn` descriptor, which is
not marked consistently. Colour follows two ramps that are never mixed: green for PPP, blue for
volume.

## Known limits, carried into the page

- Practice sessions under 0.50 points per possession over 15 possessions or more get a warning
  rather than a reading — on 14, 16 and 17 September the tagging shows 28 points in 111 possessions
  with the highest paint-touch rates of the block, which is a data question, not form.
- Paint-touch and reversal rates are not comparable between the two routes until the game tagging
  gets a written definition for a ball reversal and the same paint-touch criterion as practice.
- `BACK` is never written in a game file and does not need to be. Tag-up and get-back are read off the
  rows instead, with the rule from the tagging dictionary: the clip before a defensive clip is our own
  possession, what we finished it with decides which of the two it is, and the two clips have to be
  within ten seconds. A long shot (`M3` `ML2` `C3` `CL2`) is a TAG; a shot at the rim (`C2` `M2`) or a
  `Turnover` is a BACK — they run off a turnover like off a rebound. An `Offensive foul` is not, because
  nobody runs off a dead ball, and it is written next to the turnover, so it is taken back out.
- A foul taken while the shot is still being rebounded is thrown out of both. It is written as a
  defensive clip that opens *before* our own clip has closed and that ends in `Foul Drawn` — or in the
  free throws alone, `C1` / `M1` — with no field goal on it. Nobody ran, so it is not transition defense.
  The rule as written names `OTHER DEF`; in the two files we have, these clips are almost always
  `BALANCE`, and restricting the test to `OTHER DEF` catches none of them, so the test is on the shape of
  the clip and not on its category. A clip that also carries a field goal stays in: that is an and-one.
  In Bremerhaven this removes 3 TAG and 2 BACK, in Trier 0 and 5 — TAG in Bremerhaven goes from 0.40 to
  0.24 points per situation, so it is not a rounding matter.
- The literal `TAG` mark is not read at all. It is a mark on a player, written when he does *not* tag up,
  which is a different question from what the team conceded, and the block reports the situation only.
- One row now carries the whole possession, because the question is not only how often we got beaten:
  our possessions, how many of them missed, how many of those misses we rebounded ourselves, the
  rebound percentage, and how many turned into a transition situation against us. The percentage is over
  the misses and the miss count sits in the column beside it, so the denominator is never something to
  guess. The shot decides the side: `M3` and `ML2` are TAG, `M2` is BACK — a missed long two is a TAG
  however close the rebound lands. On a clip of ours an `Offensive Rebound` is ours. No clip in either
  file carries two missed shots, so the miss the rebound belongs to is never in doubt; if that ever
  changes the split stops being safe and the numbers should not be trusted.
- Only part of our possessions become one of the two: the rest end the same way but we take the offensive
  rebound ourselves, or more than ten seconds pass. The table carries that sample in its own column, so a
  slice is never read as the whole game.
- `CL2` / `ML2`, the long two, were not counted at all: a converted long two was worth nothing and a
  missed one was not a shot. They count now. Both are rare in the files so far, so no table moves much,
  but the transition-defense rule keys off them.
- Play types are the newest thing in the tagging and the least consistent. A game where nobody wrote
  them comes back empty in that block, and the block says so rather than drawing an empty table.
- `RED` and `HEDGE` are one coverage, and so are `SWITCH` and `BLACK`. Both pairs are merged into one
  row; kept apart, two games read as two different defensive systems when only the wording changed.

## Deploying

Drag the folder into Netlify, or push it. `netlify.toml` already points at `netlify/functions`, so
`drive.js` is picked up with no extra config.

## TAG and BACK in a practice report

The practice report now carries the same transition-defense table as the post-game one —
same columns, same marks, read the same way.

It needs defensive clips to run our end against, and a practice file only has them for the
stretch that was played 5x5. Nothing has to be marked to say where that stretch is: the
pass pairs one of our clips with a defensive clip that opens within ten seconds of it, and
that only happens in live play, so the 5x5 selects itself and the drills never pair.

Two things changed underneath:

- A practice file's defensive clips used to be folded into the offensive possessions. They
  were inflating the possession count and putting defensive tags in an offensive row. They
  are now kept out. **If a file of yours carried defensive clips, its possession count and
  its PPP will move** — the old numbers were wrong, not the new ones.
- When no defensive clip is present the block says so instead of drawing an empty table,
  and the smaller "offensive rebounding on our misses" table stays as the half of the
  question that can be answered without them.
