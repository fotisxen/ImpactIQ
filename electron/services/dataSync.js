const { getSupabaseClient } = require('./supabaseClient');
const { getTier } = require('./subscriptions');

// --- sync_map helpers ---------------------------------------------------
// One local SQLite table bridges this install's autoincrement ids to the
// matching Supabase row ids for every entity that's ever been pushed or
// pulled — local and remote ids are independent number spaces, so a
// natural-key lookup-or-create can't just reuse one as the other. Used in
// both directions: local->remote when pushing a save, remote->local when
// pulling the cloud's view of what this account can see.

function localIdForRemote(db, entityType, remoteId) {
  const row = db.prepare(`SELECT local_id FROM sync_map WHERE entity_type = ? AND remote_id = ?`).get(entityType, String(remoteId));
  return row ? row.local_id : null;
}

function remoteIdForLocal(db, entityType, localId) {
  const row = db.prepare(`SELECT remote_id FROM sync_map WHERE entity_type = ? AND local_id = ?`).get(entityType, localId);
  return row ? row.remote_id : null;
}

function setSyncMap(db, entityType, localId, remoteId) {
  db.prepare(
    `INSERT INTO sync_map (entity_type, local_id, remote_id) VALUES (?, ?, ?)
     ON CONFLICT(entity_type, local_id) DO UPDATE SET remote_id = excluded.remote_id`
  ).run(entityType, localId, String(remoteId));
}

// --- Push: local -> Supabase (Manual/Photo tier only) --------------------

function fetchLocalGameForSync(db, localGameId) {
  const game = db
    .prepare(
      `SELECT g.*, s.year AS season_year, l.id AS league_local_id, l.name AS league_name,
              l.country AS league_country, l.tier AS league_tier
       FROM games g
       JOIN seasons s ON s.id = g.season_id
       JOIN leagues l ON l.id = s.league_id
       WHERE g.id = ?`
    )
    .get(localGameId);
  if (!game) throw new Error(`Local game ${localGameId} not found.`);

  const homeTeam = db.prepare(`SELECT * FROM teams WHERE id = ?`).get(game.home_team_id);
  const awayTeam = db.prepare(`SELECT * FROM teams WHERE id = ?`).get(game.away_team_id);
  const roster = db
    .prepare(
      `SELECT b.*, p.name AS player_name, p.team_id
       FROM box_scores b JOIN players p ON p.id = b.player_id
       WHERE b.game_id = ?`
    )
    .all(localGameId);

  return { game, homeTeam, awayTeam, roster };
}

async function lookupOrCreateRemoteLeague(supabase, db, local) {
  const cached = remoteIdForLocal(db, 'league', local.league_local_id);
  if (cached) return cached;

  const { data: existing, error: findErr } = await supabase
    .from('leagues')
    .select('id')
    .eq('name', local.league_name)
    .maybeSingle();
  if (findErr) throw new Error(`lookup remote league: ${findErr.message}`);

  let remoteId = existing?.id;
  if (!remoteId) {
    const { data: created, error } = await supabase
      .from('leagues')
      .insert({ name: local.league_name, country: local.league_country, tier: local.league_tier, source: 'manual' })
      .select('id')
      .single();
    if (error) throw new Error(`create remote league: ${error.message}`);
    remoteId = created.id;
  }
  setSyncMap(db, 'league', local.league_local_id, remoteId);
  return remoteId;
}

async function lookupOrCreateRemoteSeason(supabase, db, remoteLeagueId, local) {
  const cached = remoteIdForLocal(db, 'season', local.season_id);
  if (cached) return cached;

  const { data: existing, error: findErr } = await supabase
    .from('seasons')
    .select('id')
    .eq('league_id', remoteLeagueId)
    .eq('year', local.season_year)
    .maybeSingle();
  if (findErr) throw new Error(`lookup remote season: ${findErr.message}`);

  let remoteId = existing?.id;
  if (!remoteId) {
    const { data: created, error } = await supabase
      .from('seasons')
      .insert({ league_id: remoteLeagueId, year: local.season_year })
      .select('id')
      .single();
    if (error) throw new Error(`create remote season: ${error.message}`);
    remoteId = created.id;
  }
  setSyncMap(db, 'season', local.season_id, remoteId);
  return remoteId;
}

