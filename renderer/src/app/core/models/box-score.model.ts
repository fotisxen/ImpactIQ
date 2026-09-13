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
  srj: number;
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
  league_name?: string;
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

/** One game's PER value for a player — that single game's box score run through the season's rate constants. */
export interface PerLogRow {
  game_id: number;
  date: string;
  opponent: string;
  per: number | null;
}

/** One season's headline summary for a player or team — the raw material for the Dashboard's "History" tab. */
export interface SeasonHistoryRow {
  seasonId: number;
  seasonYear: string;
  games: number;
  pts: number;
  per: number | null;
  pie: number | null;
  netRating: number | null;
}

export type ShotZoneKey = 'at_rim' | 'mid_range' | 'corner_3' | 'wing_3' | 'top_key_3';

export interface ShotZoneEntry {
  zone: ShotZoneKey;
  fgm: number;
  fga: number;
  fgPct: number | null;
  frequency: number | null;
  heat: 'hot' | 'cold' | 'neutral';
}

export interface ShotZoneChart {
  hasData: boolean;
  chart: ShotZoneEntry[];
}

/** One individual shot attempt, already in the app's shared half-court coordinate space (0-300 wide, 0-320 deep, basket at 150,20). */
export interface ShotEvent {
  x: number;
  y: number;
  made: number; // 0 or 1 (SQLite has no real boolean)
  value: number; // 2 or 3
}

export interface ScoutingRosterPlayer {
  playerId: number;
  name: string;
  position: string | null;
  depthRank: number | null;
  height: string | null;
  hidden: boolean;
  games: number;
  perGame: Record<string, number>;
  totals: Record<string, number>;
}

export interface ScoutingDepthChartRow {
  position: string;
  players: { playerId: number; name: string }[];
}

export interface ScoutingRecentGame {
  date: string;
  opponent: string;
  site: 'Home' | 'Away';
  won: boolean;
  score: string;
}

export interface OffDefFourFactorsSide {
  efgPct: number | null;
  tsPct: number | null;
  tovPct: number | null;
  astPct: number | null;
  trebPct: number | null;
  ftRate: number | null;
  ftPct: number | null;
}

export interface ScoutingTeamStatsRow {
  games: number;
  pts: number;
  fgm: number;
  fga: number;
  fgPct: number | null;
  tpm: number;
  tpa: number;
  tpPct: number | null;
  ftm: number;
  fta: number;
  ftPct: number | null;
  ast: number;
  oreb: number;
  dreb: number;
  reb: number;
  stl: number;
  blk: number;
  tov: number;
  pace: number;
  ortg: number;
  drtg: number;
  ppp: number;
  efgPct2: number | null;
  pointsOffTurnovers: number | null;
  secondChancePoints: number | null;
  fastbreakPoints: number | null;
  pointsInThePaint: number | null;
  /** True when the 4 stats above came from a real data provider's own per-shot flags
   *  (e.g. an imported EuroLeague season) rather than the app's own clock-threshold estimate. */
  advancedStatsAreOfficial: boolean;
}

export interface ScoutingLeaderEntry {
  playerId: number;
  name: string;
  [key: string]: unknown;
}

export interface ScoutingPlayerPageMeeting {
  date: string;
  site: string;
  perGame: Record<string, number>;
  advanced: AdvancedStatLine;
}

export interface ScoutingPlayerPage {
  playerId: number;
  name: string;
  position: string | null;
  height: string | null;
  games: number;
  perGame: Record<string, number>;
  advanced: AdvancedStatLine;
  meetings: ScoutingPlayerPageMeeting[];
}

