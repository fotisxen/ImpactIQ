const { ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { extractBoxScore } = require('./services/ocr');
const { parsePlayByPlay } = require('./services/playByPlay');
const { buildStints, computeRapm, confidenceLabel } = require('./services/rapm');
const { computeAssistedFgPct, computeLiveBallShare, computeLineupCombos } = require('./services/fourFactors');
const { reconstructGamePossessions, possessionStatsForTeam } = require('./services/possessions');
const { buildZoneChart } = require('./services/shotZones');
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
  pacePerGame,
  pythagoreanWinPct,
} = require('./services/statsEngine');
const {
  buildTeamInsights,
  buildPlayerInsights,
  buildTeamProfileInsights,
  buildLossPatternInsights,
  buildPlayerWinLossInsights,
  buildPlayingTimeInsights,
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
  getTier,
  cancelSubscription,
  getProfile,
  updateProfile,
  changePassword,
  createCheckoutSession,
  createPortalSession,
} = require('./services/subscriptions');
const { pullCloudGames } = require('./services/dataSync');
const {
  createAccount: adminCreateAccount,
  listOrganizations: adminListOrganizations,
  updateOrganization: adminUpdateOrganization,
} = require('./services/admin');
const {
  buildWorkbook,
  buildAdvancedReportWorkbook,
  renderReportToPdf,
  buildGameBoxScoreWorkbook,
  renderGameBoxScoreToPdf,
  renderScoutingReportToPdf,
} = require('./services/export');
const {
  publishScoutingReport,
  getCurrentPublishedReport,
  listReportViewers,
  listPlayers,
  createPlayerAccount,
} = require('./services/scoutingReportDistribution');
const { getSupabaseClient } = require('./services/supabaseClient');

/** Strips a nested-embed key (e.g. `leagues` from a `teams.select('*, leagues(name)')` row) after its fields have been flattened onto the result — keeps IPC payloads matching the plain-row shape the renderer already expects. */
function rowWithoutEmbed(row, embedKey) {
  const { [embedKey]: _embed, ...rest } = row;
  return rest;
}

