/**
 * Parses a EuroLeague-style play-by-play Excel export into the same
 * ExtractedBoxScore shape the OCR flow produces — so it can reuse the same
 * review/save UI. Unlike a photo, this is exact event data, so the box
 * score it produces is more accurate than OCR (precise FT splits, exact
 * shot types, fouls-drawn from "fouled on X"), and — the real upgrade —
 * MIN and +/- are *measured* from substitution timestamps and score deltas
 * at each scoring play, not left at 0 like every other import path today.
 *
 * Purely local parsing, no API call — never counts against the paid photo
 * upload quota.
 */

const ExcelJS = require('exceljs');

// "(14) Sasha VEZENKOV entered the court" -> number=14, name="Sasha VEZENKOV",
// action="entered the court". The name is matched non-greedily up to the
// first known action-verb word, since a plain "(\d+)\s*(.+)" swallows the
// entire action text into the "name" group instead of splitting there.
const PLAYER_ACTION = /^\((\d+)\)\s*(.+?)\s+((?:entered|left|made|missed|performed|commited|perfomed|blocked|passed)\b.*)$/i;

function emptyPlayerStat(name) {
  return {
    name,
    min: 0,
    pts: 0,
    fgm: 0,
    fga: 0,
    tpm: 0,
    tpa: 0,
    ftm: 0,
    fta: 0,
    oreb: 0,
    dreb: 0,
    ast: 0,
    stl: 0,
    blk: 0,
    tov: 0,
    pf: 0,
    pfd: 0,
    plus_minus: 0,
  };
}

