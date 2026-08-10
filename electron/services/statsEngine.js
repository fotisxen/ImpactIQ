/**
 * Pure, dependency-free stat calculations. Input is always a "box score row"
 * shape (see db/schema.sql box_scores columns), whether that row is a single
 * player-game, a summed team-game, or a summed/averaged league line.
 *
 * Kept framework-agnostic on purpose: no Electron, no DB, no Angular. This
 * file (or a straight TS port of it) can be shared into the renderer too.
 */

function safeDiv(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** True Shooting % */
function trueShootingPct(row) {
  return safeDiv(row.pts, 2 * (row.fga + 0.44 * row.fta));
}

/** Effective Field Goal % — values 3s appropriately */
function effectiveFgPct(row) {
  return safeDiv(row.fgm + 0.5 * row.tpm, row.fga);
}

/** Simple per-game shooting splits */
function fgPct(row) {
  return safeDiv(row.fgm, row.fga);
}
function tpPct(row) {
  return safeDiv(row.tpm, row.tpa);
}
function ftPct(row) {
  return safeDiv(row.ftm, row.fta);
}

/**
 * PIR — the EuroLeague/FIBA "Performance Index Rating".
 * (PTS + REB + AST + STL + BLK + FoulsDrawn)
 *  − (MissedFG + MissedFT + TOV + Fouls Committed + BlocksAgainst)
 * We don't track "fouls drawn" or "blocked against" from a standard box
 * score, so this is the commonly-used simplified version.
 */
function pir(row) {
  const positive = row.pts + row.oreb + row.dreb + row.ast + row.stl + row.blk;
  const negative =
    (row.fga - row.fgm) + (row.fta - row.ftm) + row.tov + row.pf;
  return positive - negative;
}

/** Rebounds, assists, etc. per-36-minutes, for comparing players with different minutes loads */
function per36(row, statKey) {
  return safeDiv(row[statKey] * 36, row.min);
}

/* ==========================================================================
 * Scoring — points-per-shot-type and points-per-possession. Self-contained
 * (only need the row itself), so these apply identically to a team or an
 * individual row.
 * ========================================================================== */
function pp2ps(row) {
  return safeDiv(2 * (row.fgm - row.tpm), row.fga - row.tpa);
}
function pp3ps(row) {
  return safeDiv(3 * row.tpm, row.tpa);
}
/** Points per free-throw attempt — numerically the same as FT%, framed as a scoring-rate stat. */
function ppft(row) {
  return safeDiv(row.ftm, row.fta);
}
function pointsPerShot(row) {
  return safeDiv(row.pts, row.fga);
}
function pointsPerPossession(row) {
  return safeDiv(row.pts, estimatePossessions(row));
}
function pointsPer100Poss(row) {
  return pointsPerPossession(row) * 100;
}

/* ==========================================================================
 * Shooting — shot-selection rates. Also self-contained.
 * ========================================================================== */
function ftRate(row) {
  return safeDiv(row.fta, row.fga);
}
function threePtAttemptRate(row) {
  return safeDiv(row.tpa, row.fga);
}

/* ==========================================================================
 * Rebounding % — needs the opponent's totals for the same games (the boards
 * "available" to grab are this team's + the opponent's). Team-level formulas
 * are plain share-of-available-boards; individual formulas additionally
 * prorate by (team minutes / 5) vs the player's own minutes, the classic
 * Dean Oliver box-score approximation used when on-court/off-court data
 * isn't available.
 * ========================================================================== */
function teamOrebPct(teamRow, oppRow) {
  return safeDiv(teamRow.oreb, teamRow.oreb + oppRow.dreb);
}
function teamDrebPct(teamRow, oppRow) {
  return safeDiv(teamRow.dreb, teamRow.dreb + oppRow.oreb);
}
function teamTrebPct(teamRow, oppRow) {
  const teamTrb = teamRow.oreb + teamRow.dreb;
  const oppTrb = oppRow.oreb + oppRow.dreb;
  return safeDiv(teamTrb, teamTrb + oppTrb);
}

function orebPct(playerRow, teamRow, oppRow) {
  const teamMpPerSlot = safeDiv(teamRow.min, 5);
  return safeDiv(playerRow.oreb * teamMpPerSlot, playerRow.min * (teamRow.oreb + oppRow.dreb));
}
function drebPct(playerRow, teamRow, oppRow) {
  const teamMpPerSlot = safeDiv(teamRow.min, 5);
  return safeDiv(playerRow.dreb * teamMpPerSlot, playerRow.min * (teamRow.dreb + oppRow.oreb));
}
function trebPct(playerRow, teamRow, oppRow) {
  const teamMpPerSlot = safeDiv(teamRow.min, 5);
  const playerTrb = playerRow.oreb + playerRow.dreb;
  const teamTrb = teamRow.oreb + teamRow.dreb;
  const oppTrb = oppRow.oreb + oppRow.dreb;
  return safeDiv(playerTrb * teamMpPerSlot, playerRow.min * (teamTrb + oppTrb));
}

/** Rebounding % line, team or individual depending on whether `isTeam` is set. */
function reboundingStatLine({ row, teamRow, oppRow, isTeam }) {
  if (isTeam) {
    return {
      oreb_pct: teamOrebPct(row, oppRow),
      dreb_pct: teamDrebPct(row, oppRow),
      treb_pct: teamTrebPct(row, oppRow),
    };
  }
  return {
    oreb_pct: orebPct(row, teamRow, oppRow),
    dreb_pct: drebPct(row, teamRow, oppRow),
    treb_pct: trebPct(row, teamRow, oppRow),
  };
}

/* ==========================================================================
 * Ball handling % — same team-vs-opponent-vs-proration shape as rebounding.
 * USG% is individual-only (a team is trivially 100% of its own usage).
 * ========================================================================== */
function teamAstPct(teamRow) {
  return safeDiv(teamRow.ast, teamRow.fgm);
}
function teamTovPct(teamRow) {
  return safeDiv(teamRow.tov, teamRow.fga + 0.44 * teamRow.fta + teamRow.tov);
}
function teamStlPct(teamRow, oppRow) {
  return safeDiv(teamRow.stl, estimatePossessions(oppRow));
}
function teamBlkPct(teamRow, oppRow) {
  return safeDiv(teamRow.blk, oppRow.fga - oppRow.tpa);
}

function astPct(playerRow, teamRow) {
  const teamMpPerSlot = safeDiv(teamRow.min, 5);
  const scaledTeamFgm = safeDiv(playerRow.min, teamMpPerSlot) * teamRow.fgm;
  return safeDiv(playerRow.ast, scaledTeamFgm - playerRow.fgm);
}
function tovPct(playerRow) {
  return safeDiv(playerRow.tov, playerRow.fga + 0.44 * playerRow.fta + playerRow.tov);
}
function stlPct(playerRow, teamRow, oppRow) {
  const teamMpPerSlot = safeDiv(teamRow.min, 5);
  return safeDiv(playerRow.stl * teamMpPerSlot, playerRow.min * estimatePossessions(oppRow));
}
function blkPct(playerRow, teamRow, oppRow) {
  const teamMpPerSlot = safeDiv(teamRow.min, 5);
  return safeDiv(playerRow.blk * teamMpPerSlot, playerRow.min * (oppRow.fga - oppRow.tpa));
}
/** Usage %, properly prorated by team minutes — replaces the old unprorated approximation. */
function usgPct(playerRow, teamRow) {
  const teamMpPerSlot = safeDiv(teamRow.min, 5);
  const playerPoss = playerRow.fga + 0.44 * playerRow.fta + playerRow.tov;
  const teamPoss = teamRow.fga + 0.44 * teamRow.fta + teamRow.tov;
  return safeDiv(playerPoss * teamMpPerSlot, playerRow.min * teamPoss);
}

/** Ball-handling % line, team or individual depending on whether `isTeam` is set. */
function ballHandlingStatLine({ row, teamRow, oppRow, isTeam }) {
  if (isTeam) {
    return {
      ast_pct: teamAstPct(row),
      tov_pct: teamTovPct(row),
      stl_pct: teamStlPct(row, oppRow),
      blk_pct: teamBlkPct(row, oppRow),
      usg_pct: null,
    };
  }
  return {
    ast_pct: astPct(row, teamRow),
    tov_pct: tovPct(row),
    stl_pct: stlPct(row, teamRow, oppRow),
    blk_pct: blkPct(row, teamRow, oppRow),
    usg_pct: usgPct(row, teamRow),
  };
}

/**
 * PIE (Player/Team Impact Estimate) — % of all statistical "events" in the
 * relevant games that belong to this subject. Fully computable from box
 * score data (NBA's own official formula), unlike EPM/LEBRON/RAPM/DARKO
 * which need on/off-court tracking and play-by-play data this app doesn't
 * collect. `teamRow` already includes the subject's own contribution (for
 * an individual player, their stats are part of their team's totals) —
 * only `oppRow` needs adding separately.
 */
function eventScore(row) {
  return (
    row.pts +
    row.fgm +
    row.ftm -
    row.fga -
    row.fta +
    row.dreb +
    0.5 * row.oreb +
    row.ast +
    row.stl +
    0.5 * row.blk -
    row.pf -
    row.tov
  );
}
function pie(subjectRow, teamRow, oppRow) {
  return safeDiv(eventScore(subjectRow), eventScore(teamRow) + eventScore(oppRow));
}

/**
 * Sums an array of box score rows into one aggregate row (e.g. all of a
 * player's games -> season totals, or all players in a game -> team totals).
 */
function sumRows(rows) {
  const numericKeys = [
    'min', 'pts', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta',
    'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf', 'pfd', 'plus_minus',
  ];
  return rows.reduce((acc, row) => {
    for (const key of numericKeys) acc[key] = (acc[key] || 0) + (row[key] || 0);
    return acc;
  }, {});
}

/** Divides every numeric field of a summed row by a game count, for per-game averages */
function perGame(summedRow, gameCount) {
  const out = {};
  for (const [key, value] of Object.entries(summedRow)) {
    out[key] = safeDiv(value, gameCount);
  }
  return out;
}

/**
 * Builds the "self-contained" advanced-stat line for a row — Scoring and
 * Shooting stats, which only need the row itself, on top of its raw
 * counting stats. Works identically for a team or an individual row. The
 * stats that need team/opponent context (Rebounding %, Ball handling %,
 * usg_pct) live in `reboundingStatLine`/`ballHandlingStatLine` instead.
 */
function advancedStatLine(row) {
  return {
    ts_pct: trueShootingPct(row),
    efg_pct: effectiveFgPct(row),
    fg_pct: fgPct(row),
    tp_pct: tpPct(row),
    ft_pct: ftPct(row),
    pir: pir(row),
    pp2ps: pp2ps(row),
    pp3ps: pp3ps(row),
    ppft: ppft(row),
    points_per_shot: pointsPerShot(row),
    points_per_poss: pointsPerPossession(row),
    points_per_100poss: pointsPer100Poss(row),
    ft_rate: ftRate(row),
    three_pt_attempt_rate: threePtAttemptRate(row),
  };
}

/**
 * Compares two aggregate rows (player vs team, team vs league, my-team vs
 * public-league-average — same shape, same function) across a chosen list
 * of stat keys. Always compare per-game or per-36 values, never raw totals
 * across entities with different game counts.
 */
function compareTo(rowA, rowB, statKeys) {
  return statKeys.map((key) => ({
    stat: key,
    a: rowA[key] ?? null,
    b: rowB[key] ?? null,
    diff: (rowA[key] ?? 0) - (rowB[key] ?? 0),
  }));
}

/** Estimated possessions, the same "no play-by-play" approximation used elsewhere in this file. */
function estimatePossessions(totals) {
  return totals.fga - totals.oreb + totals.tov + 0.44 * totals.fta;
}

function pacePerGame(totals, games) {
  return safeDiv(estimatePossessions(totals), games);
}

/**
 * Hollinger's unadjusted PER (uPER), before pace adjustment/normalization.
 * `playerTotals`/`teamTotals`/`leagueTotals` are all summed rows (see
 * sumRows) — team totals supply the team-assist factor, league totals
 * supply VOP/DRB%/the league free-throw-to-foul ratio.
 */
function unadjustedPER(playerTotals, teamTotals, leagueTotals) {
  const lg = leagueTotals;
  const teamAstFgRatio = safeDiv(teamTotals.ast, teamTotals.fgm);
  const factor = 2 / 3 - (0.5 * safeDiv(lg.ast, lg.fgm)) / (2 * safeDiv(lg.fgm, lg.ftm));
  const vop = safeDiv(lg.pts, lg.fga - lg.oreb + lg.tov + 0.44 * lg.fta);
  const lgTotalReb = lg.oreb + lg.dreb;
  const drbp = safeDiv(lg.dreb, lgTotalReb);

  const p = playerTotals;
  const playerTotalReb = p.oreb + p.dreb;

  const raw =
    p.tpm +
    (2 / 3) * p.ast +
    (2 - factor * teamAstFgRatio) * p.fgm +
    p.ftm * 0.5 * (1 + (1 - teamAstFgRatio) + (2 / 3) * teamAstFgRatio) -
    vop * p.tov -
    vop * drbp * (p.fga - p.fgm) -
    vop * 0.44 * (0.44 + 0.56 * drbp) * (p.fta - p.ftm) +
    vop * (1 - drbp) * (playerTotalReb - p.oreb) +
    vop * drbp * p.oreb +
    vop * p.stl +
    vop * drbp * p.blk -
    p.pf * (safeDiv(lg.ftm, lg.pf) - 0.44 * safeDiv(lg.fta, lg.pf) * vop);

  return safeDiv(raw, p.min);
}

/**
 * PER, approximated as closely as a box-score-only dataset allows: real
 * play-by-play pace isn't available, so team/league "pace" is estimated
 * the same way `estimatePossessions` does elsewhere in this file.
 * League-average uPER (the 15.0 normalization baseline) is approximated by
 * running the same formula with the league's own totals standing in for
 * "the average player" — cheaper than looping every player in the league,
 * and self-consistent since a league's per-minute rates already represent
 * its average player.
 *
 * `leagueTotals` is the sum of every individual player-game row in the
 * league (see `leagueSeasonRows` in ipc.js) — each real game contributes
 * two teams' worth of stats to it, so the pace comparison needs
 * `leagueTeamGames` (distinct game+team appearances), not the plain game
 * count, or every team would look ~2x too fast relative to the league.
 */
function per({ playerTotals, teamTotals, teamGames, leagueTotals, leagueTeamGames }) {
  const uPER = unadjustedPER(playerTotals, teamTotals, leagueTotals);
  const teamPace = pacePerGame(teamTotals, teamGames);
  const leaguePace = pacePerGame(leagueTotals, leagueTeamGames);
  const paceAdjusted = uPER * safeDiv(leaguePace, teamPace);

  const leagueBaselineUPER = unadjustedPER(leagueTotals, leagueTotals, leagueTotals);
  return safeDiv(paceAdjusted * 15, leagueBaselineUPER);
}

/**
 * A from-scratch "BPM-style" composite: value over league-average per game,
 * weighted by roughly how much each stat tends to matter. This is NOT the
 * Sports-Reference BPM formula (which needs player position and play-by-play
 * data this app doesn't collect) — it's an honest approximation in the same
 * spirit, built entirely from box-score per-game stats.
 */
function impactScore(perGameRow, leagueAvgPerGame, tsPct, leagueAvgTsPct) {
  const rebDiff =
    perGameRow.oreb + perGameRow.dreb - (leagueAvgPerGame.oreb + leagueAvgPerGame.dreb);

  return (
    1.0 * (perGameRow.pts - leagueAvgPerGame.pts) +
    0.7 * rebDiff +
    1.5 * (perGameRow.ast - leagueAvgPerGame.ast) +
    2.0 * (perGameRow.stl - leagueAvgPerGame.stl) +
    1.5 * (perGameRow.blk - leagueAvgPerGame.blk) -
    1.0 * (perGameRow.tov - leagueAvgPerGame.tov) +
    30 * (tsPct - leagueAvgTsPct)
  );
}

module.exports = {
  trueShootingPct,
  effectiveFgPct,
  fgPct,
  tpPct,
  ftPct,
  pir,
  per36,
  sumRows,
  perGame,
  advancedStatLine,
  compareTo,
  per,
  impactScore,
  estimatePossessions,
  reboundingStatLine,
  ballHandlingStatLine,
  pie,
};
