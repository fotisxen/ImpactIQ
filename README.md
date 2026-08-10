# Box Score Analytics (desktop app)

Electron + Angular desktop app: upload a photo of a basketball box score,
OCR it via the Claude API, review/correct it, then get basic + advanced
stats for players, teams, and league averages.

## Structure

```
boxscore-app/
├── electron/               # Main process (Node) — never bundled by Angular
│   ├── main.js              # Window creation, app lifecycle
│   ├── preload.js           # Safe bridge exposed as window.boxscoreApi
│   ├── ipc.js                # IPC handlers wiring renderer <-> db/services
│   ├── db/
│   │   ├── schema.sql         # leagues, teams, players, games, box_scores
│   │   └── index.js           # SQLite init (better-sqlite3)
│   └── services/
│       ├── ocr.js             # Calls Claude API, extracts box score JSON
│       └── statsEngine.js     # Pure functions: TS%, PIR, per-36, compareTo, etc.
├── renderer/                # Angular 18 standalone app (the UI)
│   └── src/app/
│       ├── core/models/       # Shared TS types incl. the boxscoreApi bridge type
│       └── features/upload/   # Photo upload + review/edit table (first screen)
└── package.json             # Root scripts tying both halves together
```

## Setup

```bash
npm install                  # installs root (Electron) + renderer deps
export ANTHROPIC_API_KEY=sk-ant-...   # needed for the OCR call
```

## Run in dev mode (hot-reloading Angular + Electron window)

```bash
npm run dev
```

## Build a distributable

```bash
npm run build
```

## What's built so far

- Electron shell with a locked-down preload bridge (`contextIsolation: true`,
  no direct Node access from the renderer)
- SQLite schema for users/leagues/seasons/teams/players/games/box_scores
- **Local auth** (`electron/services/auth.js`) — signup/login stored hashed
  (Node's built-in `scrypt`, no external deps) in SQLite. No server, single
  machine. Login and signup screens both have a **"Skip for now — try as a
  guest"** button so you can click straight into the app without creating
  an account.
- **Demo mode for OCR**: if `ANTHROPIC_API_KEY` isn't set, `ocr.js` returns
  a canned example box score (with a short simulated delay) instead of
  erroring out, so the full upload → review → save → export flow is
  demoable with zero API billing configured. Delete the demo branch in
  `extractBoxScore()` once you add a real key.
- **Manual entry** (`features/manual-entry`) — same review/edit table as
  the photo upload flow, just starts blank instead of from OCR. Add/remove
  player rows freely.
- **Excel export** — the "Export to Excel" button on both upload and manual
  entry calls `window.boxscoreApi.exportExcel(...)`, which opens a native
  save dialog and writes a real `.xlsx` via `exceljs`
  (`electron/services/export.js`). Works on both raw box scores and (once
  wired into a dashboard) stat summaries.
- Stats engine (`electron/services/statsEngine.js`) with TS%, eFG%, PIR,
  per-36, and a generic `compareTo()` that works for player-vs-team,
  team-vs-league, or your-team-vs-public-league-average — same function,
  same shape
- IPC handlers for saving a reviewed game and reading back player/team/
  league stat summaries

## Try it right now (no setup beyond `npm install`)

```bash
npm install
npm run dev
```
Then on the login screen, click **"Skip for now — try the app as a guest"**.
Upload any image (or none — the demo fallback doesn't actually need a real
box score photo since no key is configured) and you'll see the demo data
flow through review → save button → export to Excel. Same for
`/manual-entry`.

## Redesign (current)

The app now has a real dark, sports-analytics design system
(`renderer/src/styles.scss` — CSS custom properties for color/spacing/type,
plus shared `.btn`/`.card`/`.field`/`.badge` classes) and an app shell
(`core/layout/app-shell.component.ts`) with sidebar nav and a topbar showing
the logged-in user (or "Guest") and a logout button.

- **Team/season picker** (`shared/components/game-context-picker.component.ts`)
  above the box-score table on both Upload and Manual Entry — picks
  League → Season → My Team → Opponent (with inline "+ New"), remembers the
  last-used league/season, and `saveGame` now gets real IDs instead of a
  `console.log` placeholder.
- **Dashboard** (`features/dashboard/`) — Player / Team / League segmented
  view with stat tiles (PTS, REB, AST, STL, BLK, TOV, TS%, eFG%, FG%, 3P%,
  FT%, PIR), a player-vs-team or team-vs-league bar-chart comparison, a
  per-game trend line, and a recent-games table. Backed by two new IPC
  endpoints, `db:get-player-game-log` / `db:get-team-game-log`, alongside the
  existing `getPlayerStats` / `getTeamStats` / `getLeagueAverages`.
- Charts via `chart.js` + `ng2-charts` (`provideCharts` in `app.config.ts`).
- Toasts (`shared/services/toast.service.ts`) replace the old plain-text
  "hint" feedback for save/export.

## Not built yet (next passes)

- Public league data ingestion job (EuroLeague/Greek league) to populate
  league-average comparisons beyond your own scanned games
- Usage Rate needs real team-game totals passed in — currently only
  wired for a single row, see `usageRate()` in `statsEngine.js`
- League/team CRUD is create-only from the picker (no rename/delete UI yet)
