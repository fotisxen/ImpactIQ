# Impact IQ — App Changes Since Last Website Update

This is a feature/capability summary of everything added or changed in the Impact IQ app (Electron + Angular desktop app, box score extraction + basketball analytics) since the website's `PROJECT_BRIEF.md` was written. Hand this to the website session so it can refresh copy, feature lists, and positioning. Organized by theme, not chronologically. Each item notes *what changed* and, where relevant, *why it might matter for site copy* — the actual marketing language is the website session's call, not dictated here.

---

## 1. Data entry — now three real ways in, not one

- **Photo upload + OCR** (existing) — extract a box score from a photo/screenshot.
- **Manual entry** (existing).
- **Play-by-play Excel import (new)** — parses EuroLeague-style play-by-play exports into a full, exact box score. More accurate than photo OCR (precise FT splits, exact shot types, fouls-drawn detail), and unlocks a real upgrade: **minutes played and +/- are measured** from substitution timestamps and score deltas, not left at zero like every other import path.

*Positioning note:* the play-by-play path is what unlocks the deepest tier of analytics below (real Net Rating, Impact Rating, lineup data). Worth framing as "the more data you give us, the deeper it gets" rather than implying every metric is available regardless of input method — the app itself is explicit about this tiering, and the site should be too.

## 2. Real advanced analytics — full taxonomy, not a token few stats

The app now computes a full, from-scratch advanced-stat suite (no cargo-culted formulas — every one derived and documented in the codebase):

- **Headline**: PIR, PER (Hollinger-style), Impact Score (from-scratch BPM-style composite), PIE, Net Rating (exact ORtg−DRtg for teams; real measured-+/- based for players, only when play-by-play data exists).
- **Scoring**: PPFT, PP2PS, PP3PS, Points/Shot, Points/Possession, Points/100 Possessions.
- **Shooting**: TS%, eFG%, FT Rate, 3PA Rate.
- **Rebounding**: OREB%, DREB%, TRB%.
- **Ball Handling**: AST%, STL%, BLK%, TOV%, USG%, AST/TOV, STL/TOV.
- **DOE**: Dean Oliver's Four Factors (weighted 40/25/20/15) plus ORtg/DRtg.

## 3. Real Impact Rating (RAPM) — an honest alternative to "fake LEBRON/EPM"

Built a genuine, from-scratch **adjusted plus-minus model (RAPM)** from real play-by-play lineup data — the same core technique real LEBRON/EPM are built on. Deliberately shows **one transparent "Impact Rating"**, not two arbitrarily-different "LEBRON" and "EPM" numbers, since the app doesn't have (and is honest about not having) the proprietary tracking-data ingredient that actually differentiates those two commercial models. Comes with a visible confidence level (Very Low → High) tied to how many play-by-play games back the number, so a thin sample is never presented as a settled rating.

*Positioning note:* this is a real differentiator — most tools in this space either skip on/off impact metrics entirely or present borrowed/unlabeled ones. "We compute a real adjusted plus-minus from your own data, and we tell you how much to trust it" is an honest, defensible claim.

## 4. New: Four Factors analysis page

A dedicated new page breaking a team down into:
- **Primary Metrics** — what actually happened (ORtg, DRtg, Net Rating, eFG%, TOV%, ORB%, FTr).
- **Context Metrics** — under what conditions (Pace, Opponent Quality, Lineup Combinations from play-by-play data, player positions).
- **Strategic Metrics** — why it may have happened (shown honestly as unavailable — this tier needs film/tracking data no box-score-based tool can produce).

Plus four weighted combo cards (Shooting 40% / Ball Handling 25% / Rebounding 20% / FT Rate 15%), each blending the core factor with real sub-metrics (Assisted FG%, Live-ball TOV%, Opponent ORB%, etc.).

**The core honesty principle, worth stating on the site plainly:** any metric the app cannot compute from real data is shown as an explicit "N/A" with the specific reason — never estimated, guessed, or silently faked. This app will tell you what it doesn't know.

## 5. Restructured, decluttered Dashboard

Player/Team/League dashboards were each broken from one long scrolling page into a trimmed Overview plus dedicated tabs (Basic Stats / Advanced Stats / Games, and for Teams also a Roster tab). New trend charts (points/PIE/PER per game), a Four-Factors progress-bar visual, capped "recent games" lists.

## 6. New visualizations

- **Bump chart** — season-long standings movement over time.
- **Win Probability chart** — in-game win-probability curve from real score/time data (clearly labeled as a generic estimate, not a per-league-calibrated model — no league has enough historical games yet for real calibration).
- **Percentile radar** (Opta-style) — a player vs. the league across key stat categories.
- **League Leaderboards**, moved to their own page with a curated stat-ranking dropdown (PTS, PER, OREB%, DREB%, TRB%, eFG%, 3PAr, PPFT).

## 7. Bigger competition coverage

**National cup competitions** added alongside existing domestic leagues — Greek Cup, Copa del Rey, Coppa Italia, Turkish Cup, Coupe de France, BBL-Pokal, LKL Cup, Israeli State Cup. A team/player's stats can now be tracked correctly across multiple competitions in the same season (league + cup), not just one.

## 8. Coach-facing export: per-team advanced report (Excel + PDF)

New export that produces every advanced metric as its own sheet/page, ranking the full roster best-to-worst — **as of any chosen point in the season**, not just full-season totals. Useful for genuinely in-season use (e.g., "show me the rankings through game 12"), not just an end-of-season summary.

## 9. Theming and polish

Full dark/light theme toggle (user-togglable, persisted), plus consistency polish across the stat-tile UI (uniform card sizing, standardized decimal precision).

## 10. Deeper box-score detail

New tracked stat: **SRJ** (shots rejected — shot attempts blocked by the opponent), alongside the existing PFD (fouls drawn) — more defensive-impact detail in the raw box score than typical box-score tools capture.

---

## The one thread to carry through all of the above

Every feature above was built under one non-negotiable rule: **never fabricate data.** If the app can compute something real from what's been entered, it shows it. If it can't, it says so explicitly, with the reason, rather than guessing or borrowing a number that isn't really measured. This shows up everywhere — the Impact Rating's confidence levels, the Four Factors page's honest N/A tiles, Net Rating requiring real play-by-play data before it'll show a number for a player at all. If the website has room for one core trust claim beyond "we have deep stats," this is probably it — it's true of the product today, not just aspirational copy.