function registerIpcHandlers(db, mainWindow) {
  ipcMain.handle('ocr:extract-box-score', async (_event, base64Image, mediaType) => {
    const imageHash = crypto.createHash('sha256').update(`${mediaType || ''}:${base64Image}`).digest('hex');
    const cached = db.prepare(`SELECT result_json FROM ocr_cache WHERE image_hash = ?`).get(imageHash);
    if (cached) {
      // Same photo bytes as a previous call — return the paid-for result
      // again instead of re-billing the Claude API for an identical image.
      return JSON.parse(cached.result_json);
    }

    const tier = await getTier();
    if (!tier.canUploadPhoto) {
      throw new Error('Photo upload (OCR) is included on the Photo plan. Upgrade from Account settings.');
    }
    const result = await extractBoxScore(base64Image, mediaType);
    db.prepare(`INSERT INTO ocr_cache (image_hash, result_json, created_at) VALUES (?, ?, ?)`).run(
      imageHash,
      JSON.stringify(result),
      new Date().toISOString()
    );
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

  ipcMain.handle('subscription:get-tier', () => getTier());
  ipcMain.handle('subscription:cancel', () => cancelSubscription());

  ipcMain.handle('subscription:checkout', async (_event, params) => {
    const url = await createCheckoutSession(params);
    await shell.openExternal(url);
  });
  ipcMain.handle('subscription:open-portal', async () => {
    const url = await createPortalSession();
    await shell.openExternal(url);
  });

  ipcMain.handle('sync:pull-cloud-data', () => pullCloudGames(db));

  ipcMain.handle('admin:create-account', (_event, params) => adminCreateAccount(params));
  ipcMain.handle('admin:list-organizations', () => adminListOrganizations());
  ipcMain.handle('admin:update-organization', (_event, params) => adminUpdateOrganization(params));

  // Every team already lives in Supabase directly now (no more local <->
  // remote id bridge), so the "default team" picker just reads the same
  // table everything else does.
  ipcMain.handle('admin:list-teams', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('teams').select('id, name, leagues(name)').order('name');
    if (error) throw new Error(error.message);
    return (data ?? []).map((t) => ({ id: t.id, name: t.name, league_name: t.leagues?.name ?? null }));
  });

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

  ipcMain.handle('export:game-box-score', async (_event, { format, gameId }) => {
    const box = fetchGameBoxScore(db, gameId);
    if (!box) return { saved: false };

    const suggestedBase = `${box.homeTeamName}-vs-${box.awayTeamName}-${box.date}-box-score`.replace(
      /[^\w .-]/g,
      ''
    );

    if (format === 'excel') {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export box score',
        defaultPath: `${suggestedBase}.xlsx`,
        filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
      });
      if (canceled || !filePath) return { saved: false };
      const workbook = buildGameBoxScoreWorkbook(box);
      const buffer = await workbook.xlsx.writeBuffer();
      await fs.writeFile(filePath, buffer);
      return { saved: true, filePath };
    }

    if (format === 'pdf') {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export box score',
        defaultPath: `${suggestedBase}.pdf`,
        filters: [{ name: 'PDF document', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { saved: false };
      const buffer = await renderGameBoxScoreToPdf(box);
      await fs.writeFile(filePath, buffer);
      return { saved: true, filePath };
    }

    return { saved: false };
  });

  ipcMain.handle('export:scouting-report-pdf', async (_event, { ourTeamId, opponentTeamId, seasonId, gameDate }) => {
    const report = computeScoutingReport(db, ourTeamId, opponentTeamId, seasonId, gameDate);
    if (!report) return { saved: false };
    const existing = db
      .prepare(`SELECT * FROM scouting_reports WHERE our_team_id = ? AND opponent_team_id = ? AND season_id = ? AND game_date = ?`)
      .get(ourTeamId, opponentTeamId, seasonId, gameDate);
    const keysToGame = existing ? JSON.parse(existing.keys_to_game) : [];
    const playerNotes = existing
      ? db
          .prepare(`SELECT player_id AS playerId, notes FROM scouting_report_player_notes WHERE report_id = ?`)
          .all(existing.id)
          .map((r) => ({ ...r, notes: JSON.parse(r.notes) }))
      : [];

    const suggestedBase = `${report.opponentTeamName}-scouting-report-${report.gameDate}`.replace(/[^\w .-]/g, '');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export scouting report',
      defaultPath: `${suggestedBase}.pdf`,
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { saved: false };

    const teamShots = db
      .prepare(`SELECT x, y, made, value FROM shot_events WHERE team_id = ? AND season_id = ?`)
      .all(report.opponentTeamId, report.seasonId);
    const playerShotsByPlayerId = new Map();
    for (const p of report.roster) {
      playerShotsByPlayerId.set(
        p.playerId,
        db.prepare(`SELECT x, y, made, value FROM shot_events WHERE player_id = ? AND season_id = ?`).all(p.playerId, report.seasonId)
      );
    }

    const buffer = await renderScoutingReportToPdf(report, keysToGame, playerNotes, teamShots, playerShotsByPlayerId);
    await fs.writeFile(filePath, buffer);
    return { saved: true, filePath };
  });

  /** Same PDF as export:scouting-report-pdf, but uploaded to the club's Storage + recorded as the current report instead of saved locally. */
  ipcMain.handle('publish:scouting-report', async (_event, { ourTeamId, opponentTeamId, seasonId, gameDate }) => {
    const report = computeScoutingReport(db, ourTeamId, opponentTeamId, seasonId, gameDate);
    if (!report) return { published: false };
    const existing = db
      .prepare(`SELECT * FROM scouting_reports WHERE our_team_id = ? AND opponent_team_id = ? AND season_id = ? AND game_date = ?`)
      .get(ourTeamId, opponentTeamId, seasonId, gameDate);
    const keysToGame = existing ? JSON.parse(existing.keys_to_game) : [];
    const playerNotes = existing
      ? db
          .prepare(`SELECT player_id AS playerId, notes FROM scouting_report_player_notes WHERE report_id = ?`)
          .all(existing.id)
          .map((r) => ({ ...r, notes: JSON.parse(r.notes) }))
      : [];

    const teamShots = db
      .prepare(`SELECT x, y, made, value FROM shot_events WHERE team_id = ? AND season_id = ?`)
      .all(report.opponentTeamId, report.seasonId);
    const playerShotsByPlayerId = new Map();
    for (const p of report.roster) {
      playerShotsByPlayerId.set(
        p.playerId,
        db.prepare(`SELECT x, y, made, value FROM shot_events WHERE player_id = ? AND season_id = ?`).all(p.playerId, report.seasonId)
      );
    }

    const buffer = await renderScoutingReportToPdf(report, keysToGame, playerNotes, teamShots, playerShotsByPlayerId);
    const published = await publishScoutingReport({ pdfBuffer: buffer, opponentName: report.opponentTeamName, gameDate: report.gameDate });
    return { published: true, ...published };
  });

  ipcMain.handle('cloud:get-current-published-report', () => getCurrentPublishedReport());
  ipcMain.handle('cloud:list-report-viewers', (_event, reportId) => listReportViewers(reportId));
  ipcMain.handle('cloud:list-players', () => listPlayers());
  ipcMain.handle('cloud:create-player-account', (_event, params) => createPlayerAccount(params));

  ipcMain.handle('db:get-team-four-factors-report', (_event, teamId, seasonId) =>
    computeTeamFourFactorsReport(db, teamId, seasonId)
  );

  ipcMain.handle('db:update-player-position', async (_event, playerId, position) => {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('players').update({ position: position || null }).eq('id', playerId);
    if (error) throw new Error(error.message);
    return { saved: true };
  });

  ipcMain.handle('db:update-player-depth-rank', async (_event, playerId, depthRank) => {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('players').update({ depth_rank: depthRank ?? null }).eq('id', playerId);
    if (error) throw new Error(error.message);
    return { saved: true };
  });

  ipcMain.handle('db:update-player-height', async (_event, playerId, height) => {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('players').update({ height: height || null }).eq('id', playerId);
    if (error) throw new Error(error.message);
    return { saved: true };
  });

  ipcMain.handle('db:update-player-hidden', async (_event, playerId, hidden) => {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('players').update({ hidden: !!hidden }).eq('id', playerId);
    if (error) throw new Error(error.message);
    return { saved: true };
  });

  ipcMain.handle('db:get-scouting-report', (_event, ourTeamId, opponentTeamId, seasonId, gameDate) =>
    computeScoutingReport(db, ourTeamId, opponentTeamId, seasonId, gameDate)
  );

  /** Finds or creates the persisted (editable) row for one matchup — keys-to-game bullets live here, per-player notes/photos in scouting_report_player_notes. */
  ipcMain.handle('db:get-or-create-scouting-report-record', (_event, { ourTeamId, opponentTeamId, seasonId, gameDate }) => {
    const existing = db
      .prepare(`SELECT * FROM scouting_reports WHERE our_team_id = ? AND opponent_team_id = ? AND season_id = ? AND game_date = ?`)
      .get(ourTeamId, opponentTeamId, seasonId, gameDate);
    if (existing) return { ...existing, keysToGame: JSON.parse(existing.keys_to_game) };
    const id = db
      .prepare(`INSERT INTO scouting_reports (our_team_id, opponent_team_id, season_id, game_date, keys_to_game) VALUES (?, ?, ?, ?, '[]')`)
      .run(ourTeamId, opponentTeamId, seasonId, gameDate).lastInsertRowid;
    return { id, our_team_id: ourTeamId, opponent_team_id: opponentTeamId, season_id: seasonId, game_date: gameDate, keysToGame: [] };
  });

  ipcMain.handle('db:save-scouting-report-keys', (_event, reportId, keys) => {
    db.prepare(`UPDATE scouting_reports SET keys_to_game = ? WHERE id = ?`).run(JSON.stringify(keys), reportId);
    return { saved: true };
  });

  ipcMain.handle('db:get-scouting-report-player-notes', (_event, reportId) =>
    db
      .prepare(`SELECT player_id AS playerId, notes, photo_path AS photoPath FROM scouting_report_player_notes WHERE report_id = ?`)
      .all(reportId)
      .map((r) => ({ ...r, notes: JSON.parse(r.notes) }))
  );

  ipcMain.handle('db:save-scouting-report-player-notes', (_event, reportId, playerId, notes) => {
    const existing = db
      .prepare(`SELECT id FROM scouting_report_player_notes WHERE report_id = ? AND player_id = ?`)
      .get(reportId, playerId);
    if (existing) {
      db.prepare(`UPDATE scouting_report_player_notes SET notes = ? WHERE id = ?`).run(JSON.stringify(notes), existing.id);
    } else {
      db.prepare(`INSERT INTO scouting_report_player_notes (report_id, player_id, notes) VALUES (?, ?, ?)`).run(
        reportId,
        playerId,
        JSON.stringify(notes)
      );
    }
    return { saved: true };
  });

  /** `photoDataUrl` is a data: URL from the renderer's file picker, or null to clear it — stored as-is despite the column's name. */
  ipcMain.handle('db:save-scouting-report-player-photo', (_event, reportId, playerId, photoDataUrl) => {
    const existing = db
      .prepare(`SELECT id FROM scouting_report_player_notes WHERE report_id = ? AND player_id = ?`)
      .get(reportId, playerId);
    if (existing) {
      db.prepare(`UPDATE scouting_report_player_notes SET photo_path = ? WHERE id = ?`).run(photoDataUrl, existing.id);
    } else {
      db.prepare(`INSERT INTO scouting_report_player_notes (report_id, player_id, notes, photo_path) VALUES (?, ?, '[]', ?)`).run(
        reportId,
        playerId,
        photoDataUrl
      );
    }
    return { saved: true };
  });

  /** The Draw screen's playbook — one row per saved play, `data` is a JSON blob of court frames. */
  ipcMain.handle('db:list-plays', (_event, teamId) =>
    db
      .prepare(
        teamId
          ? `SELECT id, team_id AS teamId, name, updated_at AS updatedAt FROM plays WHERE team_id = ? ORDER BY updated_at DESC`
          : `SELECT id, team_id AS teamId, name, updated_at AS updatedAt FROM plays ORDER BY updated_at DESC`
      )
      .all(...(teamId ? [teamId] : []))
  );

  ipcMain.handle('db:get-play', (_event, playId) => {
    const row = db.prepare(`SELECT id, team_id AS teamId, name, data, updated_at AS updatedAt FROM plays WHERE id = ?`).get(playId);
    if (!row) return null;
    return { ...row, data: JSON.parse(row.data) };
  });

  ipcMain.handle('db:save-play', (_event, { id, teamId, name, data }) => {
    const json = JSON.stringify(data);
    if (id) {
      db.prepare(`UPDATE plays SET team_id = ?, name = ?, data = ?, updated_at = datetime('now') WHERE id = ?`).run(teamId ?? null, name, json, id);
      return { id };
    }
    const newId = db
      .prepare(`INSERT INTO plays (team_id, name, data) VALUES (?, ?, ?)`)
      .run(teamId ?? null, name, json).lastInsertRowid;
    return { id: newId };
  });

  ipcMain.handle('db:delete-play', (_event, playId) => {
    db.prepare(`DELETE FROM plays WHERE id = ?`).run(playId);
    return { deleted: true };
  });

  ipcMain.handle('db:save-game', async (_event, game) => {
    const tier = await getTier();
    if (tier.isPro) throw new Error('Pro plan is read-only — game entry is not available.');
    if (!tier.organizationId) {
      throw new Error('Your account needs to be assigned to a club before saving games — contact your administrator.');
    }

    const supabase = getSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('You need to be logged in to save a game.');

    const source = game.source === 'manual' ? 'manual' : 'photo';
    const teamId = await upsertTeam(supabase, game.team, game.leagueId);
    const oppId = await upsertTeam(supabase, game.opponent, game.leagueId);

    const { data: createdGame, error: gameErr } = await supabase
      .from('games')
      .insert({
        season_id: game.seasonId,
        date: game.date,
        home_team_id: teamId,
        away_team_id: oppId,
        source,
        owner_user_id: user.id,
        organization_id: tier.organizationId,
      })
      .select('id')
      .single();
    if (gameErr) throw new Error(`save game: ${gameErr.message}`);
    const gameId = createdGame.id;

    await insertRoster(supabase, gameId, teamId, game.players || []);
    await insertRoster(supabase, gameId, oppId, game.opponentPlayers || []);
    if (game.events && game.events.length > 0) {
      await insertGameEvents(supabase, gameId, teamId, oppId, game.events);
    }

    return gameId;
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

  ipcMain.handle('db:get-player-stats', (_event, playerId, seasonId) => computePlayerSummary(db, playerId, seasonId));

  ipcMain.handle('db:get-team-stats', (_event, teamId, seasonId) => computeTeamSummary(db, teamId, seasonId));

  ipcMain.handle('db:get-team-scouting-report', (_event, teamId) => buildTeamScoutingReport(db, teamId));

  ipcMain.handle('db:get-player-scouting-report', (_event, playerId) => buildPlayerScoutingReport(db, playerId));

  ipcMain.handle('db:get-team-scouting-report-all-competitions', (_event, teamName) =>
    buildTeamScoutingReportAllCompetitions(db, teamName)
  );

  ipcMain.handle('db:get-player-scouting-report-all-competitions', (_event, playerName, teamName) =>
    buildPlayerScoutingReportAllCompetitions(db, playerName, teamName)
  );

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

  ipcMain.handle('db:list-teams', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('teams').select('*, leagues(name)').order('name');
    if (error) throw new Error(error.message);
    return (data ?? []).map((t) => ({ ...rowWithoutEmbed(t, 'leagues'), league_name: t.leagues?.name ?? null, is_my_team: t.is_my_team ? 1 : 0 }));
  });

  /** Single global favorite team, for the Dashboard's "My Team" quick-select — reuses the existing (previously write-only) is_my_team column. */
  ipcMain.handle('db:get-favorite-team', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('teams').select('*, leagues(name)').eq('is_my_team', true).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return { ...rowWithoutEmbed(data, 'leagues'), league_name: data.leagues?.name ?? null, is_my_team: 1 };
  });

  ipcMain.handle('db:set-favorite-team', async (_event, teamId) => {
    const supabase = getSupabaseClient();
    const { error: clearErr } = await supabase.from('teams').update({ is_my_team: false }).eq('is_my_team', true);
    if (clearErr) throw new Error(clearErr.message);
    const { error: setErr } = await supabase.from('teams').update({ is_my_team: true }).eq('id', teamId);
    if (setErr) throw new Error(setErr.message);
    return { saved: true };
  });

  /** Rows: [{ subjectId: teamId or playerId, isPlayer: boolean, zone, fgm, fga }, ...] — parsed client-side from the uploaded file, inserted as-is (replacing any prior import for the same team/season). */
  ipcMain.handle('db:import-shot-zones', (_event, { teamId, seasonId, rows }) => {
    const importTx = db.transaction(() => {
      const teamPlayerIds = new Set(db.prepare(`SELECT id FROM players WHERE team_id = ?`).all(teamId).map((p) => p.id));
      db.prepare(
        `DELETE FROM shot_zones WHERE team_id = ? AND season_id = ? AND (player_id IS NULL OR player_id IN (SELECT id FROM players WHERE team_id = ?))`
      ).run(teamId, seasonId, teamId);
      const insert = db.prepare(
        `INSERT INTO shot_zones (team_id, player_id, season_id, zone, fgm, fga) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const r of rows) {
        const playerId = r.isPlayer ? r.subjectId : null;
        if (r.isPlayer && !teamPlayerIds.has(playerId)) continue; // ignore rows for players not on this team
        insert.run(teamId, playerId, seasonId, r.zone, r.fgm, r.fga);
      }
    });
    importTx();
    return { saved: true };
  });

  ipcMain.handle('db:get-team-shot-zones', (_event, teamId, seasonId) => {
    const rows = db
      .prepare(`SELECT zone, fgm, fga FROM shot_zones WHERE team_id = ? AND season_id = ? AND player_id IS NULL`)
      .all(teamId, seasonId);
    return { hasData: rows.length > 0, chart: buildZoneChart(rows) };
  });

  ipcMain.handle('db:get-player-shot-zones', (_event, playerId, seasonId) => {
    const rows = db
      .prepare(`SELECT zone, fgm, fga FROM shot_zones WHERE player_id = ? AND season_id = ?`)
      .all(playerId, seasonId);
    return { hasData: rows.length > 0, chart: buildZoneChart(rows) };
  });

  /** Individual shot locations for a real dot-scatter chart — {x,y,made,value}[], already in the app's 0-300x0-320 half-court coordinate space. */
  ipcMain.handle('db:get-team-shot-events', (_event, teamId, seasonId) =>
    db.prepare(`SELECT x, y, made, value FROM shot_events WHERE team_id = ? AND season_id = ?`).all(teamId, seasonId)
  );
  ipcMain.handle('db:get-player-shot-events', (_event, playerId, seasonId) =>
    db.prepare(`SELECT x, y, made, value FROM shot_events WHERE player_id = ? AND season_id = ?`).all(playerId, seasonId)
  );

  ipcMain.handle('db:list-players', async (_event, teamId) => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('players').select('*').eq('team_id', teamId).order('name');
    if (error) throw new Error(error.message);
    return (data ?? []).map((p) => ({ ...p, hidden: p.hidden ? 1 : 0 }));
  });

  ipcMain.handle('db:list-all-players', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('players').select('id, name, team_id, teams(name)').order('name');
    if (error) throw new Error(error.message);
    return (data ?? []).map((p) => ({ id: p.id, name: p.name, teamId: p.team_id, teamName: p.teams?.name ?? null }));
  });

  ipcMain.handle('db:list-leagues', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('leagues').select('*').order('name');
    if (error) throw new Error(error.message);
    return data ?? [];
  });

  ipcMain.handle('db:create-league', async (_event, { name, country, tier }) => {
    const supabase = getSupabaseClient();
    const { data: existing, error: findErr } = await supabase.from('leagues').select('id').eq('name', name).maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (existing) return existing.id;
    const { data: created, error: insertErr } = await supabase
      .from('leagues')
      .insert({ name, country: country || null, tier: tier || null, source: 'manual' })
      .select('id')
      .single();
    if (insertErr) throw new Error(insertErr.message);
    return created.id;
  });

  ipcMain.handle('db:list-seasons', async (_event, leagueId) => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('seasons').select('*').eq('league_id', leagueId).order('year', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

  ipcMain.handle('db:create-season', async (_event, { leagueId, year }) => {
    const supabase = getSupabaseClient();
    const { data: existing, error: findErr } = await supabase
      .from('seasons')
      .select('id')
      .eq('league_id', leagueId)
      .eq('year', year)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (existing) return existing.id;
    const { data: created, error: insertErr } = await supabase
      .from('seasons')
      .insert({ league_id: leagueId, year })
      .select('id')
      .single();
    if (insertErr) throw new Error(insertErr.message);
    return created.id;
  });

  ipcMain.handle('db:create-team', async (_event, { leagueId, name, isMyTeam }) => {
    const supabase = getSupabaseClient();
    const { data: existing, error: findErr } = await supabase
      .from('teams')
      .select('id')
      .eq('name', name)
      .eq('league_id', leagueId)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (existing) {
      if (isMyTeam) {
        const { error: updateErr } = await supabase.from('teams').update({ is_my_team: true }).eq('id', existing.id);
        if (updateErr) throw new Error(updateErr.message);
      }
      return existing.id;
    }
    const { data: created, error: insertErr } = await supabase
      .from('teams')
      .insert({ league_id: leagueId, name, is_my_team: !!isMyTeam })
      .select('id')
      .single();
    if (insertErr) throw new Error(insertErr.message);
    return created.id;
  });

  ipcMain.handle('db:get-player-game-log', (_event, playerId, seasonId) =>
    db
      .prepare(
        `SELECT bs.*, g.date AS date,
                CASE WHEN g.home_team_id = p.team_id THEN away.name ELSE home.name END AS opponent
         FROM box_scores bs
         JOIN players p ON p.id = bs.player_id
         JOIN games g ON g.id = bs.game_id
         JOIN teams home ON home.id = g.home_team_id
         JOIN teams away ON away.id = g.away_team_id
         WHERE bs.player_id = ? AND (? IS NULL OR g.season_id = ?)
         ORDER BY g.date ASC`
      )
      .all(playerId, seasonId ?? null, seasonId ?? null)
  );

  ipcMain.handle('db:get-player-pie-log', (_event, playerId, seasonId) => {
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
         WHERE bs.player_id = ? AND (? IS NULL OR g.season_id = ?)
         ORDER BY g.date ASC`
      )
      .all(playerId, seasonId ?? null, seasonId ?? null);

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
  ipcMain.handle('db:get-player-per-log', (_event, playerId, seasonId) => {
    const player = db.prepare(`SELECT team_id FROM players WHERE id = ?`).get(playerId);
    if (!player) return [];
    const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(player.team_id);
    const teamAgg = teamAggregate(db, player.team_id, seasonId);
    const leagueAgg = seasonId ? leagueAggregateForSeason(db, team.league_id, seasonId) : leagueAggregate(db, team.league_id);

    const games = db
      .prepare(
        `SELECT bs.*, g.id AS game_id, g.date AS date,
                CASE WHEN g.home_team_id = p.team_id THEN away.name ELSE home.name END AS opponent
         FROM box_scores bs
         JOIN players p ON p.id = bs.player_id
         JOIN games g ON g.id = bs.game_id
         JOIN teams home ON home.id = g.home_team_id
         JOIN teams away ON away.id = g.away_team_id
         WHERE bs.player_id = ? AND (? IS NULL OR g.season_id = ?)
         ORDER BY g.date ASC`
      )
      .all(playerId, seasonId ?? null, seasonId ?? null);

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

  ipcMain.handle('db:get-player-season-history', (_event, playerId) => computePlayerSeasonHistory(db, playerId));
  ipcMain.handle('db:get-team-season-history', (_event, teamId) => computeTeamSeasonHistory(db, teamId));

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

  ipcMain.handle('db:get-team-game-log', (_event, teamId, seasonId) =>
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
         WHERE p.team_id = ? AND (? IS NULL OR g.season_id = ?)
         GROUP BY g.id
         ORDER BY g.date ASC`
      )
      .all(teamId, teamId, seasonId ?? null, seasonId ?? null)
  );

  /** PER per game for a team — same "one game through the season's rate constants" approach as db:get-player-per-log. */
  ipcMain.handle('db:get-team-per-log', (_event, teamId, seasonId) => {
    const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(teamId);
    if (!team) return [];
    const teamAgg = teamAggregate(db, teamId, seasonId);
    const leagueAgg = seasonId ? leagueAggregateForSeason(db, team.league_id, seasonId) : leagueAggregate(db, team.league_id);

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
         WHERE p.team_id = ? AND (? IS NULL OR g.season_id = ?)
         GROUP BY g.id
         ORDER BY g.date ASC`
      )
      .all(teamId, teamId, seasonId ?? null, seasonId ?? null);

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
function playerHasPlayByPlayData(db, playerId, seasonId) {
  const row = seasonId
    ? db
        .prepare(
          `SELECT 1 FROM box_scores bs
           JOIN games g ON g.id = bs.game_id
           WHERE bs.player_id = ? AND g.season_id = ? AND EXISTS (SELECT 1 FROM game_events ge WHERE ge.game_id = bs.game_id)
           LIMIT 1`
        )
        .get(playerId, seasonId)
    : db
        .prepare(
          `SELECT 1 FROM box_scores bs
           WHERE bs.player_id = ? AND EXISTS (SELECT 1 FROM game_events ge WHERE ge.game_id = bs.game_id)
           LIMIT 1`
        )
        .get(playerId);
  return !!row;
}

function computePlayerSummary(db, playerId, seasonId) {
  const rows = seasonId
    ? db
        .prepare(`SELECT bs.* FROM box_scores bs JOIN games g ON g.id = bs.game_id WHERE bs.player_id = ? AND g.season_id = ?`)
        .all(playerId, seasonId)
    : db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(playerId);
  const player = db.prepare(`SELECT team_id FROM players WHERE id = ?`).get(playerId);
  const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(player.team_id);

  const teamAgg = teamAggregate(db, player.team_id, seasonId);
  const oppAgg = opponentAggregate(db, player.team_id, seasonId);
  const leagueAgg = seasonId ? leagueAggregateForSeason(db, team.league_id, seasonId) : leagueAggregate(db, team.league_id);
  return buildStatSummary({
    rows,
    games: rows.length,
    isTeam: false,
    teamAgg,
    oppAgg,
    leagueAgg,
    hasPlayByPlayData: playerHasPlayByPlayData(db, playerId, seasonId),
  });
}

function computeTeamSummary(db, teamId, seasonId) {
  const teamAgg = teamAggregate(db, teamId, seasonId);
  const oppAgg = opponentAggregate(db, teamId, seasonId);
  const team = db.prepare(`SELECT league_id FROM teams WHERE id = ?`).get(teamId);
  const leagueAgg = seasonId ? leagueAggregateForSeason(db, team.league_id, seasonId) : leagueAggregate(db, team.league_id);
  return buildStatSummary({ rows: teamAgg.rows, games: teamAgg.games, isTeam: true, teamAgg, oppAgg, leagueAgg });
}

/** Every season this player has box-score rows in, oldest first — the raw material for the Dashboard's "History" tab. */
function computePlayerSeasonHistory(db, playerId) {
  const seasons = db
    .prepare(
      `SELECT DISTINCT g.season_id AS id, s.year
       FROM box_scores bs
       JOIN games g ON g.id = bs.game_id
       JOIN seasons s ON s.id = g.season_id
       WHERE bs.player_id = ?
       ORDER BY s.year ASC`
    )
    .all(playerId);

  return seasons.map((s) => {
    const summary = computePlayerSummary(db, playerId, s.id);
    return {
      seasonId: s.id,
      seasonYear: s.year,
      games: summary.games,
      pts: summary.perGame['pts'] ?? 0,
      per: summary.per,
      pie: summary.pie,
      netRating: summary.netRating,
    };
  });
}

/** Same shape as computePlayerSeasonHistory, for a team. */
function computeTeamSeasonHistory(db, teamId) {
  const seasons = db
    .prepare(
      `SELECT DISTINCT g.season_id AS id, s.year
       FROM games g
       JOIN seasons s ON s.id = g.season_id
       WHERE g.home_team_id = ? OR g.away_team_id = ?
       ORDER BY s.year ASC`
    )
    .all(teamId, teamId);

  return seasons.map((s) => {
    const summary = computeTeamSummary(db, teamId, s.id);
    return {
      seasonId: s.id,
      seasonYear: s.year,
      games: summary.games,
      pts: summary.perGame['pts'] ?? 0,
      per: summary.per,
      pie: summary.pie,
      netRating: summary.netRating,
    };
  });
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

  const hasEnoughWinLossGames = winRows.length >= 2 && lossRows.length >= 2;
  const winVsLossInsights = hasEnoughWinLossGames
    ? buildPlayerWinLossInsights(
        player.name,
        perGame(sumRows(winRows), winRows.length),
        perGame(sumRows(lossRows), lossRows.length)
      )
    : [];

  const playingTimeInsights = buildPlayingTimeInsights(computePlayerAdvancedGameLog(db, playerId));

  return {
    playerId: player.id,
    playerName: player.name,
    teamName: team.name,
    leagueName: league?.name ?? '',
    games: summary.games,
    profileInsights,
    winVsLossInsights,
    hasEnoughWinLossGames,
    playingTimeInsights,
  };
}

/**
 * Same shape as buildTeamScoutingReport, but pooled across every league-scoped
 * sibling row for this club (same sibling-matching-by-name pattern as
 * db:get-team-all-competitions) instead of one single team_id. The "vs
 * average" baseline is likewise pooled across each sibling's own league
 * average, weighted by how many of that league's games are actually in the pool.
 */
function buildTeamScoutingReportAllCompetitions(db, teamName) {
  const siblings = db
    .prepare(`SELECT t.id, t.league_id, l.name AS league_name FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.name = ?`)
    .all(teamName);
  if (siblings.length === 0) return null;
  const siblingIds = siblings.map((s) => s.id);
  const placeholders = siblingIds.map(() => '?').join(',');

  const teamAggs = siblings.map((s) => teamAggregate(db, s.id));
  const allRows = teamAggs.flatMap((a) => a.rows);
  const totalGames = new Set(allRows.map((r) => r.game_id)).size;
  const teamPerGame = perGame(sumRows(allRows), totalGames || 1);

  const leagueAggs = siblings.map((s) => leagueAggregate(db, s.league_id));
  const leagueRowsAll = leagueAggs.flatMap((a) => a.rows);
  const leagueTeamGamesAll = leagueAggs.reduce((sum, a) => sum + (a.teamGames || 0), 0);
  const leaguePerGame = perGame(sumRows(leagueRowsAll), leagueTeamGamesAll || 1);
  const profileInsights = buildTeamProfileInsights(teamName, teamPerGame, leaguePerGame);

  const playerNames = [
    ...new Set(
      db
        .prepare(`SELECT DISTINCT name FROM players WHERE team_id IN (${placeholders})`)
        .all(...siblingIds)
        .map((p) => p.name)
    ),
  ];
  const oppRowsAll = siblingIds.flatMap((id) => opponentAggregate(db, id).rows);
  const oppTotalsAll = sumRows(oppRowsAll);
  const teamTotalsAll = sumRows(allRows);
  const keyPlayers = playerNames
    .map((name) => {
      const playerIds = db
        .prepare(`SELECT id FROM players WHERE name = ? AND team_id IN (${placeholders})`)
        .all(name, ...siblingIds)
        .map((p) => p.id);
      const rows = playerIds.flatMap((id) => db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(id));
      const games = rows.length;
      const pg = perGame(sumRows(rows), games || 1);
      return {
        playerId: playerIds[0],
        playerName: name,
        games,
        pts: pg.pts ?? 0,
        reb: (pg.oreb ?? 0) + (pg.dreb ?? 0),
        ast: pg.ast ?? 0,
        pie: games > 0 ? computePIE(sumRows(rows), teamTotalsAll, oppTotalsAll) : null,
      };
    })
    .filter((p) => p.games >= 2)
    .sort((a, b) => (b.pie ?? 0) - (a.pie ?? 0))
    .slice(0, 3)
    .map(({ games, ...rest }) => rest);

  const results = siblingIds.flatMap((id) => teamGameResults(db, id));
  const wins = results.filter((r) => r.won);
  const losses = results.filter((r) => !r.won);
  const lossPerGame = losses.length ? perGame(sumRows(losses.map((r) => r.teamTotals)), losses.length) : null;
  const winPerGame = wins.length ? perGame(sumRows(wins.map((r) => r.teamTotals)), wins.length) : null;
  const oppLossPerGame = losses.length ? perGame(sumRows(losses.map((r) => r.oppTotals)), losses.length) : null;
  const oppWinPerGame = wins.length ? perGame(sumRows(wins.map((r) => r.oppTotals)), wins.length) : null;
  const lossPatternInsights =
    losses.length >= 2 && wins.length >= 2
      ? buildLossPatternInsights(teamName, lossPerGame, winPerGame, oppLossPerGame, oppWinPerGame)
      : [];

  return {
    teamId: siblingIds[0],
    teamName,
    leagueName: 'All competitions',
    games: totalGames,
    wins: wins.length,
    losses: losses.length,
    profileInsights,
    keyPlayers,
    lossPatternInsights,
  };
}

/** Player counterpart to buildTeamScoutingReportAllCompetitions — pools every sibling (name, team-name) row for this player across leagues. */
function buildPlayerScoutingReportAllCompetitions(db, playerName, teamName) {
  const siblings = db
    .prepare(
      `SELECT p.id, t.id AS team_id, t.league_id
       FROM players p JOIN teams t ON t.id = p.team_id
       WHERE p.name = ? AND t.name = ?`
    )
    .all(playerName, teamName);
  if (siblings.length === 0) return null;
  const siblingPlayerIds = siblings.map((s) => s.id);
  const siblingTeamIds = [...new Set(siblings.map((s) => s.team_id))];

  const allRows = siblingPlayerIds.flatMap((id) => db.prepare(`SELECT * FROM box_scores WHERE player_id = ?`).all(id));
  const games = allRows.length;
  const summaryPerGame = perGame(sumRows(allRows), games || 1);

  const leagueIds = [...new Set(siblings.map((s) => s.league_id))];
  const leagueAggs = leagueIds.map((id) => leagueAggregate(db, id));
  const leagueRowsAll = leagueAggs.flatMap((a) => a.rows);
  const leaguePerGame = perGame(sumRows(leagueRowsAll), leagueRowsAll.length || 1);
  const profileInsights = buildTeamProfileInsights(playerName, summaryPerGame, leaguePerGame);

  const results = siblingTeamIds.flatMap((id) => teamGameResults(db, id));
  const winGameIds = new Set(results.filter((r) => r.won).map((r) => r.gameId));
  const lossGameIds = new Set(results.filter((r) => !r.won).map((r) => r.gameId));
  const winRows = allRows.filter((r) => winGameIds.has(r.game_id));
  const lossRows = allRows.filter((r) => lossGameIds.has(r.game_id));
  const hasEnoughWinLossGames = winRows.length >= 2 && lossRows.length >= 2;
  const winVsLossInsights = hasEnoughWinLossGames
    ? buildPlayerWinLossInsights(playerName, perGame(sumRows(winRows), winRows.length), perGame(sumRows(lossRows), lossRows.length))
    : [];

  return {
    playerId: siblingPlayerIds[0],
    playerName,
    teamName,
    leagueName: 'All competitions',
    games,
    profileInsights,
    winVsLossInsights,
    hasEnoughWinLossGames,
    playingTimeInsights: [],
  };
}

/**
 * One row per game this player has data for, with every advanced metric
 * PLAYING_TIME_METRIC_DEFS needs computed at single-game grain (not a
 * season aggregate) — the raw material for buildPlayingTimeInsights'
 * trend-vs-minutes check. Rebounding/ball-handling % are left null for a
 * game whose opponent has no box score entered at all (rather than
 * computing them against an all-zero opponent total, which would produce
 * a fabricated-looking 0% or 100%, not an honest "not measured").
 */
function computePlayerAdvancedGameLog(db, playerId) {
  const games = db
    .prepare(
      `SELECT bs.*, g.id AS game_id, g.date AS date, p.team_id AS team_id,
              CASE WHEN g.home_team_id = p.team_id THEN g.away_team_id ELSE g.home_team_id END AS opp_team_id
       FROM box_scores bs
       JOIN players p ON p.id = bs.player_id
       JOIN games g ON g.id = bs.game_id
       WHERE bs.player_id = ?
       ORDER BY g.date ASC`
    )
    .all(playerId);

  const teamRowsStmt = db.prepare(
    `SELECT bs2.* FROM box_scores bs2 JOIN players p2 ON p2.id = bs2.player_id WHERE bs2.game_id = ? AND p2.team_id = ?`
  );

  return games.map((g) => {
    const teamRows = teamRowsStmt.all(g.game_id, g.team_id);
    const oppRows = teamRowsStmt.all(g.game_id, g.opp_team_id);
    const hasOppData = oppRows.length > 0;

    const selfContained = advancedStatLine(g);
    const reb = hasOppData
      ? reboundingStatLine({ row: g, teamRow: sumRows(teamRows), oppRow: sumRows(oppRows), isTeam: false })
      : { oreb_pct: null, dreb_pct: null, treb_pct: null };
    const bh = hasOppData
      ? ballHandlingStatLine({ row: g, teamRow: sumRows(teamRows), oppRow: sumRows(oppRows), isTeam: false })
      : { ast_pct: null, stl_pct: null, blk_pct: null, tov_pct: null, usg_pct: null };

    return { min: g.min, ...selfContained, ...reb, ...bh };
  });
}

function teamAggregate(db, teamId, seasonId) {
  const rows = seasonId
    ? db
        .prepare(
          `SELECT bs.* FROM box_scores bs
           JOIN players p ON p.id = bs.player_id
           JOIN games g ON g.id = bs.game_id
           WHERE p.team_id = ? AND g.season_id = ?`
        )
        .all(teamId, seasonId)
    : db
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
function opponentAggregate(db, teamId, seasonId) {
  const rows = seasonId
    ? db
        .prepare(
          `SELECT bs.*
           FROM box_scores bs
           JOIN players p ON p.id = bs.player_id
           JOIN games g ON g.id = bs.game_id
           WHERE g.season_id = ?
             AND ((g.home_team_id = ? AND p.team_id = g.away_team_id)
               OR (g.away_team_id = ? AND p.team_id = g.home_team_id))`
        )
        .all(seasonId, teamId, teamId)
    : db
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

/** Same shape as leagueAggregate, restricted to one season — the season-scoped counterpart used once a season is selected. */
function leagueAggregateForSeason(db, leagueId, seasonId) {
  const rows = leagueSeasonRows(db, leagueId, seasonId);
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
 * Points off Turnovers / Second Chance Points / Fastbreak Points for one
 * team, summed across exactly the given `gameIds` — the caller picks which
 * games (all season, last 5, a specific head-to-head meeting, ...). Only
 * games with real play-by-play data contribute; returns null entirely if
 * none of the given games have any (honesty gate, same as every other
 * PBP-only metric).
 */
function computePossessionStatsForTeamGames(db, teamId, gameIds) {
  if (gameIds.length === 0) return null;
  const placeholders = gameIds.map(() => '?').join(',');
  const games = db
    .prepare(
      `SELECT id, home_team_id AS homeTeamId, away_team_id AS awayTeamId FROM games
       WHERE id IN (${placeholders}) AND EXISTS (SELECT 1 FROM game_events ge WHERE ge.game_id = games.id)`
    )
    .all(...gameIds);
  if (games.length === 0) return null;

  const totals = { pointsOffTurnovers: 0, secondChancePoints: 0, fastbreakPoints: 0 };
  for (const g of games) {
    const events = db.prepare(`SELECT * FROM game_events WHERE game_id = ? ORDER BY clock_seconds, sequence`).all(g.id);
    const possessions = reconstructGamePossessions(events, g.homeTeamId, g.awayTeamId);
    const stats = possessionStatsForTeam(possessions, teamId);
    totals.pointsOffTurnovers += stats.pointsOffTurnovers;
    totals.secondChancePoints += stats.secondChancePoints;
    totals.fastbreakPoints += stats.fastbreakPoints;
  }
  return totals;
}

/**
 * Official per-game Points off Turnovers / Second Chance / Fastbreak /
 * Points in the Paint, when a real data provider's own shot-level flags were
 * imported (see team_game_advanced_stats table + data-import/). Preferred
 * over computePossessionStatsForTeamGames's clock-threshold estimate
 * whenever it's available — it's the source's own ground truth, not a
 * heuristic. Returns null if none of the given games have official rows
 * (same honesty-gate pattern as the possession estimate).
 */
function computeOfficialTeamAdvancedStats(db, teamId, gameIds) {
  if (gameIds.length === 0) return null;
  const placeholders = gameIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM team_game_advanced_stats WHERE team_id = ? AND game_id IN (${placeholders})`
    )
    .all(teamId, ...gameIds);
  if (rows.length === 0) return null;
  const totals = { pointsOffTurnovers: 0, secondChancePoints: 0, fastbreakPoints: 0, pointsInThePaint: 0 };
  for (const r of rows) {
    totals.pointsOffTurnovers += r.points_off_turnovers;
    totals.secondChancePoints += r.second_chance_points;
    totals.fastbreakPoints += r.fastbreak_points;
    totals.pointsInThePaint += r.points_in_the_paint;
  }
  return { ...totals, games: rows.length };
}

/**
 * Off/Def Four Factors-family line for one team, restricted to an exact
 * game-id set — the shared building block for computeScoutingReport's
 * "Impact IQ Factors" section (both sides) and each Team Stats split.
 */
function offDefFourFactors(db, teamId, gameIds) {
  const teamAgg = teamAggregateThrough(db, teamId, gameIds);
  const oppAgg = opponentAggregateThrough(db, teamId, gameIds);
  const games = gameIds.length || 1;
  const offPerGame = perGame(teamAgg.totals, games);
  const defPerGame = perGame(oppAgg.totals, games);
  const offAdv = advancedStatLine(offPerGame);
  const defAdv = advancedStatLine(defPerGame);
  const offBall = ballHandlingStatLine({ row: teamAgg.totals, teamRow: teamAgg.totals, oppRow: oppAgg.totals, isTeam: true });
  const defBall = ballHandlingStatLine({ row: oppAgg.totals, teamRow: oppAgg.totals, oppRow: teamAgg.totals, isTeam: true });
  const offReb = reboundingStatLine({ row: teamAgg.totals, teamRow: teamAgg.totals, oppRow: oppAgg.totals, isTeam: true });
  const defReb = reboundingStatLine({ row: oppAgg.totals, teamRow: oppAgg.totals, oppRow: teamAgg.totals, isTeam: true });
  return {
    off: { efgPct: offAdv.efg_pct, tsPct: offAdv.ts_pct, tovPct: offBall.tov_pct, astPct: offBall.ast_pct, trebPct: offReb.treb_pct, ftRate: offAdv.ft_rate, ftPct: offAdv.ft_pct },
    def: { efgPct: defAdv.efg_pct, tsPct: defAdv.ts_pct, tovPct: defBall.tov_pct, astPct: defBall.ast_pct, trebPct: defReb.treb_pct, ftRate: defAdv.ft_rate, ftPct: defAdv.ft_pct },
  };
}

/** Full "Team Stats" row (the PDF's big table) for one team, restricted to an exact game-id set. Null if the set is empty. */
function teamStatsRowFor(db, teamId, gameIds) {
  if (gameIds.length === 0) return null;
  const off = teamAggregateThrough(db, teamId, gameIds);
  const def = opponentAggregateThrough(db, teamId, gameIds);
  const games = gameIds.length;
  const offPerGame = perGame(off.totals, games);
  const defPerGame = perGame(def.totals, games);
  const offAdv = advancedStatLine(offPerGame);
  const defAdv = advancedStatLine(defPerGame);
  // Prefer official per-shot-flag numbers (real data provider ground truth)
  // over the app's own clock-threshold possession estimate, whenever the
  // imported games actually have official data.
  const official = computeOfficialTeamAdvancedStats(db, teamId, gameIds);
  const poss = official ? null : computePossessionStatsForTeamGames(db, teamId, gameIds);
  const extra = official
    ? {
        pointsOffTurnovers: official.pointsOffTurnovers / official.games,
        secondChancePoints: official.secondChancePoints / official.games,
        fastbreakPoints: official.fastbreakPoints / official.games,
        pointsInThePaint: official.pointsInThePaint / official.games,
        advancedStatsAreOfficial: true,
      }
    : {
        pointsOffTurnovers: poss ? poss.pointsOffTurnovers / games : null,
        secondChancePoints: poss ? poss.secondChancePoints / games : null,
        fastbreakPoints: poss ? poss.fastbreakPoints / games : null,
        pointsInThePaint: null,
        advancedStatsAreOfficial: false,
      };
  return {
    games,
    pts: offPerGame.pts, fgm: offPerGame.fgm, fga: offPerGame.fga, fgPct: offAdv.fg_pct,
    tpm: offPerGame.tpm, tpa: offPerGame.tpa, tpPct: offAdv.tp_pct,
    ftm: offPerGame.ftm, fta: offPerGame.fta, ftPct: offAdv.ft_pct,
    ast: offPerGame.ast,
    oreb: offPerGame.oreb, dreb: offPerGame.dreb, reb: (offPerGame.oreb ?? 0) + (offPerGame.dreb ?? 0),
    stl: offPerGame.stl, blk: offPerGame.blk, tov: offPerGame.tov,
    pace: pacePerGame(off.totals, games),
    ortg: offAdv.points_per_100poss,
    drtg: defAdv.points_per_100poss,
    ppp: offAdv.points_per_poss,
    efgPct: offAdv.efg_pct,
    ...extra,
  };
}

/**
 * Orchestrates the whole Scouting screen for one upcoming matchup. Per the
 * source template, the bulk of the report (roster, depth chart, team stats,
 * shot charts, leaders, per-player pages) profiles the OPPONENT — the team
 * being scouted — not "our" team; only Impact IQ Factors compares both
 * sides directly, matching how a real pre-game scouting report is used.
 */
function computeScoutingReport(db, ourTeamId, opponentTeamId, seasonId, gameDate) {
  const ourTeam = db.prepare(`SELECT id, name FROM teams WHERE id = ?`).get(ourTeamId);
  const oppTeam = db.prepare(`SELECT id, name FROM teams WHERE id = ?`).get(opponentTeamId);
  if (!ourTeam || !oppTeam) return null;
  const season = db.prepare(`SELECT year FROM seasons WHERE id = ?`).get(seasonId);

  const seasonGamesFor = (teamId) =>
    db
      .prepare(
        `SELECT id, date, home_team_id AS homeTeamId, away_team_id AS awayTeamId FROM games
         WHERE season_id = ? AND (home_team_id = ? OR away_team_id = ?) ORDER BY date ASC, id ASC`
      )
      .all(seasonId, teamId, teamId);

  const oppGames = seasonGamesFor(opponentTeamId);
  const oppGameIds = oppGames.map((g) => g.id);
  const oppLast5GameIds = oppGameIds.slice(-5);
  const h2hGames = oppGames.filter((g) => g.homeTeamId === ourTeamId || g.awayTeamId === ourTeamId);

  const oppResults = teamGameResults(db, opponentTeamId).filter((r) => oppGameIds.includes(r.gameId));
  const wins = oppResults.filter((r) => r.won).length;
  const losses = oppResults.filter((r) => !r.won).length;

  // --- Roster / cumulative boxscore / depth chart (opponent) ---
  const rosterRows = db.prepare(`SELECT id, name, position, depth_rank, height, hidden FROM players WHERE team_id = ? ORDER BY name`).all(opponentTeamId);
  const roster = rosterRows.map((p) => {
    const rows =
      oppGameIds.length > 0
        ? db.prepare(`SELECT * FROM box_scores WHERE player_id = ? AND game_id IN (${oppGameIds.map(() => '?').join(',')})`).all(p.id, ...oppGameIds)
        : [];
    const games = rows.length;
    const totals = sumRows(rows);
    const pg = perGame(totals, games || 1);
    return {
      playerId: p.id,
      name: p.name,
      position: p.position,
      depthRank: p.depth_rank,
      height: p.height,
      hidden: !!p.hidden,
      games,
      totals,
      perGame: pg,
    };
  });
  const visibleRoster = roster.filter((p) => !p.hidden);
  const teamAggAll = teamAggregateThrough(db, opponentTeamId, oppGameIds);
  const oppOfTeamAggAll = opponentAggregateThrough(db, opponentTeamId, oppGameIds);
  const teamTotalsRow = perGame(teamAggAll.totals, oppGameIds.length || 1);
  const opponentAverageRow = perGame(oppOfTeamAggAll.totals, oppGameIds.length || 1);

  const depthPositions = ['PG', 'SG', 'SF', 'PF', 'C'];
  const depthChart = depthPositions.map((pos) => ({
    position: pos,
    players: visibleRoster
      .filter((p) => p.position === pos)
      .sort((a, b) => (a.depthRank ?? 999) - (b.depthRank ?? 999))
      .map((p) => ({ playerId: p.playerId, name: p.name })),
  }));

  // --- Recent games (opponent's last 5) ---
  const recentGames = oppGames.slice(-5).reverse().map((g) => {
    const oppSideTeamId = g.homeTeamId === opponentTeamId ? g.awayTeamId : g.homeTeamId;
    const oppSideName = db.prepare(`SELECT name FROM teams WHERE id = ?`).get(oppSideTeamId)?.name ?? '';
    const totals = sumRows(db.prepare(`SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`).all(g.id, opponentTeamId));
    const oppTotals = sumRows(db.prepare(`SELECT bs.* FROM box_scores bs JOIN players p ON p.id = bs.player_id WHERE bs.game_id = ? AND p.team_id = ?`).all(g.id, oppSideTeamId));
    return {
      date: g.date,
      opponent: oppSideName,
      site: g.homeTeamId === opponentTeamId ? 'Home' : 'Away',
      won: totals.pts > oppTotals.pts,
      score: `${totals.pts}-${oppTotals.pts}`,
    };
  });

  // --- Impact IQ Factors (both sides) ---
  const impactIqFactors = {
    us: offDefFourFactors(db, ourTeamId, seasonGamesFor(ourTeamId).map((g) => g.id)),
    opponent: offDefFourFactors(db, opponentTeamId, oppGameIds),
  };

  // --- Team Stats splits (opponent) ---
  const teamStats = {
    allOff: teamStatsRowFor(db, opponentTeamId, oppGameIds),
    last5: teamStatsRowFor(db, opponentTeamId, oppLast5GameIds),
    meetings: h2hGames.map((g) => ({
      date: g.date,
      site: g.homeTeamId === opponentTeamId ? 'vs' : '@',
      ourTeamName: ourTeam.name,
      stats: teamStatsRowFor(db, opponentTeamId, [g.id]),
    })),
  };

  // --- Points per period (opponent, across their whole season — a different real
  // opponent in each game, so this sums by "was it opponentTeamId's own event or
  // not" rather than assuming one fixed second team throughout). ---
  const pointsPerPeriod = (() => {
    if (oppGameIds.length === 0) return null;
    const placeholders = oppGameIds.map(() => '?').join(',');
    const events = db
      .prepare(`SELECT game_id, clock_seconds, points, team_id FROM game_events WHERE game_id IN (${placeholders}) AND event_type = 'score'`)
      .all(...oppGameIds);
    if (events.length === 0) return null;
    const pbpGameCount = new Set(events.map((e) => e.game_id)).size;
    const team = [0, 0, 0, 0];
    const opponent = [0, 0, 0, 0];
    for (const e of events) {
      const idx = Math.min(Math.floor(e.clock_seconds / 600), 3);
      const target = e.team_id === opponentTeamId ? team : opponent;
      target[idx] += e.points || 0;
    }
    return { games: pbpGameCount, team: team.map((v) => v / pbpGameCount), opponent: opponent.map((v) => v / pbpGameCount) };
  })();

  // --- Team Pace (both sides) ---
  const teamPace = {
    us: pacePerGame(teamAggregateThrough(db, ourTeamId, seasonGamesFor(ourTeamId).map((g) => g.id)).totals, seasonGamesFor(ourTeamId).length || 1),
    opponent: pacePerGame(teamAggAll.totals, oppGameIds.length || 1),
  };

  // --- Team Advanced Stats row (opponent) ---
  const ptsFor = teamTotalsRow.pts ?? 0;
  const ptsAgainst = opponentAverageRow.pts ?? 0;
  const advStatsRow = {
    wins,
    losses,
    pythagoreanWinPct: pythagoreanWinPct(ptsFor, ptsAgainst),
    ortg: advancedStatLine(teamTotalsRow).points_per_100poss,
    drtg: advancedStatLine(opponentAverageRow).points_per_100poss,
    pace: teamPace.opponent,
    ftRate: advancedStatLine(teamTotalsRow).ft_rate,
    threePtRate: advancedStatLine(teamTotalsRow).three_pt_attempt_rate,
    possessions: estimatePossessions(teamAggAll.totals) / (oppGameIds.length || 1),
  };
  advStatsRow.netRating = advStatsRow.ortg !== null && advStatsRow.drtg !== null ? advStatsRow.ortg - advStatsRow.drtg : null;

  // --- Leaders (opponent roster) ---
  const withGames = visibleRoster.filter((p) => p.games > 0);
  const topBy = (fn, n = 5) => [...withGames].sort((a, b) => fn(b) - fn(a)).slice(0, n);
  const leaders = {
    topScorers: topBy((p) => p.perGame.pts ?? 0).map((p) => ({ playerId: p.playerId, name: p.name, value: p.perGame.pts ?? 0, fgm: p.totals.fgm, fga: p.totals.fga, fgPct: advancedStatLine(p.perGame).fg_pct })),
    threePtShooters: [...withGames]
      .filter((p) => (p.totals.tpa ?? 0) >= 10)
      .sort((a, b) => advancedStatLine(b.perGame).tp_pct - advancedStatLine(a.perGame).tp_pct)
      .slice(0, 5)
      .map((p) => ({ playerId: p.playerId, name: p.name, tpm: p.totals.tpm, tpa: p.totals.tpa, tpPct: advancedStatLine(p.perGame).tp_pct })),
    ftShooters: [...withGames]
      .filter((p) => (p.totals.fta ?? 0) >= 10)
      .sort((a, b) => advancedStatLine(b.perGame).ft_pct - advancedStatLine(a.perGame).ft_pct)
      .slice(0, 5)
      .map((p) => ({ playerId: p.playerId, name: p.name, ftm: p.totals.ftm, fta: p.totals.fta, ftPct: advancedStatLine(p.perGame).ft_pct })),
    topRebounders: topBy((p) => (p.perGame.oreb ?? 0) + (p.perGame.dreb ?? 0)).map((p) => ({
      playerId: p.playerId,
      name: p.name,
      reb: p.totals.oreb + p.totals.dreb,
      oreb: p.totals.oreb,
    })),
    ballControl: [...withGames]
      .sort((a, b) => (b.totals.ast ?? 0) / Math.max(1, b.totals.tov ?? 1) - (a.totals.ast ?? 0) / Math.max(1, a.totals.tov ?? 1))
      .slice(0, 5)
      .map((p) => ({ playerId: p.playerId, name: p.name, ast: p.totals.ast, tov: p.totals.tov, ratio: p.totals.tov > 0 ? p.totals.ast / p.totals.tov : null })),
    defense: topBy((p) => (p.perGame.stl ?? 0) + (p.perGame.blk ?? 0)).map((p) => ({
      playerId: p.playerId,
      name: p.name,
      stl: p.perGame.stl ?? 0,
      blk: p.perGame.blk ?? 0,
    })),
  };

  // --- Per-player pages: season line + each head-to-head meeting vs us ---
  const playerPages = visibleRoster.map((p) => {
    const meetings = h2hGames.map((g) => {
      const rows = db.prepare(`SELECT * FROM box_scores WHERE player_id = ? AND game_id = ?`).all(p.playerId, g.id);
      if (rows.length === 0) return null;
      const pg = perGame(sumRows(rows), 1);
      return { date: g.date, site: g.homeTeamId === opponentTeamId ? 'vs' : '@', perGame: pg, advanced: advancedStatLine(pg) };
    }).filter(Boolean);
    return {
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      height: p.height,
      games: p.games,
      perGame: p.perGame,
      advanced: advancedStatLine(p.perGame),
      meetings,
    };
  });

  return {
    ourTeamId,
    ourTeamName: ourTeam.name,
    opponentTeamId,
    opponentTeamName: oppTeam.name,
    seasonId,
    seasonYear: season ? season.year : '',
    gameDate,
    record: { wins, losses },
    roster: roster.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      depthRank: p.depthRank,
      height: p.height,
      hidden: p.hidden,
      games: p.games,
      perGame: p.perGame,
      totals: p.totals,
    })),
    teamTotalsPerGame: teamTotalsRow,
    opponentAveragePerGame: opponentAverageRow,
    depthChart,
    recentGames,
    impactIqFactors,
    teamStats,
    pointsPerPeriod,
    teamPace,
    advStatsRow,
    leaders,
    playerPages,
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

async function insertRoster(supabase, gameId, teamId, players) {
  for (const p of players) {
    const playerId = await upsertPlayer(supabase, p.name, teamId);
    const { error } = await supabase.from('box_scores').insert({
      game_id: gameId,
      player_id: playerId,
      min: p.min,
      pts: p.pts,
      fgm: p.fgm,
      fga: p.fga,
      tpm: p.tpm,
      tpa: p.tpa,
      ftm: p.ftm,
      fta: p.fta,
      oreb: p.oreb,
      dreb: p.dreb,
      ast: p.ast,
      stl: p.stl,
      blk: p.blk,
      tov: p.tov,
      pf: p.pf,
      pfd: p.pfd ?? 0,
      plus_minus: p.plus_minus ?? 0,
      srj: p.srj ?? 0,
    });
    if (error) throw new Error(`insert box score: ${error.message}`);
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
async function insertGameEvents(supabase, gameId, homeTeamId, awayTeamId, events) {
  for (const e of events) {
    const teamId = e.side === 'home' ? homeTeamId : awayTeamId;
    const playerId = e.playerName ? await upsertPlayer(supabase, e.playerName, teamId) : null;
    const { error } = await supabase.from('game_events').insert({
      game_id: gameId,
      team_id: teamId,
      player_id: playerId,
      clock_seconds: e.clockSeconds,
      event_type: e.type,
      points: e.points ?? null,
      sequence: e.sequence,
    });
    if (error) throw new Error(`insert game event: ${error.message}`);
  }
}

async function upsertTeam(supabase, name, leagueId) {
  const { data: existing, error: findErr } = await supabase
    .from('teams')
    .select('id')
    .eq('name', name)
    .eq('league_id', leagueId)
    .maybeSingle();
  if (findErr) throw new Error(`find team: ${findErr.message}`);
  if (existing) return existing.id;
  const { data: created, error: insertErr } = await supabase
    .from('teams')
    .insert({ league_id: leagueId, name })
    .select('id')
    .single();
  if (insertErr) throw new Error(`create team: ${insertErr.message}`);
  return created.id;
}

async function upsertPlayer(supabase, name, teamId) {
  const { data: existing, error: findErr } = await supabase
    .from('players')
    .select('id')
    .eq('name', name)
    .eq('team_id', teamId)
    .maybeSingle();
  if (findErr) throw new Error(`find player: ${findErr.message}`);
  if (existing) return existing.id;
  const { data: created, error: insertErr } = await supabase
    .from('players')
    .insert({ team_id: teamId, name })
    .select('id')
    .single();
  if (insertErr) throw new Error(`create player: ${insertErr.message}`);
  return created.id;
}

module.exports = { registerIpcHandlers };
