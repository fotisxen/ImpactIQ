import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { STAT_GLOSSARY } from '../utils/stat-glossary';

/**
 * A single big-number stat display. `value` is pre-formatted by the caller
 * (e.g. "58.3%", "24.1", "112") so this component stays unit-agnostic.
 * `diff`, if provided, is shown as a small +/- delta vs. a comparison line
 * (e.g. team or league average) with positive/negative coloring.
 * Pass `clickable` to render it as a button (e.g. to open a trend modal)
 * and listen on `tileClick`.
 */
@Component({
  selector: 'app-stat-tile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tile" [class.clickable]="clickable()" (click)="onClick()">
      <span class="tile-label-row">
        <span class="tile-label">{{ label() }}</span>
        @if (definition(); as def) {
          <span class="info-icon" tabindex="0" (click)="$event.stopPropagation()">
            ⓘ
            <span class="tooltip-bubble">{{ def }}</span>
          </span>
        }
      </span>
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
      /* Reserves room for the "vs league" diff line even when this tile has none, so tiles stay the same height whether or not a comparison is available. */
      min-height: 6.25rem;
    }
    .tile.clickable {
      cursor: pointer;
      transition: border-color 0.15s ease;
    }
    .tile.clickable:hover {
      border-color: var(--accent);
    }
    .tile-label-row {
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }
    .tile-label {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }
    .info-icon {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 0.9rem;
      height: 0.9rem;
      border-radius: 50%;
      font-size: 0.68rem;
      font-weight: 400;
      text-transform: none;
      letter-spacing: normal;
      color: var(--text-faint);
      cursor: help;
      outline: none;
    }
    .info-icon:hover,
    .info-icon:focus-visible {
      color: var(--accent);
    }
    .tooltip-bubble {
      position: absolute;
      z-index: 30;
      bottom: calc(100% + 0.4rem);
      left: 50%;
      transform: translateX(-50%);
      width: max-content;
      max-width: 15rem;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-lg);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
      font-size: 0.75rem;
      font-weight: 500;
      line-height: 1.4;
      text-transform: none;
      letter-spacing: normal;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.12s ease;
      pointer-events: none;
    }
    .info-icon:hover .tooltip-bubble,
    .info-icon:focus-visible .tooltip-bubble {
      opacity: 1;
      visibility: visible;
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
  /** Decimal places for the diff line — matches the tile's own value precision (see advNumFmt3 callers). */
  readonly diffDecimals = input<number>(1);
  readonly clickable = input<boolean>(false);
  readonly tileClick = output<void>();

  protected onClick(): void {
    if (this.clickable()) this.tileClick.emit();
  }

  protected readonly definition = computed(() => STAT_GLOSSARY[this.label()] ?? null);

  protected readonly diffSign = computed(() => {
    const d = this.diff();
    if (d === null || Number.isNaN(d)) return 0;
    return Math.sign(d);
  });

  protected readonly diffLabel = computed(() => {
    const d = this.diff();
    if (d === null || Number.isNaN(d)) return null;
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(this.diffDecimals())}`;
  });
}
