export interface PlayerBoxScore {
  name: string;
  min: number;
  pts: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  oreb: number;
  dreb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  pf: number;
  pfd: number;
  plus_minus: number;
}

export interface ExtractedBoxScore {
  team: string;
  opponent: string;
  date: string;
  players: PlayerBoxScore[];
  opponentPlayers: PlayerBoxScore[];
}

export interface AdvancedStatLine {
  // Scoring & shooting — self-contained, always present.
  ts_pct: number;
  efg_pct: number;
  fg_pct: number;
  tp_pct: number;
  ft_pct: number;
  pir: number;
  pp2ps: number;
  pp3ps: number;
  ppft: number;
  points_per_shot: number;
  points_per_poss: number;
  points_per_100poss: number;
  ft_rate: number;
  three_pt_attempt_rate: number;
  // Rebounding % / ball-handling % — need team+opponent context; null for
  // combined-across-leagues totals, which have no single opponent.
  oreb_pct: number | null;
  dreb_pct: number | null;
  treb_pct: number | null;
  ast_pct: number | null;
  tov_pct: number | null;
  stl_pct: number | null;
  blk_pct: number | null;
  /** Individual-only (a team is trivially 100% of its own usage) — always null for team subjects. */
  usg_pct: number | null;
  // DOE (Dean Oliver's Evaluation) — ORtg/DRtg + the Four Factors composite.
  // Same team+opponent-context caveat as the block above.
  ortg: number | null;
  drtg: number | null;
  doe: number | null;
}

export interface StatSummary {
  games: number;
  totals: Record<string, number>;
  perGame: Record<string, number>;
  advanced: AdvancedStatLine;
  /** Hollinger-style PER, approximated from box-score-only data. Null when not computable (e.g. combined-across-leagues totals). */
  per: number | null;
  /** From-scratch BPM-style composite (not the Sports-Reference formula — see statsEngine.js). Null for the same reason as `per`. */
  impact: number | null;
  /** Player/Team Impact Estimate — % of all game statistical events, fully computable from box-score data. Null for the same reason as `per`. */
  pie: number | null;
  /**
   * Net Rating — point differential per 100 possessions. Exact (ORtg−DRtg) for
   * a team. For a player, built from their real, measured +/- (only non-zero
   * for games imported from play-by-play — photo/manual entries never record
   * who was on court), prorated by their share of a 40-minute game since only
   * a final per-game +/- is stored, not full lineup-stint timing.
   */
  netRating: number | null;
}

export interface League {
  id: number;
  name: string;
  country: string | null;
  tier: string | null;
  source: string;
}

export interface Season {
  id: number;
  league_id: number;
  year: string;
}

export interface Team {
  id: number;
  league_id: number;
  name: string;
  is_my_team: number;
}

export interface Player {
  id: number;
  team_id: number;
  name: string;
}

/** A single past game's counting stats, with the date/opponent joined in. */
export interface GameLogRow extends PlayerBoxScore {
  game_id: number;
  date: string;
  opponent: string;
}

/** One game's PIE value for a player, for the "click PIE to see the trend" modal. */
export interface PieLogRow {
  game_id: number;
  date: string;
  opponent: string;
  pie: number;
}

/** One team's aggregated per-game/advanced stats within a league+season, for ranking. */
export interface TeamRanking {
  teamId: number;
  teamName: string;
  games: number;
  perGame: Record<string, number>;
  advanced: AdvancedStatLine;
  per: number | null;
  impact: number | null;
  pie: number | null;
}

/** One player's aggregated per-game/advanced stats within a league+season, for the leaderboard. */
export interface PlayerLeaderboardEntry {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  games: number;
  perGame: Record<string, number>;
  advanced: AdvancedStatLine;
  per: number | null;
  impact: number | null;
  pie: number | null;
}

export type ImpactRatingConfidence = 'none' | 'very_low' | 'low' | 'medium' | 'high';

/**
 * One player's real, from-scratch RAPM-based "Impact Rating" — the same
 * core technique LEBRON/EPM are built on (box score + adjusted plus-minus),
 * computed only from games actually imported via play-by-play. `rating` is
 * null, never a fabricated 0, when the player has no play-by-play games at
 * all. `confidence` reflects how many play-by-play games actually back the
 * number — treat 'very_low'/'low' as noise, not signal.
 */
export interface ImpactRatingEntry {
  playerId: number;
  playerName: string;
  teamName: string;
  totalGames: number;
  gamesWithPbp: number;
  rating: number | null;
  confidence: ImpactRatingConfidence;
}

