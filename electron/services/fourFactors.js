/**
 * Pure helpers for the Four Factors page's PBP-only sub-metrics — same
 * dependency-free style as statsEngine.js/rapm.js. All DB access and
 * orchestration lives in ipc.js; these just do the math on rows/events
 * already fetched from `game_events`.
 */

/**
 * Share of made field goals (2PT or 3PT — excludes free throws, which are
 * 'score' events with points === 1) that have a same-team 'assist' event at
 * the exact same clock second. A make/assist pair at the same clock second
 * is treated as linked — the play-by-play format logs both on the same
 * play, so this is a reasonable, if not perfectly precise, heuristic: rare
 * simultaneous plays at the identical second could misattribute. Returns
 * null if there are no field goal makes to measure against.
 */
function computeAssistedFgPct(events) {
  const fgMakes = events.filter((e) => e.event_type === 'score' && e.points !== 1);
  if (fgMakes.length === 0) return null;

  const assistKeys = new Set(
    events.filter((e) => e.event_type === 'assist').map((e) => `${e.team_id}:${e.clock_seconds}`)
  );
  const assisted = fgMakes.filter((e) => assistKeys.has(`${e.team_id}:${e.clock_seconds}`)).length;
  return assisted / fgMakes.length;
}

/**
 * Share of *classified* turnovers (ball-handling/bad-pass = live, out-of-
 * bounds/offensive-foul = dead) that were live-ball. Turnovers caused by an
 * opponent steal aren't tagged live/dead in the source play-by-play text at
 * all (only the stealer's own "performed a steal" line exists, no matching
 * cause-tagged line for the player who lost the ball), so this is a share
 * among the turnovers the format *does* classify, not literally every
 * turnover — an honest lower-precision estimate, not the full picture.
 * Returns null if there are no classified turnovers at all.
 */
function computeLiveBallShare(events) {
  const live = events.filter((e) => e.event_type === 'turnover_live').length;
  const dead = events.filter((e) => e.event_type === 'turnover_dead').length;
  const total = live + dead;
  return total > 0 ? live / total : null;
}

/**
 * Groups stints (see rapm.js's buildStints) by the exact 5-player unit that
 * was on court for one specific team, summing minutes and net rating per
 * unique lineup across as many games as are supplied. `stints` entries:
 * `{ playerIds: number[] (sorted, length 5), durationSeconds, netPoints,
 * estPoss }` — netPoints/estPoss already computed by the caller from that
 * stint's home/away split and the game's estimated pace, from this team's
 * perspective. Sorted by minutes played, most-used lineup first.
 */
function computeLineupCombos(stints) {
  const combos = new Map();
  for (const s of stints) {
    const key = s.playerIds.join(',');
    if (!combos.has(key)) {
      combos.set(key, { playerIds: s.playerIds, durationSeconds: 0, netPoints: 0, estPoss: 0 });
    }
    const c = combos.get(key);
    c.durationSeconds += s.durationSeconds;
    c.netPoints += s.netPoints;
    c.estPoss += s.estPoss;
  }
  return [...combos.values()]
    .map((c) => ({
      playerIds: c.playerIds,
      durationSeconds: c.durationSeconds,
      netRatingPer100: c.estPoss > 0 ? (c.netPoints / c.estPoss) * 100 : null,
    }))
    .sort((a, b) => b.durationSeconds - a.durationSeconds);
}

module.exports = { computeAssistedFgPct, computeLiveBallShare, computeLineupCombos };
