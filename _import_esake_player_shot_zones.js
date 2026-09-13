/**
 * Loads real per-zone player shooting data into `shot_zones`, from the CSV
 * produced by data-import/esake_player_shot_zones_export.py (scraped from
 * 3stepsbasket.com, matched to this app's own DB names via a two-gate
 * check: 5-stat Euclidean distance + Greek-transliteration surname
 * similarity — see matches.csv in the same output dir for the audit log).
 *
 * Player-level (player_id set, not NULL) — matches this app's existing
 * `db:import-shot-zones` semantics for a per-player row.
 *
 * CSV shape: team_name,player_name,zone,fgm,fga — player_name is already
 * this app's own DB-format name (Greek, "SURNAME FIRSTNAME"), so matching
 * is exact team_id+name, no further fuzzy matching needed at import time.
 *
 * Usage:
 *   node _import_esake_player_shot_zones.js --dir ./data-import/out-esake-player-shot-zones --dry-run
 *   node _import_esake_player_shot_zones.js --dir ./data-import/out-esake-player-shot-zones --import
 *
 * Run via the Electron-bundled Node so better-sqlite3's native binding matches:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe _import_esake_player_shot_zones.js --dir ./data-import/out-esake-player-shot-zones --dry-run
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dirArgIdx = args.indexOf('--dir');
const DATA_DIR = dirArgIdx >= 0 ? args[dirArgIdx + 1] : './data-import/out-esake-player-shot-zones';
const MODE = args.includes('--import') ? 'import' : 'dry-run';
const leagueArgIdx = args.indexOf('--league');
const LEAGUE_NAME = leagueArgIdx >= 0 ? args[leagueArgIdx + 1] : 'Greek Basket League';
const seasonArgIdx = args.indexOf('--season-label');
const SEASON_LABEL = seasonArgIdx >= 0 ? args[seasonArgIdx + 1] : '2025-26';

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

function main() {
  console.log(`Mode: ${MODE}, data dir: ${DATA_DIR}`);
  const rows = loadCsv('player_shot_zones.csv');
  console.log(`Loaded ${rows.length} zone rows.`);

  const byPlayer = new Map();
  for (const r of rows) {
    const key = `${r.team_name}${r.player_name}`;
    if (!byPlayer.has(key)) byPlayer.set(key, { teamName: r.team_name, playerName: r.player_name, rows: [] });
    byPlayer.get(key).rows.push(r);
  }
  const byTeamCount = new Map();
  for (const { teamName } of byPlayer.values()) byTeamCount.set(teamName, (byTeamCount.get(teamName) || 0) + 1);
  console.log(`Covers ${byPlayer.size} players across ${byTeamCount.size} teams:`);
  for (const [t, c] of byTeamCount) console.log(`  ${t}: ${c} players`);

  if (MODE === 'dry-run') {
    console.log('\nDry run complete. No database changes made. Re-run with --import to write.');
    return;
  }

  const Database = require('better-sqlite3');
  const dbPath = path.join(process.env.APPDATA, 'boxscore-analytics', 'boxscore.sqlite3');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const league = db.prepare(`SELECT id FROM leagues WHERE name = ?`).get(LEAGUE_NAME);
  if (!league) throw new Error(`League "${LEAGUE_NAME}" not found.`);
  const season = db.prepare(`SELECT id FROM seasons WHERE league_id = ? AND year = ?`).get(league.id, SEASON_LABEL);
  if (!season) throw new Error(`Season "${SEASON_LABEL}" not found for ${LEAGUE_NAME}.`);
  console.log(`League id ${league.id}, season id ${season.id}`);

  const findTeam = db.prepare(`SELECT id FROM teams WHERE league_id = ? AND name = ?`);
  const findPlayer = db.prepare(`SELECT id FROM players WHERE team_id = ? AND name = ?`);
  const deleteExisting = db.prepare(`DELETE FROM shot_zones WHERE player_id = ? AND season_id = ?`);
  const insert = db.prepare(
    `INSERT INTO shot_zones (team_id, player_id, season_id, zone, fgm, fga) VALUES (?, ?, ?, ?, ?, ?)`
  );

  let playersImported = 0;
  const unmatchedTeams = new Set();
  const unmatchedPlayers = [];
  const importTx = db.transaction(() => {
    for (const { teamName, playerName, rows: zoneRows } of byPlayer.values()) {
      const team = findTeam.get(league.id, teamName);
      if (!team) { unmatchedTeams.add(teamName); continue; }
      const player = findPlayer.get(team.id, playerName);
      if (!player) { unmatchedPlayers.push(`${teamName} / ${playerName}`); continue; }
      deleteExisting.run(player.id, season.id);
      for (const r of zoneRows) {
        insert.run(team.id, player.id, season.id, r.zone, Number(r.fgm), Number(r.fga));
      }
      playersImported++;
    }
  });
  importTx();

  console.log(`\nDone. Imported shot zones for ${playersImported} player(s).`);
  if (unmatchedTeams.size > 0) {
    console.log(`WARNING: ${unmatchedTeams.size} team name(s) had no match in the "${LEAGUE_NAME}" teams table:`);
    for (const t of unmatchedTeams) console.log(`  "${t}"`);
  }
  if (unmatchedPlayers.length > 0) {
    console.log(`WARNING: ${unmatchedPlayers.length} player(s) had no exact name match in their team's roster:`);
    for (const p of unmatchedPlayers) console.log(`  "${p}"`);
  }
  db.close();
}

main();
