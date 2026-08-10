import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * A single big-number stat display. `value` is pre-formatted by the caller
 * (e.g. "58.3%", "24.1", "112") so this component stays unit-agnostic.
 * `diff`, if provided, is shown as a small +/- delta vs. a comparison line
 * (e.g. team or league average) with positive/negative coloring.
 */
@Component({
  selector: 'app-stat-tile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tile">
      <span class="tile-label">{{ label() }}</span>
      <span class="tile-value">{{ value() }}</span>
      @if (diffLabel(); as d) {
        <span class="tile-diff" [class.positive]="diffSign() > 0" [class.negative]="diffSign() < 0">
          {{ d }} vs {{ diffAgainst() }}
        </span>
      }
    </div>
  `,
  styles: `
    .tile {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: var(--space-4) var(--space-5);
      min-width: 0;
    }
    .tile-label {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }
    .tile-value {
      font-size: 1.85rem;
      font-weight: 700;
      color: var(--text);
      line-height: 1.15;
      font-variant-numeric: tabular-nums;
    }
    .tile-diff {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--text-faint);
    }
    .tile-diff.positive {
      color: var(--positive);
    }
    .tile-diff.negative {
      color: var(--negative);
    }
  `,
})
export class StatTileComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly diff = input<number | null>(null);
  readonly diffAgainst = input<string>('team');

  protected readonly diffSign = computed(() => {
    const d = this.diff();
    if (d === null || Number.isNaN(d)) return 0;
    return Math.sign(d);
  });

  protected readonly diffLabel = computed(() => {
    const d = this.diff();
    if (d === null || Number.isNaN(d)) return null;
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}`;
  });
}
