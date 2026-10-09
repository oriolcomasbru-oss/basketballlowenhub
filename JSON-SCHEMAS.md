# Coaches Hub — JSON import reference

Everything the app can be filled from a file, and exactly what each file has to contain.
Written so it can be pasted into a fresh conversation and used without any other context.

Four importers, four schemas:

| # | Where | Button | Schema |
|---|---|---|---|
| 1 | Pre game → Players | `⬆ Import` in the editor toolbar | **Player Scouting** |
| 2 | Pre game / Post game → report | `⇩ Game Summary + Our Offense + Our Defense — one JSON` | **Report** (summary + offense + defense, plus plan + stats in Pre game) |
| 3 | Pre game → PLAYERS STATS | `＋ Add stats (JSON)` at the bottom of the block | **Player Stats** (the `stats` key of the Report schema) |
| 4 | Pre game → GAME PLAN | `⇩ JSON` on the section banner | **Game Plan** (the `plan` key of the Report schema) |

**Post game holds three sections only** — Game Summary, Our Offense, Our Defense — and the button at the top of the page, `⇩ Game Summary + Our Offense + Our Defense — one JSON`, fills all three from one file. That is the normal post-game route. Players Stats and Game Plan are Pre game only.

There is one schema, not four variants of it. The per-section buttons (`⇩ JSON` on a banner, `＋ Add stats`) run the **same validator and the same preview** as the whole-report button — they only refuse keys that are not their own: `This button only imports defense. The file also carries offense — use "Import the whole report" at the top of the page for that, or take those keys out.` So a file written for one of them is always a valid whole-report file too, and vice versa.

Rules that hold for all four:

- **Strict.** The file is validated before anything is written. If it does not validate, **nothing is touched** — not partly, not the valid half.
- **Unknown field = error, not a silent skip.** A field the schema does not know stops the import and is named in the message, with a "did you mean" when it is within two characters of a real one. A typo losing work silently is worse than a refused file.
- **Missing field = left alone.** Anything you leave out keeps whatever is already in the report. This is how you send a partial update: a file with only `summary.offense` in it changes that one box.
- **Preview before saving.** `Validate & preview` shows a table of every field that will change, current value on the left, new value on the right. `Apply` is disabled until that passes.
- **Warnings do not block.** They appear above the preview table and the import still goes through.

---

## 1 · Player Scouting

**Pre game → a game → Players → `⬆ Import`.** Builds the five position columns of player cards. Replaces the whole scouting report for that date + opponent.

### Top level

| Field | Required | Type | Notes |
|---|---|---|---|
| `match` | **yes** | object | identifies the report |
| `match.date` | **yes** | string | `YYYY-MM-DD`. Checked against the calendar — `2026-02-31` is rejected |
| `match.opponent` | **yes** | string, non-empty | also the title on the sheet |
| `match.competition` | no | string | accepted, not displayed yet |
| `match.venue` | no | string | accepted, not displayed yet |
| `players` | **yes** | object | keys are exactly `PG`, `SG`, `SF`, `PF`, `C` |
| `players.<POS>` | no | array of player objects | a missing column warns and renders empty |
| `footerNotes` | no | string | the "Scouting notes" box at the bottom |

The key of `match.date` + `match.opponent` is what the report is filed under. Importing over an existing one **replaces it** — the preview says so in gold when that is about to happen.

### Player object

| Field | Required | Type | Values |
|---|---|---|---|
| `name` | **yes** | string, non-empty | |
| `num` | no | string | shirt number badge. Use a string: `"4"`, not `4` |
| `pos` | no | string | `PG` `SG` `SF` `PF` `C`. **The column decides where the card goes**, not this — a mismatch is a warning |
| `meta` | no | string | the grey line: `"GER · 24y · 1.90m"` |
| `badge` | no | string | small label: `"BBL"`, `"Import"` |
| `badgeCls` | no | string | `"filled"` (default) or `"outline"` |
| `minutes` | no | string | `"20.0 min/g"` |
| `tagline` | no | string | one-line description |
| `ideas` | no | array of strings | the key ideas. Up to 8; fewer than 3 is padded with empty rows |
| `blocks` | no | array of strings | extra note rows under the ideas |
| `stats` | no | array of `[value, label]` pairs | e.g. `[["8.7","PTS/G"],["5.2·48%","2PT/G"]]`. Above 8 pairs warns |
| `closeout` | no | string | `"red"` shooter · `"yellow"` mix · `"green"` driver · `"neutral"` unrated |
| `hand` | no | string | `"L"`, `"R"` or `""` |
| `photo` | no | string | image URL |

