/**
 * One-off importer: EuroLeague 2025-26 regular season play-by-play (from the
 * euroleague_api Python package's export) straight into the app's SQLite DB.
 * Not part of the app — this is a single-use data-loading script for a demo.
 *
 * Usage:
 *   node _import_euroleague_2025_26.js --dry-run      (analysis only, no DB writes)
 *   node _import_euroleague_2025_26.js --import       (writes to the real DB)
 *
 * Run via the Electron-bundled Node so better-sqlite3's native binding matches:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe _import_euroleague_2025_26.js --dry-run
 */
const fs = require('fs');
const path = require('path');

const CSV_PATH = 'C:/Users/fotis/euroleague_2025_26_playbyplay.csv';
const SEASON_LABEL = '2025-26';
const LEAGUE_NAME = 'EuroLeague';
const SEASON_START_DATE = new Date('2025-09-30'); // real date, round 1, from the metadata sample
const DAYS_PER_ROUND = 5; // placeholder spacing — order is what matters, not the exact calendar day
const GAMES_PER_ROUND = 10; // 20 teams / 2

const MODE = process.argv.includes('--import') ? 'import' : process.argv.includes('--diagnose') ? 'diagnose' : 'dry-run';

// ---------- CSV parsing (handles quoted fields with embedded commas, e.g. "JONES, KAI") ----------
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

function loadRows() {
  const text = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const rows = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = fields[j] ?? '';
    rows[i - 1] = row;
  }
  return rows;
}

