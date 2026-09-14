import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ShotZoneChart, ShotZoneEntry, ShotZoneKey } from '../../core/models/box-score.model';

export interface ZoneShape {
  zone: ShotZoneKey;
  label: string;
  /** Center point (in the 0-300 x 0-280 viewBox) for the label/value text. */
  cx: number;
  cy: number;
  path: string;
}

// A simplified half-court, 5 zones matching the app's own shot_zones data model
// (one region per zone, not split left/right — a deliberate simplification since
// the underlying data is column-based, not coordinate-based). Exported so the
// manual Shot Chart entry screen can reuse the exact same regions to click on.
export const ZONE_SHAPES: ZoneShape[] = [
  { zone: 'at_rim', label: 'At The Rim', cx: 150, cy: 55, path: 'M 110,20 A 40,40 0 0,0 190,20 Z' },
  { zone: 'mid_range', label: 'Mid-Range', cx: 150, cy: 115, path: 'M 60,20 A 100,100 0 0,0 110,20 L 110,20 A 40,40 0 0,1 190,20 L 240,20 A 100,100 0 0,0 190,20 Z M 60,20 A 100,100 0 0,0 240,20' },
  { zone: 'corner_3', label: 'Corner 3', cx: 30, cy: 200, path: 'M 5,20 L 5,180 L 55,180 L 55,20 Z' },
  { zone: 'wing_3', label: 'Wing 3', cx: 80, cy: 40, path: 'M 5,180 A 160,160 0 0,0 60,20 L 100,60 A 100,100 0 0,0 60,180 Z' },
  { zone: 'top_key_3', label: 'Top of Key 3', cx: 150, cy: 250, path: 'M 60,20 A 160,160 0 0,0 240,20 L 190,20 A 100,100 0 0,1 110,20 Z' },
];

/**
 * Simplified half-court shot chart — 5 zones (matching the app's own
 * `shot_zones` table columns), each colored by hot/cold classification.
 * Renders a clear "no data" state until real zone data has been imported
 * for this team/player/season — never a fabricated chart.
 */
@Component({
  selector: 'app-shot-zone-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data() && data()!.hasData) {
      <div class="shot-zone-wrap">
        <svg viewBox="0 0 300 280" class="court">
          <rect x="0" y="0" width="300" height="280" class="court-bg" />
          <circle cx="150" cy="20" r="8" class="hoop" />
          @for (shape of shapes; track shape.zone) {
            <path [attr.d]="shape.path" class="zone" [class.hot]="heatFor(shape.zone) === 'hot'" [class.cold]="heatFor(shape.zone) === 'cold'" />
          }
        </svg>
        <div class="zone-legend">
          @for (shape of shapes; track shape.zone) {
            <div class="zone-row" [class.hot]="heatFor(shape.zone) === 'hot'" [class.cold]="heatFor(shape.zone) === 'cold'">
              <span class="zone-label">{{ shape.label }}</span>
              <span class="zone-value">{{ fmt(shape.zone) }}</span>
            </div>
          }
        </div>
      </div>
    } @else {
      <p class="hint">No shot-location data imported yet for this team/season.</p>
    }
  `,
  styles: `
    .shot-zone-wrap {
      display: flex;
      gap: var(--space-4);
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .court {
      width: 200px;
      height: 187px;
      flex-shrink: 0;
    }
    .court-bg {
      fill: var(--surface);
    }
    .hoop {
      fill: none;
      stroke: var(--text-faint);
      stroke-width: 2;
    }
    .zone {
      fill: var(--surface-hover);
      stroke: var(--border-strong);
      stroke-width: 1;
    }
    .zone.hot {
      fill: var(--positive-muted, rgba(53, 208, 127, 0.25));
    }
    .zone.cold {
      fill: var(--negative-muted, rgba(255, 92, 122, 0.2));
    }
    .zone-legend {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      min-width: 160px;
    }
    .zone-row {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
      font-size: 0.82rem;
      padding: var(--space-1) var(--space-2);
      border-radius: var(--radius-sm);
    }
    .zone-row.hot {
      color: var(--positive);
    }
    .zone-row.cold {
      color: var(--negative);
    }
    .zone-label {
      color: inherit;
    }
    .zone-value {
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class ShotZoneChartComponent {
  readonly data = input<ShotZoneChart | null>(null);

  protected readonly shapes = ZONE_SHAPES;

  private entryFor(zone: ShotZoneKey): ShotZoneEntry | undefined {
    return this.data()?.chart.find((z) => z.zone === zone);
  }

  protected heatFor(zone: ShotZoneKey): string {
    return this.entryFor(zone)?.heat ?? 'neutral';
  }

  protected fmt(zone: ShotZoneKey): string {
    const e = this.entryFor(zone);
    if (!e || e.fga === 0) return '—';
    const pct = e.fgPct !== null ? `${(e.fgPct * 100).toFixed(1)}%` : '—';
    return `${e.fgm}-${e.fga} (${pct})`;
  }
}
