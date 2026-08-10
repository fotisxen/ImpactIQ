import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ManualEntryService } from './manual-entry.service';
import { BoxScoreTableComponent } from '../../shared/components/box-score-table.component';
import { ExportService } from '../../shared/services/export.service';
import { ToastService } from '../../shared/services/toast.service';
import {
  GameContextPickerComponent,
  LeagueSeasonContext,
} from '../../shared/components/game-context-picker.component';
import { ALL_COUNTRIES } from '../../shared/components/league-picker.component';
import { ExtractedBoxScore } from '../../core/models/box-score.model';

@Component({
  selector: 'app-manual-entry',
  standalone: true,
  imports: [BoxScoreTableComponent, GameContextPickerComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="manual-entry-page">
      <header class="page-header">
        <h2>Enter a box score manually</h2>
        <p class="hint">No photo needed. <a routerLink="/upload">Or upload a photo instead.</a></p>
      </header>

      <app-game-context-picker #gameContext />

      <div class="field date-field">
        <span class="field-label">Date</span>
        <input
          type="date"
          [value]="entry.boxScore().date"
          (change)="onHeaderEdit('date', $event)"
        />
      </div>

      <div class="rosters">
        <app-box-score-table
          cardLabel="My Team"
          [teamOptions]="gameContext.teamOptions()"
          [selectedTeamId]="myTeamId()"
          [allowCreateTeam]="!!gameContext.leagueSeasonContext()"
          (selectedTeamIdChange)="myTeamId.set($event)"
          (createTeam)="onCreateTeam($event, true, gameContext)"
          [roster]="entry.boxScore().players"
          (rosterChange)="entry.setRoster('players', $event)"
          (removePlayer)="entry.removePlayerRow('players', $event)"
          (addPlayer)="entry.addPlayerRow('players')"
        />
        <app-box-score-table
          cardLabel="Opponent"
          [teamOptions]="gameContext.teamOptions()"
          [selectedTeamId]="opponentId()"
          [allowCreateTeam]="!!gameContext.leagueSeasonContext()"
          (selectedTeamIdChange)="opponentId.set($event)"
          (createTeam)="onCreateTeam($event, false, gameContext)"
          [roster]="entry.boxScore().opponentPlayers"
          (rosterChange)="entry.setRoster('opponentPlayers', $event)"
          (removePlayer)="entry.removePlayerRow('opponentPlayers', $event)"
          (addPlayer)="entry.addPlayerRow('opponentPlayers')"
        />
      </div>

      <div class="actions">
        <button
          type="button"
          class="btn btn-primary"
          [disabled]="!canSave(gameContext.leagueSeasonContext(), gameContext.selectedCountry())"
          (click)="
            save(
              entry.boxScore(),
              gameContext.leagueSeasonContext(),
              gameContext.selectedCountry(),
              gameContext.teamOptions()
            )
          "
        >
          Save game
        </button>
        <button type="button" class="btn btn-secondary" (click)="onExport(entry.boxScore())">
          Export to Excel
        </button>
      </div>
    </section>
  `,
  styles: `
    .manual-entry-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      padding: var(--space-6);
      max-width: 1200px;
    }
    .page-header h2 {
      font-size: 1.4rem;
      margin-bottom: var(--space-1);
    }
    .date-field {
      max-width: 220px;
    }
    .date-field input {
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
    }
    .rosters {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
      gap: var(--space-4);
    }
    .actions {
      display: flex;
      gap: var(--space-3);
    }
  `,
})
export class ManualEntryComponent {
  protected readonly entry = inject(ManualEntryService);
  protected readonly exportService = inject(ExportService);
  private readonly toast = inject(ToastService);

  protected readonly myTeamId = signal<number | null>(null);
  protected readonly opponentId = signal<number | null>(null);

  onHeaderEdit(field: 'team' | 'opponent' | 'date', event: Event): void {
    this.entry.setHeader(field, (event.target as HTMLInputElement).value);
  }

  async onCreateTeam(
    name: string,
    isMyTeam: boolean,
    gameContext: GameContextPickerComponent
  ): Promise<void> {
    const id = await gameContext.createTeamInLeague(name, isMyTeam);
    if (id === null) return;
    if (isMyTeam) this.myTeamId.set(id);
    else this.opponentId.set(id);
  }

  protected canSave(context: LeagueSeasonContext | null, country: string): boolean {
    return (
      context !== null &&
      country !== ALL_COUNTRIES &&
      this.myTeamId() !== null &&
      this.opponentId() !== null
    );
  }

  async save(
    boxScore: ExtractedBoxScore,
    context: LeagueSeasonContext | null,
    country: string,
    teamOptions: { id: number; label: string }[]
  ): Promise<void> {
    if (!this.canSave(context, country)) return;
    const teamName = teamOptions.find((o) => o.id === this.myTeamId())?.label ?? '';
    const opponentName = teamOptions.find((o) => o.id === this.opponentId())?.label ?? '';

    await window.boxscoreApi.saveGame({
      leagueId: context!.leagueId,
      seasonId: context!.seasonId,
      team: teamName,
      opponent: opponentName,
      date: boxScore.date,
      players: boxScore.players,
      opponentPlayers: boxScore.opponentPlayers,
    });

    this.toast.success(`Saved ${teamName} vs ${opponentName}.`);
    this.entry.reset();
    this.myTeamId.set(null);
    this.opponentId.set(null);
  }

  onExport(boxScore: ExtractedBoxScore): void {
    void this.exportService.exportToExcel(
      boxScore,
      `${boxScore.team || 'manual'}-vs-${boxScore.opponent || 'opponent'}.xlsx`
    );
  }
}
