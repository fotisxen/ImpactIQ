const { getSupabaseClient } = require('./supabaseClient');

async function getCurrentUserId() {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

/**
 * supabase-js's functions.invoke() throws a generic "Edge Function
 * returned a non-2xx status code" for any HTTP error — the actual reason
 * is JSON in the response body, reachable only via error.context (a
 * Response object). Same helper as electron/services/subscriptions.js,
 * duplicated rather than imported to keep these two services independent.
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
 * Creates a user account, club (existing or new), and package — the
 * owner-only, no-Stripe provisioning path. Returns the generated
 * credentials once, same shape as create-player-account.
 */
async function createAccount(params) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in.');

  const { data, error } = await supabase.functions.invoke('admin-create-account', { body: params });
  if (error) throw new Error(await describeFunctionError(error));
  return data;
}

async function listOrganizations() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in.');

  const { data, error } = await supabase.functions.invoke('admin-list-organizations', { body: {} });
  if (error) throw new Error(await describeFunctionError(error));
  return data.organizations;
}

async function updateOrganization(params) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in.');

  const { data, error } = await supabase.functions.invoke('admin-update-organization', { body: params });
  if (error) throw new Error(await describeFunctionError(error));
  return data;
}

module.exports = { createAccount, listOrganizations, updateOrganization };