async function lookupOrCreateRemoteTeam(supabase, db, remoteLeagueId, localTeam) {
  const cached = remoteIdForLocal(db, 'team', localTeam.id);
  if (cached) return cached;

  const { data: existing, error: findErr } = await supabase
    .from('teams')
    .select('id')
    .eq('league_id', remoteLeagueId)
    .eq('name', localTeam.name)
    .maybeSingle();
  if (findErr) throw new Error(`lookup remote team: ${findErr.message}`);

  let remoteId = existing?.id;
  if (!remoteId) {
    const { data: created, error } = await supabase
      .from('teams')
      .insert({ league_id: remoteLeagueId, name: localTeam.name, is_my_team: !!localTeam.is_my_team })
      .select('id')
      .single();
    if (error) throw new Error(`create remote team: ${error.message}`);
    remoteId = created.id;
  }
  setSyncMap(db, 'team', localTeam.id, remoteId);
  return remoteId;
}

async function lookupOrCreateRemotePlayer(supabase, db, remoteTeamId, localPlayerId, localPlayerName) {
  const cached = remoteIdForLocal(db, 'player', localPlayerId);
  if (cached) return cached;

  const { data: existing, error: findErr } = await supabase
    .from('players')
    .select('id')
    .eq('team_id', remoteTeamId)
    .eq('name', localPlayerName)
    .maybeSingle();
  if (findErr) throw new Error(`lookup remote player: ${findErr.message}`);

  let remoteId = existing?.id;
  if (!remoteId) {
    const { data: created, error } = await supabase
      .from('players')
      .insert({ team_id: remoteTeamId, name: localPlayerName })
      .select('id')
      .single();
    if (error) throw new Error(`create remote player: ${error.message}`);
    remoteId = created.id;
  }
  setSyncMap(db, 'player', localPlayerId, remoteId);
  return remoteId;
}

/**
 * Pushes one local game (+ its roster/box_scores) to Supabase — called
 * right after a successful local db:save-game write, for Manual/Photo tier
 * only (Pro tier never reaches this; RLS would reject the insert even if
 * it tried). On any failure the local save has already succeeded — the
 * caller flags the game `pending_sync=1` for retryPendingSyncs to pick up
 * on the next app launch, rather than losing the user's work.
 */
async function pushGameToCloud(db, localGameId) {
  const tier = await getTier();
  if (tier.source === 'guest' || !tier.canManualEntry) return;

  const supabase = getSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { game, homeTeam, awayTeam, roster } = fetchLocalGameForSync(db, localGameId);

  const remoteLeagueId = await lookupOrCreateRemoteLeague(supabase, db, game);
  const remoteSeasonId = await lookupOrCreateRemoteSeason(supabase, db, remoteLeagueId, game);
  const remoteHomeTeamId = await lookupOrCreateRemoteTeam(supabase, db, remoteLeagueId, homeTeam);
  const remoteAwayTeamId = await lookupOrCreateRemoteTeam(supabase, db, remoteLeagueId, awayTeam);

  const gameRow = {
    season_id: remoteSeasonId,
    date: game.date,
    home_team_id: remoteHomeTeamId,
    away_team_id: remoteAwayTeamId,
    source: game.source === 'manual' ? 'manual' : 'photo',
    owner_user_id: user.id,
    organization_id: tier.organizationId,
  };

  const existingRemoteGameId = remoteIdForLocal(db, 'game', localGameId);
  let remoteGameId;
  if (existingRemoteGameId) {
    const { error } = await supabase.from('games').update(gameRow).eq('id', existingRemoteGameId);
    if (error) throw new Error(`push game update: ${error.message}`);
    remoteGameId = existingRemoteGameId;
  } else {
    const { data: created, error } = await supabase.from('games').insert(gameRow).select('id').single();
    if (error) throw new Error(`push game insert: ${error.message}`);
    remoteGameId = created.id;
  }
  setSyncMap(db, 'game', localGameId, remoteGameId);

  const { error: delErr } = await supabase.from('box_scores').delete().eq('game_id', remoteGameId);
  if (delErr) throw new Error(`push box_scores clear: ${delErr.message}`);

  for (const row of roster) {
    const remoteTeamId = row.team_id === homeTeam.id ? remoteHomeTeamId : remoteAwayTeamId;
    const remotePlayerId = await lookupOrCreateRemotePlayer(supabase, db, remoteTeamId, row.player_id, row.player_name);
    const { error } = await supabase.from('box_scores').insert({
      game_id: remoteGameId,
      player_id: remotePlayerId,
      min: row.min,
      pts: row.pts,
      fgm: row.fgm,
      fga: row.fga,
      tpm: row.tpm,
      tpa: row.tpa,
      ftm: row.ftm,
      fta: row.fta,
      oreb: row.oreb,
      dreb: row.dreb,
      ast: row.ast,
      stl: row.stl,
      blk: row.blk,
      tov: row.tov,
      pf: row.pf,
      pfd: row.pfd,
      plus_minus: row.plus_minus,
      srj: row.srj,
    });
    if (error) throw new Error(`push box_score: ${error.message}`);
  }

  db.prepare(`UPDATE games SET pending_sync = 0, synced_at = datetime('now') WHERE id = ?`).run(localGameId);
}

