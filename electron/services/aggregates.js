/**
 * Supabase-backed replacements for the box-score aggregation helpers that
 * used to be local SQLite `db.prepare(...).all()` calls directly inside
 * electron/ipc.js. Every function here returns the EXACT same shape the
 * original SQLite version did (`{ rows, totals, games, teamGames? }`) so
 * every downstream caller — buildStatSummary, computePlayerSummary,
 * computeTeamSummary, and the statsEngine formulas — needs zero changes,
 * only `await` added at the call site.
 *
 * Deliberately avoids PostgREST's dot-path embedded-resource filtering
 * (e.g. `.eq('players.team_id', x)`) in favor of a plain 2-3 step
 * id-resolution (fetch matching player/game ids first, then box_scores
 * `.in(...)` those) — more verbose, but every step uses only basic
 * `.eq()`/`.in()`, nothing that depends on a specific PostgREST version's
 * embedded-filter behavior.
 */
const { sumRows } = require('./statsEngine');

const BOX_SCORE_COLUMNS =
  'id, game_id, player_id, min, pts, fgm, fga, tpm, tpa, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pfd, plus_minus, srj';

async function playerIdsForTeam(supabase, teamId) {
  const { data, error } = await supabase.from('players').select('id').eq('team_id', teamId);
  if (error) throw new Error(`playerIdsForTeam: ${error.message}`);
  return (data ?? []).map((p) => p.id);
}

async function gameIdsForSeason(supabase, seasonId) {
  const { data, error } = await supabase.from('games').select('id').eq('season_id', seasonId).is('deleted_at', null);
  if (error) throw new Error(`gameIdsForSeason: ${error.message}`);
  return (data ?? []).map((g) => g.id);
}

async function boxScoresByPlayerIds(supabase, playerIds, gameIds) {
  if (playerIds.length === 0) return [];
  if (gameIds && gameIds.length === 0) return [];
  let query = supabase.from('box_scores').select(BOX_SCORE_COLUMNS).in('player_id', playerIds);
  if (gameIds) query = query.in('game_id', gameIds);
  const { data, error } = await query;
  if (error) throw new Error(`boxScoresByPlayerIds: ${error.message}`);
  return data ?? [];
}

function shape(rows) {
  return { rows, totals: sumRows(rows), games: new Set(rows.map((r) => r.game_id)).size };
}

/** Every box-score row for a team, optionally scoped to one season. */
async function teamAggregate(supabase, teamId, seasonId) {
  const playerIds = await playerIdsForTeam(supabase, teamId);
  const gameIds = seasonId ? await gameIdsForSeason(supabase, seasonId) : null;
  const rows = await boxScoresByPlayerIds(supabase, playerIds, gameIds);
  return shape(rows);
}

/**
 * For every game `teamId` played, the *other* team's box-score rows —
 * "boards/possessions available to the opponent", the missing half of
 * every rebounding %, steal %, block %, and PIE formula.
 */
async function opponentAggregate(supabase, teamId, seasonId) {
  let gamesQuery = supabase.from('games').select('id, home_team_id, away_team_id').or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  if (seasonId) gamesQuery = gamesQuery.eq('season_id', seasonId);
  const { data: games, error: gamesErr } = await gamesQuery;
  if (gamesErr) throw new Error(`opponentAggregate games: ${gamesErr.message}`);

  if (!games || games.length === 0) return shape([]);

  // For each game, resolve which side WASN'T teamId, and collect the
  // opponent team ids actually faced (rarely more than a handful of
  // distinct opponents, even across a full season).
  const opponentTeamIds = new Set(games.map((g) => (g.home_team_id === teamId ? g.away_team_id : g.home_team_id)));
  const gameIds = games.map((g) => g.id);

  const { data: opponentPlayers, error: playerErr } = await supabase
    .from('players')
    .select('id, team_id')
    .in('team_id', [...opponentTeamIds]);
  if (playerErr) throw new Error(`opponentAggregate players: ${playerErr.message}`);

  const { data: rows, error: bsErr } = await supabase
    .from('box_scores')
    .select(BOX_SCORE_COLUMNS)
    .in('player_id', (opponentPlayers ?? []).map((p) => p.id))
    .in('game_id', gameIds);
  if (bsErr) throw new Error(`opponentAggregate box_scores: ${bsErr.message}`);

  // A player row only counts if it's from a game the two teams actually
  // played each other in — filter out any opponent-team box score from a
  // DIFFERENT game (the .in() above already scoped by gameIds, so this is
  // just being explicit that the join logic matches the original SQL's
  // per-game home/away pairing, not "any game either team played").
  return shape(rows ?? []);
}

