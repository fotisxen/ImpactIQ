import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { SubscriptionService } from '../../core/subscription/subscription.service';
import { ToastService } from '../../shared/services/toast.service';
import type { Profile, TeamInvite, UploadStatus } from '../../core/models/box-score.model';

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [ReactiveFormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="account-page">
      <h1>Account</h1>

      @if (auth.currentUser()?.isGuest) {
        <section class="card">
          <p>You're using a guest session — nothing here is saved to an account.</p>
          <p class="muted">Sign up to manage your profile and subscriptions.</p>
        </section>
      } @else {
        <!-- Profile -->
        <section class="card">
          <h2>Profile</h2>
          @if (profile(); as p) {
            <form [formGroup]="profileForm" (ngSubmit)="saveProfile()">
              <label class="field">
                <span class="field-label">Email</span>
                <input type="email" [value]="p.email" disabled />
              </label>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">First name</span>
                  <input type="text" formControlName="firstName" />
                </label>
                <label class="field">
                  <span class="field-label">Last name</span>
                  <input type="text" formControlName="lastName" />
                </label>
              </div>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">Role</span>
                  <select formControlName="role">
                    <option value="">Select…</option>
                    <option value="coach">Coach</option>
                    <option value="analyst">Analyst</option>
                    <option value="scout">Scout</option>
                    <option value="player">Player</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">Date of birth</span>
                  <input type="date" formControlName="birthDate" />
                </label>
              </div>
              <button type="submit" class="btn btn-primary" [disabled]="profileForm.invalid || savingProfile()">
                {{ savingProfile() ? 'Saving…' : 'Save profile' }}
              </button>
            </form>
          } @else {
            <p class="muted">Loading…</p>
          }

          <hr />

          <h3>Change password</h3>
          <form [formGroup]="passwordForm" (ngSubmit)="savePassword()">
            <label class="field">
              <span class="field-label">New password</span>
              <input type="password" formControlName="newPassword" />
              <span class="hint">At least 8 characters.</span>
            </label>
            <button
              type="submit"
              class="btn btn-secondary"
              [disabled]="passwordForm.invalid || savingPassword()"
            >
              {{ savingPassword() ? 'Updating…' : 'Update password' }}
            </button>
          </form>
        </section>

        <!-- Team -->
        <section class="card">
          <h2>Team</h2>

          @if (profile()?.organization_id) {
            <p>You're on <strong>{{ profile()?.organizations?.name }}</strong>. Everyone on the team shares data.</p>

            <h3>Invite a teammate</h3>
            <form class="invite-form" (ngSubmit)="sendInvite()">
              <label class="field">
                <span class="field-label">Email</span>
                <input type="email" [formControl]="inviteEmail" placeholder="teammate@example.com" />
              </label>
              <button type="submit" class="btn btn-secondary btn-sm" [disabled]="inviteEmail.invalid || sendingInvite()">
                {{ sendingInvite() ? 'Sending…' : 'Send invite' }}
              </button>
            </form>

            @if (sentInvites().length) {
              <ul class="invite-list">
                @for (inv of sentInvites(); track inv.id) {
                  <li>
                    <span>{{ inv.email }}</span>
                    <span class="badge">{{ inv.status }}</span>
                    @if (inv.status === 'pending') {
                      <button class="btn btn-ghost btn-sm" (click)="revoke(inv.id)">Revoke</button>
                    }
                  </li>
                }
              </ul>
            }
          } @else {
            <p class="muted">You're not on a team yet. Accept an invite below, or subscribe to the Team plan to start one.</p>
          }

          @if (myInvites().length) {
            <h3>Invitations for you</h3>
            <ul class="invite-list">
              @for (inv of myInvites(); track inv.id) {
                <li>
                  <span>{{ inv.organizations?.name }}</span>
                  <div class="btn-row">
                    <button class="btn btn-primary btn-sm" (click)="accept(inv.id)">Accept</button>
                    <button class="btn btn-ghost btn-sm" (click)="decline(inv.id)">Decline</button>
                  </div>
                </li>
              }
            </ul>
          }
        </section>

        <!-- Base subscription -->
        <section class="card">
          <h2>Subscription</h2>
          @if (sub.baseSubscription(); as base) {
            @switch (base.source) {
              @case ('none') {
                <p>You don't have an active subscription yet.</p>
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
                    <button class="btn btn-primary btn-sm" (click)="subscribeIndividual(individualInterval())">
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
                    <button class="btn btn-primary btn-sm" (click)="subscribeTeam(teamInterval())">Subscribe</button>
                  </div>
                </div>
              }
              @case ('individual') {
                <div class="status-row">
                  <span class="badge" [class.badge-active]="base.status === 'active'">{{ base.status }}</span>
                  <span>Individual plan · billed {{ base.billing_interval }}ly</span>
                </div>
                @if (base.current_period_end) {
                  <p class="muted">
                    {{ base.cancel_at_period_end ? 'Access ends' : 'Renews' }}
                    on {{ base.current_period_end | date: 'mediumDate' }}
                  </p>
                }
                <div class="btn-row">
                  <button class="btn btn-secondary btn-sm" (click)="sub.openBillingPortal()">Manage billing</button>
                  @if (!base.cancel_at_period_end) {
                    <button class="btn btn-danger-outline btn-sm" (click)="sub.cancelBase()">Cancel subscription</button>
                  }
                </div>
                @if (base.cancel_at_period_end) {
                  <p class="hint">Your subscription is set to cancel — you'll keep access until then.</p>
                }
              }
              @case ('team') {
                <div class="status-row">
                  <span class="badge" [class.badge-active]="base.status === 'active'">{{ base.status }}</span>
                  <span>Team plan ({{ base.organizationName }}) · {{ base.seat_count }} seats</span>
                </div>
                @if (base.current_period_end) {
                  <p class="muted">
                    {{ base.cancel_at_period_end ? 'Access ends' : 'Renews' }}
                    on {{ base.current_period_end | date: 'mediumDate' }}
                  </p>
                }
                <p class="hint">Managed by your club — contact them to change or cancel this plan.</p>
              }
            }
          } @else {
            <p class="muted">Loading…</p>
          }
        </section>

        <!-- Upload a Photo add-on -->
        <section class="card">
          <h2>Upload a Photo add-on</h2>
          @if (sub.uploadStatus(); as up) {
            @if (up.source === 'active') {
              <div class="status-row">
                <span class="badge" [class.badge-active]="up.status === 'active'">{{ up.status }}</span>
                <span>{{ up.planName }} plan</span>
              </div>
              <div class="usage-bar">
                <div class="usage-bar-fill" [class.usage-bar-full]="up.exhausted" [style.width.%]="usagePercent(up)"></div>
              </div>
              <p class="muted">{{ up.used }} / {{ up.limit }} uploads used this period</p>
              @if (up.exhausted) {
                <p class="warning">
                  You've used every upload in your plan this period. Upgrade below to upload more this month.
                </p>
              }
              @if (up.currentPeriodEnd) {
                <p class="muted">
                  {{ up.cancelAtPeriodEnd ? 'Access ends' : 'Renews' }}
                  on {{ up.currentPeriodEnd | date: 'mediumDate' }}
                </p>
              }
              <div class="plan-grid">
                @for (plan of sub.uploadPlans(); track plan.id) {
                  <div class="plan-card" [class.plan-current]="plan.name === up.planName">
                    <h4>{{ plan.name }}</h4>
                    <p class="price">{{ plan.price_cents / 100 }}€ <span class="muted">/ month</span></p>
                    <p class="hint">{{ plan.monthly_upload_limit }} uploads / month</p>
                    @if (plan.name !== up.planName) {
                      <button class="btn btn-secondary btn-sm" (click)="subscribeUpload(plan.id)">Switch</button>
                    }
                  </div>
                }
              </div>
              <div class="btn-row">
                <button class="btn btn-secondary btn-sm" (click)="sub.openBillingPortal()">Manage billing</button>
                @if (!up.cancelAtPeriodEnd) {
                  <button class="btn btn-danger-outline btn-sm" (click)="sub.cancelUpload()">Cancel add-on</button>
                }
              </div>
              @if (up.cancelAtPeriodEnd) {
                <p class="hint">Your add-on is set to cancel — you'll keep your quota until then.</p>
              }
            } @else {
              <p>Photo uploads use the Claude AI API to read the box score, which costs us per upload — that's why it's a separate plan from the base subscription.</p>
              <div class="plan-grid">
                @for (plan of sub.uploadPlans(); track plan.id) {
                  <div class="plan-card">
                    <h4>{{ plan.name }}</h4>
                    <p class="price">{{ plan.price_cents / 100 }}€ <span class="muted">/ month</span></p>
                    <p class="hint">{{ plan.monthly_upload_limit }} uploads / month</p>
                    <button class="btn btn-primary btn-sm" (click)="subscribeUpload(plan.id)">Subscribe</button>
                  </div>
                }
              </div>
            }
          } @else {
            <p class="muted">Loading…</p>
          }
        </section>
      }
    </div>
  `,
  styles: `
    .account-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      max-width: 720px;
      padding: var(--space-6);
    }
    h1 {
      font-size: 1.5rem;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    h2 {
      font-size: 1.1rem;
    }
    h3 {
      font-size: 0.95rem;
      color: var(--text-muted);
    }
    form {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .invite-form {
      flex-direction: row;
      align-items: flex-end;
      gap: var(--space-3);
    }
    .invite-form .field {
      flex: 1;
    }
    .invite-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .invite-list li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-2) var(--space-3);
      background: var(--surface-raised);
      border-radius: var(--radius-md);
      font-size: 0.85rem;
    }
    .field-row {
      display: flex;
      gap: var(--space-4);
    }
    .field-row .field {
      flex: 1;
      min-width: 0;
    }
    select,
    input[type='date'],
    input[type='number'],
    input[type='text'],
    input[type='email'] {
      width: 100%;
    }
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 0;
    }
    .muted {
      color: var(--text-muted);
      font-size: 0.85rem;
    }
    .hint {
      color: var(--text-muted);
      font-size: 0.8rem;
    }
    .warning {
      color: var(--negative);
      font-size: 0.85rem;
      font-weight: 600;
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      font-size: 0.9rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.15rem 0.6rem;
      border-radius: var(--radius-pill, 999px);
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      background: var(--surface-hover);
      color: var(--text-muted);
    }
    .badge-active {
      background: var(--positive-muted);
      color: var(--positive);
    }
    .usage-bar {
      height: 8px;
      border-radius: 999px;
      background: var(--surface-hover);
      overflow: hidden;
    }
    .usage-bar-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.2s ease;
    }
    .usage-bar-fill.usage-bar-full {
      background: var(--negative);
    }
    .plan-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
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
    .plan-card.plan-current {
      border-color: var(--accent);
    }
    .price {
      font-weight: 700;
      font-size: 1.1rem;
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
    .btn-danger-outline {
      background: transparent;
      border: 1px solid var(--negative);
      color: var(--negative);
    }
    .btn-row {
      display: flex;
      gap: var(--space-2);
    }
  `,
})
export class AccountComponent {
  protected readonly auth = inject(AuthService);
  protected readonly sub = inject(SubscriptionService);
  private readonly toast = inject(ToastService);

  protected readonly profile = signal<Profile | null>(null);
  protected readonly myInvites = signal<TeamInvite[]>([]);
  protected readonly sentInvites = signal<TeamInvite[]>([]);

  protected readonly savingProfile = signal(false);
  protected readonly savingPassword = signal(false);
  protected readonly sendingInvite = signal(false);

  protected readonly profileForm = new FormGroup({
    firstName: new FormControl('', { validators: [Validators.required], nonNullable: true }),
    lastName: new FormControl('', { validators: [Validators.required], nonNullable: true }),
    role: new FormControl('', { nonNullable: true }),
    birthDate: new FormControl('', { nonNullable: true }),
  });

  protected readonly passwordForm = new FormGroup({
    newPassword: new FormControl('', { validators: [Validators.required, Validators.minLength(8)], nonNullable: true }),
  });

  protected readonly teamSeatCount = new FormControl(2, { nonNullable: true, validators: [Validators.min(1)] });
  protected readonly individualInterval = signal<'month' | 'year'>('month');
  protected readonly teamInterval = signal<'month' | 'year'>('month');
  protected readonly newTeamName = new FormControl('', { nonNullable: true });
  protected readonly inviteEmail = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.email],
  });

  constructor() {
    if (!this.auth.currentUser()?.isGuest) {
      void this.loadProfile();
      void this.loadInvites();
      void this.sub.refreshAll();
    }
  }

  private async loadProfile(): Promise<void> {
    try {
      const profile = await window.boxscoreApi.getProfile();
      if (profile) {
        this.profile.set(profile);
        this.profileForm.setValue({
          firstName: profile.first_name ?? '',
          lastName: profile.last_name ?? '',
          role: profile.role ?? '',
          birthDate: profile.birth_date ?? '',
        });
      }
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load profile.');
    }
  }

  private async loadInvites(): Promise<void> {
    try {
      const [mine, sent] = await Promise.all([window.boxscoreApi.listMyInvites(), window.boxscoreApi.listSentInvites()]);
      this.myInvites.set(mine);
      this.sentInvites.set(sent);
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load invitations.');
    }
  }

  usagePercent(status: UploadStatus): number {
    if (!status.limit) return 0;
    return Math.min((status.used / status.limit) * 100, 100);
  }

  async saveProfile(): Promise<void> {
    if (this.profileForm.invalid) return;
    this.savingProfile.set(true);
    try {
      const { firstName, lastName, role, birthDate } = this.profileForm.getRawValue();
      await window.boxscoreApi.updateProfile({
        firstName,
        lastName,
        role: role || null,
        birthDate: birthDate || null,
      });
      this.toast.success('Profile updated.');
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to update profile.');
    } finally {
      this.savingProfile.set(false);
    }
  }

  async savePassword(): Promise<void> {
    if (this.passwordForm.invalid) return;
    this.savingPassword.set(true);
    try {
      await window.boxscoreApi.changePassword(this.passwordForm.getRawValue().newPassword);
      this.passwordForm.reset({ newPassword: '' });
      this.toast.success('Password updated.');
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to update password.');
    } finally {
      this.savingPassword.set(false);
    }
  }

  async sendInvite(): Promise<void> {
    if (this.inviteEmail.invalid) return;
    this.sendingInvite.set(true);
    try {
      await window.boxscoreApi.createInvite(this.inviteEmail.value);
      this.inviteEmail.reset('');
      this.toast.success('Invite sent.');
      await this.loadInvites();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to send invite.');
    } finally {
      this.sendingInvite.set(false);
    }
  }

  async accept(inviteId: string): Promise<void> {
    const confirmed = confirm(
      "Joining this team hides all your personal data — you'll only see the team's shared data from now on. " +
        "Nothing is deleted, but you won't be able to see it yourself anymore. Are you sure?"
    );
    if (!confirmed) return;
    try {
      await window.boxscoreApi.acceptInvite(inviteId);
      this.toast.success("You've joined the team.");
      await Promise.all([this.loadProfile(), this.loadInvites(), this.sub.refreshAll()]);
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to accept invite.');
    }
  }

  async decline(inviteId: string): Promise<void> {
    try {
      await window.boxscoreApi.declineInvite(inviteId);
      await this.loadInvites();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to decline invite.');
    }
  }

  async revoke(inviteId: string): Promise<void> {
    try {
      await window.boxscoreApi.revokeInvite(inviteId);
      await this.loadInvites();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to revoke invite.');
    }
  }

  async subscribeIndividual(interval: 'month' | 'year'): Promise<void> {
    await this.sub.checkout({ kind: 'base', tier: 'individual', interval });
  }

  async subscribeTeam(interval: 'month' | 'year'): Promise<void> {
    await this.sub.subscribeTeam(interval, this.teamSeatCount.value || 1, this.newTeamName.value);
    await this.loadProfile(); // Picks up the newly-created team, if any.
  }

  async subscribeUpload(planId: string): Promise<void> {
    await this.sub.checkout({ kind: 'upload', planId });
  }
}
