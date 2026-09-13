const { contextBridge, ipcRenderer } = require('electron');

// Everything the Angular renderer is allowed to call. No direct fs/db/net
// access from the renderer — it only ever talks through these channels.
contextBridge.exposeInMainWorld('boxscoreApi', {
  // OCR: send a base64 image, get back a parsed box score for review.
  extractBoxScore: (base64Image, mediaType) =>
    ipcRenderer.invoke('ocr:extract-box-score', base64Image, mediaType),

  // Local parsing of a play-by-play Excel export — no API call, free, unmetered.
  extractPlayByPlay: (base64File) => ipcRenderer.invoke('pbp:extract', base64File),

  // Persist a reviewed/corrected box score.
  saveGame: (game) => ipcRenderer.invoke('db:save-game', game),

  // Reads used by the dashboard / comparison views.
  getPlayerStats: (playerId, seasonId) => ipcRenderer.invoke('db:get-player-stats', playerId, seasonId),
  getTeamStats: (teamId, seasonId) => ipcRenderer.invoke('db:get-team-stats', teamId, seasonId),
  getLeagueAverages: (leagueId, seasonId) =>
    ipcRenderer.invoke('db:get-league-averages', leagueId, seasonId),
  getLeaguePlayerAverages: (leagueId, seasonId) =>
    ipcRenderer.invoke('db:get-league-player-averages', leagueId, seasonId),
  getLeagueTeamRankings: (leagueId, seasonId) =>
    ipcRenderer.invoke('db:get-league-team-rankings', leagueId, seasonId),
  getLeaguePlayerLeaderboard: (leagueId, seasonId) =>
    ipcRenderer.invoke('db:get-league-player-leaderboard', leagueId, seasonId),
  getLeagueImpactRatings: (leagueId, seasonId) =>
    ipcRenderer.invoke('db:get-league-impact-ratings', leagueId, seasonId),
  getLeagueStandingsHistory: (leagueId, seasonId) =>
    ipcRenderer.invoke('db:get-league-standings-history', leagueId, seasonId),
  getGameWinProbability: (gameId) => ipcRenderer.invoke('db:get-game-win-probability', gameId),
  getGameBoxScore: (gameId) => ipcRenderer.invoke('db:get-game-box-score', gameId),
  listGames: () => ipcRenderer.invoke('db:list-games'),
  getGameInsights: (gameId) => ipcRenderer.invoke('db:get-game-insights', gameId),
  getTeamScoutingReport: (teamId) => ipcRenderer.invoke('db:get-team-scouting-report', teamId),
  getPlayerScoutingReport: (playerId) => ipcRenderer.invoke('db:get-player-scouting-report', playerId),
  getTeamScoutingReportAllCompetitions: (teamName) =>
    ipcRenderer.invoke('db:get-team-scouting-report-all-competitions', teamName),
  getPlayerScoutingReportAllCompetitions: (playerName, teamName) =>
    ipcRenderer.invoke('db:get-player-scouting-report-all-competitions', playerName, teamName),
  getTeamAllCompetitions: (teamId) => ipcRenderer.invoke('db:get-team-all-competitions', teamId),
  getPlayerAllCompetitions: (playerId) =>
    ipcRenderer.invoke('db:get-player-all-competitions', playerId),
  listTeams: () => ipcRenderer.invoke('db:list-teams'),
  getFavoriteTeam: () => ipcRenderer.invoke('db:get-favorite-team'),
  setFavoriteTeam: (teamId) => ipcRenderer.invoke('db:set-favorite-team', teamId),
  importShotZones: (params) => ipcRenderer.invoke('db:import-shot-zones', params),
  getTeamShotZones: (teamId, seasonId) => ipcRenderer.invoke('db:get-team-shot-zones', teamId, seasonId),
  getPlayerShotZones: (playerId, seasonId) => ipcRenderer.invoke('db:get-player-shot-zones', playerId, seasonId),
  getTeamShotEvents: (teamId, seasonId) => ipcRenderer.invoke('db:get-team-shot-events', teamId, seasonId),
  getPlayerShotEvents: (playerId, seasonId) => ipcRenderer.invoke('db:get-player-shot-events', playerId, seasonId),
  listPlayers: (teamId) => ipcRenderer.invoke('db:list-players', teamId),
  listAllPlayers: () => ipcRenderer.invoke('db:list-all-players'),

  // League / season / team management for the game-context picker.
  listLeagues: () => ipcRenderer.invoke('db:list-leagues'),
  createLeague: (league) => ipcRenderer.invoke('db:create-league', league),
  listSeasons: (leagueId) => ipcRenderer.invoke('db:list-seasons', leagueId),
  createSeason: (season) => ipcRenderer.invoke('db:create-season', season),
  createTeam: (team) => ipcRenderer.invoke('db:create-team', team),

  // Per-game history, for dashboard trend charts and recent-games tables.
  getPlayerGameLog: (playerId, seasonId) => ipcRenderer.invoke('db:get-player-game-log', playerId, seasonId),
  getTeamGameLog: (teamId, seasonId) => ipcRenderer.invoke('db:get-team-game-log', teamId, seasonId),
  getPlayerPieLog: (playerId, seasonId) => ipcRenderer.invoke('db:get-player-pie-log', playerId, seasonId),
  getPlayerPerLog: (playerId, seasonId) => ipcRenderer.invoke('db:get-player-per-log', playerId, seasonId),
  getPlayerSeasonHistory: (playerId) => ipcRenderer.invoke('db:get-player-season-history', playerId),
  getTeamSeasonHistory: (teamId) => ipcRenderer.invoke('db:get-team-season-history', teamId),
  getTeamPerLog: (teamId, seasonId) => ipcRenderer.invoke('db:get-team-per-log', teamId, seasonId),
  getPlayerGamesAllCompetitions: (playerId) =>
    ipcRenderer.invoke('db:get-player-games-all-competitions', playerId),
  getTeamGamesAllCompetitions: (teamId) =>
    ipcRenderer.invoke('db:get-team-games-all-competitions', teamId),

  // Supabase-backed auth — email/password handled entirely by Supabase Auth;
  // `profile` carries the signup-only extras (name, role, organization, birth date).
  signup: (email, password, profile) =>
    ipcRenderer.invoke('auth:signup', { email, password, profile }),
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  listOrganizations: () => ipcRenderer.invoke('auth:list-organizations'),

  // Teams now form by invite, not a free pick — see supabase/migrations/0007.
  createOrganization: (name) => ipcRenderer.invoke('team:create-organization', name),
  listMyInvites: () => ipcRenderer.invoke('team:list-my-invites'),
  listSentInvites: () => ipcRenderer.invoke('team:list-sent-invites'),
  createInvite: (email) => ipcRenderer.invoke('team:create-invite', email),
  acceptInvite: (inviteId) => ipcRenderer.invoke('team:accept-invite', inviteId),
  declineInvite: (inviteId) => ipcRenderer.invoke('team:decline-invite', inviteId),
  revokeInvite: (inviteId) => ipcRenderer.invoke('team:revoke-invite', inviteId),

  // Account settings: profile fields + password live on Supabase Auth/profiles.
  getProfile: () => ipcRenderer.invoke('account:get-profile'),
  updateProfile: (profile) => ipcRenderer.invoke('account:update-profile', profile),
  changePassword: (newPassword) => ipcRenderer.invoke('account:change-password', newPassword),

  // The org's annual subscription (manual/photo/pro tier).
  getSubscriptionTier: () => ipcRenderer.invoke('subscription:get-tier'),
  cancelSubscription: () => ipcRenderer.invoke('subscription:cancel'),

  // Opens Stripe Checkout / the Billing Portal in the system browser.
  checkout: (params) => ipcRenderer.invoke('subscription:checkout', params),
  openBillingPortal: () => ipcRenderer.invoke('subscription:open-portal'),

  // Pulls whatever games this account's tier/org currently entitles it to
  // see (RLS-filtered) into the local cache — see services/dataSync.js.
  pullCloudData: () => ipcRenderer.invoke('sync:pull-cloud-data'),

  // Owner-only provisioning (no Stripe) — see services/admin.js. Every
  // call is also re-checked server-side (requirePlatformAdmin), so hiding
  // the Admin page in the UI isn't the only thing stopping a non-admin.
  adminCreateAccount: (params) => ipcRenderer.invoke('admin:create-account', params),
  adminListOrganizations: () => ipcRenderer.invoke('admin:list-organizations'),
  adminUpdateOrganization: (params) => ipcRenderer.invoke('admin:update-organization', params),
  adminListSyncableTeams: () => ipcRenderer.invoke('admin:list-syncable-teams'),

  // Fires when the user completes (or cancels) a Stripe flow and is routed
  // back to the app via a boxscore-analytics:// deep link — see main.js.
  onCheckoutReturn: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('deep-link:checkout', listener);
    return () => ipcRenderer.removeListener('deep-link:checkout', listener);
  },

  // Opens a native save dialog and writes the .xlsx file.
  exportExcel: (payload, suggestedName) =>
    ipcRenderer.invoke('export:excel', { payload, suggestedName }),

  // Opens a native save dialog and writes a PNG report card image.
  exportImage: (base64Png, suggestedName) =>
    ipcRenderer.invoke('export:save-image', { base64Png, suggestedName }),

  getTeamSeasonGameCount: (teamId, seasonId) =>
    ipcRenderer.invoke('db:get-team-season-game-count', teamId, seasonId),

  // Opens a native save dialog and writes the per-metric advanced report (Excel or PDF).
  exportTeamAdvancedReport: (params) => ipcRenderer.invoke('export:team-advanced-report', params),
  exportGameBoxScore: (params) => ipcRenderer.invoke('export:game-box-score', params),

  getTeamFourFactorsReport: (teamId, seasonId) =>
    ipcRenderer.invoke('db:get-team-four-factors-report', teamId, seasonId),
  updatePlayerPosition: (playerId, position) =>
    ipcRenderer.invoke('db:update-player-position', playerId, position),
  updatePlayerDepthRank: (playerId, depthRank) =>
    ipcRenderer.invoke('db:update-player-depth-rank', playerId, depthRank),
  updatePlayerHeight: (playerId, height) => ipcRenderer.invoke('db:update-player-height', playerId, height),
  updatePlayerHidden: (playerId, hidden) => ipcRenderer.invoke('db:update-player-hidden', playerId, hidden),

  getScoutingReport: (ourTeamId, opponentTeamId, seasonId, gameDate) =>
    ipcRenderer.invoke('db:get-scouting-report', ourTeamId, opponentTeamId, seasonId, gameDate),
  getOrCreateScoutingReportRecord: (params) =>
    ipcRenderer.invoke('db:get-or-create-scouting-report-record', params),
  saveScoutingReportKeys: (reportId, keys) => ipcRenderer.invoke('db:save-scouting-report-keys', reportId, keys),
  getScoutingReportPlayerNotes: (reportId) => ipcRenderer.invoke('db:get-scouting-report-player-notes', reportId),
  saveScoutingReportPlayerNotes: (reportId, playerId, notes) =>
    ipcRenderer.invoke('db:save-scouting-report-player-notes', reportId, playerId, notes),
  saveScoutingReportPlayerPhoto: (reportId, playerId, photoDataUrl) =>
    ipcRenderer.invoke('db:save-scouting-report-player-photo', reportId, playerId, photoDataUrl),
  exportScoutingReportPdf: (params) => ipcRenderer.invoke('export:scouting-report-pdf', params),
  publishScoutingReport: (params) => ipcRenderer.invoke('publish:scouting-report', params),
  getCurrentPublishedReport: () => ipcRenderer.invoke('cloud:get-current-published-report'),
  listReportViewers: (reportId) => ipcRenderer.invoke('cloud:list-report-viewers', reportId),
  listCloudPlayers: () => ipcRenderer.invoke('cloud:list-players'),
  createPlayerAccount: (params) => ipcRenderer.invoke('cloud:create-player-account', params),

  listPlays: (teamId) => ipcRenderer.invoke('db:list-plays', teamId),
  getPlay: (playId) => ipcRenderer.invoke('db:get-play', playId),
  savePlay: (params) => ipcRenderer.invoke('db:save-play', params),
  deletePlay: (playId) => ipcRenderer.invoke('db:delete-play', playId),
});
