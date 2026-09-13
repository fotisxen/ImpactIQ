/**
 * Loads a Greek Basket League (Stoiximan GBL) season into the app's SQLite
 * DB, from the CSVs produced by data-import/esake_gbl_season_export.py.
 *
 * Simpler than _import_euroleague_full_season.js because esake.gr only gives
 * up real box scores — no play-by-play, no shot-location data, so this only
 * populates `games` and `box_scores`. Features that need game_events
 * (Net Rating, possession stats, lineup combos) will correctly show their
 * existing "not enough data" honesty-gate for these games, same as any other
 * non-PBP source (photo/manual entry) — nothing to fix there, it's already
 * built to handle this.
 *
 * Usage:
 *   node _import_esake_gbl_season.js --dir ./data-import/out-gbl --dry-run
 *   node _import_esake_gbl_season.js --dir ./data-import/out-gbl --import
 *
 * --import DELETES all existing games for this league+season first (games +
 * box_scores) and reimports from scratch — same reasoning as the EuroLeague
 * loader: cleaner to replace than to merge two derivations of the same games.
 *
 * Run via the Electron-bundled Node so better-sqlite3's native binding matches:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe _import_esake_gbl_season.js --dir ./data-import/out-gbl --dry-run
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dirArgIdx = args.indexOf('--dir');
const DATA_DIR = dirArgIdx >= 0 ? args[dirArgIdx + 1] : './data-import/out-gbl';
const MODE = args.includes('--import') ? 'import' : 'dry-run';
const leagueArgIdx = args.indexOf('--league');
const LEAGUE_NAME = leagueArgIdx >= 0 ? args[leagueArgIdx + 1] : 'Greek Basket League';
const seasonArgIdx = args.indexOf('--season-label');
const SEASON_LABEL = seasonArgIdx >= 0 ? args[seasonArgIdx + 1] : '2025-26';
// The season spans Oct (year N) through June (year N+1) — used to resolve
// "Sat 4 Oct - 16:00" (no year in the site's own date text) to a real date.
const seasonStartYearArgIdx = args.indexOf('--season-start-year');
const SEASON_START_YEAR = seasonStartYearArgIdx >= 0 ? Number(args[seasonStartYearArgIdx + 1]) : 2025;

// Greek team name (exactly as esake.gr renders it) -> the app's existing
// plain-name team row (from seed.js). Confirmed 1:1 against the 13 teams
// already seeded under "Greek Basket League".
const GREEK_TO_APP_NAME = {
  'ΑΕΚ': 'AEK',
  'ΑΡΗΣ': 'Aris',
  'ΗΡΑΚΛΗΣ': 'Iraklis',
  'ΚΑΡΔΙΤΣΑ ΙΑΠΩΝΙΚΗ': 'Karditsa',
  'ΚΟΛΟΣΣΟΣ H HOTELS COLLECTION': 'Kolossos Rodou',
  'ΜΑΡΟΥΣΙ': 'Maroussi',
  'ΜΥΚΟΝΟΣ Betsson BC': 'Mykonos',
  'ΟΛΥΜΠΙΑΚΟΣ': 'Olympiacos',
  'ΠΑΝΑΘΗΝΑΪΚΟΣ AKTOR': 'Panathinaikos',
  'ΠΑΝΙΩΝΙΟΣ COSMORAMA TRAVEL': 'Panionios',
  'ΠΑΟΚ': 'PAOK',
  'ΠΕΡΙΣΤΕΡΙ Betsson': 'Peristeri',
  'ΠΡΟΜΗΘΕΑΣ ΠΑΤΡΑΣ ΒΙΚΟΣ COLA': 'Promitheas Patras',
};

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "Sat 4 Oct - 16:00" -> "2025-10-04" (Oct-Dec = SEASON_START_YEAR, Jan-Sep = SEASON_START_YEAR+1). */
function parseGameDate(dateText) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})/.exec(dateText || '');
  if (!m) return null;
  const day = Number(m[1]);
  const monthAbbr = m[2];
  const month = MONTHS[monthAbbr];
  if (month === undefined) return null;
  const year = month >= 9 ? SEASON_START_YEAR : SEASON_START_YEAR + 1; // Oct(9)/Nov/Dec vs Jan-Sep
  const d = new Date(Date.UTC(year, month, day));
  return d.toISOString().slice(0, 10);
}

// ---------- CSV parsing (handles quoted fields with embedded commas) ----------
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { fields.push(cur); cur = ''; }
    else cur += c;
  }
  fields.push(cur);
  return fields;
}
function loadCsv(name) {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const rows = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = (fields[j] ?? '').trim();
    rows[i - 1] = row;
  }
  return rows;
}

