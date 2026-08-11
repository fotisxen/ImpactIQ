import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ChartData, ChartOptions, ChartType } from 'chart.js';
import { BaseChartDirective } from 'ng2-charts';

/**
 * General-purpose pop-up chart modal — opened by clicking a stat tile or
 * category header, same interaction as the PIE "score line" modal, but
 * supports any chart.js chart type (radar, doughnut, bubble, polar area,
 * ...) so each metric can use whichever chart shape actually explains it
 * best, instead of forcing everything into a line/bar.
 */
@Component({
  selector: 'app-insight-chart-modal',
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
        <p class="description">{{ description() }}</p>
        <div class="chart-wrap">
          <canvas baseChart [type]="chartType()" [data]="data()" [options]="options()"></canvas>
        </div>
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
      gap: var(--space-3);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    h3 {
      font-size: 1.1rem;
    }
    .description {
      color: var(--text-muted);
      font-size: 0.85rem;
      line-height: 1.5;
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
      height: 360px;
    }
  `,
})
export class InsightChartModalComponent {
  readonly title = input.required<string>();
  readonly description = input.required<string>();
  readonly chartType = input.required<ChartType>();
  readonly data = input.required<ChartData>();
  readonly options = input<ChartOptions>({});
  readonly close = output<void>();
}
