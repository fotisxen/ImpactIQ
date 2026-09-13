const { getSupabaseClient } = require('./supabaseClient');

async function getCurrentUserId() {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

async function getCurrentUserOrganizationId() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) return null;
  const { data, error } = await supabase.from('profiles').select('organization_id').eq('id', userId).single();
  if (error) throw new Error(error.message);
  return data.organization_id;
}

/**
 * Uploads a scouting report PDF to the club's private Storage folder and
 * records it as the newest published_reports row — "the current report" for
 * an organization is just whichever row has the latest published_at, so
 * publishing again naturally supersedes the previous one without needing to
 * delete or flag anything.
 */
async function publishScoutingReport({ pdfBuffer, opponentName, gameDate }) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to publish a report.');
  const organizationId = await getCurrentUserOrganizationId();
  if (!organizationId) throw new Error("You're not on a team yet — create or join one first.");

  const storagePath = `${organizationId}/${Date.now()}.pdf`;
  const { error: uploadErr } = await supabase.storage
    .from('scouting-reports')
    .upload(storagePath, pdfBuffer, { contentType: 'application/pdf' });
  if (uploadErr) throw new Error(uploadErr.message);

  const { data, error: insertErr } = await supabase
    .from('published_reports')
    .insert({ organization_id: organizationId, storage_path: storagePath, opponent_name: opponentName, game_date: gameDate, published_by: userId })
    .select('id, published_at')
    .single();
  if (insertErr) throw new Error(insertErr.message);
  return data;
}

/** The most recently published report for the caller's own club, or null if none yet. */
async function getCurrentPublishedReport() {
  const supabase = getSupabaseClient();
  const organizationId = await getCurrentUserOrganizationId();
  if (!organizationId) return null;
  const { data, error } = await supabase
    .from('published_reports')
    .select('id, opponent_name, game_date, published_at')
    .eq('organization_id', organizationId)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Who on the team has opened the given report, newest view first.
 *
 * report_views.viewer_id references auth.users(id), not public.profiles(id),
 * so PostgREST's schema cache has no FK to auto-embed `profiles(...)` in one
 * query (that's the "Could not find a relationship" error) — fetch the two
 * separately and join in JS instead of adding a redundant second FK.
 */
async function listReportViewers(reportId) {
  const supabase = getSupabaseClient();
  const { data: views, error } = await supabase
    .from('report_views')
    .select('viewer_id, viewed_at')
    .eq('report_id', reportId)
    .order('viewed_at', { ascending: false });
  if (error) throw new Error(error.message);
  if (views.length === 0) return [];

  const viewerIds = [...new Set(views.map((v) => v.viewer_id))];
  const { data: profiles, error: profilesErr } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, email')
    .in('id', viewerIds);
  if (profilesErr) throw new Error(profilesErr.message);
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  return views.map((v) => {
    const p = profileById.get(v.viewer_id);
    return { viewerId: v.viewer_id, firstName: p?.first_name ?? '', lastName: p?.last_name ?? '', email: p?.email ?? '', viewedAt: v.viewed_at };
  });
}

/** Every player account on the caller's own club. */
async function listPlayers() {
  const supabase = getSupabaseClient();
  const organizationId = await getCurrentUserOrganizationId();
  if (!organizationId) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, email')
    .eq('organization_id', organizationId)
    .eq('role', 'player')
    .order('last_name');
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Creates a new player account via the create-player-account Edge Function
 * (needs the service-role key, which never leaves that function) — returns
 * the generated password ONCE, for the coach to relay to the player directly.
 */
async function createPlayerAccount({ email, firstName, lastName }) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.functions.invoke('create-player-account', {
    body: { email, firstName, lastName },
  });
  if (error) {
    // A non-2xx response from the function is surfaced as a generic
    // FunctionsHttpError whose own .message is just "Edge Function returned
    // a non-2xx status code" — the function's actual reason (e.g. "You're
    // not on a team yet", a duplicate email, ...) is in the response body,
    // reachable via error.context (the raw Response object).
    let message = error.message;
    try {
      const body = await error.context?.json();
      if (body?.error) message = body.error;
    } catch {
      // Response body wasn't JSON (or already consumed) — fall back to the generic message.
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data; // { email, password }
}

module.exports = {
  getCurrentUserOrganizationId,
  publishScoutingReport,
  getCurrentPublishedReport,
  listReportViewers,
  listPlayers,
  createPlayerAccount,
};
