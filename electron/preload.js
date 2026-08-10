const { contextBridge, ipcRenderer } = require('electron');

// Everything the Angular renderer is allowed to call. No direct fs/db/net
// access from the renderer — it only ever talks through these channels.
contextBridge.exposeInMainWorld('boxscoreApi', {
  // OCR: send a base64 image, get back a parsed box score for review.
  extractBoxScore: (base64Image, mediaType) =>
    ipcRenderer.invoke('ocr:extract-box-score', base64Image, mediaType),

  // Persist a reviewed/corrected box score.
  saveGame: (game) => ipcRenderer.invoke('db:save-game', game),

  // Reads used by the dashboard / comparison views.
  getPlayerStats: (playerId) => ipcRenderer.invoke('db:get-player-stats', playerId),
  getTeamStats: (teamId) => ipcRenderer.invoke('db:get-team-stats', teamId),
  getLeagueAverages: (leagueId, seasonId) =>
    ipcRenderer.invoke('db:get-league-averages', leagueId, seasonId),
  getLeagueTeamRankings: (leagueId, seasonId) =>
    ipcRenderer.invoke('db:get-league-team-rankings', leagueId, seasonId),
  getTeamAllCompetitions: (teamId) => ipcRenderer.invoke('db:get-team-all-competitions', teamId),
  getPlayerAllCompetitions: (playerId) =>
    ipcRenderer.invoke('db:get-player-all-competitions', playerId),
  listTeams: () => ipcRenderer.invoke('db:list-teams'),
  listPlayers: (teamId) => ipcRenderer.invoke('db:list-players', teamId),

  // League / season / team management for the game-context picker.
  listLeagues: () => ipcRenderer.invoke('db:list-leagues'),
  createLeague: (league) => ipcRenderer.invoke('db:create-league', league),
  listSeasons: (leagueId) => ipcRenderer.invoke('db:list-seasons', leagueId),
  createSeason: (season) => ipcRenderer.invoke('db:create-season', season),
  createTeam: (team) => ipcRenderer.invoke('db:create-team', team),

  // Per-game history, for dashboard trend charts and recent-games tables.
  getPlayerGameLog: (playerId) => ipcRenderer.invoke('db:get-player-game-log', playerId),
  getTeamGameLog: (teamId) => ipcRenderer.invoke('db:get-team-game-log', teamId),

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

  // Base app subscription (individual/team) + the separate Upload a Photo add-on.
  getBaseSubscription: () => ipcRenderer.invoke('subscription:get-base'),
  cancelBaseSubscription: () => ipcRenderer.invoke('subscription:cancel-base'),
  getUploadStatus: () => ipcRenderer.invoke('subscription:get-upload-status'),
  cancelUploadSubscription: () => ipcRenderer.invoke('subscription:cancel-upload'),
  listUploadPlans: () => ipcRenderer.invoke('subscription:list-upload-plans'),

  // Opens Stripe Checkout / the Billing Portal in the system browser.
  checkout: (params) => ipcRenderer.invoke('subscription:checkout', params),
  openBillingPortal: () => ipcRenderer.invoke('subscription:open-portal'),

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
});
