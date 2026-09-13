import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ShotEvent } from '../../core/models/box-score.model';

/**
 * A real half-court with one dot per shot attempt, at its actual location —
 * not the abstract 5-region zone chart. Uses the exact same court markings
 * (lane, free-throw circle, restricted arc, 3-point line) as the Draw tool's
 * court, and the same 0-300x0-320 coordinate space, so shot locations line up
 * visually with anything drawn there. Renders a clear "no data" state until
 * real shot-location data has been imported — never a fabricated chart.
 */
@Component({
  selector: 'app-shot-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shots() && shots()!.length > 0) {
      <div class="shot-chart-wrap">
        <svg viewBox="0 0 300 320" class="court">
          <rect x="0" y="0" width="300" height="320" class="court-bg" />
          <rect x="105" y="0" width="90" height="140" class="court-line" />
          <circle cx="150" cy="140" r="45" class="court-line" />
          <path d="M 105,20 A 20,20 0 0,0 195,20" class="court-line" />
          <path d="M 25,0 L 25,71 A 135,135 0 0,0 275,71 L 275,0" class="court-line" />
          <rect x="135" y="4" width="30" height="2" class="backboard" />
          <circle cx="150" cy="20" r="7.5" class="hoop" />

          @for (s of shots(); track $index) {
            @if (s.made === 1) {
              <circle [attr.cx]="s.x" [attr.cy]="s.y" r="4" class="shot made" />
            } @else {
              <path [attr.d]="missMarker(s.x, s.y)" class="shot missed" />
            }
          }
        </svg>
        <div class="shot-summary">
          <div class="summary-row"><span>Overall</span><strong>{{ summary().fgm }}-{{ summary().fga }} ({{ summary().pct }})</strong></div>
          <div class="summary-row"><span>2PT</span><strong>{{ summary().fgm2 }}-{{ summary().fga2 }} ({{ summary().pct2 }})</strong></div>
          <div class="summary-row"><span>3PT</span><strong>{{ summary().fgm3 }}-{{ summary().fga3 }} ({{ summary().pct3 }})</strong></div>
          <div class="legend">
            <span class="legend-item"><span class="dot made"></span> Made</span>
            <span class="legend-item"><span class="dot missed"></span> Missed</span>
          </div>
        </div>
      </div>
    } @else {
      <p class="hint">No shot-location data imported yet for this team/season.</p>
    }
  `,
  styles: `
    .shot-chart-wrap {
      display: flex;
      gap: var(--space-4);
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .court {
      width: 220px;
      height: 235px;
      flex-shrink: 0;
      background: var(--surface-hover);
      border-radius: var(--radius-sm);
    }
    .court-bg {
      fill: transparent;
    }
    .court-line {
      fill: none;
      stroke: var(--border-strong);
      stroke-width: 1.5;
    }
    .backboard {
      fill: var(--text-faint);
    }
    .hoop {
      fill: none;
      stroke: var(--negative);
      stroke-width: 2;
    }
    .shot.made {
      fill: var(--positive);
      opacity: 0.85;
    }
    .shot.missed {
      fill: none;
      stroke: var(--negative);
      stroke-width: 1.5;
      opacity: 0.75;
    }
    .shot-summary {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      min-width: 150px;
      font-size: 0.85rem;
    }
    .summary-row {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
    }
    .summary-row span {
      color: var(--text-muted);
    }
    .legend {
      display: flex;
      gap: var(--space-3);
      margin-top: var(--space-2);
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .dot.made {
      background: var(--positive);
    }
    .dot.missed {
      background: transparent;
      border: 1.5px solid var(--negative);
    }
    .hint {
      color: var(--text-muted);
    }
  `,
})
export class ShotChartComponent {
  readonly shots = input<ShotEvent[] | null>(null);

  protected missMarker(x: number, y: number): string {
    const r = 4;
    return `M ${x - r},${y - r} L ${x + r},${y + r} M ${x - r},${y + r} L ${x + r},${y - r}`;
  }

  protected readonly summary = computed(() => {
    const list = this.shots() ?? [];
    const fga = list.length;
    const fgm = list.filter((s) => s.made === 1).length;
    const twos = list.filter((s) => s.value === 2);
    const threes = list.filter((s) => s.value === 3);
    const fga2 = twos.length;
    const fgm2 = twos.filter((s) => s.made === 1).length;
    const fga3 = threes.length;
    const fgm3 = threes.filter((s) => s.made === 1).length;
    const pctOf = (m: number, a: number) => (a === 0 ? '—' : `${((m / a) * 100).toFixed(1)}%`);
    return {
      fgm, fga, pct: pctOf(fgm, fga),
      fgm2, fga2, pct2: pctOf(fgm2, fga2),
      fgm3, fga3, pct3: pctOf(fgm3, fga3),
    };
  });
}