/** Re-attempts every local game still flagged pending_sync — run once at app start. */
async function retryPendingSyncs(db) {
  const tier = await getTier();
  if (!tier.canManualEntry) return;
  const rows = db.prepare(`SELECT id FROM games WHERE pending_sync = 1`).all();
  for (const { id } of rows) {
    try {
      await pushGameToCloud(db, id);
    } catch (err) {
      console.error(`retryPendingSyncs: game ${id} still failing:`, err);
    }
  }
}

// --- Pull: Supabase -> local (RLS does the entitlement filtering) --------

function lookupOrCreateLocalLeague(db, remote) {
  const cached = localIdForRemote(db, 'league', remote.id);
  if (cached) return cached;

  const row = db.prepare(`SELECT id FROM leagues WHERE name = ?`).get(remote.name);
  const localId = row
    ? row.id
    : db
        .prepare(`INSERT INTO leagues (name, country, tier, source) VALUES (?, ?, ?, 'manual')`)
        .run(remote.name, remote.country ?? null, remote.tier ?? null).lastInsertRowid;
  setSyncMap(db, 'league', localId, remote.id);
  return localId;
}

function lookupOrCreateLocalSeason(db, localLeagueId, remote) {
  const cached = localIdForRemote(db, 'season', remote.id);
  if (cached) return cached;

  const row = db.prepare(`SELECT id FROM seasons WHERE league_id = ? AND year = ?`).get(localLeagueId, remote.year);
  const localId = row ? row.id : db.prepare(`INSERT INTO seasons (league_id, year) VALUES (?, ?)`).run(localLeagueId, remote.year).lastInsertRowid;
  setSyncMap(db, 'season', localId, remote.id);
  return localId;
}

function lookupOrCreateLocalTeam(db, localLeagueId, remote) {
  const cached = localIdForRemote(db, 'team', remote.id);
  if (cached) return cached;

  const row = db.prepare(`SELECT id FROM teams WHERE league_id = ? AND name = ?`).get(localLeagueId, remote.name);
  const localId = row ? row.id : db.prepare(`INSERT INTO teams (league_id, name) VALUES (?, ?)`).run(localLeagueId, remote.name).lastInsertRowid;
  setSyncMap(db, 'team', localId, remote.id);
  return localId;
}

function lookupOrCreateLocalPlayer(db, localTeamId, remote) {
  const cached = localIdForRemote(db, 'player', remote.id);
  if (cached) return cached;

  const row = db.prepare(`SELECT id FROM players WHERE team_id = ? AND name = ?`).get(localTeamId, remote.name);
  const localId = row ? row.id : db.prepare(`INSERT INTO players (team_id, name) VALUES (?, ?)`).run(localTeamId, remote.name).lastInsertRowid;
  setSyncMap(db, 'player', localId, remote.id);
  return localId;
}

