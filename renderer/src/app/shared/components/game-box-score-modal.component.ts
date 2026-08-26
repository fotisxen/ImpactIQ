import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { GameBoxScore, PlayerBoxScore } from '../../core/models/box-score.model';

const STAT_KEYS = [
  'min', 'pts', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta',
  'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf', 'pfd', 'plus_minus', 'srj',
] as const;

/** Read-only preview of one game's full box score — opened from the Recent Games "eye" icon, with an Excel/PDF export action. */
@Component({
  selector: 'app-game-box-score-modal',
  standalone: true,
  imports: [UpperCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-backdrop" (click)="close.emit()">
      <div class="modal-card card" (click)="$event.stopPropagation()">
        <header>
          <div>
            <h3>{{ boxScore().homeTeamName }} vs {{ boxScore().awayTeamName }}</h3>
            <p class="hint">{{ boxScore().date }} · {{ boxScore().leagueName }} {{ boxScore().seasonYear }}</p>
          </div>
          <button type="button" class="close-btn" (click)="close.emit()" aria-label="Close">✕</button>
        </header>

        <div class="export-row">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            [disabled]="exporting() !== null"
            (click)="exportRequested.emit('excel')"
          >
            {{ exporting() === 'excel' ? 'Exporting…' : 'Export Excel' }}
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            [disabled]="exporting() !== null"
            (click)="exportRequested.emit('pdf')"
          >
            {{ exporting() === 'pdf' ? 'Exporting…' : 'Export PDF' }}
          </button>
        </div>

        <div class="tables">
          @for (side of ['home', 'away']; track side) {
            <div class="team-block">
              <h4>{{ side === 'home' ? boxScore().homeTeamName : boxScore().awayTeamName }}</h4>
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th class="col-name">Player</th>
                      @for (key of statKeys; track key) {
                        <th>{{ key | uppercase }}</th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of side === 'home' ? boxScore().homeRoster : boxScore().awayRoster; track p.name) {
                      <tr>
                        <td class="col-name">{{ p.name }}</td>
                        @for (key of statKeys; track key) {
                          <td>{{ p[key] }}</td>
                        }
                      </tr>
                    }
                    <tr class="totals-row">
                      <td class="col-name">Total</td>
                      @for (key of statKeys; track key) {
                        <td>{{ (side === 'home' ? boxScore().homeTotals : boxScore().awayTotals)[key] }}</td>
                      }
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          }
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
      max-width: 960px;
      max-height: 85vh;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: var(--space-6);
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: flex-start;
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
    .export-row {
      display: flex;
      gap: var(--space-2);
    }
    .tables {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      overflow-y: auto;
    }
    .team-block h4 {
      font-size: 0.85rem;
      font-weight: 700;
      margin-bottom: var(--space-2);
    }
    .table-scroll {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
      white-space: nowrap;
    }
    th, td {
      padding: var(--space-2) var(--space-2);
      text-align: right;
      border-bottom: 1px solid var(--border);
    }
    .col-name {
      text-align: left;
      font-weight: 600;
    }
    .totals-row td {
      font-weight: 700;
      border-top: 2px solid var(--border-strong);
      border-bottom: none;
    }
  `,
})
export class GameBoxScoreModalComponent {
  readonly boxScore = input.required<GameBoxScore>();
  readonly exporting = input<'excel' | 'pdf' | null>(null);
  readonly close = output<void>();
  readonly exportRequested = output<'excel' | 'pdf'>();

  protected readonly statKeys = STAT_KEYS;
}