### Complete example

```json
{
  "match": { "date": "2026-10-05", "opponent": "Vechta" },
  "players": {
    "PG": [
      {
        "num": "4",
        "pos": "PG",
        "name": "Marcus Weber",
        "meta": "GER · 24y · 1.88m",
        "badge": "BBL",
        "badgeCls": "filled",
        "minutes": "28.4 min/g",
        "tagline": "Downhill, hunts the drag every possession",
        "ideas": [
          "Right hand only going left",
          "Take away the drag — he calls it 4 times a quarter",
          "Lives at the FT line, does not finish over length"
        ],
        "blocks": ["Shot 2/14 from three in the last three games"],
        "stats": [["12.4","PTS/G"],["6.1","AST/G"],["5.8·54%","2PT/G"],["2.1·24%","3PT/G"]],
        "closeout": "green",
        "hand": "R"
      }
    ],
    "SG": [
      { "num": "11", "name": "Tim Jansen", "tagline": "Spot-up only", "closeout": "red",
        "ideas": ["Never let him catch on the move", "Gambles in the passing lane"] }
    ],
    "SF": [], "PF": [], "C": []
  },
  "footerNotes": "Zone 2-3 after every timeout in the second half."
}
```

### Error messages

| Situation | Message |
|---|---|
| Not JSON | `Invalid JSON — <reason>. Usually a missing comma, a trailing comma, or a smart quote.` |
| Array at the top | `The top level must be an object { … }, found array.` |
| `match` missing | `"match" is required: { "date": "YYYY-MM-DD", "opponent": "Name" }.` |
| Wrong date shape | `"match.date" is required and must be YYYY-MM-DD, found "05-10-2026".` |
| Date that does not exist | `"match.date" is not a real date: 2026-02-31.` |
| Typo in a top-level key | `Unknown field "playerz" at the top level — did you mean "players"?` |
| Typo in a position | `Unknown position "PGG" — did you mean "PG"?` |
| Typo in a player field | `Unknown field "taglines" in "players.PG[0]" — did you mean "tagline"?` |
| No name | `"players.PG[0]".name is required and must be a non-empty string.` |
| Bad enum | `"players.PG[0]".closeout must be one of red, yellow, green, neutral.` |
| Bad stats pair | `"players.PG[0]".stats[2] must be a pair like ["8.7","PTS/G"].` |
| Empty file | `No players in the file — nothing would be imported.` |

Warnings (import still proceeds): a missing position column, a `pos` that disagrees with its column, more than 8 stat cells, more than 8 ideas.

---

## 2 · Report — one schema, Pre game and Post game

**Pre game or Post game → a game → `⇩ Import the whole report — JSON`.**

This is the single file that fills **Game Summary + Our Offense + Our Defense**, and Game Plan and Players Stats if you include them. **The same schema works in both Pre game and Post game** — the two share one stored report but keep their sections apart (`sections` for pre, `postSections` for post), so importing into one never touches the other.

What the words mean changes with the tab, the shape does not:

| | Pre game | Post game |
|---|---|---|
| `summary` | what we are going to do — five slots | what happened — two slots |
| `<point>.them` | what they will do | what they did |
| `<point>.us` | what we will do about it | what we did |

### Top level

| Field | Required | Type |
|---|---|---|
| `meta` | no | object — bookkeeping only, changes nothing on the page |
| `summary` | no | object or array — the 5 Game Summary boxes |
| `offense` | no | array or object — the Our Offense points |
| `defense` | no | array or object — the Our Defense points |
| `playbook` | no | array or object — the Playbook areas, same shape plus `sets` |
| `plan` | no | object — see §4 |
| `stats` | no | object or array — see §3 |