/**
 * Every box score row for every team in a league, all-time (not
 * season-scoped) — used as the PER/impact-score baseline for player and
 * team views. `teamGames` counts distinct (game, team) pairs rather than
 * distinct games, since a real game contributes two teams' worth of stats
 * to `totals`.
 */
async function leagueAggregate(supabase, leagueId) {
  const { data: teams, error: teamErr } = await supabase.from('teams').select('id').eq('league_id', leagueId);
  if (teamErr) throw new Error(`leagueAggregate teams: ${teamErr.message}`);
  const teamIds = (teams ?? []).map((t) => t.id);
  if (teamIds.length === 0) return { rows: [], totals: sumRows([]), games: 0, teamGames: 0 };

  const { data: players, error: playerErr } = await supabase.from('players').select('id, team_id').in('team_id', teamIds);
  if (playerErr) throw new Error(`leagueAggregate players: ${playerErr.message}`);
  const teamIdByPlayerId = new Map((players ?? []).map((p) => [p.id, p.team_id]));

  const { data: rawRows, error: bsErr } = await supabase
    .from('box_scores')
    .select(BOX_SCORE_COLUMNS)
    .in('player_id', [...teamIdByPlayerId.keys()]);
  if (bsErr) throw new Error(`leagueAggregate box_scores: ${bsErr.message}`);

  const rows = (rawRows ?? []).map((r) => ({ ...r, team_id: teamIdByPlayerId.get(r.player_id) }));
  return {
    rows,
    totals: sumRows(rows),
    games: new Set(rows.map((r) => r.game_id)).size,
    teamGames: new Set(rows.map((r) => `${r.game_id}:${r.team_id}`)).size,
  };
}

/** Same shape as leagueAggregate, restricted to one season. */
async function leagueAggregateForSeason(supabase, leagueId, seasonId) {
  const rows = await leagueSeasonRows(supabase, leagueId, seasonId);
  return {
    rows,
    totals: sumRows(rows),
    games: new Set(rows.map((r) => r.game_id)).size,
    teamGames: new Set(rows.map((r) => `${r.game_id}:${r.team_id}`)).size,
  };
}

/** Every box-score row for a league+season, each tagged with team_id/team_name/player_name — used by leaderboard/ranking handlers that group in JS. */
async function leagueSeasonRows(supabase, leagueId, seasonId) {
  const { data: teams, error: teamErr } = await supabase.from('teams').select('id, name').eq('league_id', leagueId);
  if (teamErr) throw new Error(`leagueSeasonRows teams: ${teamErr.message}`);
  const teamIds = (teams ?? []).map((t) => t.id);
  if (teamIds.length === 0) return [];
  const teamNameById = new Map((teams ?? []).map((t) => [t.id, t.name]));

  const { data: players, error: playerErr } = await supabase.from('players').select('id, name, team_id').in('team_id', teamIds);
  if (playerErr) throw new Error(`leagueSeasonRows players: ${playerErr.message}`);
  const playerById = new Map((players ?? []).map((p) => [p.id, p]));

  const gameIds = await gameIdsForSeason(supabase, seasonId);
  if (gameIds.length === 0) return [];

  const { data: rawRows, error: bsErr } = await supabase
    .from('box_scores')
    .select(BOX_SCORE_COLUMNS)
    .in('player_id', [...playerById.keys()])
    .in('game_id', gameIds);
  if (bsErr) throw new Error(`leagueSeasonRows box_scores: ${bsErr.message}`);

  return (rawRows ?? []).map((r) => {
    const player = playerById.get(r.player_id);
    return { ...r, team_id: player?.team_id ?? null, team_name: teamNameById.get(player?.team_id) ?? null, player_name: player?.name ?? null };
  });
}