export interface ScoutingReport {
  ourTeamId: number;
  ourTeamName: string;
  opponentTeamId: number;
  opponentTeamName: string;
  seasonId: number;
  seasonYear: string;
  gameDate: string;
  record: { wins: number; losses: number };
  roster: ScoutingRosterPlayer[];
  teamTotalsPerGame: Record<string, number>;
  opponentAveragePerGame: Record<string, number>;
  depthChart: ScoutingDepthChartRow[];
  recentGames: ScoutingRecentGame[];
  impactIqFactors: {
    us: { off: OffDefFourFactorsSide; def: OffDefFourFactorsSide };
    opponent: { off: OffDefFourFactorsSide; def: OffDefFourFactorsSide };
  };
  teamStats: {
    allOff: ScoutingTeamStatsRow | null;
    last5: ScoutingTeamStatsRow | null;
    meetings: { date: string; site: string; ourTeamName: string; stats: ScoutingTeamStatsRow | null }[];
  };
  pointsPerPeriod: { games: number; team: number[]; opponent: number[] } | null;
  teamPace: { us: number; opponent: number };
  advStatsRow: {
    wins: number;
    losses: number;
    pythagoreanWinPct: number | null;
    ortg: number | null;
    drtg: number | null;
    pace: number;
    ftRate: number | null;
    threePtRate: number | null;
    possessions: number;
    netRating: number | null;
  };
  leaders: {
    topScorers: ScoutingLeaderEntry[];
    threePtShooters: ScoutingLeaderEntry[];
    ftShooters: ScoutingLeaderEntry[];
    topRebounders: ScoutingLeaderEntry[];
    ballControl: ScoutingLeaderEntry[];
    defense: ScoutingLeaderEntry[];
  };
  playerPages: ScoutingPlayerPage[];
}

export interface ScoutingReportRecord {
  id: number;
  our_team_id: number;
  opponent_team_id: number;
  season_id: number;
  game_date: string;
  keysToGame: string[];
}

export interface ScoutingReportPlayerNote {
  playerId: number;
  notes: string[];
  photoPath: string | null;
}

// ---------------------------------------------------------------------------
// Draw (play diagramming) — one play is a sequence of court "frames"; a coach
// drags players/ball into position on each frame and draws movement/pass/
// screen/dribble lines, then adds another frame (pre-seeded with the last
// frame's positions) to continue the same play into its next phase.
// ---------------------------------------------------------------------------

export type PlayDrawingType = 'move' | 'pass' | 'screen' | 'dribble' | 'text';

export interface PlayDrawing {
  id: string;
  type: PlayDrawingType;
  /** For every type except 'text': the drawn line's endpoints, in the court's 0-300 x 0-320 viewBox. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Only for type 'text': the label content, placed at (x1, y1). */
  text?: string;
}

export interface PlayFrame {
  players: { id: number; x: number; y: number }[];
  ball: { x: number; y: number };
  drawings: PlayDrawing[];
}

export interface PlayData {
  frames: PlayFrame[];
}

/** One row in the playbook list — no `data` (frames can be large; fetched separately via getPlay). */
export interface PlaybookEntry {
  id: number;
  teamId: number | null;
  name: string;
  updatedAt: string;
}

