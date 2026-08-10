import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { BaseChartDirective } from 'ng2-charts';
import { baseChartOptions, chartPalette } from '../utils/chart-theme';

/** Line chart of a single stat across a game log. */
@Component({
  selector: 'app-stat-trend-chart',
  standalone: true,
  imports: [BaseChartDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-card card">
      <h4>{{ title() }}</h4>
      @if (labels().length > 0) {
        <div class="chart-wrap">
          <canvas baseChart [data]="chartData()" [options]="options" type="line"></canvas>
        </div>
      } @else {
        <p class="hint">No games saved yet.</p>
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
      height: 260px;
    }
  `,
})
export class StatTrendChartComponent {
  readonly title = input.required<string>();
  readonly labels = input.required<string[]>();
  readonly data = input.required<number[]>();

  protected readonly options = baseChartOptions;

  protected readonly chartData = computed<ChartConfiguration<'line'>['data']>(() => ({
    labels: this.labels(),
    datasets: [
      {
        label: this.title(),
        data: this.data(),
        borderColor: chartPalette.accent,
        backgroundColor: 'rgba(255, 122, 41, 0.15)',
        fill: true,
        tension: 0.3,
        pointBackgroundColor: chartPalette.accent,
        pointRadius: 3,
      },
    ],
  }));
}