At least one of `summary` / `offense` / `defense` / `playbook` / `plan` / `stats` must be present. `meta` alone is refused: `Nothing to import — "meta" alone changes nothing.`

`meta` accepts `kind` (`"pregame"` or `"postgame"`), `date` (`YYYY-MM-DD`), `opponent`, `competition`, `venue`, `result`, `author`. It is validated but ignored on write — the report you have open decides where the content lands.

### `summary` — the 5 boxes

Positional. Five slots, in this order, with these accepted keys:

**This is the one place Pre game and Post game differ.** Pre game plans the opponent and keeps five slots; Post game reads back what happened and keeps two.

| Slot | Keys accepted (exact, case-insensitive) | Label | Pre game | Post game |
|---|---|---|---|---|
| 0 | `offense`, `our offense`, `off`, `offense 5 keys`, `5 keys offense`, `our offense · 5 keys`, `attack keys` | Our offense · 5 keys | yes | yes |
| 1 | `defense`, `our defense`, `def`, `defense 5 keys`, `5 keys defense`, `our defense · 5 keys` | Our defense · 5 keys | yes | yes |
| 2 | `ato`, `ato's`, `atos`, `after timeout`, `after time out` | ATO's | yes | — |
| 3 | `special`, `special defenses`, `specials`, `special defense` | Special defenses | yes | — |
| 4 | `attack`, `players to attack`, `targets`, `to attack`, `key moments`, `keymoments`, `turning points` | Players to attack | yes | — |

A Post game file carrying one of the last three is refused: `"ato" is a Pre game summary slot. The Post game summary has only offense and defense.` The dialog knows which report it is open on, so the example it offers and the file it accepts already match.

Everything else in this schema is identical for the two. Reports written before a slot change keep whatever items they already had; only new ones start from the shape above.

Matching is **exact**, not fuzzy. `"offens"` is refused with `Unknown summary slot "offens" — did you mean "offense"?` rather than quietly landing in slot 0.

Each value is either a **string** (kept as one paragraph, `\n` becomes a line break) or an **array of strings** (rendered as a bullet list). An object is refused.

Array form also works, positionally: `"summary": ["...", "..."]` fills the slots in order — five entries in Pre game, two in Post game. An entry past the last slot warns and is dropped.

### `offense` / `defense` — the dual points

Array form, one object per point:

```json
"offense": [
  { "t": "PNR", "them": "Drop with the big at the level", "us": "Reject and attack the short roll" }
]
```

| Field | Required | Type | Notes |
|---|---|---|---|
| `t` | **yes** | string, non-empty | the point title. Aliases: `title`, `point`, `name` |
| `them` | no | string or array of strings | the THEY column. Alias: `opp` |
| `us` | no | string or array of strings | the WE column. Alias: `we` |

Object form is also accepted — the key is the title:

```json
"defense": {
  "PNR": { "them": "Empty side, the 5 pops", "us": "Ice and stunt from the weak side" },
  "Postup": "Dig from the top"
}
```

A bare string value fills `us` only.

**Matching is by title, case-insensitive.** A title that already exists is updated in place; a title that does not is **added as a new point at the end** (the preview shows it as `new point`). Existing points you do not mention are left alone.

The default point lists, which is what you normally target:

- **Our Offense** — 3 keys, Game plan, First play, Press break, Early offense, PNR, Offscreens, Postup, Backpicks, Special defenses
- **Our Defense** — 3 keys, Game plan, Defensive rebound, Transition defense & off rebound, Early offense, Half court, 1x1, PNR, Offscreens, Postup, Backpicks, Entries

### Complete example

