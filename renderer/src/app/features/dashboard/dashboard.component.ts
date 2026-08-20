import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
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
import { StatLineModalComponent } from '../../shared/components/stat-line-modal.component';
import { InsightChartModalComponent } from '../../shared/components/insight-chart-modal.component';
import { BumpChartComponent } from '../../shared/components/bump-chart.component';
import { FactorBarsComponent, FactorBar } from '../../shared/components/factor-bars.component';
import type { ChartData, ChartType } from 'chart.js';
import type { GameLogRow, PieLogRow } from '../../core/models/box-score.model';
import {
  bubbleChartOptions,
  chartPalette,
  doughnutChartOptions,
  percentileRadarChartOptions,
  polarAreaChartOptions,
  radarChartOptions,
} from '../../shared/utils/chart-theme';
import {
  AdvancedStatLine,
  PlayerLeaderboardEntry,
  StatSummary,
  TeamRanking,
} from '../../core/models/box-score.model';
import { ReportCardService } from '../../shared/services/report-card.service';
import { ToastService } from '../../shared/services/toast.service';

interface ChartModalState {
  title: string;
  description: string;
  chartType: ChartType;
  data: ChartData;
  /** 'radar' is used by both Four Factors (fixed-scale) and the percentile radar (always 0-100) — this picks the right axis options. */
  percentileScale?: boolean;
}

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

/** Second-level tab within each mode — a plain in-page switch, not a route, so state stays in this component/service. */
type DashTab = 'overview' | 'basic' | 'advanced' | 'roster' | 'games' | 'leaderboards';

const PLAYER_TAB_OPTIONS: SegmentOption<DashTab>[] = [
  { label: 'Overview', value: 'overview' },
  { label: 'Basic Stats', value: 'basic' },
  { label: 'Advanced Stats', value: 'advanced' },
  { label: 'Games', value: 'games' },
];
const TEAM_TAB_OPTIONS: SegmentOption<DashTab>[] = [
  { label: 'Overview', value: 'overview' },
  { label: 'Basic Stats', value: 'basic' },
  { label: 'Advanced Stats', value: 'advanced' },
  { label: 'Roster', value: 'roster' },
  { label: 'Games', value: 'games' },
];
const LEAGUE_TAB_OPTIONS: SegmentOption<DashTab>[] = [
  { label: 'Overview', value: 'overview' },
  { label: 'Leaderboards', value: 'leaderboards' },
];

type RankStat =
  | 'pts' | 'reb' | 'ast' | 'stl' | 'blk' | 'tov' | 'ts_pct' | 'efg_pct' | 'pir'
  | 'per' | 'impact' | 'pie';
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
  { value: 'per', label: 'PER' },
  { value: 'impact', label: 'Impact Score' },
  { value: 'pie', label: 'PIE%' },
];
const RANK_PERCENT_STATS = new Set<RankStat>(['ts_pct', 'efg_pct', 'pie']);

/** The curated metric list for the League Leaderboards tab — independent from the Standings table's broader RANK_STAT_OPTIONS. */
type LeaderboardStat = 'pts' | 'per' | 'oreb_pct' | 'dreb_pct' | 'treb_pct' | 'efg_pct' | 'three_pt_attempt_rate' | 'ppft';
const LEADERBOARD_STAT_OPTIONS: { value: LeaderboardStat; label: string }[] = [
  { value: 'pts', label: 'PTS / game' },
  { value: 'per', label: 'PER' },
  { value: 'oreb_pct', label: 'OREB%' },
  { value: 'dreb_pct', label: 'DREB%' },
  { value: 'treb_pct', label: 'TRB%' },
  { value: 'efg_pct', label: 'eFG%' },
  { value: 'three_pt_attempt_rate', label: '3PAr' },
  { value: 'ppft', label: 'PPFT' },
];
const LEADERBOARD_PERCENT_STATS = new Set<LeaderboardStat>([
  'oreb_pct', 'dreb_pct', 'treb_pct', 'efg_pct', 'three_pt_attempt_rate', 'ppft',
]);

