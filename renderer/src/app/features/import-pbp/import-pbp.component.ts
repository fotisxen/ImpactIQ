import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PbpImportService } from './pbp-import.service';
import { BoxScoreTableComponent } from '../../shared/components/box-score-table.component';
import { ExportService } from '../../shared/services/export.service';
import { ToastService } from '../../shared/services/toast.service';
import {
  GameContextPickerComponent,
  LeagueSeasonContext,
} from '../../shared/components/game-context-picker.component';
import { ALL_COUNTRIES } from '../../shared/components/league-picker.component';
import { PbpExtractedBoxScore, PlayerBoxScore } from '../../core/models/box-score.model';
import { emptyPlayer } from '../../shared/utils/empty-player';
import { EntitiesService } from '../../core/data/entities.service';
import { resolveGameTeams } from '../../shared/utils/match-team';

type RosterField = 'players' | 'opponentPlayers';

/**
 * Play-by-play import: same review/save flow as Upload a Photo, but the
 * source is a play-by-play Excel export instead of a photo. Parsing is
 * local (no API call), so unlike photo uploads this isn't gated by the
 * paid upload subscription — and because the source data includes
 * substitution timestamps and score deltas, MIN and +/- are *measured*
 * exactly, not left at 0 the way every other import path leaves them.
 */
