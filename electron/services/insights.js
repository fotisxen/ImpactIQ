/**
 * Deterministic "what happened in this game" sentence generation — pure
 * functions, no LLM call and no API cost. Compares this game's numbers
 * against season averages (already excluding this game, computed by the
 * caller) and only speaks up when a deviation is large enough to be worth
 * mentioning, using stat-specific thresholds — a few extra points is
 * nothing for a 20 PPG scorer, everything for a 3 PPG bench player.
 */

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Worth mentioning when either:
 *  - the average is already meaningful and the gap is at least `minDiff`, or
 *  - the average is small (a "breakout" case) and this game's number cleared
 *    `breakoutFloor` outright (e.g. someone who barely rebounds grabbing 3+ OREB).
 */
function isNotable(actual, average, minDiff, breakoutFloor) {
  const diff = actual - average;
  if (Math.abs(diff) >= minDiff) return true;
  if (average < minDiff && actual >= breakoutFloor && diff > 0) return true;
  return false;
}

function pushInsight(list, { team, playerName, polarity, stat, text }) {
  list.push({
    scope: playerName ? 'player' : 'team',
    team,
    playerName: playerName ?? null,
    polarity,
    stat,
    text,
  });
}

/** `seasonAvg` is `{ perGame, games }` for this team, computed over every OTHER game this season. */
function buildTeamInsights(side, teamName, totals, seasonAvg, opponentPts, opponentSeasonAvg) {
  const insights = [];
  if (seasonAvg.games < 1) return insights;

  const avg = seasonAvg.perGame;
  const pts = totals.pts ?? 0;
  if (isNotable(pts, avg.pts ?? 0, 10, 70)) {
    const over = pts > (avg.pts ?? 0);
    pushInsight(insights, {
      team: side,
      polarity: over ? 'positive' : 'negative',
      stat: 'pts',
      text: `${teamName} scored ${pts} points, ${over ? 'well above' : 'well below'} their season average of ${round1(avg.pts ?? 0)}.`,
    });
  }

  const reb = (totals.oreb ?? 0) + (totals.dreb ?? 0);
  const avgReb = (avg.oreb ?? 0) + (avg.dreb ?? 0);
  if (isNotable(reb, avgReb, 8, 40)) {
    const over = reb > avgReb;
    pushInsight(insights, {
      team: side,
      polarity: over ? 'positive' : 'negative',
      stat: 'reb',
      text: `${teamName} pulled down ${reb} rebounds, ${over ? 'well above' : 'well below'} their usual ${round1(avgReb)}.`,
    });
  }

  const tov = totals.tov ?? 0;
  const avgTov = avg.tov ?? 0;
  if (tov - avgTov >= 5) {
    pushInsight(insights, {
      team: side,
      polarity: 'negative',
      stat: 'tov',
      text: `${teamName} turned it over ${tov} times, well above their average of ${round1(avgTov)}.`,
    });
  } else if (avgTov - tov >= 4) {
    pushInsight(insights, {
      team: side,
      polarity: 'positive',
      stat: 'tov',
      text: `${teamName} took care of the ball — just ${tov} turnovers against a season average of ${round1(avgTov)}.`,
    });
  }

  const fga = totals.fga ?? 0;
  const fgm = totals.fgm ?? 0;
  const seasonFga = (avg.fga ?? 0) * seasonAvg.games;
  const seasonFgm = (avg.fgm ?? 0) * seasonAvg.games;
  if (fga >= 20 && seasonFga >= 20) {
    const gameFgPct = fgm / fga;
    const seasonFgPct = seasonFgm / seasonFga;
    const diffPts = (gameFgPct - seasonFgPct) * 100;
    if (Math.abs(diffPts) >= 10) {
      pushInsight(insights, {
        team: side,
        polarity: diffPts > 0 ? 'positive' : 'negative',
        stat: 'fg_pct',
        text: `${teamName} shot ${round1(gameFgPct * 100)}% from the field, ${diffPts > 0 ? 'well above' : 'well below'} their season average of ${round1(seasonFgPct * 100)}%.`,
      });
    }
  }

  // Defensive angle: how the OPPONENT did relative to their own average, attributed to this team's defense.
  if (opponentSeasonAvg.games >= 1) {
    const oppAvgPts = opponentSeasonAvg.perGame.pts ?? 0;
    if (isNotable(opponentPts, oppAvgPts, 10, 0)) {
      const heldDown = opponentPts < oppAvgPts;
      pushInsight(insights, {
        team: side,
        polarity: heldDown ? 'positive' : 'negative',
        stat: 'opp_pts',
        text: heldDown
          ? `${teamName}'s defense held the opponent to ${opponentPts} points, well below their season average of ${round1(oppAvgPts)}.`
          : `${teamName} allowed ${opponentPts} points, well above what the opponent usually scores (${round1(oppAvgPts)}).`,
      });
    }
  }

  return insights;
}

