/**
 * Loads Greek Cup (Kypello Elladas) games — scoped to the app's 13 seeded
 * top-tier clubs' own games only — from the CSVs produced by
 * data-import/greek_cup_season_export.py (scraped from stats.basket.gr, the
 * Hellenic Basketball Federation's own stats platform; esake.gr has no Cup
 * coverage of its own).
 *
 * Same per-game replace pattern as the other esake-family loaders (NOT a
 * wholesale season delete) — this loader gets run once per phase
 * ("4th Phase", then "Final-8") against the same season, and a wholesale
 * delete would wipe out whichever phase was imported first.
 *
 * Usage:
 *   node _import_greek_cup_season.js --dir ./data-import/out-greek-cup --dry-run
 *   node _import_greek_cup_season.js --dir ./data-import/out-greek-cup --import
 *
 * Run via the Electron-bundled Node so better-sqlite3's native binding matches:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe _import_greek_cup_season.js --dir ./data-import/out-greek-cup --dry-run
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dirArgIdx = args.indexOf('--dir');
const DATA_DIR = dirArgIdx >= 0 ? args[dirArgIdx + 1] : './data-import/out-greek-cup';
const MODE = args.includes('--import') ? 'import' : 'dry-run';
const LEAGUE_NAME = 'Greek Cup';
const SEASON_LABEL = '2025-26';

function loadCsv(name) {
  const p = path.join(DATA_DIR, name);
  const text = fs.readFileSync(p, 'utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const fields = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = fields[i]; });
    return row;
  });
}

function numOrZero(s) {
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

/** "17:49" -> 17.817 decimal minutes. */
function parseMinutes(s) {
  const m = /^(\d+):(\d+)$/.exec((s || '').trim());
  if (!m) return 0;
  return Math.round((Number(m[1]) + Number(m[2]) / 60) * 1000) / 1000;
}

function main() {
  console.log(`Mode: ${MODE}, data dir: ${DATA_DIR}`);
  const games = loadCsv('games.csv');
  const boxscores = loadCsv('player_boxscores.csv');
  console.log(`Loaded: ${games.length} games, ${boxscores.length} box score rows.`);
  if (games.length === 0) {
    console.log('No games.csv found / empty — nothing to do.');
    return;
  }

  const boxByGame = new Map();
  for (const r of boxscores) {
    if (!boxByGame.has(r.idgame)) boxByGame.set(r.idgame, []);
    boxByGame.get(r.idgame).push(r);
  }

  if (MODE === 'dry-run') {
    const sample = games[0];
    console.log(`\nSample game: ${sample.home_team} ${sample.home_score} - ${sample.away_score} ${sample.away_team} (${sample.date}, ${sample.phase})`);
    console.log('Dry run complete. No database changes made. Re-run with --import to write.');
    return;
  }

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
  function teamIdFor(appName) {
    const row = findTeam.get(leagueId, appName);
    return row ? row.id : insertTeam.run(leagueId, appName).lastInsertRowid;
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
     VALUES (@gameId, @playerId, @min, @pts, @fgm, @fga, @tpm, @tpa, @ftm, @fta, @oreb, @dreb, @ast, @stl, @blk, @tov, @pf, 0, 0, 0)`
  );

  let gamesImported = 0;
  let playersImported = 0;

  const importTx = db.transaction(() => {
    for (const g of games) {
      const boxRows = boxByGame.get(g.idgame);
      if (!boxRows || boxRows.length === 0) continue;
      if (!g.date) {
        console.log(`  idgame ${g.idgame}: no date, skipping.`);
        continue;
      }

      const homeTeamId = teamIdFor(g.home_team);
      const awayTeamId = teamIdFor(g.away_team);
      replaceGameIfExists(seasonId, g.date, homeTeamId, awayTeamId);
      const gameId = insertGame.run(seasonId, g.date, homeTeamId, awayTeamId).lastInsertRowid;

      for (const r of boxRows) {
        const teamId = r.team === g.home_team ? homeTeamId : r.team === g.away_team ? awayTeamId : null;
        if (!teamId) continue;
        const dbPlayerId = playerIdFor(teamId, r.name);
        insertBoxScore.run({
          gameId, playerId: dbPlayerId,
          min: parseMinutes(r.min),
          pts: numOrZero(r.pts),
          fgm: numOrZero(r.fgm), fga: numOrZero(r.fga),
          tpm: numOrZero(r.threem), tpa: numOrZero(r.threea),
          ftm: numOrZero(r.ftm), fta: numOrZero(r.fta),
          oreb: numOrZero(r.oreb), dreb: numOrZero(r.dreb), ast: numOrZero(r.ast),
          stl: numOrZero(r.stl), blk: numOrZero(r.blk), tov: numOrZero(r.to),
          pf: numOrZero(r.pf),
        });
        playersImported++;
      }

      gamesImported++;
    }
  });

  importTx();

  console.log(`\nDone. Imported ${gamesImported} games, ${playersImported} player-game box scores.`);
  db.close();
}

main();