export interface PlaybookPlay {
  id: number;
  teamId: number | null;
  name: string;
  data: PlayData;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Scouting report distribution — publishing a report to a club's players
// (Supabase-backed, separate from the local SQLite data everything else in
// this file describes).
// ---------------------------------------------------------------------------

export interface PublishedReport {
  id: string;
  opponent_name: string | null;
  game_date: string | null;
  published_at: string;
}

export interface ReportViewer {
  viewerId: string;
  firstName: string;
  lastName: string;
  email: string;
  viewedAt: string;
}

export interface CloudPlayer {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
}

/** One game a player has data for, flattened across every league/cup they appear in — for the Player "Games" tab. */
export interface PlayerCrossCompetitionGameRow {
  game_id: number;
  date: string;
  leagueName: string;
  opponent: string;
  pts: number;
  reb: number;
  ast: number;
}

/** One game a team has data for, flattened across every league/cup it appears in — for the Team "Games" tab. */
export interface TeamCrossCompetitionGameRow {
  game_id: number;
  date: string;
  leagueName: string;
  opponent: string;
  teamPts: number;
  oppPts: number;
  won: boolean;
}

/**
 * One metric on the Four Factors page — never a fabricated number standing
 * in for missing data. `available: false` means `value` is always null;
 * `reason` explains why (e.g. needs shot-location/tracking data this app's
 * three input methods can't produce, or needs a play-by-play import that
 * hasn't happened yet for this team/season).
 */
export interface FourFactorsMetric {
  label: string;
  value: number | null;
  available: boolean;
  isPercent: boolean;
  reason?: string;
}

/** A distinct 5-man on-court unit and its combined minutes/net rating, from PBP-imported games only. */
export interface LineupCombo {
  playerNames: string[];
  minutes: number;
  netRatingPer100: number | null;
}

/** Context Metrics' "Lineup Combinations" entry — either a populated list (PBP data exists) or the same N/A shape as every other metric. */
export type LineupCombosMetric = FourFactorsMetric & { lineups?: LineupCombo[] };

/** One weighted Four Factors combo card (Shooting/Ball Handling/Rebounding/FT Rate) — the factor itself plus its blended sub-metrics. */
export interface FourFactorsCombo {
  label: string;
  weightPct: number;
  primary: FourFactorsMetric;
  subMetrics: FourFactorsMetric[];
}

export interface FourFactorsRosterPlayer {
  playerId: number;
  playerName: string;
  position: string | null;
}

/** The Four Factors page's full report for one team/season. */
export interface TeamFourFactorsReport {
  teamName: string;
  seasonYear: string;
  primaryMetrics: FourFactorsMetric[];
  contextMetrics: LineupCombosMetric[];
  strategicMetrics: FourFactorsMetric[];
  combos: FourFactorsCombo[];
  roster: FourFactorsRosterPlayer[];
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

/** Every team's rank at every date across a season — the raw material for a bump chart. */
export interface LeagueStandingsHistory {
  dates: string[];
  teams: { teamId: number; teamName: string; ranks: (number | null)[] }[];
}

/**
 * A generic, non-calibrated win-probability estimate across one game's real
 * score timeline — only available for games with play-by-play data. Not a
 * model fitted on this league's own historical outcomes (not enough games
 * for that yet), just a standard logistic curve from score margin and time
 * remaining. Treat as illustrative, not precise.
 */
export interface GameWinProbability {
  gameId: number;
  gameDurationSeconds: number;
  points: { clockSeconds: number; homeWinProb: number }[];
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
  /** False only when there are genuinely fewer than 2 wins or 2 losses — distinguishes "not enough games" from "enough games, no pattern found" for winVsLossInsights being empty. */
  hasEnoughWinLossGames: boolean;
  /** Advanced metrics whose season trend doesn't match the playing-time trend — e.g. eFG% rising with flat minutes. Needs at least 5 games; silently empty otherwise. */
  playingTimeInsights: PatternInsight[];
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
export type Tier = 'manual' | 'photo' | 'pro';

/** Every subscription is an organization (club) purchase — even a solo coach subscribes as an org of one. */
export interface AccountSubscription {
  source: 'guest' | 'none' | 'active';
  tier?: Tier;
  status?: SubscriptionStatus;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  organizationId?: string | null;
  organizationName?: string | null;
  isPlatformAdmin?: boolean;
}

/** One row in the owner-only Admin page's organization table (see admin-list-organizations). */
export interface AdminOrganizationRow {
  id: string;
  name: string;
  defaultTeamId: number | null;
  defaultTeamName: string | null;
  tier: Tier | null;
  status: SubscriptionStatus | null;
  currentPeriodEnd: string | null;
  memberCount: number;
}

/** A team, for the Admin page's "default team" picker. */
export interface AdminTeam {
  id: number;
  name: string;
  league_name: string | null;
}

export interface CreateAccountParams {
  email: string;
  firstName: string;
  lastName: string;
  role?: string;
  organizationId?: string;
  organizationName?: string;
  tier: Tier;
  defaultTeamId?: number;
}

export interface SaveGamePayload {
  leagueId: number;
  seasonId: number;
  team: string;
  opponent: string;
  date: string;
  players: PlayerBoxScore[];
  opponentPlayers: PlayerBoxScore[];
  /** Which entry method produced this game — drives tier gating (Photo tier only for 'photo'). */
  source: 'manual' | 'photo';
  /** Only present for play-by-play imports — the raw substitution/scoring timeline, stored for future on/off analysis. */
  events?: GameEvent[];
}

/**
 * One substitution or shot-attempt event from a play-by-play import — the
 * primitives for a future on/off, RAPM, or luck-adjustment calculation.
 * `'miss'` (a missed FG/FT) is tracked alongside `'score'` (a made one) so a
 * team's real shot attempts while a lineup was on court are derivable, not
 * just its makes.
 */
export interface GameEvent {
  side: 'home' | 'away';
  playerName: string | null;
  clockSeconds: number;
  type: 'sub_in' | 'sub_out' | 'score' | 'miss' | 'assist' | 'turnover_live' | 'turnover_dead';
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
  getPlayerStats(playerId: number, seasonId?: number | null): Promise<StatSummary>;
  getTeamStats(teamId: number, seasonId?: number | null): Promise<StatSummary>;
  getLeagueAverages(leagueId: number, seasonId: number): Promise<StatSummary>;
  getLeaguePlayerAverages(leagueId: number, seasonId: number): Promise<StatSummary>;
  getLeagueTeamRankings(leagueId: number, seasonId: number): Promise<TeamRanking[]>;
  getLeaguePlayerLeaderboard(leagueId: number, seasonId: number): Promise<PlayerLeaderboardEntry[]>;
  getLeagueImpactRatings(leagueId: number, seasonId: number): Promise<ImpactRatingEntry[]>;
  getLeagueStandingsHistory(leagueId: number, seasonId: number): Promise<LeagueStandingsHistory>;
  getGameWinProbability(gameId: number): Promise<GameWinProbability | null>;
  getGameBoxScore(gameId: number): Promise<GameBoxScore | null>;
  listGames(): Promise<GameListEntry[]>;
  getGameInsights(gameId: number): Promise<GameInsightsResult | null>;
  getTeamScoutingReport(teamId: number): Promise<TeamScoutingReport | null>;
  getPlayerScoutingReport(playerId: number): Promise<PlayerScoutingReport | null>;
  getTeamScoutingReportAllCompetitions(teamName: string): Promise<TeamScoutingReport | null>;
  getPlayerScoutingReportAllCompetitions(playerName: string, teamName: string): Promise<PlayerScoutingReport | null>;
  getTeamAllCompetitions(teamId: number): Promise<AllCompetitionsSummary | null>;
  getPlayerAllCompetitions(playerId: number): Promise<AllCompetitionsSummary | null>;
  listTeams(): Promise<Team[]>;
  listPlayers(teamId: number): Promise<Player[]>;
  listAllPlayers(): Promise<PlayerListEntry[]>;
  getFavoriteTeam(): Promise<Team | null>;
  setFavoriteTeam(teamId: number): Promise<{ saved: boolean }>;
  importShotZones(params: {
    teamId: number;
    seasonId: number;
    rows: { subjectId: number; isPlayer: boolean; zone: ShotZoneKey; fgm: number; fga: number }[];
  }): Promise<{ saved: boolean }>;
  getTeamShotZones(teamId: number, seasonId: number): Promise<ShotZoneChart>;
  getPlayerShotZones(playerId: number, seasonId: number): Promise<ShotZoneChart>;
  getTeamShotEvents(teamId: number, seasonId: number): Promise<ShotEvent[]>;
  getPlayerShotEvents(playerId: number, seasonId: number): Promise<ShotEvent[]>;

