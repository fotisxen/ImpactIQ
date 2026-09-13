# Data Import Pipeline — How It Works, and How to Replicate It Yourself

This covers exactly what each script requests (URLs, params, methods — so you
can reproduce any of it in Postman or a browser), and how the data gets from
"a website" into the app's own database. Six competitions, four genuinely
different techniques, because the four data sources are built differently.

Every pipeline is the same two-step shape:
1. **A Python script** talks to the real data source and writes plain CSV files.
2. **A Node script** reads those CSVs and writes into the app's SQLite database
   (at `%APPDATA%\boxscore-analytics\boxscore.sqlite3`).

Nothing touches the database directly from Python — CSVs are the handoff
point, so you can inspect/edit them, or feed the Node loader from a different
source entirely, without touching the scrapers.

---

## 1. EuroLeague & EuroCup — a real public REST API

**Script:** `euroleague_full_season_export.py` → **Loader:** `_import_euroleague_full_season.js`

This is the good case: EuroLeague Basketball (the company that runs both
EuroLeague and EuroCup) has a genuine, free, public JSON API. We use it via
the `euroleague_api` Python package, but every call it makes is just a plain
GET request — here's what's actually happening underneath, so you can hit it
directly from Postman if you want:

**Base hosts:**
- `https://api-live.euroleague.net/v1/...` — schedule/results
- `https://live.euroleague.net/api/...` — box scores, play-by-play, shot data

**Example requests** (no auth, no API key — just GET):
```
GET https://api-live.euroleague.net/v1/results?seasonCode=E2025
GET https://live.euroleague.net/api/Boxscore?gamecode=1&seasoncode=E2025
GET https://live.euroleague.net/api/PlayByPlay?gamecode=1&seasoncode=E2025
GET https://live.euroleague.net/api/Points?gamecode=1&seasoncode=E2025      ← this is the shot data
```
`seasonCode` is `E` (EuroLeague) or `U` (EuroCup) + the season's start year
(`E2025` = 2025-26). `gamecode` is a plain sequential integer covering the
*entire* season — regular season, play-ins, playoffs, and Final Four are just
later gamecodes in the same sequence; there's no separate endpoint per phase.

There's also a v2/v3 "team stats" and "team stats leaders" family of
endpoints (used for the official cross-check CSVs the script writes) — see
`fetch_team_advanced_official()` in the script for the exact calls, or just
run the script with `--out` pointed somewhere and read the resulting
`team_stats_official_*.csv` files' column headers.

**Why we use the `euroleague_api` package instead of raw requests:** it
already handles pagination across a whole season (calling the per-game
endpoint once per gamecode) and some response-shape quirks. The script adds
retry/backoff on top (confirmed necessary — the API rate-limits after a few
dozen rapid requests) since the package itself has none.

**Gotchas you'll hit if you call this yourself:**
- `Minutes` comes back as a string like `"33:21"` or `"DNP"`, not decimal.
- Every response includes a synthetic **"Total" row per team** in the box
  score — filter out any row where `Player_ID` doesn't start with `P`.
- Shot data's `FASTBREAK` / `SECOND_CHANCE` / `POINTS_OFF_TURNOVER` fields
  come back as the **strings** `"0"`/`"1"`, not real booleans.

---

## 2. Greek Basket League (Stoiximan GBL) — plain HTML, no API

**Script:** `esake_gbl_season_export.py` → **Loader:** `_import_esake_gbl_season.js`

esake.gr has no documented API, but it's a plain server-rendered site (no
JavaScript needed to see real data) that accepts ordinary GET query params.
`requests` + BeautifulSoup is enough — no browser required.

**The schedule/results list** (one round at a time):
```
GET https://www.esake.gr/en/action/EsakeResults
    ?idchampionship=44B80BEB      (this season's internal ID — see below)
    &idseason=00000001            (00000001 = regular season "Α Φάση", 00000002 = playoffs "Β Φάση")
    &series=01                    (round number for regular season, or a code like QF1/SF1/F1 for playoffs)
```
Response is HTML; each game appears as a `<div class="esake-program-game">`
block containing the date, both team names, the final score, and a link to
the box score (see below). **Important:** the response's `Content-Type`
header doesn't declare a charset, so `requests` defaults to guessing wrong —
you must set `r.encoding = 'utf-8'` yourself or the Greek text comes out as
mojibake.

**One game's box score:**
```
GET https://www.esake.gr/en/action/EsakegameView?idgame=D6867DA7&mode=3
```
`idgame` is an 8-character hex ID found in the results list's box-score link
(`mode=3` is stats; `mode=2` is play-by-play — see below). The response has
two `<table class="table-esake table-sorter">` elements (one per team), 17
columns each: `#, PLAYER, P, 2PM-A, 3PM-A, FTM-A, REBS, D.REBS, O.REBS, AST,
BLK, BLK-A, FOULS F, FOULS M, STL, TO, TIM.PL., RANK`. `FOULS F` = committed,
`FOULS M` = drawn. A `TΕΑΜ - BENCH` row holds unattributed team rebounds/TOs
(no single player to credit them to — skipped), and a `TOTAL` row.

**How to find `idchampionship` for a different season:** load
`https://www.esake.gr/en/action/EsakeResults` in a browser, open dev tools,
and read the `<option value="...">` values in the season `<select>` — each
past season (back to 1992-93) has its own ID.

**Play-by-play was investigated but not used**: a "Play by Play" link exists
per game (`mode=2`), but the rendered page shows no event data via a direct
URL — it likely needs deeper client-side interaction not worth chasing given
box scores alone already cover everything the app's core features need.

---

## 3. Basketball Champions League & FIBA Europe Cup — real browser required

