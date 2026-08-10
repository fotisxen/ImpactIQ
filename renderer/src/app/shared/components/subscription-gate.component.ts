import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { SubscriptionService } from '../../core/subscription/subscription.service';

type Interval = 'month' | 'year';

/**
 * App-wide, non-dismissable gate: an authenticated (non-guest) account
 * with no active base subscription sees this instead of being able to use
 * anything. Rendered once at the shell level so it covers every route.
 * Guest mode bypasses it (see SubscriptionService.hasBaseAccess) — the
 * Upload a Photo page has its own separate, stricter gate.
 */
@Component({
  selector: 'app-subscription-gate',
  standalone: true,
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shouldBlock()) {
      <div class="gate-backdrop">
        <div class="gate-modal">
          <h2>Subscribe to continue</h2>
          <p>Box Score Analytics needs an active subscription to use any feature.</p>

          <div class="plan-grid">
            <div class="plan-card">
              <h4>Individual</h4>
              <div class="interval-toggle">
                <button
                  type="button"
                  class="toggle-btn"
                  [class.active]="individualInterval() === 'month'"
                  (click)="individualInterval.set('month')"
                >
                  Monthly
                </button>
                <button
                  type="button"
                  class="toggle-btn"
                  [class.active]="individualInterval() === 'year'"
                  (click)="individualInterval.set('year')"
                >
                  Yearly
                </button>
              </div>
              <p class="price">
                {{ individualInterval() === 'month' ? '8€' : '86.40€' }}
                <span class="muted">/ {{ individualInterval() === 'month' ? 'month' : 'year (10% off)' }}</span>
              </p>
              <button
                class="btn btn-primary btn-sm"
                (click)="sub.checkout({ kind: 'base', tier: 'individual', interval: individualInterval() })"
              >
                Subscribe
              </button>
            </div>
            <div class="plan-card">
              <h4>Team</h4>
              <div class="interval-toggle">
                <button
                  type="button"
                  class="toggle-btn"
                  [class.active]="teamInterval() === 'month'"
                  (click)="teamInterval.set('month')"
                >
                  Monthly
                </button>
                <button
                  type="button"
                  class="toggle-btn"
                  [class.active]="teamInterval() === 'year'"
                  (click)="teamInterval.set('year')"
                >
                  Yearly
                </button>
              </div>
              <p class="price">
                {{ teamInterval() === 'month' ? '15€' : '162€' }}
                <span class="muted">/ {{ teamInterval() === 'month' ? 'month' : 'year (10% off)' }}</span>
              </p>
              <p class="hint">+6€ per seat from the 3rd account</p>
              @if (!sub.organizationId()) {
                <label class="field">
                  <span class="field-label">Team name</span>
                  <input type="text" [formControl]="newTeamName" placeholder="e.g. Iraklis Coaching Staff" />
                </label>
              }
              <label class="field">
                <span class="field-label">Seats</span>
                <input type="number" min="1" [formControl]="teamSeatCount" />
              </label>
              <button
                class="btn btn-primary btn-sm"
                (click)="sub.subscribeTeam(teamInterval(), teamSeatCount.value || 1, newTeamName.value)"
              >
                Subscribe
              </button>
            </div>
          </div>

          <div class="already-paid">
            <p class="hint">
              Already paid and still seeing this? It usually updates on its own within a few seconds — or check
              right now:
            </p>
            <button class="btn btn-secondary btn-sm" (click)="sub.refreshNow()">I've already paid — check again</button>
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
      max-width: 520px;
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
    .muted {
      color: var(--text-muted);
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
      grid-template-columns: 1fr 1fr;
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
    .interval-toggle {
      display: flex;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 2px;
    }
    .toggle-btn {
      flex: 1;
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 0.78rem;
      font-weight: 600;
      padding: var(--space-1) var(--space-2);
      border-radius: calc(var(--radius-sm) - 2px);
      cursor: pointer;
    }
    .toggle-btn.active {
      background: var(--accent);
      color: var(--accent-text);
    }
    .price {
      font-weight: 700;
      font-size: 1.1rem;
    }
    .btn-row {
      display: flex;
      gap: var(--space-2);
    }
    input[type='number'] {
      width: 100%;
    }
  `,
})
export class SubscriptionGateComponent {
  protected readonly auth = inject(AuthService);
  protected readonly sub = inject(SubscriptionService);

  protected readonly individualInterval = signal<Interval>('month');
  protected readonly teamInterval = signal<Interval>('month');
  protected readonly teamSeatCount = new FormControl(2, { nonNullable: true, validators: [Validators.min(1)] });
  protected readonly newTeamName = new FormControl('', { nonNullable: true });

  protected readonly shouldBlock = computed(() => {
    const user = this.auth.currentUser();
    if (!user || user.isGuest) return false;
    return this.sub.hasBaseAccess() === false;
  });
}
