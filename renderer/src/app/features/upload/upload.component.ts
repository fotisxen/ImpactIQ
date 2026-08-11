import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SubscriptionService } from '../../core/subscription/subscription.service';
import { UploadService } from './upload.service';
import { BoxScoreTableComponent } from '../../shared/components/box-score-table.component';
import { ExportService } from '../../shared/services/export.service';
import { ToastService } from '../../shared/services/toast.service';
import {
  GameContextPickerComponent,
  LeagueSeasonContext,
} from '../../shared/components/game-context-picker.component';
import { ALL_COUNTRIES } from '../../shared/components/league-picker.component';
import { ExtractedBoxScore, PlayerBoxScore } from '../../core/models/box-score.model';
import { emptyPlayer } from '../../shared/utils/empty-player';
import { EntitiesService } from '../../core/data/entities.service';
import { resolveGameTeams } from '../../shared/utils/match-team';

type RosterField = 'players' | 'opponentPlayers';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [BoxScoreTableComponent, GameContextPickerComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (sub.hasUploadAccess() === false) {
      <section class="upload-page">
        <div class="card upload-gate">
          <h2>Upload a Photo needs its own subscription</h2>
          <p>
            Photo uploads use the Claude AI API to read the box score, which costs us per upload — that's
            why it's billed separately from your base subscription.
            <a routerLink="/manual-entry">You can still enter stats manually without it.</a>
          </p>
          <div class="plan-grid">
            @for (plan of sub.uploadPlans(); track plan.id) {
              <div class="plan-card">
                <h4>{{ plan.name }}</h4>
                <p class="price">{{ plan.price_cents / 100 }}€ <span class="hint">/ month</span></p>
                <p class="hint">{{ plan.monthly_upload_limit }} uploads / month</p>
                <button class="btn btn-primary btn-sm" (click)="sub.checkout({ kind: 'upload', planId: plan.id })">
                  Subscribe
                </button>
              </div>
            }
          </div>
          <p class="hint">
            Already paid and still seeing this? It usually updates on its own within a few seconds — or check
            right now:
          </p>
          <button class="btn btn-secondary btn-sm" (click)="sub.refreshNow()">I've already paid — check again</button>
        </div>
      </section>
    } @else if (sub.hasUploadAccess() === true) {
    <section class="upload-page">
      <header class="page-header">
        <h2>Upload a box score photo</h2>
        @if (sub.uploadStatus(); as up) {
          @if (up.remaining !== undefined && up.limit !== undefined) {
            <p class="hint quota-hint" [class.quota-low]="up.remaining <= 2">
              {{ up.remaining }} of {{ up.limit }} photo uploads left this period
              @if (up.planName) {
                <span>· {{ up.planName }}</span>
              }
            </p>
          }
        }
        <p class="hint"><a routerLink="/manual-entry">Prefer to enter stats manually instead?</a></p>
      </header>

      <div
        class="dropzone"
        [class.dragging]="dragging()"
        (dragover)="onDragOver($event)"
        (dragleave)="dragging.set(false)"
        (drop)="onDrop($event)"
      >
        @if (upload.previewUrl(); as preview) {
          <img [src]="preview" alt="Selected box score" class="preview-img" />
        } @else {
          <div class="dropzone-empty">
            <span class="dropzone-title">Drag & drop a box score photo here</span>
            <span class="hint">or click to browse</span>
          </div>
        }
        <input type="file" accept="image/*" (change)="onFileSelected($event)" class="file-input" />
      </div>

      <app-game-context-picker #gameContext [autoSelectDefault]="false" />

      @if (upload.extracting()) {
        <div class="skeleton-card card">
          <span class="hint">Reading the box score…</span>
          <div class="skeleton-rows">
            @for (row of skeletonRows; track row) {
              <div class="skeleton-row"></div>
            }
          </div>
        </div>
      }

      @if (upload.error(); as err) {
        <p class="error-text">{{ err }}</p>
      }

      @if (upload.needsSecondPhoto() && !upload.extracting()) {
        <div class="second-photo-card card">
          <p>
            This photo only had <strong>{{ upload.result()?.players?.length ? upload.result()?.team : upload.result()?.opponent }}</strong>'s stats.
            Got a photo of the other team? Add it here instead of starting over.
          </p>
          <div class="second-photo-row">
            @if (upload.secondPreviewUrl(); as preview) {
              <img [src]="preview" alt="Second team's box score" class="second-preview-img" />
            }
            <label class="btn btn-secondary btn-sm second-photo-input">
              Upload the other team's photo
              <input type="file" accept="image/*" (change)="onSecondFileSelected($event)" class="file-input-hidden" />
            </label>
          </div>
        </div>
      }

      @if (upload.result(); as boxScore) {
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
    }
  `,
  styles: `
    .upload-page {
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
    .quota-hint {
      color: var(--text-muted);
    }
    .quota-hint.quota-low {
      color: var(--negative);
      font-weight: 600;
    }

    .upload-gate {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      max-width: 640px;
    }
    .upload-gate .plan-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: var(--space-3);
    }
    .upload-gate .plan-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-3);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .upload-gate .price {
      font-weight: 700;
      font-size: 1.1rem;
    }

    .second-photo-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .second-photo-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }
    .second-preview-img {
      max-height: 80px;
      border-radius: var(--radius-sm);
    }
    .second-photo-input {
      cursor: pointer;
    }
    .file-input-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .dropzone {
      position: relative;
      border: 2px dashed var(--border-strong);
      border-radius: var(--radius-lg);
      background: var(--surface);
      min-height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.15s ease, background-color 0.15s ease;
      overflow: hidden;
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
    }
    .dropzone-title {
      font-weight: 600;
      color: var(--text);
    }
    .preview-img {
      max-height: 260px;
      max-width: 100%;
      object-fit: contain;
      pointer-events: none;
    }
    .file-input {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
    }

    .skeleton-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .skeleton-rows {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .skeleton-row {
      height: 1.5rem;
      border-radius: var(--radius-sm);
      background: linear-gradient(
        90deg,
        var(--surface-raised) 25%,
        var(--surface-hover) 50%,
        var(--surface-raised) 75%
      );
      background-size: 200% 100%;
      animation: shimmer 1.4s ease-in-out infinite;
    }
    @keyframes shimmer {
      0% {
        background-position: 200% 0;
      }
      100% {
        background-position: -200% 0;
      }
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
export class UploadComponent {
  protected readonly upload = inject(UploadService);
  protected readonly sub = inject(SubscriptionService);
  protected readonly exportService = inject(ExportService);
  private readonly entities = inject(EntitiesService);
  private readonly toast = inject(ToastService);

  protected readonly dragging = signal(false);
  protected readonly skeletonRows = [1, 2, 3, 4, 5];

  protected readonly myTeamId = signal<number | null>(null);
  protected readonly opponentId = signal<number | null>(null);

  private readonly gameContextRef = viewChild(GameContextPickerComponent);

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.startExtraction(file);
  }

  onSecondFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void this.addSecondTeamPhoto(file);
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
    await this.upload.extractFromFile(file);
    await this.tryAutoMatch();
  }

  private async addSecondTeamPhoto(file: File): Promise<void> {
    await this.upload.extractSecondTeamFromFile(file);
    await this.tryAutoMatch();
  }

  /**
   * After OCR returns, tries to recognize the country/league/both teams by
   * matching the extracted names against the known team list, so the
   * pickers come up pre-filled instead of always starting blank. Only
   * applies when both names resolve to teams in the same league — anything
   * less certain is left for the user to pick by hand, same as always.
   */
  private async tryAutoMatch(): Promise<void> {
    const boxScore = this.upload.result();
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

      // Set team IDs first so a downstream failure (e.g. resolving the
      // season) still leaves the roster pickers correctly filled instead of
      // an all-or-nothing failure that silently blanks everything.
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
    const current = this.upload.result();
    if (!current) return;
    this.upload.result.set({ ...current, [field]: roster });
  }

  addPlayer(field: RosterField): void {
    const current = this.upload.result();
    if (!current) return;
    this.upload.result.set({ ...current, [field]: [...current[field], emptyPlayer()] });
  }

  removePlayer(field: RosterField, index: number): void {
    const current = this.upload.result();
    if (!current) return;
    this.upload.result.set({ ...current, [field]: current[field].filter((_, i) => i !== index) });
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
  }

  onExport(boxScore: ExtractedBoxScore): void {
    void this.exportService.exportToExcel(boxScore, `${boxScore.team}-vs-${boxScore.opponent}.xlsx`);
  }
}