**Scripts:** `bcl_season_export.py`, `fiba_europe_cup_season_export.py` →
**Loader:** `_import_fiba_boxscore_season.js` (shared — both sites use the
identical underlying page template)

These two are the hard case, and Postman won't help here — **the box score
data is not in the HTML response at all.** It's a React app that only
renders the stats into the page after JavaScript runs and a "Boxscore" tab
is clicked. A plain GET gets you an empty shell. On top of that, the site's
bot-protection **blocks a default headless browser outright** ("The request
is blocked") — you need specific flags to get past it. This is why these two
scripts use Playwright (a real, scriptable Chromium) instead of `requests`.

**The two working recipes, if you want to replicate this in your own
tooling** (Playwright, Puppeteer, Selenium — any of them):
1. Launch Chromium with `--disable-blink-features=AutomationControlled` and a
   realistic desktop `User-Agent` string. Without both of these you get
   blocked before the page even loads.
2. Accept the cookie consent banner (a button literally labeled "I accept").
3. Click the tab/button whose text starts with `"Boxscore"`.
4. The now-visible `<table>` has one team's box score. Click the *other*
   team's name (it's also a button, labeled with that team's exact name) to
   flip the same table to their stats.
5. Parse the table's real `<tr>`/`<td>` cells (not `.innerText()` — a
   flattened text blob desynchronizes on the first row that doesn't match the
   expected shape, e.g. a DNP player; real DOM cells don't have this
   problem). 18 cells for a played row: `[#, "Name * POS", MIN, PTS, FG,
   2PT FG, 3PT FG, FT, OREB, DREB, REB, AST, PF, TO, STL, BLK, +/-, EFF]`.
   4 cells for DNP: `[#, Name, "Did Not Play", ""]`.

**Where the pages live** — this is the part that actually differs between
the two sites, and where I originally went looking in the wrong place:

- **FIBA Europe Cup**: `https://www.fiba.basketball/en/events/fiba-europe-cup-25-26/games`
  — one continuously-updated microsite. Real matchday-date buttons
  (`2025Wed24SEP`, `2025Tue14OCT`, ...) reveal that date's games when
  clicked; clicking through every date covers the whole season including the
  Finals (there's no separate playoff phase here — it's all one list).

- **Basketball Champions League**: **do not use** `championsleague.basketball`
  (its own custom domain) for anything more than a season old — it **prunes
  completed seasons' game pages** once a new season starts (confirmed: a
  real, Google-indexed 2025-26 Final page returns a soft-404 there today).
  The permanent archive instead lives under fiba.basketball's own history
  section:
  ```
  https://www.fiba.basketball/en/history/112-fiba-mens-european-club-competitions-tier-1/208962/games
  ```
  (`208962` is the 2025-26 season's internal ID; a different season has a
  different number — find it by Google-searching
  `site:fiba.basketball history "basketball champions league" <season>`).
  This page shows **all 96 regular-season games on one scrollable list**
  (no clicking needed), plus four separate phase-filter buttons — `Play-ins`,
  `Round of 16`, `Quarter-Finals`, `Final Four` — each revealing that phase's
  games when clicked.

**Why this is slow**: each game needs a real page load + cookie-accept (once
per fresh page) + two button clicks, roughly 8-12 seconds per game end to
end. For ~350 games across both competitions combined, budget real time —
this is not a "run it and it's done in a minute" scrape like the other two.

**Resilience built into both scripts** (learned the hard way, mid-scrape):
- Every game's result is written to the CSV **immediately**, not batched to
  the end — so Ctrl+C or a crash doesn't lose already-scraped games.
- Re-running the exact same command **skips games already in the output
  CSV** rather than re-scraping them — safe to stop and resume anytime.
- The browser page is **recycled every 25 games** (closed and reopened) —
  a single long-lived tab across 100+ real page loads eventually crashes the
  renderer (confirmed: hit this for real on game 90 of a 176-game run). If a
  crash happens anyway, the script opens a fresh page and retries that one
  game before moving on, instead of taking the whole run down.

---

## The Node loader side — how CSVs become database rows

Every loader (`_import_euroleague_full_season.js`,
`_import_esake_gbl_season.js`, `_import_fiba_boxscore_season.js`) follows the
same shape:

1. Look up (or create) the `leagues` / `seasons` rows the data belongs to.
2. For each game in the CSV: look up (or auto-create) both teams by name,
   look up (or create) each player by name within their team, insert the
   `games` row, then insert one `box_scores` row per player.
3. **Only replace a game if the exact same (date, home team, away team)
   already exists** — never a wholesale "delete everything in this season
   first". This matters because these loaders get run multiple times against
   the *same* season for *different phases* (regular season, then playoffs,
   run as separate commands) — a wholesale delete would wipe out whichever
   phase was imported first the moment the second one runs (this happened
   for real once, on the Greek Basket League data, before the fix).

Run any loader with `--dry-run` first — it prints what it *would* do without
touching the database, which is the safe way to sanity-check a fresh CSV
before committing to `--import`.

---

## On keeping this going day-to-day (once live)

**Recommendation: a single script you run yourself after each day's games
are final, not a silent background job.** Two of the six sources (BCL, FIBA
Europe Cup) depend on browser automation against a site with active
bot-protection — the kind of thing that can silently start failing when the
site changes something, with no one around to notice if it's running
unattended overnight. A script you run and watch the output of once a day
is far more trustworthy than a cron job quietly failing for a week.

The genuinely useful next step here, when you're ready for it: one small
wrapper script that, for each of the six leagues, checks whether there's a
new completed game since the last successful import and — if so — runs that
league's existing scrape+load pipeline automatically for just that game (not
the whole season each time). That's a real, scoped feature to build, not
something to improvise inline here — happy to build it whenever you want to
lock in exactly how "check for new games" should work per source.
