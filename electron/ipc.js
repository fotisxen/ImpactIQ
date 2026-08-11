const { ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { extractBoxScore } = require('./services/ocr');
const {
  sumRows,
  perGame,
  advancedStatLine,
  per: computePER,
  impactScore,
  reboundingStatLine,
  ballHandlingStatLine,
  pie: computePIE,
  doeStatLine,
} = require('./services/statsEngine');
const {
  buildTeamInsights,
  buildPlayerInsights,
  buildTeamProfileInsights,
  buildLossPatternInsights,
  buildPlayerWinLossInsights,
} = require('./services/insights');
const { signup, login, logout } = require('./services/auth');
const {
  listOrganizations,
  createOrganization,
  listMyInvites,
  listSentInvites,
  createInvite,
  acceptInvite,
  declineInvite,
  revokeInvite,
} = require('./services/organizations');
const {
  getBaseSubscription,
  cancelBaseSubscription,
  getUploadStatus,
  cancelUploadSubscription,
  listUploadPlans,
  assertUploadQuotaAvailable,
  recordPhotoUpload,
  getProfile,
  updateProfile,
  changePassword,
  createCheckoutSession,
  createPortalSession,
} = require('./services/subscriptions');
const { buildWorkbook } = require('./services/export');

function registerIpcHandlers(db, mainWindow) {
  ipcMain.handle('ocr:extract-box-score', async (_event, base64Image, mediaType) => {
    const imageHash = crypto.createHash('sha256').update(`${mediaType || ''}:${base64Image}`).digest('hex');
    const cached = db.prepare(`SELECT result_json FROM ocr_cache WHERE image_hash = ?`).get(imageHash);
    if (cached) {
      // Same photo bytes as a previous call — return the paid-for result
      // again instead of re-billing the Claude API for an identical image.
      return JSON.parse(cached.result_json);
    }

    await assertUploadQuotaAvailable();
    const result = await extractBoxScore(base64Image, mediaType);
    db.prepare(`INSERT INTO ocr_cache (image_hash, result_json, created_at) VALUES (?, ?, ?)`).run(
      imageHash,
      JSON.stringify(result),
      new Date().toISOString()
    );
    await recordPhotoUpload();
    return result;
  });

  ipcMain.handle('auth:signup', (_event, { email, password, profile }) => signup(email, password, profile));
  ipcMain.handle('auth:login', (_event, { email, password }) => login(email, password));
  ipcMain.handle('auth:logout', () => logout());
  ipcMain.handle('auth:list-organizations', () => listOrganizations());

  ipcMain.handle('team:create-organization', (_event, name) => createOrganization(name));
  ipcMain.handle('team:list-my-invites', () => listMyInvites());
  ipcMain.handle('team:list-sent-invites', () => listSentInvites());
  ipcMain.handle('team:create-invite', (_event, email) => createInvite(email));
  ipcMain.handle('team:accept-invite', (_event, inviteId) => acceptInvite(inviteId));
  ipcMain.handle('team:decline-invite', (_event, inviteId) => declineInvite(inviteId));
  ipcMain.handle('team:revoke-invite', (_event, inviteId) => revokeInvite(inviteId));

  ipcMain.handle('account:get-profile', () => getProfile());
  ipcMain.handle('account:update-profile', (_event, profile) => updateProfile(profile));
  ipcMain.handle('account:change-password', (_event, newPassword) => changePassword(newPassword));

  ipcMain.handle('subscription:get-base', () => getBaseSubscription());
  ipcMain.handle('subscription:cancel-base', () => cancelBaseSubscription());
  ipcMain.handle('subscription:get-upload-status', () => getUploadStatus());
  ipcMain.handle('subscription:cancel-upload', () => cancelUploadSubscription());

  ipcMain.handle('subscription:checkout', async (_event, params) => {
    const url = await createCheckoutSession(params);
    await shell.openExternal(url);
  });
  ipcMain.handle('subscription:open-portal', async () => {
    const url = await createPortalSession();
    await shell.openExternal(url);
  });
  ipcMain.handle('subscription:list-upload-plans', () => listUploadPlans());

  ipcMain.handle('export:excel', async (_event, { payload, suggestedName }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export to Excel',
      defaultPath: suggestedName || 'box-score-export.xlsx',
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { saved: false };

    const workbook = await buildWorkbook(payload);
    const buffer = await workbook.xlsx.writeBuffer();
    await fs.writeFile(filePath, buffer);
    return { saved: true, filePath };
  });

  ipcMain.handle('export:save-image', async (_event, { base64Png, suggestedName }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save report card',
      defaultPath: suggestedName || 'report-card.png',
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (canceled || !filePath) return { saved: false };

    await fs.writeFile(filePath, Buffer.from(base64Png, 'base64'));
    return { saved: true, filePath };
  });

  ipcMain.handle('db:save-game', (_event, game) => {
    const saveTx = db.transaction((g) => {
      const teamId = upsertTeam(db, g.team, g.leagueId);
      const oppId = upsertTeam(db, g.opponent, g.leagueId);

      const gameId = db
        .prepare(
          `INSERT INTO games (season_id, date, home_team_id, away_team_id, source)
           VALUES (@seasonId, @date, @homeTeamId, @awayTeamId, 'photo')`
        )
        .run({ seasonId: g.seasonId, date: g.date, homeTeamId: teamId, awayTeamId: oppId }).lastInsertRowid;

      insertRoster(db, gameId, teamId, g.players || []);
      insertRoster(db, gameId, oppId, g.opponentPlayers || []);
      return gameId;
    });

    return saveTx(game);
  });

  ipcMain.handle('db:get-game-box-score', (_event, gameId) => fetchGameBoxScore(db, gameId));

  ipcMain.handle('db:list-games', () =>
    db
      .prepare(
        `SELECT g.id AS gameId, g.date, ht.name AS homeTeamName, at.name AS awayTeamName,
                l.name AS leagueName, s.year AS seasonYear
         FROM games g
         JOIN teams ht ON ht.id = g.home_team_id
         JOIN teams at ON at.id = g.away_team_id
         JOIN seasons s ON s.id = g.season_id
         JOIN leagues l ON l.id = s.league_id
         ORDER BY g.date DESC, g.id DESC`
      )
      .all()
  );

  ipcMain.handle('db:get-game-insights', (_event, gameId) => buildGameInsights(db, gameId));

  ipcMain.handle('db:get-player-stats', (_event, playerId) => computePlayerSummary(db, playerId));

  ipcMain.handle('db:get-team-stats', (_event, teamId) => computeTeamSummary(db, teamId));

  ipcMain.handle('db:get-team-scouting-report', (_event, teamId) => buildTeamScoutingReport(db, teamId));

  ipcMain.handle('db:get-player-scouting-report', (_event, playerId) => buildPlayerScoutingReport(db, playerId));

  ipcMain.handle('db:get-league-averages', (_event, leagueId, seasonId) => {
    const rows = leagueSeasonRows(db, leagueId, seasonId);
    const games = new Set(rows.map((r) => r.game_id)).size;
    const teamGames = new Set(rows.map((r) => `${r.game_id}:${r.team_id}`)).size;
    const agg = { rows, totals: sumRows(rows), games, teamGames };
    // No single "opponent" for a whole league — self-referential, same as
    // teamAgg/leagueAgg, and mathematically sound (see PER's own self-check).
    return buildStatSummary({
      rows,
      games,
      isTeam: true,
      teamAgg: agg,
      oppAgg: agg,
      leagueAgg: agg,
      perGameDivisor: teamGames, // the /2 fix: a game's totals are 2 teams' worth, not 1
    });
  });

  /**
   * The player-mode counterpart to db:get-league-averages: "what does an
   * average PLAYER in this league/season do per game" rather than "what
   * does an average TEAM do" — divides by player-appearances (one row per
   * player per game), not team-appearances. Used as the comparison baseline
   * for an individual player, since comparing a player to a team-scale
   * average makes counting stats (PTS/REB/AST/...) meaningless.
   *
   * `isTeam: true` here is deliberate, not a copy-paste mistake: rebounding
   * %/ball-handling %/DOE are self-referential share-of-total ratios (e.g.
   * TmOREB/(TmOREB+OppDREB)) that are valid at any aggregate scale — but
   * their *individual* Dean Oliver proration formulas assume `teamRow` is
   * one real team's totals (dividing minutes by 5 players), which breaks if
   * fed the whole league's totals instead. `teamGames: playerGames` in the
   * self-referential agg below is what actually makes the *counting-stat*
   * side (perGame, PIR, Impact Score) come out player-scaled regardless.
   */
  ipcMain.handle('db:get-league-player-averages', (_event, leagueId, seasonId) => {
    const rows = leagueSeasonRows(db, leagueId, seasonId);
    const playerGames = rows.length;
    const agg = { rows, totals: sumRows(rows), games: playerGames, teamGames: playerGames };
    return buildStatSummary({
      rows,
      games: playerGames,
      isTeam: true,
      teamAgg: agg,
      oppAgg: agg,
      leagueAgg: agg,
      perGameDivisor: playerGames,
    });
  });

  ipcMain.handle('db:get-team-all-competitions', (_event, teamId) => {
    const team = db.prepare(`SELECT name FROM teams WHERE id = ?`).get(teamId);
    if (!team) return null;

    const siblings = db
      .prepare(
        `SELECT t.id, t.league_id, l.name AS league_name
         FROM teams t JOIN leagues l ON l.id = t.league_id
         WHERE t.name = ?`
      )
      .all(team.name)
      .map((s) => ({ ...s, agg: teamAggregate(db, s.id), oppAgg: opponentAggregate(db, s.id) }));

    const perLeague = siblings.map((s) => ({
      leagueId: s.league_id,
      leagueName: s.league_name,
      ...buildStatSummary({
        rows: s.agg.rows,
        games: s.agg.games,
        isTeam: true,
        teamAgg: s.agg,
        oppAgg: s.oppAgg,
        leagueAgg: leagueAggregate(db, s.league_id),
      }),
    }));

    const allRows = siblings.flatMap((s) => s.agg.rows);
    const combined = buildCombinedSummary(allRows, new Set(allRows.map((r) => r.game_id)).size);

    return { combined, perLeague };
  });

  ipcMain.handle('db:get-player-all-competitions', (_event, playerId) => {
    const player = db
      .prepare(
        `SELECT p.name AS player_name, t.name AS team_name
         FROM players p JOIN teams t ON t.id = p.team_id
         WHERE p.id = ?`
      )
      .get(playerId);
    if (!player) return null;

    const siblings = db
      .prepare(
        `SELECT p.id, t.id AS team_id, t.league_id, l.name AS league_name
         FROM players p
         JOIN teams t ON t.id = p.team_id
         JOIN leagues l ON l.id = t.league_id
         WHERE p.name = ? AND t.name = ?`
      )
      .all(player.player_name, player.team_name)
      .map((s) => {
        const rows = db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(s.id);
        return { ...s, rows, games: rows.length };
      });

    const perLeague = siblings.map((s) => ({
      leagueId: s.league_id,
      leagueName: s.league_name,
      ...buildStatSummary({
        rows: s.rows,
        games: s.games,
        isTeam: false,
        teamAgg: teamAggregate(db, s.team_id),
        oppAgg: opponentAggregate(db, s.team_id),
        leagueAgg: leagueAggregate(db, s.league_id),
      }),
    }));

    const allRows = siblings.flatMap((s) => s.rows);
    const combined = buildCombinedSummary(allRows, allRows.length);

    return { combined, perLeague };
  });

  ipcMain.handle('db:get-league-team-rankings', (_event, leagueId, seasonId) => {
    const rows = leagueSeasonRows(db, leagueId, seasonId);

    const byTeam = new Map();
    for (const row of rows) {
      if (!byTeam.has(row.team_id)) {
        byTeam.set(row.team_id, { teamName: row.team_name, rows: [], gameIds: new Set() });
      }
      const entry = byTeam.get(row.team_id);
      entry.rows.push(row);
      entry.gameIds.add(row.game_id);
    }

    const leagueAgg = leagueAggregate(db, leagueId);

    return [...byTeam.entries()].map(([teamId, entry]) => {
      const teamAgg = { rows: entry.rows, totals: sumRows(entry.rows), games: entry.gameIds.size };
      const oppAgg = opponentAggregate(db, teamId);
      return {
        teamId,
        teamName: entry.teamName,
        ...buildStatSummary({
          rows: entry.rows,
          games: entry.gameIds.size,
          isTeam: true,
          teamAgg,
          oppAgg,
          leagueAgg,
        }),
      };
    });
  });

  ipcMain.handle('db:get-league-player-leaderboard', (_event, leagueId, seasonId) => {
    const rows = leagueSeasonRows(db, leagueId, seasonId);

    const byPlayer = new Map();
    for (const row of rows) {
      if (!byPlayer.has(row.player_id)) {
        byPlayer.set(row.player_id, {
          playerName: row.player_name,
          teamId: row.team_id,
          teamName: row.team_name,
          rows: [],
          gameIds: new Set(),
        });
      }
      const entry = byPlayer.get(row.player_id);
      entry.rows.push(row);
      entry.gameIds.add(row.game_id);
    }

    const leagueAgg = leagueAggregate(db, leagueId);
    const teamAggCache = new Map();
    const oppAggCache = new Map();

    return [...byPlayer.entries()].map(([playerId, entry]) => {
      if (!teamAggCache.has(entry.teamId)) teamAggCache.set(entry.teamId, teamAggregate(db, entry.teamId));
      if (!oppAggCache.has(entry.teamId)) oppAggCache.set(entry.teamId, opponentAggregate(db, entry.teamId));

      return {
        playerId,
        playerName: entry.playerName,
        teamId: entry.teamId,
        teamName: entry.teamName,
        ...buildStatSummary({
          rows: entry.rows,
          games: entry.gameIds.size,
          isTeam: false,
          teamAgg: teamAggCache.get(entry.teamId),
          oppAgg: oppAggCache.get(entry.teamId),
          leagueAgg,
        }),
      };
    });
  });

  ipcMain.handle('db:list-teams', () => db.prepare(`SELECT * FROM teams ORDER BY name`).all());

  ipcMain.handle('db:list-players', (_event, teamId) =>
    db.prepare(`SELECT * FROM players WHERE team_id = ? ORDER BY name`).all(teamId)
  );

  ipcMain.handle('db:list-all-players', () =>
    db
      .prepare(
        `SELECT p.id, p.name, p.team_id AS teamId, t.name AS teamName
         FROM players p JOIN teams t ON t.id = p.team_id
         ORDER BY p.name`
      )
      .all()
  );

  ipcMain.handle('db:list-leagues', () => db.prepare(`SELECT * FROM leagues ORDER BY name`).all());

  ipcMain.handle('db:create-league', (_event, { name, country, tier }) => {
    const existing = db.prepare(`SELECT id FROM leagues WHERE name = ?`).get(name);
    if (existing) return existing.id;
    return db
      .prepare(`INSERT INTO leagues (name, country, tier, source) VALUES (?, ?, ?, 'manual')`)
      .run(name, country || null, tier || null).lastInsertRowid;
  });

  ipcMain.handle('db:list-seasons', (_event, leagueId) =>
    db.prepare(`SELECT * FROM seasons WHERE league_id = ? ORDER BY year DESC`).all(leagueId)
  );

  ipcMain.handle('db:create-season', (_event, { leagueId, year }) => {
    const existing = db
      .prepare(`SELECT id FROM seasons WHERE league_id = ? AND year = ?`)
      .get(leagueId, year);
    if (existing) return existing.id;
    return db
      .prepare(`INSERT INTO seasons (league_id, year) VALUES (?, ?)`)
      .run(leagueId, year).lastInsertRowid;
  });

  ipcMain.handle('db:create-team', (_event, { leagueId, name, isMyTeam }) => {
    const existing = db.prepare(`SELECT id FROM teams WHERE name = ? AND league_id = ?`).get(name, leagueId);
    if (existing) {
      if (isMyTeam) db.prepare(`UPDATE teams SET is_my_team = 1 WHERE id = ?`).run(existing.id);
      return existing.id;
    }
    return db
      .prepare(`INSERT INTO teams (league_id, name, is_my_team) VALUES (?, ?, ?)`)
      .run(leagueId, name, isMyTeam ? 1 : 0).lastInsertRowid;
  });

  ipcMain.handle('db:get-player-game-log', (_event, playerId) =>
    db
      .prepare(
        `SELECT bs.*, g.date AS date,
                CASE WHEN g.home_team_id = p.team_id THEN away.name ELSE home.name END AS opponent
         FROM box_scores bs
         JOIN players p ON p.id = bs.player_id
         JOIN games g ON g.id = bs.game_id
         JOIN teams home ON home.id = g.home_team_id
         JOIN teams away ON away.id = g.away_team_id
         WHERE bs.player_id = ?
         ORDER BY g.date ASC`
      )
      .all(playerId)
  );

  ipcMain.handle('db:get-player-pie-log', (_event, playerId) => {
    const games = db
      .prepare(
        `SELECT bs.*, g.id AS game_id, g.date AS date, p.team_id AS team_id,
                CASE WHEN g.home_team_id = p.team_id THEN g.away_team_id ELSE g.home_team_id END AS opp_team_id,
                CASE WHEN g.home_team_id = p.team_id THEN away.name ELSE home.name END AS opponent
         FROM box_scores bs
         JOIN players p ON p.id = bs.player_id
         JOIN games g ON g.id = bs.game_id
         JOIN teams home ON home.id = g.home_team_id
         JOIN teams away ON away.id = g.away_team_id
         WHERE bs.player_id = ?
         ORDER BY g.date ASC`
      )
      .all(playerId);

    const teamRowsStmt = db.prepare(
      `SELECT bs2.* FROM box_scores bs2 JOIN players p2 ON p2.id = bs2.player_id
       WHERE bs2.game_id = ? AND p2.team_id = ?`
    );

    return games.map((g) => {
      const teamTotals = sumRows(teamRowsStmt.all(g.game_id, g.team_id));
      const oppTotals = sumRows(teamRowsStmt.all(g.game_id, g.opp_team_id));
      return {
        game_id: g.game_id,
        date: g.date,
        opponent: g.opponent,
        pie: computePIE(g, teamTotals, oppTotals),
      };
    });
  });

  ipcMain.handle('db:get-team-game-log', (_event, teamId) =>
    db
      .prepare(
        `SELECT g.id AS game_id, g.date AS date,
                CASE WHEN g.home_team_id = ? THEN away.name ELSE home.name END AS opponent,
                SUM(bs.min) AS min, SUM(bs.pts) AS pts, SUM(bs.fgm) AS fgm, SUM(bs.fga) AS fga,
                SUM(bs.tpm) AS tpm, SUM(bs.tpa) AS tpa, SUM(bs.ftm) AS ftm, SUM(bs.fta) AS fta,
                SUM(bs.oreb) AS oreb, SUM(bs.dreb) AS dreb, SUM(bs.ast) AS ast,
                SUM(bs.stl) AS stl, SUM(bs.blk) AS blk, SUM(bs.tov) AS tov, SUM(bs.pf) AS pf
         FROM box_scores bs
         JOIN players p ON p.id = bs.player_id
         JOIN games g ON g.id = bs.game_id
         JOIN teams home ON home.id = g.home_team_id
         JOIN teams away ON away.id = g.away_team_id
         WHERE p.team_id = ?
         GROUP BY g.id
         ORDER BY g.date ASC`
      )
      .all(teamId, teamId)
  );
}

function fetchGameBoxScore(db, gameId) {
  const game = db
    .prepare(
      `SELECT g.id, g.date, g.home_team_id, g.away_team_id,
              ht.name AS home_team_name, at.name AS away_team_name,
              l.name AS league_name, s.year AS season_year
       FROM games g
       JOIN teams ht ON ht.id = g.home_team_id
       JOIN teams at ON at.id = g.away_team_id
       JOIN seasons s ON s.id = g.season_id
       JOIN leagues l ON l.id = s.league_id
       WHERE g.id = ?`
    )
    .get(gameId);
  if (!game) return null;

  const rosterFor = (teamId) =>
    db
      .prepare(
        `SELECT bs.*, p.name AS name
         FROM box_scores bs
         JOIN players p ON p.id = bs.player_id
         WHERE bs.game_id = ? AND p.team_id = ?
         ORDER BY bs.pts DESC`
      )
      .all(gameId, teamId);

  const homeRoster = rosterFor(game.home_team_id);
  const awayRoster = rosterFor(game.away_team_id);

  return {
    gameId: game.id,
    date: game.date,
    leagueName: game.league_name,
    seasonYear: game.season_year,
    homeTeamId: game.home_team_id,
    awayTeamId: game.away_team_id,
    homeTeamName: game.home_team_name,
    awayTeamName: game.away_team_name,
    homeRoster,
    awayRoster,
    homeTotals: sumRows(homeRoster),
    awayTotals: sumRows(awayRoster),
  };
}

/**
 * Deterministic, zero-cost "what happened in this game" analysis — no LLM
 * call, just comparing this game's numbers against each player's/team's own
 * season averages (excluding this game, so a big game doesn't partly hide
 * itself inside its own baseline) and flagging deviations big enough to be
 * worth mentioning. See insights.js for the actual thresholds/wording.
 */
function buildGameInsights(db, gameId) {
  const box = fetchGameBoxScore(db, gameId);
  if (!box) return null;

  const teamSeasonAvg = (teamId) => {
    const rows = db
      .prepare(
        `SELECT bs.* FROM box_scores bs
         JOIN players p ON p.id = bs.player_id
         WHERE p.team_id = ? AND bs.game_id != ?`
      )
      .all(teamId, gameId);
    const gamesPlayed = new Set(rows.map((r) => r.game_id)).size;
    return { perGame: perGame(sumRows(rows), gamesPlayed || 1), games: gamesPlayed };
  };

  const playerSeasonAvg = (playerId) => {
    const rows = db.prepare(`SELECT * FROM box_scores WHERE player_id = ? AND game_id != ?`).all(playerId, gameId);
    const allRows = db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(playerId);
    return {
      perGame: perGame(sumRows(rows), rows.length || 1),
      games: rows.length,
      seasonHighPts: allRows.length > 1 ? Math.max(...allRows.map((r) => r.pts)) : null,
      seasonHighReb: allRows.length > 1 ? Math.max(...allRows.map((r) => r.oreb + r.dreb)) : null,
    };
  };

  const homeTeamAvg = teamSeasonAvg(box.homeTeamId);
  const awayTeamAvg = teamSeasonAvg(box.awayTeamId);

  const homePts = box.homeTotals.pts ?? 0;
  const awayPts = box.awayTotals.pts ?? 0;
  const winner = homePts === awayPts ? 'tie' : homePts > awayPts ? 'home' : 'away';

  const insights = [
    ...buildTeamInsights('home', box.homeTeamName, box.homeTotals, homeTeamAvg, awayPts, awayTeamAvg),
    ...buildTeamInsights('away', box.awayTeamName, box.awayTotals, awayTeamAvg, homePts, homeTeamAvg),
    ...box.homeRoster.flatMap((row) => buildPlayerInsights('home', row, playerSeasonAvg(row.player_id))),
    ...box.awayRoster.flatMap((row) => buildPlayerInsights('away', row, playerSeasonAvg(row.player_id))),
  ];

  return {
    gameId: box.gameId,
    date: box.date,
    leagueName: box.leagueName,
    seasonYear: box.seasonYear,
    homeTeamName: box.homeTeamName,
    awayTeamName: box.awayTeamName,
    homeScore: homePts,
    awayScore: awayPts,
    winner,
    insights,
  };
}

function computePlayerSummary(db, playerId) {
  const rows = db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(playerId);
  const player = db.prepare(`SELECT team_id FROM players WHERE id = ?`).get(playerId);
  const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(player.team_id);

  const teamAgg = teamAggregate(db, player.team_id);
  const oppAgg = opponentAggregate(db, player.team_id);
  const leagueAgg = leagueAggregate(db, team.league_id);
  return buildStatSummary({ rows, games: rows.length, isTeam: false, teamAgg, oppAgg, leagueAgg });
}

function computeTeamSummary(db, teamId) {
  const teamAgg = teamAggregate(db, teamId);
  const oppAgg = opponentAggregate(db, teamId);
  const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(teamId);
  const leagueAgg = leagueAggregate(db, team.league_id);
  return buildStatSummary({ rows: teamAgg.rows, games: teamAgg.games, isTeam: true, teamAgg, oppAgg, leagueAgg });
}

/** Every game a team played, split by win/loss, with both sides' totals — the raw material for "what goes wrong when they lose". */
function teamGameResults(db, teamId) {
  const games = db
    .prepare(`SELECT id, home_team_id, away_team_id FROM games WHERE home_team_id = ? OR away_team_id = ?`)
    .all(teamId, teamId);

  const rowsFor = (gameId, forTeamId) =>
    db
      .prepare(
        `SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`
      )
      .all(gameId, forTeamId);

  return games.map((g) => {
    const opponentId = g.home_team_id === teamId ? g.away_team_id : g.home_team_id;
    const teamTotals = sumRows(rowsFor(g.id, teamId));
    const oppTotals = sumRows(rowsFor(g.id, opponentId));
    return { gameId: g.id, teamTotals, oppTotals, won: (teamTotals.pts ?? 0) > (oppTotals.pts ?? 0) };
  });
}

/**
 * A scouting report for one team: strengths/weaknesses vs the league average,
 * its key players (by season PIE), and — the "how do I beat them" angle —
 * what its own numbers look like in losses vs wins, so an opposing coach
 * knows what to force. Deterministic, no LLM call.
 */
function buildTeamScoutingReport(db, teamId) {
  const team = db.prepare(`SELECT id, name, league_id FROM teams WHERE id = ?`).get(teamId);
  if (!team) return null;
  const league = db.prepare(`SELECT name FROM leagues WHERE id = ?`).get(team.league_id);

  const teamAgg = teamAggregate(db, teamId);
  const leagueAgg = leagueAggregate(db, team.league_id);
  const teamPerGame = perGame(teamAgg.totals, teamAgg.games || 1);
  const leaguePerGame = perGame(leagueAgg.totals, leagueAgg.teamGames || 1);
  const profileInsights = buildTeamProfileInsights(team.name, teamPerGame, leaguePerGame);

  const playerIds = db.prepare(`SELECT id FROM players WHERE team_id = ?`).all(teamId).map((p) => p.id);
  const keyPlayers = playerIds
    .map((id) => {
      const p = db.prepare(`SELECT name FROM players WHERE id = ?`).get(id);
      const summary = computePlayerSummary(db, id);
      return { playerId: id, playerName: p.name, summary };
    })
    .filter((p) => p.summary.games >= 2)
    .sort((a, b) => (b.summary.pie ?? 0) - (a.summary.pie ?? 0))
    .slice(0, 3)
    .map((p) => ({
      playerId: p.playerId,
      playerName: p.playerName,
      pts: p.summary.perGame.pts ?? 0,
      reb: (p.summary.perGame.oreb ?? 0) + (p.summary.perGame.dreb ?? 0),
      ast: p.summary.perGame.ast ?? 0,
      pie: p.summary.pie,
    }));

  const results = teamGameResults(db, teamId);
  const wins = results.filter((r) => r.won);
  const losses = results.filter((r) => !r.won);
  const lossPerGame = losses.length ? perGame(sumRows(losses.map((r) => r.teamTotals)), losses.length) : null;
  const winPerGame = wins.length ? perGame(sumRows(wins.map((r) => r.teamTotals)), wins.length) : null;
  const oppLossPerGame = losses.length ? perGame(sumRows(losses.map((r) => r.oppTotals)), losses.length) : null;
  const oppWinPerGame = wins.length ? perGame(sumRows(wins.map((r) => r.oppTotals)), wins.length) : null;

  const lossPatternInsights =
    losses.length >= 2 && wins.length >= 2
      ? buildLossPatternInsights(team.name, lossPerGame, winPerGame, oppLossPerGame, oppWinPerGame)
      : [];

  return {
    teamId: team.id,
    teamName: team.name,
    leagueName: league?.name ?? '',
    games: teamAgg.games,
    wins: wins.length,
    losses: losses.length,
    profileInsights,
    keyPlayers,
    lossPatternInsights,
  };
}

/** Same "vs league average" angle as the team report, scoped to one player, plus how they perform in team wins vs losses. */
function buildPlayerScoutingReport(db, playerId) {
  const player = db.prepare(`SELECT id, name, team_id FROM players WHERE id = ?`).get(playerId);
  if (!player) return null;
  const team = db.prepare(`SELECT name, league_id FROM teams WHERE id = ?`).get(player.team_id);
  const league = db.prepare(`SELECT name FROM leagues WHERE id = ?`).get(team.league_id);

  const summary = computePlayerSummary(db, playerId);
  const leagueAgg = leagueAggregate(db, team.league_id);
  // Player-scale divisor (total player-appearances), not team-appearances —
  // comparing a player's ~15 PTS/game against a whole team's ~80 PTS/game
  // "league average" would be comparing different things entirely.
  const leaguePerGame = perGame(leagueAgg.totals, leagueAgg.rows.length || 1);
  const profileInsights = buildTeamProfileInsights(player.name, summary.perGame, leaguePerGame);

  const teamResults = teamGameResults(db, player.team_id);
  const winGameIds = new Set(teamResults.filter((r) => r.won).map((r) => r.gameId));
  const lossGameIds = new Set(teamResults.filter((r) => !r.won).map((r) => r.gameId));
  const allRows = db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(playerId);
  const winRows = allRows.filter((r) => winGameIds.has(r.game_id));
  const lossRows = allRows.filter((r) => lossGameIds.has(r.game_id));

  const winVsLossInsights =
    winRows.length >= 2 && lossRows.length >= 2
      ? buildPlayerWinLossInsights(
          player.name,
          perGame(sumRows(winRows), winRows.length),
          perGame(sumRows(lossRows), lossRows.length)
        )
      : [];

  return {
    playerId: player.id,
    playerName: player.name,
    teamName: team.name,
    leagueName: league?.name ?? '',
    games: summary.games,
    profileInsights,
    winVsLossInsights,
  };
}

function teamAggregate(db, teamId) {
  const rows = db
    .prepare(`SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE p.team_id = ?`)
    .all(teamId);
  return { rows, totals: sumRows(rows), games: new Set(rows.map((r) => r.game_id)).size };
}

/**
 * For every game `teamId` played, the *other* team's box-score rows —
 * "boards/possessions available to the opponent", the missing half of
 * every rebounding %, steal %, block %, and PIE formula. Uses
 * `games.home_team_id`/`away_team_id` to find, for each of the team's
 * games, whichever side it wasn't on.
 */
function opponentAggregate(db, teamId) {
  const rows = db
    .prepare(
      `SELECT bs.*
       FROM box_scores bs
       JOIN players p ON p.id = bs.player_id
       JOIN games g ON g.id = bs.game_id
       WHERE (g.home_team_id = ? AND p.team_id = g.away_team_id)
          OR (g.away_team_id = ? AND p.team_id = g.home_team_id)`
    )
    .all(teamId, teamId);
  return { rows, totals: sumRows(rows), games: new Set(rows.map((r) => r.game_id)).size };
}

/**
 * Every box score row for every team in a league, all-time (not
 * season-scoped) — used as the PER/impact-score baseline for player and
 * team views. `teamGames` counts distinct (game, team) pairs rather than
 * distinct games, since a real game contributes two teams' worth of stats
 * to `totals` — see the comment on statsEngine's `per()`.
 */
function leagueAggregate(db, leagueId) {
  const rows = db
    .prepare(
      `SELECT bs.*, t.id AS team_id
       FROM box_scores bs
       JOIN players p ON p.id = bs.player_id
       JOIN teams t ON t.id = p.team_id
       WHERE t.league_id = ?`
    )
    .all(leagueId);
  return {
    rows,
    totals: sumRows(rows),
    games: new Set(rows.map((r) => r.game_id)).size,
    teamGames: new Set(rows.map((r) => `${r.game_id}:${r.team_id}`)).size,
  };
}

/**
 * Full StatSummary — totals/perGame/advanced (scoring, shooting, rebounding
 * %, ball-handling %) plus PER, the BPM-style impact score, and PIE.
 *
 * `isTeam` picks team-level vs individual formulas for the stats that need
 * it (rebounding %, ball-handling %) — a team's own formulas are plain
 * share-of-available ratios, an individual's are the classic Dean Oliver
 * box-score approximation prorated by team minutes (see statsEngine.js).
 * `oppAgg` is the opponent's aggregate across the subject's games (see
 * `opponentAggregate`) — without it, rebounding/steal/block/PIE can't be
 * computed, since those all need "boards/possessions available", not just
 * the subject's own totals.
 * `perGameDivisor` overrides what `perGame`/totals-derived rates divide by
 * — defaults to `games`, but a league-wide aggregate needs `teamGames`
 * instead (its totals already sum both teams per game — see the /2 fix on
 * `db:get-league-averages`).
 */
function buildStatSummary({ rows, games, isTeam, teamAgg, oppAgg, leagueAgg, perGameDivisor }) {
  const totals = sumRows(rows);
  const divisor = perGameDivisor ?? games;
  const perGameAvg = perGame(totals, divisor || 1);
  const advanced = {
    // PIR is a plain sum (no built-in division), so it must be computed from
    // the per-game average, not season totals, or it comes out as a season-
    // cumulative number instead of a per-game rate. Every other field here is
    // a ratio, which is scale-invariant either way — safe to switch uniformly.
    ...advancedStatLine(perGameAvg),
    ...reboundingStatLine({ row: totals, teamRow: teamAgg.totals, oppRow: oppAgg.totals, isTeam }),
    ...ballHandlingStatLine({ row: totals, teamRow: teamAgg.totals, oppRow: oppAgg.totals, isTeam }),
    ...doeStatLine({ row: totals, teamRow: teamAgg.totals, oppRow: oppAgg.totals, isTeam }),
  };

  // The league baseline must be divided by the same "kind" of game count as
  // the subject: team-appearances for a team subject, player-appearances for
  // an individual subject — otherwise an individual player's ~15 PTS/game
  // gets compared against a whole TEAM's ~80 PTS/game league average, which
  // wrecks Impact Score (a raw counting-stat diff) for every player. Ratio
  // stats (shooting %, rebounding %, etc.) aren't affected either way since
  // a ratio is scale-invariant — only this counting-stat baseline was ever
  // actually wrong.
  const leagueDivisor = isTeam
    ? leagueAgg.teamGames || leagueAgg.games || 1
    : leagueAgg.rows.length || 1;
  const leaguePerGameAvg = perGame(leagueAgg.totals, leagueDivisor);
  const leagueAdvanced = advancedStatLine(leaguePerGameAvg);

  return {
    games,
    totals,
    perGame: perGameAvg,
    advanced,
    per: computePER({
      playerTotals: totals,
      teamTotals: teamAgg.totals,
      teamGames: teamAgg.games || 1,
      leagueTotals: leagueAgg.totals,
      leagueTeamGames: leagueAgg.teamGames || 1,
    }),
    impact: impactScore(perGameAvg, leaguePerGameAvg, advanced.ts_pct, leagueAdvanced.ts_pct),
    pie: computePIE(totals, teamAgg.totals, oppAgg.totals),
  };
}

/**
 * A lighter StatSummary for cross-league combined totals — PER/impact/PIE
 * and the team/opponent-dependent advanced stats (rebounding %, ball-
 * handling %) all need one coherent league/opponent context to normalize
 * against, which a "combined across every competition" row doesn't have,
 * so those come back null here. Totals, per-game, and the self-contained
 * scoring/shooting line are still valid to sum across competitions.
 */
function buildCombinedSummary(rows, games) {
  const totals = sumRows(rows);
  const perGameAvg = perGame(totals, games || 1);
  return {
    games,
    totals,
    perGame: perGameAvg,
    advanced: {
      ...advancedStatLine(perGameAvg),
      oreb_pct: null,
      dreb_pct: null,
      treb_pct: null,
      ast_pct: null,
      tov_pct: null,
      stl_pct: null,
      blk_pct: null,
      usg_pct: null,
      ortg: null,
      drtg: null,
      doe: null,
    },
    per: null,
    impact: null,
    pie: null,
  };
}

function leagueSeasonRows(db, leagueId, seasonId) {
  return db
    .prepare(
      `SELECT bs.*, t.id AS team_id, t.name AS team_name, p.name AS player_name
       FROM box_scores bs
       JOIN players p ON p.id = bs.player_id
       JOIN teams t ON t.id = p.team_id
       JOIN games g ON g.id = bs.game_id
       WHERE t.league_id = ? AND g.season_id = ?`
    )
    .all(leagueId, seasonId);
}

function insertRoster(db, gameId, teamId, players) {
  for (const p of players) {
    const playerId = upsertPlayer(db, p.name, teamId);
    db.prepare(
      `INSERT INTO box_scores
         (game_id, player_id, min, pts, fgm, fga, tpm, tpa, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pfd, plus_minus)
       VALUES
         (@gameId, @playerId, @min, @pts, @fgm, @fga, @tpm, @tpa, @ftm, @fta, @oreb, @dreb, @ast, @stl, @blk, @tov, @pf, @pfd, @plus_minus)`
    ).run({ gameId, playerId, pfd: 0, plus_minus: 0, ...p });
  }
}

function upsertTeam(db, name, leagueId) {
  const existing = db.prepare(`SELECT id FROM teams WHERE name = ? AND league_id = ?`).get(name, leagueId);
  if (existing) return existing.id;
  return db.prepare(`INSERT INTO teams (league_id, name) VALUES (?, ?)`).run(leagueId, name).lastInsertRowid;
}

function upsertPlayer(db, name, teamId) {
  const existing = db.prepare(`SELECT id FROM players WHERE name = ? AND team_id = ?`).get(name, teamId);
  if (existing) return existing.id;
  return db.prepare(`INSERT INTO players (team_id, name) VALUES (?, ?)`).run(teamId, name).lastInsertRowid;
}

module.exports = { registerIpcHandlers };
