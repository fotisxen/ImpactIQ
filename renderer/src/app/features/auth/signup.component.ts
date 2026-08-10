import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-signup',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="auth-page">
      <section class="auth-card card">
        <div class="brand">
          <span class="brand-mark">BA</span>
          <span class="brand-name">Box Score Analytics</span>
        </div>

        <h2>Create an account</h2>

        <form [formGroup]="form" (ngSubmit)="submit()">
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

          <label class="field">
            <span class="field-label">Email</span>
            <input type="email" formControlName="email" />
          </label>
          <label class="field">
            <span class="field-label">Password</span>
            <input type="password" formControlName="password" />
            <span class="hint">At least 8 characters.</span>
          </label>

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
              <span class="field-label">Date of birth <span class="optional">(optional)</span></span>
              <input type="date" formControlName="birthDate" />
            </label>
          </div>

          <p class="hint">
            Joining a club comes later, from Account settings — either accept an invite from a teammate
            or start a new team of your own.
          </p>

          @if (auth.error(); as err) {
            <p class="error-text">{{ err }}</p>
          }

          <button type="submit" class="btn btn-primary" [disabled]="form.invalid || auth.busy()">
            {{ auth.busy() ? 'Creating…' : 'Sign up' }}
          </button>
        </form>

        <p class="switch-link">Already have an account? <a routerLink="/login">Log in</a></p>

        <hr />

        <button type="button" class="btn btn-secondary" (click)="continueAsGuest()">
          Skip for now — try the app as a guest
        </button>
      </section>
    </div>
  `,
  styles: `
    .auth-page {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at 30% 20%, rgba(255, 122, 41, 0.08), transparent 55%),
        var(--bg);
      padding: var(--space-4) 0;
    }
    .auth-card {
      width: 420px;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin-bottom: var(--space-2);
    }
    .brand-mark {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: var(--radius-md);
      background: var(--accent);
      color: var(--accent-text);
      font-weight: 800;
      font-size: 0.85rem;
    }
    .brand-name {
      font-weight: 700;
      font-size: 0.9rem;
      color: var(--text-muted);
    }
    h2 {
      font-size: 1.3rem;
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
    .optional {
      color: var(--text-muted);
      font-weight: 400;
    }
    select,
    input[type='date'] {
      width: 100%;
    }
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 0;
    }
    .switch-link {
      font-size: 0.85rem;
      color: var(--text-muted);
    }
  `,
})
export class SignupComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly form = new FormGroup({
    firstName: new FormControl('', { validators: [Validators.required], nonNullable: true }),
    lastName: new FormControl('', { validators: [Validators.required], nonNullable: true }),
    email: new FormControl('', { validators: [Validators.required, Validators.email], nonNullable: true }),
    password: new FormControl('', { validators: [Validators.required, Validators.minLength(8)], nonNullable: true }),
    role: new FormControl('', { nonNullable: true }),
    birthDate: new FormControl('', { nonNullable: true }),
  });

  async submit(): Promise<void> {
    if (this.form.invalid) return;
    const { email, password, firstName, lastName, role, birthDate } = this.form.getRawValue();
    const ok = await this.auth.signup(email, password, {
      firstName,
      lastName,
      role: role || null,
      birthDate: birthDate || null,
    });
    if (ok) void this.router.navigate(['/']);
  }

  continueAsGuest(): void {
    this.auth.continueAsGuest();
    void this.router.navigate(['/']);
  }
}
