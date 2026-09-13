/**
 * Loads a full EuroLeague season (Regular Season + Play-Ins + Playoffs +
 * Final Four) into the app's SQLite DB, from the CSVs produced by
 * data-import/euroleague_full_season_export.py.
 *
 * This REPLACES the older `_import_euroleague_2025_26.js` approach (which
 * only covered the regular season, and re-derived box scores from
 * text-parsed play-by-play). This script instead:
 *   - uses EuroLeague's own OFFICIAL per-player box scores directly (more
 *     accurate than re-deriving pts/fgm/etc. from parsing PBP text),
 *   - covers every phase (RS/PI/PO/FF), not just the regular season,
 *   - uses real game dates (not placeholder round-spacing),
 *   - imports shot-location data into shot_zones,
 *   - imports Points-off-Turnovers / Second-Chance / Fastbreak / Points-in-
 *     the-Paint as OFFICIAL per-game team stats (team_game_advanced_stats),
 *     sourced from EuroLeague's own per-shot flags — not the app's own
 *     clock-threshold estimate.
 * play_by_play.csv is still used, but only to rebuild game_events (needed
 * for on-court lineups / RAPM / possession reconstruction) — not for box
 * scores.
 *
 * Usage:
 *   node _import_euroleague_full_season.js --dir ./data-import/out --dry-run
 *   node _import_euroleague_full_season.js --dir ./data-import/out --import
 *
 * --league <name> targets a different `leagues.name` row from seed.js —
 * defaults to "EuroLeague". Pass --league EuroCup when the --dir CSVs were
 * pulled with euroleague_full_season_export.py --competition U (EuroCup is
 * the only other competition that package covers). --season-label <year>
 * defaults to "2025-26".
 *
 * --import DELETES all existing games for that league+season first (games,
 * box_scores, game_events, shot_zones, team_game_advanced_stats) and
 * reimports from scratch. This is deliberate: the old regular-season-only
 * EuroLeague dataset was derived from fragile text-parsed PBP, while this
 * source is the competition's own structured API — cleaner to replace
 * entirely than to try to merge two different derivations of the same games.
 *
 * Run via the Electron-bundled Node so better-sqlite3's native binding matches:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe _import_euroleague_full_season.js --dir ./data-import/out --dry-run
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe _import_euroleague_full_season.js --dir ./data-import/out-eurocup --league EuroCup --import
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dirArgIdx = args.indexOf('--dir');
const DATA_DIR = dirArgIdx >= 0 ? args[dirArgIdx + 1] : './data-import/out';
const MODE = args.includes('--import') ? 'import' : 'dry-run';

const leagueArgIdx = args.indexOf('--league');
// Must exactly match a `leagues.name` row from seed.js — 'EuroLeague' or 'EuroCup'
// for anything pulled via euroleague_full_season_export.py (the only two
// competitions the euroleague_api package covers).
const LEAGUE_NAME = leagueArgIdx >= 0 ? args[leagueArgIdx + 1] : 'EuroLeague';
const seasonArgIdx = args.indexOf('--season-label');
const SEASON_LABEL = seasonArgIdx >= 0 ? args[seasonArgIdx + 1] : '2025-26';

// ---------- CSV parsing (handles quoted fields with embedded commas, e.g. "LARKIN, SHANE") ----------
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

/** "33:21" -> 33.35 decimal minutes; "DNP" / "" -> 0. */
function parseMinutes(s) {
  const m = /^(\d+):(\d{2})$/.exec((s || '').trim());
  if (!m) return 0;
  return Number(m[1]) + Number(m[2]) / 60;
}

// ---------- Clock conversion: PERIOD + "MM:SS" countdown -> continuous clock_seconds ----------
function periodLengthSeconds(period) {
  return period <= 4 ? 600 : 300; // 10 min regulation quarters, 5 min OT
}
function clockSecondsFor(period, markerTime) {
  const m = /^(\d+):(\d+)$/.exec((markerTime || '').trim());
  if (!m) return null;
  const remaining = Number(m[1]) * 60 + Number(m[2]);
  let elapsedBefore = 0;
  for (let p = 1; p < period; p++) elapsedBefore += periodLengthSeconds(p);
  return elapsedBefore + (periodLengthSeconds(period) - remaining);
}