/** Shape shared by TeamRanking and PlayerLeaderboardEntry — everything rankValueFor needs. */
interface Rankable {
  games: number;
  perGame: Record<string, number>;
  advanced: AdvancedStatLine;
  per: number | null;
  impact: number | null;
  pie: number | null;
}

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
    StatLineModalComponent,
    InsightChartModalComponent,
    BumpChartComponent,
    FactorBarsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dashboard-page">
      <header class="page-header">
        <h2>Dashboard</h2>
        <app-segmented-control
          [options]="modeOptions"
          [selected]="dash.mode()"
          (selectedChange)="onModeChange($event)"
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
        @if (dash.mode() !== 'league') {
          <div class="card-export-row">
            <button type="button" class="btn btn-secondary btn-sm" [disabled]="exportingCard()" (click)="exportSeasonCard(summary)">
              {{ exportingCard() ? 'Exporting…' : 'Export as image' }}
            </button>
          </div>
        }

        <app-segmented-control
          [options]="tabOptions()"
          [selected]="activeTab()"
          (selectedChange)="activeTab.set($event)"
        />

        @if (pieModalOpen()) {
          <app-stat-line-modal
            title="PIE per game"
            [labels]="pieModalLabels()"
            [data]="pieModalData()"
            (close)="closePieModal()"
          />
        }

        @if (chartModal(); as modal) {
          <app-insight-chart-modal
            [title]="modal.title"
            [description]="modal.description"
            [chartType]="modal.chartType"
            [data]="modal.data"
            [options]="chartModalOptions()"
            (close)="chartModal.set(null)"
          />
        }

        @if (activeTab() === 'overview') {
          <div class="headline-row">
            <app-stat-tile label="Games" [value]="summary.games.toString()" />
            @if (dash.mode() !== 'team') {
              <app-stat-tile
                label="PIR"
                [value]="advNumFmt2(summary.advanced.pir)"
                [diff]="pirDiff(summary)"
                [diffAgainst]="diffLabel()"
              />
              @if (summary.per !== null) {
                <app-stat-tile
                  label="PER"
                  [value]="advNumFmt2(summary.per)"
                  [diff]="perDiff(summary)"
                  [diffAgainst]="diffLabel()"
                />
              }
              @if (summary.impact !== null) {
                <app-stat-tile
                  label="Impact Score"
                  [value]="advNumFmt2(summary.impact)"
                  [diff]="impactDiff(summary)"
                  [diffAgainst]="diffLabel()"
                  [clickable]="true"
                  (tileClick)="openStrengthProfileChart(summary)"
                />
              }
              @if (summary.pie !== null) {
                <app-stat-tile
                  label="PIE"
                  [value]="advPctFmt2(summary.pie)"
                  [diff]="pieDiff(summary)"
                  [diffAgainst]="diffLabel()"
                  [clickable]="dash.mode() === 'player'"
                  (tileClick)="openPieModal()"
                />
              }
              @if (summary.netRating !== null) {
                <app-stat-tile
                  label="Net Rating"
                  [value]="advNumFmt2(summary.netRating)"
                  [diff]="netRatingDiff(summary)"
                  [diffAgainst]="diffLabel()"
                />
              } @else if (dash.mode() === 'player') {
                <app-stat-tile label="Net Rating" value="N/A" />
              }
            }
          </div>

          @if (dash.mode() !== 'league') {
            <div class="stat-category">
              <h4>Basic stats</h4>
              <div class="tile-grid">
                <app-stat-tile
                  label="PTS / game"
                  [value]="numFmt(summary.perGame['pts'])"
                  [clickable]="true"
                  (tileClick)="openScoringBreakdownChart(summary)"
                />
                <app-stat-tile label="REB / game" [value]="numFmt(reboundsPerGame(summary))" />
                <app-stat-tile label="AST / game" [value]="numFmt(summary.perGame['ast'])" />
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

            @if (dash.standingsHistory(); as history) {
              <app-bump-chart [history]="history" />
            }
          }

          @if (dash.mode() === 'player') {
            <div class="chart-row">
              <app-stat-trend-chart title="PTS per game" [labels]="trendLabels()" [data]="trendData()" />
              <app-stat-trend-chart title="PIE per game" [labels]="pieTrendLabels()" [data]="pieTrendData()" />
              <app-stat-trend-chart title="PER per game" [labels]="perTrendLabels()" [data]="perTrendData()" />
            </div>
            <app-factor-bars [factors]="factorBars(summary)" />
          }

          @if (dash.mode() === 'team') {
            <div class="chart-row">
              <app-stat-trend-chart title="PTS per game" [labels]="trendLabels()" [data]="trendData()" />
              <app-stat-trend-chart title="PER per game" [labels]="perTrendLabels()" [data]="perTrendData()" />
            </div>
            <div class="headline-row">
              @if (summary.advanced.ortg !== null) {
                <app-stat-tile
                  label="ORtg"
                  [value]="advNumFmt2(summary.advanced.ortg)"
                  [diff]="ortgDiff(summary)"
                  [diffAgainst]="diffLabel()"
                />
              }
              @if (summary.advanced.drtg !== null) {
                <app-stat-tile
                  label="DRtg"
                  [value]="advNumFmt2(summary.advanced.drtg)"
                  [diff]="drtgDiff(summary)"
                  [diffAgainst]="diffLabel()"
                />
              }
            </div>
          }

          @if (dash.mode() !== 'league' && dash.scope() !== 'all') {
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
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (g of recentGames(); track g.game_id) {
                      <tr>
                        <td>{{ g.date }}</td>
                        <td>{{ g.opponent }}</td>
                        <td>{{ g.min }}</td>
                        <td>{{ g.pts }}</td>
                        <td>{{ g.oreb + g.dreb }}</td>
                        <td>{{ g.ast }}</td>
                        <td>
                          <button
                            type="button"
                            class="btn btn-ghost btn-sm"
                            [disabled]="exportingGameId() === g.game_id"
                            (click)="exportGameCard(g.game_id)"
                          >
                            {{ exportingGameId() === g.game_id ? 'Exporting…' : 'Share' }}
                          </button>
                        </td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="7" class="hint">No games saved yet.</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
          }

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
                        <td>{{ b.per !== null ? advNumFmt2(b.per) : '—' }}</td>
                        <td>{{ b.impact !== null ? advNumFmt2(b.impact) : '—' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
          }
        }

        @if (activeTab() === 'basic' && dash.mode() !== 'league') {
          <div class="stat-category">
            <h4>Basic stats</h4>
            <div class="tile-grid">
              <app-stat-tile
                label="PTS / game"
                [value]="numFmt(summary.perGame['pts'])"
                [clickable]="true"
                (tileClick)="openScoringBreakdownChart(summary)"
              />
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
              <app-stat-tile label="SRJ / game" [value]="numFmt(summary.perGame['srj'])" />
              <app-stat-tile label="TOV / game" [value]="numFmt(summary.perGame['tov'])" />
              <app-stat-tile label="PF / game" [value]="numFmt(summary.perGame['pf'])" />
              <app-stat-tile label="PFD / game" [value]="numFmt(summary.perGame['pfd'])" />
              <app-stat-tile label="+/-" [value]="numFmt(summary.perGame['plus_minus'])" />
            </div>
          </div>
        }

        @if (activeTab() === 'advanced' && dash.mode() !== 'league') {
          @if (dash.mode() === 'team') {
            <div class="headline-row">
              <app-stat-tile label="Games" [value]="summary.games.toString()" />
              <app-stat-tile
                label="PIR"
                [value]="advNumFmt2(summary.advanced.pir)"
                [diff]="pirDiff(summary)"
                [diffAgainst]="diffLabel()"
              />
              @if (summary.per !== null) {
                <app-stat-tile
                  label="PER"
                  [value]="advNumFmt2(summary.per)"
                  [diff]="perDiff(summary)"
                  [diffAgainst]="diffLabel()"
                />
              }
              @if (summary.impact !== null) {
                <app-stat-tile
                  label="Impact Score"
                  [value]="advNumFmt2(summary.impact)"
                  [diff]="impactDiff(summary)"
                  [diffAgainst]="diffLabel()"
                  [clickable]="true"
                  (tileClick)="openStrengthProfileChart(summary)"
                />
              }
              @if (summary.pie !== null) {
                <app-stat-tile
                  label="PIE"
                  [value]="advPctFmt2(summary.pie)"
                  [diff]="pieDiff(summary)"
                  [diffAgainst]="diffLabel()"
                />
              }
              @if (summary.netRating !== null) {
                <app-stat-tile
                  label="Net Rating"
                  [value]="advNumFmt2(summary.netRating)"
                  [diff]="netRatingDiff(summary)"
                  [diffAgainst]="diffLabel()"
                />
              }
            </div>
          }

          @if (dash.mode() === 'team') {
            <div class="table-card card">
              <h4>Export advanced metrics report</h4>
              <p class="hint">
                Every advanced metric, one page per metric, ranking the roster from best to worst — as of a
                chosen game, not the full season. TOV% ranks lowest-first (fewer turnovers is better);
                everything else ranks highest-first.
              </p>
              <div class="report-export-row">
                <label class="field">
                  <span class="field-label">Through game #</span>
                  <input
                    type="number"
                    min="1"
                    [max]="reportMaxGame()"
                    [value]="reportThroughGame()"
                    (change)="onReportThroughGameChange($event)"
                  />
                </label>
                <span class="hint">of {{ reportMaxGame() }} played</span>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  [disabled]="exportingReport() !== null"
                  (click)="exportAdvancedReport('excel')"
                >
                  {{ exportingReport() === 'excel' ? 'Exporting…' : 'Export Excel' }}
                </button>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  [disabled]="exportingReport() !== null"
                  (click)="exportAdvancedReport('pdf')"
                >
                  {{ exportingReport() === 'pdf' ? 'Exporting…' : 'Export PDF' }}
                </button>
              </div>
            </div>
          }

          <div class="stat-category">
            <h4>Scoring</h4>
            <div class="tile-grid">
              <app-stat-tile
                label="PPFT"
                [value]="advNumFmt3(summary.advanced.ppft)"
                [diff]="advDiff(summary, 'ppft')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="PP2PS"
                [value]="advNumFmt3(summary.advanced.pp2ps)"
                [diff]="advDiff(summary, 'pp2ps')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="PP3PS"
                [value]="advNumFmt3(summary.advanced.pp3ps)"
                [diff]="advDiff(summary, 'pp3ps')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="Points / Shot"
                [value]="advNumFmt3(summary.advanced.points_per_shot)"
                [diff]="advDiff(summary, 'points_per_shot')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="Points / Poss"
                [value]="advNumFmt3(summary.advanced.points_per_poss)"
                [diff]="advDiff(summary, 'points_per_poss')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="Points / 100 Poss"
                [value]="advNumFmt3(summary.advanced.points_per_100poss)"
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
                [value]="advPctFmt2(summary.advanced.ft_rate)"
                [diff]="pctDiffFor(summary, 'ft_rate')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="3PAr"
                [value]="advPctFmt2(summary.advanced.three_pt_attempt_rate)"
                [diff]="pctDiffFor(summary, 'three_pt_attempt_rate')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="eFG%"
                [value]="advPctFmt2(summary.advanced.efg_pct)"
                [diff]="pctDiffFor(summary, 'efg_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="TS%"
                [value]="advPctFmt2(summary.advanced.ts_pct)"
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
                [value]="advPctFmt2(summary.advanced.oreb_pct)"
                [diff]="pctDiffFor(summary, 'oreb_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="DREB%"
                [value]="advPctFmt2(summary.advanced.dreb_pct)"
                [diff]="pctDiffFor(summary, 'dreb_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="TRB%"
                [value]="advPctFmt2(summary.advanced.treb_pct)"
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
                [value]="advPctFmt2(summary.advanced.ast_pct)"
                [diff]="pctDiffFor(summary, 'ast_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="STL%"
                [value]="advPctFmt2(summary.advanced.stl_pct)"
                [diff]="pctDiffFor(summary, 'stl_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="BLK%"
                [value]="advPctFmt2(summary.advanced.blk_pct)"
                [diff]="pctDiffFor(summary, 'blk_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="TOV%"
                [value]="advPctFmt2(summary.advanced.tov_pct)"
                [diff]="pctDiffFor(summary, 'tov_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="AST/TOV"
                [value]="advNumFmt2(astToTovRatio(summary))"
                [diff]="astToTovDiff(summary)"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="STL/TOV"
                [value]="advNumFmt2(stlToTovRatio(summary))"
                [diff]="stlToTovDiff(summary)"
                [diffAgainst]="diffLabel()"
              />
              @if (summary.advanced.usg_pct !== null) {
                <app-stat-tile
                  label="USG%"
                  [value]="advPctFmt2(summary.advanced.usg_pct)"
                  [diff]="pctDiffFor(summary, 'usg_pct')"
                  [diffAgainst]="diffLabel()"
                  [clickable]="true"
                  (tileClick)="openUsageEfficiencyChart()"
                />
              }
            </div>
          </div>

          <div class="stat-category">
            <div class="category-header-row">
              <h4>DOE (Dean Oliver's Evaluation)</h4>
              <button type="button" class="btn-link" (click)="openFourFactorsChart(summary)">View radar chart</button>
            </div>
            <div class="tile-grid">
              <app-stat-tile
                label="eFG% (40%)"
                [value]="advPctFmt2(summary.advanced.efg_pct)"
                [diff]="pctDiffFor(summary, 'efg_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="TOV% (25%)"
                [value]="advPctFmt2(summary.advanced.tov_pct)"
                [diff]="pctDiffFor(summary, 'tov_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="ORB% (20%)"
                [value]="advPctFmt2(summary.advanced.oreb_pct)"
                [diff]="pctDiffFor(summary, 'oreb_pct')"
                [diffAgainst]="diffLabel()"
              />
              <app-stat-tile
                label="FTHr (15%)"
                [value]="advPctFmt2(summary.advanced.ft_rate)"
                [diff]="pctDiffFor(summary, 'ft_rate')"
                [diffAgainst]="diffLabel()"
              />
              @if (summary.advanced.ortg !== null) {
                <app-stat-tile
                  label="ORtg"
                  [value]="advNumFmt2(summary.advanced.ortg)"
                  [diff]="ortgDiff(summary)"
                  [diffAgainst]="diffLabel()"
                />
              }
              @if (summary.advanced.drtg !== null) {
                <app-stat-tile
                  label="DRtg"
                  [value]="advNumFmt2(summary.advanced.drtg)"
                  [diff]="drtgDiff(summary)"
                  [diffAgainst]="diffLabel()"
                />
              }
            </div>
          </div>
        }

        @if (activeTab() === 'roster' && dash.mode() === 'team') {
          <div class="table-card card">
            <h4>Roster</h4>
            <div class="table-scroll">
              <table class="log-table">
                <thead>
                  <tr><th>Player</th></tr>
                </thead>
                <tbody>
                  @for (p of dash.players(); track p.id) {
                    <tr class="clickable-row" (click)="viewPlayer(p.id)">
                      <td>{{ p.name }}</td>
                    </tr>
                  } @empty {
                    <tr><td class="hint">No players yet.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }

        @if (activeTab() === 'games' && dash.mode() === 'player') {
          <div class="table-card card">
            <h4>All games (every competition)</h4>
            <div class="table-scroll scroll-tall">
              <table class="log-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Competition</th>
                    <th>Opponent</th>
                    <th>PTS</th>
                    <th>REB</th>
                    <th>AST</th>
                  </tr>
                </thead>
                <tbody>
                  @for (g of dash.playerAllGames(); track g.game_id) {
                    <tr>
                      <td>{{ g.date }}</td>
                      <td>{{ g.leagueName }}</td>
                      <td>{{ g.opponent }}</td>
                      <td>{{ g.pts }}</td>
                      <td>{{ g.reb }}</td>
                      <td>{{ g.ast }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="6" class="hint">No games saved yet.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }

        @if (activeTab() === 'games' && dash.mode() === 'team') {
          <div class="table-card card">
            <h4>All games (every competition)</h4>
            <div class="table-scroll scroll-tall">
              <table class="log-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Competition</th>
                    <th>Opponent</th>
                    <th>Score</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  @for (g of dash.teamAllGames(); track g.game_id) {
                    <tr>
                      <td>{{ g.date }}</td>
                      <td>{{ g.leagueName }}</td>
                      <td>{{ g.opponent }}</td>
                      <td>{{ g.teamPts }}–{{ g.oppPts }}</td>
                      <td>{{ g.won ? 'W' : 'L' }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="5" class="hint">No games saved yet.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        }

        @if (activeTab() === 'leaderboards' && dash.mode() === 'league') {
          <div class="table-card card">
            <div class="rankings-header">
              <h4>Player leaderboard</h4>
              <select (change)="onLeaderboardStatChange($event)">
                @for (opt of leaderboardStatOptions; track opt.value) {
                  <option
                    [value]="opt.value"
                    [selected]="opt.value === leaderboardStat()"
                  >
                    {{ opt.label }}
                  </option>
                }
              </select>
            </div>
            <span class="hint">Click a player for their league percentile radar</span>
            <div class="table-scroll">
              <table class="log-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Player</th>
                    <th>Team</th>
                    <th>GP</th>
                    <th>{{ leaderboardStatLabel() }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of sortedLeaderboardByStat(); track r.playerId; let i = $index) {
                    <tr class="clickable-row" (click)="openPercentileRadarChart(r)">
                      <td>{{ i + 1 }}</td>
                      <td>{{ r.playerName }}</td>
                      <td>{{ r.teamName }}</td>
                      <td>{{ r.games }}</td>
                      <td>
                        {{ numFmt(leaderboardValue(r))
                        }}{{ isLeaderboardPercentStat() ? '%' : '' }}
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="hint">
                        No games saved for this league/season yet.
                      </td>
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

    .card-export-row {
      display: flex;
      justify-content: flex-end;
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
    .category-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }
    .btn-link {
      background: none;
      border: none;
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
    }
    .btn-link:hover {
      text-decoration: underline;
    }
    .clickable-row {
      cursor: pointer;
    }
    .clickable-row:hover {
      background: var(--accent-muted);
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
    .report-export-row {
      display: flex;
      align-items: flex-end;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .report-export-row input[type='number'] {
      width: 5rem;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
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
    .table-scroll.scroll-tall {
      max-height: 420px;
      overflow-y: auto;
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
  private readonly reportCard = inject(ReportCardService);
  private readonly toast = inject(ToastService);

  protected readonly modeOptions = MODE_OPTIONS;
  protected readonly scopeOptions = SCOPE_OPTIONS;
  protected readonly countingLabels = COUNTING_LABELS;
  protected readonly shootingLabels = SHOOTING_LABELS;
  protected readonly rankStatOptions = RANK_STAT_OPTIONS;

  protected readonly exportingCard = signal(false);
  protected readonly exportingGameId = signal<number | null>(null);

  // ── Team advanced-metrics report export ─────────────────────────────
  protected readonly reportMaxGame = signal(1);
  protected readonly reportThroughGame = signal(1);
  protected readonly exportingReport = signal<'excel' | 'pdf' | null>(null);

  constructor() {
    effect(() => {
      const teamId = this.dash.selectedTeamId();
      const seasonId = this.dash.selectedSeasonId();
      if (teamId === null || seasonId === null || this.dash.mode() !== 'team') {
        this.reportMaxGame.set(1);
        this.reportThroughGame.set(1);
        return;
      }
      void window.boxscoreApi.getTeamSeasonGameCount(teamId, seasonId).then((count) => {
        const max = Math.max(count, 1);
        this.reportMaxGame.set(max);
        this.reportThroughGame.set(max);
      });
    });
  }

  protected onReportThroughGameChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.reportThroughGame.set(Math.min(Math.max(1, value || 1), this.reportMaxGame()));
  }

  protected async exportAdvancedReport(format: 'excel' | 'pdf'): Promise<void> {
    const teamId = this.dash.selectedTeamId();
    const seasonId = this.dash.selectedSeasonId();
    if (teamId === null || seasonId === null) return;
    this.exportingReport.set(format);
    try {
      const result = await window.boxscoreApi.exportTeamAdvancedReport({
        format,
        teamId,
        seasonId,
        throughGame: this.reportThroughGame(),
      });
      if (result.saved) this.toast.success('Advanced metrics report exported.');
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to export the report.');
    } finally {
      this.exportingReport.set(null);
    }
  }

  protected readonly rankStat = signal<RankStat>('pts');

  protected readonly sortedRankings = computed(() => {
    const stat = this.rankStat();
    return [...this.dash.teamRankings()].sort(
      (a, b) => this.rankValueFor(b, stat) - this.rankValueFor(a, stat),
    );
  });

  protected readonly sortedLeaderboard = computed(() => {
    const stat = this.rankStat();
    return [...this.dash.playerLeaderboard()].sort(
      (a, b) => this.rankValueFor(b, stat) - this.rankValueFor(a, stat),
    );
  });

  // ── Second-level tabs ─────────────────────────────────────────────────
  protected readonly activeTab = signal<DashTab>('overview');
  protected readonly tabOptions = computed<SegmentOption<DashTab>[]>(() => {
    switch (this.dash.mode()) {
      case 'team':
        return TEAM_TAB_OPTIONS;
      case 'league':
        return LEAGUE_TAB_OPTIONS;
      default:
        return PLAYER_TAB_OPTIONS;
    }
  });

  protected onModeChange(mode: DashboardMode): void {
    this.dash.setMode(mode);
    this.activeTab.set('overview');
  }

  protected async viewPlayer(playerId: number): Promise<void> {
    await this.dash.viewPlayerFromRoster(playerId);
    this.activeTab.set('overview');
  }

  // ── League Leaderboards tab — its own curated metric dropdown, independent from the Standings table's rankStat. ──
  protected readonly leaderboardStatOptions = LEADERBOARD_STAT_OPTIONS;
  protected readonly leaderboardStat = signal<LeaderboardStat>('pts');

  protected readonly sortedLeaderboardByStat = computed(() => {
    const stat = this.leaderboardStat();
    return [...this.dash.playerLeaderboard()].sort(
      (a, b) => this.leaderboardValueFor(b, stat) - this.leaderboardValueFor(a, stat),
    );
  });

  protected onLeaderboardStatChange(event: Event): void {
    this.leaderboardStat.set((event.target as HTMLSelectElement).value as LeaderboardStat);
  }

  protected leaderboardStatLabel(): string {
    return this.leaderboardStatOptions.find((o) => o.value === this.leaderboardStat())?.label ?? '';
  }

  protected isLeaderboardPercentStat(): boolean {
    return LEADERBOARD_PERCENT_STATS.has(this.leaderboardStat());
  }

  protected leaderboardValue(r: PlayerLeaderboardEntry): number {
    return this.leaderboardValueFor(r, this.leaderboardStat());
  }

  private leaderboardValueFor(r: PlayerLeaderboardEntry, stat: LeaderboardStat): number {
    switch (stat) {
      case 'pts':
        return r.perGame['pts'] ?? 0;
      case 'per':
        return r.per ?? 0;
      case 'oreb_pct':
        return (r.advanced.oreb_pct ?? 0) * 100;
      case 'dreb_pct':
        return (r.advanced.dreb_pct ?? 0) * 100;
      case 'treb_pct':
        return (r.advanced.treb_pct ?? 0) * 100;
      case 'efg_pct':
        return r.advanced.efg_pct * 100;
      case 'three_pt_attempt_rate':
        return r.advanced.three_pt_attempt_rate * 100;
      case 'ppft':
        return r.advanced.ppft * 100;
    }
  }

  async ngOnInit(): Promise<void> {
    await this.dash.init();
  }

  protected async exportSeasonCard(summary: StatSummary): Promise<void> {
    this.exportingCard.set(true);
    try {
      await this.reportCard.exportPlayerOrTeamCard(
        { subjectName: this.subjectName(), subtitle: this.subjectSubtitle(), summary },
        `${this.subjectName().replace(/[^\w -]/g, '')}-report-card.png`
      );
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to export report card.');
    } finally {
      this.exportingCard.set(false);
    }
  }

  protected async exportGameCard(gameId: number): Promise<void> {
    this.exportingGameId.set(gameId);
    try {
      const box = await window.boxscoreApi.getGameBoxScore(gameId);
      if (!box) {
        this.toast.error('Could not load that game.');
        return;
      }
      await this.reportCard.exportGameCard(
        box,
        `${box.homeTeamName}-vs-${box.awayTeamName}-${box.date}.png`.replace(/[^\w .-]/g, '')
      );
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to export game card.');
    } finally {
      this.exportingGameId.set(null);
    }
  }

  private subjectName(): string {
    if (this.dash.mode() === 'player') {
      return this.dash.playerOptions().find((o) => o.id === this.dash.selectedPlayerId())?.label ?? 'Player';
    }
    return this.dash.teamOptions().find((o) => o.id === this.dash.selectedTeamId())?.label ?? 'Team';
  }

  private subjectSubtitle(): string {
    const league = this.dash.leagues().find((l) => l.id === this.dash.selectedLeagueId())?.name ?? '';
    const season = this.dash.seasonOptions().find((s) => s.id === this.dash.selectedSeasonId())?.label ?? '';
    if (this.dash.mode() === 'player') {
      const team = this.dash.teamOptions().find((o) => o.id === this.dash.selectedTeamId())?.label ?? '';
      return [team, league, season].filter(Boolean).join(' · ');
    }
    return [league, season].filter(Boolean).join(' · ');
  }

  protected numFmt(n: number | undefined): string {
    return (n ?? 0).toFixed(1);
  }

  protected pctFmt(n: number | undefined | null): string {
    return `${((n ?? 0) * 100).toFixed(1)}%`;
  }

  /** Scoring-category advanced metrics (PPFT, PP2PS, points/shot, etc.) — 3 decimal places. */
  protected advNumFmt3(n: number | undefined | null): string {
    return (n ?? 0).toFixed(3);
  }

  /** Every other non-percentage advanced metric (PIR, PER, Impact Score, Net Rating, AST/TOV, ORtg/DRtg) — 2 decimal places. */
  protected advNumFmt2(n: number | undefined | null): string {
    return (n ?? 0).toFixed(2);
  }

  /** Every percentage-based advanced metric (Shooting/Rebounding/Ball Handling/DOE splits, PIE) — 2 decimal places. */
  protected advPctFmt2(n: number | undefined | null): string {
    return `${((n ?? 0) * 100).toFixed(2)}%`;
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

  protected rankValue(r: Rankable): number {
    return this.rankValueFor(r, this.rankStat());
  }

  private rankValueFor(r: Rankable, stat: RankStat): number {
    switch (stat) {
      case 'reb':
        return this.reboundsPerGame(r);
      case 'ts_pct':
        return r.advanced.ts_pct * 100;
      case 'efg_pct':
        return r.advanced.efg_pct * 100;
      case 'pir':
        // advanced.pir is already a per-game rate (see buildStatSummary), not a season total.
        return r.advanced.pir;
      case 'per':
        return r.per ?? 0;
      case 'impact':
        return r.impact ?? 0;
      case 'pie':
        return (r.pie ?? 0) * 100;
      default:
        return r.perGame[stat] ?? 0;
    }
  }

  protected diffLabel(): string {
    return this.dash.mode() === 'player' ? 'avg player' : 'league';
  }

  /** The summary actually displayed — per-competition (as today) or combined-across-leagues. */
  protected effectiveSummary(): StatSummary | null {
    if (this.dash.scope() === 'all') return this.dash.allCompetitions()?.combined ?? null;
    return this.dash.primary();
  }

  /**
   * Both modes compare against a league baseline now — just a different
   * flavor: a player's own per-game numbers (~15 PTS) against the league's
   * average PLAYER (~15 PTS), a team's against the league's average TEAM
   * (~80 PTS). Comparing a player against their own team's totals (the old
   * behavior) compared numbers on completely different scales.
   */
  protected comparisonBaseline(): StatSummary | null {
    // No single coherent league to compare a cross-competition total against.
    if (this.dash.scope() === 'all') return null;
    if (this.dash.mode() === 'player' || this.dash.mode() === 'team') return this.dash.leagueBaseline();
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

  /** ORtg/DRtg are points-per-100-possessions, not 0-1 fractions — plain diff, not pctDiffFor's x100. */
  protected ortgDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline || summary.advanced.ortg === null || baseline.advanced.ortg === null) return null;
    return summary.advanced.ortg - baseline.advanced.ortg;
  }

  protected drtgDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline || summary.advanced.drtg === null || baseline.advanced.drtg === null) return null;
    return summary.advanced.drtg - baseline.advanced.drtg;
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

  protected netRatingDiff(summary: StatSummary): number | null {
    const baseline = this.comparisonBaseline();
    if (!baseline || summary.netRating === null || baseline.netRating === null) return null;
    return summary.netRating - baseline.netRating;
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

  /** Recent games — the last 5 chronologically, capped so the table can't grow unbounded. gameLog is date-ASC, so slice(-5) keeps the most recent 5 in that same order. */
  protected recentGames(): GameLogRow[] {
    return this.dash.gameLog().slice(-5);
  }

  protected pieTrendLabels(): string[] {
    return this.dash.pieTrendLog().map((g) => `${g.date} vs ${g.opponent}`);
  }

  protected pieTrendData(): number[] {
    return this.dash.pieTrendLog().map((g) => g.pie * 100);
  }

  protected perTrendLabels(): string[] {
    return this.dash.perTrendLog().map((g) => `${g.date} vs ${g.opponent}`);
  }

  protected perTrendData(): number[] {
    return this.dash.perTrendLog().map((g) => g.per ?? 0);
  }

  /** The DOE Four Factors as 0-1 fractions, for the "carpet" progress-bar chart. */
  protected factorBars(summary: StatSummary): FactorBar[] {
    return [
      { label: 'eFG%', value: summary.advanced.efg_pct },
      { label: 'TOV%', value: summary.advanced.tov_pct ?? 0 },
      { label: 'ORB%', value: summary.advanced.oreb_pct ?? 0 },
      { label: 'FTHr', value: summary.advanced.ft_rate },
    ];
  }

  protected readonly pieModalOpen = signal(false);
  protected readonly pieLog = signal<PieLogRow[]>([]);

  protected async openPieModal(): Promise<void> {
    const playerId = this.dash.selectedPlayerId();
    if (playerId === null) return;
    this.pieModalOpen.set(true);
    this.pieLog.set(await window.boxscoreApi.getPlayerPieLog(playerId));
  }

  protected closePieModal(): void {
    this.pieModalOpen.set(false);
    this.pieLog.set([]);
  }

  protected pieModalLabels(): string[] {
    return this.pieLog().map((g) => `${g.date} vs ${g.opponent}`);
  }

  protected pieModalData(): number[] {
    return this.pieLog().map((g) => g.pie * 100);
  }

  // ── Insight chart modals ──────────────────────────────────────────────
  // Four different chart shapes, each picked because it's the natural fit
  // for that metric — not just a line/bar for everything.

  protected readonly chartModal = signal<ChartModalState | null>(null);

  protected chartModalOptions() {
    switch (this.chartModal()?.chartType) {
      case 'radar':
        return this.chartModal()?.percentileScale ? percentileRadarChartOptions : radarChartOptions;
      case 'doughnut':
        return doughnutChartOptions;
      case 'polarArea':
        return polarAreaChartOptions;
      case 'bubble':
        return bubbleChartOptions;
      default:
        return {};
    }
  }

  /** Radar — the Four Factors' actual *shape*, this subject vs. the comparison baseline, at a glance. */
  protected openFourFactorsChart(summary: StatSummary): void {
    const adv = summary.advanced;
    const baseline = this.comparisonBaseline();
    const labels = ['eFG%', 'Ball security', 'ORB%', 'FT rate'];
    const subjectValues = [adv.efg_pct, 1 - (adv.tov_pct ?? 0), adv.oreb_pct ?? 0, adv.ft_rate].map((v) => v * 100);

    const datasets: NonNullable<ChartData<'radar'>['datasets']> = [
      {
        label: this.subjectName(),
        data: subjectValues,
        borderColor: chartPalette.accent,
        backgroundColor: 'rgba(255, 122, 41, 0.25)',
        pointBackgroundColor: chartPalette.accent,
      },
    ];
    if (baseline) {
      const b = baseline.advanced;
      datasets.push({
        label: this.diffLabel() === 'team' ? 'Team' : 'League avg',
        data: [b.efg_pct, 1 - (b.tov_pct ?? 0), b.oreb_pct ?? 0, b.ft_rate].map((v) => v * 100),
        borderColor: chartPalette.accent2,
        backgroundColor: 'rgba(58, 160, 255, 0.15)',
        pointBackgroundColor: chartPalette.accent2,
      });
    }

    this.chartModal.set({
      title: 'Four Factors',
      description:
        "Dean Oliver's Four Factors, plotted as a shape — the four things that decide who wins: shooting, ball security, rebounding, and getting to the line. A bigger, rounder shape is a more complete performance.",
      chartType: 'radar',
      data: { labels, datasets } as ChartData,
    });
  }

  /** Doughnut — how this subject's points actually break down by shot type. */
  protected openScoringBreakdownChart(summary: StatSummary): void {
    const t = summary.totals;
    const twoPtPts = ((t['fgm'] ?? 0) - (t['tpm'] ?? 0)) * 2;
    const threePtPts = (t['tpm'] ?? 0) * 3;
    const ftPts = t['ftm'] ?? 0;

    this.chartModal.set({
      title: 'Scoring breakdown',
      description: 'Where this scoring actually comes from — the share of total points scored on 2-pointers, 3-pointers, and free throws.',
      chartType: 'doughnut',
      data: {
        labels: ['2PT', '3PT', 'FT'],
        datasets: [
          {
            data: [twoPtPts, threePtPts, ftPts],
            backgroundColor: [chartPalette.accent, chartPalette.accent2, chartPalette.positive],
            borderColor: chartPalette.surfaceRaised,
            borderWidth: 2,
          },
        ],
      } as ChartData,
    });
  }

  /** Bubble — shot volume vs. efficiency, one bubble per game, so hot/cold and heavy/light-usage games are visible at once. */
  protected openUsageEfficiencyChart(): void {
    const log = this.dash.gameLog();
    const points = log
      .filter((g) => g.fga > 0)
      .map((g) => ({
        x: g.fga,
        y: this.tsPctForGame(g) * 100,
        r: Math.max(4, g.pts / 2),
      }));

    this.chartModal.set({
      title: 'Shot volume vs. efficiency',
      description:
        'One bubble per game: how many shots were taken (x-axis), how efficiently they went in (y-axis, True Shooting %), and bubble size for total points that game. Shows whether taking more shots comes at the cost of efficiency.',
      chartType: 'bubble',
      data: {
        datasets: [
          {
            label: this.subjectName(),
            data: points,
            backgroundColor: 'rgba(255, 122, 41, 0.55)',
            borderColor: chartPalette.accent,
          },
        ],
      } as ChartData,
    });
  }

  /** Polar area — a production "fingerprint": each category's size relative to the comparison baseline (100 = average). */
  protected openStrengthProfileChart(summary: StatSummary): void {
    const baseline = this.comparisonBaseline();
    const pg = summary.perGame;
    const basePg = baseline?.perGame;
    const index = (value: number, base: number | undefined): number =>
      base && base > 0 ? (value / base) * 100 : value > 0 ? 150 : 0;

    const rebounds = (pg['oreb'] ?? 0) + (pg['dreb'] ?? 0);
    const baseRebounds = basePg ? (basePg['oreb'] ?? 0) + (basePg['dreb'] ?? 0) : undefined;

    const labels = ['PTS', 'REB', 'AST', 'STL', 'BLK'];
    const values = [
      index(pg['pts'] ?? 0, basePg?.['pts']),
      index(rebounds, baseRebounds),
      index(pg['ast'] ?? 0, basePg?.['ast']),
      index(pg['stl'] ?? 0, basePg?.['stl']),
      index(pg['blk'] ?? 0, basePg?.['blk']),
    ];

    this.chartModal.set({
      title: 'Production profile',
      description: `Each category sized relative to the ${this.diffLabel()} average — 100 means exactly average, bigger wedges mean further above it.`,
      chartType: 'polarArea',
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: ['#ff7a2999', '#3aa0ff99', '#35d07f99', '#e0c04899', '#c774e899'],
          },
        ],
      } as ChartData,
    });
  }

  private tsPctForGame(g: GameLogRow): number {
    const denom = 2 * (g.fga + 0.44 * g.fta);
    return denom > 0 ? g.pts / denom : 0;
  }

  /** Radar — Opta-style percentile ranking, this player vs. every other player in the same league/season, per category. */
  protected openPercentileRadarChart(player: PlayerLeaderboardEntry): void {
    const players = this.dash.playerLeaderboard();
    if (players.length < 2) {
      this.toast.error('Not enough players in this league/season yet to rank percentiles against.');
      return;
    }

    type Category = { label: string; get: (p: PlayerLeaderboardEntry) => number; lowerIsBetter?: boolean };
    const categories: Category[] = [
      { label: 'PTS', get: (p) => p.perGame['pts'] ?? 0 },
      { label: 'REB', get: (p) => (p.perGame['oreb'] ?? 0) + (p.perGame['dreb'] ?? 0) },
      { label: 'AST', get: (p) => p.perGame['ast'] ?? 0 },
      { label: 'STL', get: (p) => p.perGame['stl'] ?? 0 },
      { label: 'BLK', get: (p) => p.perGame['blk'] ?? 0 },
      { label: 'TS%', get: (p) => p.advanced.ts_pct },
      { label: 'Ball security', get: (p) => p.perGame['tov'] ?? 0, lowerIsBetter: true },
    ];

    const percentileFor = (cat: Category): number => {
      const values = players.map((p) => cat.get(p));
      const target = cat.get(player);
      const worse = values.filter((v) => (cat.lowerIsBetter ? v > target : v < target)).length;
      const tied = values.filter((v) => v === target).length;
      return Math.round(((worse + tied * 0.5) / values.length) * 100);
    };

    this.chartModal.set({
      title: `${player.playerName} — league percentiles`,
      description: `Where ${player.playerName} ranks against every other player in this league/season, category by category (100 = best in the league, 50 = median). Computed only from box-score per-game stats — no tracking data involved.`,
      chartType: 'radar',
      percentileScale: true,
      data: {
        labels: categories.map((c) => c.label),
        datasets: [
          {
            label: player.playerName,
            data: categories.map((c) => percentileFor(c)),
            borderColor: chartPalette.accent,
            backgroundColor: 'rgba(255, 122, 41, 0.25)',
            pointBackgroundColor: chartPalette.accent,
          },
        ],
      } as ChartData,
    });
  }
}
