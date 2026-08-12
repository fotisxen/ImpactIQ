import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-login',
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

        <h2>Log in</h2>

        <form [formGroup]="form" (ngSubmit)="submit()">
          <label class="field">
            <span class="field-label">Email</span>
            <input type="email" formControlName="email" />
          </label>
          <label class="field">
            <span class="field-label">Password</span>
            <input type="password" formControlName="password" />
          </label>

          @if (auth.error(); as err) {
            <p class="error-text">{{ err }}</p>
          }

          <button type="submit" class="btn btn-primary" [disabled]="form.invalid || auth.busy()">
            {{ auth.busy() ? 'Logging in…' : 'Log in' }}
          </button>
        </form>

        <p class="switch-link">No account? <a routerLink="/signup">Sign up</a></p>

        <hr />

        <!-- <button type="button" class="btn btn-secondary" (click)="continueAsGuest()">
          Skip for now — try the app as a guest
        </button> -->
        <p class="hint">
          Guest mode doesn't create an account. It just lets you click straight
          into the upload / manual entry / export flow to see how it works.
        </p>
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
    }
    .auth-card {
      width: 380px;
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
export class LoginComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly form = new FormGroup({
    email: new FormControl('', { validators: [Validators.required, Validators.email], nonNullable: true }),
    password: new FormControl('', { validators: [Validators.required], nonNullable: true }),
  });

  async submit(): Promise<void> {
    if (this.form.invalid) return;
    const { email, password } = this.form.getRawValue();
    const ok = await this.auth.login(email, password);
    if (ok) void this.router.navigate(['/']);
  }

  continueAsGuest(): void {
    this.auth.continueAsGuest();
    void this.router.navigate(['/']);
  }
}
