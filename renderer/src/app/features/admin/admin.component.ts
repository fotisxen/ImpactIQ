import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ToastService } from '../../shared/services/toast.service';
import type { AdminOrganizationRow, AdminSyncableTeam, Tier } from '../../core/models/box-score.model';

/**
 * Owner-only account provisioning — no Stripe checkout involved (see the
 * "Owner-only admin provisioning" plan). Hidden from everyone else by
 * platformAdminGuard on the route and the nav link's own
 * `sub.isPlatformAdmin()` check; every write here is re-verified
 * server-side by the 3 admin-* Edge Functions regardless.
 */
@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [ReactiveFormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="admin-page">
      <h1>Admin</h1>
      <p class="muted">Create accounts and assign clubs/packages directly — no payment involved.</p>

      <section class="card">
        <h2>Create account</h2>
        <form [formGroup]="form" (ngSubmit)="createAccount()">
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
              <span class="field-label">Email</span>
              <input type="email" formControlName="email" />
            </label>
            <label class="field">
              <span class="field-label">Role</span>
              <select formControlName="role">
                <option value="">Select…</option>
                <option value="coach">Coach</option>
                <option value="analyst">Analyst</option>
                <option value="scout">Scout</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>

          <label class="field">
            <span class="field-label">Club</span>
            <select formControlName="organizationId">
              <option value="">— New club —</option>
              @for (org of organizations(); track org.id) {
                <option [value]="org.id">{{ org.name }}</option>
              }
            </select>
          </label>
          @if (!form.controls.organizationId.value) {
            <label class="field">
              <span class="field-label">New club name</span>
              <input type="text" formControlName="organizationName" placeholder="e.g. Iraklis Coaching Staff" />
            </label>
          }

          <label class="field">
            <span class="field-label">Package</span>
            <select formControlName="tier">
              <option value="manual">Manual — €200/yr</option>
              <option value="photo">Photo — €500/yr</option>
              <option value="pro">Pro — €4000/yr (read-only)</option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">Default team (optional — sets their homepage view)</span>
            <select formControlName="defaultTeamId">
              <option value="">— None —</option>
              @for (team of syncableTeams(); track team.remoteId) {
                <option [value]="team.remoteId">{{ team.name }} ({{ team.league_name }})</option>
              }
            </select>
            <span class="hint">Only teams you've already uploaded at least one game for appear here.</span>
          </label>

          <button type="submit" class="btn btn-primary" [disabled]="form.invalid || creating()">
            {{ creating() ? 'Creating…' : 'Create account' }}
          </button>
        </form>

        @if (createdCredentials(); as cred) {
          <p class="hint credentials">
            Give these to them — shown once: <strong>{{ cred.email }}</strong> / <strong>{{ cred.password }}</strong>
          </p>
        }
      </section>

      <section class="card">
        <h2>Clubs</h2>
        @if (loadingOrgs()) {
          <p class="muted">Loading…</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Club</th>
                  <th>Package</th>
                  <th>Status</th>
                  <th>Default team</th>
                  <th>Members</th>
                </tr>
              </thead>
              <tbody>
                @for (org of organizations(); track org.id) {
                  <tr>
                    <td>{{ org.name }}</td>
                    <td>
                      <select [value]="org.tier ?? ''" (change)="changeTier(org, $event)">
                        <option value="manual">Manual</option>
                        <option value="photo">Photo</option>
                        <option value="pro">Pro</option>
                      </select>
                    </td>
                    <td>{{ org.status ?? '—' }}</td>
                    <td>
                      <select [value]="org.defaultTeamId ?? ''" (change)="changeDefaultTeam(org, $event)">
                        <option value="">— None —</option>
                        @for (team of syncableTeams(); track team.remoteId) {
                          <option [value]="team.remoteId">{{ team.name }} ({{ team.league_name }})</option>
                        }
                      </select>
                    </td>
                    <td>{{ org.memberCount }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="muted">No clubs yet.</td></tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </div>
  `,
  styles: `
    .admin-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      max-width: 860px;
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
    form {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
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
    input[type='text'],
    input[type='email'] {
      width: 100%;
    }
    .muted {
      color: var(--text-muted);
      font-size: 0.85rem;
    }
    .hint {
      color: var(--text-muted);
      font-size: 0.8rem;
    }
    .credentials {
      background: var(--surface-hover);
      border-radius: var(--radius-md);
      padding: var(--space-3);
    }
    .table-scroll {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    th,
    td {
      text-align: left;
      padding: var(--space-2) var(--space-3);
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--text-muted);
      font-weight: 600;
    }
  `,
})
export class AdminComponent {
  private readonly toast = inject(ToastService);

  protected readonly organizations = signal<AdminOrganizationRow[]>([]);
  protected readonly syncableTeams = signal<AdminSyncableTeam[]>([]);
  protected readonly loadingOrgs = signal(false);
  protected readonly creating = signal(false);
  protected readonly createdCredentials = signal<{ email: string; password: string } | null>(null);

  protected readonly form = new FormGroup({
    firstName: new FormControl('', { validators: [Validators.required], nonNullable: true }),
    lastName: new FormControl('', { validators: [Validators.required], nonNullable: true }),
    email: new FormControl('', { validators: [Validators.required, Validators.email], nonNullable: true }),
    role: new FormControl('', { nonNullable: true }),
    organizationId: new FormControl('', { nonNullable: true }),
    organizationName: new FormControl('', { nonNullable: true }),
    tier: new FormControl<Tier>('manual', { validators: [Validators.required], nonNullable: true }),
    defaultTeamId: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    void this.loadOrganizations();
    void this.loadSyncableTeams();
  }

  private async loadOrganizations(): Promise<void> {
    this.loadingOrgs.set(true);
    try {
      this.organizations.set(await window.boxscoreApi.adminListOrganizations());
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load clubs.');
    } finally {
      this.loadingOrgs.set(false);
    }
  }

  private async loadSyncableTeams(): Promise<void> {
    try {
      this.syncableTeams.set(await window.boxscoreApi.adminListSyncableTeams());
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load teams.');
    }
  }

  async createAccount(): Promise<void> {
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    if (!v.organizationId && !v.organizationName.trim()) {
      this.toast.error('Pick an existing club or name a new one.');
      return;
    }

    this.creating.set(true);
    this.createdCredentials.set(null);
    try {
      const result = await window.boxscoreApi.adminCreateAccount({
        email: v.email,
        firstName: v.firstName,
        lastName: v.lastName,
        role: v.role || undefined,
        organizationId: v.organizationId || undefined,
        organizationName: v.organizationId ? undefined : v.organizationName.trim(),
        tier: v.tier,
        defaultTeamId: v.defaultTeamId ? Number(v.defaultTeamId) : undefined,
      });
      this.createdCredentials.set({ email: result.email, password: result.password });
      this.toast.success('Account created.');
      this.form.reset({ role: '', organizationId: '', organizationName: '', tier: 'manual', defaultTeamId: '' });
      await this.loadOrganizations();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to create account.');
    } finally {
      this.creating.set(false);
    }
  }

  async changeTier(org: AdminOrganizationRow, event: Event): Promise<void> {
    const tier = (event.target as HTMLSelectElement).value as Tier;
    try {
      await window.boxscoreApi.adminUpdateOrganization({ organizationId: org.id, tier });
      this.toast.success(`${org.name} moved to ${tier}.`);
      await this.loadOrganizations();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to update package.');
    }
  }

  async changeDefaultTeam(org: AdminOrganizationRow, event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value;
    try {
      await window.boxscoreApi.adminUpdateOrganization({
        organizationId: org.id,
        defaultTeamId: value ? Number(value) : null,
      });
      this.toast.success(`Default team updated for ${org.name}.`);
      await this.loadOrganizations();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to update default team.');
    }
  }
}