/** `row` is this game's raw box-score line (with `name`); `seasonAvg` is `{ perGame, games, seasonHighPts }` over all of this player's games. */
function buildPlayerInsights(side, row, seasonAvg) {
  const insights = [];
  if (seasonAvg.games < 2) return insights;

  const avg = seasonAvg.perGame;
  const name = row.name;

  if (isNotable(row.pts, avg.pts ?? 0, 8, 12)) {
    const over = row.pts > (avg.pts ?? 0);
    pushInsight(insights, {
      team: side,
      playerName: name,
      polarity: over ? 'positive' : 'negative',
      stat: 'pts',
      text: `${name} scored ${row.pts} points, ${over ? 'well above' : 'well below'} their average of ${round1(avg.pts ?? 0)}.`,
    });
  }

  const reb = row.oreb + row.dreb;
  const avgReb = (avg.oreb ?? 0) + (avg.dreb ?? 0);
  if (isNotable(reb, avgReb, 5, 8)) {
    const over = reb > avgReb;
    pushInsight(insights, {
      team: side,
      playerName: name,
      polarity: over ? 'positive' : 'negative',
      stat: 'reb',
      text: `${name} grabbed ${reb} rebounds, ${over ? 'well above' : 'well below'} their average of ${round1(avgReb)}.`,
    });
  }

  // Called out separately from total rebounds, since a big OREB night can hide inside an otherwise ordinary TRB line.
  if (isNotable(row.oreb, avg.oreb ?? 0, 3, 3) && row.oreb > (avg.oreb ?? 0)) {
    pushInsight(insights, {
      team: side,
      playerName: name,
      polarity: 'positive',
      stat: 'oreb',
      text: `${name} crashed the offensive glass for ${row.oreb} offensive rebounds, well above their usual ${round1(avg.oreb ?? 0)}.`,
    });
  }

  if (isNotable(row.ast, avg.ast ?? 0, 4, 6)) {
    const over = row.ast > (avg.ast ?? 0);
    pushInsight(insights, {
      team: side,
      playerName: name,
      polarity: over ? 'positive' : 'negative',
      stat: 'ast',
      text: `${name} dished out ${row.ast} assists, ${over ? 'well above' : 'well below'} their average of ${round1(avg.ast ?? 0)}.`,
    });
  }

  if (row.tov - (avg.tov ?? 0) >= 3) {
    pushInsight(insights, {
      team: side,
      playerName: name,
      polarity: 'negative',
      stat: 'tov',
      text: `${name} had ${row.tov} turnovers, more than usual (avg ${round1(avg.tov ?? 0)}).`,
    });
  }

  if (row.stl - (avg.stl ?? 0) >= 2) {
    pushInsight(insights, {
      team: side,
      playerName: name,
      polarity: 'positive',
      stat: 'stl',
      text: `${name} was active defensively with ${row.stl} steals (avg ${round1(avg.stl ?? 0)}).`,
    });
  }

  if (row.blk - (avg.blk ?? 0) >= 2) {
    pushInsight(insights, {
      team: side,
      playerName: name,
      polarity: 'positive',
      stat: 'blk',
      text: `${name} protected the rim with ${row.blk} blocks (avg ${round1(avg.blk ?? 0)}).`,
    });
  }

  if (row.fga >= 6 && (avg.fga ?? 0) >= 3) {
    const gameFgPct = row.fga > 0 ? row.fgm / row.fga : 0;
    const seasonFga = (avg.fga ?? 0) * seasonAvg.games;
    const seasonFgm = (avg.fgm ?? 0) * seasonAvg.games;
    const seasonFgPct = seasonFga > 0 ? seasonFgm / seasonFga : 0;
    const diffPts = (gameFgPct - seasonFgPct) * 100;
    if (Math.abs(diffPts) >= 20) {
      pushInsight(insights, {
        team: side,
        playerName: name,
        polarity: diffPts > 0 ? 'positive' : 'negative',
        stat: 'fg_pct',
        text: `${name} shot ${round1(gameFgPct * 100)}% from the field, ${diffPts > 0 ? 'well above' : 'well below'} their season average of ${round1(seasonFgPct * 100)}%.`,
      });
    }
  }

  if (seasonAvg.seasonHighPts !== null && row.pts >= seasonAvg.seasonHighPts && row.pts > (avg.pts ?? 0)) {
    pushInsight(insights, {
      team: side,
      playerName: name,
      polarity: 'positive',
      stat: 'season_high_pts',
      text: `This was a season-high scoring game for ${name}.`,
    });
  }

  return insights;
}