/** Both rosters' full stat lines for one saved game, for the shareable game report card. */
export interface GameBoxScore {
  gameId: number;
  date: string;
  leagueName: string;
  seasonYear: string;
  homeTeamName: string;
  awayTeamName: string;
  homeRoster: PlayerBoxScore[];
  awayRoster: PlayerBoxScore[];
  homeTotals: Record<string, number>;
  awayTotals: Record<string, number>;
}

/** One player across the whole app (not scoped to a team), for the player search on the Insights screen. */
export interface PlayerListEntry {
  id: number;
  name: string;
  teamId: number;
  teamName: string;
}

/** One saved game, for the game picker on the Game Insights screen. */
export interface GameListEntry {
  gameId: number;
  date: string;
  homeTeamName: string;
  awayTeamName: string;
  leagueName: string;
  seasonYear: string;
}

/** One deterministic, rule-based observation about a game — no LLM involved, see electron/services/insights.js. */
export interface GameInsight {
  scope: 'team' | 'player';
  team: 'home' | 'away';
  playerName: string | null;
  polarity: 'positive' | 'negative';
  stat: string;
  text: string;
}

export interface GameInsightsResult {
  gameId: number;
  date: string;
  leagueName: string;
  seasonYear: string;
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  winner: 'home' | 'away' | 'tie';
  insights: GameInsight[];
}

/** A strength/weakness observation vs a league average — used by both team and player scouting reports. */
export interface ProfileInsight {
  stat: string;
  polarity: 'strength' | 'weakness';
  text: string;
}

/** A fact about how a subject's own numbers differ in losses vs wins — the "how to beat them" angle. */
export interface PatternInsight {
  stat: string;
  text: string;
}

export interface ScoutingKeyPlayer {
  playerId: number;
  playerName: string;
  pts: number;
  reb: number;
  ast: number;
  pie: number | null;
}

export interface TeamScoutingReport {
  teamId: number;
  teamName: string;
  leagueName: string;
  games: number;
  wins: number;
  losses: number;
  profileInsights: ProfileInsight[];
  keyPlayers: ScoutingKeyPlayer[];
  lossPatternInsights: PatternInsight[];
}

export interface PlayerScoutingReport {
  playerId: number;
  playerName: string;
  teamName: string;
  leagueName: string;
  games: number;
  profileInsights: ProfileInsight[];
  winVsLossInsights: PatternInsight[];
}

/** One competition's worth of a team's/player's stats, for the all-competitions breakdown. */
export interface CompetitionBreakdown extends StatSummary {
  leagueId: number;
  leagueName: string;
}

/** Combined totals across every competition a team/player appears in, plus the per-competition split. */
export interface AllCompetitionsSummary {
  combined: StatSummary;
  perLeague: CompetitionBreakdown[];
}

export interface Organization {
  id: string;
  name: string;
}

/**
 * Extra profile fields collected at signup, stored on public.profiles via
 * a DB trigger. Team membership is NOT set here — joining a team requires
 * accepting an invite or creating a new one (see TeamInvite below).
 */
export interface SignupProfile {
  firstName: string;
  lastName: string;
  birthDate?: string | null;
  role?: string | null;
}

export interface TeamInvite {
  id: string;
  organization_id?: string;
  organizations?: { name: string } | null;
  email?: string;
  status: 'pending' | 'accepted' | 'revoked';
  created_at: string;
}

export interface Profile {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  birth_date: string | null;
  role: string | null;
  organization_id: string | null;
  organizations: { name: string } | null;
}

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'inactive';

export interface BaseSubscription {
  source: 'guest' | 'none' | 'individual' | 'team';
  id?: string;
  tier?: 'individual' | 'team';
  billing_interval?: 'month' | 'year';
  status?: SubscriptionStatus;
  seat_count?: number;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  organizationName?: string | null;
}

export interface UploadPlan {
  id: string;
  name: string;
  monthly_upload_limit: number;
  price_cents: number;
  currency: string;
}

export interface UploadStatus {
  source: 'guest' | 'none' | 'active';
  planName?: string | null;
  limit?: number;
  used: number;
  remaining?: number;
  exhausted?: boolean;
  status?: SubscriptionStatus;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
}

export interface SaveGamePayload {
  leagueId: number;
  seasonId: number;
  team: string;
  opponent: string;
  date: string;
  players: PlayerBoxScore[];
  opponentPlayers: PlayerBoxScore[];
  /** Only present for play-by-play imports — the raw substitution/scoring timeline, stored for future on/off analysis. */
  events?: GameEvent[];
}

/** One substitution or scoring event from a play-by-play import — the minimal primitives for a future on/off or RAPM calculation. */
export interface GameEvent {
  side: 'home' | 'away';
  playerName: string | null;
  clockSeconds: number;
  type: 'sub_in' | 'sub_out' | 'score';
  points: number | null;
  sequence: number;
}

