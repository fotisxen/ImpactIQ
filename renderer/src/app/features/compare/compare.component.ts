import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { EntitiesService } from '../../core/data/entities.service';
import { League, Player, Season, StatSummary, Team } from '../../core/models/box-score.model';
import { EntityPickerComponent, PickerOption } from '../../shared/components/entity-picker.component';
import { LeaguePickerComponent } from '../../shared/components/league-picker.component';
import { SegmentOption, SegmentedControlComponent } from '../../shared/components/segmented-control.component';

type CompareMode = 'player' | 'team';

interface CompareRow {
  label: string;
  get: (s: StatSummary) => number | null;
  fmt: 'num' | 'num2' | 'pct';
  lowerIsBetter?: boolean;
  playerOnly?: boolean;
}

const HEADLINE_ROWS: CompareRow[] = [
  { label: 'Games', get: (s) => s.games, fmt: 'num' },
  { label: 'PIR / game', get: (s) => s.advanced.pir, fmt: 'num2' },
  { label: 'PER', get: (s) => s.per, fmt: 'num2' },
  { label: 'Impact Score', get: (s) => s.impact, fmt: 'num2' },
  { label: 'PIE', get: (s) => s.pie, fmt: 'pct' },
  { label: 'Net Rating', get: (s) => s.netRating, fmt: 'num2' },
];

const BASIC_ROWS: CompareRow[] = [
  { label: 'PTS / game', get: (s) => s.perGame['pts'] ?? null, fmt: 'num' },
  { label: 'REB / game', get: (s) => (s.perGame['oreb'] ?? 0) + (s.perGame['dreb'] ?? 0), fmt: 'num' },
  { label: 'AST / game', get: (s) => s.perGame['ast'] ?? null, fmt: 'num' },
  { label: 'STL / game', get: (s) => s.perGame['stl'] ?? null, fmt: 'num' },
  { label: 'BLK / game', get: (s) => s.perGame['blk'] ?? null, fmt: 'num' },
  { label: 'TOV / game', get: (s) => s.perGame['tov'] ?? null, fmt: 'num', lowerIsBetter: true },
];

const ADVANCED_ROWS: CompareRow[] = [
  { label: 'eFG%', get: (s) => s.advanced.efg_pct, fmt: 'pct' },
  { label: 'TS%', get: (s) => s.advanced.ts_pct, fmt: 'pct' },
  { label: 'FTr', get: (s) => s.advanced.ft_rate, fmt: 'pct' },
  { label: '3PAr', get: (s) => s.advanced.three_pt_attempt_rate, fmt: 'pct' },
  { label: 'OREB%', get: (s) => s.advanced.oreb_pct, fmt: 'pct' },
  { label: 'DREB%', get: (s) => s.advanced.dreb_pct, fmt: 'pct' },
  { label: 'TRB%', get: (s) => s.advanced.treb_pct, fmt: 'pct' },
  { label: 'AST%', get: (s) => s.advanced.ast_pct, fmt: 'pct' },
  { label: 'STL%', get: (s) => s.advanced.stl_pct, fmt: 'pct' },
  { label: 'BLK%', get: (s) => s.advanced.blk_pct, fmt: 'pct' },
  { label: 'TOV%', get: (s) => s.advanced.tov_pct, fmt: 'pct', lowerIsBetter: true },
  { label: 'USG%', get: (s) => s.advanced.usg_pct, fmt: 'pct', playerOnly: true },
  { label: 'ORtg', get: (s) => s.advanced.ortg, fmt: 'num2' },
  { label: 'DRtg', get: (s) => s.advanced.drtg, fmt: 'num2', lowerIsBetter: true },
];

const MODE_OPTIONS: SegmentOption<CompareMode>[] = [
  { label: 'Player vs Player', value: 'player' },
  { label: 'Team vs Team', value: 'team' },
];

/** One side of the comparison — its own independent League→Season→Team(→Player) selection and fetched summary. */
class CompareSide {
  constructor(
    private readonly entities: EntitiesService,
    private readonly mode: () => CompareMode
  ) {}

  readonly leagues = signal<League[]>([]);
  readonly teams = signal<Team[]>([]);
  readonly seasons = signal<Season[]>([]);
  readonly players = signal<Player[]>([]);

  readonly selectedLeagueId = signal<number | null>(null);
  readonly selectedSeasonId = signal<number | null>(null);
  readonly selectedTeamId = signal<number | null>(null);
  readonly selectedPlayerId = signal<number | null>(null);

  readonly summary = signal<StatSummary | null>(null);
  readonly subjectName = signal<string>('');
  readonly loading = signal(false);

