/**
 * Loads a season's box scores into the app's SQLite DB from CSVs produced by
 * EITHER bcl_season_export.py OR fiba_europe_cup_season_export.py — both
 * scrapers write the exact same CSV shape (same underlying FIBA site
 * template), so one loader covers both. Like the Greek Basket League loader,
 * this only populates `games` and `box_scores` — no play-by-play or shot
 * locations exist on these sites, so game_events stays empty for these games
 * (Net Rating / possession-stat features correctly show their existing "not
 * enough data" gate, same as any other non-PBP source).
 *
 * Usage:
 *   node _import_fiba_boxscore_season.js --dir ./data-import/out-bcl --league "Basketball Champions League" --dry-run
 *   node _import_fiba_boxscore_season.js --dir ./data-import/out-bcl --league "Basketball Champions League" --import
 *   node _import_fiba_boxscore_season.js --dir ./data-import/out-fec --league "FIBA Europe Cup" --import
 *
 * --import DELETES all existing games for this league+season first (games +
 * box_scores) and reimports from scratch, same reasoning as every other
 * loader this session.
 *
 * Run via the Electron-bundled Node so better-sqlite3's native binding matches:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe _import_fiba_boxscore_season.js --dir ./data-import/out-bcl --league "Basketball Champions League" --dry-run
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}

const DATA_DIR = argVal('--dir', './data-import/out-bcl');
const MODE = args.includes('--import') ? 'import' : 'dry-run';
const LEAGUE_NAME = argVal('--league', null);
const SEASON_LABEL = argVal('--season-label', '2025-26');

if (!LEAGUE_NAME) {
  console.error('ERROR: --league is required, e.g. --league "Basketball Champions League" or --league "FIBA Europe Cup"');
  process.exit(1);
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

function parseMinutes(s) {
  // "MM:SS" (FIBA's own box scores use plain minutes:seconds, no hours).
  const m = /^(\d+):(\d+)$/.exec((s || '').trim());
  if (!m) return 0;
  return Number(m[1]) + Number(m[2]) / 60;
}

// ---------- Main ----------
function main() {
  console.log(`Mode: ${MODE}, data dir: ${DATA_DIR}, league: ${LEAGUE_NAME}, season: ${SEASON_LABEL}`);

  const games = loadCsv('games.csv');
  const boxscores = loadCsv('player_boxscores.csv');
  console.log(`Loaded: ${games.length} games, ${boxscores.length} box score rows.`);
  if (games.length === 0) {
    console.log('No games.csv found / empty — nothing to do. Check --dir.');
    return;
  }

  const missingDates = games.filter((g) => !g.date).length;
  if (missingDates > 0) {
    console.log(`WARNING: ${missingDates} game(s) have no date captured — they will be skipped (games.date is required).`);
  }

  const boxByGame = new Map();
  for (const r of boxscores) {
    if (!boxByGame.has(r.game_id)) boxByGame.set(r.game_id, []);
    boxByGame.get(r.game_id).push(r);
  }

  if (MODE === 'dry-run') {
    const sample = games[0];
    console.log(`\nSample game: ${sample.team_a} vs ${sample.team_b} (${sample.score_a}-${sample.score_b}), ${sample.date}${sample.phase ? ', phase ' + sample.phase : ''}`);
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

  // Per-game replace, NOT a wholesale season delete — this loader is run
  // separately per phase (e.g. Regular Season, then Play-ins, then Round of
  // 16, ... for BCL; or against however many matchdays FIBA Europe Cup was
  // scraped in). A wholesale "delete every game in this season" here would
  // wipe out every OTHER phase's already-imported games the moment a new
  // phase gets imported (this happened for real once, on the Greek Basket
  // League loader — same bug pattern, fixed the same way there too).
  // Matching on (date, home, away) instead makes re-running the same phase
  // idempotent while leaving every other phase's games untouched.
  const findExistingGame = db.prepare(
    `SELECT id FROM games WHERE season_id = ? AND date = ? AND home_team_id = ? AND away_team_id = ?`
  );
  function replaceGameIfExists(seasonId, date, homeTeamId, awayTeamId) {
    const existing = findExistingGame.get(seasonId, date, homeTeamId, awayTeamId);
    if (!existing) return;
    db.prepare(`DELETE FROM box_scores WHERE game_id = ?`).run(existing.id);
    db.prepare(`DELETE FROM game_events WHERE game_id = ?`).run(existing.id);
    db.prepare(`DELETE FROM games WHERE id = ?`).run(existing.id);
  }

  const findTeam = db.prepare(`SELECT id FROM teams WHERE league_id = ? AND UPPER(name) = UPPER(?)`);
  const insertTeam = db.prepare(`INSERT INTO teams (league_id, name, is_my_team) VALUES (?, ?, 0)`);
  const teamIdByName = new Map();
  function teamIdFor(name) {
    if (teamIdByName.has(name)) return teamIdByName.get(name);
    let row = findTeam.get(leagueId, name);
    const id = row ? row.id : insertTeam.run(leagueId, name).lastInsertRowid;
    teamIdByName.set(name, id);
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
     VALUES (@gameId, @playerId, @min, @pts, @fgm, @fga, @tpm, @tpa, @ftm, @fta, @oreb, @dreb, @ast, @stl, @blk, @tov, @pf, 0, @plus_minus, 0)`
  );

  let gamesImported = 0;
  let playersImported = 0;
  let skipped = 0;

  const importTx = db.transaction(() => {
    for (const g of games) {
      if (!g.date) { skipped++; continue; }
      const boxRows = boxByGame.get(g.game_id);
      if (!boxRows || boxRows.length === 0) { skipped++; continue; }

      const homeTeamId = teamIdFor(g.team_a);
      const awayTeamId = teamIdFor(g.team_b);
      replaceGameIfExists(seasonId, g.date, homeTeamId, awayTeamId);
      const gameId = insertGame.run(seasonId, g.date, homeTeamId, awayTeamId).lastInsertRowid;

      for (const r of boxRows) {
        if (r.dnp === 'True') continue; // no minutes/stats to insert for a DNP player
        const teamId = r.team === g.team_a ? homeTeamId : r.team === g.team_b ? awayTeamId : null;
        if (!teamId) continue;
        const dbPlayerId = playerIdFor(teamId, r.name);
        // FIBA's own 2PT/3PT/FT are already split; total FG = 2PT makes/attempts + 3PT makes/attempts.
        const fgm = numOrZero(r.tpm2) + numOrZero(r.tpm3);
        const fga = numOrZero(r.tpa2) + numOrZero(r.tpa3);
        insertBoxScore.run({
          gameId, playerId: dbPlayerId,
          min: Math.round(parseMinutes(r.minutes_text) * 10) / 10,
          pts: numOrZero(r.pts), fgm, fga,
          tpm: numOrZero(r.tpm3), tpa: numOrZero(r.tpa3),
          ftm: numOrZero(r.ftm), fta: numOrZero(r.fta),
          oreb: numOrZero(r.oreb), dreb: numOrZero(r.dreb), ast: numOrZero(r.ast),
          stl: numOrZero(r.stl), blk: numOrZero(r.blk), tov: numOrZero(r.tov), pf: numOrZero(r.pf),
          plus_minus: numOrZero(r.plus_minus),
        });
        playersImported++;
      }

      gamesImported++;
      if (gamesImported % 25 === 0) console.log(`  ...${gamesImported} games imported`);
    }
  });

  importTx();

  console.log(`\nDone. Imported ${gamesImported} games (skipped ${skipped}), ${playersImported} player-game box scores.`);
  db.close();
}

main();
