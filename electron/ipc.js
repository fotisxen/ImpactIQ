const { ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { extractBoxScore } = require('./services/ocr');
const { parsePlayByPlay } = require('./services/playByPlay');
const { buildStints, computeRapm, confidenceLabel } = require('./services/rapm');
const { computeAssistedFgPct, computeLiveBallShare, computeLineupCombos } = require('./services/fourFactors');
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
  estimatePossessions,
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
const { buildWorkbook, buildAdvancedReportWorkbook, renderReportToPdf } = require('./services/export');

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

  // Local parsing only, no API call — never counts against the paid photo upload quota.
  ipcMain.handle('pbp:extract', async (_event, base64File) => {
    const buffer = Buffer.from(base64File, 'base64');
    return parsePlayByPlay(buffer);
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

  ipcMain.handle('db:get-team-season-game-count', (_event, teamId, seasonId) => {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM games WHERE season_id = ? AND (home_team_id = ? OR away_team_id = ?)`)
      .get(seasonId, teamId, teamId);
    return row.c;
  });

  /**
   * One workbook/PDF with every advanced metric, one sheet/page each, all
   * of the team's players ranked as of their Nth game that season — see
   * computeTeamAdvancedReport for the cutoff-filtering logic.
   */
  ipcMain.handle('export:team-advanced-report', async (_event, { format, teamId, seasonId, throughGame }) => {
    const report = computeTeamAdvancedReport(db, teamId, seasonId, throughGame);
    if (!report) return { saved: false };

    const suggestedBase = `${report.teamName}-advanced-report-through-game-${report.throughGame}`.replace(
      /[^\w .-]/g,
      ''
    );

    if (format === 'excel') {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export advanced metrics report',
        defaultPath: `${suggestedBase}.xlsx`,
        filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
      });
      if (canceled || !filePath) return { saved: false };
      const workbook = buildAdvancedReportWorkbook(report);
      const buffer = await workbook.xlsx.writeBuffer();
      await fs.writeFile(filePath, buffer);
      return { saved: true, filePath };
    }

    if (format === 'pdf') {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export advanced metrics report',
        defaultPath: `${suggestedBase}.pdf`,
        filters: [{ name: 'PDF document', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { saved: false };
      const buffer = await renderReportToPdf(report);
      await fs.writeFile(filePath, buffer);
      return { saved: true, filePath };
    }

    return { saved: false };
  });

  ipcMain.handle('db:get-team-four-factors-report', (_event, teamId, seasonId) =>
    computeTeamFourFactorsReport(db, teamId, seasonId)
  );

  ipcMain.handle('db:update-player-position', (_event, playerId, position) => {
    db.prepare(`UPDATE players SET position = ? WHERE id = ?`).run(position || null, playerId);
    return { saved: true };
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
      if (g.events && g.events.length > 0) insertGameEvents(db, gameId, teamId, oppId, g.events);
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
          hasPlayByPlayData: playerHasPlayByPlayData(db, playerId),
        }),
      };
    });
  });

  ipcMain.handle('db:get-league-impact-ratings', (_event, leagueId, seasonId) =>
    computeLeagueImpactRatings(db, leagueId, seasonId)
  );

  ipcMain.handle('db:get-league-standings-history', (_event, leagueId, seasonId) =>
    computeLeagueStandingsHistory(db, leagueId, seasonId)
  );

  ipcMain.handle('db:get-game-win-probability', (_event, gameId) => computeGameWinProbability(db, gameId));

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

  /**
   * PER per game — that single game's box score run through the season's
   * rate-normalization constants (team pace, league pace, league baseline),
   * the same "one game, season-fixed context" approach `db:get-player-pie-log`
   * already uses for PIE's opponent totals. A true isolated per-game PER
   * isn't a standard concept — this mirrors how real per-game PER charts work.
   */
  ipcMain.handle('db:get-player-per-log', (_event, playerId) => {
    const player = db.prepare(`SELECT team_id FROM players WHERE id = ?`).get(playerId);
    if (!player) return [];
    const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(player.team_id);
    const teamAgg = teamAggregate(db, player.team_id);
    const leagueAgg = leagueAggregate(db, team.league_id);

    const games = db
      .prepare(
        `SELECT bs.*, g.id AS game_id, g.date AS date,
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

    return games.map((g) => ({
      game_id: g.game_id,
      date: g.date,
      opponent: g.opponent,
      per: computePER({
        playerTotals: g,
        teamTotals: teamAgg.totals,
        teamGames: teamAgg.games || 1,
        leagueTotals: leagueAgg.totals,
        leagueTeamGames: leagueAgg.teamGames || 1,
      }),
    }));
  });

  /**
   * Every game a player has data for, across every league/cup they appear
   * in — a player has a separate player_id per (name, team-name) sibling row
   * today (same as teams), so this reuses db:get-player-all-competitions'
   * sibling-matching query, flattened into one date-sorted list instead of
   * that handler's per-league summary shape.
   */
  ipcMain.handle('db:get-player-games-all-competitions', (_event, playerId) => {
    const player = db
      .prepare(
        `SELECT p.name AS player_name, t.name AS team_name
         FROM players p JOIN teams t ON t.id = p.team_id
         WHERE p.id = ?`
      )
      .get(playerId);
    if (!player) return [];

    const siblingIds = db
      .prepare(
        `SELECT p.id FROM players p JOIN teams t ON t.id = p.team_id
         WHERE p.name = ? AND t.name = ?`
      )
      .all(player.player_name, player.team_name)
      .map((r) => r.id);

    const rows = siblingIds.flatMap((pid) =>
      db
        .prepare(
          `SELECT bs.pts, bs.oreb, bs.dreb, bs.ast, g.id AS game_id, g.date AS date, l.name AS leagueName,
                  CASE WHEN g.home_team_id = p.team_id THEN away.name ELSE home.name END AS opponent
           FROM box_scores bs
           JOIN players p ON p.id = bs.player_id
           JOIN teams t ON t.id = p.team_id
           JOIN leagues l ON l.id = t.league_id
           JOIN games g ON g.id = bs.game_id
           JOIN teams home ON home.id = g.home_team_id
           JOIN teams away ON away.id = g.away_team_id
           WHERE bs.player_id = ?`
        )
        .all(pid)
    );

    return rows
      .map((r) => ({
        game_id: r.game_id,
        date: r.date,
        leagueName: r.leagueName,
        opponent: r.opponent,
        pts: r.pts,
        reb: r.oreb + r.dreb,
        ast: r.ast,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  });

  /**
   * Every game a team has data for, across every league/cup it appears in —
   * reuses db:get-team-all-competitions' sibling-matching query (teams
   * sharing the same name), flattened into one date-sorted W/L list.
   */
  ipcMain.handle('db:get-team-games-all-competitions', (_event, teamId) => {
    const team = db.prepare(`SELECT name FROM teams WHERE id = ?`).get(teamId);
    if (!team) return [];

    const siblingIds = db.prepare(`SELECT id FROM teams WHERE name = ?`).all(team.name).map((r) => r.id);

    const rows = siblingIds.flatMap((tid) =>
      db
        .prepare(
          `SELECT g.id AS gameId, g.date AS date, l.name AS leagueName,
                  CASE WHEN g.home_team_id = ? THEN g.away_team_id ELSE g.home_team_id END AS oppTeamId,
                  CASE WHEN g.home_team_id = ? THEN away.name ELSE home.name END AS opponent
           FROM games g
           JOIN teams t ON t.id = ?
           JOIN leagues l ON l.id = t.league_id
           JOIN teams home ON home.id = g.home_team_id
           JOIN teams away ON away.id = g.away_team_id
           WHERE g.home_team_id = ? OR g.away_team_id = ?`
        )
        .all(tid, tid, tid, tid, tid)
        .map((g) => {
          const teamTotals = sumRows(
            db
              .prepare(`SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`)
              .all(g.gameId, tid)
          );
          const oppTotals = sumRows(
            db
              .prepare(`SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`)
              .all(g.gameId, g.oppTeamId)
          );
          return {
            game_id: g.gameId,
            date: g.date,
            leagueName: g.leagueName,
            opponent: g.opponent,
            teamPts: teamTotals.pts ?? 0,
            oppPts: oppTotals.pts ?? 0,
            won: (teamTotals.pts ?? 0) > (oppTotals.pts ?? 0),
          };
        })
    );

    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
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

  /** PER per game for a team — same "one game through the season's rate constants" approach as db:get-player-per-log. */
  ipcMain.handle('db:get-team-per-log', (_event, teamId) => {
    const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(teamId);
    if (!team) return [];
    const teamAgg = teamAggregate(db, teamId);
    const leagueAgg = leagueAggregate(db, team.league_id);

    const games = db
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
      .all(teamId, teamId);

    return games.map((g) => ({
      game_id: g.game_id,
      date: g.date,
      opponent: g.opponent,
      per: computePER({
        playerTotals: g,
        teamTotals: teamAgg.totals,
        teamGames: teamAgg.games || 1,
        leagueTotals: leagueAgg.totals,
        leagueTeamGames: leagueAgg.teamGames || 1,
      }),
    }));
  });
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

/** Whether ANY of a player's saved games came from a play-by-play import — the only source that records real +/-. */
function playerHasPlayByPlayData(db, playerId) {
  const row = db
    .prepare(
      `SELECT 1 FROM box_scores bs
       WHERE bs.player_id = ? AND EXISTS (SELECT 1 FROM game_events ge WHERE ge.game_id = bs.game_id)
       LIMIT 1`
    )
    .get(playerId);
  return !!row;
}

function computePlayerSummary(db, playerId) {
  const rows = db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(playerId);
  const player = db.prepare(`SELECT team_id FROM players WHERE id = ?`).get(playerId);
  const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(player.team_id);

  const teamAgg = teamAggregate(db, player.team_id);
  const oppAgg = opponentAggregate(db, player.team_id);
  const leagueAgg = leagueAggregate(db, team.league_id);
  return buildStatSummary({
    rows,
    games: rows.length,
    isTeam: false,
    teamAgg,
    oppAgg,
    leagueAgg,
    hasPlayByPlayData: playerHasPlayByPlayData(db, playerId),
  });
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
 * Team rank at every date across a season — the raw material for a bump
 * chart. Ranked by win% (falling back to wins for ties), recomputed after
 * each date's games. Purely from real game results, nothing modeled.
 */
function computeLeagueStandingsHistory(db, leagueId, seasonId) {
  const games = db
    .prepare(
      `SELECT g.id, g.date, g.home_team_id AS homeTeamId, g.away_team_id AS awayTeamId,
              ht.name AS homeTeamName, at.name AS awayTeamName
       FROM games g
       JOIN teams ht ON ht.id = g.home_team_id
       JOIN teams at ON at.id = g.away_team_id
       WHERE ht.league_id = ? AND g.season_id = ?
       ORDER BY g.date ASC, g.id ASC`
    )
    .all(leagueId, seasonId);

  if (games.length === 0) return { dates: [], teams: [] };

  const totalsFor = (gameId, teamId) =>
    sumRows(
      db
        .prepare(
          `SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`
        )
        .all(gameId, teamId)
    );

  const record = new Map(); // teamId -> { name, wins, losses }
  const ensure = (id, name) => {
    if (!record.has(id)) record.set(id, { name, wins: 0, losses: 0 });
    return record.get(id);
  };

  const dates = [...new Set(games.map((g) => g.date))];
  // teamId -> rank[], one slot per date, pre-filled with null so a team that
  // hasn't played its first game yet at a given date correctly has no data
  // point there instead of a misaligned/appended one.
  const ranksByTeamId = new Map();
  const ranksFor = (teamId) => {
    if (!ranksByTeamId.has(teamId)) ranksByTeamId.set(teamId, new Array(dates.length).fill(null));
    return ranksByTeamId.get(teamId);
  };

  let gameIdx = 0;
  dates.forEach((date, dateIdx) => {
    while (gameIdx < games.length && games[gameIdx].date === date) {
      const g = games[gameIdx];
      const homePts = totalsFor(g.id, g.homeTeamId).pts ?? 0;
      const awayPts = totalsFor(g.id, g.awayTeamId).pts ?? 0;
      const home = ensure(g.homeTeamId, g.homeTeamName);
      const away = ensure(g.awayTeamId, g.awayTeamName);
      if (homePts > awayPts) {
        home.wins += 1;
        away.losses += 1;
      } else if (awayPts > homePts) {
        away.wins += 1;
        home.losses += 1;
      }
      gameIdx += 1;
    }

    const standings = [...record.entries()]
      .map(([teamId, r]) => ({
        teamId,
        winPct: r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : 0,
        wins: r.wins,
      }))
      .sort((a, b) => b.winPct - a.winPct || b.wins - a.wins);

    standings.forEach((s, i) => {
      ranksFor(s.teamId)[dateIdx] = i + 1;
    });
  });

  const teams = [...record.entries()].map(([teamId, r]) => ({
    teamId,
    teamName: r.name,
    ranks: ranksByTeamId.get(teamId) ?? new Array(dates.length).fill(null),
  }));

  return { dates, teams };
}

/**
 * Estimated win probability across one game's real score timeline — only
 * available for games with play-by-play data (needs the actual score-by-
 * time sequence, which photo/manual entries don't have). Uses a standard,
 * generic logistic formula from score margin and time remaining — not a
 * model calibrated on this league's own historical outcomes, since we
 * don't have anywhere near enough games for that yet. Shown as an
 * estimate, not a precise probability.
 */
function computeGameWinProbability(db, gameId) {
  const game = db
    .prepare(`SELECT id, home_team_id AS homeTeamId, away_team_id AS awayTeamId FROM games WHERE id = ?`)
    .get(gameId);
  if (!game) return null;

  const events = db
    .prepare(`SELECT * FROM game_events WHERE game_id = ? ORDER BY clock_seconds, sequence`)
    .all(gameId);
  if (events.length === 0) return null; // no play-by-play data for this game

  const gameDurationSeconds = Math.max(...events.map((e) => e.clock_seconds), 2400);

  let home = 0;
  let away = 0;
  const points = [{ clockSeconds: 0, homeWinProb: 0.5 }];
  for (const e of events) {
    if (e.event_type !== 'score') continue;
    if (e.team_id === game.homeTeamId) home += e.points || 0;
    else if (e.team_id === game.awayTeamId) away += e.points || 0;

    const secondsRemaining = Math.max(1, gameDurationSeconds - e.clock_seconds);
    const margin = home - away;
    // A gentle, generic logistic curve: bigger leads matter less early, more as time runs out.
    const z = (margin / Math.sqrt(secondsRemaining / 60)) * 0.4;
    const homeWinProb = 1 / (1 + Math.exp(-z));
    points.push({ clockSeconds: e.clock_seconds, homeWinProb });
  }
  points.push({ clockSeconds: gameDurationSeconds, homeWinProb: home > away ? 1 : home < away ? 0 : 0.5 });

  return { gameId, gameDurationSeconds, points };
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
 * Same shape as teamAggregate, restricted to an exact set of game ids —
 * used instead of a date cutoff for the team's own games, since two games
 * on the same calendar date (the schema only stores a date, not a time)
 * would otherwise both match a "<= cutoff date" comparison and blur the
 * "through game #N" boundary the whole report is built around.
 */
function teamAggregateThrough(db, teamId, gameIds) {
  if (gameIds.length === 0) return { rows: [], totals: sumRows([]), games: 0 };
  const placeholders = gameIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE p.team_id = ? AND bs.game_id IN (${placeholders})`)
    .all(teamId, ...gameIds);
  return { rows, totals: sumRows(rows), games: new Set(rows.map((r) => r.game_id)).size };
}

/** Same shape as opponentAggregate, restricted to an exact set of game ids — see teamAggregateThrough for why. */
function opponentAggregateThrough(db, teamId, gameIds) {
  if (gameIds.length === 0) return { rows: [], totals: sumRows([]), games: 0 };
  const placeholders = gameIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT bs.* FROM box_scores bs
       JOIN players p ON p.id = bs.player_id
       JOIN games g ON g.id = bs.game_id
       WHERE bs.game_id IN (${placeholders})
         AND ((g.home_team_id = ? AND p.team_id = g.away_team_id)
           OR (g.away_team_id = ? AND p.team_id = g.home_team_id))`
    )
    .all(...gameIds, teamId, teamId);
  return { rows, totals: sumRows(rows), games: new Set(rows.map((r) => r.game_id)).size };
}

/** Date-filtered variant of leagueAggregate — see leagueAggregate for the shape this mirrors. */
function leagueAggregateThrough(db, leagueId, seasonId, cutoffDate) {
  const rows = db
    .prepare(
      `SELECT bs.*, t.id AS team_id FROM box_scores bs
       JOIN players p ON p.id = bs.player_id
       JOIN teams t ON t.id = p.team_id
       JOIN games g ON g.id = bs.game_id
       WHERE t.league_id = ? AND g.season_id = ? AND g.date <= ?`
    )
    .all(leagueId, seasonId, cutoffDate);
  return {
    rows,
    totals: sumRows(rows),
    games: new Set(rows.map((r) => r.game_id)).size,
    teamGames: new Set(rows.map((r) => `${r.game_id}:${r.team_id}`)).size,
  };
}

/** Every advanced metric shown across the Dashboard's headline row + 5 Advanced-tab categories, deduplicated, for the per-team export report. */
const METRIC_DEFS = [
  { key: 'pir', label: 'PIR', get: (s) => s.advanced.pir },
  { key: 'per', label: 'PER', get: (s) => s.per },
  { key: 'impact', label: 'Impact Score', get: (s) => s.impact },
  { key: 'pie', label: 'PIE', get: (s) => s.pie },
  { key: 'net_rating', label: 'Net Rating', get: (s) => s.netRating },
  { key: 'ppft', label: 'PPFT', get: (s) => s.advanced.ppft },
  { key: 'pp2ps', label: 'PP2PS', get: (s) => s.advanced.pp2ps },
  { key: 'pp3ps', label: 'PP3PS', get: (s) => s.advanced.pp3ps },
  { key: 'points_per_shot', label: 'Points per Shot', get: (s) => s.advanced.points_per_shot },
  { key: 'points_per_poss', label: 'Points per Possession', get: (s) => s.advanced.points_per_poss },
  { key: 'points_per_100poss', label: 'Points per 100 Poss', get: (s) => s.advanced.points_per_100poss },
  { key: 'ft_rate', label: 'FT Rate', get: (s) => s.advanced.ft_rate },
  { key: 'three_pt_attempt_rate', label: '3P Attempt Rate', get: (s) => s.advanced.three_pt_attempt_rate },
  { key: 'efg_pct', label: 'eFG%', get: (s) => s.advanced.efg_pct },
  { key: 'ts_pct', label: 'TS%', get: (s) => s.advanced.ts_pct },
  { key: 'oreb_pct', label: 'OREB%', get: (s) => s.advanced.oreb_pct },
  { key: 'dreb_pct', label: 'DREB%', get: (s) => s.advanced.dreb_pct },
  { key: 'treb_pct', label: 'TRB%', get: (s) => s.advanced.treb_pct },
  { key: 'ast_pct', label: 'AST%', get: (s) => s.advanced.ast_pct },
  { key: 'stl_pct', label: 'STL%', get: (s) => s.advanced.stl_pct },
  { key: 'blk_pct', label: 'BLK%', get: (s) => s.advanced.blk_pct },
  { key: 'tov_pct', label: 'TOV%', get: (s) => s.advanced.tov_pct, lowerIsBetter: true },
  { key: 'ast_tov', label: 'AST/TOV', get: (s) => ((s.perGame.tov ?? 0) > 0 ? s.perGame.ast / s.perGame.tov : null) },
  { key: 'stl_tov', label: 'STL/TOV', get: (s) => ((s.perGame.tov ?? 0) > 0 ? s.perGame.stl / s.perGame.tov : null) },
  { key: 'usg_pct', label: 'USG%', get: (s) => s.advanced.usg_pct },
  { key: 'ortg', label: 'ORtg', get: (s) => s.advanced.ortg },
  { key: 'drtg', label: 'DRtg', get: (s) => s.advanced.drtg },
];

/** 0-1 fraction metrics (rendered ×100 with a % sign) vs plain-number metrics, for export formatting. */
const METRIC_IS_PERCENT = new Set([
  'efg_pct', 'ts_pct', 'oreb_pct', 'dreb_pct', 'treb_pct', 'ast_pct', 'stl_pct', 'blk_pct', 'tov_pct', 'usg_pct',
  'ft_rate', 'three_pt_attempt_rate', 'pie',
]);
/** Scoring-category metrics get 3 decimals (matches the Dashboard's advNumFmt3); everything else gets 2. */
const METRIC_IS_SCORING = new Set([
  'ppft', 'pp2ps', 'pp3ps', 'points_per_shot', 'points_per_poss', 'points_per_100poss',
]);

function formatMetricValue(key, value) {
  if (value === null || value === undefined) return null;
  const scaled = METRIC_IS_PERCENT.has(key) ? value * 100 : value;
  const decimals = METRIC_IS_SCORING.has(key) ? 3 : 2;
  const rounded = Number(scaled.toFixed(decimals));
  return METRIC_IS_PERCENT.has(key) ? `${rounded}%` : rounded;
}

/**
 * Every advanced metric for every player on a team, ranked, as of the
 * team's Nth game that season — not the team's full-season totals. The
 * team's own aggregates (its rows, its opponents' rows, the roster, each
 * player's rows) are restricted to the *exact* first `throughGame` game
 * ids (not a date comparison — two games can share a calendar date, since
 * the schema only stores a date, not a time, and a date comparison would
 * silently pull in a game past the intended cutoff). The league-wide
 * aggregate stays date-based (`g.date <= cutoffDate`) since "the league's
 * state as of that date" is genuinely a date concept, not a specific-game one.
 */
function computeTeamAdvancedReport(db, teamId, seasonId, throughGame) {
  const team = db.prepare(`SELECT name, league_id FROM teams WHERE id = ?`).get(teamId);
  if (!team) return null;
  const league = db.prepare(`SELECT name FROM leagues WHERE id = ?`).get(team.league_id);
  const season = db.prepare(`SELECT year FROM seasons WHERE id = ?`).get(seasonId);

  const teamGames = db
    .prepare(
      `SELECT id, date FROM games
       WHERE season_id = ? AND (home_team_id = ? OR away_team_id = ?)
       ORDER BY date ASC, id ASC`
    )
    .all(seasonId, teamId, teamId);
  if (throughGame < 1 || throughGame > teamGames.length) return null;
  const cutoffGames = teamGames.slice(0, throughGame);
  const cutoffGameIds = cutoffGames.map((g) => g.id);
  const cutoffDate = cutoffGames[cutoffGames.length - 1].date;
  const cutoffGamesPlaceholders = cutoffGameIds.map(() => '?').join(',');

  const teamAgg = teamAggregateThrough(db, teamId, cutoffGameIds);
  const oppAgg = opponentAggregateThrough(db, teamId, cutoffGameIds);
  const leagueAgg = leagueAggregateThrough(db, team.league_id, seasonId, cutoffDate);

  const roster = db
    .prepare(
      `SELECT DISTINCT p.id, p.name FROM players p
       JOIN box_scores bs ON bs.player_id = p.id
       WHERE p.team_id = ? AND bs.game_id IN (${cutoffGamesPlaceholders})`
    )
    .all(teamId, ...cutoffGameIds);

  const playerSummaries = roster.map((p) => {
    const rows = db
      .prepare(`SELECT bs.* FROM box_scores bs WHERE bs.player_id = ? AND bs.game_id IN (${cutoffGamesPlaceholders})`)
      .all(p.id, ...cutoffGameIds);
    const hasPlayByPlayData = db
      .prepare(
        `SELECT 1 FROM box_scores bs
         WHERE bs.player_id = ? AND bs.game_id IN (${cutoffGamesPlaceholders})
           AND EXISTS (SELECT 1 FROM game_events ge WHERE ge.game_id = bs.game_id)
         LIMIT 1`
      )
      .get(p.id, ...cutoffGameIds);
    const summary = buildStatSummary({
      rows,
      games: rows.length,
      isTeam: false,
      teamAgg,
      oppAgg,
      leagueAgg,
      hasPlayByPlayData: !!hasPlayByPlayData,
    });
    return { playerId: p.id, playerName: p.name, summary };
  });

  const metrics = METRIC_DEFS.map((def) => {
    const rows = playerSummaries
      .map((p) => ({ playerId: p.playerId, playerName: p.playerName, value: def.get(p.summary) }))
      .filter((r) => r.value !== null && r.value !== undefined && !Number.isNaN(r.value))
      .sort((a, b) => (def.lowerIsBetter ? a.value - b.value : b.value - a.value))
      .map((r) => ({ ...r, formatted: formatMetricValue(def.key, r.value) }));
    return { key: def.key, label: def.label, lowerIsBetter: !!def.lowerIsBetter, rows };
  });

  return {
    teamName: team.name,
    leagueName: league ? league.name : '',
    seasonYear: season ? season.year : '',
    throughGame,
    totalGames: teamGames.length,
    cutoffDate,
    metrics,
  };
}

/** A real, available metric — `isPercent` tells the renderer whether to multiply by 100 and add a % sign. */
function ffMetric(label, value, isPercent) {
  const ok = value !== null && value !== undefined && !Number.isNaN(value);
  return { label, value: ok ? value : null, available: ok, isPercent: !!isPercent };
}

/** An explicitly unavailable metric — never a fabricated 0, always a stated reason. */
function ffNaMetric(label, reason) {
  return { label, value: null, available: false, isPercent: false, reason };
}

const SHOT_LOCATION_REASON =
  'Needs shot-location data (where on the floor the shot came from) — not capturable from a photo, manual entry, or the play-by-play text this app parses.';
const PLAY_TYPE_REASON =
  'Needs possession-by-possession play-type tracking — not capturable from any of this app\'s input methods.';
const FILM_TRACKING_REASON =
  'Needs film-tagged or tracking-derived scheme/matchup data — categorically outside what a box score, photo, or play-by-play log can capture.';

/**
 * The Four Factors page's full report for one team/season: Primary Metrics
 * (already-computed team stats), Context Metrics (some already-computed,
 * some new PBP-only derivations, some permanently N/A), an explicit
 * all-N/A Strategic Metrics row, and the four weighted Four-Factor combo
 * cards. Every metric is `{ label, value, available, isPercent, reason? }`
 * — never a fabricated number standing in for missing data.
 */
function computeTeamFourFactorsReport(db, teamId, seasonId) {
  const team = db.prepare(`SELECT name, league_id FROM teams WHERE id = ?`).get(teamId);
  if (!team) return null;
  const season = db.prepare(`SELECT year FROM seasons WHERE id = ?`).get(seasonId);

  const teamAgg = teamAggregate(db, teamId);
  const oppAgg = opponentAggregate(db, teamId);
  const leagueAgg = leagueAggregate(db, team.league_id);
  const summary = buildStatSummary({
    rows: teamAgg.rows,
    games: teamAgg.games,
    isTeam: true,
    teamAgg,
    oppAgg,
    leagueAgg,
  });

  // PBP-only raw material, scoped to this season.
  const teamEvents = db
    .prepare(
      `SELECT ge.* FROM game_events ge JOIN games g ON g.id = ge.game_id
       WHERE ge.team_id = ? AND g.season_id = ?`
    )
    .all(teamId, seasonId);
  const hasPbp = teamEvents.length > 0;

  const assistedFgPct = hasPbp ? computeAssistedFgPct(teamEvents) : null;
  const liveBallShare = hasPbp ? computeLiveBallShare(teamEvents) : null;
  const liveBallTovPct =
    liveBallShare !== null && summary.advanced.tov_pct !== null ? summary.advanced.tov_pct * liveBallShare : null;

  const opponentQuality = computeOpponentQualityForTeam(db, teamId, seasonId);
  const { combos: lineupCombos, hasPbp: hasLineupData } = computeLineupCombosForTeam(db, teamId, seasonId);

  const primaryMetrics = [
    ffMetric('ORtg', summary.advanced.ortg, false),
    ffMetric('DRtg', summary.advanced.drtg, false),
    ffMetric('Net Rating', summary.netRating, false),
    ffMetric('eFG%', summary.advanced.efg_pct, true),
    ffMetric('TOV%', summary.advanced.tov_pct, true),
    ffMetric('ORB%', summary.advanced.oreb_pct, true),
    ffMetric('FTr', summary.advanced.ft_rate, true),
  ];

  const contextMetrics = [
    ffMetric('Pace', estimatePossessions(teamAgg.totals) / (teamAgg.games || 1), false),
    opponentQuality !== null
      ? ffMetric('Opponent Quality (avg. opponent Net Rating)', opponentQuality, false)
      : ffNaMetric('Opponent Quality', 'No games played this season yet.'),
    hasLineupData
      ? { label: 'Lineup Combinations', available: true, isPercent: false, value: null, lineups: lineupCombos.slice(0, 8) }
      : ffNaMetric('Lineup Combinations', 'No play-by-play games imported for this team/season yet.'),
    ffNaMetric('Rim Frequency', SHOT_LOCATION_REASON),
    ffNaMetric('Shot Profile', SHOT_LOCATION_REASON),
  ];

  const strategicMetrics = [
    ffNaMetric('Transition Strategy', PLAY_TYPE_REASON),
    ffNaMetric('Offensive Rebounding Philosophy', FILM_TRACKING_REASON),
    ffNaMetric('Switching / Drop / Hedge', FILM_TRACKING_REASON),
    ffNaMetric('Matchup Assignments', FILM_TRACKING_REASON),
  ];

  const shooting = {
    label: 'Shooting',
    weightPct: 40,
    primary: ffMetric('eFG%', summary.advanced.efg_pct, true),
    subMetrics: [
      ffMetric('TS%', summary.advanced.ts_pct, true),
      ffMetric('3PAr', summary.advanced.three_pt_attempt_rate, true),
      assistedFgPct !== null
        ? ffMetric('Assisted FG%', assistedFgPct, true)
        : ffNaMetric('Assisted FG%', 'No play-by-play games imported for this team/season yet.'),
      ffNaMetric('Shot Profile', SHOT_LOCATION_REASON),
      ffNaMetric('Rim Frequency', SHOT_LOCATION_REASON),
      ffNaMetric('Shot Quality (PPP by play type)', PLAY_TYPE_REASON),
    ],
  };

  const ballHandling = {
    label: 'Ball Handling',
    weightPct: 25,
    primary: ffMetric('TOV%', summary.advanced.tov_pct, true),
    subMetrics: [
      ffMetric('AST/TOV', safeRatio(summary.perGame.ast, summary.perGame.tov), false),
      ffMetric('STL%', summary.advanced.stl_pct, true),
      liveBallTovPct !== null
        ? ffMetric('Live-ball TOV%', liveBallTovPct, true)
        : ffNaMetric('Live-ball TOV%', 'No play-by-play games imported for this team/season yet.'),
      ffNaMetric('Points off TOV', PLAY_TYPE_REASON),
      ffNaMetric('Transition Frequency after TOV', PLAY_TYPE_REASON),
    ],
  };

  const rebounding = {
    label: 'Rebounding',
    weightPct: 20,
    primary: ffMetric('ORB%', summary.advanced.oreb_pct, true),
    subMetrics: [
      ffMetric('Opponent ORB%', summary.advanced.dreb_pct !== null ? 1 - summary.advanced.dreb_pct : null, true),
      ffNaMetric('Second Chance PPP', 'Not reliably derivable from this app\'s data — would need a fragile guess, not a real number.'),
      ffNaMetric('Putback PPP', 'Not reliably derivable from this app\'s data — would need a fragile guess, not a real number.'),
      ffNaMetric('Contested / Uncontested Rebounds', FILM_TRACKING_REASON),
      ffNaMetric('Lineup Size', 'Needs both player position data and play-by-play lineup reconstruction together — not built yet.'),
    ],
  };

  const ftRate = {
    label: 'FT Rate',
    weightPct: 15,
    primary: ffMetric('FTr', summary.advanced.ft_rate, true),
    subMetrics: [
      ffMetric('FT/FGA', safeRatio(summary.totals.ftm, summary.totals.fga), true),
      ffMetric('Foul Rate (PF/game)', summary.perGame.pf, false),
      ffNaMetric('Shooting Fouls Drawn', 'The play-by-play source text doesn\'t distinguish shooting vs. non-shooting fouls.'),
      ffNaMetric('Rim Frequency', SHOT_LOCATION_REASON),
      ffNaMetric('Drives', PLAY_TYPE_REASON),
    ],
  };

  const roster = db
    .prepare(`SELECT id AS playerId, name AS playerName, position FROM players WHERE team_id = ? ORDER BY name`)
    .all(teamId);

  return {
    teamName: team.name,
    seasonYear: season ? season.year : '',
    primaryMetrics,
    contextMetrics,
    strategicMetrics,
    combos: [shooting, ballHandling, rebounding, ftRate],
    roster,
  };
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/** Average of every opponent's own season Net Rating across the team's games — team-level "strength of schedule", not individual defender-matchup difficulty (that stays permanently N/A). */
function computeOpponentQualityForTeam(db, teamId, seasonId) {
  const games = db
    .prepare(
      `SELECT CASE WHEN g.home_team_id = ? THEN g.away_team_id ELSE g.home_team_id END AS oppTeamId
       FROM games g WHERE g.season_id = ? AND (g.home_team_id = ? OR g.away_team_id = ?)`
    )
    .all(teamId, seasonId, teamId, teamId);
  if (games.length === 0) return null;

  const ratings = games.map((g) => {
    const oppTeam = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(g.oppTeamId);
    if (!oppTeam) return null;
    const oppTeamAgg = teamAggregate(db, g.oppTeamId);
    const oppOppAgg = opponentAggregate(db, g.oppTeamId);
    const oppLeagueAgg = leagueAggregate(db, oppTeam.league_id);
    const oppSummary = buildStatSummary({
      rows: oppTeamAgg.rows,
      games: oppTeamAgg.games,
      isTeam: true,
      teamAgg: oppTeamAgg,
      oppAgg: oppOppAgg,
      leagueAgg: oppLeagueAgg,
    });
    return oppSummary.netRating;
  });

  const valid = ratings.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

/** Every distinct 5-man on-court unit for `teamId`, across every PBP-imported game that season, with combined minutes and net rating — reuses buildStints (rapm.js) per game instead of feeding a RAPM regression. */
function computeLineupCombosForTeam(db, teamId, seasonId) {
  const games = db
    .prepare(
      `SELECT g.id, g.home_team_id AS homeTeamId, g.away_team_id AS awayTeamId
       FROM games g
       WHERE g.season_id = ? AND (g.home_team_id = ? OR g.away_team_id = ?)
         AND EXISTS (SELECT 1 FROM game_events ge WHERE ge.game_id = g.id)`
    )
    .all(seasonId, teamId, teamId);

  if (games.length === 0) return { combos: [], hasPbp: false };

  const allStints = [];
  for (const g of games) {
    const events = db.prepare(`SELECT * FROM game_events WHERE game_id = ? ORDER BY clock_seconds, sequence`).all(g.id);
    if (events.length === 0) continue;
    const gameEndSeconds = Math.max(...events.map((e) => e.clock_seconds), 2400);
    const stints = buildStints(events, g.homeTeamId, g.awayTeamId, gameEndSeconds);

    const homeTotals = sumRows(
      db.prepare(`SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`).all(g.id, g.homeTeamId)
    );
    const awayTotals = sumRows(
      db.prepare(`SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`).all(g.id, g.awayTeamId)
    );
    const totalPoss = estimatePossessions(homeTotals) + estimatePossessions(awayTotals);
    const possPerSecond = gameEndSeconds > 0 ? totalPoss / 2 / gameEndSeconds : 0;
    if (possPerSecond <= 0) continue;

    const isHome = g.homeTeamId === teamId;
    for (const s of stints) {
      const estPoss = s.durationSeconds * possPerSecond;
      if (estPoss <= 0) continue;
      const ourIds = [...(isHome ? s.homeIds : s.awayIds)].sort((a, b) => a - b);
      const netPoints = isHome ? s.homePts - s.awayPts : s.awayPts - s.homePts;
      allStints.push({ playerIds: ourIds, durationSeconds: s.durationSeconds, netPoints, estPoss });
    }
  }

  const combos = computeLineupCombos(allStints);
  if (combos.length === 0) return { combos: [], hasPbp: false };

  const playerNames = new Map(
    db.prepare(`SELECT id, name FROM players WHERE team_id = ?`).all(teamId).map((p) => [p.id, p.name])
  );
  const named = combos.map((c) => ({
    playerNames: c.playerIds.map((id) => playerNames.get(id) ?? `#${id}`),
    minutes: Math.round((c.durationSeconds / 60) * 10) / 10,
    netRatingPer100: c.netRatingPer100,
  }));
  return { combos: named, hasPbp: true };
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
function buildStatSummary({ rows, games, isTeam, teamAgg, oppAgg, leagueAgg, perGameDivisor, hasPlayByPlayData }) {
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
    netRating: computeNetRating({ isTeam, advanced, perGameAvg, teamAgg, hasPlayByPlayData }),
  };
}

/**
 * Net Rating — point differential per 100 possessions.
 *
 * For a team this is exact: ORtg − DRtg, both already computed from real
 * points scored/allowed. For an individual player it's built from their
 * *measured* +/- (real, only recorded by a play-by-play import — photo and
 * manual entries never capture who was on court) normalized by an estimate
 * of how many of the team's possessions they were on court for, prorated
 * by their share of a regulation 40-minute game since this app only stores
 * a final per-game +/- rather than full lineup-stint timing.
 *
 * `hasPlayByPlayData` is the honesty gate: a player who has never had a
 * single play-by-play game returns null (shown as "no data" in the UI),
 * never a fabricated 0 — 0 would silently look like "measured, no impact"
 * when the truth is "never measured at all".
 */
function computeNetRating({ isTeam, advanced, perGameAvg, teamAgg, hasPlayByPlayData }) {
  if (isTeam) {
    if (advanced.ortg === null || advanced.drtg === null) return null;
    return advanced.ortg - advanced.drtg;
  }
  if (!hasPlayByPlayData) return null;

  const GAME_DURATION_MINUTES = 40; // FIBA/EuroLeague regulation length; doesn't account for overtime
  const teamPossessionsPerGame = estimatePossessions(teamAgg.totals) / (teamAgg.games || 1);
  const onCourtShare = (perGameAvg.min ?? 0) / GAME_DURATION_MINUTES;
  const onCourtPossessions = teamPossessionsPerGame * onCourtShare;
  return onCourtPossessions > 0 ? ((perGameAvg.plus_minus ?? 0) / onCourtPossessions) * 100 : null;
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
    netRating: null,
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

/**
 * The league-wide "Impact Rating" — a real RAPM computed only from games
 * that were actually imported via play-by-play, blended with nothing and
 * never extrapolated onto games that don't have that data. A player who's
 * only ever been entered by photo/manual gets `rapm: null` here, not a
 * fabricated number — see confidenceLabel for how the confidence tiers map
 * to how many play-by-play games actually back a given rating.
 */
function computeLeagueImpactRatings(db, leagueId, seasonId) {
  const pbpGames = db
    .prepare(
      `SELECT g.id AS gameId, g.home_team_id AS homeTeamId, g.away_team_id AS awayTeamId
       FROM games g
       JOIN seasons s ON s.id = g.season_id
       WHERE s.league_id = ? AND g.season_id = ?
         AND EXISTS (SELECT 1 FROM game_events ge WHERE ge.game_id = g.id)`
    )
    .all(leagueId, seasonId);

  const gamesData = pbpGames.map((g) => {
    const events = db
      .prepare(`SELECT * FROM game_events WHERE game_id = ? ORDER BY clock_seconds, sequence`)
      .all(g.gameId);
    const homeRows = db
      .prepare(
        `SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`
      )
      .all(g.gameId, g.homeTeamId);
    const awayRows = db
      .prepare(
        `SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`
      )
      .all(g.gameId, g.awayTeamId);
    const gameEndSeconds = events.length ? Math.max(...events.map((e) => e.clock_seconds)) : 0;
    return {
      stints: buildStints(events, g.homeTeamId, g.awayTeamId, gameEndSeconds),
      homeTotals: sumRows(homeRows),
      awayTotals: sumRows(awayRows),
      gameDurationSeconds: gameEndSeconds,
    };
  });

  const rapmByPlayer = computeRapm(gamesData);
  const pbpGameIdSet = new Set(pbpGames.map((g) => g.gameId));

  const byPlayer = new Map();
  for (const row of leagueSeasonRows(db, leagueId, seasonId)) {
    if (!byPlayer.has(row.player_id)) {
      byPlayer.set(row.player_id, { playerName: row.player_name, teamName: row.team_name, gameIds: new Set() });
    }
    byPlayer.get(row.player_id).gameIds.add(row.game_id);
  }

  const round1 = (n) => Math.round(n * 10) / 10;
  const results = [];
  for (const [playerId, info] of byPlayer) {
    const totalGames = info.gameIds.size;
    const gamesWithPbp = [...info.gameIds].filter((id) => pbpGameIdSet.has(id)).length;
    const hasRating = gamesWithPbp > 0 && rapmByPlayer.has(playerId);
    results.push({
      playerId,
      playerName: info.playerName,
      teamName: info.teamName,
      totalGames,
      gamesWithPbp,
      rating: hasRating ? round1(rapmByPlayer.get(playerId)) : null,
      confidence: confidenceLabel(gamesWithPbp),
    });
  }

  return results.sort((a, b) => (b.rating ?? -999) - (a.rating ?? -999));
}

function insertRoster(db, gameId, teamId, players) {
  for (const p of players) {
    const playerId = upsertPlayer(db, p.name, teamId);
    db.prepare(
      `INSERT INTO box_scores
         (game_id, player_id, min, pts, fgm, fga, tpm, tpa, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf, pfd, plus_minus, srj)
       VALUES
         (@gameId, @playerId, @min, @pts, @fgm, @fga, @tpm, @tpa, @ftm, @fta, @oreb, @dreb, @ast, @stl, @blk, @tov, @pf, @pfd, @plus_minus, @srj)`
    ).run({ gameId, playerId, pfd: 0, plus_minus: 0, srj: 0, ...p });
  }
}

/**
 * Persists the raw substitution/scoring timeline from a play-by-play
 * import. Runs after insertRoster so every named player already exists —
 * upsertPlayer here is just a lookup in practice, matching by the same
 * name the parser produced (if the user renamed a player during review,
 * an event for the old name would create a stray player row instead of
 * matching — an acceptable edge case for how rarely that'll happen).
 */
function insertGameEvents(db, gameId, homeTeamId, awayTeamId, events) {
  const insert = db.prepare(
    `INSERT INTO game_events (game_id, team_id, player_id, clock_seconds, event_type, points, sequence)
     VALUES (@gameId, @teamId, @playerId, @clockSeconds, @eventType, @points, @sequence)`
  );
  for (const e of events) {
    const teamId = e.side === 'home' ? homeTeamId : awayTeamId;
    const playerId = e.playerName ? upsertPlayer(db, e.playerName, teamId) : null;
    insert.run({
      gameId,
      teamId,
      playerId,
      clockSeconds: e.clockSeconds,
      eventType: e.type,
      points: e.points ?? null,
      sequence: e.sequence,
    });
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