  readonly teamOptions = computed<PickerOption[]>(() => {
    const leagueId = this.selectedLeagueId();
    if (leagueId === null) return [];
    return this.teams()
      .filter((t) => t.league_id === leagueId)
      .map((t) => ({ id: t.id, label: t.name }));
  });
  readonly seasonOptions = computed<PickerOption[]>(() => this.seasons().map((s) => ({ id: s.id, label: s.year })));
  readonly playerOptions = computed<PickerOption[]>(() => this.players().map((p) => ({ id: p.id, label: p.name })));

  async init(): Promise<void> {
    const [leagues, teams] = await Promise.all([this.entities.listLeagues(), this.entities.listTeams()]);
    this.leagues.set(leagues);
    this.teams.set(teams);
  }

  async selectLeague(leagueId: number | null): Promise<void> {
    this.selectedLeagueId.set(leagueId);
    this.selectedTeamId.set(null);
    this.selectedPlayerId.set(null);
    this.players.set([]);
    this.summary.set(null);
    if (leagueId === null) {
      this.seasons.set([]);
      this.selectedSeasonId.set(null);
      return;
    }
    const seasons = await this.entities.listSeasons(leagueId);
    this.seasons.set(seasons);
    this.selectedSeasonId.set(seasons[0]?.id ?? null);
  }

  async selectSeason(seasonId: number | null): Promise<void> {
    this.selectedSeasonId.set(seasonId);
    await this.reload();
  }

  async selectTeam(teamId: number | null): Promise<void> {
    this.selectedTeamId.set(teamId);
    this.selectedPlayerId.set(null);
    this.summary.set(null);
    if (teamId === null) {
      this.players.set([]);
      return;
    }
    this.players.set(await this.entities.listPlayers(teamId));
    if (this.mode() === 'team') await this.reload();
  }

  async selectPlayer(playerId: number | null): Promise<void> {
    this.selectedPlayerId.set(playerId);
    await this.reload();
  }

  reset(): void {
    this.selectedLeagueId.set(null);
    this.selectedSeasonId.set(null);
    this.selectedTeamId.set(null);
    this.selectedPlayerId.set(null);
    this.seasons.set([]);
    this.players.set([]);
    this.summary.set(null);
    this.subjectName.set('');
  }

  private async reload(): Promise<void> {
    const seasonId = this.selectedSeasonId();
    this.loading.set(true);
    try {
      if (this.mode() === 'player') {
        const playerId = this.selectedPlayerId();
        if (playerId === null) {
          this.summary.set(null);
          return;
        }
        this.summary.set(await window.boxscoreApi.getPlayerStats(playerId, seasonId));
        this.subjectName.set(this.players().find((p) => p.id === playerId)?.name ?? '');
      } else {
        const teamId = this.selectedTeamId();
        if (teamId === null) {
          this.summary.set(null);
          return;
        }
        this.summary.set(await window.boxscoreApi.getTeamStats(teamId, seasonId));
        this.subjectName.set(this.teams().find((t) => t.id === teamId)?.name ?? '');
      }
    } finally {
      this.loading.set(false);
    }
  }
}