// ---------- PBP -> game_events (box scores come from the official CSV instead, not from this) ----------
const KNOWN_PLAYTYPES = new Set([
  '2FGM', '2FGA', '3FGM', '3FGA', 'FTM', 'FTA', 'AS', 'TO', 'ST', 'D', 'O', 'CM', 'CMT', 'CMU', 'CMTI', 'CMD',
  'OF', 'RV', 'FV', 'AG', 'IN', 'OUT', 'BP', 'EP', 'EG', 'JB', 'TOUT', 'TOUT_TV', 'CCH', 'C', 'B',
]);
const SKIP_PLAYTYPES = new Set(['BP', 'EP', 'EG', 'JB', 'TOUT', 'TOUT_TV', 'CCH', 'C', 'B']);

/** Parses one game's PBP rows (sorted by play order) into { codeA, codeB, codeOf, events }. */
function parseGameEvents(rows) {
  const codeOf = {};
  const events = [];
  let sequence = 0;
  const onCourtSince = {}; // `${code}:${playerId}` -> clock_seconds entered, or null

  let codeA = null;
  let codeB = null;
  for (const r of rows) {
    if (codeA === null && r.POINTS_A !== '' && r.CODETEAM) codeA = r.CODETEAM;
    if (codeB === null && r.POINTS_B !== '' && r.CODETEAM) codeB = r.CODETEAM;
    if (codeA && codeB) break;
  }
  if (!codeA || !codeB) {
    for (const r of rows) {
      if (!r.CODETEAM) continue;
      if (!codeA) codeA = r.CODETEAM;
      else if (!codeB && r.CODETEAM !== codeA) codeB = r.CODETEAM;
    }
  }

  // Pre-pass: mark every player who appears before their first "IN" as on-court since tip-off,
  // same rationale as the original importer (avoids order-dependent starter detection).
  const seen = new Set();
  for (const r of rows) {
    const code = r.CODETEAM;
    const pid = r.PLAYER_ID;
    if (!code || !pid || !pid.startsWith('P')) continue;
    if (!codeOf[code]) codeOf[code] = r.TEAM;
    const key = `${code}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.PLAYTYPE !== 'IN') onCourtSince[key] = 0;
  }

  let lastOffensiveFoul = null;

  for (const r of rows) {
    const code = r.CODETEAM;
    const playtype = r.PLAYTYPE;
    const period = Number(r.PERIOD) || 1;
    const clockSeconds = clockSecondsFor(period, r.MARKERTIME);
    if (code && !codeOf[code]) codeOf[code] = r.TEAM;

    if (!KNOWN_PLAYTYPES.has(playtype) || SKIP_PLAYTYPES.has(playtype)) continue;
    if (!code || clockSeconds === null) continue;

    const playerId = r.PLAYER_ID || null;
    if (playerId && !playerId.startsWith('P')) continue; // coach/bench-attributed, no individual player
    const key = playerId ? `${code}:${playerId}` : null;

    switch (playtype) {
      case 'IN':
        if (key) onCourtSince[key] = clockSeconds;
        events.push({ code, playerId, clockSeconds, type: 'sub_in', points: null, sequence: sequence++ });
        break;
      case 'OUT':
        if (key) onCourtSince[key] = null;
        events.push({ code, playerId, clockSeconds, type: 'sub_out', points: null, sequence: sequence++ });
        break;
      case '2FGM':
      case '3FGM':
        events.push({ code, playerId, clockSeconds, type: 'score', points: playtype === '3FGM' ? 3 : 2, sequence: sequence++ });
        break;
      case '2FGA':
      case '3FGA':
        events.push({ code, playerId, clockSeconds, type: 'miss', points: playtype === '3FGA' ? 3 : 2, sequence: sequence++ });
        break;
      case 'FTM':
        events.push({ code, playerId, clockSeconds, type: 'score', points: 1, sequence: sequence++ });
        break;
      case 'FTA':
        events.push({ code, playerId, clockSeconds, type: 'miss', points: 1, sequence: sequence++ });
        break;
      case 'AS':
        events.push({ code, playerId, clockSeconds, type: 'assist', points: null, sequence: sequence++ });
        break;
      case 'D':
        if (playerId) events.push({ code, playerId, clockSeconds, type: 'reb_def', points: null, sequence: sequence++ });
        break;
      case 'O':
        if (playerId) events.push({ code, playerId, clockSeconds, type: 'reb_off', points: null, sequence: sequence++ });
        break;
      case 'OF':
        lastOffensiveFoul = { playerId, clockSeconds };
        break;
      case 'TO': {
        if (!playerId) break;
        const isDeadBall =
          lastOffensiveFoul && lastOffensiveFoul.playerId === playerId && lastOffensiveFoul.clockSeconds === clockSeconds;
        events.push({
          code, playerId, clockSeconds,
          type: isDeadBall ? 'turnover_dead' : 'turnover_live',
          points: null, sequence: sequence++,
        });
        lastOffensiveFoul = null;
        break;
      }
      default:
        break; // ST/CM/CMT/.../RV/FV/AG feed box-score counters only, which we source from the official CSV instead
    }
  }

  return { codeA, codeB, codeOf, events };
}

// ---------- Shot zone bucketing (5-zone app taxonomy from EuroLeague's 9-letter A-I zones) ----------
// A = rim; B/C/D/E/F/G = all non-rim 2PT range, collapsed into "mid_range";
// H/I = 3PT, split into corner/wing/top-key by court position — this split
// is an empirical geometric derivation (EuroLeague's zone letters don't
// distinguish corner/wing/top-key themselves), NOT an official label.
function bucketZone(zoneLetter, x, y) {
  if (zoneLetter === 'A') return 'at_rim';
  if (['B', 'C', 'D', 'E', 'F', 'G'].includes(zoneLetter)) return 'mid_range';
  if (zoneLetter === 'H' || zoneLetter === 'I') {
    const absX = Math.abs(x);
    if (absX > 550 && y < 250) return 'corner_3';
    if (absX <= 250) return 'top_key_3';
    return 'wing_3';
  }
  return null; // unrecognized zone letter — skip rather than guess
}

// ---------- Coordinate transform: EuroLeague's raw shot coords -> the app's shared half-court space ----------
// EuroLeague's COORD_X/COORD_Y are centered on the basket (origin ~0,0), in
// units close to real-world centimeters (confirmed empirically: 3-point shots
// cluster around 650-780 units from origin, matching FIBA's ~675cm arc).
// The app's shared half-court viewBox (used identically by the Draw tool and
// every shot chart) is 300 wide x 320 deep with the basket at (150, 20) — a
// real FIBA half-court is ~1500cm wide, so scale = 300/1500 = 0.2 maps
// centimeters onto that viewBox directly, preserving real proportions.
const COURT_SCALE = 0.2;
function transformCoord(rawX, rawY) {
  const x = Math.max(5, Math.min(295, 150 + rawX * COURT_SCALE));
  const y = Math.max(2, Math.min(318, 20 + rawY * COURT_SCALE));
  return { x, y };
}

// ---------- Main ----------
function main() {
  console.log(`Mode: ${MODE}, data dir: ${DATA_DIR}`);

  const games = loadCsv('games.csv');
  const boxscores = loadCsv('player_boxscores.csv');
  const pbp = loadCsv('play_by_play.csv');
  const shots = loadCsv('shot_data.csv');
  const teamAdv = loadCsv('team_game_advanced_stats.csv');

  console.log(`Loaded: ${games.length} games, ${boxscores.length} box score rows, ${pbp.length} PBP rows, ` +
    `${shots.length} shot rows, ${teamAdv.length} team-advanced-stat rows.`);

  if (games.length === 0) {
    console.log('No games.csv found / empty — nothing to do. Check --dir.');
    return;
  }

  // Code -> real team name, built once from the schedule (stable across the season).
  const nameByCode = {};
  for (const g of games) {
    nameByCode[g.homecode] = g.hometeam;
    nameByCode[g.awaycode] = g.awayteam;
  }

  // Group everything by Gamecode.
  const boxByGame = new Map();
  for (const r of boxscores) {
    const gc = r.Gamecode;
    if (!boxByGame.has(gc)) boxByGame.set(gc, []);
    boxByGame.get(gc).push(r);
  }
  const pbpByGame = new Map();
  for (const r of pbp) {
    const gc = r.Gamecode;
    if (!pbpByGame.has(gc)) pbpByGame.set(gc, []);
    pbpByGame.get(gc).push(r);
  }
  const shotsByGame = new Map();
  for (const r of shots) {
    const gc = r.Gamecode;
    if (!shotsByGame.has(gc)) shotsByGame.set(gc, []);
    shotsByGame.get(gc).push(r);
  }
  const teamAdvByGame = new Map();
  for (const r of teamAdv) {
    const gc = r.Gamecode;
    if (!teamAdvByGame.has(gc)) teamAdvByGame.set(gc, []);
    teamAdvByGame.get(gc).push(r);
  }

  for (const rows of pbpByGame.values()) rows.sort((a, b) => Number(a.TRUE_NUMBEROFPLAY) - Number(b.TRUE_NUMBEROFPLAY));

  console.log(`\nPhase breakdown: ${JSON.stringify(
    games.reduce((acc, g) => { acc[g.Phase] = (acc[g.Phase] || 0) + 1; return acc; }, {})
  )}`);

  if (MODE === 'dry-run') {
    const sample = games[0];
    console.log(`\nSample game: ${sample.hometeam} vs ${sample.awayteam}, ${sample.date}, phase ${sample.Phase}`);
    console.log('Dry run complete. No database changes made. Re-run with --import to write.');
    return;
  }

  runImport({ games, boxByGame, pbpByGame, shotsByGame, teamAdvByGame, nameByCode });
}

function runImport({ games, boxByGame, pbpByGame, shotsByGame, teamAdvByGame, nameByCode }) {
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

  // ---- Clean slate: delete existing data for this league+season before reimporting ----
  const existingGameIds = db
    .prepare(`SELECT id FROM games WHERE season_id = ?`)
    .all(seasonId)
    .map((r) => r.id);
  console.log(`Deleting ${existingGameIds.length} existing games (and their box scores / events) for this season...`);
  const delTx = db.transaction(() => {
    for (const gameId of existingGameIds) {
      db.prepare(`DELETE FROM game_events WHERE game_id = ?`).run(gameId);
      db.prepare(`DELETE FROM box_scores WHERE game_id = ?`).run(gameId);
      db.prepare(`DELETE FROM team_game_advanced_stats WHERE game_id = ?`).run(gameId);
    }
    db.prepare(`DELETE FROM games WHERE season_id = ?`).run(seasonId);
    const teamIds = db.prepare(`SELECT id FROM teams WHERE league_id = ?`).all(leagueId).map((r) => r.id);
    for (const teamId of teamIds) {
      db.prepare(`DELETE FROM shot_zones WHERE team_id = ? AND season_id = ?`).run(teamId, seasonId);
      db.prepare(`DELETE FROM shot_events WHERE team_id = ? AND season_id = ?`).run(teamId, seasonId);
    }
  });
  delTx();

  const findTeam = db.prepare(`SELECT id FROM teams WHERE league_id = ? AND UPPER(name) = UPPER(?)`);
  const insertTeam = db.prepare(`INSERT INTO teams (league_id, name, is_my_team) VALUES (?, ?, 0)`);
  const teamIdByCode = new Map();
  function teamIdForCode(code) {
    if (teamIdByCode.has(code)) return teamIdByCode.get(code);
    const name = nameByCode[code];
    if (!name) throw new Error(`No team name known for code "${code}"`);
    let row = findTeam.get(leagueId, name);
    let id;
    if (row) {
      id = row.id;
    } else {
      // Title-case fallback so a first-time-seen team doesn't get stored ALL CAPS.
      const titled = name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      id = insertTeam.run(leagueId, titled).lastInsertRowid;
      console.log(`  New team not previously seeded: "${titled}" (code ${code})`);
    }
    teamIdByCode.set(code, id);
    return id;
  }

  const findPlayer = db.prepare(`SELECT id FROM players WHERE team_id = ? AND name = ?`);
  const insertPlayer = db.prepare(`INSERT INTO players (team_id, name) VALUES (?, ?)`);
  const playerIdCache = new Map(); // `${teamId}:${name}` -> db player id
  function playerIdFor(teamId, name) {
    const key = `${teamId}:${name}`;
    if (playerIdCache.has(key)) return playerIdCache.get(key);
    let row = findPlayer.get(teamId, name);
    const id = row ? row.id : insertPlayer.run(teamId, name).lastInsertRowid;
    playerIdCache.set(key, id);
    return id;
  }

  const insertGame = db.prepare(
    `INSERT INTO games (season_id, date, home_team_id, away_team_id, source) VALUES (?, ?, ?, ?, 'play_by_play')`
  );
  const insertBoxScore = db.prepare(
    `INSERT INTO box_scores (game_id, player_id, min, pts, fgm, fga, tpm, tpa, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pfd, plus_minus, srj)
     VALUES (@gameId, @playerId, @min, @pts, @fgm, @fga, @tpm, @tpa, @ftm, @fta, @oreb, @dreb, @ast, @stl, @blk, @tov, @pf, @pfd, @plus_minus, @srj)`
  );
  const insertEvent = db.prepare(
    `INSERT INTO game_events (game_id, team_id, player_id, clock_seconds, event_type, points, sequence)
     VALUES (@gameId, @teamId, @playerId, @clockSeconds, @eventType, @points, @sequence)`
  );
  const insertTeamAdv = db.prepare(
    `INSERT INTO team_game_advanced_stats (game_id, team_id, points_off_turnovers, second_chance_points, fastbreak_points, points_in_the_paint)
     VALUES (@gameId, @teamId, @pointsOffTurnovers, @secondChancePoints, @fastbreakPoints, @pointsInThePaint)`
  );
  const insertShotEvent = db.prepare(
    `INSERT INTO shot_events (team_id, player_id, season_id, x, y, made, value)
     VALUES (@teamId, @playerId, @seasonId, @x, @y, @made, @value)`
  );

  // Accumulate season-total shot zone lines here; inserted once at the end.
  // key = `${teamId}:${playerId ?? 'TEAM'}:${zone}` -> { teamId, playerId, zone, fgm, fga }
  const zoneAcc = new Map();
  function accumulateZone(teamId, playerId, zone, made) {
    const key = `${teamId}:${playerId ?? 'TEAM'}:${zone}`;
    if (!zoneAcc.has(key)) zoneAcc.set(key, { teamId, playerId, zone, fgm: 0, fga: 0 });
    const row = zoneAcc.get(key);
    row.fga += 1;
    if (made) row.fgm += 1;
  }

  let gamesImported = 0;
  let playersImported = 0;
  let eventsImported = 0;
  let skippedNoBoxscore = 0;

  const importTx = db.transaction(() => {
    for (const g of games) {
      const gc = g.gameCode;
      const boxRows = boxByGame.get(gc);
      if (!boxRows || boxRows.length === 0) {
        skippedNoBoxscore++;
        continue;
      }

      const homeTeamId = teamIdForCode(g.homecode);
      const awayTeamId = teamIdForCode(g.awaycode);
      const gameId = insertGame.run(seasonId, isoDate(g.date), homeTeamId, awayTeamId).lastInsertRowid;

      // Map official Player_ID (trimmed — the API pads it with trailing spaces) -> db player id,
      // built from the OFFICIAL box score rows (authoritative roster, including DNP/0-minute players).
      const dbPlayerIdByOfficialId = new Map();
      for (const r of boxRows) {
        const officialId = (r.Player_ID || '').trim();
        // The official box score CSV includes one synthetic "Team totals" row
        // per team (Player_ID literally the string "Total", not a "P######"
        // id) — skip it, or it gets inserted as a fake player whose stats
        // double the real team total.
        if (!officialId.startsWith('P')) continue;
        const teamId = r.Team === g.homecode ? homeTeamId : awayTeamId;
        const name = r.Player;
        const dbPlayerId = playerIdFor(teamId, name);
        dbPlayerIdByOfficialId.set(officialId, dbPlayerId);

        const fgm = numOrZero(r.FieldGoalsMade2) + numOrZero(r.FieldGoalsMade3);
        const fga = numOrZero(r.FieldGoalsAttempted2) + numOrZero(r.FieldGoalsAttempted3);
        insertBoxScore.run({
          gameId, playerId: dbPlayerId,
          min: Math.round(parseMinutes(r.Minutes) * 10) / 10,
          pts: numOrZero(r.Points),
          fgm, fga,
          tpm: numOrZero(r.FieldGoalsMade3), tpa: numOrZero(r.FieldGoalsAttempted3),
          ftm: numOrZero(r.FreeThrowsMade), fta: numOrZero(r.FreeThrowsAttempted),
          oreb: numOrZero(r.OffensiveRebounds), dreb: numOrZero(r.DefensiveRebounds),
          ast: numOrZero(r.Assistances), stl: numOrZero(r.Steals),
          blk: numOrZero(r.BlocksFavour), tov: numOrZero(r.Turnovers),
          pf: numOrZero(r.FoulsCommited), pfd: numOrZero(r.FoulsReceived),
          plus_minus: Math.round(numOrZero(r.Plusminus)), srj: numOrZero(r.BlocksAgainst),
        });
        playersImported++;
      }

      // Events, from PBP — attach to the same player IDs just created above.
      const pbpRows = pbpByGame.get(gc);
      if (pbpRows && pbpRows.length > 0) {
        const parsed = parseGameEvents(pbpRows);
        const codeToTeamId = { [parsed.codeA]: homeTeamId, [parsed.codeB]: awayTeamId };
        // codeA/codeB from PBP might not line up with home/away if PBP's own
        // POINTS_A/POINTS_B attribution differs — fall back to matching by
        // the team's own 3-letter code against home/away codes directly.
        if (!codeToTeamId[parsed.codeA]) codeToTeamId[parsed.codeA] = parsed.codeA === g.homecode ? homeTeamId : awayTeamId;
        if (!codeToTeamId[parsed.codeB]) codeToTeamId[parsed.codeB] = parsed.codeB === g.homecode ? homeTeamId : awayTeamId;

        for (const e of parsed.events) {
          const teamId = e.code === g.homecode ? homeTeamId : e.code === g.awaycode ? awayTeamId : codeToTeamId[e.code];
          if (!teamId) continue;
          const officialId = (e.playerId || '').trim();
          const dbPlayerId = officialId ? dbPlayerIdByOfficialId.get(officialId) ?? null : null;
          insertEvent.run({
            gameId, teamId, playerId: dbPlayerId, clockSeconds: e.clockSeconds,
            eventType: e.type, points: e.points, sequence: e.sequence,
          });
          eventsImported++;
        }
      }

      // Official team-game advanced stats (points off TO / second chance / fastbreak / paint).
      const advRows = teamAdvByGame.get(gc) || [];
      for (const r of advRows) {
        const teamId = r.TEAM === g.homecode ? homeTeamId : r.TEAM === g.awaycode ? awayTeamId : null;
        if (!teamId) continue;
        insertTeamAdv.run({
          gameId, teamId,
          pointsOffTurnovers: numOrZero(r.points_off_turnovers),
          secondChancePoints: numOrZero(r.second_chance_points),
          fastbreakPoints: numOrZero(r.fastbreak_points),
          pointsInThePaint: numOrZero(r.points_in_the_paint),
        });
      }

      // Shot zones (season-aggregated) + individual shot events (real dot-chart locations).
      const shotRows = shotsByGame.get(gc) || [];
      for (const r of shotRows) {
        const isShotAttempt = ['2FGM', '2FGA', '3FGM', '3FGA'].includes(r.ID_ACTION);
        if (!isShotAttempt) continue;
        const teamId = r.TEAM === g.homecode ? homeTeamId : r.TEAM === g.awaycode ? awayTeamId : null;
        if (!teamId) continue;
        const made = r.ID_ACTION === '2FGM' || r.ID_ACTION === '3FGM';
        const value = r.ID_ACTION.startsWith('3') ? 3 : 2;
        const officialId = (r.ID_PLAYER || '').trim();
        const dbPlayerId = officialId ? dbPlayerIdByOfficialId.get(officialId) ?? null : null;

        const zone = bucketZone(r.ZONE, Number(r.COORD_X), Number(r.COORD_Y));
        if (zone) {
          accumulateZone(teamId, null, zone, made); // team total
          if (dbPlayerId) accumulateZone(teamId, dbPlayerId, zone, made); // player total
        }

        const { x, y } = transformCoord(Number(r.COORD_X), Number(r.COORD_Y));
        insertShotEvent.run({ teamId, playerId: dbPlayerId, seasonId, x, y, made: made ? 1 : 0, value });
      }

      gamesImported++;
      if (gamesImported % 25 === 0) console.log(`  ...${gamesImported} games imported`);
    }

    const insertZone = db.prepare(
      `INSERT INTO shot_zones (team_id, player_id, season_id, zone, fgm, fga) VALUES (@teamId, @playerId, @seasonId, @zone, @fgm, @fga)`
    );
    for (const row of zoneAcc.values()) {
      insertZone.run({
        teamId: row.teamId, playerId: row.playerId, seasonId, zone: row.zone, fgm: row.fgm, fga: row.fga,
      });
    }
  });

  importTx();

  console.log(`\nDone. Imported ${gamesImported} games (skipped ${skippedNoBoxscore} with no box score data), ` +
    `${playersImported} player-game box scores, ${eventsImported} game events, ${zoneAcc.size} shot-zone rows.`);
  db.close();
}

/** "Sep 30, 2025" -> "2025-09-30" */
function isoDate(s) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 10);
}

main();
