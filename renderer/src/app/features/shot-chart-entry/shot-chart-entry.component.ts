import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GameContextPickerComponent } from '../../shared/components/game-context-picker.component';
import { EntityPickerComponent, PickerOption } from '../../shared/components/entity-picker.component';
import { ZONE_SHAPES } from '../../shared/components/shot-zone-chart.component';
import { EntitiesService } from '../../core/data/entities.service';
import { ToastService } from '../../shared/services/toast.service';
import { Player, ShotZoneEntryRow, ShotZoneKey } from '../../core/models/box-score.model';

const TEAM_TOTAL_OPTION_ID = -1;

/**
 * Manual shot-chart entry: click a zone on a half-court diagram, say whose
 * shot it was (a specific player, or the team as a whole), type makes/
 * attempts, repeat. Everything saved here shares one match (two teams +
 * season + date) — the team's own season total is later built by summing
 * every entry across every game (see db:get-team-shot-zones), so this
 * screen only ever needs to worry about "what happened in this one game."
 */
@Component({
  selector: 'app-shot-chart-entry',
  standalone: true,
  imports: [FormsModule, GameContextPickerComponent, EntityPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="shot-chart-page">
      <header class="page-header">
        <h2>Shot Chart Entry</h2>
        <p class="hint">Click a zone on the court, then log makes/attempts for a team or one of its players.</p>
      </header>

      <app-game-context-picker #gameContext />

      <div class="match-fields card">
        <app-entity-picker
          label="Team A"
          [options]="gameContext.teamOptions()"
          [selectedId]="teamAId()"
          [allowCreate]="false"
          (selectedIdChange)="onTeamASelect($event)"
        />
        <app-entity-picker
          label="Team B"
          [options]="gameContext.teamOptions()"
          [selectedId]="teamBId()"
          [allowCreate]="false"
          (selectedIdChange)="onTeamBSelect($event)"
        />
        <label class="field">
          <span class="field-label">Date</span>
          <input type="date" [ngModel]="gameDate()" (ngModelChange)="onDateChange($event)" />
        </label>
      </div>

      @if (sameTeamPicked()) {
        <p class="error-text">Team A and Team B can't be the same team.</p>
      }

      @if (matchReady()) {
        <div class="entry-layout">
          <div class="court-panel card">
            <svg viewBox="0 0 300 280" class="court">
              <rect x="0" y="0" width="300" height="280" class="court-bg" />
              <circle cx="150" cy="20" r="8" class="hoop" />
              @for (shape of shapes; track shape.zone) {
                <path
                  [attr.d]="shape.path"
                  class="zone clickable"
                  [class.selected]="selectedZone() === shape.zone"
                  (click)="selectZone(shape.zone)"
                />
              }
            </svg>
            <p class="hint">Click a zone to log a make/attempt entry there.</p>
          </div>

          <div class="form-panel card">
            @if (selectedZone(); as z) {
              <h4>{{ zoneLabel(z) }}</h4>

              <div class="side-toggle">
                <button
                  type="button"
                  class="btn btn-sm"
                  [class.btn-primary]="forTeamId() === teamAId()"
                  [class.btn-ghost]="forTeamId() !== teamAId()"
                  (click)="onForTeamSelect(teamAId()!)"
                >
                  {{ teamAName() }}
                </button>
                <button
                  type="button"
                  class="btn btn-sm"
                  [class.btn-primary]="forTeamId() === teamBId()"
                  [class.btn-ghost]="forTeamId() !== teamBId()"
                  (click)="onForTeamSelect(teamBId()!)"
                >
                  {{ teamBName() }}
                </button>
              </div>

              <app-entity-picker
                label="Player"
                [options]="playerOptionsForSelectedTeam()"
                [selectedId]="selectedPlayerOptionId()"
                [allowCreate]="false"
                (selectedIdChange)="selectedPlayerId.set($event === teamTotalOptionId ? null : $event)"
              />

              <div class="field makes-attempts">
                <span class="field-label">Makes / Attempts</span>
                <div class="ma-row">
                  <input type="number" min="0" [ngModel]="fgm()" (ngModelChange)="fgm.set($event)" />
                  <span class="slash">/</span>
                  <input type="number" min="0" [ngModel]="fga()" (ngModelChange)="fga.set($event)" />
                </div>
                @if (fga() !== null && fgm() !== null && fgm()! > fga()!) {
                  <p class="error-text">Makes can't be more than attempts.</p>
                }
              </div>

              <button type="button" class="btn btn-primary" [disabled]="!canSubmit() || saving()" (click)="submitEntry()">
                {{ saving() ? 'Saving…' : 'Add entry' }}
              </button>
            } @else {
              <p class="hint">Click a zone on the court to start an entry.</p>
            }
          </div>
        </div>

        <div class="entries-table card">
          <h4>Entries for this match</h4>
          @if (loadingEntries()) {
            <p class="hint">Loading…</p>
          } @else if (entries().length === 0) {
            <p class="hint">No entries yet — add one above.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Player</th>
                    <th>Zone</th>
                    <th>FGM-FGA</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of entries(); track e.id) {
                    <tr>
                      <td>{{ e.teamName }}</td>
                      <td>{{ e.playerName ?? 'Team total' }}</td>
                      <td>{{ zoneLabel(e.zone) }}</td>
                      <td>{{ e.fgm }}-{{ e.fga }}</td>
                      <td>
                        <button type="button" class="btn btn-ghost btn-sm" (click)="deleteEntry(e.id)">Delete</button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      } @else {
        <p class="hint">Pick both teams, a season, and a date to start entering shots.</p>
      }
    </section>
  `,
  styles: `
    .shot-chart-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      max-width: 900px;
      padding: var(--space-6);
    }
    h2 {
      font-size: 1.4rem;
    }
    .hint {
      color: var(--text-muted);
      font-size: 0.85rem;
    }
    .error-text {
      color: var(--negative);
      font-size: 0.82rem;
    }
    .match-fields {
      display: grid;
      grid-template-columns: repeat(3, minmax(160px, 1fr));
      gap: var(--space-4);
    }
    .match-fields input {
      width: 100%;
    }
    .entry-layout {
      display: grid;
      grid-template-columns: minmax(240px, 320px) 1fr;
      gap: var(--space-5);
      align-items: start;
    }
    .court-panel,
    .form-panel {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .court {
      width: 100%;
      max-width: 280px;
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
    .zone.clickable {
      cursor: pointer;
      transition: fill 0.1s ease;
    }
    .zone.clickable:hover {
      fill: var(--accent-hover, var(--surface-raised));
    }
    .zone.selected {
      fill: var(--accent);
      opacity: 0.85;
    }
    .side-toggle {
      display: flex;
      gap: var(--space-2);
    }
    .ma-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .ma-row input {
      width: 5rem;
    }
    .slash {
      font-weight: 700;
      color: var(--text-muted);
    }
    .table-scroll {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    th,
    td {
      text-align: left;
      padding: var(--space-2) var(--space-3);
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--text-muted);
      font-weight: 600;
    }
  `,
})
export class ShotChartEntryComponent {
  private readonly entities = inject(EntitiesService);
  private readonly toast = inject(ToastService);

  protected readonly shapes = ZONE_SHAPES;
  protected readonly teamTotalOptionId = TEAM_TOTAL_OPTION_ID;

  protected readonly teamAId = signal<number | null>(null);
  protected readonly teamBId = signal<number | null>(null);
  protected readonly gameDate = signal<string>(new Date().toISOString().slice(0, 10));

  private readonly gameContextRef = viewChild(GameContextPickerComponent);
  private readonly teamOptionsSnapshot = computed<PickerOption[]>(() => this.gameContextRef()?.teamOptions() ?? []);
  protected readonly currentSeasonId = computed<number | null>(
    () => this.gameContextRef()?.leagueSeasonContext()?.seasonId ?? null
  );

  protected readonly teamAName = computed(
    () => this.teamOptionsSnapshot().find((t) => t.id === this.teamAId())?.label ?? ''
  );
  protected readonly teamBName = computed(
    () => this.teamOptionsSnapshot().find((t) => t.id === this.teamBId())?.label ?? ''
  );

  protected readonly sameTeamPicked = computed(
    () => this.teamAId() !== null && this.teamAId() === this.teamBId()
  );
  protected readonly matchReady = computed(
    () => this.teamAId() !== null && this.teamBId() !== null && !this.sameTeamPicked() && !!this.gameDate()
  );

  protected readonly selectedZone = signal<ShotZoneKey | null>(null);
  protected readonly forTeamId = signal<number | null>(null);
  protected readonly selectedPlayerId = signal<number | null>(null);
  protected readonly fgm = signal<number | null>(null);
  protected readonly fga = signal<number | null>(null);
  protected readonly saving = signal(false);

  protected readonly playersByTeam = signal<Map<number, Player[]>>(new Map());
  protected readonly playerOptionsForSelectedTeam = computed<PickerOption[]>(() => {
    const teamId = this.forTeamId();
    const players = teamId !== null ? (this.playersByTeam().get(teamId) ?? []) : [];
    return [{ id: TEAM_TOTAL_OPTION_ID, label: 'Team total (no specific player)' }, ...players.map((p) => ({ id: p.id, label: p.name }))];
  });
  protected readonly selectedPlayerOptionId = computed(() => this.selectedPlayerId() ?? TEAM_TOTAL_OPTION_ID);

  protected readonly currentGameId = signal<number | null>(null);
  protected readonly entries = signal<ShotZoneEntryRow[]>([]);
  protected readonly loadingEntries = signal(false);

  protected readonly canSubmit = computed(() => {
    const m = this.fgm();
    const a = this.fga();
    return this.selectedZone() !== null && this.forTeamId() !== null && m !== null && a !== null && m >= 0 && a >= 0 && m <= a;
  });

  constructor() {
    // Re-resolve (or clear) the current match whenever any part of its
    // identity changes — covers the league-context picker's own season
    // changing too, not just this component's own team/date fields.
    effect(() => {
      const teamAId = this.teamAId();
      const teamBId = this.teamBId();
      const seasonId = this.currentSeasonId();
      const gameDate = this.gameDate();
      void this.tryResolveMatch(teamAId, teamBId, seasonId, gameDate);
      // tryResolveMatch's early-exit branch writes currentGameId/entries
      // synchronously (before its first await) when the match isn't fully
      // picked yet — same "signal write inside effect" shape Angular
      // restricts by default (NG0600); explicitly allowed since neither
      // signal is read by this effect, so there's no feedback loop.
    }, { allowSignalWrites: true });
  }

  protected async onTeamASelect(id: number | null): Promise<void> {
    this.teamAId.set(id);
    if (id !== null) await this.loadPlayersForTeam(id);
  }

  protected async onTeamBSelect(id: number | null): Promise<void> {
    this.teamBId.set(id);
    if (id !== null) await this.loadPlayersForTeam(id);
  }

  protected onDateChange(value: string): void {
    this.gameDate.set(value);
  }

  protected onForTeamSelect(teamId: number): void {
    this.forTeamId.set(teamId);
    this.selectedPlayerId.set(null);
  }

  protected selectZone(zone: ShotZoneKey): void {
    this.selectedZone.set(zone);
    if (this.forTeamId() === null && this.teamAId() !== null) this.forTeamId.set(this.teamAId());
    this.fgm.set(null);
    this.fga.set(null);
  }

  protected zoneLabel(zone: ShotZoneKey): string {
    return this.shapes.find((s) => s.zone === zone)?.label ?? zone;
  }

  private async loadPlayersForTeam(teamId: number): Promise<void> {
    if (this.playersByTeam().has(teamId)) return;
    const players = await this.entities.listPlayers(teamId);
    const next = new Map(this.playersByTeam());
    next.set(teamId, players);
    this.playersByTeam.set(next);
  }

  private async tryResolveMatch(
    teamAId: number | null,
    teamBId: number | null,
    seasonId: number | null,
    gameDate: string
  ): Promise<void> {
    if (teamAId === null || teamBId === null || teamAId === teamBId || seasonId === null || !gameDate) {
      this.currentGameId.set(null);
      this.entries.set([]);
      return;
    }
    const gameId = await window.boxscoreApi.findGameByMatchup({ teamAId, teamBId, seasonId, gameDate });
    this.currentGameId.set(gameId);
    if (gameId !== null) await this.refreshEntries(gameId);
    else this.entries.set([]);
  }

  protected async refreshEntries(gameId: number): Promise<void> {
    this.loadingEntries.set(true);
    try {
      this.entries.set(await window.boxscoreApi.listShotZoneEntriesForGame(gameId));
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load entries for this match.');
    } finally {
      this.loadingEntries.set(false);
    }
  }

  protected async submitEntry(): Promise<void> {
    const teamAId = this.teamAId();
    const teamBId = this.teamBId();
    const seasonId = this.currentSeasonId();
    const zone = this.selectedZone();
    const forTeamId = this.forTeamId();
    const fgm = this.fgm();
    const fga = this.fga();
    if (teamAId === null || teamBId === null || seasonId === null || zone === null || forTeamId === null || fgm === null || fga === null) {
      return;
    }

    this.saving.set(true);
    try {
      const result = await window.boxscoreApi.saveShotZoneEntry({
        teamAId,
        teamBId,
        seasonId,
        gameDate: this.gameDate(),
        forTeamId,
        playerId: this.selectedPlayerId(),
        zone,
        fgm,
        fga,
      });
      this.currentGameId.set(result.gameId);
      this.toast.success('Entry saved.');
      this.fgm.set(null);
      this.fga.set(null);
      await this.refreshEntries(result.gameId);
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to save this entry.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteEntry(id: number): Promise<void> {
    try {
      await window.boxscoreApi.deleteShotZoneEntry(id);
      const gameId = this.currentGameId();
      if (gameId !== null) await this.refreshEntries(gameId);
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to delete this entry.');
    }
  }
}
