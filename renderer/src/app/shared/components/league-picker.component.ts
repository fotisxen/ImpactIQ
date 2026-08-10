import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EntityPickerComponent, PickerOption } from './entity-picker.component';
import { League } from '../../core/models/box-score.model';

export interface LeagueCreateRequest {
  name: string;
  country?: string;
}

export const ALL_COUNTRIES = 'All countries';

/** Country filter + League select, so a long flat league list stays browsable. */
@Component({
  selector: 'app-league-picker',
  standalone: true,
  imports: [FormsModule, EntityPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field">
      <span class="field-label">Country</span>
      <select [ngModel]="country()" (ngModelChange)="country.set($event)">
        <option [ngValue]="allCountries">{{ allCountries }}</option>
        @for (c of countries(); track c) {
          <option [ngValue]="c">{{ c }}</option>
        }
      </select>
    </div>
    <app-entity-picker
      label="League"
      [options]="leagueOptions()"
      [selectedId]="selectedLeagueId()"
      [allowCreate]="allowCreate()"
      (selectedIdChange)="selectedLeagueIdChange.emit($event)"
      (create)="onCreate($event)"
    />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: row;
      align-items: flex-end;
      gap: var(--space-3);
      min-width: 0;
    }
    .field,
    app-entity-picker {
      flex: 1;
      min-width: 0;
    }
    select {
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
      width: 100%;
    }
    select:focus {
      border-color: var(--accent);
    }
  `,
})
export class LeaguePickerComponent {
  readonly leagues = input.required<League[]>();
  readonly selectedLeagueId = input<number | null>(null);
  readonly allowCreate = input(true);

  readonly selectedLeagueIdChange = output<number | null>();
  readonly create = output<LeagueCreateRequest>();

  protected readonly allCountries = ALL_COUNTRIES;
  protected readonly country = signal<string>(ALL_COUNTRIES);

  /** The current country filter value, e.g. for gating save until a real country is set. */
  readonly selectedCountry = computed<string>(() => this.country());

  protected readonly countries = computed<string[]>(() => {
    const set = new Set(this.leagues().map((l) => l.country).filter((c): c is string => !!c));
    return [...set].sort();
  });

  protected readonly leagueOptions = computed<PickerOption[]>(() => {
    const pool =
      this.country() === ALL_COUNTRIES
        ? this.leagues()
        : this.leagues().filter((l) => l.country === this.country());
    return pool.map((l) => ({ id: l.id, label: l.name }));
  });

  constructor() {
    // Keep the country filter in sync with whichever league is actually
    // selected — including when that selection comes from outside (auto-
    // matched from an OCR'd box score, a remembered last-used league,
    // etc.), not just when the user picks a league by hand.
    effect(() => {
      const id = this.selectedLeagueId();
      if (id === null) return;
      const league = this.leagues().find((l) => l.id === id);
      if (league?.country) this.country.set(league.country);
    });
  }

  onCreate(name: string): void {
    const country = this.country();
    this.create.emit({ name, country: country === ALL_COUNTRIES ? undefined : country });
  }
}
