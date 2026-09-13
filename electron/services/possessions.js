/**
 * Reconstructs possessions from a game's `game_events` stream, purely from
 * event sequencing — no shot-location data involved (that's a separate,
 * still-missing capability; see shotZones.js). Only usable for games with
 * real play-by-play data (`hasPlayByPlayData`), same honesty gate as every
 * other PBP-only metric in this app.
 *
 * A possession ends on a made 2/3-point basket, a turnover, or a defensive
 * rebound; it continues through offensive rebounds and free throws. Free
 * throws don't carry their own "is this the last one of the trip" signal in
 * this event stream, so the end of a free-throw sequence is inferred the
 * moment the *other* team's next event appears — the one genuinely fuzzy
 * corner of this reconstruction, disclosed here rather than silently assumed
 * correct.
 *
 * Fastbreak detection uses an 8-second-since-gaining-the-ball threshold — a
 * standard heuristic used across basketball analytics when clean play-type
 * tagging isn't available, not a precise classification.
 */
function reconstructGamePossessions(events, homeTeamId, awayTeamId) {
  const relevant = events
    .filter((e) => ['score', 'miss', 'turnover_live', 'turnover_dead', 'reb_off', 'reb_def'].includes(e.event_type))
    .sort((a, b) => a.clock_seconds - b.clock_seconds || a.sequence - b.sequence);

  const possessions = [];
  let current = null;

  function close() {
    if (current) possessions.push(current);
    current = null;
  }
  function open(teamId, atSeconds, startedAfterTurnover) {
    close();
    current = { teamId, startClockSeconds: atSeconds, startedAfterTurnover, isSecondChance: false, isFastbreak: false, points: 0 };
  }

  for (const e of relevant) {
    if (current && e.team_id !== current.teamId && e.event_type !== 'reb_def') {
      // Possession changed hands without one of the explicit boundary events below having
      // fired yet — most commonly, the tail of a free-throw trip with no rebound event.
      open(e.team_id, e.clock_seconds, false);
    } else if (!current) {
      open(e.team_id, e.clock_seconds, false);
    }

    if (e.event_type === 'score') {
      current.points += e.points || 0;
      if (e.points >= 2 && e.clock_seconds - current.startClockSeconds <= 8) current.isFastbreak = true;
      if (e.points >= 2) close(); // a made FT (points === 1) doesn't end the trip by itself
    } else if (e.event_type === 'reb_def') {
      open(e.team_id, e.clock_seconds, false);
    } else if (e.event_type === 'reb_off') {
      current.isSecondChance = true;
    } else if (e.event_type === 'turnover_live' || e.event_type === 'turnover_dead') {
      const otherTeamId = e.team_id === homeTeamId ? awayTeamId : homeTeamId;
      close();
      open(otherTeamId, e.clock_seconds, true);
    }
    // 'miss' carries no possession-ending signal by itself — resolved by whatever follows.
  }
  close();

  return possessions;
}

/** Sums the 3 possession-derived "Points off ___" stats for one team from an already-reconstructed possession list. */
function possessionStatsForTeam(possessions, teamId) {
  let pointsOffTurnovers = 0;
  let secondChancePoints = 0;
  let fastbreakPoints = 0;
  for (const p of possessions) {
    if (p.teamId !== teamId || p.points <= 0) continue;
    if (p.startedAfterTurnover) pointsOffTurnovers += p.points;
    if (p.isSecondChance) secondChancePoints += p.points;
    if (p.isFastbreak) fastbreakPoints += p.points;
  }
  return { pointsOffTurnovers, secondChancePoints, fastbreakPoints };
}

module.exports = { reconstructGamePossessions, possessionStatsForTeam };