/** What extractPlayByPlay returns — a normal ExtractedBoxScore plus the raw event timeline. */
export interface PbpExtractedBoxScore extends ExtractedBoxScore {
  events: GameEvent[];
}

/**
 * The bridge exposed by electron/preload.js on window.boxscoreApi.
 * Declared here so the rest of the renderer gets type safety without
 * pulling any Electron/Node types into the Angular build.
 */
export interface BoxscoreApi {
  extractBoxScore(base64Image: string, mediaType: string): Promise<ExtractedBoxScore>;
  extractPlayByPlay(base64File: string): Promise<PbpExtractedBoxScore>;
  saveGame(game: SaveGamePayload): Promise<number>;
  getPlayerStats(playerId: number): Promise<StatSummary>;
  getTeamStats(teamId: number): Promise<StatSummary>;
  getLeagueAverages(leagueId: number, seasonId: number): Promise<StatSummary>;
  getLeaguePlayerAverages(leagueId: number, seasonId: number): Promise<StatSummary>;
  getLeagueTeamRankings(leagueId: number, seasonId: number): Promise<TeamRanking[]>;
  getLeaguePlayerLeaderboard(leagueId: number, seasonId: number): Promise<PlayerLeaderboardEntry[]>;
  getLeagueImpactRatings(leagueId: number, seasonId: number): Promise<ImpactRatingEntry[]>;
  getGameBoxScore(gameId: number): Promise<GameBoxScore | null>;
  listGames(): Promise<GameListEntry[]>;
  getGameInsights(gameId: number): Promise<GameInsightsResult | null>;
  getTeamScoutingReport(teamId: number): Promise<TeamScoutingReport | null>;
  getPlayerScoutingReport(playerId: number): Promise<PlayerScoutingReport | null>;
  getTeamAllCompetitions(teamId: number): Promise<AllCompetitionsSummary | null>;
  getPlayerAllCompetitions(playerId: number): Promise<AllCompetitionsSummary | null>;
  listTeams(): Promise<Team[]>;
  listPlayers(teamId: number): Promise<Player[]>;
  listAllPlayers(): Promise<PlayerListEntry[]>;

  listLeagues(): Promise<League[]>;
  createLeague(league: { name: string; country?: string; tier?: string }): Promise<number>;
  listSeasons(leagueId: number): Promise<Season[]>;
  createSeason(season: { leagueId: number; year: string }): Promise<number>;
  createTeam(team: { leagueId: number; name: string; isMyTeam?: boolean }): Promise<number>;

  getPlayerGameLog(playerId: number): Promise<GameLogRow[]>;
  getTeamGameLog(teamId: number): Promise<GameLogRow[]>;
  getPlayerPieLog(playerId: number): Promise<PieLogRow[]>;

  signup(email: string, password: string, profile: SignupProfile): Promise<{ id: string; email: string }>;
  login(email: string, password: string): Promise<{ id: string; email: string }>;
  logout(): Promise<void>;
  listOrganizations(): Promise<Organization[]>;

  createOrganization(name: string): Promise<Organization>;
  listMyInvites(): Promise<TeamInvite[]>;
  listSentInvites(): Promise<TeamInvite[]>;
  createInvite(email: string): Promise<void>;
  acceptInvite(inviteId: string): Promise<void>;
  declineInvite(inviteId: string): Promise<void>;
  revokeInvite(inviteId: string): Promise<void>;

  getProfile(): Promise<Profile | null>;
  updateProfile(profile: SignupProfile): Promise<void>;
  changePassword(newPassword: string): Promise<void>;

  getBaseSubscription(): Promise<BaseSubscription>;
  cancelBaseSubscription(): Promise<void>;
  getUploadStatus(): Promise<UploadStatus>;
  cancelUploadSubscription(): Promise<void>;
  listUploadPlans(): Promise<UploadPlan[]>;

  checkout(
    params:
      | { kind: 'base'; tier: 'individual' | 'team'; interval: 'month' | 'year'; seatCount?: number }
      | { kind: 'upload'; planId: string }
  ): Promise<void>;
  openBillingPortal(): Promise<void>;
  onCheckoutReturn(callback: (status: string | null) => void): () => void;

  exportExcel(
    payload: ExtractedBoxScore | StatSummary,
    suggestedName?: string
  ): Promise<{ saved: boolean; filePath?: string }>;
  exportImage(base64Png: string, suggestedName?: string): Promise<{ saved: boolean; filePath?: string }>;
}

declare global {
  interface Window {
    boxscoreApi: BoxscoreApi;
  }
}
