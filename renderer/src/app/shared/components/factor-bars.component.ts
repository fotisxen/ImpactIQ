import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export interface FactorBar {
  label: string;
  /** 0-1 fraction — rendered as a percentage of the 100%-wide track. */
  value: number;
}

/** "Carpet" chart — each DOE four-factor percentage as its own 100%-wide track with a filled bar showing the actual share. */
@Component({
  selector: 'app-factor-bars',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="factor-bars card">
      <h4>Four Factors</h4>
      @for (f of factors(); track f.label) {
        <div class="factor-row">
          <span class="factor-label">{{ f.label }}</span>
          <div class="factor-track">
            <div class="factor-fill" [style.width.%]="f.value * 100"></div>
          </div>
          <span class="factor-value">{{ (f.value * 100).toFixed(2) }}%</span>
        </div>
      }
    </div>
  `,
  styles: `
    .factor-bars {
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
    .factor-row {
      display: grid;
      grid-template-columns: 70px 1fr 64px;
      align-items: center;
      gap: var(--space-3);
    }
    .factor-label {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--text-muted);
    }
    .factor-track {
      height: 10px;
      border-radius: 999px;
      background: var(--surface-raised);
      border: 1px solid var(--border);
      overflow: hidden;
    }
    .factor-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 999px;
    }
    .factor-value {
      font-size: 0.8rem;
      font-weight: 700;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class FactorBarsComponent {
  readonly factors = input.required<FactorBar[]>();
}
