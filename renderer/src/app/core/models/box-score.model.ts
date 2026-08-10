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

/** One team's aggregated per-game/advanced stats within a league+season, for ranking. */
export interface TeamRanking {
  teamId: number;
  teamName: string;
  games: number;
  perGame: Record<string, number>;
  advanced: AdvancedStatLine;
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
}

/**
 * The bridge exposed by electron/preload.js on window.boxscoreApi.
 * Declared here so the rest of the renderer gets type safety without
 * pulling any Electron/Node types into the Angular build.
 */
export interface BoxscoreApi {
  extractBoxScore(base64Image: string, mediaType: string): Promise<ExtractedBoxScore>;
  saveGame(game: SaveGamePayload): Promise<number>;
  getPlayerStats(playerId: number): Promise<StatSummary>;
  getTeamStats(teamId: number): Promise<StatSummary>;
  getLeagueAverages(leagueId: number, seasonId: number): Promise<StatSummary>;
  getLeagueTeamRankings(leagueId: number, seasonId: number): Promise<TeamRanking[]>;
  getTeamAllCompetitions(teamId: number): Promise<AllCompetitionsSummary | null>;
  getPlayerAllCompetitions(playerId: number): Promise<AllCompetitionsSummary | null>;
  listTeams(): Promise<Team[]>;
  listPlayers(teamId: number): Promise<Player[]>;

  listLeagues(): Promise<League[]>;
  createLeague(league: { name: string; country?: string; tier?: string }): Promise<number>;
  listSeasons(leagueId: number): Promise<Season[]>;
  createSeason(season: { leagueId: number; year: string }): Promise<number>;
  createTeam(team: { leagueId: number; name: string; isMyTeam?: boolean }): Promise<number>;

  getPlayerGameLog(playerId: number): Promise<GameLogRow[]>;
  getTeamGameLog(teamId: number): Promise<GameLogRow[]>;

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
}

declare global {
  interface Window {
    boxscoreApi: BoxscoreApi;
  }
}
