import { getUserScopedClient } from './supabaseClients.ts';

/**
 * Verifies the caller is the platform admin (profiles.is_platform_admin) —
 * the one person (the app owner) allowed to provision accounts/orgs/tiers
 * outside of Stripe. Returns their user id; throws otherwise. Every
 * admin-* Edge Function starts with this before switching to the
 * service-role client for the actual work.
 */
export async function requirePlatformAdmin(req: Request): Promise<string> {
  const supabase = getUserScopedClient(req);
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) throw new Error('Not authenticated.');

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('is_platform_admin')
    .eq('id', user.id)
    .single();
  if (profileErr) throw new Error(profileErr.message);
  if (!profile.is_platform_admin) throw new Error('Not authorized.');

  return user.id;
}
