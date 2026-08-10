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
 * The base app-usage plan, resolved from whichever side actually applies:
 * the user's own individual subscription, or — if they belong to a club —
 * that club's team subscription. `source: 'guest'` means there's no
 * Supabase session at all (the app's local "continue as guest" mode).
 */
async function getBaseSubscription() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) return { source: 'guest' };

  const { data: individual, error: indErr } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('owner_type', 'user')
    .eq('user_id', userId)
    .maybeSingle();
  if (indErr) throw new Error(indErr.message);
  if (individual) return { ...individual, source: 'individual' };

  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('organization_id, organizations(name)')
    .eq('id', userId)
    .maybeSingle();
  if (profErr) throw new Error(profErr.message);
  if (!profile?.organization_id) return { source: 'none' };

  const { data: team, error: teamErr } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('owner_type', 'organization')
    .eq('organization_id', profile.organization_id)
    .maybeSingle();
  if (teamErr) throw new Error(teamErr.message);

  const organizationName = profile.organizations?.name ?? null;
  return team ? { ...team, source: 'team', organizationName } : { source: 'none', organizationName };
}

/**
 * Cancels the caller's own individual subscription. If it's backed by a
 * real Stripe subscription, tells Stripe to stop renewing (the
 * stripe-webhook function syncs cancel_at_period_end back into Supabase
 * once Stripe confirms it). A dev-bypass row with no Stripe subscription
 * attached is flipped directly, since there's nothing for Stripe to know
 * about. Team subscriptions aren't self-serve cancelable yet — that needs
 * an "organization admin" concept the schema doesn't have.
 */
async function cancelBaseSubscription() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to manage a subscription.');

  const { data: existing, error: findErr } = await supabase
    .from('subscriptions')
    .select('id, stripe_subscription_id')
    .eq('owner_type', 'user')
    .eq('user_id', userId)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (!existing) {
    throw new Error(
      'No individual subscription to cancel. Team subscriptions are managed by your club — contact them directly.'
    );
  }

  if (existing.stripe_subscription_id) {
    const { error } = await supabase.functions.invoke('cancel-subscription', { body: { kind: 'base' } });
    if (error) throw new Error(await describeFunctionError(error));
    return;
  }

  const { error } = await supabase.from('subscriptions').update({ cancel_at_period_end: true }).eq('id', existing.id);
  if (error) throw new Error(error.message);
}

/** Photo-upload add-on status: plan, monthly limit, and usage so far this billing period. */
async function getUploadStatus() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) return { source: 'guest' };

  const { data: sub, error: subErr } = await supabase
    .from('upload_subscriptions')
    .select('*, upload_plans(name, monthly_upload_limit, price_cents, currency)')
    .eq('user_id', userId)
    .maybeSingle();
  if (subErr) throw new Error(subErr.message);

  const { data: used, error: usedErr } = await supabase.rpc('upload_usage_this_period', { uid: userId });
  if (usedErr) throw new Error(usedErr.message);
  const usedCount = used ?? 0;

  if (!sub) return { source: 'none', used: usedCount };

  const limit = sub.upload_plans?.monthly_upload_limit ?? 0;
  return {
    source: 'active',
    planName: sub.upload_plans?.name ?? null,
    limit,
    used: usedCount,
    remaining: Math.max(limit - usedCount, 0),
    exhausted: usedCount >= limit,
    status: sub.status,
    currentPeriodEnd: sub.current_period_end,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

async function cancelUploadSubscription() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to manage a subscription.');

  const { data: existing, error: findErr } = await supabase
    .from('upload_subscriptions')
    .select('id, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (!existing) throw new Error('No upload add-on subscription to cancel.');

  if (existing.stripe_subscription_id) {
    const { error } = await supabase.functions.invoke('cancel-subscription', { body: { kind: 'upload' } });
    if (error) throw new Error(await describeFunctionError(error));
    return;
  }

  const { error } = await supabase
    .from('upload_subscriptions')
    .update({ cancel_at_period_end: true })
    .eq('id', existing.id);
  if (error) throw new Error(error.message);
}

/**
 * Starts a Stripe Checkout Session for the base plan or the upload add-on
 * and returns its URL — the caller (ipc.js) opens it in the system
 * browser via shell.openExternal. Stripe redirects back to a
 * boxscore-analytics:// deep link on completion (see main.js).
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

/** Every plan in the catalog, for the upgrade/choose-plan picker. */
async function listUploadPlans() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('upload_plans').select('*').order('sort_order');
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Throws if the current user has no upload quota left this period —
 * called before the OCR call itself so a blocked upload never reaches the
 * (paid) Claude API. Call recordPhotoUpload() after a successful extract.
 */
async function assertUploadQuotaAvailable() {
  const status = await getUploadStatus();
  if (status.source === 'guest') {
    throw new Error('Sign up and subscribe to the Upload a Photo add-on to use this feature.');
  }
  if (status.source === 'none') {
    throw new Error('You don\'t have an Upload a Photo subscription yet. Add one from Account settings.');
  }
  if (status.status !== 'active' && status.status !== 'trialing') {
    throw new Error('Your Upload a Photo subscription isn\'t active. Renew it from Account settings.');
  }
  if (status.exhausted) {
    throw new Error(
      `You've used all ${status.limit} uploads included in your ${status.planName} plan this period. ` +
        'Upgrade your plan from Account settings to upload more this month.'
    );
  }
}

async function recordPhotoUpload() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) return; // Guest session — nothing to meter.
  const { error } = await supabase.from('photo_upload_events').insert({ user_id: userId });
  if (error) throw new Error(error.message);
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
  getBaseSubscription,
  cancelBaseSubscription,
  getUploadStatus,
  cancelUploadSubscription,
  listUploadPlans,
  assertUploadQuotaAvailable,
  recordPhotoUpload,
  getProfile,
  updateProfile,
  changePassword,
  createCheckoutSession,
  createPortalSession,
};
