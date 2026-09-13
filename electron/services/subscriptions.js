const { getSupabaseClient } = require('./supabaseClient');

async function getCurrentUserId() {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

/**
 * supabase-js's functions.invoke() throws a generic "Edge Function
 * returned a non-2xx status code" for any HTTP error — the actual reason
 * (e.g. "No Stripe price configured for...") is JSON in the response body,
 * reachable only via error.context (a Response object). Without this, every
 * checkout/cancel failure surfaced the same useless message regardless of
 * cause.
 */
async function describeFunctionError(error) {
  if (error?.context && typeof error.context.json === 'function') {
    try {
      const body = await error.context.clone().json();
      if (body?.error) return body.error;
    } catch {
      // Response body wasn't JSON — fall through to the generic message.
    }
  }
  return error?.message || 'Unknown error.';
}

/**
 * The org's annual subscription — every account works through a club/org
 * now, even a solo coach (an org of one). `source: 'guest'` means there's
 * no Supabase session at all (the app's local "continue as guest" mode);
 * `source: 'none'` means the account is signed in but has no org, or its
 * org has never subscribed.
 */
async function getSubscription() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) return { source: 'guest' };

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('organization_id, is_platform_admin, organizations(name)')
    .eq('id', userId)
    .maybeSingle();
  if (profileErr) throw new Error(profileErr.message);
  const isPlatformAdmin = !!profile?.is_platform_admin;
  if (!profile?.organization_id) return { source: 'none', isPlatformAdmin };

  const organizationName = profile.organizations?.name ?? null;

  const { data: sub, error: subErr } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('owner_type', 'organization')
    .eq('organization_id', profile.organization_id)
    .maybeSingle();
  if (subErr) throw new Error(subErr.message);
  if (!sub) return { source: 'none', organizationId: profile.organization_id, organizationName, isPlatformAdmin };

  return { ...sub, source: 'active', organizationName, isPlatformAdmin };
}

function isActiveStatus(sub) {
  return sub.source === 'active' && (sub.status === 'active' || sub.status === 'trialing');
}

/**
 * Single source of truth for what this account is allowed to do — every
 * gate (the OCR call, db:save-game, route guards, nav links) reads from
 * this instead of re-deriving access from raw subscription rows.
 */
async function getTier() {
  const sub = await getSubscription();
  const active = isActiveStatus(sub);
  const isPlatformAdmin = sub.isPlatformAdmin ?? false;
  // The platform admin is never meant to carry a subscription of their own
  // — they're the one uploading the weekly league data everyone else's
  // packages depend on, so every gate (including the write-path checks in
  // ipc.js's db:save-game/ocr:extract-box-score) bypasses for them.
  return {
    source: sub.source, // 'guest' | 'none' | 'active'
    tier: sub.tier ?? null, // 'manual' | 'photo' | 'pro' | null
    status: sub.status ?? null,
    organizationId: sub.organization_id ?? sub.organizationId ?? null,
    organizationName: sub.organizationName ?? null,
    currentPeriodEnd: sub.current_period_end ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    hasBaseAccess: isPlatformAdmin || sub.source === 'guest' || active,
    canUploadPhoto: isPlatformAdmin || (sub.source === 'guest' ? false : active && sub.tier === 'photo'),
    canManualEntry: isPlatformAdmin || sub.source === 'guest' || (active && (sub.tier === 'manual' || sub.tier === 'photo')),
    isPro: !isPlatformAdmin && active && sub.tier === 'pro',
    isPlatformAdmin,
  };
}

/** Cancels the org's subscription — same Stripe-vs-dev-bypass split as before. */
async function cancelSubscription() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to manage a subscription.');

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', userId)
    .single();
  if (profileErr) throw new Error(profileErr.message);
  if (!profile.organization_id) throw new Error('No club/subscription found.');

  const { data: existing, error: findErr } = await supabase
    .from('subscriptions')
    .select('id, stripe_subscription_id')
    .eq('owner_type', 'organization')
    .eq('organization_id', profile.organization_id)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (!existing) throw new Error('No active subscription to cancel.');

  if (existing.stripe_subscription_id) {
    const { error } = await supabase.functions.invoke('cancel-subscription', { body: {} });
    if (error) throw new Error(await describeFunctionError(error));
    return;
  }

  const { error } = await supabase.from('subscriptions').update({ cancel_at_period_end: true }).eq('id', existing.id);
  if (error) throw new Error(error.message);
}

/**
 * Starts a Stripe Checkout Session for the org's chosen tier and returns
 * its URL — the caller (ipc.js) opens it in the system browser via
 * shell.openExternal. Stripe redirects back to a boxscore-analytics://
 * deep link on completion (see main.js).
 */
async function createCheckoutSession(params) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to subscribe.');

  const { data, error } = await supabase.functions.invoke('create-checkout-session', { body: params });
  if (error) throw new Error(await describeFunctionError(error));
  if (!data?.url) throw new Error('Stripe did not return a checkout URL.');
  return data.url;
}

/** Opens the Stripe-hosted Customer Portal for payment method/invoice/plan management. */
async function createPortalSession() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to manage billing.');

  const { data, error } = await supabase.functions.invoke('create-portal-session', { body: {} });
  if (error) throw new Error(await describeFunctionError(error));
  if (!data?.url) throw new Error('Stripe did not return a billing portal URL.');
  return data.url;
}

async function getProfile() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*, organizations(name)')
    .eq('id', userId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Team membership is deliberately NOT settable here — joining a team only
 * happens via accept_team_invite() or createOrganization() (see
 * supabase/migrations/0007). A generic profile update touching
 * organization_id would reopen the free-pick loophole those exist to close.
 */
async function updateProfile(fields) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to update your profile.');
  const { error } = await supabase
    .from('profiles')
    .update({
      first_name: fields.firstName,
      last_name: fields.lastName,
      role: fields.role || null,
      birth_date: fields.birthDate || null,
    })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

async function changePassword(newPassword) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

module.exports = {
  getTier,
  cancelSubscription,
  getProfile,
  updateProfile,
  changePassword,
  createCheckoutSession,
  createPortalSession,
};
