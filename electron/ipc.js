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
const aggregates = require('./services/aggregates');

/** Strips a nested-embed key (e.g. `leagues` from a `teams.select('*, leagues(name)')` row) after its fields have been flattened onto the result — keeps IPC payloads matching the plain-row shape the renderer already expects. */
function rowWithoutEmbed(row, embedKey) {
  const { [embedKey]: _embed, ...rest } = row;
  return rest;
}

function registerIpcHandlers(mainWindow) {
  ipcMain.handle('ocr:extract-box-score', async (_event, base64Image, mediaType) => {
    const supabase = getSupabaseClient();
    const imageHash = crypto.createHash('sha256').update(`${mediaType || ''}:${base64Image}`).digest('hex');
    const { data: cached, error: cacheErr } = await supabase
      .from('ocr_cache')
      .select('result_json')
      .eq('image_hash', imageHash)
      .maybeSingle();
    if (cacheErr) throw new Error(cacheErr.message);
    if (cached) {
      // Same photo bytes as a previous call — return the paid-for result
      // again instead of re-billing the Claude API for an identical image.
      // A cross-organization cache hit saves everyone the Claude API cost,
      // not just the original uploader (ocr_cache has no owner scoping).
      return cached.result_json;
    }

    const tier = await getTier();
    if (!tier.canUploadPhoto) {
      throw new Error('Photo upload (OCR) is included on the Photo plan. Upgrade from Account settings.');
    }
    const result = await extractBoxScore(base64Image, mediaType);
    const { error: insertErr } = await supabase.from('ocr_cache').insert({ image_hash: imageHash, result_json: result });
    if (insertErr) throw new Error(insertErr.message);
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

  ipcMain.handle('db:get-team-season-game-count', async (_event, teamId, seasonId) => {
    const supabase = getSupabaseClient();
    const { count, error } = await supabase
      .from('games')
      .select('id', { count: 'exact', head: true })
      .eq('season_id', seasonId)
      .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
    if (error) throw new Error(error.message);
    return count ?? 0;
  });

  /**
   * One workbook/PDF with every advanced metric, one sheet/page each, all
   * of the team's players ranked as of their Nth game that season — see
   * computeTeamAdvancedReport for the cutoff-filtering logic.
   */
  ipcMain.handle('export:team-advanced-report', async (_event, { format, teamId, seasonId, throughGame }) => {
    const report = await computeTeamAdvancedReport(getSupabaseClient(), teamId, seasonId, throughGame);
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
    const box = await fetchGameBoxScore(getSupabaseClient(), gameId);
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

  /** Shared by export:scouting-report-pdf and publish:scouting-report — fetches the editable keys/notes and per-team/player shot-location data a rendered report needs, given an already-computed report. */
  async function scoutingReportPdfInputs(supabase, report, ourTeamId, opponentTeamId, seasonId, gameDate) {
    const { data: existing, error: findErr } = await supabase
      .from('scouting_reports')
      .select('id, keys_to_game')
      .eq('our_team_id', ourTeamId)
      .eq('opponent_team_id', opponentTeamId)
      .eq('season_id', seasonId)
      .eq('game_date', gameDate)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    const keysToGame = existing?.keys_to_game ?? [];
    let playerNotes = [];
    if (existing) {
      const { data: notesRows, error: notesErr } = await supabase
        .from('scouting_report_player_notes')
        .select('player_id, notes')
        .eq('report_id', existing.id);
      if (notesErr) throw new Error(notesErr.message);
      playerNotes = (notesRows ?? []).map((r) => ({ playerId: r.player_id, notes: r.notes ?? [] }));
    }

    const { data: teamShots, error: teamShotsErr } = await supabase
      .from('shot_events')
      .select('x, y, made, value')
      .eq('team_id', report.opponentTeamId)
      .eq('season_id', report.seasonId);
    if (teamShotsErr) throw new Error(teamShotsErr.message);

    const playerShotsByPlayerId = new Map();
    await Promise.all(
      report.roster.map(async (p) => {
        const { data: shots, error } = await supabase
          .from('shot_events')
          .select('x, y, made, value')
          .eq('player_id', p.playerId)
          .eq('season_id', report.seasonId);
        if (error) throw new Error(error.message);
        playerShotsByPlayerId.set(p.playerId, shots ?? []);
      })
    );

    return { keysToGame, playerNotes, teamShots: teamShots ?? [], playerShotsByPlayerId };
  }

  ipcMain.handle('export:scouting-report-pdf', async (_event, { ourTeamId, opponentTeamId, seasonId, gameDate }) => {
    const supabase = getSupabaseClient();
    const report = await computeScoutingReport(supabase, ourTeamId, opponentTeamId, seasonId, gameDate);
    if (!report) return { saved: false };

    const suggestedBase = `${report.opponentTeamName}-scouting-report-${report.gameDate}`.replace(/[^\w .-]/g, '');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export scouting report',
      defaultPath: `${suggestedBase}.pdf`,
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { saved: false };

    const { keysToGame, playerNotes, teamShots, playerShotsByPlayerId } = await scoutingReportPdfInputs(
      supabase,
      report,
      ourTeamId,
      opponentTeamId,
      seasonId,
      gameDate
    );
    const buffer = await renderScoutingReportToPdf(report, keysToGame, playerNotes, teamShots, playerShotsByPlayerId);
    await fs.writeFile(filePath, buffer);
    return { saved: true, filePath };
  });

  /** Same PDF as export:scouting-report-pdf, but uploaded to the club's Storage + recorded as the current report instead of saved locally. */
  ipcMain.handle('publish:scouting-report', async (_event, { ourTeamId, opponentTeamId, seasonId, gameDate }) => {
    const supabase = getSupabaseClient();
    const report = await computeScoutingReport(supabase, ourTeamId, opponentTeamId, seasonId, gameDate);
    if (!report) return { published: false };

    const { keysToGame, playerNotes, teamShots, playerShotsByPlayerId } = await scoutingReportPdfInputs(
      supabase,
      report,
      ourTeamId,
      opponentTeamId,
      seasonId,
      gameDate
    );
    const buffer = await renderScoutingReportToPdf(report, keysToGame, playerNotes, teamShots, playerShotsByPlayerId);
    const published = await publishScoutingReport({ pdfBuffer: buffer, opponentName: report.opponentTeamName, gameDate: report.gameDate });
    return { published: true, ...published };
  });

  ipcMain.handle('cloud:get-current-published-report', () => getCurrentPublishedReport());
  ipcMain.handle('cloud:list-report-viewers', (_event, reportId) => listReportViewers(reportId));
  ipcMain.handle('cloud:list-players', () => listPlayers());
  ipcMain.handle('cloud:create-player-account', (_event, params) => createPlayerAccount(params));

  ipcMain.handle('db:get-team-four-factors-report', async (_event, teamId, seasonId) =>
    computeTeamFourFactorsReport(getSupabaseClient(), teamId, seasonId)
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

  ipcMain.handle('db:get-scouting-report', async (_event, ourTeamId, opponentTeamId, seasonId, gameDate) =>
    computeScoutingReport(getSupabaseClient(), ourTeamId, opponentTeamId, seasonId, gameDate)
  );

  /** Finds or creates the persisted (editable) row for one matchup — keys-to-game bullets live here, per-player notes/photos in scouting_report_player_notes. */
  ipcMain.handle('db:get-or-create-scouting-report-record', async (_event, { ourTeamId, opponentTeamId, seasonId, gameDate }) => {
    const supabase = getSupabaseClient();
    const { data: existing, error: findErr } = await supabase
      .from('scouting_reports')
      .select('*')
      .eq('our_team_id', ourTeamId)
      .eq('opponent_team_id', opponentTeamId)
      .eq('season_id', seasonId)
      .eq('game_date', gameDate)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (existing) return { ...existing, keysToGame: existing.keys_to_game ?? [] };

    const tier = await getTier();
    if (!tier.organizationId) {
      throw new Error('Your account needs to be assigned to a club before creating a scouting report — contact your administrator.');
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('You need to be logged in to create a scouting report.');

    const { data: created, error: insertErr } = await supabase
      .from('scouting_reports')
      .insert({
        our_team_id: ourTeamId,
        opponent_team_id: opponentTeamId,
        season_id: seasonId,
        game_date: gameDate,
        keys_to_game: [],
        owner_user_id: user.id,
        organization_id: tier.organizationId,
      })
      .select('*')
      .single();
    if (insertErr) throw new Error(insertErr.message);
    return { ...created, keysToGame: [] };
  });

  ipcMain.handle('db:save-scouting-report-keys', async (_event, reportId, keys) => {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('scouting_reports').update({ keys_to_game: keys }).eq('id', reportId);
    if (error) throw new Error(error.message);
    return { saved: true };
  });

  ipcMain.handle('db:get-scouting-report-player-notes', async (_event, reportId) => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('scouting_report_player_notes')
      .select('player_id, notes, photo_path')
      .eq('report_id', reportId);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({ playerId: r.player_id, notes: r.notes ?? [], photoPath: r.photo_path }));
  });

  ipcMain.handle('db:save-scouting-report-player-notes', async (_event, reportId, playerId, notes) => {
    const supabase = getSupabaseClient();
    const { data: existing, error: findErr } = await supabase
      .from('scouting_report_player_notes')
      .select('id')
      .eq('report_id', reportId)
      .eq('player_id', playerId)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (existing) {
      const { error } = await supabase.from('scouting_report_player_notes').update({ notes }).eq('id', existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from('scouting_report_player_notes').insert({ report_id: reportId, player_id: playerId, notes });
      if (error) throw new Error(error.message);
    }
    return { saved: true };
  });

  /** `photoDataUrl` is a data: URL from the renderer's file picker, or null to clear it — stored as-is despite the column's name. */
  ipcMain.handle('db:save-scouting-report-player-photo', async (_event, reportId, playerId, photoDataUrl) => {
    const supabase = getSupabaseClient();
    const { data: existing, error: findErr } = await supabase
      .from('scouting_report_player_notes')
      .select('id')
      .eq('report_id', reportId)
      .eq('player_id', playerId)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (existing) {
      const { error } = await supabase.from('scouting_report_player_notes').update({ photo_path: photoDataUrl }).eq('id', existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase
        .from('scouting_report_player_notes')
        .insert({ report_id: reportId, player_id: playerId, notes: [], photo_path: photoDataUrl });
      if (error) throw new Error(error.message);
    }
    return { saved: true };
  });

  /** The Draw screen's playbook — one row per saved play, `data` is a JSON blob of court frames. */
  ipcMain.handle('db:list-plays', async (_event, teamId) => {
    const supabase = getSupabaseClient();
    let query = supabase.from('plays').select('id, team_id, name, updated_at').order('updated_at', { ascending: false });
    if (teamId) query = query.eq('team_id', teamId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({ id: r.id, teamId: r.team_id, name: r.name, updatedAt: r.updated_at }));
  });

  ipcMain.handle('db:get-play', async (_event, playId) => {
    const supabase = getSupabaseClient();
    const { data: row, error } = await supabase
      .from('plays')
      .select('id, team_id, name, data, updated_at')
      .eq('id', playId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return null;
    return { id: row.id, teamId: row.team_id, name: row.name, data: row.data, updatedAt: row.updated_at };
  });

  ipcMain.handle('db:save-play', async (_event, { id, teamId, name, data }) => {
    const supabase = getSupabaseClient();
    if (id) {
      const { error } = await supabase.from('plays').update({ team_id: teamId ?? null, name, data }).eq('id', id);
      if (error) throw new Error(error.message);
      return { id };
    }
    const tier = await getTier();
    if (!tier.organizationId) {
      throw new Error('Your account needs to be assigned to a club before saving plays — contact your administrator.');
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('You need to be logged in to save a play.');
    const { data: created, error } = await supabase
      .from('plays')
      .insert({ team_id: teamId ?? null, name, data, owner_user_id: user.id, organization_id: tier.organizationId })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return { id: created.id };
  });

  ipcMain.handle('db:delete-play', async (_event, playId) => {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('plays').delete().eq('id', playId);
    if (error) throw new Error(error.message);
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

  ipcMain.handle('db:get-game-box-score', async (_event, gameId) => fetchGameBoxScore(getSupabaseClient(), gameId));

  ipcMain.handle('db:list-games', async () => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('games')
      .select(
        `id, date,
         home_team:teams!games_home_team_id_fkey(name),
         away_team:teams!games_away_team_id_fkey(name),
         season:seasons(year, league:leagues(name))`
      )
      .order('date', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((g) => ({
      gameId: g.id,
      date: g.date,
      homeTeamName: g.home_team?.name ?? null,
      awayTeamName: g.away_team?.name ?? null,
      leagueName: g.season?.league?.name ?? null,
      seasonYear: g.season?.year ?? null,
    }));
  });

  ipcMain.handle('db:get-game-insights', async (_event, gameId) => buildGameInsights(getSupabaseClient(), gameId));

  ipcMain.handle('db:get-player-stats', async (_event, playerId, seasonId) =>
    computePlayerSummary(getSupabaseClient(), playerId, seasonId)
  );

  ipcMain.handle('db:get-team-stats', async (_event, teamId, seasonId) =>
    computeTeamSummary(getSupabaseClient(), teamId, seasonId)
  );

  ipcMain.handle('db:get-team-scouting-report', async (_event, teamId) => buildTeamScoutingReport(getSupabaseClient(), teamId));

  ipcMain.handle('db:get-player-scouting-report', async (_event, playerId) => buildPlayerScoutingReport(getSupabaseClient(), playerId));

  ipcMain.handle('db:get-team-scouting-report-all-competitions', async (_event, teamName) =>
    buildTeamScoutingReportAllCompetitions(getSupabaseClient(), teamName)
  );

  ipcMain.handle('db:get-player-scouting-report-all-competitions', async (_event, playerName, teamName) =>
    buildPlayerScoutingReportAllCompetitions(getSupabaseClient(), playerName, teamName)
  );

  ipcMain.handle('db:get-league-averages', async (_event, leagueId, seasonId) => {
    const rows = await aggregates.leagueSeasonRows(getSupabaseClient(), leagueId, seasonId);
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
  ipcMain.handle('db:get-league-player-averages', async (_event, leagueId, seasonId) => {
    const rows = await aggregates.leagueSeasonRows(getSupabaseClient(), leagueId, seasonId);
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

  ipcMain.handle('db:get-team-all-competitions', async (_event, teamId) => {
    const supabase = getSupabaseClient();
    const { data: team, error: teamErr } = await supabase.from('teams').select('name').eq('id', teamId).maybeSingle();
    if (teamErr) throw new Error(teamErr.message);
    if (!team) return null;

    const { data: siblingRows, error: siblingErr } = await supabase
      .from('teams')
      .select('id, league_id, leagues(name)')
      .eq('name', team.name);
    if (siblingErr) throw new Error(siblingErr.message);

    const siblings = await Promise.all(
      (siblingRows ?? []).map(async (s) => {
        const [agg, oppAgg] = await Promise.all([
          aggregates.teamAggregate(supabase, s.id),
          aggregates.opponentAggregate(supabase, s.id),
        ]);
        return { id: s.id, league_id: s.league_id, league_name: s.leagues?.name ?? null, agg, oppAgg };
      })
    );

    const perLeague = await Promise.all(
      siblings.map(async (s) => ({
        leagueId: s.league_id,
        leagueName: s.league_name,
        ...buildStatSummary({
          rows: s.agg.rows,
          games: s.agg.games,
          isTeam: true,
          teamAgg: s.agg,
          oppAgg: s.oppAgg,
          leagueAgg: await aggregates.leagueAggregate(supabase, s.league_id),
        }),
      }))
    );

    const allRows = siblings.flatMap((s) => s.agg.rows);
    const combined = buildCombinedSummary(allRows, new Set(allRows.map((r) => r.game_id)).size);

    return { combined, perLeague };
  });

  ipcMain.handle('db:get-player-all-competitions', async (_event, playerId) => {
    const supabase = getSupabaseClient();
    const { data: player, error: playerErr } = await supabase
      .from('players')
      .select('name, team:teams(name)')
      .eq('id', playerId)
      .maybeSingle();
    if (playerErr) throw new Error(playerErr.message);
    if (!player) return null;

    const { data: siblingTeams, error: teamsErr } = await supabase.from('teams').select('id, league_id, leagues(name)').eq('name', player.team?.name ?? '');
    if (teamsErr) throw new Error(teamsErr.message);
    const teamById = new Map((siblingTeams ?? []).map((t) => [t.id, t]));

    const { data: siblingPlayers, error: siblingErr } = await supabase
      .from('players')
      .select('id, team_id')
      .eq('name', player.name)
      .in('team_id', [...teamById.keys()]);
    if (siblingErr) throw new Error(siblingErr.message);

    const siblings = await Promise.all(
      (siblingPlayers ?? []).map(async (s) => {
        const { data: rows, error: rowsErr } = await supabase.from('box_scores').select(aggregates.BOX_SCORE_COLUMNS).eq('player_id', s.id);
        if (rowsErr) throw new Error(rowsErr.message);
        const team = teamById.get(s.team_id);
        return { id: s.id, team_id: s.team_id, league_id: team.league_id, league_name: team.leagues?.name ?? null, rows: rows ?? [], games: (rows ?? []).length };
      })
    );

    const perLeague = await Promise.all(
      siblings.map(async (s) => {
        const [teamAgg, oppAgg, leagueAgg] = await Promise.all([
          aggregates.teamAggregate(supabase, s.team_id),
          aggregates.opponentAggregate(supabase, s.team_id),
          aggregates.leagueAggregate(supabase, s.league_id),
        ]);
        return {
          leagueId: s.league_id,
          leagueName: s.league_name,
          ...buildStatSummary({ rows: s.rows, games: s.games, isTeam: false, teamAgg, oppAgg, leagueAgg }),
        };
      })
    );

    const allRows = siblings.flatMap((s) => s.rows);
    const combined = buildCombinedSummary(allRows, allRows.length);

    return { combined, perLeague };
  });

  ipcMain.handle('db:get-league-team-rankings', async (_event, leagueId, seasonId) => {
    const supabase = getSupabaseClient();
    const rows = await aggregates.leagueSeasonRows(supabase, leagueId, seasonId);

    const byTeam = new Map();
    for (const row of rows) {
      if (!byTeam.has(row.team_id)) {
        byTeam.set(row.team_id, { teamName: row.team_name, rows: [], gameIds: new Set() });
      }
      const entry = byTeam.get(row.team_id);
      entry.rows.push(row);
      entry.gameIds.add(row.game_id);
    }

    const leagueAgg = await aggregates.leagueAggregate(supabase, leagueId);

    return Promise.all(
      [...byTeam.entries()].map(async ([teamId, entry]) => {
        const teamAgg = { rows: entry.rows, totals: sumRows(entry.rows), games: entry.gameIds.size };
        const oppAgg = await aggregates.opponentAggregate(supabase, teamId);
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
      })
    );
  });

  ipcMain.handle('db:get-league-player-leaderboard', async (_event, leagueId, seasonId) => {
    const supabase = getSupabaseClient();
    const rows = await aggregates.leagueSeasonRows(supabase, leagueId, seasonId);

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

    const leagueAgg = await aggregates.leagueAggregate(supabase, leagueId);
    const teamAggCache = new Map();
    const oppAggCache = new Map();
    const uniqueTeamIds = [...new Set([...byPlayer.values()].map((e) => e.teamId))];
    await Promise.all(
      uniqueTeamIds.map(async (teamId) => {
        const [teamAgg, oppAgg] = await Promise.all([
          aggregates.teamAggregate(supabase, teamId),
          aggregates.opponentAggregate(supabase, teamId),
        ]);
        teamAggCache.set(teamId, teamAgg);
        oppAggCache.set(teamId, oppAgg);
      })
    );

    return Promise.all(
      [...byPlayer.entries()].map(async ([playerId, entry]) => ({
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
          hasPlayByPlayData: await playerHasPlayByPlayData(supabase, playerId),
        }),
      }))
    );
  });

  ipcMain.handle('db:get-league-impact-ratings', async (_event, leagueId, seasonId) =>
    computeLeagueImpactRatings(getSupabaseClient(), leagueId, seasonId)
  );

  ipcMain.handle('db:get-league-standings-history', async (_event, leagueId, seasonId) =>
    computeLeagueStandingsHistory(getSupabaseClient(), leagueId, seasonId)
  );

  ipcMain.handle('db:get-game-win-probability', async (_event, gameId) => computeGameWinProbability(getSupabaseClient(), gameId));

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
  ipcMain.handle('db:import-shot-zones', async (_event, { teamId, seasonId, rows }) => {
    const supabase = getSupabaseClient();
    const tier = await getTier();
    if (!tier.organizationId) {
      throw new Error('Your account needs to be assigned to a club before importing shot data — contact your administrator.');
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('You need to be logged in to import shot data.');

    const { data: teamPlayers, error: playersErr } = await supabase.from('players').select('id').eq('team_id', teamId);
    if (playersErr) throw new Error(playersErr.message);
    const teamPlayerIds = new Set((teamPlayers ?? []).map((p) => p.id));

    const { error: delErr } = await supabase
      .from('shot_zones')
      .delete()
      .eq('team_id', teamId)
      .eq('season_id', seasonId)
      .or(`player_id.is.null,player_id.in.(${[...teamPlayerIds].join(',') || '0'})`);
    if (delErr) throw new Error(delErr.message);

    const insertRows = rows
      .map((r) => ({ isPlayer: r.isPlayer, playerId: r.isPlayer ? r.subjectId : null, zone: r.zone, fgm: r.fgm, fga: r.fga }))
      .filter((r) => !r.isPlayer || teamPlayerIds.has(r.playerId))
      .map((r) => ({
        team_id: teamId,
        player_id: r.playerId,
        season_id: seasonId,
        zone: r.zone,
        fgm: r.fgm,
        fga: r.fga,
        owner_user_id: user.id,
        organization_id: tier.organizationId,
      }));
    if (insertRows.length > 0) {
      const { error: insertErr } = await supabase.from('shot_zones').insert(insertRows);
      if (insertErr) throw new Error(insertErr.message);
    }
    return { saved: true };
  });

  /**
   * Team's season zone totals. Two sources, both counted, never double-counted:
   * (a) team-only rows (player_id IS NULL) — how the old bulk "import a whole
   *     season at once" flow always wrote a team's totals, as one independent
   *     measurement (not meant to be added to any per-player rows from that
   *     same bulk import, which sat alongside it un-summed);
   * (b) player-level rows that DO carry a game_id — only ever written by the
   *     new per-game manual entry screen, where the team total is explicitly
   *     meant to be built up as the sum of whichever players got entered for
   *     each game. Old bulk-imported player rows have no game_id and are
   *     deliberately excluded here so they're never added on top of (a).
   */
  ipcMain.handle('db:get-team-shot-zones', async (_event, teamId, seasonId) => {
    const supabase = getSupabaseClient();
    const [teamOnly, gameScopedPlayerRows] = await Promise.all([
      supabase.from('shot_zones').select('zone, fgm, fga').eq('team_id', teamId).eq('season_id', seasonId).is('player_id', null),
      supabase.from('shot_zones').select('zone, fgm, fga').eq('team_id', teamId).eq('season_id', seasonId).not('player_id', 'is', null).not('game_id', 'is', null),
    ]);
    if (teamOnly.error) throw new Error(teamOnly.error.message);
    if (gameScopedPlayerRows.error) throw new Error(gameScopedPlayerRows.error.message);
    const rows = [...(teamOnly.data ?? []), ...(gameScopedPlayerRows.data ?? [])];
    return { hasData: rows.length > 0, chart: buildZoneChart(rows) };
  });

  ipcMain.handle('db:get-player-shot-zones', async (_event, playerId, seasonId) => {
    const supabase = getSupabaseClient();
    const { data: rows, error } = await supabase
      .from('shot_zones')
      .select('zone, fgm, fga')
      .eq('player_id', playerId)
      .eq('season_id', seasonId);
    if (error) throw new Error(error.message);
    return { hasData: (rows ?? []).length > 0, chart: buildZoneChart(rows ?? []) };
  });

  /**
   * One click-a-zone entry from the manual Shot Chart screen: makes/attempts
   * for one team (or one specific player on that team) from one zone, in one
   * specific match between two named teams. Resolves the match to a real
   * `games` row by natural key (season + date + the two teams, in either
   * home/away order) — reusing whatever row already exists (e.g. one a box
   * score was already saved against) rather than creating a duplicate.
   */
  ipcMain.handle(
    'db:save-shot-zone-entry',
    async (_event, { teamAId, teamBId, seasonId, gameDate, forTeamId, playerId, zone, fgm, fga }) => {
      const tier = await getTier();
      if (!tier.organizationId) {
        throw new Error('Your account needs to be assigned to a club before saving shot data — contact your administrator.');
      }
      const supabase = getSupabaseClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('You need to be logged in to save shot data.');

      const { data: existingGame, error: findErr } = await supabase
        .from('games')
        .select('id')
        .eq('season_id', seasonId)
        .eq('date', gameDate)
        .or(`and(home_team_id.eq.${teamAId},away_team_id.eq.${teamBId}),and(home_team_id.eq.${teamBId},away_team_id.eq.${teamAId})`)
        .maybeSingle();
      if (findErr) throw new Error(findErr.message);

      let gameId = existingGame?.id;
      if (!gameId) {
        const { data: createdGame, error: createErr } = await supabase
          .from('games')
          .insert({
            season_id: seasonId,
            date: gameDate,
            home_team_id: teamAId,
            away_team_id: teamBId,
            source: 'manual',
            owner_user_id: user.id,
            organization_id: tier.organizationId,
          })
          .select('id')
          .single();
        if (createErr) throw new Error(createErr.message);
        gameId = createdGame.id;
      }

      const { data: created, error: insertErr } = await supabase
        .from('shot_zones')
        .insert({
          team_id: forTeamId,
          player_id: playerId ?? null,
          season_id: seasonId,
          game_id: gameId,
          zone,
          fgm,
          fga,
          owner_user_id: user.id,
          organization_id: tier.organizationId,
        })
        .select('id')
        .single();
      if (insertErr) throw new Error(insertErr.message);

      return { id: created.id, gameId };
    }
  );

  /** Looks up (without creating) the game a matchup already resolves to, so revisiting an in-progress match can load its existing entries. Null if that exact matchup/date has never been saved. */
  ipcMain.handle('db:find-game-by-matchup', async (_event, { teamAId, teamBId, seasonId, gameDate }) => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('games')
      .select('id')
      .eq('season_id', seasonId)
      .eq('date', gameDate)
      .or(`and(home_team_id.eq.${teamAId},away_team_id.eq.${teamBId}),and(home_team_id.eq.${teamBId},away_team_id.eq.${teamAId})`)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data?.id ?? null;
  });

  ipcMain.handle('db:list-shot-zone-entries-for-game', async (_event, gameId) => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('shot_zones')
      .select('id, team_id, player_id, zone, fgm, fga, team:teams(name), player:players(name)')
      .eq('game_id', gameId)
      .order('id', { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      id: r.id,
      teamId: r.team_id,
      teamName: r.team?.name ?? null,
      playerId: r.player_id,
      playerName: r.player?.name ?? null,
      zone: r.zone,
      fgm: r.fgm,
      fga: r.fga,
    }));
  });

  ipcMain.handle('db:delete-shot-zone-entry', async (_event, id) => {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('shot_zones').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return { deleted: true };
  });

  /** Individual shot locations for a real dot-scatter chart — {x,y,made,value}[], already in the app's 0-300x0-320 half-court coordinate space. */
  ipcMain.handle('db:get-team-shot-events', async (_event, teamId, seasonId) => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('shot_events').select('x, y, made, value').eq('team_id', teamId).eq('season_id', seasonId);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
  ipcMain.handle('db:get-player-shot-events', async (_event, playerId, seasonId) => {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('shot_events').select('x, y, made, value').eq('player_id', playerId).eq('season_id', seasonId);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

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

  /** Every box-score row for a player, tagged with the game date + opponent name — the raw material for the per-game log/trend charts below. */
  async function playerGameLogRows(supabase, playerId, seasonId) {
    const { data: player, error: playerErr } = await supabase.from('players').select('team_id').eq('id', playerId).maybeSingle();
    if (playerErr) throw new Error(playerErr.message);
    if (!player) return [];

    let gamesQuery = supabase
      .from('games')
      .select('id, date, home_team_id, away_team_id, home_team:teams!games_home_team_id_fkey(name), away_team:teams!games_away_team_id_fkey(name)')
      .order('date', { ascending: true });
    if (seasonId) gamesQuery = gamesQuery.eq('season_id', seasonId);
    const { data: games, error: gamesErr } = await gamesQuery;
    if (gamesErr) throw new Error(gamesErr.message);

    const { data: boxRows, error: bsErr } = await supabase
      .from('box_scores')
      .select(aggregates.BOX_SCORE_COLUMNS)
      .eq('player_id', playerId);
    if (bsErr) throw new Error(bsErr.message);

    const gameById = new Map((games ?? []).map((g) => [g.id, g]));
    return (boxRows ?? [])
      .filter((bs) => gameById.has(bs.game_id))
      .map((bs) => {
        const g = gameById.get(bs.game_id);
        const opponent = g.home_team_id === player.team_id ? g.away_team?.name ?? null : g.home_team?.name ?? null;
        return { ...bs, date: g.date, opponent };
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  ipcMain.handle('db:get-player-game-log', async (_event, playerId, seasonId) =>
    playerGameLogRows(getSupabaseClient(), playerId, seasonId)
  );

  ipcMain.handle('db:get-player-pie-log', async (_event, playerId, seasonId) => {
    const supabase = getSupabaseClient();
    const { data: player, error: playerErr } = await supabase.from('players').select('team_id').eq('id', playerId).maybeSingle();
    if (playerErr) throw new Error(playerErr.message);
    if (!player) return [];

    const rows = await playerGameLogRows(supabase, playerId, seasonId);
    if (rows.length === 0) return [];

    const gameIds = [...new Set(rows.map((r) => r.game_id))];
    const { data: games, error: gamesErr } = await supabase.from('games').select('id, home_team_id, away_team_id').in('id', gameIds);
    if (gamesErr) throw new Error(gamesErr.message);
    const gameById = new Map((games ?? []).map((g) => [g.id, g]));

    // One bulk fetch for every box-score row across every one of this
    // player's games (tagged with each row's own team_id via the players
    // embed), instead of 2 extra round-trips per game — the earlier version
    // re-fetched "which players are on my team" on every single iteration,
    // which would turn a full season's PIE log into 100+ sequential queries.
    const { data: allBox, error: allBoxErr } = await supabase
      .from('box_scores')
      .select(`${aggregates.BOX_SCORE_COLUMNS}, player:players(team_id)`)
      .in('game_id', gameIds);
    if (allBoxErr) throw new Error(allBoxErr.message);
    const rowsByGame = new Map();
    for (const r of allBox ?? []) {
      if (!rowsByGame.has(r.game_id)) rowsByGame.set(r.game_id, []);
      rowsByGame.get(r.game_id).push({ ...r, team_id: r.player?.team_id ?? null });
    }

    return rows.map((r) => {
      const g = gameById.get(r.game_id);
      const oppTeamId = g.home_team_id === player.team_id ? g.away_team_id : g.home_team_id;
      const gameRows = rowsByGame.get(r.game_id) ?? [];
      const teamTotals = sumRows(gameRows.filter((row) => row.team_id === player.team_id));
      const oppTotals = sumRows(gameRows.filter((row) => row.team_id === oppTeamId));
      return {
        game_id: r.game_id,
        date: r.date,
        opponent: r.opponent,
        pie: computePIE(r, teamTotals, oppTotals),
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
  ipcMain.handle('db:get-player-per-log', async (_event, playerId, seasonId) => {
    const supabase = getSupabaseClient();
    const { data: player, error: playerErr } = await supabase.from('players').select('team_id').eq('id', playerId).maybeSingle();
    if (playerErr) throw new Error(playerErr.message);
    if (!player) return [];
    const { data: team, error: teamErr } = await supabase.from('teams').select('league_id').eq('id', player.team_id).maybeSingle();
    if (teamErr) throw new Error(teamErr.message);
    const teamAgg = await aggregates.teamAggregate(supabase, player.team_id, seasonId);
    const leagueAgg = seasonId
      ? await aggregates.leagueAggregateForSeason(supabase, team.league_id, seasonId)
      : await aggregates.leagueAggregate(supabase, team.league_id);

    const rows = await playerGameLogRows(supabase, playerId, seasonId);
    return rows.map((g) => ({
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

  ipcMain.handle('db:get-player-season-history', async (_event, playerId) => computePlayerSeasonHistory(getSupabaseClient(), playerId));
  ipcMain.handle('db:get-team-season-history', async (_event, teamId) => computeTeamSeasonHistory(getSupabaseClient(), teamId));

  /**
   * Every game a player has data for, across every league/cup they appear
   * in — a player has a separate player_id per (name, team-name) sibling row
   * today (same as teams), so this reuses db:get-player-all-competitions'
   * sibling-matching query, flattened into one date-sorted list instead of
   * that handler's per-league summary shape.
   */
  ipcMain.handle('db:get-player-games-all-competitions', async (_event, playerId) => {
    const supabase = getSupabaseClient();
    const { data: player, error: playerErr } = await supabase
      .from('players')
      .select('name, team_id, team:teams(name)')
      .eq('id', playerId)
      .maybeSingle();
    if (playerErr) throw new Error(playerErr.message);
    if (!player) return [];

    const { data: siblingTeams, error: teamsErr } = await supabase.from('teams').select('id').eq('name', player.team?.name ?? '');
    if (teamsErr) throw new Error(teamsErr.message);
    const siblingTeamIds = (siblingTeams ?? []).map((t) => t.id);
    if (siblingTeamIds.length === 0) return [];

    const { data: siblings, error: siblingErr } = await supabase
      .from('players')
      .select('id, team_id')
      .eq('name', player.name)
      .in('team_id', siblingTeamIds);
    if (siblingErr) throw new Error(siblingErr.message);
    const teamIdByPlayerId = new Map((siblings ?? []).map((p) => [p.id, p.team_id]));
    const siblingIds = [...teamIdByPlayerId.keys()];
    if (siblingIds.length === 0) return [];

    const { data: boxRows, error: bsErr } = await supabase
      .from('box_scores')
      .select('pts, oreb, dreb, ast, player_id, game_id')
      .in('player_id', siblingIds);
    if (bsErr) throw new Error(bsErr.message);

    const gameIds = [...new Set((boxRows ?? []).map((r) => r.game_id))];
    if (gameIds.length === 0) return [];
    const { data: games, error: gamesErr } = await supabase
      .from('games')
      .select(
        `id, date, home_team_id, away_team_id,
         home_team:teams!games_home_team_id_fkey(name),
         away_team:teams!games_away_team_id_fkey(name),
         season:seasons(league:leagues(name))`
      )
      .in('id', gameIds);
    if (gamesErr) throw new Error(gamesErr.message);
    const gameById = new Map((games ?? []).map((g) => [g.id, g]));

    return (boxRows ?? [])
      .map((r) => {
        const g = gameById.get(r.game_id);
        if (!g) return null;
        const teamId = teamIdByPlayerId.get(r.player_id);
        const opponent = g.home_team_id === teamId ? g.away_team?.name ?? null : g.home_team?.name ?? null;
        return {
          game_id: r.game_id,
          date: g.date,
          leagueName: g.season?.league?.name ?? null,
          opponent,
          pts: r.pts,
          reb: r.oreb + r.dreb,
          ast: r.ast,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  });

  /**
   * Every game a team has data for, across every league/cup it appears in —
   * reuses db:get-team-all-competitions' sibling-matching query (teams
   * sharing the same name), flattened into one date-sorted W/L list.
   */
  ipcMain.handle('db:get-team-games-all-competitions', async (_event, teamId) => {
    const supabase = getSupabaseClient();
    const { data: team, error: teamErr } = await supabase.from('teams').select('name').eq('id', teamId).maybeSingle();
    if (teamErr) throw new Error(teamErr.message);
    if (!team) return [];

    const { data: siblings, error: siblingErr } = await supabase.from('teams').select('id').eq('name', team.name);
    if (siblingErr) throw new Error(siblingErr.message);
    const siblingIds = (siblings ?? []).map((t) => t.id);
    if (siblingIds.length === 0) return [];

    const { data: games, error: gamesErr } = await supabase
      .from('games')
      .select(
        `id, date, home_team_id, away_team_id,
         home_team:teams!games_home_team_id_fkey(name),
         away_team:teams!games_away_team_id_fkey(name),
         season:seasons(league:leagues(name))`
      )
      .or(siblingIds.map((tid) => `home_team_id.eq.${tid},away_team_id.eq.${tid}`).join(','));
    if (gamesErr) throw new Error(gamesErr.message);
    const relevant = (games ?? []).filter((g) => siblingIds.includes(g.home_team_id) || siblingIds.includes(g.away_team_id));
    if (relevant.length === 0) return [];

    const gameIds = relevant.map((g) => g.id);
    const { data: boxRows, error: bsErr } = await supabase
      .from('box_scores')
      .select(`${aggregates.BOX_SCORE_COLUMNS}, player:players(team_id)`)
      .in('game_id', gameIds);
    if (bsErr) throw new Error(bsErr.message);

    const rowsByGame = new Map();
    for (const r of boxRows ?? []) {
      if (!rowsByGame.has(r.game_id)) rowsByGame.set(r.game_id, []);
      rowsByGame.get(r.game_id).push({ ...r, team_id: r.player?.team_id ?? null });
    }

    const rows = relevant.map((g) => {
      const tid = siblingIds.includes(g.home_team_id) ? g.home_team_id : g.away_team_id;
      const oppTeamId = g.home_team_id === tid ? g.away_team_id : g.home_team_id;
      const gameRows = rowsByGame.get(g.id) ?? [];
      const teamTotals = sumRows(gameRows.filter((r) => r.team_id === tid));
      const oppTotals = sumRows(gameRows.filter((r) => r.team_id === oppTeamId));
      const opponent = g.home_team_id === tid ? g.away_team?.name ?? null : g.home_team?.name ?? null;
      return {
        game_id: g.id,
        date: g.date,
        leagueName: g.season?.league?.name ?? null,
        opponent,
        teamPts: teamTotals.pts ?? 0,
        oppPts: oppTotals.pts ?? 0,
        won: (teamTotals.pts ?? 0) > (oppTotals.pts ?? 0),
      };
    });

    return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  });

  /** Every game a team played (optionally season-scoped), summed to one row per game — the raw material for the team game-log/trend charts. */
  async function teamGameLogRows(supabase, teamId, seasonId) {
    const { data: team, error: teamErr } = await supabase.from('teams').select('id').eq('id', teamId).maybeSingle();
    if (teamErr) throw new Error(teamErr.message);
    if (!team) return [];

    let gamesQuery = supabase
      .from('games')
      .select(
        `id, date, home_team_id, away_team_id,
         home_team:teams!games_home_team_id_fkey(name),
         away_team:teams!games_away_team_id_fkey(name)`
      )
      .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
      .order('date', { ascending: true });
    if (seasonId) gamesQuery = gamesQuery.eq('season_id', seasonId);
    const { data: games, error: gamesErr } = await gamesQuery;
    if (gamesErr) throw new Error(gamesErr.message);
    if (!games || games.length === 0) return [];

    const gameIds = games.map((g) => g.id);
    const playerIds = await aggregates.playerIdsForTeam(supabase, teamId);
    const boxRows = await aggregates.boxScoresByPlayerIds(supabase, playerIds, gameIds);
    const rowsByGame = new Map();
    for (const r of boxRows) {
      if (!rowsByGame.has(r.game_id)) rowsByGame.set(r.game_id, []);
      rowsByGame.get(r.game_id).push(r);
    }

    return games.map((g) => {
      const opponent = g.home_team_id === teamId ? g.away_team?.name ?? null : g.home_team?.name ?? null;
      const summed = sumRows(rowsByGame.get(g.id) ?? []);
      return { game_id: g.id, date: g.date, opponent, ...summed };
    });
  }

  ipcMain.handle('db:get-team-game-log', async (_event, teamId, seasonId) => teamGameLogRows(getSupabaseClient(), teamId, seasonId));

  /** PER per game for a team — same "one game through the season's rate constants" approach as db:get-player-per-log. */
  ipcMain.handle('db:get-team-per-log', async (_event, teamId, seasonId) => {
    const supabase = getSupabaseClient();
    const { data: team, error: teamErr } = await supabase.from('teams').select('league_id').eq('id', teamId).maybeSingle();
    if (teamErr) throw new Error(teamErr.message);
    if (!team) return [];
    const teamAgg = await aggregates.teamAggregate(supabase, teamId, seasonId);
    const leagueAgg = seasonId
      ? await aggregates.leagueAggregateForSeason(supabase, team.league_id, seasonId)
      : await aggregates.leagueAggregate(supabase, team.league_id);

    const games = await teamGameLogRows(supabase, teamId, seasonId);
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

async function fetchGameBoxScore(supabase, gameId) {
  const { data: game, error } = await supabase
    .from('games')
    .select(
      `id, date, home_team_id, away_team_id,
       home_team:teams!games_home_team_id_fkey(name),
       away_team:teams!games_away_team_id_fkey(name),
       season:seasons(year, league:leagues(name))`
    )
    .eq('id', gameId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!game) return null;

  const rosterFor = async (teamId) => {
    const playerIds = await aggregates.playerIdsForTeam(supabase, teamId);
    if (playerIds.length === 0) return [];
    const { data, error: bsErr } = await supabase
      .from('box_scores')
      .select(`${aggregates.BOX_SCORE_COLUMNS}, player:players(name)`)
      .eq('game_id', gameId)
      .in('player_id', playerIds)
      .order('pts', { ascending: false });
    if (bsErr) throw new Error(bsErr.message);
    return (data ?? []).map((r) => ({ ...rowWithoutEmbed(r, 'player'), name: r.player?.name ?? '' }));
  };

  const [homeRoster, awayRoster] = await Promise.all([rosterFor(game.home_team_id), rosterFor(game.away_team_id)]);

  return {
    gameId: game.id,
    date: game.date,
    leagueName: game.season?.league?.name ?? null,
    seasonYear: game.season?.year ?? null,
    homeTeamId: game.home_team_id,
    awayTeamId: game.away_team_id,
    homeTeamName: game.home_team?.name ?? null,
    awayTeamName: game.away_team?.name ?? null,
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
async function buildGameInsights(supabase, gameId) {
  const box = await fetchGameBoxScore(supabase, gameId);
  if (!box) return null;

  const teamSeasonAvg = async (teamId) => {
    const playerIds = await aggregates.playerIdsForTeam(supabase, teamId);
    const rows = playerIds.length ? await aggregates.boxScoresByPlayerIds(supabase, playerIds, null) : [];
    const rowsExcludingThisGame = rows.filter((r) => r.game_id !== gameId);
    const gamesPlayed = new Set(rowsExcludingThisGame.map((r) => r.game_id)).size;
    return { perGame: perGame(sumRows(rowsExcludingThisGame), gamesPlayed || 1), games: gamesPlayed };
  };

  const playerSeasonAvg = async (playerId) => {
    const { data: allRows, error } = await supabase.from('box_scores').select(aggregates.BOX_SCORE_COLUMNS).eq('player_id', playerId);
    if (error) throw new Error(error.message);
    const rows = (allRows ?? []).filter((r) => r.game_id !== gameId);
    return {
      perGame: perGame(sumRows(rows), rows.length || 1),
      games: rows.length,
      seasonHighPts: (allRows ?? []).length > 1 ? Math.max(...allRows.map((r) => r.pts)) : null,
      seasonHighReb: (allRows ?? []).length > 1 ? Math.max(...allRows.map((r) => r.oreb + r.dreb)) : null,
    };
  };

  const [homeTeamAvg, awayTeamAvg] = await Promise.all([teamSeasonAvg(box.homeTeamId), teamSeasonAvg(box.awayTeamId)]);

  const homePts = box.homeTotals.pts ?? 0;
  const awayPts = box.awayTotals.pts ?? 0;
  const winner = homePts === awayPts ? 'tie' : homePts > awayPts ? 'home' : 'away';

  const homePlayerInsights = await Promise.all(
    box.homeRoster.map(async (row) => buildPlayerInsights('home', row, await playerSeasonAvg(row.player_id)))
  );
  const awayPlayerInsights = await Promise.all(
    box.awayRoster.map(async (row) => buildPlayerInsights('away', row, await playerSeasonAvg(row.player_id)))
  );

  const insights = [
    ...buildTeamInsights('home', box.homeTeamName, box.homeTotals, homeTeamAvg, awayPts, awayTeamAvg),
    ...buildTeamInsights('away', box.awayTeamName, box.awayTotals, awayTeamAvg, homePts, homeTeamAvg),
    ...homePlayerInsights.flat(),
    ...awayPlayerInsights.flat(),
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
async function playerHasPlayByPlayData(supabase, playerId, seasonId) {
  const { data: boxRows, error } = await supabase.from('box_scores').select('game_id').eq('player_id', playerId);
  if (error) throw new Error(error.message);
  const gameIds = [...new Set((boxRows ?? []).map((r) => r.game_id))];
  if (gameIds.length === 0) return false;

  let gamesQuery = supabase.from('games').select('id').in('id', gameIds);
  if (seasonId) gamesQuery = gamesQuery.eq('season_id', seasonId);
  const { data: games, error: gamesErr } = await gamesQuery;
  if (gamesErr) throw new Error(gamesErr.message);
  const scopedGameIds = (games ?? []).map((g) => g.id);
  if (scopedGameIds.length === 0) return false;

  const { data: events, error: eventsErr } = await supabase.from('game_events').select('id').in('game_id', scopedGameIds).limit(1);
  if (eventsErr) throw new Error(eventsErr.message);
  return (events ?? []).length > 0;
}

async function computePlayerSummary(supabase, playerId, seasonId) {
  const { data: allRows, error: rowsErr } = await supabase.from('box_scores').select(aggregates.BOX_SCORE_COLUMNS).eq('player_id', playerId);
  if (rowsErr) throw new Error(rowsErr.message);

  const { data: player, error: playerErr } = await supabase.from('players').select('team_id').eq('id', playerId).maybeSingle();
  if (playerErr) throw new Error(playerErr.message);
  const { data: team, error: teamErr } = await supabase.from('teams').select('league_id').eq('id', player.team_id).maybeSingle();
  if (teamErr) throw new Error(teamErr.message);

  let rows = allRows ?? [];
  if (seasonId) {
    const gameIds = new Set(await aggregates.gameIdsForSeason(supabase, seasonId));
    rows = rows.filter((r) => gameIds.has(r.game_id));
  }

  const [teamAgg, oppAgg, leagueAgg, hasPlayByPlayData] = await Promise.all([
    aggregates.teamAggregate(supabase, player.team_id, seasonId),
    aggregates.opponentAggregate(supabase, player.team_id, seasonId),
    seasonId ? aggregates.leagueAggregateForSeason(supabase, team.league_id, seasonId) : aggregates.leagueAggregate(supabase, team.league_id),
    playerHasPlayByPlayData(supabase, playerId, seasonId),
  ]);
  return buildStatSummary({
    rows,
    games: rows.length,
    isTeam: false,
    teamAgg,
    oppAgg,
    leagueAgg,
    hasPlayByPlayData,
  });
}

async function computeTeamSummary(supabase, teamId, seasonId) {
  const { data: team, error: teamErr } = await supabase.from('teams').select('league_id').eq('id', teamId).maybeSingle();
  if (teamErr) throw new Error(teamErr.message);
  const [teamAgg, oppAgg, leagueAgg] = await Promise.all([
    aggregates.teamAggregate(supabase, teamId, seasonId),
    aggregates.opponentAggregate(supabase, teamId, seasonId),
    seasonId ? aggregates.leagueAggregateForSeason(supabase, team.league_id, seasonId) : aggregates.leagueAggregate(supabase, team.league_id),
  ]);
  return buildStatSummary({ rows: teamAgg.rows, games: teamAgg.games, isTeam: true, teamAgg, oppAgg, leagueAgg });
}

/** Every season this player has box-score rows in, oldest first — the raw material for the Dashboard's "History" tab. */
async function computePlayerSeasonHistory(supabase, playerId) {
  const { data: boxRows, error } = await supabase.from('box_scores').select('game_id').eq('player_id', playerId);
  if (error) throw new Error(error.message);
  const gameIds = [...new Set((boxRows ?? []).map((r) => r.game_id))];
  if (gameIds.length === 0) return [];

  const { data: games, error: gamesErr } = await supabase
    .from('games')
    .select('season_id, season:seasons(id, year)')
    .in('id', gameIds);
  if (gamesErr) throw new Error(gamesErr.message);

  const seasonById = new Map();
  for (const g of games ?? []) {
    if (g.season) seasonById.set(g.season.id, g.season.year);
  }
  const seasons = [...seasonById.entries()].map(([id, year]) => ({ id, year })).sort((a, b) => (a.year < b.year ? -1 : 1));

  return Promise.all(
    seasons.map(async (s) => {
      const summary = await computePlayerSummary(supabase, playerId, s.id);
      return {
        seasonId: s.id,
        seasonYear: s.year,
        games: summary.games,
        pts: summary.perGame['pts'] ?? 0,
        per: summary.per,
        pie: summary.pie,
        netRating: summary.netRating,
      };
    })
  );
}

/** Same shape as computePlayerSeasonHistory, for a team. */
async function computeTeamSeasonHistory(supabase, teamId) {
  const { data: games, error } = await supabase
    .from('games')
    .select('season:seasons(id, year)')
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  if (error) throw new Error(error.message);

  const seasonById = new Map();
  for (const g of games ?? []) {
    if (g.season) seasonById.set(g.season.id, g.season.year);
  }
  const seasons = [...seasonById.entries()].map(([id, year]) => ({ id, year })).sort((a, b) => (a.year < b.year ? -1 : 1));

  return Promise.all(
    seasons.map(async (s) => {
      const summary = await computeTeamSummary(supabase, teamId, s.id);
      return {
        seasonId: s.id,
        seasonYear: s.year,
        games: summary.games,
        pts: summary.perGame['pts'] ?? 0,
        per: summary.per,
        pie: summary.pie,
        netRating: summary.netRating,
      };
    })
  );
}

/** Every game a team played, split by win/loss, with both sides' totals — the raw material for "what goes wrong when they lose". */
async function teamGameResults(supabase, teamId) {
  const { data: games, error: gamesErr } = await supabase
    .from('games')
    .select('id, home_team_id, away_team_id')
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  if (gamesErr) throw new Error(gamesErr.message);
  if (!games || games.length === 0) return [];

  const gameIds = games.map((g) => g.id);
  const opponentTeamIds = [...new Set(games.map((g) => (g.home_team_id === teamId ? g.away_team_id : g.home_team_id)))];
  const [teamPlayerIds, oppPlayerIdsRaw] = await Promise.all([
    aggregates.playerIdsForTeam(supabase, teamId),
    supabase.from('players').select('id, team_id').in('team_id', opponentTeamIds),
  ]);
  if (oppPlayerIdsRaw.error) throw new Error(oppPlayerIdsRaw.error.message);
  const teamIdByPlayerId = new Map((oppPlayerIdsRaw.data ?? []).map((p) => [p.id, p.team_id]));

  const [teamBox, oppBox] = await Promise.all([
    aggregates.boxScoresByPlayerIds(supabase, teamPlayerIds, gameIds),
    aggregates.boxScoresByPlayerIds(supabase, [...teamIdByPlayerId.keys()], gameIds),
  ]);
  const teamRowsByGame = new Map();
  for (const r of teamBox) {
    if (!teamRowsByGame.has(r.game_id)) teamRowsByGame.set(r.game_id, []);
    teamRowsByGame.get(r.game_id).push(r);
  }
  const oppRowsByGame = new Map();
  for (const r of oppBox) {
    const oppTeamId = teamIdByPlayerId.get(r.player_id);
    const key = `${r.game_id}:${oppTeamId}`;
    if (!oppRowsByGame.has(key)) oppRowsByGame.set(key, []);
    oppRowsByGame.get(key).push(r);
  }

  return games.map((g) => {
    const opponentId = g.home_team_id === teamId ? g.away_team_id : g.home_team_id;
    const teamTotals = sumRows(teamRowsByGame.get(g.id) ?? []);
    const oppTotals = sumRows(oppRowsByGame.get(`${g.id}:${opponentId}`) ?? []);
    return { gameId: g.id, teamTotals, oppTotals, won: (teamTotals.pts ?? 0) > (oppTotals.pts ?? 0) };
  });
}

/**
 * Team rank at every date across a season — the raw material for a bump
 * chart. Ranked by win% (falling back to wins for ties), recomputed after
 * each date's games. Purely from real game results, nothing modeled.
 */
async function computeLeagueStandingsHistory(supabase, leagueId, seasonId) {
  const { data: leagueTeams, error: teamsErr } = await supabase.from('teams').select('id, name').eq('league_id', leagueId);
  if (teamsErr) throw new Error(teamsErr.message);
  const teamIds = (leagueTeams ?? []).map((t) => t.id);
  const teamNameById = new Map((leagueTeams ?? []).map((t) => [t.id, t.name]));
  if (teamIds.length === 0) return { dates: [], teams: [] };

  const { data: rawGames, error: gamesErr } = await supabase
    .from('games')
    .select('id, date, home_team_id, away_team_id')
    .eq('season_id', seasonId)
    .in('home_team_id', teamIds)
    .order('date', { ascending: true })
    .order('id', { ascending: true });
  if (gamesErr) throw new Error(gamesErr.message);
  const games = (rawGames ?? []).map((g) => ({
    id: g.id,
    date: g.date,
    homeTeamId: g.home_team_id,
    awayTeamId: g.away_team_id,
    homeTeamName: teamNameById.get(g.home_team_id) ?? '',
    awayTeamName: teamNameById.get(g.away_team_id) ?? '',
  }));

  if (games.length === 0) return { dates: [], teams: [] };

  // One bulk fetch of every box-score row for this league/season, tagged
  // with the team_id it belongs to (via the players embed) — the per-date
  // standings loop below then just groups/sums in memory instead of
  // issuing a query per game per date (was O(games) round trips).
  const gameIds = games.map((g) => g.id);
  const { data: allPlayers, error: playersErr } = await supabase.from('players').select('id, team_id').in('team_id', teamIds);
  if (playersErr) throw new Error(playersErr.message);
  const teamIdByPlayerId = new Map((allPlayers ?? []).map((p) => [p.id, p.team_id]));
  const { data: allBox, error: boxErr } = await supabase
    .from('box_scores')
    .select(aggregates.BOX_SCORE_COLUMNS)
    .in('player_id', [...teamIdByPlayerId.keys()])
    .in('game_id', gameIds);
  if (boxErr) throw new Error(boxErr.message);
  const totalsCache = new Map(); // `${gameId}:${teamId}` -> summed row
  for (const r of allBox ?? []) {
    const teamId = teamIdByPlayerId.get(r.player_id);
    const key = `${r.game_id}:${teamId}`;
    if (!totalsCache.has(key)) totalsCache.set(key, []);
    totalsCache.get(key).push(r);
  }
  const totalsFor = (gameId, teamId) => sumRows(totalsCache.get(`${gameId}:${teamId}`) ?? []);

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
async function computeGameWinProbability(supabase, gameId) {
  const { data: game, error: gameErr } = await supabase
    .from('games')
    .select('id, home_team_id, away_team_id')
    .eq('id', gameId)
    .maybeSingle();
  if (gameErr) throw new Error(gameErr.message);
  if (!game) return null;
  const homeTeamId = game.home_team_id;
  const awayTeamId = game.away_team_id;

  const { data: events, error: eventsErr } = await supabase
    .from('game_events')
    .select('*')
    .eq('game_id', gameId)
    .order('clock_seconds', { ascending: true })
    .order('sequence', { ascending: true });
  if (eventsErr) throw new Error(eventsErr.message);
  if (!events || events.length === 0) return null; // no play-by-play data for this game

  const gameDurationSeconds = Math.max(...events.map((e) => e.clock_seconds), 2400);

  let home = 0;
  let away = 0;
  const points = [{ clockSeconds: 0, homeWinProb: 0.5 }];
  for (const e of events) {
    if (e.event_type !== 'score') continue;
    if (e.team_id === homeTeamId) home += e.points || 0;
    else if (e.team_id === awayTeamId) away += e.points || 0;

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
async function buildTeamScoutingReport(supabase, teamId) {
  const { data: team, error: teamErr } = await supabase.from('teams').select('id, name, league_id').eq('id', teamId).maybeSingle();
  if (teamErr) throw new Error(teamErr.message);
  if (!team) return null;
  const { data: league, error: leagueErr } = await supabase.from('leagues').select('name').eq('id', team.league_id).maybeSingle();
  if (leagueErr) throw new Error(leagueErr.message);

  const [teamAgg, leagueAgg] = await Promise.all([
    aggregates.teamAggregate(supabase, teamId),
    aggregates.leagueAggregate(supabase, team.league_id),
  ]);
  const teamPerGame = perGame(teamAgg.totals, teamAgg.games || 1);
  const leaguePerGame = perGame(leagueAgg.totals, leagueAgg.teamGames || 1);
  const profileInsights = buildTeamProfileInsights(team.name, teamPerGame, leaguePerGame);

  const { data: players, error: playersErr } = await supabase.from('players').select('id, name').eq('team_id', teamId);
  if (playersErr) throw new Error(playersErr.message);
  const keyPlayers = (
    await Promise.all(
      (players ?? []).map(async (p) => {
        const summary = await computePlayerSummary(supabase, p.id);
        return { playerId: p.id, playerName: p.name, summary };
      })
    )
  )
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

  const results = await teamGameResults(supabase, teamId);
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
async function buildPlayerScoutingReport(supabase, playerId) {
  const { data: player, error: playerErr } = await supabase.from('players').select('id, name, team_id').eq('id', playerId).maybeSingle();
  if (playerErr) throw new Error(playerErr.message);
  if (!player) return null;
  const { data: team, error: teamErr } = await supabase.from('teams').select('name, league_id').eq('id', player.team_id).maybeSingle();
  if (teamErr) throw new Error(teamErr.message);
  const { data: league, error: leagueErr } = await supabase.from('leagues').select('name').eq('id', team.league_id).maybeSingle();
  if (leagueErr) throw new Error(leagueErr.message);

  const summary = await computePlayerSummary(supabase, playerId);
  const leagueAgg = await aggregates.leagueAggregate(supabase, team.league_id);
  // Player-scale divisor (total player-appearances), not team-appearances —
  // comparing a player's ~15 PTS/game against a whole team's ~80 PTS/game
  // "league average" would be comparing different things entirely.
  const leaguePerGame = perGame(leagueAgg.totals, leagueAgg.rows.length || 1);
  const profileInsights = buildTeamProfileInsights(player.name, summary.perGame, leaguePerGame);

  const teamResults = await teamGameResults(supabase, player.team_id);
  const winGameIds = new Set(teamResults.filter((r) => r.won).map((r) => r.gameId));
  const lossGameIds = new Set(teamResults.filter((r) => !r.won).map((r) => r.gameId));
  const { data: allRows, error: rowsErr } = await supabase.from('box_scores').select(aggregates.BOX_SCORE_COLUMNS).eq('player_id', playerId);
  if (rowsErr) throw new Error(rowsErr.message);
  const winRows = (allRows ?? []).filter((r) => winGameIds.has(r.game_id));
  const lossRows = (allRows ?? []).filter((r) => lossGameIds.has(r.game_id));

  const hasEnoughWinLossGames = winRows.length >= 2 && lossRows.length >= 2;
  const winVsLossInsights = hasEnoughWinLossGames
    ? buildPlayerWinLossInsights(
        player.name,
        perGame(sumRows(winRows), winRows.length),
        perGame(sumRows(lossRows), lossRows.length)
      )
    : [];

  const playingTimeInsights = buildPlayingTimeInsights(await computePlayerAdvancedGameLog(supabase, playerId));

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
async function buildTeamScoutingReportAllCompetitions(supabase, teamName) {
  const { data: siblings, error: siblingErr } = await supabase.from('teams').select('id, league_id, leagues(name)').eq('name', teamName);
  if (siblingErr) throw new Error(siblingErr.message);
  if (!siblings || siblings.length === 0) return null;
  const siblingIds = siblings.map((s) => s.id);

  const teamAggs = await Promise.all(siblingIds.map((id) => aggregates.teamAggregate(supabase, id)));
  const allRows = teamAggs.flatMap((a) => a.rows);
  const totalGames = new Set(allRows.map((r) => r.game_id)).size;
  const teamPerGame = perGame(sumRows(allRows), totalGames || 1);

  const leagueIds = [...new Set(siblings.map((s) => s.league_id))];
  const leagueAggs = await Promise.all(leagueIds.map((id) => aggregates.leagueAggregate(supabase, id)));
  const leagueRowsAll = leagueAggs.flatMap((a) => a.rows);
  const leagueTeamGamesAll = leagueAggs.reduce((sum, a) => sum + (a.teamGames || 0), 0);
  const leaguePerGame = perGame(sumRows(leagueRowsAll), leagueTeamGamesAll || 1);
  const profileInsights = buildTeamProfileInsights(teamName, teamPerGame, leaguePerGame);

  const { data: siblingPlayers, error: playersErr } = await supabase.from('players').select('id, name').in('team_id', siblingIds);
  if (playersErr) throw new Error(playersErr.message);
  const playerNames = [...new Set((siblingPlayers ?? []).map((p) => p.name))];
  const playerIdsByName = new Map();
  for (const p of siblingPlayers ?? []) {
    if (!playerIdsByName.has(p.name)) playerIdsByName.set(p.name, []);
    playerIdsByName.get(p.name).push(p.id);
  }

  const oppAggs = await Promise.all(siblingIds.map((id) => aggregates.opponentAggregate(supabase, id)));
  const oppTotalsAll = sumRows(oppAggs.flatMap((a) => a.rows));
  const teamTotalsAll = sumRows(allRows);

  const allPlayerIds = [...playerIdsByName.values()].flat();
  const { data: allPlayerBox, error: boxErr } = await supabase.from('box_scores').select(aggregates.BOX_SCORE_COLUMNS).in('player_id', allPlayerIds.length ? allPlayerIds : [-1]);
  if (boxErr) throw new Error(boxErr.message);
  const rowsByPlayerId = new Map();
  for (const r of allPlayerBox ?? []) {
    if (!rowsByPlayerId.has(r.player_id)) rowsByPlayerId.set(r.player_id, []);
    rowsByPlayerId.get(r.player_id).push(r);
  }

  const keyPlayers = playerNames
    .map((name) => {
      const playerIds = playerIdsByName.get(name) ?? [];
      const rows = playerIds.flatMap((id) => rowsByPlayerId.get(id) ?? []);
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

  const results = (await Promise.all(siblingIds.map((id) => teamGameResults(supabase, id)))).flat();
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
async function buildPlayerScoutingReportAllCompetitions(supabase, playerName, teamName) {
  const { data: siblingTeams, error: teamsErr } = await supabase.from('teams').select('id, league_id').eq('name', teamName);
  if (teamsErr) throw new Error(teamsErr.message);
  const siblingTeamIds = (siblingTeams ?? []).map((t) => t.id);
  if (siblingTeamIds.length === 0) return null;
  const leagueIdByTeamId = new Map((siblingTeams ?? []).map((t) => [t.id, t.league_id]));

  const { data: siblings, error: siblingErr } = await supabase
    .from('players')
    .select('id, team_id')
    .eq('name', playerName)
    .in('team_id', siblingTeamIds);
  if (siblingErr) throw new Error(siblingErr.message);
  if (!siblings || siblings.length === 0) return null;
  const siblingPlayerIds = siblings.map((s) => s.id);

  const { data: allRows, error: rowsErr } = await supabase.from('box_scores').select(aggregates.BOX_SCORE_COLUMNS).in('player_id', siblingPlayerIds);
  if (rowsErr) throw new Error(rowsErr.message);
  const games = (allRows ?? []).length;
  const summaryPerGame = perGame(sumRows(allRows ?? []), games || 1);

  const leagueIds = [...new Set(siblings.map((s) => leagueIdByTeamId.get(s.team_id)))];
  const leagueAggs = await Promise.all(leagueIds.map((id) => aggregates.leagueAggregate(supabase, id)));
  const leagueRowsAll = leagueAggs.flatMap((a) => a.rows);
  const leaguePerGame = perGame(sumRows(leagueRowsAll), leagueRowsAll.length || 1);
  const profileInsights = buildTeamProfileInsights(playerName, summaryPerGame, leaguePerGame);

  const usedTeamIds = [...new Set(siblings.map((s) => s.team_id))];
  const results = (await Promise.all(usedTeamIds.map((id) => teamGameResults(supabase, id)))).flat();
  const winGameIds = new Set(results.filter((r) => r.won).map((r) => r.gameId));
  const lossGameIds = new Set(results.filter((r) => !r.won).map((r) => r.gameId));
  const winRows = (allRows ?? []).filter((r) => winGameIds.has(r.game_id));
  const lossRows = (allRows ?? []).filter((r) => lossGameIds.has(r.game_id));
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
async function computePlayerAdvancedGameLog(supabase, playerId) {
  const { data: player, error: playerErr } = await supabase.from('players').select('team_id').eq('id', playerId).maybeSingle();
  if (playerErr) throw new Error(playerErr.message);
  if (!player) return [];

  const { data: rows, error: rowsErr } = await supabase.from('box_scores').select(aggregates.BOX_SCORE_COLUMNS).eq('player_id', playerId);
  if (rowsErr) throw new Error(rowsErr.message);
  if (!rows || rows.length === 0) return [];

  const gameIds = rows.map((r) => r.game_id);
  const { data: games, error: gamesErr } = await supabase.from('games').select('id, date, home_team_id, away_team_id').in('id', gameIds).order('date', { ascending: true });
  if (gamesErr) throw new Error(gamesErr.message);
  const gameById = new Map((games ?? []).map((g) => [g.id, g]));

  const { data: allBox, error: boxErr } = await supabase
    .from('box_scores')
    .select(`${aggregates.BOX_SCORE_COLUMNS}, player:players(team_id)`)
    .in('game_id', gameIds);
  if (boxErr) throw new Error(boxErr.message);
  const rowsByGame = new Map();
  for (const r of allBox ?? []) {
    if (!rowsByGame.has(r.game_id)) rowsByGame.set(r.game_id, []);
    rowsByGame.get(r.game_id).push({ ...r, team_id: r.player?.team_id ?? null });
  }

  const sorted = [...rows].sort((a, b) => {
    const da = gameById.get(a.game_id)?.date ?? '';
    const db_ = gameById.get(b.game_id)?.date ?? '';
    return da < db_ ? -1 : da > db_ ? 1 : 0;
  });

  return sorted.map((g) => {
    const game = gameById.get(g.game_id);
    const oppTeamId = game && game.home_team_id === player.team_id ? game.away_team_id : game?.home_team_id;
    const gameRows = rowsByGame.get(g.game_id) ?? [];
    const teamRows = gameRows.filter((r) => r.team_id === player.team_id);
    const oppRows = gameRows.filter((r) => r.team_id === oppTeamId);
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
async function computeTeamAdvancedReport(supabase, teamId, seasonId, throughGame) {
  const { data: team, error: teamErr } = await supabase.from('teams').select('name, league_id').eq('id', teamId).maybeSingle();
  if (teamErr) throw new Error(teamErr.message);
  if (!team) return null;
  const { data: league, error: leagueErr } = await supabase.from('leagues').select('name').eq('id', team.league_id).maybeSingle();
  if (leagueErr) throw new Error(leagueErr.message);
  const { data: season, error: seasonErr } = await supabase.from('seasons').select('year').eq('id', seasonId).maybeSingle();
  if (seasonErr) throw new Error(seasonErr.message);

  const { data: teamGames, error: gamesErr } = await supabase
    .from('games')
    .select('id, date')
    .eq('season_id', seasonId)
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .order('date', { ascending: true })
    .order('id', { ascending: true });
  if (gamesErr) throw new Error(gamesErr.message);
  if (throughGame < 1 || throughGame > (teamGames ?? []).length) return null;
  const cutoffGames = teamGames.slice(0, throughGame);
  const cutoffGameIds = cutoffGames.map((g) => g.id);
  const cutoffDate = cutoffGames[cutoffGames.length - 1].date;

  const [teamAgg, oppAgg, leagueAgg] = await Promise.all([
    aggregates.teamAggregateThrough(supabase, teamId, cutoffGameIds),
    aggregates.opponentAggregateThrough(supabase, teamId, cutoffGameIds),
    aggregates.leagueAggregateThrough(supabase, team.league_id, seasonId, cutoffDate),
  ]);

  const { data: teamPlayers, error: playersErr } = await supabase.from('players').select('id, name').eq('team_id', teamId);
  if (playersErr) throw new Error(playersErr.message);
  const nameById = new Map((teamPlayers ?? []).map((p) => [p.id, p.name]));

  const { data: cutoffBox, error: boxErr } = await supabase
    .from('box_scores')
    .select(aggregates.BOX_SCORE_COLUMNS)
    .in('player_id', [...nameById.keys()])
    .in('game_id', cutoffGameIds);
  if (boxErr) throw new Error(boxErr.message);
  const boxByPlayer = new Map();
  for (const r of cutoffBox ?? []) {
    if (!boxByPlayer.has(r.player_id)) boxByPlayer.set(r.player_id, []);
    boxByPlayer.get(r.player_id).push(r);
  }

  const { data: pbpGames, error: pbpErr } = await supabase.from('game_events').select('game_id').in('game_id', cutoffGameIds);
  if (pbpErr) throw new Error(pbpErr.message);
  const gameIdsWithPbp = new Set((pbpGames ?? []).map((g) => g.game_id));

  const playerSummaries = [...boxByPlayer.entries()].map(([playerId, rows]) => {
    const hasPlayByPlayData = rows.some((r) => gameIdsWithPbp.has(r.game_id));
    const summary = buildStatSummary({
      rows,
      games: rows.length,
      isTeam: false,
      teamAgg,
      oppAgg,
      leagueAgg,
      hasPlayByPlayData,
    });
    return { playerId, playerName: nameById.get(playerId) ?? '', summary };
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
async function computeTeamFourFactorsReport(supabase, teamId, seasonId) {
  const { data: team, error: teamErr } = await supabase.from('teams').select('name, league_id').eq('id', teamId).maybeSingle();
  if (teamErr) throw new Error(teamErr.message);
  if (!team) return null;
  const { data: season, error: seasonErr } = await supabase.from('seasons').select('year').eq('id', seasonId).maybeSingle();
  if (seasonErr) throw new Error(seasonErr.message);

  const [teamAgg, oppAgg, leagueAgg] = await Promise.all([
    aggregates.teamAggregate(supabase, teamId),
    aggregates.opponentAggregate(supabase, teamId),
    aggregates.leagueAggregate(supabase, team.league_id),
  ]);
  const summary = buildStatSummary({
    rows: teamAgg.rows,
    games: teamAgg.games,
    isTeam: true,
    teamAgg,
    oppAgg,
    leagueAgg,
  });

  // PBP-only raw material, scoped to this season.
  const seasonGameIds = await aggregates.gameIdsForSeason(supabase, seasonId);
  const { data: teamEvents, error: eventsErr } = await supabase
    .from('game_events')
    .select('*')
    .eq('team_id', teamId)
    .in('game_id', seasonGameIds.length ? seasonGameIds : [-1]);
  if (eventsErr) throw new Error(eventsErr.message);
  const hasPbp = (teamEvents ?? []).length > 0;

  const assistedFgPct = hasPbp ? computeAssistedFgPct(teamEvents) : null;
  const liveBallShare = hasPbp ? computeLiveBallShare(teamEvents) : null;
  const liveBallTovPct =
    liveBallShare !== null && summary.advanced.tov_pct !== null ? summary.advanced.tov_pct * liveBallShare : null;

  const [opponentQuality, lineupResult] = await Promise.all([
    computeOpponentQualityForTeam(supabase, teamId, seasonId),
    computeLineupCombosForTeam(supabase, teamId, seasonId),
  ]);
  const { combos: lineupCombos, hasPbp: hasLineupData } = lineupResult;

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

  const { data: roster, error: rosterErr } = await supabase
    .from('players')
    .select('id, name, position')
    .eq('team_id', teamId)
    .order('name');
  if (rosterErr) throw new Error(rosterErr.message);

  return {
    teamName: team.name,
    seasonYear: season ? season.year : '',
    primaryMetrics,
    contextMetrics,
    strategicMetrics,
    combos: [shooting, ballHandling, rebounding, ftRate],
    roster: (roster ?? []).map((p) => ({ playerId: p.id, playerName: p.name, position: p.position })),
  };
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/** Average of every opponent's own season Net Rating across the team's games — team-level "strength of schedule", not individual defender-matchup difficulty (that stays permanently N/A). */
async function computeOpponentQualityForTeam(supabase, teamId, seasonId) {
  const { data: games, error: gamesErr } = await supabase
    .from('games')
    .select('home_team_id, away_team_id')
    .eq('season_id', seasonId)
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  if (gamesErr) throw new Error(gamesErr.message);
  if (!games || games.length === 0) return null;

  // One rating computed per DISTINCT opponent (avoids recomputing the same
  // team's season summary once per meeting), but the final average is still
  // weighted by games played against each — a team faced twice counts twice
  // — matching the original per-game averaging exactly.
  const opponentTeamIds = [...new Set(games.map((g) => (g.home_team_id === teamId ? g.away_team_id : g.home_team_id)))];
  const ratingByOppTeamId = new Map(
    await Promise.all(
      opponentTeamIds.map(async (oppTeamId) => {
        const { data: oppTeam, error: oppTeamErr } = await supabase.from('teams').select('league_id').eq('id', oppTeamId).maybeSingle();
        if (oppTeamErr) throw new Error(oppTeamErr.message);
        if (!oppTeam) return [oppTeamId, null];
        const [oppTeamAgg, oppOppAgg, oppLeagueAgg] = await Promise.all([
          aggregates.teamAggregate(supabase, oppTeamId),
          aggregates.opponentAggregate(supabase, oppTeamId),
          aggregates.leagueAggregate(supabase, oppTeam.league_id),
        ]);
        const oppSummary = buildStatSummary({
          rows: oppTeamAgg.rows,
          games: oppTeamAgg.games,
          isTeam: true,
          teamAgg: oppTeamAgg,
          oppAgg: oppOppAgg,
          leagueAgg: oppLeagueAgg,
        });
        return [oppTeamId, oppSummary.netRating];
      })
    )
  );

  const ratings = games.map((g) => ratingByOppTeamId.get(g.home_team_id === teamId ? g.away_team_id : g.home_team_id));
  const valid = ratings.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

/** Every distinct 5-man on-court unit for `teamId`, across every PBP-imported game that season, with combined minutes and net rating — reuses buildStints (rapm.js) per game instead of feeding a RAPM regression. */
async function computeLineupCombosForTeam(supabase, teamId, seasonId) {
  const { data: seasonGames, error: gamesErr } = await supabase
    .from('games')
    .select('id, home_team_id, away_team_id')
    .eq('season_id', seasonId)
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);
  if (gamesErr) throw new Error(gamesErr.message);
  if (!seasonGames || seasonGames.length === 0) return { combos: [], hasPbp: false };

  const gameIds = seasonGames.map((g) => g.id);
  const { data: allEvents, error: eventsErr } = await supabase
    .from('game_events')
    .select('*')
    .in('game_id', gameIds)
    .order('clock_seconds', { ascending: true })
    .order('sequence', { ascending: true });
  if (eventsErr) throw new Error(eventsErr.message);
  const eventsByGame = new Map();
  for (const e of allEvents ?? []) {
    if (!eventsByGame.has(e.game_id)) eventsByGame.set(e.game_id, []);
    eventsByGame.get(e.game_id).push(e);
  }
  const games = seasonGames.filter((g) => (eventsByGame.get(g.id) ?? []).length > 0);
  if (games.length === 0) return { combos: [], hasPbp: false };

  const { data: allBox, error: boxErr } = await supabase
    .from('box_scores')
    .select(`${aggregates.BOX_SCORE_COLUMNS}, player:players(team_id)`)
    .in('game_id', games.map((g) => g.id));
  if (boxErr) throw new Error(boxErr.message);
  const boxByGame = new Map();
  for (const r of allBox ?? []) {
    if (!boxByGame.has(r.game_id)) boxByGame.set(r.game_id, []);
    boxByGame.get(r.game_id).push({ ...r, team_id: r.player?.team_id ?? null });
  }

  const allStints = [];
  for (const g of games) {
    const events = eventsByGame.get(g.id) ?? [];
    const gameEndSeconds = Math.max(...events.map((e) => e.clock_seconds), 2400);
    const stints = buildStints(events, g.home_team_id, g.away_team_id, gameEndSeconds);

    const gameRows = boxByGame.get(g.id) ?? [];
    const homeTotals = sumRows(gameRows.filter((r) => r.team_id === g.home_team_id));
    const awayTotals = sumRows(gameRows.filter((r) => r.team_id === g.away_team_id));
    const totalPoss = estimatePossessions(homeTotals) + estimatePossessions(awayTotals);
    const possPerSecond = gameEndSeconds > 0 ? totalPoss / 2 / gameEndSeconds : 0;
    if (possPerSecond <= 0) continue;

    const isHome = g.home_team_id === teamId;
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

  const { data: teamPlayers, error: playersErr } = await supabase.from('players').select('id, name').eq('team_id', teamId);
  if (playersErr) throw new Error(playersErr.message);
  const playerNames = new Map((teamPlayers ?? []).map((p) => [p.id, p.name]));
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
async function computePossessionStatsForTeamGames(supabase, teamId, gameIds) {
  if (gameIds.length === 0) return null;
  const { data: allEvents, error: eventsErr } = await supabase
    .from('game_events')
    .select('*')
    .in('game_id', gameIds)
    .order('clock_seconds', { ascending: true })
    .order('sequence', { ascending: true });
  if (eventsErr) throw new Error(eventsErr.message);
  const eventsByGame = new Map();
  for (const e of allEvents ?? []) {
    if (!eventsByGame.has(e.game_id)) eventsByGame.set(e.game_id, []);
    eventsByGame.get(e.game_id).push(e);
  }
  const pbpGameIds = [...eventsByGame.keys()];
  if (pbpGameIds.length === 0) return null;

  const { data: games, error: gamesErr } = await supabase.from('games').select('id, home_team_id, away_team_id').in('id', pbpGameIds);
  if (gamesErr) throw new Error(gamesErr.message);
  if (!games || games.length === 0) return null;

  const totals = { pointsOffTurnovers: 0, secondChancePoints: 0, fastbreakPoints: 0 };
  for (const g of games) {
    const events = eventsByGame.get(g.id) ?? [];
    const possessions = reconstructGamePossessions(events, g.home_team_id, g.away_team_id);
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
async function computeOfficialTeamAdvancedStats(supabase, teamId, gameIds) {
  if (gameIds.length === 0) return null;
  const { data: rows, error } = await supabase
    .from('team_game_advanced_stats')
    .select('*')
    .eq('team_id', teamId)
    .in('game_id', gameIds);
  if (error) throw new Error(error.message);
  if (!rows || rows.length === 0) return null;
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
async function offDefFourFactors(supabase, teamId, gameIds) {
  const [teamAgg, oppAgg] = await Promise.all([
    aggregates.teamAggregateThrough(supabase, teamId, gameIds),
    aggregates.opponentAggregateThrough(supabase, teamId, gameIds),
  ]);
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
async function teamStatsRowFor(supabase, teamId, gameIds) {
  if (gameIds.length === 0) return null;
  const [off, def] = await Promise.all([
    aggregates.teamAggregateThrough(supabase, teamId, gameIds),
    aggregates.opponentAggregateThrough(supabase, teamId, gameIds),
  ]);
  const games = gameIds.length;
  const offPerGame = perGame(off.totals, games);
  const defPerGame = perGame(def.totals, games);
  const offAdv = advancedStatLine(offPerGame);
  const defAdv = advancedStatLine(defPerGame);
  // Prefer official per-shot-flag numbers (real data provider ground truth)
  // over the app's own clock-threshold possession estimate, whenever the
  // imported games actually have official data.
  const official = await computeOfficialTeamAdvancedStats(supabase, teamId, gameIds);
  const poss = official ? null : await computePossessionStatsForTeamGames(supabase, teamId, gameIds);
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
async function computeScoutingReport(supabase, ourTeamId, opponentTeamId, seasonId, gameDate) {
  const { data: teamsRows, error: teamsErr } = await supabase.from('teams').select('id, name').in('id', [ourTeamId, opponentTeamId]);
  if (teamsErr) throw new Error(teamsErr.message);
  const teamById = new Map((teamsRows ?? []).map((t) => [t.id, t]));
  const ourTeam = teamById.get(ourTeamId);
  const oppTeam = teamById.get(opponentTeamId);
  if (!ourTeam || !oppTeam) return null;
  const { data: season, error: seasonErr } = await supabase.from('seasons').select('year').eq('id', seasonId).maybeSingle();
  if (seasonErr) throw new Error(seasonErr.message);

  const seasonGamesFor = async (teamId) => {
    const { data, error } = await supabase
      .from('games')
      .select('id, date, home_team_id, away_team_id')
      .eq('season_id', seasonId)
      .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
      .order('date', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((g) => ({ id: g.id, date: g.date, homeTeamId: g.home_team_id, awayTeamId: g.away_team_id }));
  };

  const [ourGames, oppGames] = await Promise.all([seasonGamesFor(ourTeamId), seasonGamesFor(opponentTeamId)]);
  const oppGameIds = oppGames.map((g) => g.id);
  const oppLast5GameIds = oppGameIds.slice(-5);
  const h2hGames = oppGames.filter((g) => g.homeTeamId === ourTeamId || g.awayTeamId === ourTeamId);
  const ourGameIds = ourGames.map((g) => g.id);

  const oppResultsAll = await teamGameResults(supabase, opponentTeamId);
  const oppResults = oppResultsAll.filter((r) => oppGameIds.includes(r.gameId));
  const wins = oppResults.filter((r) => r.won).length;
  const losses = oppResults.filter((r) => !r.won).length;

  // --- Roster / cumulative boxscore / depth chart (opponent) ---
  const { data: rosterRows, error: rosterErr } = await supabase
    .from('players')
    .select('id, name, position, depth_rank, height, hidden')
    .eq('team_id', opponentTeamId)
    .order('name');
  if (rosterErr) throw new Error(rosterErr.message);

  const rosterPlayerIds = (rosterRows ?? []).map((p) => p.id);
  const { data: rosterBox, error: rosterBoxErr } =
    oppGameIds.length > 0 && rosterPlayerIds.length > 0
      ? await supabase.from('box_scores').select(aggregates.BOX_SCORE_COLUMNS).in('player_id', rosterPlayerIds).in('game_id', oppGameIds)
      : { data: [], error: null };
  if (rosterBoxErr) throw new Error(rosterBoxErr.message);
  const rosterBoxByPlayer = new Map();
  for (const r of rosterBox ?? []) {
    if (!rosterBoxByPlayer.has(r.player_id)) rosterBoxByPlayer.set(r.player_id, []);
    rosterBoxByPlayer.get(r.player_id).push(r);
  }

  const roster = (rosterRows ?? []).map((p) => {
    const rows = rosterBoxByPlayer.get(p.id) ?? [];
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
  const [teamAggAll, oppOfTeamAggAll] = await Promise.all([
    aggregates.teamAggregateThrough(supabase, opponentTeamId, oppGameIds),
    aggregates.opponentAggregateThrough(supabase, opponentTeamId, oppGameIds),
  ]);
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
  const recentGamesList = oppGames.slice(-5).reverse();
  const recentOppSideTeamIds = [...new Set(recentGamesList.map((g) => (g.homeTeamId === opponentTeamId ? g.awayTeamId : g.homeTeamId)))];
  const { data: recentOppTeams, error: recentTeamsErr } = recentOppSideTeamIds.length
    ? await supabase.from('teams').select('id, name').in('id', recentOppSideTeamIds)
    : { data: [], error: null };
  if (recentTeamsErr) throw new Error(recentTeamsErr.message);
  const recentTeamNameById = new Map((recentOppTeams ?? []).map((t) => [t.id, t.name]));
  const recentGameIds = recentGamesList.map((g) => g.id);
  const { data: recentBox, error: recentBoxErr } = recentGameIds.length
    ? await supabase.from('box_scores').select(`${aggregates.BOX_SCORE_COLUMNS}, player:players(team_id)`).in('game_id', recentGameIds)
    : { data: [], error: null };
  if (recentBoxErr) throw new Error(recentBoxErr.message);
  const recentBoxByGame = new Map();
  for (const r of recentBox ?? []) {
    if (!recentBoxByGame.has(r.game_id)) recentBoxByGame.set(r.game_id, []);
    recentBoxByGame.get(r.game_id).push({ ...r, team_id: r.player?.team_id ?? null });
  }
  const recentGames = recentGamesList.map((g) => {
    const oppSideTeamId = g.homeTeamId === opponentTeamId ? g.awayTeamId : g.homeTeamId;
    const oppSideName = recentTeamNameById.get(oppSideTeamId) ?? '';
    const gameRows = recentBoxByGame.get(g.id) ?? [];
    const totals = sumRows(gameRows.filter((r) => r.team_id === opponentTeamId));
    const oppTotals = sumRows(gameRows.filter((r) => r.team_id === oppSideTeamId));
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
    us: await offDefFourFactors(supabase, ourTeamId, ourGameIds),
    opponent: await offDefFourFactors(supabase, opponentTeamId, oppGameIds),
  };

  // --- Team Stats splits (opponent) ---
  const [allOffStats, last5Stats, meetingStats] = await Promise.all([
    teamStatsRowFor(supabase, opponentTeamId, oppGameIds),
    teamStatsRowFor(supabase, opponentTeamId, oppLast5GameIds),
    Promise.all(h2hGames.map((g) => teamStatsRowFor(supabase, opponentTeamId, [g.id]))),
  ]);
  const teamStats = {
    allOff: allOffStats,
    last5: last5Stats,
    meetings: h2hGames.map((g, i) => ({
      date: g.date,
      site: g.homeTeamId === opponentTeamId ? 'vs' : '@',
      ourTeamName: ourTeam.name,
      stats: meetingStats[i],
    })),
  };

  // --- Points per period (opponent, across their whole season — a different real
  // opponent in each game, so this sums by "was it opponentTeamId's own event or
  // not" rather than assuming one fixed second team throughout). ---
  const pointsPerPeriod = await (async () => {
    if (oppGameIds.length === 0) return null;
    const { data: events, error: eventsErr } = await supabase
      .from('game_events')
      .select('game_id, clock_seconds, points, team_id')
      .in('game_id', oppGameIds)
      .eq('event_type', 'score');
    if (eventsErr) throw new Error(eventsErr.message);
    if (!events || events.length === 0) return null;
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
  const ourTeamAggAll = await aggregates.teamAggregateThrough(supabase, ourTeamId, ourGameIds);
  const teamPace = {
    us: pacePerGame(ourTeamAggAll.totals, ourGameIds.length || 1),
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
  const h2hGameIds = h2hGames.map((g) => g.id);
  const visibleRosterIds = visibleRoster.map((p) => p.playerId);
  const { data: h2hBox, error: h2hBoxErr } =
    h2hGameIds.length > 0 && visibleRosterIds.length > 0
      ? await supabase.from('box_scores').select(aggregates.BOX_SCORE_COLUMNS).in('player_id', visibleRosterIds).in('game_id', h2hGameIds)
      : { data: [], error: null };
  if (h2hBoxErr) throw new Error(h2hBoxErr.message);
  const h2hBoxByKey = new Map();
  for (const r of h2hBox ?? []) {
    h2hBoxByKey.set(`${r.player_id}:${r.game_id}`, r);
  }

  const playerPages = visibleRoster.map((p) => {
    const meetings = h2hGames
      .map((g) => {
        const row = h2hBoxByKey.get(`${p.playerId}:${g.id}`);
        if (!row) return null;
        const pg = perGame(sumRows([row]), 1);
        return { date: g.date, site: g.homeTeamId === opponentTeamId ? 'vs' : '@', perGame: pg, advanced: advancedStatLine(pg) };
      })
      .filter(Boolean);
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

/**
 * The league-wide "Impact Rating" — a real RAPM computed only from games
 * that were actually imported via play-by-play, blended with nothing and
 * never extrapolated onto games that don't have that data. A player who's
 * only ever been entered by photo/manual gets `rapm: null` here, not a
 * fabricated number — see confidenceLabel for how the confidence tiers map
 * to how many play-by-play games actually back a given rating.
 */
async function computeLeagueImpactRatings(supabase, leagueId, seasonId) {
  const { data: leagueTeams, error: teamsErr } = await supabase.from('teams').select('id').eq('league_id', leagueId);
  if (teamsErr) throw new Error(teamsErr.message);
  const teamIds = (leagueTeams ?? []).map((t) => t.id);

  const { data: seasonGames, error: gamesErr } =
    teamIds.length > 0
      ? await supabase.from('games').select('id, home_team_id, away_team_id').eq('season_id', seasonId).in('home_team_id', teamIds)
      : { data: [], error: null };
  if (gamesErr) throw new Error(gamesErr.message);

  const gameIds = (seasonGames ?? []).map((g) => g.id);
  const { data: allEvents, error: eventsErr } =
    gameIds.length > 0
      ? await supabase.from('game_events').select('*').in('game_id', gameIds).order('clock_seconds', { ascending: true }).order('sequence', { ascending: true })
      : { data: [], error: null };
  if (eventsErr) throw new Error(eventsErr.message);
  const eventsByGame = new Map();
  for (const e of allEvents ?? []) {
    if (!eventsByGame.has(e.game_id)) eventsByGame.set(e.game_id, []);
    eventsByGame.get(e.game_id).push(e);
  }
  const pbpGames = (seasonGames ?? []).filter((g) => (eventsByGame.get(g.id) ?? []).length > 0);

  const { data: allBox, error: boxErr } =
    pbpGames.length > 0
      ? await supabase.from('box_scores').select(`${aggregates.BOX_SCORE_COLUMNS}, player:players(team_id)`).in('game_id', pbpGames.map((g) => g.id))
      : { data: [], error: null };
  if (boxErr) throw new Error(boxErr.message);
  const boxByGame = new Map();
  for (const r of allBox ?? []) {
    if (!boxByGame.has(r.game_id)) boxByGame.set(r.game_id, []);
    boxByGame.get(r.game_id).push({ ...r, team_id: r.player?.team_id ?? null });
  }

  const gamesData = pbpGames.map((g) => {
    const events = eventsByGame.get(g.id) ?? [];
    const gameRows = boxByGame.get(g.id) ?? [];
    const homeRows = gameRows.filter((r) => r.team_id === g.home_team_id);
    const awayRows = gameRows.filter((r) => r.team_id === g.away_team_id);
    const gameEndSeconds = events.length ? Math.max(...events.map((e) => e.clock_seconds)) : 0;
    return {
      stints: buildStints(events, g.home_team_id, g.away_team_id, gameEndSeconds),
      homeTotals: sumRows(homeRows),
      awayTotals: sumRows(awayRows),
      gameDurationSeconds: gameEndSeconds,
    };
  });

  const rapmByPlayer = computeRapm(gamesData);
  const pbpGameIdSet = new Set(pbpGames.map((g) => g.id));

  const byPlayer = new Map();
  for (const row of await aggregates.leagueSeasonRows(supabase, leagueId, seasonId)) {
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