/** Fully independent side-by-side comparison of two players or two teams — each side may be a different league/season entirely. */
@Component({
  selector: 'app-compare',
  standalone: true,
  imports: [SegmentedControlComponent, LeaguePickerComponent, EntityPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="compare-page">
      <header class="page-header">
        <h2>Compare</h2>
        <app-segmented-control [options]="modeOptions" [selected]="mode()" (selectedChange)="setMode($event)" />
      </header>
      <p class="hint">Each side picks its own league, season, and {{ mode() }} independently.</p>

      <div class="sides">
        @for (side of [sideA, sideB]; track $index) {
          <div class="side-card card">
            <h3>{{ $index === 0 ? 'Side A' : 'Side B' }}</h3>
            <app-league-picker
              [leagues]="side.leagues()"
              [selectedLeagueId]="side.selectedLeagueId()"
              [allowCreate]="false"
              (selectedLeagueIdChange)="side.selectLeague($event)"
            />
            @if (side.seasons().length > 0) {
              <app-entity-picker
                label="Season"
                [options]="side.seasonOptions()"
                [selectedId]="side.selectedSeasonId()"
                [allowCreate]="false"
                (selectedIdChange)="side.selectSeason($event)"
              />
            }
            <app-entity-picker
              label="Team"
              [options]="side.teamOptions()"
              [selectedId]="side.selectedTeamId()"
              [allowCreate]="false"
              (selectedIdChange)="side.selectTeam($event)"
            />
            @if (mode() === 'player') {
              <app-entity-picker
                label="Player"
                [options]="side.playerOptions()"
                [selectedId]="side.selectedPlayerId()"
                [allowCreate]="false"
                (selectedIdChange)="side.selectPlayer($event)"
              />
            }
          </div>
        }
      </div>

      @if (sideA.summary(); as a) {
        @if (sideB.summary(); as b) {
          <div class="compare-table card">
            <div class="compare-header-row">
              <span></span>
              <span class="subject-name">{{ sideA.subjectName() }}</span>
              <span class="subject-name">{{ sideB.subjectName() }}</span>
            </div>

            <h4>Headline</h4>
            @for (row of headlineRows; track row.label) {
              @if (!row.playerOnly || mode() === 'player') {
                <div class="compare-row">
                  <span class="row-label">{{ row.label }}</span>
                  <span [class.better]="isBetter(row, a, b)">{{ fmt(row, a) }}</span>
                  <span [class.better]="isBetter(row, b, a)">{{ fmt(row, b) }}</span>
                </div>
              }
            }

            <h4>Basic</h4>
            @for (row of basicRows; track row.label) {
              <div class="compare-row">
                <span class="row-label">{{ row.label }}</span>
                <span [class.better]="isBetter(row, a, b)">{{ fmt(row, a) }}</span>
                <span [class.better]="isBetter(row, b, a)">{{ fmt(row, b) }}</span>
              </div>
            }

            <h4>Advanced</h4>
            @for (row of advancedRows; track row.label) {
              @if (!row.playerOnly || mode() === 'player') {
                <div class="compare-row">
                  <span class="row-label">{{ row.label }}</span>
                  <span [class.better]="isBetter(row, a, b)">{{ fmt(row, a) }}</span>
                  <span [class.better]="isBetter(row, b, a)">{{ fmt(row, b) }}</span>
                </div>
              }
            }
          </div>
        } @else {
          <p class="hint">Pick Side B's {{ mode() }} to see the comparison.</p>
        }
      } @else {
        <p class="hint">Pick both sides' {{ mode() }} to see the comparison.</p>
      }
    </section>
  `,
  styles: `
    .compare-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      padding: var(--space-6);
      max-width: 1100px;
    }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
    }
    .sides {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: var(--space-4);
    }
    .side-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .side-card h3 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .compare-table {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .compare-table h4 {
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-top: var(--space-4);
    }
    .compare-table h4:first-of-type {
      margin-top: 0;
    }
    .compare-header-row,
    .compare-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: var(--space-3);
      align-items: center;
      padding: var(--space-2) 0;
      border-bottom: 1px solid var(--border);
    }
    .compare-header-row {
      border-bottom: 2px solid var(--border-strong);
      padding-bottom: var(--space-3);
    }
    .subject-name {
      font-weight: 700;
      font-size: 0.95rem;
    }
    .row-label {
      color: var(--text-muted);
      font-size: 0.82rem;
    }
    .compare-row span:not(.row-label) {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .compare-row span.better {
      color: var(--positive);
      font-weight: 700;
    }
  `,
})
export class CompareComponent implements OnInit {
  private readonly entities = inject(EntitiesService);

  protected readonly modeOptions = MODE_OPTIONS;
  protected readonly mode = signal<CompareMode>('player');

  protected readonly headlineRows = HEADLINE_ROWS;
  protected readonly basicRows = BASIC_ROWS;
  protected readonly advancedRows = ADVANCED_ROWS;

  protected readonly sideA = new CompareSide(this.entities, () => this.mode());
  protected readonly sideB = new CompareSide(this.entities, () => this.mode());

  async ngOnInit(): Promise<void> {
    await Promise.all([this.sideA.init(), this.sideB.init()]);
  }

  protected setMode(mode: CompareMode): void {
    this.mode.set(mode);
    this.sideA.reset();
    this.sideB.reset();
  }

  protected fmt(row: CompareRow, s: StatSummary): string {
    const v = row.get(s);
    if (v === null || Number.isNaN(v)) return '—';
    if (row.fmt === 'pct') return `${(v * 100).toFixed(1)}%`;
    if (row.fmt === 'num2') return v.toFixed(2);
    return v.toFixed(1);
  }

  protected isBetter(row: CompareRow, s: StatSummary, other: StatSummary): boolean {
    const a = row.get(s);
    const b = row.get(other);
    if (a === null || b === null || a === b) return false;
    return row.lowerIsBetter ? a < b : a > b;
  }
}
