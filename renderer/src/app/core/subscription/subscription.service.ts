import { Injectable, computed, inject, signal } from '@angular/core';
import { ToastService } from '../../shared/services/toast.service';
import type { BaseSubscription, UploadPlan, UploadStatus } from '../models/box-score.model';

export type CheckoutParams =
  | { kind: 'base'; tier: 'individual' | 'team'; interval: 'month' | 'year'; seatCount?: number }
  | { kind: 'upload'; planId: string };

/**
 * Single source of truth for "does this account have an active
 * subscription" — read by the app-wide subscription gate (blocks
 * everything except guest mode) and the Upload a Photo page's own gate
 * (blocks that one feature, guest mode included, since it's the paid-API
 * feature and the guest bypass was never meant to cover that).
 */
@Injectable({ providedIn: 'root' })
export class SubscriptionService {
  private readonly toast = inject(ToastService);

  readonly baseSubscription = signal<BaseSubscription | null>(null);
  readonly uploadStatus = signal<UploadStatus | null>(null);
  readonly uploadPlans = signal<UploadPlan[]>([]);
  readonly organizationId = signal<string | null>(null);
  readonly loading = signal(false);

  /** null = not loaded yet, true = has access, false = blocked. */
  readonly hasBaseAccess = computed<boolean | null>(() => {
    const sub = this.baseSubscription();
    if (!sub) return null;
    if (sub.source === 'guest') return true;
    if (sub.source === 'none') return false;
    return sub.status === 'active' || sub.status === 'trialing';
  });

  /** Guest mode does NOT bypass this one — it gates the paid Claude API call. */
  readonly hasUploadAccess = computed<boolean | null>(() => {
    const up = this.uploadStatus();
    if (!up) return null;
    if (up.source !== 'active') return false;
    return up.status === 'active' || up.status === 'trialing';
  });

  private initialized = false;
  private deepLinkUnsubscribe: (() => void) | null = null;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  /** Call once, after the user is authenticated (or in guest mode). */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    void this.refreshAll();
    try {
      this.deepLinkUnsubscribe = window.boxscoreApi.onCheckoutReturn((status) => this.handleCheckoutReturn(status));
    } catch {
      // window.boxscoreApi isn't available outside the real Electron window
      // (e.g. a plain browser preview) — subscription status just won't
      // auto-refresh after a checkout redirect there.
    }
  }

  /** Call on logout so a stale subscription state doesn't leak into the next login. */
  reset(): void {
    this.initialized = false;
    this.deepLinkUnsubscribe?.();
    this.deepLinkUnsubscribe = null;
    this.stopPolling();
    this.baseSubscription.set(null);
    this.uploadStatus.set(null);
    this.organizationId.set(null);
  }

  async refreshAll(): Promise<void> {
    this.loading.set(true);
    try {
      const [base, upload, plans, profile] = await Promise.all([
        window.boxscoreApi.getBaseSubscription(),
        window.boxscoreApi.getUploadStatus(),
        window.boxscoreApi.listUploadPlans(),
        window.boxscoreApi.getProfile(),
      ]);
      this.baseSubscription.set(base);
      this.uploadStatus.set(upload);
      this.uploadPlans.set(plans);
      this.organizationId.set(profile?.organization_id ?? null);
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to load subscription status.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Polls subscription status every few seconds after a checkout is
   * opened, so payment gets picked up even when the boxscore-analytics://
   * deep link doesn't fire — which is common for unpackaged dev builds,
   * since Windows protocol-handler registration from `electron .` is
   * unreliable (packaged installers register it properly). Stops itself
   * once access is granted or after a few minutes.
   */
  private startPolling(): void {
    if (this.pollHandle) return;
    const startedAt = Date.now();
    const maxDurationMs = 3 * 60 * 1000;
    this.pollHandle = setInterval(() => {
      if (this.hasBaseAccess() === true || this.hasUploadAccess() === true || Date.now() - startedAt > maxDurationMs) {
        this.stopPolling();
        return;
      }
      void this.refreshAll();
    }, 4000);
  }

  private stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /** Manual escape hatch for the "I've already paid" button in the gate UI. */
  async refreshNow(): Promise<void> {
    await this.refreshAll();
    if (this.hasBaseAccess() !== true && this.hasUploadAccess() !== true) {
      this.toast.error("Still not seeing it — Stripe may need a few more seconds. Try again shortly.");
    }
  }

  private handleCheckoutReturn(status: string | null): void {
    if (status === 'success') {
      this.toast.success('Payment received — activating your subscription…');
    } else if (status === 'cancelled') {
      this.toast.error('Checkout was cancelled — nothing was charged.');
    }
    // The Stripe webhook may take a moment to land.
    setTimeout(() => void this.refreshAll(), 2500);
  }

  async checkout(params: CheckoutParams): Promise<void> {
    try {
      await window.boxscoreApi.checkout(params);
      this.toast.success('Opening Stripe Checkout in your browser…');
      this.startPolling();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to start checkout.');
    }
  }

  /**
   * Team checkout needs an organization to attach the subscription to.
   * If the caller isn't on one yet, creates one first (using `newTeamName`)
   * before starting checkout — the single place this happens, so the gate
   * modal and the Account page can't drift out of sync on this logic again.
   */
  async subscribeTeam(interval: 'month' | 'year', seatCount: number, newTeamName?: string): Promise<void> {
    if (!this.organizationId()) {
      const name = (newTeamName ?? '').trim();
      if (!name) {
        this.toast.error('Give your team a name first.');
        return;
      }
      try {
        await window.boxscoreApi.createOrganization(name);
        const profile = await window.boxscoreApi.getProfile();
        this.organizationId.set(profile?.organization_id ?? null);
      } catch (err) {
        this.toast.error(err instanceof Error ? err.message : 'Failed to create team.');
        return;
      }
    }
    await this.checkout({ kind: 'base', tier: 'team', interval, seatCount });
  }

  async openBillingPortal(): Promise<void> {
    try {
      await window.boxscoreApi.openBillingPortal();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to open the billing portal.');
    }
  }

  async cancelBase(): Promise<void> {
    try {
      await window.boxscoreApi.cancelBaseSubscription();
      this.toast.success('Subscription set to cancel at period end.');
      await this.refreshAll();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to cancel subscription.');
    }
  }

  async cancelUpload(): Promise<void> {
    try {
      await window.boxscoreApi.cancelUploadSubscription();
      this.toast.success('Upload add-on set to cancel at period end.');
      await this.refreshAll();
    } catch (err) {
      this.toast.error(err instanceof Error ? err.message : 'Failed to cancel add-on.');
    }
  }
}