function numOrZero(s) {
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

// ---------- Main ----------
function main() {
  console.log(`Mode: ${MODE}, data dir: ${DATA_DIR}, league: ${LEAGUE_NAME}, season: ${SEASON_LABEL}`);

  const rawGames = loadCsv('games.csv');
  const rawBoxscores = loadCsv('player_boxscores.csv');

  // Defensive dedup, independent of whether the source CSV was already fixed
  // upstream (esake_gbl_season_export.py used to write the same real
  // playoff game more than once — see its own idgame-dedup fix — and CSVs
  // scraped before that fix still have the duplication baked in). Keeps the
  // first-seen row per idgame (games) / per (idgame, side, name) (box score
  // rows), so importing an un-deduped CSV can never write a real game or a
  // player's box score line more than once.
  const seenGameIds = new Set();
  const games = rawGames.filter((g) => {
    if (seenGameIds.has(g.idgame)) return false;
    seenGameIds.add(g.idgame);
    return true;
  });
  const seenBoxKeys = new Set();
  const boxscores = rawBoxscores.filter((r) => {
    const key = `${r.idgame}::${r.side}::${r.name}`;
    if (seenBoxKeys.has(key)) return false;
    seenBoxKeys.add(key);
    return true;
  });
  if (rawGames.length !== games.length || rawBoxscores.length !== boxscores.length) {
    console.log(`Deduped source CSVs: ${rawGames.length - games.length} duplicate game row(s), ${rawBoxscores.length - boxscores.length} duplicate box score row(s) skipped.`);
  }
  console.log(`Loaded: ${games.length} games, ${boxscores.length} box score rows.`);
  if (games.length === 0) {
    console.log('No games.csv found / empty — nothing to do. Check --dir.');
    return;
  }

  const unknownTeams = new Set();
  for (const g of games) {
    if (!GREEK_TO_APP_NAME[g.home_team]) unknownTeams.add(g.home_team);
    if (!GREEK_TO_APP_NAME[g.away_team]) unknownTeams.add(g.away_team);
  }
  if (unknownTeams.size > 0) {
    console.log(`WARNING: ${unknownTeams.size} team name(s) not in GREEK_TO_APP_NAME, will be auto-created as-is:`);
    for (const t of unknownTeams) console.log(`  "${t}"`);
  }

  const boxByGame = new Map();
  for (const r of boxscores) {
    if (!boxByGame.has(r.idgame)) boxByGame.set(r.idgame, []);
    boxByGame.get(r.idgame).push(r);
  }

  if (MODE === 'dry-run') {
    const sample = games[0];
    console.log(`\nSample game: ${sample.home_team} vs ${sample.away_team}, ${sample.date_text} -> ${parseGameDate(sample.date_text)}`);
    console.log('Dry run complete. No database changes made. Re-run with --import to write.');
    return;
  }

  runImport({ games, boxByGame });
}

function runImport({ games, boxByGame }) {
  const Database = require('better-sqlite3');
  const dbPath = path.join(process.env.APPDATA, 'boxscore-analytics', 'boxscore.sqlite3');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const league = db.prepare(`SELECT id FROM leagues WHERE name = ?`).get(LEAGUE_NAME);
  if (!league) throw new Error(`League "${LEAGUE_NAME}" not found — is it in seed.js?`);
  const leagueId = league.id;

  let season = db.prepare(`SELECT id FROM seasons WHERE league_id = ? AND year = ?`).get(leagueId, SEASON_LABEL);
  const seasonId = season
    ? season.id
    : db.prepare(`INSERT INTO seasons (league_id, year) VALUES (?, ?)`).run(leagueId, SEASON_LABEL).lastInsertRowid;
  console.log(`Season "${SEASON_LABEL}" -> id ${seasonId}`);

  // Per-game replace, NOT a wholesale season delete — this loader is used for
  // separately-scraped phases (regular season, then playoffs, run as two
  // independent commands against the same season). A wholesale "delete every
  // game in this season" here would wipe out the OTHER phase's games the
  // moment a second phase gets imported (this actually happened once — the
  // Greek Basket League's playoffs import deleted its already-imported
  // regular season). Matching on (date, home, away) instead makes re-running
  // the exact same phase idempotent while leaving every other phase's games
  // untouched.
  //
  // Deletes ALL matching rows, not just one — if the same (date, home, away)
  // tuple somehow already has more than one row (e.g. a since-fixed source
  // CSV that used to write the same real game more than once), a `.get()`
  // that only deletes the first match would leave the rest behind forever,
  // since re-running only ever converges by one row per run.
  const findExistingGames = db.prepare(
    `SELECT id FROM games WHERE season_id = ? AND date = ? AND home_team_id = ? AND away_team_id = ?`
  );
  function replaceGameIfExists(seasonId, date, homeTeamId, awayTeamId) {
    const existing = findExistingGames.all(seasonId, date, homeTeamId, awayTeamId);
    for (const row of existing) {
      db.prepare(`DELETE FROM box_scores WHERE game_id = ?`).run(row.id);
      db.prepare(`DELETE FROM game_events WHERE game_id = ?`).run(row.id);
      db.prepare(`DELETE FROM games WHERE id = ?`).run(row.id);
    }
  }

  const findTeam = db.prepare(`SELECT id FROM teams WHERE league_id = ? AND UPPER(name) = UPPER(?)`);
  const insertTeam = db.prepare(`INSERT INTO teams (league_id, name, is_my_team) VALUES (?, ?, 0)`);
  const teamIdByGreekName = new Map();
  function teamIdFor(greekName) {
    if (teamIdByGreekName.has(greekName)) return teamIdByGreekName.get(greekName);
    const appName = GREEK_TO_APP_NAME[greekName] || greekName;
    let row = findTeam.get(leagueId, appName);
    const id = row ? row.id : insertTeam.run(leagueId, appName).lastInsertRowid;
    teamIdByGreekName.set(greekName, id);
    return id;
  }

  const findPlayer = db.prepare(`SELECT id FROM players WHERE team_id = ? AND name = ?`);
  const insertPlayer = db.prepare(`INSERT INTO players (team_id, name) VALUES (?, ?)`);
  function playerIdFor(teamId, name) {
    const row = findPlayer.get(teamId, name);
    return row ? row.id : insertPlayer.run(teamId, name).lastInsertRowid;
  }

  const insertGame = db.prepare(
    `INSERT INTO games (season_id, date, home_team_id, away_team_id, source) VALUES (?, ?, ?, ?, 'photo')`
  );
  const insertBoxScore = db.prepare(
    `INSERT INTO box_scores (game_id, player_id, min, pts, fgm, fga, tpm, tpa, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pfd, plus_minus, srj)
     VALUES (@gameId, @playerId, @min, @pts, @fgm, @fga, @tpm, @tpa, @ftm, @fta, @oreb, @dreb, @ast, @stl, @blk, @tov, @pf, @pfd, 0, @srj)`
  );

  let gamesImported = 0;
  let playersImported = 0;
  let skippedNoBoxscore = 0;

  const importTx = db.transaction(() => {
    for (const g of games) {
      const boxRows = boxByGame.get(g.idgame);
      if (!boxRows || boxRows.length === 0) {
        skippedNoBoxscore++;
        continue;
      }
      const date = parseGameDate(g.date_text);
      if (!date) {
        console.log(`  idgame ${g.idgame}: could not parse date "${g.date_text}", skipping.`);
        continue;
      }

      const homeTeamId = teamIdFor(g.home_team);
      const awayTeamId = teamIdFor(g.away_team);
      replaceGameIfExists(seasonId, date, homeTeamId, awayTeamId);
      const gameId = insertGame.run(seasonId, date, homeTeamId, awayTeamId).lastInsertRowid;

      for (const r of boxRows) {
        const teamId = r.side === 'home' ? homeTeamId : r.side === 'away' ? awayTeamId : null;
        if (!teamId) continue;
        const dbPlayerId = playerIdFor(teamId, r.name);
        insertBoxScore.run({
          gameId, playerId: dbPlayerId,
          min: Math.round(numOrZero(r.minutes) * 10) / 10,
          pts: numOrZero(r.pts),
          fgm: numOrZero(r.fgm2) + numOrZero(r.tpm), fga: numOrZero(r.fga2) + numOrZero(r.tpa),
          tpm: numOrZero(r.tpm), tpa: numOrZero(r.tpa),
          ftm: numOrZero(r.ftm), fta: numOrZero(r.fta),
          oreb: numOrZero(r.oreb), dreb: numOrZero(r.dreb), ast: numOrZero(r.ast),
          stl: numOrZero(r.stl), blk: numOrZero(r.blk), tov: numOrZero(r.tov),
          pf: numOrZero(r.pf), pfd: numOrZero(r.pfd), srj: numOrZero(r.blk_against),
        });
        playersImported++;
      }

      gamesImported++;
      if (gamesImported % 25 === 0) console.log(`  ...${gamesImported} games imported`);
    }
  });

  importTx();

  console.log(`\nDone. Imported ${gamesImported} games (skipped ${skippedNoBoxscore} with no box score data), ${playersImported} player-game box scores.`);
  db.close();
}

main();
