import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DashboardMode, DashboardScope, DashboardService } from './dashboard.service';
import {
  SegmentedControlComponent,
  SegmentOption,
} from '../../shared/components/segmented-control.component';
import { EntityPickerComponent } from '../../shared/components/entity-picker.component';
import { LeaguePickerComponent } from '../../shared/components/league-picker.component';
import { StatTileComponent } from '../../shared/components/stat-tile.component';
import {
  StatBarChartComponent,
  ChartSeries,
} from '../../shared/components/stat-bar-chart.component';
import { StatTrendChartComponent } from '../../shared/components/stat-trend-chart.component';
import { chartPalette } from '../../shared/utils/chart-theme';
import {
  AdvancedStatLine,
  StatSummary,
  TeamRanking,
} from '../../core/models/box-score.model';

const MODE_OPTIONS: SegmentOption<DashboardMode>[] = [
  { label: 'Player', value: 'player' },
  { label: 'Team', value: 'team' },
  { label: 'League', value: 'league' },
];

const SCOPE_OPTIONS: SegmentOption<DashboardScope>[] = [
  { label: 'This competition', value: 'competition' },
  { label: 'All competitions', value: 'all' },
];

const COUNTING_LABELS = ['PTS', 'REB', 'AST', 'STL', 'BLK', 'TOV'];
const SHOOTING_LABELS = ['TS%', 'eFG%', 'FG%', '3P%', 'FT%'];

type RankStat =
  'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'tov' | 'ts_pct' | 'efg_pct' | 'pir';
