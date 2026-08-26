import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LowerCasePipe } from '@angular/common';

export interface PickerOption {
  id: number;
  label: string;
}

/**
 * Searchable dropdown for a named entity (league/season/team/player/...)
 * with an optional inline "+ New" flow that emits the typed name for the
 * parent to create and re-select. Supports `[(selectedId)]` two-way
 * binding. A custom combobox (not a native `<select>`) so a text filter
 * can live inside the open panel — needed once a list runs into the
 * hundreds of options (e.g. every player in a league).
 */
@Component({
  selector: 'app-entity-picker',
  standalone: true,
  imports: [FormsModule, LowerCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field entity-picker">
      <span class="field-label">{{ label() }}</span>
      @if (!creating()) {
        <div class="picker-row">
          <div class="combobox">
            <button type="button" class="combobox-trigger" (click)="toggleOpen()">
              <span [class.placeholder]="!selectedLabel()">{{ selectedLabel() || ('No ' + label() + ' yet' | lowercase) }}</span>
              <span class="chevron">▾</span>
            </button>
            @if (open()) {
              <div class="combobox-panel">
                @if (options().length > 3) {
                  <input
                    type="text"
                    class="combobox-search"
                    autofocus
                    placeholder="Filter {{ label() | lowercase }}…"
                    [ngModel]="query()"
                    (ngModelChange)="query.set($event)"
                    (keydown.enter)="selectFirstMatch()"
                  />
                }
                <div class="combobox-list">
                  @for (opt of filteredOptions(); track opt.id) {
                    <button
                      type="button"
                      class="combobox-option"
                      [class.selected]="opt.id === selectedId()"
                      (click)="selectOption(opt.id)"
                    >
                      {{ opt.label }}
                    </button>
                  } @empty {
                    <p class="hint">{{ options().length === 0 ? ('No ' + label() + ' yet' | lowercase) : 'No matches' }}</p>
                  }
                </div>
              </div>
            }
          </div>
          @if (allowCreate()) {
            <button type="button" class="btn btn-ghost btn-sm" (click)="startCreate()">+ New</button>
          }
        </div>
      } @else {
        <div class="picker-row">
          <input
            type="text"
            [(ngModel)]="newName"
            placeholder="New {{ label() | lowercase }} name"
            (keydown.enter)="confirmCreate()"
          />
          <button type="button" class="btn btn-primary btn-sm" [disabled]="!newName.trim()" (click)="confirmCreate()">
            Add
          </button>
          <button type="button" class="btn btn-ghost btn-sm" (click)="cancelCreate()">Cancel</button>
        </div>
      }
    </div>
  `,
  styles: `
    .picker-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .picker-row input {
      flex: 1;
      min-width: 0;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
    }
    .picker-row input:focus {
      border-color: var(--accent);
    }
    .combobox {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    .combobox-trigger {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
      cursor: pointer;
      text-align: left;
      font: inherit;
    }
    .combobox-trigger:focus,
    .combobox-trigger:hover {
      border-color: var(--accent);
    }
    .combobox-trigger span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .combobox-trigger .placeholder {
      color: var(--text-muted);
    }
    .chevron {
      flex-shrink: 0;
      color: var(--text-muted);
      font-size: 0.75rem;
    }
    .combobox-panel {
      position: absolute;
      z-index: 20;
      top: calc(100% + var(--space-1));
      left: 0;
      right: 0;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-lg);
      display: flex;
      flex-direction: column;
      max-height: 320px;
      overflow: hidden;
    }
    .combobox-search {
      flex-shrink: 0;
      margin: var(--space-2);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
    }
    .combobox-search:focus {
      border-color: var(--accent);
    }
    .combobox-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      padding: 0 var(--space-1) var(--space-1);
    }
    .combobox-option {
      flex-shrink: 0;
      display: block;
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-2);
      color: var(--text);
      cursor: pointer;
      font: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .combobox-option:hover {
      background: var(--surface-hover);
    }
    .combobox-option.selected {
      background: var(--accent-muted);
      color: var(--accent);
      font-weight: 600;
    }
    .combobox-list .hint {
      padding: var(--space-2);
      margin: 0;
    }
  `,
})
export class EntityPickerComponent {
  private readonly elementRef = inject(ElementRef);

  readonly label = input.required<string>();
  readonly options = input.required<PickerOption[]>();
  readonly selectedId = input<number | null>(null);
  readonly allowCreate = input(true);

  readonly selectedIdChange = output<number | null>();
  readonly create = output<string>();

  protected readonly creating = signal(false);
  protected newName = '';

  protected readonly open = signal(false);
  protected readonly query = signal('');

  protected readonly selectedLabel = computed(
    () => this.options().find((o) => o.id === this.selectedId())?.label ?? ''
  );

  protected readonly filteredOptions = computed(() => {
    const q = this.query().trim().toLowerCase();
    const opts = this.options();
    if (!q) return opts;
    return opts.filter((o) => o.label.toLowerCase().includes(q));
  });

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.open()) return;
    if (!this.elementRef.nativeElement.contains(event.target)) this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.open.set(false);
  }

  toggleOpen(): void {
    if (this.open()) {
      this.open.set(false);
      return;
    }
    this.query.set('');
    this.open.set(true);
  }

  selectOption(id: number): void {
    this.selectedIdChange.emit(id);
    this.open.set(false);
  }

  selectFirstMatch(): void {
    const first = this.filteredOptions()[0];
    if (first) this.selectOption(first.id);
  }

  startCreate(): void {
    this.newName = '';
    this.creating.set(true);
    this.open.set(false);
  }

  cancelCreate(): void {
    this.creating.set(false);
  }

  confirmCreate(): void {
    const name = this.newName.trim();
    if (!name) return;
    this.create.emit(name);
    this.creating.set(false);
  }
}
