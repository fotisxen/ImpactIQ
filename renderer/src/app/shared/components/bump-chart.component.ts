import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { BaseChartDirective } from 'ng2-charts';
import { bumpChartOptions, categoricalPalette } from '../utils/chart-theme';
import { LeagueStandingsHistory } from '../../core/models/box-score.model';

function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Bump chart — every team's rank at every date across a season, one line per team, rank 1 on top. */
@Component({
  selector: 'app-bump-chart',
  standalone: true,
  imports: [BaseChartDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-card card">
      <h4>Standings over the season</h4>
      @if (history().dates.length > 1) {
        <div class="chart-wrap">
          <canvas baseChart [data]="chartData()" [options]="options" type="line"></canvas>
        </div>
      } @else {
        <p class="hint">Needs at least two dates of games to show movement.</p>
      }
    </div>
  `,
  styles: `
    .chart-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    h4 {
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .chart-wrap {
      height: 320px;
    }
  `,
})
export class BumpChartComponent {
  readonly history = input.required<LeagueStandingsHistory>();
  /** When set, that team's line stays at full opacity and every other line dims — so one team's season is easy to trace. */
  readonly selectedTeamId = input<number | null>(null);

  protected readonly options = bumpChartOptions;

  protected readonly chartData = computed<ChartConfiguration<'line'>['data']>(() => {
    const h = this.history();
    const selected = this.selectedTeamId();
    return {
      labels: h.dates,
      datasets: h.teams.map((t, i) => {
        const color = categoricalPalette[i % categoricalPalette.length];
        const isSelected = selected === null || t.teamId === selected;
        const lineColor = isSelected ? color : withAlpha(color, 0.12);
        return {
          label: t.teamName,
          data: t.ranks,
          borderColor: lineColor,
          backgroundColor: lineColor,
          borderWidth: selected !== null && t.teamId === selected ? 3 : 2,
          spanGaps: false,
          tension: 0.2,
          pointRadius: isSelected ? 3 : 0,
          pointBackgroundColor: lineColor,
        };
      }),
    };
  });
}
