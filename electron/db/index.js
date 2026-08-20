const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');
const Database = require('better-sqlite3');
const { seedLeaguesAndTeams, ensureCurrentSeasons } = require('./seed');

function initDb() {
  const userDataDir = app.getPath('userData');
  const dbPath = path.join(userDataDir, 'boxscore.sqlite3');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  migrate(db);
  seedLeaguesAndTeams(db);
  ensureCurrentSeasons(db);

  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` in schema.sql doesn't add columns to a table
 * that already exists on the user's machine, so new columns need an
 * explicit, idempotent ALTER TABLE here — checked against the live schema
 * rather than a version number, so it's safe to run on every launch.
 */
function migrate(db) {
  const columns = new Set(db.prepare(`PRAGMA table_info(box_scores)`).all().map((c) => c.name));
  if (!columns.has('pfd')) {
    db.exec(`ALTER TABLE box_scores ADD COLUMN pfd INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has('plus_minus')) {
    db.exec(`ALTER TABLE box_scores ADD COLUMN plus_minus INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has('srj')) {
    db.exec(`ALTER TABLE box_scores ADD COLUMN srj INTEGER NOT NULL DEFAULT 0`);
  }

  const playerColumns = new Set(db.prepare(`PRAGMA table_info(players)`).all().map((c) => c.name));
  if (!playerColumns.has('position')) {
    db.exec(`ALTER TABLE players ADD COLUMN position TEXT`);
  }

  // 'Dubai Basketball' was mistakenly seeded into the ABA League as well as
  // EuroLeague (it only actually plays in EuroLeague), which made team-name
  // auto-matching ambiguous. Drop the erroneous ABA League row, but only if
  // nothing was ever recorded against it — an untouched duplicate is safe to
  // remove, real data never is.
  const strayDubai = db
    .prepare(
      `SELECT t.id FROM teams t JOIN leagues l ON l.id = t.league_id
       WHERE t.name = 'Dubai Basketball' AND l.name = 'ABA League'`
    )
    .get();
  if (strayDubai) {
    const hasPlayers = db.prepare(`SELECT 1 FROM players WHERE team_id = ?`).get(strayDubai.id);
    const hasGames = db
      .prepare(`SELECT 1 FROM games WHERE home_team_id = ? OR away_team_id = ?`)
      .get(strayDubai.id, strayDubai.id);
    if (!hasPlayers && !hasGames) {
      db.prepare(`DELETE FROM teams WHERE id = ?`).run(strayDubai.id);
    }
  }
}

module.exports = { initDb };
