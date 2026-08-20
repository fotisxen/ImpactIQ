import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { EntitiesService } from '../../core/data/entities.service';
import {
  FourFactorsMetric,
  League,
  LineupCombosMetric,
  Season,
  Team,
  TeamFourFactorsReport,
} from '../../core/models/box-score.model';
import { EntityPickerComponent, PickerOption } from '../../shared/components/entity-picker.component';
import { LeaguePickerComponent } from '../../shared/components/league-picker.component';
import { StatTileComponent } from '../../shared/components/stat-tile.component';
import { ToastService } from '../../shared/services/toast.service';

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

@Component({
  selector: 'app-four-factors',
  standalone: true,
  imports: [EntityPickerComponent, LeaguePickerComponent, StatTileComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="four-factors-page">
      <header class="page-header">
        <h2>Four Factors</h2>
        <p class="hint">
          Primary Metrics (what happened) · Context Metrics (under what conditions) · Strategic Metrics
          (why it may have happened) — real numbers where this app's data supports them, an explicit N/A
          with a reason everywhere else. Nothing here is estimated or guessed.
        </p>
      </header>

      <div class="picker-row card">
        <app-league-picker
          [leagues]="leagues()"
          [selectedLeagueId]="selectedLeagueId()"
          [allowCreate]="false"
          (selectedLeagueIdChange)="selectLeague($event)"
        />
        @if (seasons().length > 0) {
          <app-entity-picker
            label="Season"
            [options]="seasonOptions()"
            [selectedId]="selectedSeasonId()"
            [allowCreate]="false"
            (selectedIdChange)="selectSeason($event)"
          />
        }
        <app-entity-picker
          label="Team"
          [options]="teamOptions()"
          [selectedId]="selectedTeamId()"
          [allowCreate]="false"
          (selectedIdChange)="selectTeam($event)"
        />
      </div>

      @if (loading()) {
        <p class="hint">Loading…</p>
      }

      @if (!loading() && report(); as r) {
        <div class="stat-category">
          <h4>Primary Metrics <span class="hint">— what actually happened</span></h4>
          <div class="tile-grid">
            @for (m of r.primaryMetrics; track m.label) {
              <div class="tile-wrap" [class.na]="!m.available" [title]="m.reason ?? ''">
                <app-stat-tile [label]="m.label" [value]="fmt(m)" />
              </div>
            }
          </div>
        </div>

        <div class="stat-category">
          <h4>Context Metrics <span class="hint">— under what conditions it happened</span></h4>
          <div class="tile-grid">
            @for (m of contextTiles(); track m.label) {
              <div class="tile-wrap" [class.na]="!m.available" [title]="m.reason ?? ''">
                <app-stat-tile [label]="m.label" [value]="fmt(m)" />
              </div>
            }
          </div>

          @if (lineupCombosMetric(); as lc) {
            <div class="sub-block">
              <h5>Lineup Combinations</h5>
              @if (lc.available && lc.lineups && lc.lineups.length > 0) {
                <div class="table-scroll">
                  <table class="log-table">
                    <thead>
                      <tr><th>Lineup</th><th>MIN</th><th>Net Rtg / 100</th></tr>
                    </thead>
                    <tbody>
                      @for (l of lc.lineups; track l.playerNames.join(',')) {
                        <tr>
                          <td>{{ l.playerNames.join(', ') }}</td>
                          <td>{{ l.minutes }}</td>
                          <td>{{ l.netRatingPer100 !== null ? l.netRatingPer100.toFixed(1) : '—' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else {
                <p class="hint na-text">N/A — {{ lc.reason }}</p>
              }
            </div>
          }

          <div class="sub-block">
            <h5>Positions</h5>
            <p class="hint">Optional, manual — nobody tracks this automatically. Set once per player.</p>
            <div class="roster-position-grid">
              @for (p of r.roster; track p.playerId) {
                <label class="field">
                  <span class="field-label">{{ p.playerName }}</span>
                  <select (change)="onPositionChange(p.playerId, $event)">
                    <option value="" [selected]="!p.position">—</option>
                    @for (pos of positions; track pos) {
                      <option [value]="pos" [selected]="pos === p.position">{{ pos }}</option>
                    }
                  </select>
                </label>
              }
            </div>
          </div>
        </div>

        <div class="stat-category">
          <h4>Strategic Metrics <span class="hint">— why it may have happened</span></h4>
          <div class="tile-grid">
            @for (m of r.strategicMetrics; track m.label) {
              <div class="tile-wrap na" [title]="m.reason ?? ''">
                <app-stat-tile [label]="m.label" value="N/A" />
              </div>
            }
          </div>
        </div>

        <div class="combo-row">
          @for (c of r.combos; track c.label) {
            <div class="combo-card card">
              <div class="combo-header">
                <h4>{{ c.label }}</h4>
                <span class="badge badge-accent">{{ c.weightPct }}%</span>
              </div>
              <div class="tile-wrap" [class.na]="!c.primary.available">
                <app-stat-tile [label]="c.primary.label" [value]="fmt(c.primary)" />
              </div>
              <div class="sub-metric-list">
                @for (sm of c.subMetrics; track sm.label) {
                  <div class="sub-metric-row" [class.na]="!sm.available" [title]="sm.reason ?? ''">
                    <span class="sm-label">{{ sm.label }}</span>
                    <span class="sm-value">{{ fmt(sm) }}</span>
                  </div>
                }
              </div>
            </div>
          }
        </div>
      } @else if (!loading() && selectedTeamId() !== null) {
        <div class="empty-state card">
          <p class="hint">No data for this team/season yet.</p>
        </div>
      }
    </section>
  `,
  styles: `
    .four-factors-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      padding: var(--space-6);
      max-width: 1200px;
    }
    .page-header {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
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
    .stat-category h4 .hint {
      text-transform: none;
      letter-spacing: normal;
      font-weight: 500;
    }
    .tile-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: var(--space-3);
    }
    .tile-wrap.na {
      opacity: 0.5;
    }
    .sub-block {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .sub-block h5 {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .na-text {
      font-style: italic;
    }
    .roster-position-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: var(--space-3);
    }
    .roster-position-grid select {
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
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
    .combo-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: var(--space-4);
    }
    .combo-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .combo-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }
    .combo-header h4 {
      font-size: 0.95rem;
    }
    .sub-metric-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .sub-metric-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
      background: var(--surface-raised);
      font-size: 0.82rem;
    }
    .sub-metric-row.na {
      opacity: 0.5;
    }
    .sm-label {
      color: var(--text-muted);
    }
    .sm-value {
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 160px;
    }
  `,
})
export class FourFactorsComponent {
  private readonly entities = inject(EntitiesService);
  private readonly toast = inject(ToastService);

  protected readonly positions = POSITIONS;

  protected readonly leagues = signal<League[]>([]);
  protected readonly teams = signal<Team[]>([]);
  protected readonly seasons = signal<Season[]>([]);
  protected readonly selectedLeagueId = signal<number | null>(null);
  protected readonly selectedSeasonId = signal<number | null>(null);
  protected readonly selectedTeamId = signal<number | null>(null);
  protected readonly loading = signal(false);
  protected readonly report = signal<TeamFourFactorsReport | null>(null);

  protected readonly teamOptions = computed<PickerOption[]>(() => {
    const leagueId = this.selectedLeagueId();
    if (leagueId === null) return [];
    return this.teams()
      .filter((t) => t.league_id === leagueId)
      .map((t) => ({ id: t.id, label: t.name }));
  });

  protected readonly seasonOptions = computed<PickerOption[]>(() =>
    this.seasons().map((s) => ({ id: s.id, label: s.year }))
  );

  protected readonly lineupCombosMetric = computed<LineupCombosMetric | null>(() => {
    const r = this.report();
    if (!r) return null;
    return (r.contextMetrics.find((m) => m.label === 'Lineup Combinations') as LineupCombosMetric) ?? null;
  });

  /** Context Metrics tiles minus Lineup Combinations, which renders as its own table below. */
  protected readonly contextTiles = computed<FourFactorsMetric[]>(() =>
    (this.report()?.contextMetrics ?? []).filter((m) => m.label !== 'Lineup Combinations')
  );

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    const [teams, leagues] = await Promise.all([this.entities.listTeams(), this.entities.listLeagues()]);
    this.teams.set(teams);
    this.leagues.set(leagues);
  }

  protected async selectLeague(leagueId: number | null): Promise<void> {
    this.selectedLeagueId.set(leagueId);
    this.selectedTeamId.set(null);
    this.report.set(null);
    if (leagueId === null) {
      this.seasons.set([]);
      this.selectedSeasonId.set(null);
      return;
    }
    const seasons = await this.entities.listSeasons(leagueId);
    this.seasons.set(seasons);
    this.selectedSeasonId.set(seasons[0]?.id ?? null);
  }

  protected selectSeason(seasonId: number | null): void {
    this.selectedSeasonId.set(seasonId);
    void this.loadReport();
  }

  protected selectTeam(teamId: number | null): void {
    this.selectedTeamId.set(teamId);
    void this.loadReport();
  }

  private async loadReport(): Promise<void> {
    const teamId = this.selectedTeamId();
    const seasonId = this.selectedSeasonId();
    if (teamId === null || seasonId === null) {
      this.report.set(null);
      return;
    }
    this.loading.set(true);
    try {
      this.report.set(await window.boxscoreApi.getTeamFourFactorsReport(teamId, seasonId));
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load the Four Factors report.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async onPositionChange(playerId: number, event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value || null;
    try {
      await window.boxscoreApi.updatePlayerPosition(playerId, value);
      const r = this.report();
      if (r) {
        this.report.set({
          ...r,
          roster: r.roster.map((p) => (p.playerId === playerId ? { ...p, position: value } : p)),
        });
      }
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to save the position.');
    }
  }

  protected fmt(m: FourFactorsMetric): string {
    if (!m.available || m.value === null) return 'N/A';
    return m.isPercent ? `${(m.value * 100).toFixed(2)}%` : m.value.toFixed(2);
  }
}
