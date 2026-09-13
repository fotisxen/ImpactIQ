import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SubscriptionService } from './subscription.service';

/**
 * `!== false` (not `=== true`) deliberately lets guest sessions and the
 * brief "subscription not loaded yet" window through — matches the same
 * tri-state convention already used for nav-link visibility, so a slow
 * subscription fetch never flashes a redirect for an account that turns
 * out to have access. Pro tier (the only case these ever return `false`
 * for) is the only one actually blocked.
 */
export const photoTierGuard: CanActivateFn = () => {
  const sub = inject(SubscriptionService);
  const router = inject(Router);
  return sub.canUploadPhoto() !== false ? true : router.createUrlTree(['/account']);
};

export const entryTierGuard: CanActivateFn = () => {
  const sub = inject(SubscriptionService);
  const router = inject(Router);
  return sub.canManualEntry() !== false ? true : router.createUrlTree(['/account']);
};

/**
 * Gates the Admin page — hiding the nav link isn't the only thing stopping
 * a non-admin from reaching it, the 3 admin Edge Functions re-check
 * `profiles.is_platform_admin` server-side on every call regardless of
 * whether this guard is bypassed. Unlike the tier guards above, this one
 * is `=== true` (not `!== false`): the Admin page does real, immediate
 * account-provisioning actions, so it's worth a brief redirect during the
 * loading window rather than ever flashing it open speculatively.
 */
export const platformAdminGuard: CanActivateFn = () => {
  const sub = inject(SubscriptionService);
  const router = inject(Router);
  return sub.isPlatformAdmin() === true ? true : router.createUrlTree(['/home']);
};