/** "MM:SS" (continuous game clock, not resetting per quarter) -> whole seconds. */
function parseClock(text) {
  const m = /^(\d+):(\d+)$/.exec((text || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Splits "(12) First LAST entered the court" into { number, name, action }, or null if it doesn't match. */
function parsePlayerAction(cellText) {
  if (typeof cellText !== 'string') return null;
  const m = PLAYER_ACTION.exec(cellText.trim().replace(/\s+/g, ' '));
  if (!m) return null;
  return { number: m[1], name: titleCaseName(m[2]), action: m[3].trim() };
}

class TeamState {
  constructor(name) {
    this.name = name;
    /** key -> PlayerBoxScore-shaped row */
    this.players = new Map();
    /** key -> seconds the player entered the court at (null when off court) */
    this.enteredAt = new Map();
  }

  playerRow(key, displayName) {
    if (!this.players.has(key)) this.players.set(key, emptyPlayerStat(displayName));
    return this.players.get(key);
  }

  enter(key, displayName, atSeconds) {
    this.playerRow(key, displayName);
    this.enteredAt.set(key, atSeconds);
  }

  leave(key, atSeconds) {
    const enteredAt = this.enteredAt.get(key);
    if (enteredAt === null || enteredAt === undefined) return;
    const row = this.players.get(key);
    if (row) row.min += Math.max(0, atSeconds - enteredAt) / 60;
    this.enteredAt.set(key, null);
  }

  onCourtKeys() {
    return [...this.enteredAt.entries()].filter(([, v]) => v !== null && v !== undefined).map(([k]) => k);
  }

  closeOutAt(atSeconds) {
    for (const key of this.onCourtKeys()) this.leave(key, atSeconds);
  }

  applyPlusMinus(delta) {
    for (const key of this.onCourtKeys()) {
      const row = this.players.get(key);
      if (row) row.plus_minus += delta;
    }
  }
}

/**
 * @param {Buffer} buffer - raw .xls/.xlsx file bytes
 * @returns {Promise<{team: string, opponent: string, date: string, players: object[], opponentPlayers: object[], events: object[]}>}
 */
async function parsePlayByPlay(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The file has no sheets.');

  // Columns: [0]=unused (exceljs 1-based quirk), [1]=time, [2]=score, [3]=home
  // team actions, [4]=away team actions, [5]=neutral/game actions.
  const header = sheet.getRow(1).values;
  const homeTeamName = typeof header[3] === 'string' ? header[3].trim() : 'Home';
  const awayTeamName = typeof header[4] === 'string' ? header[4].trim() : 'Away';

  const home = new TeamState(homeTeamName);
  const away = new TeamState(awayTeamName);
  let lastClockSeconds = 0;
  let score = { home: 0, away: 0 };
  /** Raw substitution/scoring timeline — the minimal primitives for a future on/off or RAPM calculation. */
  const events = [];
  let sequence = 0;

  function pushEvent(team, displayName, atSeconds, type, points) {
    events.push({
      side: team === home ? 'home' : 'away',
      playerName: displayName,
      clockSeconds: atSeconds,
      type,
      points: points ?? null,
      sequence: sequence++,
    });
  }

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values;
    const clock = parseClock(values[1]);
    if (clock !== null) lastClockSeconds = clock;

    const scoreCell = values[2];
    const homeCell = values[3];
    const awayCell = values[4];
    const neutralCell = values[5];

    if (typeof homeCell === 'string') handleCell(home, away, homeCell, lastClockSeconds, scoreCell);
    if (typeof awayCell === 'string') handleCell(away, home, awayCell, lastClockSeconds, scoreCell);
    if (typeof neutralCell === 'string') handleNeutral(neutralCell, lastClockSeconds, home, away);
  });

  function handleCell(team, opponentTeam, cellText, atSeconds, scoreCell) {
    const parsed = parsePlayerAction(cellText);
    if (!parsed) return;
    const key = parsed.number;
    const displayName = parsed.name;
    const action = parsed.action;

    if (/^entered the court$/i.test(action)) {
      team.enter(key, displayName, atSeconds);
      pushEvent(team, displayName, atSeconds, 'sub_in');
      return;
    }
    if (/^left the court$/i.test(action)) {
      team.leave(key, atSeconds);
      pushEvent(team, displayName, atSeconds, 'sub_out');
      return;
    }

    const row = team.playerRow(key, displayName);

    let madeShot = /^performed a (\d) points/i.exec(action);
    let missedShot = /^missed a (\d) points/i.exec(action);
    let blockedAttempt = /^blocked while attempting a (\d) points/i.exec(action);

    if (madeShot) {
      const points = Number(madeShot[1]);
      row.fga += 1;
      row.fgm += 1;
      row.pts += points;
      if (points === 3) {
        row.tpa += 1;
        row.tpm += 1;
      }
      applyScoreDelta(scoreCell, team, opponentTeam);
      pushEvent(team, displayName, atSeconds, 'score', points);
      return;
    }
    if (missedShot || blockedAttempt) {
      const points = Number((missedShot || blockedAttempt)[1]);
      row.fga += 1;
      if (points === 3) row.tpa += 1;
      return;
    }
    if (/^made a free throw/i.test(action)) {
      row.fta += 1;
      row.ftm += 1;
      row.pts += 1;
      applyScoreDelta(scoreCell, team, opponentTeam);
      pushEvent(team, displayName, atSeconds, 'score', 1);
      return;
    }
    if (/^missed a free throw/i.test(action)) {
      row.fta += 1;
      return;
    }
    if (/^made a defensive rebound$/i.test(action)) {
      row.dreb += 1;
      return;
    }
    if (/^made an? offensive rebound$/i.test(action)) {
      row.oreb += 1;
      return;
    }
    if (/^made an assist$/i.test(action)) {
      row.ast += 1;
      return;
    }
    if (/^perfomed a steal$|^performed a steal$/i.test(action)) {
      row.stl += 1;
      return;
    }
    if (/^blocked a shot$/i.test(action)) {
      row.blk += 1;
      return;
    }
    if (/^made a turnover in ball handling$|^made a bad pass$|^passed the ball out of bounds$/i.test(action)) {
      row.tov += 1;
      return;
    }
    if (/^made an offensive foul$/i.test(action)) {
      row.tov += 1;
      row.pf += 1;
      return;
    }
    const foulOn = /^commited a personal foul on \((\d+)\)\s*(.+)$/i.exec(action);
    if (foulOn) {
      row.pf += 1;
      const victimKey = foulOn[1];
      const victimName = titleCaseName(foulOn[2]);
      opponentTeam.playerRow(victimKey, victimName).pfd += 1;
      return;
    }
    // Unrecognized action text (e.g. a rare foul-subtype variant) is silently
    // skipped rather than thrown — better to under-count one obscure event
    // than fail the whole import over it.
  }

  function applyScoreDelta(scoreCell, scoringTeam, opponentTeam) {
    if (typeof scoreCell !== 'string') return;
    const m = /^(\d+)-(\d+)$/.exec(scoreCell.trim());
    if (!m) return;
    const newHome = Number(m[1]);
    const newAway = Number(m[2]);
    const deltaHome = newHome - score.home;
    const deltaAway = newAway - score.away;
    score = { home: newHome, away: newAway };
    const isHomeTeam = scoringTeam === home;
    const delta = isHomeTeam ? deltaHome : deltaAway;
    if (delta === 0) return;
    scoringTeam.applyPlusMinus(delta);
    opponentTeam.applyPlusMinus(-delta);
  }

  function handleNeutral(text, atSeconds, homeTeam, awayTeam) {
    if (/^End of game$/i.test(text)) {
      homeTeam.closeOutAt(atSeconds);
      awayTeam.closeOutAt(atSeconds);
    }
  }

  // Safety net in case the file has no explicit "End of game" line.
  home.closeOutAt(lastClockSeconds);
  away.closeOutAt(lastClockSeconds);

  const round1 = (n) => Math.round(n * 10) / 10;
  const finalize = (team) =>
    [...team.players.values()]
      .map((p) => ({ ...p, min: round1(p.min) }))
      .sort((a, b) => b.pts - a.pts);

  return {
    team: homeTeamName,
    opponent: awayTeamName,
    date: new Date().toISOString().slice(0, 10),
    players: finalize(home),
    opponentPlayers: finalize(away),
    events,
  };
}

function titleCaseName(raw) {
  return raw
    .trim()
    .split(/\s+/)
    .map((word) =>
      word.length > 2 && word === word.toUpperCase()
        ? word[0] + word.slice(1).toLowerCase()
        : word
    )
    .join(' ');
}

module.exports = { parsePlayByPlay };