function numOrNull(s) {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
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

// ---------- Team name canonicalization (merges mid-season sponsor-name variants) ----------
function buildTeamNameAliasMap(rows) {
  const counts = new Map();
  for (const r of rows) {
    const t = r.TEAM;
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const pairs = [
    ['Crvena Zvezda Meridian Belgrade', 'Crvena Zvezda Meridianbet Belgrade'],
    ['Baskonia Vitoria-Gasteiz', 'Kosner Baskonia Vitoria-Gasteiz'],
  ];
  const aliasMap = new Map();
  for (const [a, b] of pairs) {
    const countA = counts.get(a) || 0;
    const countB = counts.get(b) || 0;
    if (countA === 0 && countB === 0) continue;
    const winner = countA >= countB ? a : b;
    const loser = countA >= countB ? b : a;
    aliasMap.set(loser, winner);
    console.log(`Team name merge: "${loser}" (${Math.min(countA, countB)} rows) -> "${winner}" (${Math.max(countA, countB)} rows)`);
  }
  return aliasMap;
}

// ---------- Box score / on-court tracking, one instance per team per game ----------
class TeamGameState {
  constructor() {
    this.players = new Map(); // playerId -> box score accumulator
    this.enteredAt = new Map(); // playerId -> clock_seconds, or null if off court
    this.seen = new Set();
  }
  ensurePlayer(playerId, name, dorsal) {
    if (!this.players.has(playerId)) {
      this.players.set(playerId, {
        name, dorsal, min: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
        oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, pfd: 0, plus_minus: 0, srj: 0,
      });
    }
    return this.players.get(playerId);
  }
  enter(playerId, atSeconds) {
    this.enteredAt.set(playerId, atSeconds);
  }
  leave(playerId, atSeconds) {
    const enteredAt = this.enteredAt.get(playerId);
    if (enteredAt === null || enteredAt === undefined) return;
    const p = this.players.get(playerId);
    if (p) p.min += Math.max(0, atSeconds - enteredAt) / 60;
    this.enteredAt.set(playerId, null);
  }
  onCourtIds() {
    return [...this.enteredAt.entries()].filter(([, v]) => v !== null && v !== undefined).map(([k]) => k);
  }
  closeOutAt(atSeconds) {
    for (const id of this.onCourtIds()) this.leave(id, atSeconds);
  }
  applyPlusMinus(delta) {
    for (const id of this.onCourtIds()) {
      const p = this.players.get(id);
      if (p) p.plus_minus += delta;
    }
  }
}

const SHOT_PLAYTYPES = new Set(['2FGM', '2FGA', '3FGM', '3FGA']);
const KNOWN_PLAYTYPES = new Set([
  '2FGM', '2FGA', '3FGM', '3FGA', 'FTM', 'FTA', 'AS', 'TO', 'ST', 'D', 'O', 'CM', 'CMT', 'CMU', 'CMTI', 'CMD',
  'OF', 'RV', 'FV', 'AG', 'IN', 'OUT', 'BP', 'EP', 'EG', 'JB', 'TOUT', 'TOUT_TV', 'CCH', 'C', 'B',
]);

/** Parses one game's rows (already sorted by TRUE_NUMBEROFPLAY) into {homeCode, awayCode, homeState, awayState, events, unknownPlaytypes}. */
function parseGame(rows) {
  const codeOf = {}; // CODETEAM -> team full name (canonical)
  const stateByCode = {}; // CODETEAM -> TeamGameState
  const events = [];
  let sequence = 0;
  const unknownPlaytypes = new Set();

  // Determine Team A / Team B from which CODETEAM owns POINTS_A vs POINTS_B.
  let codeA = null;
  let codeB = null;
  for (const r of rows) {
    if (codeA === null && numOrNull(r.POINTS_A) !== null && r.CODETEAM) codeA = r.CODETEAM;
    if (codeB === null && numOrNull(r.POINTS_B) !== null && r.CODETEAM) codeB = r.CODETEAM;
    if (codeA && codeB) break;
  }
  // Fallback: first two distinct CODETEAM values in event order.
  if (!codeA || !codeB) {
    for (const r of rows) {
      if (!r.CODETEAM) continue;
      if (!codeA) codeA = r.CODETEAM;
      else if (!codeB && r.CODETEAM !== codeA) codeB = r.CODETEAM;
    }
  }

  // Pre-pass: determine each team's starters (on court since tip-off) from the WHOLE game
  // before any event is applied. Doing this lazily during the main pass (on first appearance)
  // under-credits whichever team's own first action comes later in event order — e.g. if team A
  // scores before team B's first logged action, team B's starters aren't "on court" yet to take
  // the plus-minus hit. Scanning ahead avoids that order-dependent bias entirely.
  for (const r of rows) {
    const code = r.CODETEAM;
    const pid = r.PLAYER_ID;
    const pt = r.PLAYTYPE;
    if (!code || !pid || !pid.startsWith('P')) continue;
    if (!stateByCode[code]) stateByCode[code] = new TeamGameState();
    if (!codeOf[code]) codeOf[code] = r.TEAM;
    const state = stateByCode[code];
    if (state.seen.has(pid)) continue;
    state.seen.add(pid);
    state.ensurePlayer(pid, r.PLAYER, r.DORSAL);
    if (pt !== 'IN') state.enter(pid, 0);
  }

  let lastOffensiveFoul = null; // { code, playerId, clockSeconds } — pairs OF -> next TO as turnover_dead
  let maxClockSeconds = 0;

  for (const r of rows) {
    const code = r.CODETEAM;
    const playtype = r.PLAYTYPE;
    const period = Number(r.PERIOD) || 1;
    const clockSeconds = clockSecondsFor(period, r.MARKERTIME);
    if (clockSeconds !== null) maxClockSeconds = Math.max(maxClockSeconds, clockSeconds);

    if (code) {
      if (!codeOf[code]) codeOf[code] = r.TEAM;
      if (!stateByCode[code]) stateByCode[code] = new TeamGameState();
    }

    if (!KNOWN_PLAYTYPES.has(playtype)) {
      unknownPlaytypes.add(playtype);
      continue;
    }
    if (['BP', 'EP', 'EG', 'JB', 'TOUT', 'TOUT_TV', 'CCH', 'C', 'B'].includes(playtype)) continue;
    if (!code || clockSeconds === null) continue;

    const state = stateByCode[code];
    const oppCode = code === codeA ? codeB : codeA;
    const oppState = oppCode ? stateByCode[oppCode] : null;
    const playerId = r.PLAYER_ID || null;
    const playerName = r.PLAYER || null;

    // Coach/bench-attributed events (PLAYER_ID like CO_A, AC_B) have no individual player to credit — skip.
    if (playerId && !playerId.startsWith('P')) continue;

    switch (playtype) {
      case 'IN':
        state.enter(playerId, clockSeconds);
        events.push({ code, playerId, clockSeconds, type: 'sub_in', points: null, sequence: sequence++ });
        break;
      case 'OUT':
        state.leave(playerId, clockSeconds);
        events.push({ code, playerId, clockSeconds, type: 'sub_out', points: null, sequence: sequence++ });
        break;
      case '2FGM':
      case '3FGM': {
        const pts = playtype === '3FGM' ? 3 : 2;
        const p = state.ensurePlayer(playerId, playerName, r.DORSAL);
        p.fgm += 1; p.fga += 1; p.pts += pts;
        if (pts === 3) { p.tpm += 1; p.tpa += 1; }
        state.applyPlusMinus(pts);
        if (oppState) oppState.applyPlusMinus(-pts);
        events.push({ code, playerId, clockSeconds, type: 'score', points: pts, sequence: sequence++ });
        break;
      }
      case '2FGA':
      case '3FGA': {
        const pts = playtype === '3FGA' ? 3 : 2;
        const p = state.ensurePlayer(playerId, playerName, r.DORSAL);
        p.fga += 1;
        if (pts === 3) p.tpa += 1;
        events.push({ code, playerId, clockSeconds, type: 'miss', points: pts, sequence: sequence++ });
        break;
      }
      case 'AG':
        // "Shot Rejected" — a direct signal on the shooter, distinct from FV (credited to the blocker).
        state.ensurePlayer(playerId, playerName, r.DORSAL).srj += 1;
        break;
      case 'FTM': {
        const p = state.ensurePlayer(playerId, playerName, r.DORSAL);
        p.ftm += 1; p.fta += 1; p.pts += 1;
        state.applyPlusMinus(1);
        if (oppState) oppState.applyPlusMinus(-1);
        events.push({ code, playerId, clockSeconds, type: 'score', points: 1, sequence: sequence++ });
        break;
      }
      case 'FTA': {
        const p = state.ensurePlayer(playerId, playerName, r.DORSAL);
        p.fta += 1;
        events.push({ code, playerId, clockSeconds, type: 'miss', points: 1, sequence: sequence++ });
        break;
      }
      case 'AS':
        state.ensurePlayer(playerId, playerName, r.DORSAL).ast += 1;
        events.push({ code, playerId, clockSeconds, type: 'assist', points: null, sequence: sequence++ });
        break;
      case 'ST':
        state.ensurePlayer(playerId, playerName, r.DORSAL).stl += 1;
        break;
      case 'D':
        if (playerId) {
          state.ensurePlayer(playerId, playerName, r.DORSAL).dreb += 1;
          events.push({ code, playerId, clockSeconds, type: 'reb_def', points: null, sequence: sequence++ });
        }
        break;
      case 'O':
        if (playerId) {
          state.ensurePlayer(playerId, playerName, r.DORSAL).oreb += 1;
          events.push({ code, playerId, clockSeconds, type: 'reb_off', points: null, sequence: sequence++ });
        }
        break;
      case 'CM':
      case 'CMT':
      case 'CMU':
      case 'CMTI':
      case 'CMD':
        state.ensurePlayer(playerId, playerName, r.DORSAL).pf += 1;
        break;
      case 'OF':
        state.ensurePlayer(playerId, playerName, r.DORSAL).pf += 1;
        lastOffensiveFoul = { playerId, clockSeconds };
        break;
      case 'RV':
        state.ensurePlayer(playerId, playerName, r.DORSAL).pfd += 1;
        break;
      case 'FV':
        state.ensurePlayer(playerId, playerName, r.DORSAL).blk += 1;
        break;
      case 'TO': {
        // A minority of TOs (shot-clock violations etc.) are team-level, with no PLAYER_ID —
        // nothing to individually credit, same treatment as team rebounds (D/O with blank id).
        if (!playerId) break;
        state.ensurePlayer(playerId, playerName, r.DORSAL).tov += 1;
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
        break;
    }
  }

  for (const code of Object.keys(stateByCode)) stateByCode[code].closeOutAt(maxClockSeconds);

  return { codeA, codeB, codeOf, stateByCode, events, unknownPlaytypes, maxClockSeconds };
}

function roundForGamecode(gamecode) {
  return Math.floor((gamecode - 1) / GAMES_PER_ROUND) + 1;
}
function placeholderDateForGamecode(gamecode) {
  const round = roundForGamecode(gamecode);
  const d = new Date(SEASON_START_DATE);
  d.setDate(d.getDate() + (round - 1) * DAYS_PER_ROUND);
  return d.toISOString().slice(0, 10);
}

// ---------- Main ----------
function main() {
  console.log(`Mode: ${MODE}`);
  console.log('Loading CSV...');
  const rows = loadRows();
  console.log(`Loaded ${rows.length} rows.`);

  const aliasMap = buildTeamNameAliasMap(rows);
  const canonicalName = (name) => aliasMap.get(name) || name;

  const byGame = new Map();
  for (const r of rows) {
    const gc = r.Gamecode;
    if (!byGame.has(gc)) byGame.set(gc, []);
    byGame.get(gc).push(r);
  }
  console.log(`Distinct games: ${byGame.size}`);

  for (const gameRows of byGame.values()) {
    gameRows.sort((a, b) => Number(a.TRUE_NUMBEROFPLAY) - Number(b.TRUE_NUMBEROFPLAY));
  }

  const allUnknownPlaytypes = new Set();
  const teamNamesSeen = new Set();
  let sampleReport = null;

  for (const [gc, gameRows] of byGame) {
    const parsed = parseGame(gameRows);
    for (const u of parsed.unknownPlaytypes) allUnknownPlaytypes.add(u);
    for (const code of Object.keys(parsed.codeOf)) teamNamesSeen.add(canonicalName(parsed.codeOf[code]));

    if (gc === '1') {
      const homeState = parsed.stateByCode[parsed.codeA];
      const awayState = parsed.stateByCode[parsed.codeB];
      const homePts = [...homeState.players.values()].reduce((a, p) => a + p.pts, 0);
      const awayPts = [...awayState.players.values()].reduce((a, p) => a + p.pts, 0);
      sampleReport = {
        gamecode: gc,
        homeTeam: parsed.codeOf[parsed.codeA],
        awayTeam: parsed.codeOf[parsed.codeB],
        homePts, awayPts,
        homePlayers: homeState.players.size,
        awayPlayers: awayState.players.size,
        totalMinHome: [...homeState.players.values()].reduce((a, p) => a + p.min, 0),
      };
    }
  }

  console.log('\n--- Sanity check: Gamecode 1 (real result was Anadolu Efes Istanbul 85, Maccabi Rapyd Tel Aviv 78) ---');
  console.log(sampleReport);

  console.log('\n--- Unknown PLAYTYPE codes encountered (skipped, not crashed) ---');
  console.log([...allUnknownPlaytypes]);

  console.log(`\n--- Canonical team names (${teamNamesSeen.size}) ---`);
  console.log([...teamNamesSeen].sort());

  if (MODE === 'dry-run') {
    console.log('\nDry run complete. No database changes made. Re-run with --import to write.');
    return;
  }

  if (MODE === 'diagnose') {
    let blankNameCount = 0;
    for (const [gc, gameRows] of byGame) {
      const parsed = parseGame(gameRows);
      for (const code of Object.keys(parsed.stateByCode)) {
        for (const [pid, box] of parsed.stateByCode[code].players) {
          if (!box.name) {
            blankNameCount++;
            console.log(`Gamecode ${gc}, code ${code}, playerId ${pid}: name = ${JSON.stringify(box.name)}`);
          }
        }
      }
    }
    console.log(`Total blank-name players: ${blankNameCount}`);
    return;
  }

  runImport(byGame, canonicalName);
}

function runImport(byGame, canonicalName) {
  const Database = require('better-sqlite3');
  const dbPath = path.join(process.env.APPDATA, 'boxscore-analytics', 'boxscore.sqlite3');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const league = db.prepare(`SELECT id FROM leagues WHERE name = ?`).get(LEAGUE_NAME);
  if (!league) throw new Error(`League "${LEAGUE_NAME}" not found — is it in seed.js?`);
  const leagueId = league.id;

  // The DB already has EuroLeague teams seeded under their old short names (from before
  // seed.js was updated to match this feed's exact naming) — rename in place so we don't
  // create duplicate orphaned rows.
  const OLD_TO_NEW_NAME = {
    Barcelona: 'FC Barcelona',
    Baskonia: 'Kosner Baskonia Vitoria-Gasteiz',
    Olympiacos: 'Olympiacos Piraeus',
    Panathinaikos: 'Panathinaikos AKTOR Athens',
    'Fenerbahçe Beko': 'Fenerbahce Beko Istanbul',
    'Anadolu Efes': 'Anadolu Efes Istanbul',
    'Maccabi Tel Aviv': 'Maccabi Rapyd Tel Aviv',
    'Hapoel Tel Aviv': 'Hapoel IBI Tel Aviv',
    ASVEL: 'LDLC ASVEL Villeurbanne',
    'Olimpia Milano': 'EA7 Emporio Armani Milan',
    'Bayern Munich': 'FC Bayern Munich',
    Žalgiris: 'Zalgiris Kaunas',
    'Crvena Zvezda': 'Crvena Zvezda Meridianbet Belgrade',
    Partizan: 'Partizan Mozzart Bet Belgrade',
  };
  const renameTeam = db.prepare(`UPDATE teams SET name = ? WHERE league_id = ? AND name = ?`);
  for (const [oldName, newName] of Object.entries(OLD_TO_NEW_NAME)) {
    const info = renameTeam.run(newName, leagueId, oldName);
    if (info.changes > 0) console.log(`Renamed team "${oldName}" -> "${newName}"`);
  }

  let season = db.prepare(`SELECT id FROM seasons WHERE league_id = ? AND year = ?`).get(leagueId, SEASON_LABEL);
  const seasonId = season
    ? season.id
    : db.prepare(`INSERT INTO seasons (league_id, year) VALUES (?, ?)`).run(leagueId, SEASON_LABEL).lastInsertRowid;
  console.log(`Season "${SEASON_LABEL}" -> id ${seasonId}`);

  const findTeam = db.prepare(`SELECT id FROM teams WHERE league_id = ? AND name = ?`);
  const insertTeam = db.prepare(`INSERT INTO teams (league_id, name, is_my_team) VALUES (?, ?, 0)`);
  function upsertTeam(name) {
    const existing = findTeam.get(leagueId, name);
    if (existing) return existing.id;
    return insertTeam.run(leagueId, name).lastInsertRowid;
  }

  const findPlayer = db.prepare(`SELECT id FROM players WHERE team_id = ? AND name = ?`);
  const insertPlayer = db.prepare(`INSERT INTO players (team_id, name) VALUES (?, ?)`);
  function upsertPlayer(teamId, name) {
    const existing = findPlayer.get(teamId, name);
    if (existing) return existing.id;
    return insertPlayer.run(teamId, name).lastInsertRowid;
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

  let gamesImported = 0;
  let playersImported = 0;

  const importTx = db.transaction(() => {
    for (const [gc, gameRows] of byGame) {
      gameRows.sort((a, b) => Number(a.TRUE_NUMBEROFPLAY) - Number(b.TRUE_NUMBEROFPLAY));
      const parsed = parseGame(gameRows);
      if (!parsed.codeA || !parsed.codeB) {
        console.log(`Gamecode ${gc}: could not determine both teams, skipping.`);
        continue;
      }

      const homeName = canonicalName(parsed.codeOf[parsed.codeA]);
      const awayName = canonicalName(parsed.codeOf[parsed.codeB]);
      const homeTeamId = upsertTeam(homeName);
      const awayTeamId = upsertTeam(awayName);
      const date = placeholderDateForGamecode(Number(gc));

      const gameId = insertGame.run(seasonId, date, homeTeamId, awayTeamId).lastInsertRowid;

      const teamIdByCode = { [parsed.codeA]: homeTeamId, [parsed.codeB]: awayTeamId };
      const playerIdByCodeAndPlayerId = {};

      for (const code of [parsed.codeA, parsed.codeB]) {
        const state = parsed.stateByCode[code];
        if (!state) continue;
        const teamId = teamIdByCode[code];
        for (const [pid, box] of state.players) {
          const dbPlayerId = upsertPlayer(teamId, box.name);
          playerIdByCodeAndPlayerId[`${code}:${pid}`] = dbPlayerId;
          insertBoxScore.run({
            gameId, playerId: dbPlayerId,
            min: Math.round(box.min * 10) / 10,
            pts: box.pts, fgm: box.fgm, fga: box.fga, tpm: box.tpm, tpa: box.tpa,
            ftm: box.ftm, fta: box.fta, oreb: box.oreb, dreb: box.dreb, ast: box.ast,
            stl: box.stl, blk: box.blk, tov: box.tov, pf: box.pf, pfd: box.pfd,
            plus_minus: Math.round(box.plus_minus), srj: box.srj,
          });
          playersImported++;
        }
      }

      for (const e of parsed.events) {
        const teamId = teamIdByCode[e.code];
        if (!teamId) continue;
        const dbPlayerId = e.playerId ? playerIdByCodeAndPlayerId[`${e.code}:${e.playerId}`] ?? null : null;
        insertEvent.run({
          gameId, teamId, playerId: dbPlayerId, clockSeconds: e.clockSeconds,
          eventType: e.type, points: e.points, sequence: e.sequence,
        });
      }

      gamesImported++;
      if (gamesImported % 25 === 0) console.log(`  ...${gamesImported} games imported`);
    }
  });

  importTx();

  console.log(`\nDone. Imported ${gamesImported} games, ${playersImported} player-game box scores.`);
  db.close();
}

main();