function upsertLocalGameFromRemote(db, g) {
  const league = g.seasons.leagues;
  const localLeagueId = lookupOrCreateLocalLeague(db, league);
  const localSeasonId = lookupOrCreateLocalSeason(db, localLeagueId, g.seasons);
  const localHomeTeamId = lookupOrCreateLocalTeam(db, localLeagueId, g.home_team);
  const localAwayTeamId = lookupOrCreateLocalTeam(db, localLeagueId, g.away_team);

  const cachedLocalGameId = localIdForRemote(db, 'game', g.id);
  let localGameId;
  if (cachedLocalGameId) {
    db.prepare(`UPDATE games SET season_id = ?, date = ?, home_team_id = ?, away_team_id = ?, source = ? WHERE id = ?`).run(
      localSeasonId,
      g.date,
      localHomeTeamId,
      localAwayTeamId,
      g.source,
      cachedLocalGameId
    );
    localGameId = cachedLocalGameId;
  } else {
    localGameId = db
      .prepare(`INSERT INTO games (season_id, date, home_team_id, away_team_id, source) VALUES (?, ?, ?, ?, ?)`)
      .run(localSeasonId, g.date, localHomeTeamId, localAwayTeamId, g.source).lastInsertRowid;
  }
  setSyncMap(db, 'game', localGameId, g.id);

  db.prepare(`DELETE FROM box_scores WHERE game_id = ?`).run(localGameId);
  for (const bs of g.box_scores ?? []) {
    const localTeamId = bs.players.team_id === g.home_team.id ? localHomeTeamId : localAwayTeamId;
    const localPlayerId = lookupOrCreateLocalPlayer(db, localTeamId, bs.players);
    db.prepare(
      `INSERT INTO box_scores
       (game_id, player_id, min, pts, fgm, fga, tpm, tpa, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pfd, plus_minus, srj)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      localGameId,
      localPlayerId,
      bs.min,
      bs.pts,
      bs.fgm,
      bs.fga,
      bs.tpm,
      bs.tpa,
      bs.ftm,
      bs.fta,
      bs.oreb,
      bs.dreb,
      bs.ast,
      bs.stl,
      bs.blk,
      bs.tov,
      bs.pf,
      bs.pfd,
      bs.plus_minus,
      bs.srj
    );
  }
}

/**
 * Pulls every game the signed-in account's tier/org entitles it to see
 * (RLS does the filtering — own org's pooled games for Manual/Photo tier,
 * or the platform-feed org's games for Pro tier) and upserts into local
 * SQLite by natural key. The ONLY data path for Pro-tier accounts. Safe to
 * call repeatedly (app start, login, and a manual "Refresh Data" action).
 */
async function pullCloudGames(db) {
  const tier = await getTier();
  if (tier.source === 'guest') return { pulled: 0 };

  const supabase = getSupabaseClient();
  const { data: games, error } = await supabase
    .from('games')
    .select(
      `id, date, source, home_team_id, away_team_id,
       seasons(id, year, leagues(id, name, country, tier)),
       home_team:teams!games_home_team_id_fkey(id, name),
       away_team:teams!games_away_team_id_fkey(id, name),
       box_scores(min, pts, fgm, fga, tpm, tpa, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pfd, plus_minus, srj,
         players(id, name, team_id))`
    )
    .is('deleted_at', null);
  if (error) throw new Error(error.message);

  const upsertTx = db.transaction((remoteGames) => {
    for (const g of remoteGames) upsertLocalGameFromRemote(db, g);
  });
  upsertTx(games || []);

  await applyDefaultTeamPreference(db, supabase, tier);

  return { pulled: (games || []).length };
}

/**
 * Sets the local is_my_team flag to whatever the signed-in account's own
 * organization has as its default_team_id (set by the owner via the Admin
 * page — see migration 0011). Deliberately re-derived fresh on every pull
 * rather than ever copying a remote is_my_team value directly: that flag
 * lives on the shared team row itself, so two different orgs both "having"
 * the same platform-feed team as their default would corrupt each other's
 * view if it were just mirrored as-is. Resolves/creates the team locally
 * independently of whether any game in this pull happened to reference it,
 * so the preference still applies even for a team with no games yet.
 */
async function applyDefaultTeamPreference(db, supabase, tier) {
  if (!tier.organizationId) return;

  const { data: org, error } = await supabase
    .from('organizations')
    .select('default_team_id, default_team:default_team_id(id, name, league_id, leagues:league_id(id, name, country, tier))')
    .eq('id', tier.organizationId)
    .maybeSingle();
  if (error || !org?.default_team_id || !org.default_team) return;

  const remoteTeam = org.default_team;
  const remoteLeague = remoteTeam.leagues;
  if (!remoteLeague) return;

  const localLeagueId = lookupOrCreateLocalLeague(db, remoteLeague);
  const localTeamId = lookupOrCreateLocalTeam(db, localLeagueId, remoteTeam);

  db.prepare(`UPDATE teams SET is_my_team = 0 WHERE league_id = ? AND is_my_team = 1`).run(localLeagueId);
  db.prepare(`UPDATE teams SET is_my_team = 1 WHERE id = ?`).run(localTeamId);
}

module.exports = { pushGameToCloud, pullCloudGames, retryPendingSyncs };
