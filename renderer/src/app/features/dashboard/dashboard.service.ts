import { Injectable, computed, inject, signal } from '@angular/core';
import { EntitiesService } from '../../core/data/entities.service';
import {
  AllCompetitionsSummary,
  GameLogRow,
  League,
  Player,
  Season,
  StatSummary,
  Team,
  TeamRanking,
} from '../../core/models/box-score.model';
import { PickerOption } from '../../shared/components/entity-picker.component';

export type DashboardMode = 'player' | 'team' | 'league';
/** 'competition' = the currently selected league only; 'all' = combined across every competition. */
export type DashboardScope = 'competition' | 'all';

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly entities = inject(EntitiesService);

  readonly mode = signal<DashboardMode>('player');

  readonly teams = signal<Team[]>([]);
  readonly players = signal<Player[]>([]);
  readonly leagues = signal<League[]>([]);
  readonly seasons = signal<Season[]>([]);

  readonly selectedTeamId = signal<number | null>(null);
  readonly selectedPlayerId = signal<number | null>(null);
  readonly selectedLeagueId = signal<number | null>(null);
  readonly selectedSeasonId = signal<number | null>(null);

  readonly loading = signal(false);
  /** The entity being viewed: player, team, or league averages, per `mode`. */
  readonly primary = signal<StatSummary | null>(null);
  /** Comparison baseline: player's team when mode is 'player', league when mode is 'team'. */
  readonly teamBaseline = signal<StatSummary | null>(null);
  readonly leagueBaseline = signal<StatSummary | null>(null);
  readonly gameLog = signal<GameLogRow[]>([]);
  /** Every team in the selected league/season, ranked — only populated in 'league' mode. */
  readonly teamRankings = signal<TeamRanking[]>([]);

  /** 'competition'-scope is the existing per-league view; 'all' combines every competition. Player/Team mode only. */
  readonly scope = signal<DashboardScope>('competition');
  readonly allCompetitions = signal<AllCompetitionsSummary | null>(null);

  /** In Player/Team mode this is scoped to `selectedLeagueId`; empty until a league is picked. */
  readonly teamOptions = computed<PickerOption[]>(() => {
    const leagueId = this.selectedLeagueId();
    if (leagueId === null) return [];
    return this.teams()
      .filter((t) => t.league_id === leagueId)
      .map((t) => ({ id: t.id, label: t.name }));
  });
  readonly playerOptions = computed<PickerOption[]>(() =>
    this.players().map((p) => ({ id: p.id, label: p.name }))
  );
  readonly seasonOptions = computed<PickerOption[]>(() =>
    this.seasons().map((s) => ({ id: s.id, label: s.year }))
  );

  async init(): Promise<void> {
    const [teams, leagues] = await Promise.all([this.entities.listTeams(), this.entities.listLeagues()]);
    this.teams.set(teams);
    this.leagues.set(leagues);
  }

  setMode(mode: DashboardMode): void {
    this.mode.set(mode);
    this.selectedTeamId.set(null);
    this.selectedPlayerId.set(null);
    this.selectedLeagueId.set(null);
    this.selectedSeasonId.set(null);
    this.players.set([]);
    this.seasons.set([]);
    this.scope.set('competition');
    this.clearResults();
  }

  /** Switches between "this competition" and "all competitions combined" for Player/Team mode. */
  async setScope(scope: DashboardScope): Promise<void> {
    this.scope.set(scope);
    if (scope !== 'all') return;
    await this.loadAllCompetitions();
  }

  async selectTeam(teamId: number | null): Promise<void> {
    this.selectedTeamId.set(teamId);
    this.selectedPlayerId.set(null);
    this.scope.set('competition');
    this.clearResults();
    if (teamId === null) {
      this.players.set([]);
      this.seasons.set([]);
      return;
    }

    const team = this.teams().find((t) => t.id === teamId) ?? null;
    const [players] = await Promise.all([
      this.entities.listPlayers(teamId),
      team ? this.loadSeasonsForLeague(team.league_id) : Promise.resolve(),
    ]);
    this.players.set(players);

    if (this.mode() === 'team') await this.loadTeam(teamId);
  }

  async selectPlayer(playerId: number | null): Promise<void> {
    this.selectedPlayerId.set(playerId);
    this.scope.set('competition');
    this.allCompetitions.set(null);
    if (playerId !== null) {
      await this.loadPlayer(playerId);
    } else {
      this.primary.set(null);
      this.teamBaseline.set(null);
      this.gameLog.set([]);
    }
  }

  async selectLeague(leagueId: number | null): Promise<void> {
    this.selectedLeagueId.set(leagueId);
    this.selectedTeamId.set(null);
    this.selectedPlayerId.set(null);
    this.players.set([]);
    this.clearResults();
    if (leagueId === null) {
      this.seasons.set([]);
      this.selectedSeasonId.set(null);
      return;
    }
    if (this.mode() === 'league') await this.loadSeasonsForLeague(leagueId);
  }

  async selectSeason(seasonId: number | null): Promise<void> {
    this.selectedSeasonId.set(seasonId);
    await this.refreshLeagueBaseline();
    const leagueId = this.selectedLeagueId();
    if (this.mode() === 'league' && seasonId !== null && leagueId !== null) {
      await this.loadLeagueSummary(leagueId, seasonId);
    }
  }

  private async loadSeasonsForLeague(leagueId: number): Promise<void> {
    const seasons = await this.entities.listSeasons(leagueId);
    this.seasons.set(seasons);
    await this.selectSeason(seasons[0]?.id ?? null);
  }

  private async loadPlayer(playerId: number): Promise<void> {
    this.loading.set(true);
    try {
      const [summary, log] = await Promise.all([
        window.boxscoreApi.getPlayerStats(playerId),
        window.boxscoreApi.getPlayerGameLog(playerId),
      ]);
      this.primary.set(summary);
      this.gameLog.set(log);

      const teamId = this.selectedTeamId();
      if (teamId !== null) this.teamBaseline.set(await window.boxscoreApi.getTeamStats(teamId));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadTeam(teamId: number): Promise<void> {
    this.loading.set(true);
    try {
      const [summary, log] = await Promise.all([
        window.boxscoreApi.getTeamStats(teamId),
        window.boxscoreApi.getTeamGameLog(teamId),
      ]);
      this.primary.set(summary);
      this.gameLog.set(log);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadLeagueSummary(leagueId: number, seasonId: number): Promise<void> {
    this.loading.set(true);
    try {
      const [summary, rankings] = await Promise.all([
        window.boxscoreApi.getLeagueAverages(leagueId, seasonId),
        window.boxscoreApi.getLeagueTeamRankings(leagueId, seasonId),
      ]);
      this.primary.set(summary);
      this.teamRankings.set(rankings);
      this.gameLog.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadAllCompetitions(): Promise<void> {
    this.loading.set(true);
    try {
      if (this.mode() === 'player') {
        const playerId = this.selectedPlayerId();
        this.allCompetitions.set(
          playerId !== null ? await window.boxscoreApi.getPlayerAllCompetitions(playerId) : null
        );
      } else if (this.mode() === 'team') {
        const teamId = this.selectedTeamId();
        this.allCompetitions.set(
          teamId !== null ? await window.boxscoreApi.getTeamAllCompetitions(teamId) : null
        );
      }
    } finally {
      this.loading.set(false);
    }
  }

  private async refreshLeagueBaseline(): Promise<void> {
    if (this.mode() === 'league') {
      this.leagueBaseline.set(null);
      return;
    }
    const leagueId = this.currentLeagueId();
    const seasonId = this.selectedSeasonId();
    if (leagueId === null || seasonId === null) {
      this.leagueBaseline.set(null);
      return;
    }
    this.leagueBaseline.set(await window.boxscoreApi.getLeagueAverages(leagueId, seasonId));
  }

  private currentLeagueId(): number | null {
    const teamId = this.selectedTeamId();
    return this.teams().find((t) => t.id === teamId)?.league_id ?? null;
  }

  private clearResults(): void {
    this.primary.set(null);
    this.teamBaseline.set(null);
    this.leagueBaseline.set(null);
    this.gameLog.set([]);
    this.teamRankings.set([]);
    this.allCompetitions.set(null);
  }
}