```json
{
  "meta": { "kind": "pregame", "date": "2026-10-05", "opponent": "Vechta" },
  "summary": {
    "offense": ["Push after every stop", "Paint touch before the first shot", "Two reversals or a paint touch on every half court"],
    "defense": ["No middle", "Wall the ball, tag the roller", "One shot: box out the 4 and the 5"],
    "ato": "Box → flare for the 2",
    "special": "Switch 1-4 on the last shot",
    "attack": ["#3 slow feet on closeouts", "#11 gambles in the passing lane"]
  },
  "offense": [
    { "t": "3 keys", "us": ["Pace", "Paint touch", "Second side"] },
    { "t": "Press break", "them": "1-2-2 three-quarter after made free throws", "us": "Middle flash, then run" },
    { "t": "PNR", "them": "Drop with the big at the level", "us": "Reject and attack the short roll" },
    { "t": "Postup", "them": "Front the 5 with weak-side help", "us": "High-low from the top" }
  ],
  "defense": [
    { "t": "3 keys", "us": ["No middle", "Wall", "Box out"] },
    { "t": "Transition defense & off rebound", "them": "Two runners every possession", "us": "Guards tag up, bigs sprint to the rim" },
    { "t": "PNR", "them": "Empty side, the 5 pops", "us": "Ice and stunt from the weak side" }
  ]
}
```

### Error messages

| Situation | Message |
|---|---|
| Not JSON | `Invalid JSON — <reason>. …` |
| Top level not an object | `The top level must be an object { … }, found array.` |
| Typo at the top | `Unknown field "offense" at the top level — did you mean "offense"?` |
| Unknown with no near miss | `Unknown field "xyz" at the top level. Allowed: meta, summary, offense, defense, plan, stats.` |
| Only `meta` | `Nothing to import — "meta" alone changes nothing. Use at least one of: summary, offense, defense, plan, stats.` |
| Bad `meta.kind` | `"meta.kind" must be "pregame" or "postgame", found "warmup".` |
| Bad `meta.date` | `"meta.date" must be YYYY-MM-DD, found "5/10/26".` |
| Unknown summary slot | `Unknown summary slot "offens" — did you mean "offense"?` |
| Wrong summary type | `"summary.ato" must be text or a list of text, found object.` |
| Point with no title | `"offense[0]" — a point needs a non-empty title in "t".` |
| Typo in a point field | `Unknown field "uss" in "offense[0]" — did you mean "us"?` |
| Wrong point type | `"offense[2].them must be text or a list of text, found object.` |

---

### `playbook` — the areas, and the sets picked into the right column

Same shape as `offense` / `defense` — matched by area title (`Transition`, `Half court`, `SLOB`, `BLOB`) —
with one extra key. The left column of that section is not typed at all any more: it is the opponent's own
tagging, read live from the Drive folder. `them` and `us` still fill the two free boxes underneath.

| Field | Required | Type | Notes |
|---|---|---|---|
| `t` | **yes** | string | the area, matched case-insensitively |
| `them` | no | text or list | the free box under the automatic list |
| `us` | no | text or list | the free box under the picked sets |
| `sets` | no | array | the sets picked into the right column — **replaces** what is picked there |

Each entry of `sets` is either the set's name as a string, or `{ "k": "<set name>", "rule": "<the rule>" }`.
`k` must be the set as the tagging names it — `"H8A Iverson Dallas"`, not `"#H8A Iverson Dallas (1)"` — or the
pick lands with your rule but without its numbers.

```json
{ "playbook": [
  { "t": "BLOB", "us": "",
    "sets": [ { "k": "B3 Stagger Pin Down", "rule": "our rules in 5-4 offscreen" } ] }
] }
```

## 3 · Player Stats

Either standalone (`＋ Add stats (JSON)` at the bottom of the PLAYERS STATS block) or as the `stats` key of the Report schema.

Two shapes accepted:

```json
[ { "name": "…", … } ]                                   // just the players
{ "players": [ … ], "highlights": { … } }                // players plus the manual highlights
```

### Player object

`name` is required and must be a non-empty string. `pos` is optional, one of `PG SG SF PF C G F GF`. Every other field is an optional **number** — a string like `"15"` is refused.

| Field | Meaning |
|---|---|
| `min` | minutes |
| `pts` | points |
| `pir` | valuation / PIR |
| `ast` | assists |
| `fg2m` / `fg2a` | two-point made / attempted |
| `fg3m` / `fg3a` | three-point made / attempted |
| `ftm` / `fta` | free throws made / attempted |
| `oreb` / `dreb` | offensive / defensive rebounds |
| `tov` | turnovers — without it there is no TOV% in the four factors |
| `gp` | games played. Only for per-game numbers, and only worth it when someone missed games |

