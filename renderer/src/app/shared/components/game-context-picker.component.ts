import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { EntitiesService } from '../../core/data/entities.service';
import { League, Season, Team } from '../../core/models/box-score.model';
import { EntityPickerComponent, PickerOption } from './entity-picker.component';
import { ALL_COUNTRIES, LeagueCreateRequest, LeaguePickerComponent } from './league-picker.component';
import { currentSeasonLabel } from '../utils/current-season';

export interface LeagueSeasonContext {
  leagueId: number;
  seasonId: number;
}

const LEAGUE_KEY = 'boxscore.lastLeagueId';
const SEASON_KEY = 'boxscore.lastSeasonId';

/**
 * League -> Season selector used above the box-score tables on both Upload
 * and Manual Entry, so `saveGame` has real IDs to attach to. Remembers the
 * last-used league/season for convenience. Which actual team each roster
 * belongs to is picked on the roster card itself (see box-score-table),
 * not here — this component just supplies the league's team list
 * (`teamOptions`) and a way to add a new one (`createTeamInLeague`) for
 * those cards to use. Parents read the resolved league/season via the
 * public `leagueSeasonContext` signal, typically through a template
 * reference variable.
 */
@Component({
  selector: 'app-game-context-picker',
  standalone: true,
  imports: [EntityPickerComponent, LeaguePickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="picker-grid card">
      <app-league-picker
        [leagues]="leagues()"
        [selectedLeagueId]="leagueId()"
        (selectedLeagueIdChange)="onLeagueSelect($event)"
        (create)="onCreateLeague($event)"
      />
      <app-entity-picker
        label="Season"
        [options]="seasonOptions()"
        [selectedId]="seasonId()"
        [allowCreate]="leagueId() !== null"
        (selectedIdChange)="onSeasonSelect($event)"
        (create)="onCreateSeason($event)"
      />
    </div>
  `,
  styles: `
    .picker-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(160px, 1fr));
      gap: var(--space-4);
    }
    .picker-grid app-league-picker {
      grid-column: span 2;
      min-width: 340px;
    }
  `,
})
export class GameContextPickerComponent implements OnInit {
  private readonly entities = inject(EntitiesService);

  /**
   * Whether to pre-select a league (remembered last-used, or the first one)
   * as soon as the leagues list loads. Manual Entry wants that convenience
   * since there's no other signal to pick from; Upload a Photo sets this to
   * false so the pickers stay empty until OCR/auto-match resolves a real
   * league instead of momentarily showing a stale or arbitrary one.
   */
  readonly autoSelectDefault = input(true);

  protected readonly leagues = signal<League[]>([]);
  protected readonly seasons = signal<Season[]>([]);
  protected readonly teams = signal<Team[]>([]);

  protected readonly leagueId = signal<number | null>(null);
  protected readonly seasonId = signal<number | null>(null);

  protected readonly seasonOptions = computed<PickerOption[]>(() =>
    this.seasons().map((s) => ({ id: s.id, label: s.year }))
  );

  /** Every team in the currently selected league, for the roster-card pickers. */
  readonly teamOptions = computed<PickerOption[]>(() =>
    this.teams().map((t) => ({ id: t.id, label: t.name }))
  );

  /** Resolved selection, or null until both league and season are chosen. */
  readonly leagueSeasonContext = computed<LeagueSeasonContext | null>(() => {
    const leagueId = this.leagueId();
    const seasonId = this.seasonId();
    if (!leagueId || !seasonId) return null;
    return { leagueId, seasonId };
  });

  private readonly leaguePickerRef = viewChild(LeaguePickerComponent);

  /** The country filter's current value — still "All countries" until a real one is set. */
  readonly selectedCountry = computed<string>(() => this.leaguePickerRef()?.selectedCountry() ?? ALL_COUNTRIES);

  async ngOnInit(): Promise<void> {
    this.leagues.set(await this.entities.listLeagues());
    if (!this.autoSelectDefault()) return;

    const storedLeagueId = this.readStoredId(LEAGUE_KEY);
    const initialLeagueId =
      storedLeagueId && this.leagues().some((l) => l.id === storedLeagueId)
        ? storedLeagueId
        : (this.leagues()[0]?.id ?? null);
    if (initialLeagueId !== null) await this.selectLeague(initialLeagueId);
  }

  async onLeagueSelect(id: number | null): Promise<void> {
    if (id === null) return;
    await this.selectLeague(id);
  }

  onSeasonSelect(id: number | null): void {
    this.seasonId.set(id);
    if (id !== null) localStorage.setItem(SEASON_KEY, String(id));
  }

  async onCreateLeague(request: LeagueCreateRequest): Promise<void> {
    const id = await this.entities.createLeague(request);
    this.leagues.set(await this.entities.listLeagues());
    await this.selectLeague(id);
  }

  async onCreateSeason(year: string): Promise<void> {
    const leagueId = this.leagueId();
    if (leagueId === null) return;
    const id = await this.entities.createSeason({ leagueId, year });
    this.seasons.set(await this.entities.listSeasons(leagueId));
    this.onSeasonSelect(id);
  }

  /** Creates a team in the current league and returns its id, or null if no league is selected. */
  async createTeamInLeague(name: string, isMyTeam: boolean): Promise<number | null> {
    const leagueId = this.leagueId();
    if (leagueId === null) return null;
    const id = await this.entities.createTeam({ leagueId, name, isMyTeam });
    await this.refreshTeams(leagueId);
    return id;
  }

  /**
   * Selects a league (and, within it, a season) — public so callers that
   * auto-detect a league from OCR/typed team names can apply it directly,
   * same as picking it from the dropdown. `referenceDate` lets a caller
   * with a real game date (from an OCR'd or manually entered box score)
   * resolve the season that date actually falls in, instead of always
   * defaulting to today's season.
   */
  async selectLeague(id: number, referenceDate?: Date): Promise<void> {
    this.leagueId.set(id);
    localStorage.setItem(LEAGUE_KEY, String(id));

    const [seasons] = await Promise.all([this.entities.listSeasons(id), this.refreshTeams(id)]);
    this.seasons.set(seasons);

    const storedSeasonId = this.readStoredId(SEASON_KEY);
    const targetSeasonLabel = currentSeasonLabel(referenceDate);
    const matchingSeason = seasons.find((s) => s.year === targetSeasonLabel);
    const initialSeasonId =
      matchingSeason?.id ??
      (storedSeasonId && seasons.some((s) => s.id === storedSeasonId) ? storedSeasonId : null) ??
      seasons[0]?.id ??
      null;
    this.seasonId.set(initialSeasonId);
  }

  private async refreshTeams(leagueId: number): Promise<void> {
    const allTeams = await this.entities.listTeams();
    this.teams.set(allTeams.filter((t) => t.league_id === leagueId));
  }

  private readStoredId(key: string): number | null {
    const raw = localStorage.getItem(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }
}
