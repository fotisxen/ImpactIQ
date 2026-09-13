import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { SubscriptionService } from '../../core/subscription/subscription.service';

/**
 * App-wide, non-dismissable gate: an authenticated (non-guest, non-admin)
 * account with no active subscription sees this instead of being able to
 * use anything. Rendered once at the shell level so it covers every route.
 * Guest mode and the platform admin both bypass it (see
 * SubscriptionService.hasBaseAccess) — the Upload Photo route has its own
 * separate, stricter gate.
 *
 * Informative only, on purpose: accounts are provisioned by the platform
 * admin directly (no Stripe self-checkout for now — see the "Owner-only
 * admin provisioning" plan), so there's nothing for the person seeing this
 * to actually click through to. No prices either, same reason.
 */
@Component({
  selector: 'app-subscription-gate',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shouldBlock()) {
      <div class="gate-backdrop">
        <div class="gate-modal">
          <h2>Your account isn't set up yet</h2>
          <p>Access to Box Score Analytics is set up by your club's administrator — reach out to them to get started.</p>

          <div class="plan-grid">
            <div class="plan-card">
              <h4>Manual</h4>
              <p class="hint">Manual box-score entry.</p>
            </div>
            <div class="plan-card">
              <h4>Photo</h4>
              <p class="hint">Manual entry, plus AI photo upload to read box scores automatically.</p>
            </div>
            <div class="plan-card">
              <h4>Pro</h4>
              <p class="hint">Read-only — view the data your club's administrator publishes for you.</p>
            </div>
          </div>

          <div class="already-paid">
            <p class="hint">Already been set up? It usually updates on its own within a few seconds — or check right now:</p>
            <button class="btn btn-secondary btn-sm" (click)="sub.refreshNow()">Check again</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .gate-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2000;
      background: rgba(4, 6, 12, 0.72);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-6);
    }
    .gate-modal {
      width: 100%;
      max-width: 560px;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: var(--space-6);
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    h2 {
      font-size: 1.3rem;
    }
    .hint {
      color: var(--text-muted);
      font-size: 0.8rem;
    }
    .already-paid {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      align-items: flex-start;
    }
    .plan-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: var(--space-3);
    }
    .plan-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-3);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
  `,
})
export class SubscriptionGateComponent {
  protected readonly auth = inject(AuthService);
  protected readonly sub = inject(SubscriptionService);

  protected readonly shouldBlock = computed(() => {
    const user = this.auth.currentUser();
    if (!user || user.isGuest) return false;
    return this.sub.hasBaseAccess() === false;
  });
}
