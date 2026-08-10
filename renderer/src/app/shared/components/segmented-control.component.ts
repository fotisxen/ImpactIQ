import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface SegmentOption<T extends string> {
  label: string;
  value: T;
}

@Component({
  selector: 'app-segmented-control',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="segmented" role="tablist">
      @for (opt of options(); track opt.value) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="opt.value === selected()"
          [class.active]="opt.value === selected()"
          (click)="selectedChange.emit(opt.value)"
        >
          {{ opt.label }}
        </button>
      }
    </div>
  `,
  styles: `
    .segmented {
      display: inline-flex;
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-pill);
      padding: 3px;
      gap: 2px;
    }
    button {
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 0.82rem;
      font-weight: 600;
      padding: var(--space-2) var(--space-4);
      border-radius: var(--radius-pill);
      cursor: pointer;
      transition:
        background-color 0.15s ease,
        color 0.15s ease;
    }
    button:hover {
      color: var(--text);
    }
    button.active {
      background: var(--accent);
      color: var(--accent-text);
    }
  `,
})
export class SegmentedControlComponent<T extends string> {
  readonly options = input.required<SegmentOption<T>[]>();
  readonly selected = input.required<T>();
  readonly selectedChange = output<T>();
}
