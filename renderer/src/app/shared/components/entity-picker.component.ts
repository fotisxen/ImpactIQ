import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LowerCasePipe } from '@angular/common';

export interface PickerOption {
  id: number;
  label: string;
}

/**
 * Select dropdown for a named entity (league/season/team/...) with an
 * optional inline "+ New" flow that emits the typed name for the parent to
 * create and re-select. Supports `[(selectedId)]` two-way binding.
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
          <select [ngModel]="selectedId()" (ngModelChange)="onSelect($event)">
            @if (options().length === 0) {
              <option [ngValue]="null">No {{ label() | lowercase }} yet</option>
            }
            @for (opt of options(); track opt.id) {
              <option [ngValue]="opt.id">{{ opt.label }}</option>
            }
          </select>
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
    .picker-row select,
    .picker-row input {
      flex: 1;
      min-width: 0;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text);
    }
    .picker-row select:focus,
    .picker-row input:focus {
      border-color: var(--accent);
    }
  `,
})
export class EntityPickerComponent {
  readonly label = input.required<string>();
  readonly options = input.required<PickerOption[]>();
  readonly selectedId = input<number | null>(null);
  readonly allowCreate = input(true);

  readonly selectedIdChange = output<number | null>();
  readonly create = output<string>();

  protected readonly creating = signal(false);
  protected newName = '';

  onSelect(id: number | null): void {
    this.selectedIdChange.emit(id);
  }

  startCreate(): void {
    this.newName = '';
    this.creating.set(true);
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
