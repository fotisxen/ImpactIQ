import { Injectable, computed, signal } from '@angular/core';
import type { Organization, SignupProfile } from '../models/box-score.model';

export interface CurrentUser {
  id: string | null;
  email: string;
  isGuest: boolean;
}

const STORAGE_KEY = 'boxscore.currentUser';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _currentUser = signal<CurrentUser | null>(this.readStoredUser());

  readonly currentUser = computed(() => this._currentUser());
  readonly isAuthenticated = computed(() => this._currentUser() !== null);

  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  async signup(email: string, password: string, profile: SignupProfile): Promise<boolean> {
    return this.runAuthCall(() => window.boxscoreApi.signup(email, password, profile));
  }

  async login(email: string, password: string): Promise<boolean> {
    return this.runAuthCall(() => window.boxscoreApi.login(email, password));
  }

  listOrganizations(): Promise<Organization[]> {
    return window.boxscoreApi.listOrganizations();
  }

  /** Lets you click straight into the app without setting up real auth. */
  continueAsGuest(): void {
    this.setUser({ id: null, email: 'guest@local', isGuest: true });
  }

  async logout(): Promise<void> {
    const wasGuest = this._currentUser()?.isGuest ?? true;
    this._currentUser.set(null);
    localStorage.removeItem(STORAGE_KEY);
    if (!wasGuest) {
      try {
        await window.boxscoreApi.logout();
      } catch {
        // Local session is already cleared either way — a failed remote
        // sign-out shouldn't block the user from leaving the app.
      }
    }
  }

  private async runAuthCall(fn: () => Promise<{ id: string; email: string }>): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const user = await fn();
      this.setUser({ id: user.id, email: user.email, isGuest: false });
      return true;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Something went wrong.');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private setUser(user: CurrentUser): void {
    this._currentUser.set(user);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  }

  private readStoredUser(): CurrentUser | null {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  }
}
