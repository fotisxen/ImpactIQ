import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ChartConfiguration } from 'chart.js';
import { BaseChartDirective } from 'ng2-charts';
import { baseChartOptions, chartPalette } from '../utils/chart-theme';

/**
 * Pop-up "score line" chart for a single metric across a player's games —
 * opened by clicking a stat tile (e.g. PIE) rather than living permanently
 * on the dashboard.
 */
@Component({
  selector: 'app-stat-line-modal',
  standalone: true,
  imports: [BaseChartDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-backdrop" (click)="close.emit()">
      <div class="modal-card card" (click)="$event.stopPropagation()">
        <header>
          <h3>{{ title() }}</h3>
          <button type="button" class="close-btn" (click)="close.emit()" aria-label="Close">✕</button>
        </header>
        @if (labels().length > 0) {
          <div class="chart-wrap">
            <canvas baseChart [data]="chartData()" [options]="options" type="line"></canvas>
          </div>
        } @else {
          <p class="hint">No games saved yet.</p>
        }
      </div>
    </div>
  `,
  styles: `
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 3000;
      background: rgba(4, 6, 12, 0.72);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-6);
    }
    .modal-card {
      width: 100%;
      max-width: 640px;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: var(--space-6);
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    h3 {
      font-size: 1.1rem;
    }
    .close-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 1rem;
      cursor: pointer;
      line-height: 1;
      padding: var(--space-1);
    }
    .close-btn:hover {
      color: var(--text);
    }
    .chart-wrap {
      height: 320px;
    }
  `,
})
export class StatLineModalComponent {
  readonly title = input.required<string>();
  readonly labels = input.required<string[]>();
  readonly data = input.required<number[]>();
  readonly close = output<void>();

  protected readonly options = baseChartOptions;

  protected readonly chartData = computed<ChartConfiguration<'line'>['data']>(() => ({
    labels: this.labels(),
    datasets: [
      {
        label: this.title(),
        data: this.data(),
        borderColor: chartPalette.accent2,
        backgroundColor: 'rgba(58, 160, 255, 0.15)',
        fill: true,
        tension: 0.3,
        pointBackgroundColor: chartPalette.accent2,
        pointRadius: 3,
      },
    ],
  }));
}
