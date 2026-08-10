import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { PlayerBoxScore } from '../../core/models/box-score.model';
import { EntityPickerComponent, PickerOption } from './entity-picker.component';

const STAT_KEYS = [
  'min', 'pts', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta',
  'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf', 'pfd', 'plus_minus',
] as const;
type StatKey = (typeof STAT_KEYS)[number];

/**
 * A single team's editable roster grid. The header is a team picker (not a
 * static label) so a wrong OCR/manual name-to-team mapping can be
 * corrected right on the card. Save/export live at the page level.
 */
@Component({
  selector: 'app-box-score-table',
  standalone: true,
  imports: [UpperCasePipe, EntityPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="table-card card">
      <div class="table-header">
        <app-entity-picker
          [label]="cardLabel()"
          [options]="teamOptions()"
          [selectedId]="selectedTeamId()"
          [allowCreate]="allowCreateTeam()"
          (selectedIdChange)="selectedTeamIdChange.emit($event)"
          (create)="createTeam.emit($event)"
        />
        @if (sourceName()) {
          <span class="hint">as entered: {{ sourceName() }}</span>
        }
      </div>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th class="col-name">Player</th>
              @for (key of statKeys; track key) {
                <th>{{ key | uppercase }}</th>
              }
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            @for (player of roster(); track $index; let i = $index) {
              <tr>
                <td class="col-name">
                  <input
                    type="text"
                    [value]="player.name"
                    (change)="onNameEdit(i, $event)"
                    placeholder="Player name"
                  />
                </td>
                @for (key of statKeys; track key) {
                  <td>
                    <input type="number" [value]="player[key]" (change)="onStatEdit(i, key, $event)" />
                  </td>
                }
                <td class="col-actions">
                  <button
                    type="button"
                    class="btn btn-icon btn-ghost"
                    (click)="removePlayer.emit(i)"
                    title="Remove row"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            }
          </tbody>
          <tfoot>
            <tr>
              <td class="col-name">Totals</td>
              @for (key of statKeys; track key) {
                <td>{{ totals()[key] }}</td>
              }
              <td class="col-actions"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <button type="button" class="btn btn-secondary btn-sm add-row" (click)="addPlayer.emit()">
        + Add player row
      </button>
    </div>
  `,
  styles: `
    .table-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      min-width: 0;
    }
    .table-header {
      display: flex;
      align-items: flex-end;
      gap: var(--space-3);
    }
    .table-header app-entity-picker {
      max-width: 260px;
    }
    .table-header .hint {
      padding-bottom: var(--space-2);
    }

    .table-scroll {
      overflow-x: auto;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
    }

    table {
      width: 100%;
      font-size: 0.82rem;
    }

    thead th {
      position: sticky;
      top: 0;
      background: var(--surface-raised);
      color: var(--text-muted);
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: var(--space-2) var(--space-2);
      border-bottom: 1px solid var(--border-strong);
      z-index: 1;
    }

    td {
      padding: 0.2rem 0.3rem;
      border-bottom: 1px solid var(--border);
      text-align: center;
    }

    tbody tr:nth-child(even) {
      background: rgba(255, 255, 255, 0.02);
    }
    tbody tr:hover {
      background: var(--surface-hover);
    }

    .col-name {
      text-align: left;
      min-width: 8rem;
    }
    .col-actions {
      width: 2.25rem;
    }

    input[type='number'] {
      width: 2.9rem;
      text-align: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 0.3rem 0.2rem;
      font-variant-numeric: tabular-nums;
    }
    input[type='text'] {
      width: 100%;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 0.3rem 0.4rem;
      font-weight: 600;
    }
    input:hover {
      border-color: var(--border-strong);
    }
    input:focus {
      background: var(--surface-raised);
      border-color: var(--accent);
    }

    tfoot td {
      font-weight: 700;
      color: var(--text);
      background: var(--surface-raised);
      border-top: 2px solid var(--border-strong);
      border-bottom: none;
    }

    .btn-icon {
      color: var(--text-faint);
    }
    .btn-icon:hover {
      color: var(--negative);
    }

    .add-row {
      align-self: flex-start;
    }
  `,
})
export class BoxScoreTableComponent {
  /** Label for the team picker, e.g. "My Team" / "Opponent". */
  readonly cardLabel = input<string>('Team');
  /** The raw name as extracted/typed, shown as a hint next to the picker. */
  readonly sourceName = input<string>('');
  readonly teamOptions = input.required<PickerOption[]>();
  readonly selectedTeamId = input<number | null>(null);
  readonly allowCreateTeam = input(true);
  readonly roster = input.required<PlayerBoxScore[]>();

  readonly selectedTeamIdChange = output<number | null>();
  readonly createTeam = output<string>();
  readonly rosterChange = output<PlayerBoxScore[]>();
  readonly removePlayer = output<number>();
  readonly addPlayer = output<void>();

  protected readonly statKeys = STAT_KEYS;

  protected readonly totals = computed(() => {
    const totals: Record<StatKey, number> = {
      min: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
      oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0, pfd: 0, plus_minus: 0,
    };
    for (const player of this.roster()) {
      for (const key of STAT_KEYS) totals[key] += player[key] || 0;
    }
    return totals;
  });

  onNameEdit(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.emitPlayerChange(index, 'name', value);
  }

  onStatEdit(index: number, key: StatKey, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.emitPlayerChange(index, key, value);
  }

  private emitPlayerChange(index: number, key: keyof PlayerBoxScore, value: string | number): void {
    const players = this.roster().map((p, i) => (i === index ? { ...p, [key]: value } : p));
    this.rosterChange.emit(players);
  }
}