  updatePlayerDepthRank(playerId: number, depthRank: number | null): Promise<{ saved: boolean }>;
  updatePlayerHeight(playerId: number, height: string | null): Promise<{ saved: boolean }>;
  updatePlayerHidden(playerId: number, hidden: boolean): Promise<{ saved: boolean }>;
  getScoutingReport(
    ourTeamId: number,
    opponentTeamId: number,
    seasonId: number,
    gameDate: string
  ): Promise<ScoutingReport | null>;
  getOrCreateScoutingReportRecord(params: {
    ourTeamId: number;
    opponentTeamId: number;
    seasonId: number;
    gameDate: string;
  }): Promise<ScoutingReportRecord>;
  saveScoutingReportKeys(reportId: number, keys: string[]): Promise<{ saved: boolean }>;
  getScoutingReportPlayerNotes(reportId: number): Promise<ScoutingReportPlayerNote[]>;
  saveScoutingReportPlayerNotes(reportId: number, playerId: number, notes: string[]): Promise<{ saved: boolean }>;
  saveScoutingReportPlayerPhoto(
    reportId: number,
    playerId: number,
    photoDataUrl: string | null
  ): Promise<{ saved: boolean }>;
  exportScoutingReportPdf(params: {
    ourTeamId: number;
    opponentTeamId: number;
    seasonId: number;
    gameDate: string;
  }): Promise<{ saved: boolean; filePath?: string }>;
  publishScoutingReport(params: {
    ourTeamId: number;
    opponentTeamId: number;
    seasonId: number;
    gameDate: string;
  }): Promise<{ published: boolean; id?: string; published_at?: string }>;
  getCurrentPublishedReport(): Promise<PublishedReport | null>;
  listReportViewers(reportId: string): Promise<ReportViewer[]>;
  listCloudPlayers(): Promise<CloudPlayer[]>;
  createPlayerAccount(params: { email: string; firstName: string; lastName: string }): Promise<{ email: string; password: string }>;