`gp` is what stops a per-game table from lying. A player who sat out two of three has a per-game
line that is per game *he played* — the honest read of him, and the wrong thing to add up. With
`gp` on every line the TEAM row is weighted back down to one real game, a `GP` column appears next
to the minutes, and anyone who missed a game is marked there. Leave `gp` off everywhere and nothing
changes: every line counts once, exactly as before.

Consistency is checked: `fg3m: 5, fg3a: 2` is refused with `fg3m (5) is greater than fg3a (2)`.

### `team` — the two numbers a list of players cannot carry

Four factors need turnovers and the boards the other side took. All optional, all numbers.

| Field | Meaning |
|---|---|
| `tov` | team turnovers. Left out, the players' own `tov` are summed instead |
| `opp_dreb` | defensive rebounds we took — gives their ORB% |
| `opp_oreb` | offensive rebounds we took — gives their DREB% |
| `games` | how many games these numbers cover |

### `ref` — what the four factors are painted against

Optional, all numbers, all as percentages. Without it the four factors are shown without a verdict,
because a factor is only good or bad against something.

`efg` · `tov` · `orb` · `dreb` · `ftr`

### What the app computes on its own

You do **not** enter these — they come out of the players array:

**01 Four factors** eFG%, TOV%, ORB%, DREB%, FT rate · **02 Shooting** per player 2PT, 2P%, 3PT, 3P%, FT, FT%,
eFG%, TS% and shot load, with the team totals in the footer · **03 Rebounding** offensive, defensive, total and
each player's share of the team's · **04 Scoring and load** points by position group (guards = PG/SG/G,
wings = SF/GF/F, then PF and C) and per player minutes, points, assists and PIR.

The percentages are painted against the pooled rates of the tagged games (2P 53.4%, 3P 36.1%, FT 71.4%);
eFG% and TS% against this team's own total.

### `highlights` — no longer drawn

Strengths, weaknesses, notes and the hand-made cards were taken out of the block. A file that still carries
`highlights` imports without failing and the key is simply dropped, with a warning in the preview. The fields
below are kept here only so an old file can be read.

| Field | Type | Renders as |
|---|---|---|
| `strengths` | string or array of strings | a green-edged list card |
| `weaknesses` | string or array of strings | a red-edged list card |
| `notes` | string or array of strings | a plain list card |
| `cards` | array of card objects | your own bar charts, in the same style as the computed ones |

Card object:

| Field | Required | Type | Notes |
|---|---|---|---|
| `title` | **yes** | string | |
| `tag` | no | string | the small label next to the title |
| `tone` | no | string | `"good"` green · `"bad"` red · `"cool"` blue · `"green"` · omitted for the default |
| `rows` | **yes** | non-empty array | |
| `rows[].name` | **yes** | string | the left label |
| `rows[].val` | **yes** | string or number | the text on the right |
| `rows[].bar` | no | number | bar length. Defaults to the number parsed out of `val` |

### Complete example

```json
{
  "players": [
    { "name": "Devin Askew", "pos": "PG", "min": 31, "pts": 18, "pir": 21, "ast": 6,
      "fg2m": 5, "fg2a": 9, "fg3m": 2, "fg3a": 6, "ftm": 2, "fta": 2, "oreb": 1, "dreb": 4 },
    { "name": "Felipe Haase", "pos": "PF", "min": 24, "pts": 11, "pir": 14, "ast": 2,
      "fg2m": 3, "fg2a": 5, "fg3m": 1, "fg3a": 4, "ftm": 2, "fta": 3, "oreb": 3, "dreb": 6 }
  ],
  "highlights": {
    "strengths": [
      "18 second-chance points from 12 offensive rebounds",
      "1.43 PPP on possessions that reached the paint"
    ],
    "weaknesses": [
      "16 failed tag-ups",
      "0.71 PPP in the third quarter"
    ],
    "notes": ["Free throws counted from C1/M1, not from the Foul Drawn tag"],
    "cards": [
      { "title": "Paint touch rate by quarter", "tag": "target 70%", "tone": "cool",
        "rows": [ {"name":"Q1","val":"68%","bar":68}, {"name":"Q2","val":"71%","bar":71},
                  {"name":"Q3","val":"49%","bar":49}, {"name":"Q4","val":"64%","bar":64} ] }
    ]
  }
}
```

