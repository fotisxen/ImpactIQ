import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { BaseChartDirective } from 'ng2-charts';
import { bumpChartOptions, categoricalPalette } from '../utils/chart-theme';
import { LeagueStandingsHistory } from '../../core/models/box-score.model';

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

  protected readonly options = bumpChartOptions;

  protected readonly chartData = computed<ChartConfiguration<'line'>['data']>(() => {
    const h = this.history();
    return {
      labels: h.dates,
      datasets: h.teams.map((t, i) => {
        const color = categoricalPalette[i % categoricalPalette.length];
        return {
          label: t.teamName,
          data: t.ranks,
          borderColor: color,
          backgroundColor: color,
          spanGaps: false,
          tension: 0.2,
          pointRadius: 3,
          pointBackgroundColor: color,
        };
      }),
    };
  });
}
