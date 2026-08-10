const { getSupabaseClient } = require('./supabaseClient');

async function getCurrentUserId() {
  const supabase = getSupabaseClient();
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

/** Reference data — club names, for display only (joining now requires an invite). */
async function listOrganizations() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('organizations').select('id, name').order('name');
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Creates a brand-new team and makes the caller its first member — the
 * other way (besides accepting an invite) to end up in an organization.
 * Used when someone with no club yet wants the Team subscription.
 */
async function createOrganization(name) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to create a team.');

  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .insert({ name })
    .select('id, name')
    .single();
  if (orgErr) throw new Error(orgErr.message);

  const { error: profErr } = await supabase
    .from('profiles')
    .update({ organization_id: org.id })
    .eq('id', userId);
  if (profErr) throw new Error(profErr.message);

  return org;
}

/** Pending invites addressed to the caller's own email. */
async function listMyInvites() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from('team_invites')
    .select('id, organization_id, status, created_at, organizations(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

/** Invites the caller has sent for their own club (any status). */
async function listSentInvites() {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from('team_invites')
    .select('id, email, status, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

/** Invites `email` to the caller's own club — only an existing member can do this. */
async function createInvite(email) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to invite someone.');

  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', userId)
    .single();
  if (profErr) throw new Error(profErr.message);
  if (!profile.organization_id) throw new Error("You're not on a team yet — create one first.");

  const { error } = await supabase
    .from('team_invites')
    .insert({ organization_id: profile.organization_id, email, invited_by: userId });
  if (error) throw new Error(error.message);
}

/**
 * Joins the team behind this invite. Soft-deletes the caller's own
 * personal games (they lose access to them from then on — see
 * supabase/migrations/0007) and cancels any individual subscription,
 * since the team's billing covers them now. All done atomically by the
 * accept_team_invite() Postgres function.
 */
async function acceptInvite(inviteId) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to accept an invite.');
  const { error } = await supabase.rpc('accept_team_invite', { p_invite_id: inviteId });
  if (error) throw new Error(error.message);
}

async function declineInvite(inviteId) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to decline an invite.');
  const { error } = await supabase.rpc('decline_team_invite', { p_invite_id: inviteId });
  if (error) throw new Error(error.message);
}

/** Revokes an invite the caller's team sent (before it's been accepted). */
async function revokeInvite(inviteId) {
  const supabase = getSupabaseClient();
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('You need to be logged in to manage invites.');
  const { error } = await supabase.from('team_invites').update({ status: 'revoked' }).eq('id', inviteId);
  if (error) throw new Error(error.message);
}

module.exports = {
  listOrganizations,
  createOrganization,
  listMyInvites,
  listSentInvites,
  createInvite,
  acceptInvite,
  declineInvite,
  revokeInvite,
};