### Error messages

`"stats.players[0]".name is required and must be a non-empty string.` · `.pos must be one of PG, SG, SF, PF, C, G, F, GF.` · `.pts must be a number, found string.` · `Unknown field "stl" in "stats.players[0]" — did you mean "ast"?` · `"stats.highlights.cards[0]".tone must be one of "good", "bad", "cool", "green" (or omitted).` · `"stats.highlights.cards[0]".rows must be a non-empty array of { name, val }.`

Warning: an empty `players` array with no highlights gives `"stats" has no players — the computed charts will be empty.`

---

## 4 · Game Plan

`⇩ JSON` on the GAME PLAN banner, or the `plan` key of the Report schema. Pre game only — Post game has no Game Plan section.

| Field | Type | Notes |
|---|---|---|
| `pool` | array of strings, or of `{ "name": "…" }` | the squad chips. Uppercased. Duplicates warn and are kept once. **Players you keep by name keep their minutes** |
| `pairs1` | array of `{ "us": "…", "them": "…" }` | first-rotation matchups |
| `pairs2` | array of `{ "us": "…", "them": "…" }` | second-rotation matchups |
| `offleg` | array of up to 4 strings | offense legend, one per colour |
| `defleg` | array of up to 4 strings | defense legend, one per colour |
| `grid` | `{ "Q1": rows, "Q2": rows }` | the minute board. **5 rows exactly**, in the order PG, SG, SF, PF, C. Each row is 10 cells, minute 10' down to 1' |
| `offbar` | `{ "Q1": [10 numbers], "Q2": [...] }` | the OFF colour strip. `0` = empty, `1`–`4` = colour |
| `defbar` | `{ "Q1": [10 numbers], "Q2": [...] }` | the DEF colour strip, same rule |

**Grid cells are player names, not ids.** Write `"DEVIN"`, not an internal id. A name that is not in `pool` is added to it automatically. `null` or `""` means an empty minute. Fewer or more than 10 cells warns and is padded or cut; a row count other than 5 is an error.

### Complete example

```json
{
  "plan": {
    "pool": ["DEVIN","GIAN","FERDI","SHELDON","CHIP","BENNY","TAJH","FELIPE","ZABA","EDDY"],
    "pairs1": [
      { "us": "Devin", "them": "#3 Weber" },
      { "us": "Felipe", "them": "#33 Kovac" }
    ],
    "pairs2": [
      { "us": "Gian", "them": "#11 Jansen" }
    ],
    "offleg": ["Drag PnR","Horns","Zone attack","Special"],
    "defleg": ["Man","2-3","Full press",""],
    "grid": {
      "Q1": [
        ["DEVIN","DEVIN","DEVIN","DEVIN","DEVIN","GIAN","GIAN","GIAN","GIAN","GIAN"],
        ["TAJH","TAJH","TAJH","TAJH","TAJH","TAJH","CHIP","CHIP","CHIP","CHIP"],
        ["FERDI","FERDI","FERDI","FERDI","BENNY","BENNY","BENNY","BENNY","FERDI","FERDI"],
        ["FELIPE","FELIPE","FELIPE","FELIPE","FELIPE","ZABA","ZABA","ZABA","ZABA","ZABA"],
        ["SHELDON","SHELDON","SHELDON","EDDY","EDDY","EDDY","EDDY","SHELDON","SHELDON","SHELDON"]
      ],
      "Q2": [[null,null,null,null,null,null,null,null,null,null],[],[],[],[]]
    },
    "offbar": { "Q1": [1,1,1,2,2,2,1,1,3,3], "Q2": [0,0,0,0,0,0,0,0,0,0] },
    "defbar": { "Q1": [1,1,1,1,1,1,2,2,2,2], "Q2": [0,0,0,0,0,0,0,0,0,0] }
  }
}
```

### Error messages