@Component({
  selector: 'app-import-pbp',
  standalone: true,
  imports: [BoxScoreTableComponent, GameContextPickerComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="import-page">
      <header class="page-header">
        <h2>Import play-by-play</h2>
        <p class="hint">
          Upload a play-by-play Excel export (EuroLeague-style) and get an exact box score — including
          real minutes and +/-, measured from substitutions and score changes, not estimated.
          <a routerLink="/upload">Have a photo instead?</a>
        </p>
      </header>

      <div class="dropzone" [class.dragging]="dragging()" (dragover)="onDragOver($event)" (dragleave)="dragging.set(false)" (drop)="onDrop($event)">
        @if (pbp.fileName(); as name) {
          <div class="dropzone-empty">
            <span class="dropzone-title">{{ name }}</span>
            <span class="hint">Click or drop another file to replace it</span>
          </div>
        } @else {
          <div class="dropzone-empty">
            <span class="dropzone-title">Drag & drop a play-by-play .xlsx/.xls file here</span>
            <span class="hint">or click to browse</span>
          </div>
        }
        <input type="file" accept=".xls,.xlsx" (change)="onFileSelected($event)" class="file-input" />
      </div>

      <app-game-context-picker #gameContext [autoSelectDefault]="false" />

      @if (pbp.extracting()) {
        <p class="hint">Reading the play-by-play…</p>
      }

      @if (pbp.error(); as err) {
        <p class="error-text">{{ err }}</p>
      }

      @if (pbp.result(); as boxScore) {
        <div class="rosters">
          <app-box-score-table
            cardLabel="My Team"
            [sourceName]="boxScore.team"
            [teamOptions]="gameContext.teamOptions()"
            [selectedTeamId]="myTeamId()"
            [allowCreateTeam]="!!gameContext.leagueSeasonContext()"
            (selectedTeamIdChange)="myTeamId.set($event)"
            (createTeam)="onCreateTeam($event, true, gameContext)"
            [roster]="boxScore.players"
            (rosterChange)="updateRoster('players', $event)"
            (removePlayer)="removePlayer('players', $event)"
            (addPlayer)="addPlayer('players')"
          />
          <app-box-score-table
            cardLabel="Opponent"
            [sourceName]="boxScore.opponent"
            [teamOptions]="gameContext.teamOptions()"
            [selectedTeamId]="opponentId()"
            [allowCreateTeam]="!!gameContext.leagueSeasonContext()"
            (selectedTeamIdChange)="opponentId.set($event)"
            (createTeam)="onCreateTeam($event, false, gameContext)"
            [roster]="boxScore.opponentPlayers"
            (rosterChange)="updateRoster('opponentPlayers', $event)"
            (removePlayer)="removePlayer('opponentPlayers', $event)"
            (addPlayer)="addPlayer('opponentPlayers')"
          />
        </div>

        <div class="actions">
          <button
            type="button"
            class="btn btn-primary"
            [disabled]="!canSave(gameContext.leagueSeasonContext(), gameContext.selectedCountry())"
            (click)="
              save(
                boxScore,
                gameContext.leagueSeasonContext(),
                gameContext.selectedCountry(),
                gameContext.teamOptions()
              )
            "
          >
            Save game
          </button>
          <button type="button" class="btn btn-secondary" (click)="onExport(boxScore)">
            Export to Excel
          </button>
        </div>
      }
    </section>
  `,
  styles: `
    .import-page {
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

    .dropzone {
      position: relative;
      border: 2px dashed var(--border-strong);
      border-radius: var(--radius-lg);
      background: var(--surface);
      min-height: 140px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.15s ease, background-color 0.15s ease;
    }
    .dropzone.dragging {
      border-color: var(--accent);
      background: var(--accent-muted);
    }
    .dropzone-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-1);
      pointer-events: none;
      text-align: center;
    }
    .dropzone-title {
      font-weight: 600;
      color: var(--text);
    }
    .file-input {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
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
export class ImportPbpComponent {
  protected readonly pbp = inject(PbpImportService);
  protected readonly exportService = inject(ExportService);
  private readonly entities = inject(EntitiesService);
  private readonly toast = inject(ToastService);

  protected readonly dragging = signal(false);
  protected readonly myTeamId = signal<number | null>(null);
  protected readonly opponentId = signal<number | null>(null);

  private readonly gameContextRef = viewChild(GameContextPickerComponent);

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.startExtraction(file);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void this.startExtraction(file);
  }

  private async startExtraction(file: File): Promise<void> {
    this.myTeamId.set(null);
    this.opponentId.set(null);
    await this.pbp.extractFromFile(file);
    await this.tryAutoMatch();
  }

  /** Same auto-match logic as the photo upload flow — see upload.component.ts. */
  private async tryAutoMatch(): Promise<void> {
    const boxScore = this.pbp.result();
    const gameContext = this.gameContextRef();
    if (!boxScore || !gameContext) return;

    try {
      const [teams, leagues] = await Promise.all([
        this.entities.listTeams(),
        this.entities.listLeagues(),
      ]);
      const match = resolveGameTeams(boxScore.team, boxScore.opponent, teams, leagues);
      if (!match) {
        console.warn('Auto-match: no confident team/league match for', boxScore.team, 'vs', boxScore.opponent);
        return;
      }

      this.myTeamId.set(match.teamId);
      this.opponentId.set(match.opponentId);

      const referenceDate =
        boxScore.date && !Number.isNaN(Date.parse(boxScore.date)) ? new Date(boxScore.date) : undefined;
      await gameContext.selectLeague(match.leagueId, referenceDate);
    } catch (err) {
      console.error('Auto-match failed — pick the league/teams manually.', err);
    }
  }

  updateRoster(field: RosterField, roster: PlayerBoxScore[]): void {
    const current = this.pbp.result();
    if (!current) return;
    this.pbp.result.set({ ...current, [field]: roster });
  }

  addPlayer(field: RosterField): void {
    const current = this.pbp.result();
    if (!current) return;
    this.pbp.result.set({ ...current, [field]: [...current[field], emptyPlayer()] });
  }

  removePlayer(field: RosterField, index: number): void {
    const current = this.pbp.result();
    if (!current) return;
    this.pbp.result.set({ ...current, [field]: current[field].filter((_, i) => i !== index) });
  }

  async onCreateTeam(name: string, isMyTeam: boolean, gameContext: GameContextPickerComponent): Promise<void> {
    const id = await gameContext.createTeamInLeague(name, isMyTeam);
    if (id === null) return;
    if (isMyTeam) this.myTeamId.set(id);
    else this.opponentId.set(id);
  }

  protected canSave(context: LeagueSeasonContext | null, country: string): boolean {
    return context !== null && country !== ALL_COUNTRIES && this.myTeamId() !== null && this.opponentId() !== null;
  }

  async save(
    boxScore: PbpExtractedBoxScore,
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
      events: boxScore.events,
    });

    this.toast.success(`Saved ${teamName} vs ${opponentName}.`);
  }

  onExport(boxScore: PbpExtractedBoxScore): void {
    void this.exportService.exportToExcel(boxScore, `${boxScore.team}-vs-${boxScore.opponent}.xlsx`);
  }
}