function safeDiv(a, b) {
  return b === 0 ? 0 : a / b;
}

/**
 * Season-long strengths/weaknesses vs a league (or, reused for a player,
 * vs the league) average — percentage-based thresholds rather than the
 * single-game absolute ones, since these are already averaged over many
 * games on both sides. Works for either a team's or a player's per-game
 * line, since the shape (`{pts, oreb, dreb, ast, tov, stl, blk, fgm, fga,
 * tpm, tpa}` per game) is the same either way.
 */
function buildTeamProfileInsights(subjectName, subjectPerGame, leaguePerGame) {
  const insights = [];
  const subjectReb = (subjectPerGame.oreb ?? 0) + (subjectPerGame.dreb ?? 0);
  const leagueReb = (leaguePerGame.oreb ?? 0) + (leaguePerGame.dreb ?? 0);

  const specs = [
    { key: 'pts', label: 'scoring', actual: subjectPerGame.pts ?? 0, base: leaguePerGame.pts ?? 0, goodWhenHigh: true },
    { key: 'reb', label: 'rebounding', actual: subjectReb, base: leagueReb, goodWhenHigh: true },
    { key: 'ast', label: 'ball movement', actual: subjectPerGame.ast ?? 0, base: leaguePerGame.ast ?? 0, goodWhenHigh: true },
    { key: 'tov', label: 'turnovers', actual: subjectPerGame.tov ?? 0, base: leaguePerGame.tov ?? 0, goodWhenHigh: false },
    { key: 'stl', label: 'steals', actual: subjectPerGame.stl ?? 0, base: leaguePerGame.stl ?? 0, goodWhenHigh: true },
    { key: 'blk', label: 'shot blocking', actual: subjectPerGame.blk ?? 0, base: leaguePerGame.blk ?? 0, goodWhenHigh: true },
  ];

  for (const s of specs) {
    if (s.base < 0.5) continue; // too small a league baseline to compare against meaningfully
    const relDiff = (s.actual - s.base) / s.base;
    if (Math.abs(relDiff) < 0.15) continue;
    const isStrength = s.goodWhenHigh ? s.actual > s.base : s.actual < s.base;
    insights.push({
      stat: s.key,
      polarity: isStrength ? 'strength' : 'weakness',
      text: `${isStrength ? 'Strong' : 'Weak'} in ${s.label}: ${round1(s.actual)} vs a league average of ${round1(s.base)}.`,
    });
  }

  const fgPct = safeDiv(subjectPerGame.fgm ?? 0, subjectPerGame.fga ?? 0);
  const leagueFgPct = safeDiv(leaguePerGame.fgm ?? 0, leaguePerGame.fga ?? 0);
  if (Math.abs(fgPct - leagueFgPct) * 100 >= 4) {
    const isStrength = fgPct > leagueFgPct;
    insights.push({
      stat: 'fg_pct',
      polarity: isStrength ? 'strength' : 'weakness',
      text: `Shoots ${round1(fgPct * 100)}% from the field vs a league average of ${round1(leagueFgPct * 100)}%.`,
    });
  }

  const tpPct = safeDiv(subjectPerGame.tpm ?? 0, subjectPerGame.tpa ?? 0);
  const leagueTpPct = safeDiv(leaguePerGame.tpm ?? 0, leaguePerGame.tpa ?? 0);
  if ((subjectPerGame.tpa ?? 0) >= 1 && Math.abs(tpPct - leagueTpPct) * 100 >= 4) {
    const isStrength = tpPct > leagueTpPct;
    insights.push({
      stat: 'tp_pct',
      polarity: isStrength ? 'strength' : 'weakness',
      text: `Shoots ${round1(tpPct * 100)}% from three vs a league average of ${round1(leagueTpPct * 100)}%.`,
    });
  }

  return insights;
}

/**
 * The "how do I beat them" report: how a team's own numbers, and what they
 * allow, differ between their wins and their losses. Whatever's notably
 * worse in losses is the lever an opposing coach can pull — force turnovers,
 * crash the boards, whatever the pattern shows.
 */
