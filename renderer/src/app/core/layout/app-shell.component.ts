import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../auth/auth.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { ThemeService } from '../theme/theme.service';
import { ToastHostComponent } from '../../shared/components/toast.component';
import { SubscriptionGateComponent } from '../../shared/components/subscription-gate.component';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastHostComponent, SubscriptionGateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">BA</span>
          <span class="brand-name">Box Score<br />Analytics</span>
        </div>
        <nav>
          <a routerLink="/home" routerLinkActive="active">Home</a>
          @if (sub.canUploadPhoto() !== false) {
            <a routerLink="/upload" routerLinkActive="active">Upload Photo</a>
          }
          @if (sub.canManualEntry() !== false) {
            <a routerLink="/import-pbp" routerLinkActive="active">Import Play-by-Play</a>
            <a routerLink="/manual-entry" routerLinkActive="active">Manual Entry</a>
            <a routerLink="/shot-chart-entry" routerLinkActive="active">Shot Chart Entry</a>
          }
          <a routerLink="/dashboard" routerLinkActive="active">Dashboard</a>
          <a routerLink="/game-insights" routerLinkActive="active">Insights</a>
          <a routerLink="/four-factors" routerLinkActive="active">Four Factors</a>
          <a routerLink="/compare" routerLinkActive="active">Compare</a>
          <a routerLink="/scouting" routerLinkActive="active">Scouting</a>
          <a routerLink="/draw" routerLinkActive="active">Draw</a>
          <a routerLink="/account" routerLinkActive="active">Account</a>
          @if (sub.isPlatformAdmin()) {
            <a routerLink="/admin" routerLinkActive="active">Admin</a>
          }
        </nav>
      </aside>

      <div class="main">
        <header class="topbar">
          <button
            type="button"
            class="btn btn-ghost btn-sm theme-toggle"
            (click)="theme.toggle()"
            [attr.aria-label]="theme.theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
          >
            {{ theme.theme() === 'dark' ? '🌙 Dark' : '☀️ Light' }}
          </button>
          @if (auth.currentUser(); as u) {
            @if (u.isGuest) {
              <span class="badge">Guest</span>
            } @else {
              <span class="user-email">{{ u.email }}</span>
            }
          }
          <button class="btn btn-ghost btn-sm" (click)="logout()">Log out</button>
        </header>

        <main class="content">
          <router-outlet />
        </main>
      </div>
    </div>

    <app-toast-host />
    <app-subscription-gate />
  `,
  styles: `
    .shell {
      display: grid;
      grid-template-columns: 220px 1fr;
      height: 100vh;
    }

    .sidebar {
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      padding: var(--space-5) var(--space-4);
      gap: var(--space-6);
      overflow-y: auto;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: var(--space-3);
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
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .brand-name {
      font-weight: 700;
      font-size: 0.85rem;
      line-height: 1.25;
      color: var(--text);
    }

    nav {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    nav a {
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 600;
      font-size: 0.88rem;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
      transition:
        background-color 0.15s ease,
        color 0.15s ease;
    }
    nav a:hover {
      background: var(--surface-hover);
      color: var(--text);
    }
    nav a.active {
      background: var(--accent-muted);
      color: var(--accent);
    }

    .main {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-4);
      padding: var(--space-3) var(--space-6);
      border-bottom: 1px solid var(--border);
    }
    .user-email {
      color: var(--text-muted);
      font-size: 0.85rem;
    }

    .content {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
    }
  `,
})
export class AppShellComponent {
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  protected readonly sub = inject(SubscriptionService);
  private readonly router = inject(Router);

  constructor() {
    this.sub.init();
  }

  logout(): void {
    this.sub.reset();
    void this.auth.logout();
    void this.router.navigate(['/login']);
  }
}
