// Coach-facing "add a player" action from the desktop app. Creating another
// person's auth account requires the service-role key (bypasses RLS by
// design), which must never reach the desktop app or the mobile app
// directly — this function is the one narrow, server-side place that key is
// ever used for this feature. The generated password is returned exactly
// once in the response; it is never stored or logged anywhere.
import { corsHeaders } from '../_shared/cors.ts';
import { getUserScopedClient, getAdminClient } from '../_shared/supabaseClients.ts';

type Body = { email: string; firstName: string; lastName: string };

function generatePassword(): string {
  // 12 random bytes, base64url-encoded — plenty of entropy for a
  // hand-relayed, one-time-shown credential; the player can change it later.
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 14);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = getUserScopedClient(req);
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    if (userErr || !user) throw new Error('Not authenticated.');

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();
    if (profileErr) throw new Error(profileErr.message);
    if (!profile.organization_id) throw new Error("You're not on a team yet — create one first.");

    const { email, firstName, lastName } = (await req.json()) as Body;
    if (!email || !firstName || !lastName) {
      throw new Error('email, firstName, and lastName are all required.');
    }

    const password = generatePassword();
    const admin = getAdminClient();
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // no email-confirmation step — the coach is handing the password over directly
      user_metadata: {
        first_name: firstName,
        last_name: lastName,
        role: 'player',
        organization_id: profile.organization_id,
      },
    });
    if (createErr) throw new Error(createErr.message);
    // handle_new_user() (supabase/migrations/0001) copies user_metadata into
    // public.profiles automatically on insert — no separate profile write needed here.

    return new Response(JSON.stringify({ email: created.user.email, password }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
