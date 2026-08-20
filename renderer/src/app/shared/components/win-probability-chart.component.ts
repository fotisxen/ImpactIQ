import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { BaseChartDirective } from 'ng2-charts';
import { chartPalette, winProbabilityChartOptions } from '../utils/chart-theme';
import { GameWinProbability } from '../../core/models/box-score.model';

/** Win probability over the course of one game, home team's perspective. Only renders for play-by-play-imported games. */
@Component({
  selector: 'app-win-probability-chart',
  standalone: true,
  imports: [BaseChartDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-card card">
      <h4>Win probability</h4>
      <p class="hint">
        A generic estimate from scoring margin and time remaining — not calibrated against real historical
        outcomes for this league, since there isn't enough game volume yet. Treat it as a rough feel for how
        the game swung, not a precise probability.
      </p>
      <div class="chart-wrap">
        <canvas baseChart [data]="chartData()" [options]="options" type="line"></canvas>
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
      height: 280px;
    }
  `,
})
export class WinProbabilityChartComponent {
  readonly probability = input.required<GameWinProbability>();
  readonly homeTeamName = input.required<string>();
  readonly awayTeamName = input.required<string>();

  protected readonly options = winProbabilityChartOptions;

  protected readonly chartData = computed<ChartConfiguration<'line'>['data']>(() => {
    const p = this.probability();
    return {
      labels: p.points.map((pt) => this.formatClock(pt.clockSeconds)),
      datasets: [
        {
          label: `${this.homeTeamName()} win probability`,
          data: p.points.map((pt) => pt.homeWinProb * 100),
          borderColor: chartPalette.accent,
          backgroundColor: 'rgba(255, 122, 41, 0.12)',
          fill: true,
          tension: 0.15,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    };
  });

  private formatClock(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0');
    return `${m}:${s}`;
  }
}