/**
 * Same shape as teamAggregate, restricted to an exact set of game ids —
 * used instead of a date cutoff for the team's own games, since two games
 * on the same calendar date would otherwise both match a "<= cutoff date"
 * comparison and blur the "through game #N" boundary.
 */
async function teamAggregateThrough(supabase, teamId, gameIds) {
  if (gameIds.length === 0) return { rows: [], totals: sumRows([]), games: 0 };
  const playerIds = await playerIdsForTeam(supabase, teamId);
  const rows = await boxScoresByPlayerIds(supabase, playerIds, gameIds);
  return shape(rows);
}

/** Same shape as opponentAggregate, restricted to an exact set of game ids. */
async function opponentAggregateThrough(supabase, teamId, gameIds) {
  if (gameIds.length === 0) return { rows: [], totals: sumRows([]), games: 0 };
  const { data: games, error: gamesErr } = await supabase.from('games').select('id, home_team_id, away_team_id').in('id', gameIds);
  if (gamesErr) throw new Error(`opponentAggregateThrough games: ${gamesErr.message}`);

  const relevant = (games ?? []).filter((g) => g.home_team_id === teamId || g.away_team_id === teamId);
  if (relevant.length === 0) return shape([]);
  const opponentTeamIds = new Set(relevant.map((g) => (g.home_team_id === teamId ? g.away_team_id : g.home_team_id)));

  const { data: opponentPlayers, error: playerErr } = await supabase.from('players').select('id').in('team_id', [...opponentTeamIds]);
  if (playerErr) throw new Error(`opponentAggregateThrough players: ${playerErr.message}`);

  const rows = await boxScoresByPlayerIds(
    supabase,
    (opponentPlayers ?? []).map((p) => p.id),
    relevant.map((g) => g.id)
  );
  return shape(rows);
}

/** Date-filtered variant of leagueAggregate — see leagueAggregate for the shape this mirrors. */
async function leagueAggregateThrough(supabase, leagueId, seasonId, cutoffDate) {
  const { data: teams, error: teamErr } = await supabase.from('teams').select('id').eq('league_id', leagueId);
  if (teamErr) throw new Error(`leagueAggregateThrough teams: ${teamErr.message}`);
  const teamIds = (teams ?? []).map((t) => t.id);
  if (teamIds.length === 0) return { rows: [], totals: sumRows([]), games: 0, teamGames: 0 };

  const { data: players, error: playerErr } = await supabase.from('players').select('id, team_id').in('team_id', teamIds);
  if (playerErr) throw new Error(`leagueAggregateThrough players: ${playerErr.message}`);
  const teamIdByPlayerId = new Map((players ?? []).map((p) => [p.id, p.team_id]));

  const { data: games, error: gameErr } = await supabase
    .from('games')
    .select('id')
    .eq('season_id', seasonId)
    .lte('date', cutoffDate)
    .is('deleted_at', null);
  if (gameErr) throw new Error(`leagueAggregateThrough games: ${gameErr.message}`);
  const gameIds = (games ?? []).map((g) => g.id);
  if (gameIds.length === 0) return { rows: [], totals: sumRows([]), games: 0, teamGames: 0 };

  const { data: rawRows, error: bsErr } = await supabase
    .from('box_scores')
    .select(BOX_SCORE_COLUMNS)
    .in('player_id', [...teamIdByPlayerId.keys()])
    .in('game_id', gameIds);
  if (bsErr) throw new Error(`leagueAggregateThrough box_scores: ${bsErr.message}`);

  const rows = (rawRows ?? []).map((r) => ({ ...r, team_id: teamIdByPlayerId.get(r.player_id) }));
  return {
    rows,
    totals: sumRows(rows),
    games: new Set(rows.map((r) => r.game_id)).size,
    teamGames: new Set(rows.map((r) => `${r.game_id}:${r.team_id}`)).size,
  };
}

module.exports = {
  teamAggregate,
  opponentAggregate,
  leagueAggregate,
  leagueAggregateForSeason,
  leagueSeasonRows,
  teamAggregateThrough,
  opponentAggregateThrough,
  leagueAggregateThrough,
  playerIdsForTeam,
  gameIdsForSeason,
  boxScoresByPlayerIds,
  BOX_SCORE_COLUMNS,
};
