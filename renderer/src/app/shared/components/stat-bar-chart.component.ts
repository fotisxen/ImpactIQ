import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { BaseChartDirective } from 'ng2-charts';
import { baseChartOptions } from '../utils/chart-theme';

export interface ChartSeries {
  label: string;
  data: number[];
  color: string;
}

/**
 * Grouped bar comparison (e.g. Player vs Team vs League) across a set of
 * same-scale stat categories — pass counting stats and shooting percentages
 * as separate instances since their scales differ.
 */
@Component({
  selector: 'app-stat-bar-chart',
  standalone: true,
  imports: [BaseChartDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-card card">
      <h4>{{ title() }}</h4>
      <div class="chart-wrap">
        <canvas baseChart [data]="chartData()" [options]="options" type="bar"></canvas>
      </div>
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
export class StatBarChartComponent {
  readonly title = input.required<string>();
  readonly labels = input.required<string[]>();
  readonly series = input.required<ChartSeries[]>();

  protected readonly options = baseChartOptions;

  protected readonly chartData = computed<ChartConfiguration<'bar'>['data']>(() => ({
    labels: this.labels(),
    datasets: this.series().map((s) => ({
      label: s.label,
      data: s.data,
      backgroundColor: s.color,
      borderRadius: 6,
      maxBarThickness: 28,
    })),
  }));
}
