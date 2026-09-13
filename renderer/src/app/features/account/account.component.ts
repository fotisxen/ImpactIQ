import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { SubscriptionService } from '../../core/subscription/subscription.service';
import { ToastService } from '../../shared/services/toast.service';
import type { Profile, TeamInvite, Tier } from '../../core/models/box-score.model';

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

        <!-- Subscription -->
        <section class="card">
          <h2>Subscription</h2>
          @if (sub.subscription(); as account) {
            @if (account.isPlatformAdmin) {
              <p class="hint">You're the platform administrator — no subscription needed on your own account.</p>
            } @else {
            @switch (account.source) {
              @case ('none') {
                <p>Your account isn't set up with a package yet — this is done by your club's administrator, not from here.</p>
                <div class="plan-grid">
                  <div class="plan-card">
                    <h4>Manual</h4>
                    <p class="hint">Manual box-score entry. No photo upload.</p>
                  </div>
                  <div class="plan-card">
                    <h4>Photo</h4>
                    <p class="hint">Manual entry + AI photo upload.</p>
                  </div>
                  <div class="plan-card">
                    <h4>Pro</h4>
                    <p class="hint">Read-only — view the data your administrator publishes for your club.</p>
                  </div>
                </div>
              }
              @case ('active') {
                <div class="status-row">
                  <span class="badge" [class.badge-active]="account.status === 'active'">{{ account.status }}</span>
                  <span>{{ tierLabel(account.tier) }} plan ({{ account.organizationName }})</span>
                </div>
                @if (account.currentPeriodEnd) {
                  <p class="muted">
                    {{ account.cancelAtPeriodEnd ? 'Access ends' : 'Renews' }}
                    on {{ account.currentPeriodEnd | date: 'mediumDate' }}
                  </p>
                }
                <div class="btn-row">
                  <button class="btn btn-secondary btn-sm" (click)="sub.openBillingPortal()">Manage billing</button>
                  @if (!account.cancelAtPeriodEnd) {
                    <button class="btn btn-danger-outline btn-sm" (click)="sub.cancel()">Cancel subscription</button>
                  }
                </div>
                @if (account.cancelAtPeriodEnd) {
                  <p class="hint">Your subscription is set to cancel — you'll keep access until then.</p>
                }
              }
            }
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

  protected tierLabel(tier: Tier | undefined): string {
    if (tier === 'manual') return 'Manual';
    if (tier === 'photo') return 'Photo';
    if (tier === 'pro') return 'Pro';
    return '';
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
}
