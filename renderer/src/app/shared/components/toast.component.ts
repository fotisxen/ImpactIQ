import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from '../services/toast.service';

@Component({
  selector: 'app-toast-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-host">
      @for (toast of toastService.toasts(); track toast.id) {
        <div class="toast" [class]="toast.variant" (click)="toastService.dismiss(toast.id)">
          {{ toast.message }}
        </div>
      }
    </div>
  `,
  styles: `
    .toast-host {
      position: fixed;
      bottom: var(--space-6);
      right: var(--space-6);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      /* Above the subscription gate's backdrop (z-index 2000) — otherwise
         a checkout error fires right as the gate is covering the screen
         and the toast renders blurred and unreadable underneath it. */
      z-index: 2500;
    }
    .toast {
      min-width: 240px;
      max-width: 360px;
      padding: var(--space-3) var(--space-4);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-lg);
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      color: var(--text);
      animation: toast-in 0.15s ease-out;
    }
    .toast.success {
      border-color: var(--positive);
      background: var(--positive-muted);
      color: var(--positive);
    }
    .toast.error {
      border-color: var(--negative);
      background: var(--negative-muted);
      color: var(--negative);
    }
    @keyframes toast-in {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `,
})
export class ToastHostComponent {
  protected readonly toastService = inject(ToastService);
}