  listPlays(teamId?: number | null): Promise<PlaybookEntry[]>;
  getPlay(playId: number): Promise<PlaybookPlay | null>;
  savePlay(params: { id?: number | null; teamId?: number | null; name: string; data: PlayData }): Promise<{ id: number }>;
  deletePlay(playId: number): Promise<{ deleted: boolean }>;

  listLeagues(): Promise<League[]>;
  createLeague(league: { name: string; country?: string; tier?: string }): Promise<number>;
  listSeasons(leagueId: number): Promise<Season[]>;
  createSeason(season: { leagueId: number; year: string }): Promise<number>;
  createTeam(team: { leagueId: number; name: string; isMyTeam?: boolean }): Promise<number>;

  getPlayerGameLog(playerId: number, seasonId?: number | null): Promise<GameLogRow[]>;
  getTeamGameLog(teamId: number, seasonId?: number | null): Promise<GameLogRow[]>;
  getPlayerPieLog(playerId: number, seasonId?: number | null): Promise<PieLogRow[]>;
  getPlayerPerLog(playerId: number, seasonId?: number | null): Promise<PerLogRow[]>;
  getTeamPerLog(teamId: number, seasonId?: number | null): Promise<PerLogRow[]>;
  getPlayerSeasonHistory(playerId: number): Promise<SeasonHistoryRow[]>;
  getTeamSeasonHistory(teamId: number): Promise<SeasonHistoryRow[]>;
  getPlayerGamesAllCompetitions(playerId: number): Promise<PlayerCrossCompetitionGameRow[]>;
  getTeamGamesAllCompetitions(teamId: number): Promise<TeamCrossCompetitionGameRow[]>;

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

  getSubscriptionTier(): Promise<AccountSubscription>;
  cancelSubscription(): Promise<void>;

  checkout(params: { tier: Tier }): Promise<void>;
  openBillingPortal(): Promise<void>;
  onCheckoutReturn(callback: (status: string | null) => void): () => void;

  adminCreateAccount(params: CreateAccountParams): Promise<{ email: string; password: string; organizationId: string }>;
  adminListOrganizations(): Promise<AdminOrganizationRow[]>;
  adminUpdateOrganization(params: { organizationId: string; tier?: Tier; defaultTeamId?: number | null }): Promise<void>;
  adminListTeams(): Promise<AdminTeam[]>;

  exportExcel(
    payload: ExtractedBoxScore | StatSummary,
    suggestedName?: string
  ): Promise<{ saved: boolean; filePath?: string }>;
  exportImage(base64Png: string, suggestedName?: string): Promise<{ saved: boolean; filePath?: string }>;

  getTeamSeasonGameCount(teamId: number, seasonId: number): Promise<number>;
  exportTeamAdvancedReport(params: {
    format: 'excel' | 'pdf';
    teamId: number;
    seasonId: number;
    throughGame: number;
  }): Promise<{ saved: boolean; filePath?: string }>;
  exportGameBoxScore(params: {
    format: 'excel' | 'pdf';
    gameId: number;
  }): Promise<{ saved: boolean; filePath?: string }>;

  getTeamFourFactorsReport(teamId: number, seasonId: number): Promise<TeamFourFactorsReport | null>;
  updatePlayerPosition(playerId: number, position: string | null): Promise<{ saved: boolean }>;
}

declare global {
  interface Window {
    boxscoreApi: BoxscoreApi;
  }
}
