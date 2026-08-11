/**
 * A from-scratch RAPM (Regularized Adjusted Plus-Minus) engine, built only
 * from real play-by-play data (game_events) — never estimated, never
 * fabricated for games that don't have it.
 *
 * This is the same core technique real LEBRON/EPM are built on (box score +
 * RAPM) — minus the smaller tracking-informed component that neither this
 * app nor any Excel/photo import can ever provide. Deliberately produces
 * ONE transparent "Impact Rating", not two differently-labeled "LEBRON" and
 * "EPM" numbers: we don't have the real differentiating ingredients between
 * those two proprietary models, and showing two numbers we can't honestly
 * tell apart would just be inventing a difference that isn't real.
 *
 * Needs real volume to mean anything — see CONFIDENCE_THRESHOLDS below —
 * and is only ever computed from games that actually have a play-by-play
 * import behind them. A team/player/league can freely mix manual, photo,
 * and play-by-play entries; this simply skips whatever doesn't have the
 * lineup data it needs, rather than guessing.
 */

const { estimatePossessions } = require('./statsEngine');

const RIDGE_LAMBDA = 2000; // a fixed, commonly-cited regularization constant for this kind of possession-weighted RAPM — not scientifically tuned via cross-validation on this app's data, an honest caveat worth keeping in mind.

const CONFIDENCE_THRESHOLDS = { veryLow: 1, low: 5, medium: 15, high: 25 };

function confidenceLabel(gamesWithPbp) {
  if (gamesWithPbp < CONFIDENCE_THRESHOLDS.veryLow) return 'none';
  if (gamesWithPbp < CONFIDENCE_THRESHOLDS.low) return 'very_low';
  if (gamesWithPbp < CONFIDENCE_THRESHOLDS.medium) return 'low';
  if (gamesWithPbp < CONFIDENCE_THRESHOLDS.high) return 'medium';
  return 'high';
}

/**
 * Reconstructs continuous 5-vs-5 lineup stints from one game's raw
 * sub_in/sub_out/score events. A stint where either side doesn't have
 * exactly 5 players on court (incomplete data, or the moment before all
 * starters have "entered") is dropped rather than guessed at — half a
 * lineup is worse than no data point at all for this purpose.
 */
function buildStints(events, homeTeamId, awayTeamId, gameEndSeconds) {
  const sorted = [...events].sort((a, b) => a.clock_seconds - b.clock_seconds || a.sequence - b.sequence);
  const onCourt = { [homeTeamId]: new Set(), [awayTeamId]: new Set() };

  const stints = [];
  let stintStart = 0;
  let homePts = 0;
  let awayPts = 0;

  function closeStint(endTime) {
    const duration = endTime - stintStart;
    if (duration > 0) {
      const homeIds = [...onCourt[homeTeamId]];
      const awayIds = [...onCourt[awayTeamId]];
      if (homeIds.length === 5 && awayIds.length === 5) {
        stints.push({ durationSeconds: duration, homeIds, awayIds, homePts, awayPts });
      }
    }
    homePts = 0;
    awayPts = 0;
    stintStart = endTime;
  }

  for (const e of sorted) {
    if (e.event_type === 'score') {
      if (e.team_id === homeTeamId) homePts += e.points || 0;
      else if (e.team_id === awayTeamId) awayPts += e.points || 0;
      continue; // scores don't change the on-court lineup, just accumulate into the current stint
    }
    if (e.clock_seconds !== stintStart) closeStint(e.clock_seconds);
    const set = onCourt[e.team_id];
    if (!set) continue;
    if (e.event_type === 'sub_in') set.add(e.player_id);
    else if (e.event_type === 'sub_out') set.delete(e.player_id);
  }

  closeStint(gameEndSeconds);
  return stints;
}

/** Gauss-Jordan elimination with partial pivoting — solves Ax = b for x. */
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    const pivotVal = M[col][col];
    if (Math.abs(pivotVal) < 1e-9) continue; // effectively singular in this column — leave its coefficient at 0
    for (let k = col; k <= n; k++) M[col][k] /= pivotVal;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= factor * M[col][k];
    }
  }

  return M.map((row) => row[n]);
}

/**
 * `gamesData`: [{ stints, homeTotals, awayTotals, gameDurationSeconds }]
 * from games that actually have play-by-play data. Returns Map<playerId,
 * ratingPer100Possessions>. Possession weighting per stint uses the game's
 * own estimated pace (from real box-score totals), not a fixed assumption.
 */
function computeRapm(gamesData) {
  const playerIndex = new Map();
  const rows = [];

  for (const g of gamesData) {
    const totalPoss = estimatePossessions(g.homeTotals) + estimatePossessions(g.awayTotals);
    const possPerSecond = g.gameDurationSeconds > 0 ? totalPoss / 2 / g.gameDurationSeconds : 0;
    if (possPerSecond <= 0) continue;

    for (const s of g.stints) {
      const estPoss = s.durationSeconds * possPerSecond;
      if (estPoss <= 0) continue;
      for (const id of [...s.homeIds, ...s.awayIds]) {
        if (!playerIndex.has(id)) playerIndex.set(id, playerIndex.size);
      }
      const netPer100 = ((s.homePts - s.awayPts) / estPoss) * 100;
      rows.push({ homeIds: s.homeIds, awayIds: s.awayIds, response: netPer100, weight: estPoss });
    }
  }

  const p = playerIndex.size;
  if (p === 0) return new Map();

  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);

  for (const row of rows) {
    const w = row.weight;
    const y = row.response;
    const coeffs = new Map();
    for (const id of row.homeIds) {
      const j = playerIndex.get(id);
      coeffs.set(j, (coeffs.get(j) || 0) + 1);
    }
    for (const id of row.awayIds) {
      const j = playerIndex.get(id);
      coeffs.set(j, (coeffs.get(j) || 0) - 1);
    }
    for (const [j, xj] of coeffs) {
      b[j] += w * xj * y;
      for (const [k, xk] of coeffs) {
        A[j][k] += w * xj * xk;
      }
    }
  }
  for (let j = 0; j < p; j++) A[j][j] += RIDGE_LAMBDA;

  const beta = solveLinearSystem(A, b);
  const result = new Map();
  for (const [playerId, idx] of playerIndex) result.set(playerId, beta[idx]);
  return result;
}

module.exports = { buildStints, computeRapm, confidenceLabel, CONFIDENCE_THRESHOLDS };