`"plan.pool[2]" must be a name, or { "name": "…" }.` · `"plan.grid.Q1" must have exactly 5 rows (PG, SG, SF, PF, C), found 2.` · `"plan.grid.Q1[0][3]" must be a player name or null.` · `"plan.offbar.Q1[0]" must be a whole number 0–4 (0 = empty, 1–4 = colour).` · `"plan.pairs1[0]" must be an object { us, them }.`

Warnings: a repeated name in `pool`, a legend longer than 4, a row or bar that is not exactly 10 long.

---

## 5 · Trends & comparison

**Post game / practice → `Trends & comparison`** — the wide button above the season grid. It loads the tagging CSVs from the two Drive folders once opened, and holds nothing of its own.

Three ranges: **Whole season**, **a month**, **a week**. Any range can be set against a second one in the `compare with` box; the table then reads `A → B` with the delta, green when it improved, red when it dropped.

Weeks run **game to game** as soon as every file in the post-game folder carries its date in the name (`G7 2026-10-05 VECHTA.csv`). Until then they are Monday–Sunday calendar weeks, and the panel says which of the two it is using. Game files with no date in the name are left out of every range and listed by name so you can see which ones.

Shown per range, practice and game on separate rows: sessions, possessions, points, PPP, paint-touch possessions and rate, reversal possessions and rate, offensive-rebound possessions, turnovers. Then three session-by-session charts: PPP, paint-touch rate and reversal rate, the last two with the 70% line drawn.

Practice and game rows are deliberately never added together. The two tagging routes still have no shared written definition of a ball reversal and do not use the same paint-touch criterion, so the figures are not the same measurement — the panel repeats this under the charts.

---

## 6 · File naming, so nothing needs configuring

Two date formats are read, and the ISO one wins if both appear in a name:

| In the name | Read as |
|---|---|
| `2026-09-19`, `2026-9-19`, `2026-9-1` | that date — padding is optional |
| `2026_09_19` | 2026-09-19 (four digits first always means year first) |
| `19_9_2026`, `19-9-2026`, `19.9.2026` | 2026-09-19 |
| `05_10_2026`, `5-10-2026` | 2026-10-05 |
| `19_9_26` | 2026-09-19 (a two-digit year is 20xx) |

**Day before month**, always, unless the name starts with a four-digit year. `10_9_2026` is 10 September; `2026-10-9` is 9 October. A month above 12, a day above 31 or a year outside 2000–2099 is refused rather than guessed, and the file is then treated as undated.

The two examples in the folder today: `2026-10-11 G6 CUP POSTGAME BREMERHAVEN.csv` → 11 October, `2026-9-19 G7 BBL TRIER.csv` → 19 September.

- **Post-game CSV** — `19_9_2026 G7 BBL TRIER.csv`, `10_9_2026 G6 CUP POSTGAME BREMERHAVEN.csv`. Two things are read out of the name: the **opponent**, matched against the game in the schedule, and the **date**. The opponent match is forgiving — `Eisbären Bremerhaven` in the schedule still finds `…BREMERHAVEN.csv`, because if the full name misses it retries on the longest word. The date is what puts the game on the trend charts and what separates two games against the same opponent.
- **Post-practice CSV** — `training-180926-2026-09-18.csv`. Matched by date only, exact or nothing; there is no closest-file fallback.

With both game files dated, the comparison view switches to **game-to-game weeks** on its own: everything from the day after one game up to and including the next.

## 7 · Asking for a file in a conversation

Enough context to hand to a fresh conversation:

> I use a basketball app with four JSON importers. Their schemas are in the document below.
> I am going to paste notes / a transcript. Turn them into a valid file for **&lt;schema name&gt;**, using only the fields listed, no invented keys, and give it to me as a single JSON block. Anything you cannot fill, leave out rather than guess — a missing field keeps whatever is already in the report.

Then paste this document.

The shortest version, for the thing you will do most often — turning voice notes into a report:

> Here are my notes for the pre game against &lt;opponent&gt;, &lt;date&gt;. Turn them into a Report JSON for the Coaches Hub: `summary` with the five slots, `offense` and `defense` as arrays of `{t, them, us}` using the default point titles. Only fields I actually gave you. One JSON block, nothing else.

Paste what comes back into `⇩ Import the whole report`, press **Validate & preview**, read the table, press **Apply**.
