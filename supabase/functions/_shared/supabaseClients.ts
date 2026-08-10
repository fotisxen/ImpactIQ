import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * A client scoped to the calling user's own JWT (forwarded from the
 * Authorization header the Electron app sends via functions.invoke()).
 * Every query through this client is still subject to RLS — it can only
 * see/touch what that user is allowed to.
 */
export function getUserScopedClient(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) throw new Error('Missing Authorization header.');
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
}

/**
 * Service-role client — bypasses RLS entirely. Only ever used by the
 * Stripe webhook handler, which has no user JWT (Stripe is calling us
 * directly) and legitimately needs to write subscription state for
 * whichever user/organization a Stripe event refers to.
 */
export function getAdminClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}