function buildLossPatternInsights(teamName, lossPerGame, winPerGame, oppLossPerGame, oppWinPerGame) {
  const insights = [];

  const lossReb = (lossPerGame.oreb ?? 0) + (lossPerGame.dreb ?? 0);
  const winReb = (winPerGame.oreb ?? 0) + (winPerGame.dreb ?? 0);

  const specs = [
    { key: 'pts', label: 'points', unit: '', loss: lossPerGame.pts ?? 0, win: winPerGame.pts ?? 0, minDiff: 6 },
    { key: 'reb', label: 'rebounds', unit: '', loss: lossReb, win: winReb, minDiff: 5 },
    { key: 'ast', label: 'assists', unit: '', loss: lossPerGame.ast ?? 0, win: winPerGame.ast ?? 0, minDiff: 3 },
    { key: 'tov', label: 'turnovers', unit: '', loss: lossPerGame.tov ?? 0, win: winPerGame.tov ?? 0, minDiff: 3, worse: 'more' },
  ];

  for (const s of specs) {
    const diff = s.loss - s.win;
    const worseInLosses = s.worse === 'more' ? diff > 0 : diff < 0;
    if (!worseInLosses || Math.abs(diff) < s.minDiff) continue;
    insights.push({
      stat: s.key,
      text:
        s.key === 'tov'
          ? `${teamName} turns it over ${round1(s.loss)} times per game in losses, vs ${round1(s.win)} in wins.`
          : `${teamName} averages ${round1(s.loss)} ${s.label} in losses, vs ${round1(s.win)} in wins.`,
    });
  }

  const fgPctLoss = safeDiv(lossPerGame.fgm ?? 0, lossPerGame.fga ?? 0);
  const fgPctWin = safeDiv(winPerGame.fgm ?? 0, winPerGame.fga ?? 0);
  if ((fgPctWin - fgPctLoss) * 100 >= 6) {
    insights.push({
      stat: 'fg_pct',
      text: `${teamName} shoots ${round1(fgPctLoss * 100)}% from the field in losses, vs ${round1(fgPctWin * 100)}% in wins — force tougher, contested shots.`,
    });
  }

  const oppPtsLoss = oppLossPerGame.pts ?? 0;
  const oppPtsWin = oppWinPerGame.pts ?? 0;
  if (oppPtsLoss - oppPtsWin >= 6) {
    insights.push({
      stat: 'opp_pts',
      text: `${teamName} allows ${round1(oppPtsLoss)} points per game in losses, vs just ${round1(oppPtsWin)} in wins — pushing pace or getting easy transition buckets works against them.`,
    });
  }

  const oppRebLoss = (oppLossPerGame.oreb ?? 0) + (oppLossPerGame.dreb ?? 0);
  const oppRebWin = (oppWinPerGame.oreb ?? 0) + (oppWinPerGame.dreb ?? 0);
  if (oppRebLoss - oppRebWin >= 5) {
    insights.push({
      stat: 'opp_reb',
      text: `Opponents out-rebound ${teamName} in their losses (${round1(oppRebLoss)} vs ${round1(oppRebWin)} in wins) — crashing the boards against them pays off.`,
    });
  }

  return insights;
}

/** How one player's own numbers differ between games their team won and games their team lost. */
function buildPlayerWinLossInsights(playerName, winPerGame, lossPerGame) {
  const insights = [];
  const diffPts = (winPerGame.pts ?? 0) - (lossPerGame.pts ?? 0);
  if (Math.abs(diffPts) >= 5) {
    insights.push({
      stat: 'pts',
      text:
        diffPts > 0
          ? `${playerName} scores more in wins (${round1(winPerGame.pts ?? 0)}) than in losses (${round1(lossPerGame.pts ?? 0)}).`
          : `${playerName} actually scores more in losses (${round1(lossPerGame.pts ?? 0)}) than in wins (${round1(winPerGame.pts ?? 0)}) — their scoring alone isn't deciding the result.`,
    });
  }

  const diffTov = (lossPerGame.tov ?? 0) - (winPerGame.tov ?? 0);
  if (diffTov >= 2) {
    insights.push({
      stat: 'tov',
      text: `${playerName} turns it over more in losses (${round1(lossPerGame.tov ?? 0)}) than in wins (${round1(winPerGame.tov ?? 0)}).`,
    });
  }

  const diffAst = (winPerGame.ast ?? 0) - (lossPerGame.ast ?? 0);
  if (Math.abs(diffAst) >= 2) {
    insights.push({
      stat: 'ast',
      text:
        diffAst > 0
          ? `${playerName} sets up teammates more in wins (${round1(winPerGame.ast ?? 0)} AST) than in losses (${round1(lossPerGame.ast ?? 0)} AST).`
          : `${playerName} actually assists more in losses (${round1(lossPerGame.ast ?? 0)}) than in wins (${round1(winPerGame.ast ?? 0)}).`,
    });
  }

  return insights;
}

module.exports = {
  buildTeamInsights,
  buildPlayerInsights,
  buildTeamProfileInsights,
  buildLossPatternInsights,
  buildPlayerWinLossInsights,
};