const RANK_STAT_OPTIONS: { value: RankStat; label: string }[] = [
  { value: 'pts', label: 'PTS / game' },
  { value: 'reb', label: 'REB / game' },
  { value: 'ast', label: 'AST / game' },
  { value: 'stl', label: 'STL / game' },
  { value: 'blk', label: 'BLK / game' },
  { value: 'tov', label: 'TOV / game' },
  { value: 'ts_pct', label: 'TS%' },
  { value: 'efg_pct', label: 'eFG%' },
  { value: 'pir', label: 'PIR / game' },
];
const RANK_PERCENT_STATS = new Set<RankStat>(['ts_pct', 'efg_pct']);

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    SegmentedControlComponent,
    EntityPickerComponent,
    LeaguePickerComponent,
    StatTileComponent,
    StatBarChartComponent,
    StatTrendChartComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dashboard-page">
      <header class="page-header">
        <h2>Dashboard</h2>
        <app-segmented-control
          [options]="modeOptions"
          [selected]="dash.mode()"
          (selectedChange)="dash.setMode($event)"
        />
      </header>

      <div class="picker-row card">
        @switch (dash.mode()) {
          @case ('player') {
            <app-league-picker
              [leagues]="dash.leagues()"
              [selectedLeagueId]="dash.selectedLeagueId()"
              [allowCreate]="false"
              (selectedLeagueIdChange)="dash.selectLeague($event)"
            />
            @if (dash.seasons().length > 0) {
              <app-entity-picker
                label="vs League Season"
                [options]="dash.seasonOptions()"
                [selectedId]="dash.selectedSeasonId()"
                [allowCreate]="false"
                (selectedIdChange)="dash.selectSeason($event)"
              />
            }
            <app-entity-picker
              label="Team"
              [options]="dash.teamOptions()"
              [selectedId]="dash.selectedTeamId()"
              [allowCreate]="false"
              (selectedIdChange)="dash.selectTeam($event)"
            />
            <app-entity-picker
              label="Player"
              [options]="dash.playerOptions()"
              [selectedId]="dash.selectedPlayerId()"
              [allowCreate]="false"
              (selectedIdChange)="dash.selectPlayer($event)"
            />
          }
          @case ('team') {
            <app-league-picker
              [leagues]="dash.leagues()"
              [selectedLeagueId]="dash.selectedLeagueId()"
              [allowCreate]="false"
              (selectedLeagueIdChange)="dash.selectLeague($event)"
            />
            @if (dash.seasons().length > 0) {
              <app-entity-picker
                label="vs League Season"
                [options]="dash.seasonOptions()"
                [selectedId]="dash.selectedSeasonId()"
                [allowCreate]="false"
                (selectedIdChange)="dash.selectSeason($event)"
              />
            }
            <app-entity-picker
              label="Team"
              [options]="dash.teamOptions()"
              [selectedId]="dash.selectedTeamId()"
              [allowCreate]="false"
              (selectedIdChange)="dash.selectTeam($event)"
            />
          }
          @case ('league') {
            <app-league-picker
              [leagues]="dash.leagues()"
              [selectedLeagueId]="dash.selectedLeagueId()"
              [allowCreate]="false"
              (selectedLeagueIdChange)="dash.selectLeague($event)"
            />
            <app-entity-picker
              label="Season"
              [options]="dash.seasonOptions()"
              [selectedId]="dash.selectedSeasonId()"
              [allowCreate]="false"
              (selectedIdChange)="dash.selectSeason($event)"
            />
          }
        }
      </div>

      @if (dash.mode() !== 'league') {
        <app-segmented-control
          [options]="scopeOptions"
          [selected]="dash.scope()"
          (selectedChange)="dash.setScope($event)"
        />
      }

      @if (dash.loading()) {
        <p class="hint">Loading stats…</p>
      }

      @if (!dash.loading() && effectiveSummary(); as summary) {
        <div class="headline-row">
          <app-stat-tile label="Games" [value]="summary.games.toString()" />
          <app-stat-tile
            label="PIR"
            [value]="numFmt(summary.advanced.pir)"
            [diff]="pirDiff(summary)"
            [diffAgainst]="diffLabel()"
          />
          @if (summary.per !== null) {
            <app-stat-tile
              label="PER"
              [value]="numFmt(summary.per)"
              [diff]="perDiff(summary)"
              [diffAgainst]="diffLabel()"
            />
          }
          @if (summary.impact !== null) {
            <app-stat-tile
              label="Impact Score"
              [value]="numFmt(summary.impact)"
              [diff]="impactDiff(summary)"
              [diffAgainst]="diffLabel()"
            />
          }
          @if (summary.pie !== null) {
            <app-stat-tile
              label="PIE"
              [value]="pctFmt(summary.pie)"
              [diff]="pieDiff(summary)"
              [diffAgainst]="diffLabel()"
            />
          }
        </div>

        <div class="stat-category">
          <h4>Basic stats</h4>
          <div class="tile-grid">
            <app-stat-tile label="PTS / game" [value]="numFmt(summary.perGame['pts'])" />
            <app-stat-tile label="MIN / game" [value]="numFmt(summary.perGame['min'])" />
            <app-stat-tile label="FGM / game" [value]="numFmt(summary.perGame['fgm'])" />
            <app-stat-tile label="FGA / game" [value]="numFmt(summary.perGame['fga'])" />
            <app-stat-tile label="2PA / game" [value]="numFmt(twoPtAttemptsPerGame(summary))" />
            <app-stat-tile label="2P%" [value]="pctFmt(twoPtPct(summary))" />
            <app-stat-tile label="3PA / game" [value]="numFmt(summary.perGame['tpa'])" />
            <app-stat-tile label="3P%" [value]="pctFmt(summary.advanced.tp_pct)" />
            <app-stat-tile label="FTA / game" [value]="numFmt(summary.perGame['fta'])" />
            <app-stat-tile label="FT%" [value]="pctFmt(summary.advanced.ft_pct)" />
            <app-stat-tile label="OREB / game" [value]="numFmt(summary.perGame['oreb'])" />
            <app-stat-tile label="DREB / game" [value]="numFmt(summary.perGame['dreb'])" />
            <app-stat-tile label="TRB / game" [value]="numFmt(reboundsPerGame(summary))" />
            <app-stat-tile label="AST / game" [value]="numFmt(summary.perGame['ast'])" />
            <app-stat-tile label="STL / game" [value]="numFmt(summary.perGame['stl'])" />
            <app-stat-tile label="BLK / game" [value]="numFmt(summary.perGame['blk'])" />
            <app-stat-tile label="TOV / game" [value]="numFmt(summary.perGame['tov'])" />
            <app-stat-tile label="PF / game" [value]="numFmt(summary.perGame['pf'])" />
            <app-stat-tile label="PFD / game" [value]="numFmt(summary.perGame['pfd'])" />
            <app-stat-tile label="+/-" [value]="numFmt(summary.perGame['plus_minus'])" />
          </div>
        </div>

        <div class="stat-category">
          <h4>Scoring</h4>
          <div class="tile-grid">
            <app-stat-tile
              label="PPFT"
              [value]="numFmt(summary.advanced.ppft)"
              [diff]="advDiff(summary, 'ppft')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="PP2PS"
              [value]="numFmt(summary.advanced.pp2ps)"
              [diff]="advDiff(summary, 'pp2ps')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="PP3PS"
              [value]="numFmt(summary.advanced.pp3ps)"
              [diff]="advDiff(summary, 'pp3ps')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="Points / Shot"
              [value]="numFmt(summary.advanced.points_per_shot)"
              [diff]="advDiff(summary, 'points_per_shot')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="Points / Poss"
              [value]="numFmt(summary.advanced.points_per_poss)"
              [diff]="advDiff(summary, 'points_per_poss')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="Points / 100 Poss"
              [value]="numFmt(summary.advanced.points_per_100poss)"
              [diff]="advDiff(summary, 'points_per_100poss')"
              [diffAgainst]="diffLabel()"
            />
          </div>
        </div>

        <div class="stat-category">
          <h4>Shooting</h4>
          <div class="tile-grid">
            <app-stat-tile
              label="FTr"
              [value]="pctFmt(summary.advanced.ft_rate)"
              [diff]="pctDiffFor(summary, 'ft_rate')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="3PAr"
              [value]="pctFmt(summary.advanced.three_pt_attempt_rate)"
              [diff]="pctDiffFor(summary, 'three_pt_attempt_rate')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="eFG%"
              [value]="pctFmt(summary.advanced.efg_pct)"
              [diff]="pctDiffFor(summary, 'efg_pct')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="TS%"
              [value]="pctFmt(summary.advanced.ts_pct)"
              [diff]="pctDiffFor(summary, 'ts_pct')"
              [diffAgainst]="diffLabel()"
            />
          </div>
        </div>

        <div class="stat-category">
          <h4>Rebounding</h4>
          <div class="tile-grid">
            <app-stat-tile
              label="OREB%"
              [value]="pctFmt(summary.advanced.oreb_pct)"
              [diff]="pctDiffFor(summary, 'oreb_pct')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="DREB%"
              [value]="pctFmt(summary.advanced.dreb_pct)"
              [diff]="pctDiffFor(summary, 'dreb_pct')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="TRB%"
              [value]="pctFmt(summary.advanced.treb_pct)"
              [diff]="pctDiffFor(summary, 'treb_pct')"
              [diffAgainst]="diffLabel()"
            />
          </div>
        </div>

        <div class="stat-category">
          <h4>Ball Handling</h4>
          <div class="tile-grid">
            <app-stat-tile
              label="AST%"
              [value]="pctFmt(summary.advanced.ast_pct)"
              [diff]="pctDiffFor(summary, 'ast_pct')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="STL%"
              [value]="pctFmt(summary.advanced.stl_pct)"
              [diff]="pctDiffFor(summary, 'stl_pct')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="BLK%"
              [value]="pctFmt(summary.advanced.blk_pct)"
              [diff]="pctDiffFor(summary, 'blk_pct')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="TOV%"
              [value]="pctFmt(summary.advanced.tov_pct)"
              [diff]="pctDiffFor(summary, 'tov_pct')"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="AST/TOV"
              [value]="numFmt(astToTovRatio(summary))"
              [diff]="astToTovDiff(summary)"
              [diffAgainst]="diffLabel()"
            />
            <app-stat-tile
              label="STL/TOV"
              [value]="numFmt(stlToTovRatio(summary))"
              [diff]="stlToTovDiff(summary)"
              [diffAgainst]="diffLabel()"
            />
            @if (summary.advanced.usg_pct !== null) {
              <app-stat-tile
                label="USG%"
                [value]="pctFmt(summary.advanced.usg_pct)"
                [diff]="pctDiffFor(summary, 'usg_pct')"
                [diffAgainst]="diffLabel()"
              />
            }
          </div>
        </div>

        @if (dash.scope() === 'all' && dash.allCompetitions(); as ac) {
          <div class="table-card card">
            <h4>By competition</h4>
            <div class="table-scroll">
              <table class="log-table">
                <thead>
                  <tr>
                    <th>League</th>
                    <th>GP</th>
                    <th>PTS/g</th>
                    <th>PER</th>
                    <th>Impact</th>
                  </tr>
                </thead>
                <tbody>
                  @for (b of ac.perLeague; track b.leagueId) {
                    <tr>
                      <td>{{ b.leagueName }}</td>
                      <td>{{ b.games }}</td>
                      <td>{{ numFmt(b.perGame['pts']) }}</td>
                      <td>{{ b.per !== null ? numFmt(b.per) : '—' }}</td>
                      <td>{{ b.impact !== null ? numFmt(b.impact) : '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }

        @if (comparisonBaseline(); as baseline) {
          <div class="chart-row">
            <app-stat-bar-chart
              title="Counting stats per game"
              [labels]="countingLabels"
              [series]="countingSeries(summary, baseline)"
            />
            <app-stat-bar-chart
              title="Shooting splits (%)"
              [labels]="shootingLabels"
              [series]="shootingSeries(summary, baseline)"
            />
          </div>
        }

        @if (dash.mode() === 'league') {
          <div class="table-card card">
            <div class="rankings-header">
              <h4>Standings</h4>
              <select (change)="onRankStatChange($event)">
                @for (opt of rankStatOptions; track opt.value) {
                  <option
                    [value]="opt.value"
                    [selected]="opt.value === rankStat()"
                  >
                    {{ opt.label }}
                  </option>
                }
              </select>
            </div>
            <div class="table-scroll">
              <table class="log-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Team</th>
                    <th>GP</th>
                    <th>{{ rankStatLabel() }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of sortedRankings(); track r.teamId; let i = $index) {
                    <tr>
                      <td>{{ i + 1 }}</td>
                      <td>{{ r.teamName }}</td>
                      <td>{{ r.games }}</td>
                      <td>
                        {{ numFmt(rankValue(r))
                        }}{{ isPercentStat() ? '%' : '' }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="4" class="hint">
                        No games saved for this league/season yet.
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }

        @if (dash.mode() !== 'league' && dash.scope() !== 'all') {
          <app-stat-trend-chart
            title="PTS per game"
            [labels]="trendLabels()"
            [data]="trendData()"
          />

          <div class="table-card card">
            <h4>Recent games</h4>
            <div class="table-scroll">
              <table class="log-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Opponent</th>
                    <th>MIN</th>
                    <th>PTS</th>
                    <th>REB</th>
                    <th>AST</th>
                  </tr>
                </thead>
                <tbody>
                  @for (g of dash.gameLog(); track g.game_id) {
                    <tr>
                      <td>{{ g.date }}</td>
                      <td>{{ g.opponent }}</td>
                      <td>{{ g.min }}</td>
                      <td>{{ g.pts }}</td>
                      <td>{{ g.oreb + g.dreb }}</td>
                      <td>{{ g.ast }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="6" class="hint">No games saved yet.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }
      } @else if (!dash.loading()) {
        <div class="empty-state card">
          <p class="hint">
            Pick
            {{
              dash.mode() === 'league'
                ? 'a league and season'
                : dash.mode() === 'team'
                  ? 'a team'
                  : 'a team and player'
            }}
            above to see stats.
          </p>
        </div>
      }
    </section>
  `,
  styles: `
    .dashboard-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      padding: var(--space-6);
      max-width: 1200px;
    }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .page-header h2 {
      font-size: 1.4rem;
    }

    .picker-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: var(--space-4);
    }
    .picker-row app-league-picker {
      grid-column: span 2;
      min-width: 340px;
    }

    .headline-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: var(--space-3);
    }

    .stat-category {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .stat-category h4 {
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .tile-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: var(--space-3);
    }

    .chart-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: var(--space-4);
    }

    .table-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .table-card h4 {
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .rankings-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }
    .rankings-header select {
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-1) var(--space-2);
      color: var(--text);
      font-size: 0.8rem;
    }
    .table-scroll {
      overflow-x: auto;
    }
    .log-table {
      width: 100%;
      font-size: 0.82rem;
    }
    .log-table th {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: var(--space-2);
      border-bottom: 1px solid var(--border-strong);
    }
    .log-table th:first-child,
    .log-table td:first-child {
      text-align: left;
    }
    .log-table td {
      text-align: center;
      padding: var(--space-2);
      border-bottom: 1px solid var(--border);
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 160px;
    }
  `,
})
export class DashboardComponent implements OnInit {
  protected readonly dash = inject(DashboardService);

  protected readonly modeOptions = MODE_OPTIONS;
  protected readonly scopeOptions = SCOPE_OPTIONS;
  protected readonly countingLabels = COUNTING_LABELS;
  protected readonly shootingLabels = SHOOTING_LABELS;
  protected readonly rankStatOptions = RANK_STAT_OPTIONS;

  protected readonly rankStat = signal<RankStat>('pts');

  protected readonly sortedRankings = computed(() => {
    const stat = this.rankStat();
    return [...this.dash.teamRankings()].sort(
      (a, b) => this.rankValueFor(b, stat) - this.rankValueFor(a, stat),
    );
  });

  async ngOnInit(): Promise<void> {
    await this.dash.init();
  }

  protected numFmt(n: number | undefined): string {
    return (n ?? 0).toFixed(1);
  }

  protected pctFmt(n: number | undefined | null): string {
    return `${((n ?? 0) * 100).toFixed(1)}%`;
  }

  protected onRankStatChange(event: Event): void {
    this.rankStat.set((event.target as HTMLSelectElement).value as RankStat);
  }

  protected rankStatLabel(): string {
    return (
      this.rankStatOptions.find((o) => o.value === this.rankStat())?.label ?? ''
    );
  }

  protected isPercentStat(): boolean {
    return RANK_PERCENT_STATS.has(this.rankStat());
  }

  protected rankValue(r: TeamRanking): number {
    return this.rankValueFor(r, this.rankStat());
  }

  private rankValueFor(r: TeamRanking, stat: RankStat): number {
    switch (stat) {
      case 'reb':
        return this.reboundsPerGame(r);
      case 'ts_pct':
        return r.advanced.ts_pct * 100;
      case 'efg_pct':
        return r.advanced.efg_pct * 100;
      case 'pir':
        return r.games > 0 ? r.advanced.pir / r.games : 0;
      default:
        return r.perGame[stat] ?? 0;
    }
  }

  protected diffLabel(): string {
    return this.dash.mode() === 'player' ? 'team' : 'league';
  }

  /** The summary actually displayed — per-competition (as today) or combined-across-leagues. */
  protected effectiveSummary(): StatSummary | null {
    if (this.dash.scope() === 'all') return this.dash.allCompetitions()?.combined ?? null;
    return this.dash.primary();
  }

  protected comparisonBaseline(): StatSummary | null {
    // No single coherent league to compare a cross-competition total against.
    if (this.dash.scope() === 'all') return null;
    if (this.dash.mode() === 'player') return this.dash.teamBaseline();
    if (this.dash.mode() === 'team') return this.dash.leagueBaseline();
    return null;
  }

  protected reboundsPerGame(summary: {
    perGame: Record<string, number>;
  }): number {
    return (summary.perGame['oreb'] ?? 0) + (summary.perGame['dreb'] ?? 0);
  }

  protected diffFor(summary: StatSummary, key: string): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline) return null;
    return (summary.perGame[key] ?? 0) - (baseline.perGame[key] ?? 0);
  }

  protected pctDiffFor(
    summary: StatSummary,
    key: keyof AdvancedStatLine,
  ): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline) return null;
    const a = summary.advanced[key];
    const b = baseline.advanced[key];
    if (a === null || b === null) return null;
    return (a - b) * 100;
  }

  protected reboundDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline) return null;
    return this.reboundsPerGame(summary) - this.reboundsPerGame(baseline);
  }

  protected pirDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline) return null;
    return summary.advanced.pir - baseline.advanced.pir;
  }

  protected perDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline || summary.per === null || baseline.per === null) return null;
    return summary.per - baseline.per;
  }

  protected impactDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline || summary.impact === null || baseline.impact === null) return null;
    return summary.impact - baseline.impact;
  }

  protected astToTovRatio(summary: { perGame: Record<string, number> }): number {
    const tov = summary.perGame['tov'] ?? 0;
    return tov > 0 ? (summary.perGame['ast'] ?? 0) / tov : 0;
  }

  protected astToTovDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline) return null;
    return this.astToTovRatio(summary) - this.astToTovRatio(baseline);
  }

  protected stlToTovRatio(summary: { perGame: Record<string, number> }): number {
    const tov = summary.perGame['tov'] ?? 0;
    return tov > 0 ? (summary.perGame['stl'] ?? 0) / tov : 0;
  }

  protected stlToTovDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline) return null;
    return this.stlToTovRatio(summary) - this.stlToTovRatio(baseline);
  }

  protected pieDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline || summary.pie === null || baseline.pie === null) return null;
    return (summary.pie - baseline.pie) * 100;
  }

  /** Diff for a non-percentage advanced-stat field (points-per-shot etc.) — no ×100 scaling. */
  protected advDiff(summary: StatSummary, key: keyof AdvancedStatLine): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline) return null;
    const a = summary.advanced[key];
    const b = baseline.advanced[key];
    if (a === null || b === null) return null;
    return a - b;
  }

  /** 2PA = FGA − 3PA, a "basic stats" field derived client-side rather than stored. */
  protected twoPtAttemptsPerGame(summary: { perGame: Record<string, number> }): number {
    return (summary.perGame['fga'] ?? 0) - (summary.perGame['tpa'] ?? 0);
  }

  /** 2P% computed from totals (not perGame) — a ratio, so totals vs perGame gives the same result either way. */
  protected twoPtPct(summary: StatSummary): number {
    const made = (summary.totals['fgm'] ?? 0) - (summary.totals['tpm'] ?? 0);
    const attempted = (summary.totals['fga'] ?? 0) - (summary.totals['tpa'] ?? 0);
    return attempted > 0 ? made / attempted : 0;
  }

  protected primaryLabel(): string {
    if (this.dash.mode() === 'player') {
      return (
        this.dash.players().find((p) => p.id === this.dash.selectedPlayerId())
          ?.name ?? 'Player'
      );
    }
    return (
      this.dash.teams().find((t) => t.id === this.dash.selectedTeamId())
        ?.name ?? 'Team'
    );
  }

  protected countingSeries(
    summary: StatSummary,
    baseline: StatSummary,
  ): ChartSeries[] {
    const seriesFor = (s: StatSummary): number[] => [
      s.perGame['pts'] ?? 0,
      this.reboundsPerGame(s),
      s.perGame['ast'] ?? 0,
      s.perGame['stl'] ?? 0,
      s.perGame['blk'] ?? 0,
      s.perGame['tov'] ?? 0,
    ];
    return [
      {
        label: this.primaryLabel(),
        data: seriesFor(summary),
        color: chartPalette.accent,
      },
      {
        label: this.diffLabel() === 'team' ? 'Team' : 'League',
        data: seriesFor(baseline),
        color: chartPalette.accent2,
      },
    ];
  }

  protected shootingSeries(
    summary: StatSummary,
    baseline: StatSummary,
  ): ChartSeries[] {
    const seriesFor = (s: StatSummary): number[] => [
      s.advanced.ts_pct * 100,
      s.advanced.efg_pct * 100,
      s.advanced.fg_pct * 100,
      s.advanced.tp_pct * 100,
      s.advanced.ft_pct * 100,
    ];
    return [
      {
        label: this.primaryLabel(),
        data: seriesFor(summary),
        color: chartPalette.accent,
      },
      {
        label: this.diffLabel() === 'team' ? 'Team' : 'League',
        data: seriesFor(baseline),
        color: chartPalette.accent2,
      },
    ];
  }

  protected trendLabels(): string[] {
    return this.dash.gameLog().map((g) => `${g.date} vs ${g.opponent}`);
  }

  protected trendData(): number[] {
    return this.dash.gameLog().map((g) => g.pts);
  }
}
