/**
 * Loads real per-zone team shooting data into `shot_zones`, from a CSV
 * produced by any of this project's *_team_shot_zones_export.py scrapers
 * (all scraped from 3stepsbasket.com's shot chart pages, same CSV shape:
 * team_name,zone,fgm,fga).
 *
 * Team-level only (player_id NULL) — matches this app's existing
 * `db:import-shot-zones` semantics for a "team total" row.
 *
 * Usage:
 *   node _import_esake_team_shot_zones.js --dir ./data-import/out-esake-shot-zones --league "Greek Basket League" --dry-run
 *   node _import_esake_team_shot_zones.js --dir ./data-import/out-bcl-shot-zones --league "Basketball Champions League" --import
 *
 * Run via the Electron-bundled Node so better-sqlite3's native binding matches:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe _import_esake_team_shot_zones.js --dir ./data-import/out-esake-shot-zones --dry-run
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dirArgIdx = args.indexOf('--dir');
const DATA_DIR = dirArgIdx >= 0 ? args[dirArgIdx + 1] : './data-import/out-esake-shot-zones';
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
  const rows = loadCsv('team_shot_zones.csv');
  console.log(`Loaded ${rows.length} zone rows.`);

  const byTeam = new Map();
  for (const r of rows) {
    if (!byTeam.has(r.team_name)) byTeam.set(r.team_name, []);
    byTeam.get(r.team_name).push(r);
  }
  console.log(`Covers ${byTeam.size} teams: ${[...byTeam.keys()].join(', ')}`);

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
  const deleteExisting = db.prepare(`DELETE FROM shot_zones WHERE team_id = ? AND season_id = ? AND player_id IS NULL`);
  const insert = db.prepare(
    `INSERT INTO shot_zones (team_id, player_id, season_id, zone, fgm, fga) VALUES (?, NULL, ?, ?, ?, ?)`
  );

  let teamsImported = 0;
  const unmatched = [];
  const importTx = db.transaction(() => {
    for (const [teamName, zoneRows] of byTeam) {
      const team = findTeam.get(league.id, teamName);
      if (!team) { unmatched.push(teamName); continue; }
      deleteExisting.run(team.id, season.id);
      for (const r of zoneRows) {
        insert.run(team.id, season.id, r.zone, Number(r.fgm), Number(r.fga));
      }
      teamsImported++;
    }
  });
  importTx();

  console.log(`\nDone. Imported shot zones for ${teamsImported} team(s).`);
  if (unmatched.length > 0) {
    console.log(`WARNING: ${unmatched.length} team name(s) had no match in the "${LEAGUE_NAME}" teams table:`);
    for (const t of unmatched) console.log(`  "${t}"`);
  }
  db.close();
}

main();
